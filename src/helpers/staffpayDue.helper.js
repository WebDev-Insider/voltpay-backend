/**
 * Who is due to be paid, and for which salary cycle.
 *
 * One copy, read by the scheduler and by the manual "Run payroll now" button,
 * so a person pressing the button at 08:59 and the scheduler firing at 09:00
 * compute the same answer and stamp the same cycle key. That key is what the
 * unique index on (staff_id, cycle_key) refuses to duplicate - see
 * services/staffpayPayroll.service.js.
 *
 * Money rules that must not be relaxed:
 *   - Never cap the staff scan. A `take: 300` here means staff member 301 is
 *     silently never paid, which is the worst kind of payroll bug: no error,
 *     no alert, just a person with no salary. The scan pages to the end.
 *   - A cycle key is derived from the staff member's own due date, never from
 *     "today". Two instances running a minute apart must produce the same
 *     string or the guard is worthless.
 */
const { withDirectFallback } = require('./prismaDirect.helper');
const { payoutTimeOrDefault } = require('../services/staffpayPayroll.service');

// Rows per query while paging. Nothing to tune unless a single company grows
// past a few thousand staff.
const SCAN_PAGE_SIZE = 500;

function addDaysUtc(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}

// Payday runs to 29 (see MAX_PAYMENT_DAY), so February would roll a 29th into
// March. Clamp to the length of the target month instead - a payday of 29 in
// February means the 28th, not "next month".
function monthDayUtc(year, month, day) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const wanted = Number.isFinite(Number(day)) ? Number(day) : 1;
  return new Date(Date.UTC(year, month, Math.max(1, Math.min(daysInMonth, wanted)), 0, 0, 0, 0));
}

function paymentDayOf(staff) {
  const raw = Number(staff?.payment_day);
  return Number.isFinite(raw) ? raw : 1;
}

function nextDueAtUtc(staff) {
  const freq = String(staff?.frequency || '').trim().toLowerCase();
  const start = new Date(staff?.start_date);
  if (Number.isNaN(start.getTime())) return null;

  const lastPaid = staff?.last_paid_at ? new Date(staff.last_paid_at) : null;
  if (!lastPaid || Number.isNaN(lastPaid.getTime())) {
    if (freq === 'monthly') {
      const day = paymentDayOf(staff);
      const y = start.getUTCFullYear();
      const m = start.getUTCMonth();
      const candidate = monthDayUtc(y, m, day);
      if (candidate.getTime() < start.getTime()) {
        return monthDayUtc(y, m + 1, day);
      }
      return candidate;
    }

    return start;
  }

  if (freq === 'weekly') {
    return addDaysUtc(lastPaid, 7);
  }

  if (freq === 'bi-weekly' || freq === 'biweekly') {
    return addDaysUtc(lastPaid, 14);
  }

  const y = lastPaid.getUTCFullYear();
  const m = lastPaid.getUTCMonth();
  return monthDayUtc(y, m + 1, paymentDayOf(staff));
}

/**
 * The identity of one salary cycle for one staff member.
 *
 * Derived only from the due date, so it is stable across instances, restarts
 * and a retry hours later. A failed transfer keeps the same key - the retry
 * re-uses the existing item row rather than inserting a new one, which is what
 * lets a run be retried without re-paying the staff who already succeeded.
 */
function cycleKeyFor(dueAt) {
  const d = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  return `due:${d.toISOString().slice(0, 10)}`;
}

function minutesSinceMidnightInTz({ date, timeZone }) {
  const tz = String(timeZone || 'Africa/Lagos').trim() || 'Africa/Lagos';
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = fmt.formatToParts(date);
    const hh = Number(parts.find(p => p.type === 'hour')?.value);
    const mm = Number(parts.find(p => p.type === 'minute')?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return (hh * 60) + mm;
  } catch (_) {
    const d = date instanceof Date ? date : new Date(date);
    return (d.getHours() * 60) + d.getMinutes();
  }
}

// There is no AutoPay toggle any more, so an unset payout_time must not mean
// "pay immediately" - it falls back to the platform default (WAT).
function companyPayoutTimeReached(company, now = new Date()) {
  const payout = payoutTimeOrDefault(company);
  const tz = String(company?.payout_timezone || 'Africa/Lagos').trim() || 'Africa/Lagos';
  const [hhRaw, mmRaw] = payout.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return true;
  const target = (hh * 60) + mm;
  const nowMin = minutesSinceMidnightInTz({ date: now, timeZone: tz });
  if (nowMin == null) return false;
  return nowMin >= target;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Every active staff member of a company whose payday has arrived and whose
 * cycle has not been attempted yet.
 *
 * `db` is injectable for the tests; production passes nothing and gets the
 * Accelerate-with-direct-fallback client.
 *
 * Returns `[{ id, cycle_key, due_at }]`, oldest id first.
 */
async function listDueStaff({ companyId, now = new Date(), db = null } = {}) {
  const query = db ? (fn => fn(db)) : withDirectFallback;
  const id = Number(companyId);
  if (!id) return [];

  const due = [];
  let cursor = 0;

  // Paged rather than a single findMany: a school with 2,000 staff must be
  // paid in full, and the previous flat cap paid the first 300 of them.
  for (;;) {
    const page = await query(p => p.staffPayStaff.findMany({
      where: { company_id: id, is_active: true, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, frequency: true, payment_day: true, start_date: true, last_paid_at: true },
      orderBy: { id: 'asc' },
      take: SCAN_PAGE_SIZE,
    }));

    if (!page?.length) break;

    for (const s of page) {
      const dueAt = nextDueAtUtc(s);
      if (!dueAt || dueAt.getTime() > now.getTime()) continue;
      const cycleKey = cycleKeyFor(dueAt);
      if (!cycleKey) continue;
      due.push({ id: Number(s.id), cycle_key: cycleKey, due_at: dueAt });
    }

    if (page.length < SCAN_PAGE_SIZE) break;
    cursor = Number(page[page.length - 1].id);
  }

  if (!due.length) return [];

  // A failed transfer never sets last_paid_at, so the staff member stays due
  // for ever. Without this the scheduler would open a fresh run every tick and
  // race the retry timer over the same salary. The DB unique index would still
  // refuse the duplicate, but losing a whole batch to a rollback every minute
  // is not a working payroll - this is what keeps it to one attempt per cycle.
  const attempted = new Set();
  for (const batch of chunk(due, SCAN_PAGE_SIZE)) {
    const rows = await query(p => p.staffPayPayrollItem.findMany({
      where: {
        staff_id: { in: batch.map(d => d.id) },
        cycle_key: { in: [...new Set(batch.map(d => d.cycle_key))] },
      },
      select: { staff_id: true, cycle_key: true },
    }));
    for (const row of rows || []) attempted.add(`${Number(row.staff_id)}|${row.cycle_key}`);
  }

  return due.filter(d => !attempted.has(`${d.id}|${d.cycle_key}`));
}

module.exports = {
  SCAN_PAGE_SIZE,
  addDaysUtc,
  monthDayUtc,
  nextDueAtUtc,
  cycleKeyFor,
  minutesSinceMidnightInTz,
  companyPayoutTimeReached,
  listDueStaff,
  chunk,
};
