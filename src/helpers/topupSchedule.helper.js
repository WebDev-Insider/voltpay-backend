// Scheduled top-ups: the calendar and the rules, with no database and no
// network - so the parts that decide *when* money moves and *whether to try
// again* can be tested on their own.
//
// Everything is Lagos wall clock. A customer who picks "Monday 07:00" means
// 07:00 in Nigeria wherever the server happens to run, and Lagos is UTC+1 all
// year with no DST, so lagosTime.helper's fixed offset is exact here.
const { lagosDateParts, lagosMidnightUtc } = require('./lagosTime.helper');
const { normalizeNgPhone } = require('./phone.helper');

// Electricity and TV are deliberately absent. A prepaid meter's purchase is
// not finished until its token reaches the customer (see billSettlement), and
// an unattended run has nobody waiting on a receipt to read it to.
const SERVICES = { airtime: 'Airtime', data: 'Data' };
const FREQUENCIES = ['weekly', 'monthly'];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const LABEL_MAX = 40;

const pad = n => String(n).padStart(2, '0');

// `Number('')` is 0, which would read an unset variable as "no limit at all" -
// the same trap velocity.helper guards against.
function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The most one run may buy. A standing order repeats, so a typo - ₦20,000 for
 * ₦2,000 - is paid every week until somebody notices. Well above any real
 * airtime top-up, well below what a mistake would cost over a month.
 */
function maxRunAmount() {
  return envNumber('SCHEDULED_TOPUPS_MAX_AMOUNT', 50_000);
}

/** Live schedules per customer, paused ones included. */
function maxSchedulesPerUser() {
  return envNumber('SCHEDULED_TOPUPS_MAX_PER_USER', 10);
}

/* ------------------------------------------------------------------- clock */

/** "07:00" or "7:05" -> { hour, minute }, or null. */
function parseRunTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function formatRunTime({ hour, minute }) {
  return `${pad(hour)}:${pad(minute)}`;
}

/** 7, 0 -> "07:00 AM"; 19, 30 -> "07:30 PM". */
function clockLabel(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${pad(h12)}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Month is 1-12, and may overflow the way Date.UTC allows. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The UTC instant of a Lagos wall-clock time. Day may overflow the month. */
function slotUtc(year, month, day, time) {
  return new Date(lagosMidnightUtc(year, month, day).getTime() + (time.hour * 60 + time.minute) * 60_000);
}

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/* ---------------------------------------------------------------- schedule */

/**
 * The first run strictly after `after`, as a UTC instant. Null when the
 * schedule is malformed - never "now", which would read as due.
 *
 * Monthly days past the end of a short month land on its last day: the 31st
 * runs on 30 April and on 28 (or 29) February, never on the 1st of the next
 * month, which would quietly buy two cycles in one.
 */
function nextRunAt(schedule, after = new Date()) {
  const time = parseRunTime(schedule?.run_time);
  const from = after instanceof Date ? after : new Date(after);
  if (!time || Number.isNaN(from.getTime())) return null;

  const today = lagosDateParts(from);

  if (schedule.frequency === 'weekly') {
    const dow = Number(schedule.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    const ahead = (dow - today.weekday + 7) % 7;
    const candidate = slotUtc(today.year, today.month, today.day + ahead, time);
    if (candidate.getTime() > from.getTime()) return candidate;
    return slotUtc(today.year, today.month, today.day + ahead + 7, time);
  }

  if (schedule.frequency === 'monthly') {
    const dom = Number(schedule.day_of_month);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
    for (let offset = 0; offset < 3; offset += 1) {
      const index = today.month - 1 + offset;
      const year = today.year + Math.floor(index / 12);
      const month = (index % 12) + 1;
      const candidate = slotUtc(year, month, Math.min(dom, daysInMonth(year, month)), time);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }

  return null;
}

/**
 * The cycle a run belongs to: the Lagos week, named by its Monday, or the
 * Lagos month. The unique (schedule_id, cycle_key) index makes this the
 * double-charge guard, so it is deliberately the *period*, not the slot - a
 * customer who moves Monday's top-up to Friday after Monday's has run does not
 * get bought a second one that week.
 */
function cycleKeyFor(frequency, at) {
  const p = lagosDateParts(at instanceof Date ? at : new Date(at));
  if (frequency === 'monthly') return `mo:${p.year}-${pad(p.month)}`;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - ((p.weekday + 6) % 7)));
  return `wk:${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

/** "Mon, 12 Oct 2026" in Lagos. */
function lagosDateLabel(at) {
  if (!at) return '';
  const p = lagosDateParts(at instanceof Date ? at : new Date(at));
  return `${DAY_SHORT[p.weekday]}, ${p.day} ${MONTH_SHORT[p.month - 1]} ${p.year}`;
}

/** "Mon, 12 Oct 2026, 07:00 AM" in Lagos. */
function lagosLabel(at) {
  if (!at) return '';
  const date = at instanceof Date ? at : new Date(at);
  const p = lagosDateParts(date);
  return `${lagosDateLabel(date)}, ${clockLabel(p.hour, p.minute)}`;
}

/**
 * The cadence in the three lengths the screens use: a card ("Weekly • Mon
 * 07:00 AM"), the details header ("Weekly • Every Monday at 07:00 AM") and the
 * confirm row ("Weekly (Every Monday)"). Built here so the app never has to
 * know that the 31st means "or the last day".
 */
function cadenceLabels(schedule) {
  const time = parseRunTime(schedule?.run_time);
  const clock = time ? clockLabel(time.hour, time.minute) : '';

  if (schedule?.frequency === 'weekly') {
    const dow = Number(schedule.day_of_week);
    return {
      short: `Weekly • ${DAY_SHORT[dow] || ''} ${clock}`.trim(),
      long: `Weekly • Every ${DAY_NAMES[dow] || ''} at ${clock}`,
      frequency: `Weekly (Every ${DAY_NAMES[dow] || ''})`,
      time: `${clock} (WAT)`,
    };
  }

  const dom = Number(schedule?.day_of_month);
  const day = dom > 28 ? `${ordinal(dom)} (or last day)` : ordinal(dom);
  return {
    short: `Monthly • ${ordinal(dom)} ${clock}`.trim(),
    long: `Monthly • ${day} of every month at ${clock}`,
    frequency: `Monthly (${day} of every month)`,
    time: `${clock} (WAT)`,
  };
}

/* -------------------------------------------------------------- the input */

function fail(message) {
  return { ok: false, message };
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Everything about a schedule that needs no catalogue: what, for whom, how
 * often, when. Returns `{ ok: true, value }` or `{ ok: false, message }`.
 *
 * The data plan is checked by the caller against the live catalogue - a plan
 * id is only meaningful to the provider that issued it, and its price is the
 * catalogue's to say, never the client's.
 */
function validateScheduleInput(body, { minAirtime = 100 } = {}) {
  const input = body || {};

  const service = String(input.service || '').trim().toLowerCase();
  if (!service) return fail('Choose airtime or data');
  if (!SERVICES[service]) return fail('Only airtime and data can be scheduled for now');

  const provider = String(input.provider || '').trim().toUpperCase();
  if (!provider) return fail('Please select a network');

  const phone = normalizeNgPhone(input.phone ?? input.number ?? input.mobile_number);
  if (!phone) return fail('Enter a valid Nigerian phone number');

  // A nickname the customer typed. Control characters out, whitespace
  // collapsed, capped - it lands on a push banner and a card title.
  const label = String(input.label ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX);

  // On unless switched off: the reminder is what gives a customer the hour to
  // fund the wallet before a low-balance miss.
  const notify = input.notify_before;
  const value = {
    service,
    provider,
    phone: phone.local,
    msisdn: phone.msisdn,
    label: label || null,
    notify_before: notify === undefined || notify === null ? true : [true, 'true', 1, '1'].includes(notify),
  };

  if (service === 'airtime') {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount < minAirtime) return fail(`Minimum airtime amount is NGN ${minAirtime}`);
    // Whole naira: the provider's validator takes an integer, so a kobo
    // amount would be reserved every week and refused every week.
    if (!Number.isInteger(amount)) return fail('Enter a whole naira amount');
    if (amount > maxRunAmount()) {
      return fail(`A scheduled top-up can be at most NGN ${maxRunAmount().toLocaleString('en-NG')}`);
    }
    value.amount = amount;
  } else {
    const planId = String(input.plan_id || '').trim();
    if (!planId) return fail('Please select a data plan');
    value.plan_id = planId;
  }

  const frequency = String(input.frequency || '').trim().toLowerCase();
  if (!FREQUENCIES.includes(frequency)) return fail('Choose weekly or monthly');
  value.frequency = frequency;

  if (frequency === 'weekly') {
    const dow = intOrNull(input.day_of_week);
    if (dow === null || Number.isNaN(dow) || dow < 0 || dow > 6) return fail('Choose the day of the week');
    value.day_of_week = dow;
    value.day_of_month = null;
  } else {
    const dom = intOrNull(input.day_of_month);
    if (dom === null || Number.isNaN(dom) || dom < 1 || dom > 31) return fail('Choose a day of the month between 1 and 31');
    value.day_of_month = dom;
    value.day_of_week = null;
  }

  const time = parseRunTime(input.run_time);
  if (!time) return fail('Choose a valid recharge time');
  value.run_time = formatRunTime(time);

  // Not a formality: a malformed combination that slipped past the checks
  // above must never be saved with a null next run, which no worker picks up.
  if (!nextRunAt(value)) return fail('Could not work out the next run date for this schedule');

  return { ok: true, value };
}

/* ---------------------------------------------------------- retries & failure */

/**
 * Minutes to wait before each retry of a cycle. The design promises "retry 3x
 * if balance low": 1h, 3h, 6h is long enough for a customer to fund the
 * wallet after the first push, and over well before the next cycle.
 */
function retryDelaysMinutes() {
  const raw = String(process.env.SCHEDULED_TOPUPS_RETRY_MINUTES ?? '').trim();
  const parsed = raw
    ? raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    : [];
  return parsed.length ? parsed : [60, 180, 360];
}

function maxAttempts() {
  return 1 + retryDelaysMinutes().length;
}

/** When attempt `attempts + 1` should run, or null when that was the last. */
function nextRetryAt(attempts, now = new Date()) {
  const delays = retryDelaysMinutes();
  const index = Number(attempts) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= delays.length) return null;
  return new Date(now.getTime() + delays[index] * 60_000);
}

// Connection failures that provably never reached the provider. Every other
// transport error is ambiguous: the order may exist at the far end.
const NEVER_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

function socketCode(error) {
  let e = error;
  for (let depth = 0; e && depth < 5; depth += 1) {
    if (typeof e.code === 'string' && e.code) return e.code;
    e = e.cause;
  }
  return '';
}

/**
 * What a refused vend means for this cycle, after it has been refunded:
 *
 *   retry - the provider said no for a reason of its own (an outage, our
 *           float) and nothing was delivered; a fresh attempt later can work.
 *   pause - the schedule itself is wrong (the number or plan was refused); it
 *           will fail every time until the customer edits it.
 *   final - give up on this cycle and tell the customer.
 *
 * An *ambiguous* failure is final even though it was refunded. The order may
 * have landed at the far end after all, and buying it again automatically is
 * exactly the double delivery CLAUDE.md's "a vend is never retried" exists to
 * prevent. A person can choose to top up by hand; a timer must not.
 */
function classifyVendFailure(error) {
  if (error?.ambiguous && !NEVER_SENT.has(socketCode(error))) return 'final';
  if (error?.floatExhausted || error?.misconfigured) return 'retry';
  if (error?.kind === 'outage' || error?.kind === 'unavailable') return 'retry';
  const status = Number(error?.statusCode) || 0;
  if (status === 429 || status >= 500) return 'retry';
  if (error?.kind === 'input' || error?.kind === 'limit') return 'pause';
  return 'final';
}

/* --------------------------------------------------------------- display */

/** "08034567890" -> "+234 803 456 7890". */
function displayPhone(local) {
  const digits = String(local || '').replace(/\D/g, '');
  if (digits.length !== 11) return String(local || '');
  return `+234 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/** "08034567890" -> "0803 *** 7890", for a push banner on a lock screen. */
function maskPhone(local) {
  const digits = String(local || '').replace(/\D/g, '');
  if (digits.length !== 11) return '';
  return `${digits.slice(0, 4)} *** ${digits.slice(7)}`;
}

function nairaLabel(amount) {
  const n = Number(amount);
  return `₦${(Number.isFinite(n) ? n : 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = {
  SERVICES,
  FREQUENCIES,
  DAY_NAMES,
  maxRunAmount,
  maxSchedulesPerUser,
  parseRunTime,
  clockLabel,
  nextRunAt,
  cycleKeyFor,
  lagosLabel,
  lagosDateLabel,
  cadenceLabels,
  validateScheduleInput,
  retryDelaysMinutes,
  maxAttempts,
  nextRetryAt,
  classifyVendFailure,
  displayPhone,
  maskPhone,
  nairaLabel,
};
