/**
 * node test/topupSchedule.helper.test.js
 *
 * The calendar and the rules behind scheduled top-ups - no database, no
 * network. What must not break:
 *
 *   1. When a run happens. Lagos wall clock, never UTC: a 00:30 Monday top-up
 *      is 23:30 *Sunday* UTC, and a UTC-minded implementation buys it a day
 *      late. Month ends clamp - the 31st runs on 30 April, never 1 May.
 *   2. What counts as one cycle. The cycle key is the double-charge guard, so
 *      it names the Lagos week or month - a Monday top-up moved to Friday after
 *      Monday's ran must land in the *same* cycle and be refused.
 *   3. When to try again. A low balance retries; an ambiguous vend - which may
 *      have been delivered - must never be bought again by a timer.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.SCHEDULED_TOPUPS_RETRY_MINUTES;
delete process.env.SCHEDULED_TOPUPS_MAX_AMOUNT;

const s = require('../src/helpers/topupSchedule.helper');

const iso = d => (d ? d.toISOString() : d);
const weekly = (day_of_week, run_time = '07:00') => ({ frequency: 'weekly', day_of_week, run_time });
const monthly = (day_of_month, run_time = '07:00') => ({ frequency: 'monthly', day_of_month, run_time });

/* --------------------------------------------------------------- weekly */

// 2026-10-06 is a Tuesday. Monday 07:00 Lagos is 06:00 UTC.
assert.strictEqual(iso(s.nextRunAt(weekly(1), new Date('2026-10-06T10:00:00Z'))), '2026-10-12T06:00:00.000Z');

// A second before the slot: today. At the slot itself: next week - "strictly
// after" is what stops a just-run slot being due again.
assert.strictEqual(iso(s.nextRunAt(weekly(1), new Date('2026-10-12T05:59:59Z'))), '2026-10-12T06:00:00.000Z');
assert.strictEqual(iso(s.nextRunAt(weekly(1), new Date('2026-10-12T06:00:00Z'))), '2026-10-19T06:00:00.000Z');

// The Lagos/UTC day boundary. Monday 00:30 Lagos is Sunday 23:30 UTC; at
// Monday 00:00 Lagos (Sunday 23:00 UTC) the run is half an hour away, not a
// week away and not a day late.
assert.strictEqual(iso(s.nextRunAt(weekly(1, '00:30'), new Date('2026-10-11T23:00:00Z'))), '2026-10-11T23:30:00.000Z');
// And a Sunday 23:30 Lagos slot is still Sunday in UTC terms too.
assert.strictEqual(iso(s.nextRunAt(weekly(0, '23:30'), new Date('2026-10-11T22:00:00Z'))), '2026-10-11T22:30:00.000Z');

/* -------------------------------------------------------------- monthly */

// Month ends clamp to the last day, never roll into the next month.
assert.strictEqual(iso(s.nextRunAt(monthly(31), new Date('2026-04-10T00:00:00Z'))), '2026-04-30T06:00:00.000Z');
assert.strictEqual(iso(s.nextRunAt(monthly(31), new Date('2027-02-01T00:00:00Z'))), '2027-02-28T06:00:00.000Z');
assert.strictEqual(iso(s.nextRunAt(monthly(29), new Date('2028-02-01T00:00:00Z'))), '2028-02-29T06:00:00.000Z', 'leap year keeps its 29th');

// At the slot: next month. December wraps into January.
assert.strictEqual(iso(s.nextRunAt(monthly(15), new Date('2026-10-15T06:00:00Z'))), '2026-11-15T06:00:00.000Z');
assert.strictEqual(iso(s.nextRunAt(monthly(1), new Date('2026-12-20T00:00:00Z'))), '2027-01-01T06:00:00.000Z');

// The 1st at 00:30 Lagos is the 31st in UTC.
assert.strictEqual(iso(s.nextRunAt(monthly(1, '00:30'), new Date('2026-10-31T23:00:00Z'))), '2026-10-31T23:30:00.000Z');

// Malformed schedules have no next run - never "now", which would read as due.
assert.strictEqual(s.nextRunAt(weekly(7), new Date()), null);
assert.strictEqual(s.nextRunAt(monthly(0), new Date()), null);
assert.strictEqual(s.nextRunAt(weekly(1, '25:00'), new Date()), null);
assert.strictEqual(s.nextRunAt({ frequency: 'daily', run_time: '07:00' }, new Date()), null);

/* ----------------------------------------------------------- cycle keys */

assert.strictEqual(s.cycleKeyFor('weekly', new Date('2026-10-12T06:00:00Z')), 'wk:2026-10-12');
// Sunday 23:30 Lagos is still the week that began on Monday the 12th...
assert.strictEqual(s.cycleKeyFor('weekly', new Date('2026-10-18T22:30:00Z')), 'wk:2026-10-12');
// ...and Monday 00:30 Lagos - Sunday 23:30 UTC - is the next one.
assert.strictEqual(s.cycleKeyFor('weekly', new Date('2026-10-18T23:30:00Z')), 'wk:2026-10-19');
// Monday's top-up moved to Friday after it ran: same cycle, so the unique
// index refuses a second purchase that week.
assert.strictEqual(
  s.cycleKeyFor('weekly', new Date('2026-10-16T06:00:00Z')),
  s.cycleKeyFor('weekly', new Date('2026-10-12T06:00:00Z')),
);
assert.strictEqual(s.cycleKeyFor('monthly', new Date('2026-10-31T23:30:00Z')), 'mo:2026-11', 'Lagos month, not UTC month');
assert.strictEqual(s.cycleKeyFor('monthly', new Date('2026-04-30T06:00:00Z')), 'mo:2026-04');

/* --------------------------------------------------------------- labels */

assert.strictEqual(s.lagosLabel(new Date('2026-10-12T06:00:00Z')), 'Mon, 12 Oct 2026, 07:00 AM');
assert.strictEqual(s.lagosDateLabel(new Date('2026-10-11T23:30:00Z')), 'Mon, 12 Oct 2026');
assert.strictEqual(s.clockLabel(0, 5), '12:05 AM');
assert.strictEqual(s.clockLabel(12, 0), '12:00 PM');
assert.strictEqual(s.clockLabel(19, 30), '07:30 PM');

assert.deepStrictEqual(s.cadenceLabels(weekly(1)), {
  short: 'Weekly • Mon 07:00 AM',
  long: 'Weekly • Every Monday at 07:00 AM',
  frequency: 'Weekly (Every Monday)',
  time: '07:00 AM (WAT)',
});
assert.strictEqual(s.cadenceLabels(monthly(1, '08:00')).long, 'Monthly • 1st of every month at 08:00 AM');
assert.strictEqual(s.cadenceLabels(monthly(31)).frequency, 'Monthly (31st (or last day) of every month)');
assert.strictEqual(s.cadenceLabels(monthly(22)).short, 'Monthly • 22nd 07:00 AM');

assert.strictEqual(s.displayPhone('08034567890'), '+234 803 456 7890');
assert.strictEqual(s.maskPhone('08034567890'), '0803 *** 7890');
assert.strictEqual(s.nairaLabel(2000), '₦2,000.00');

/* ----------------------------------------------------------- validation */

const base = {
  service: 'airtime',
  provider: 'mtn',
  phone: '+234 803 123 4567',
  amount: 2000,
  frequency: 'weekly',
  day_of_week: 1,
  run_time: '7:00',
};
const ok = s.validateScheduleInput(base);
assert.ok(ok.ok, ok.message);
assert.strictEqual(ok.value.phone, '08031234567', 'every keyboard shape normalises to the local form');
assert.strictEqual(ok.value.msisdn, '2348031234567');
assert.strictEqual(ok.value.provider, 'MTN');
assert.strictEqual(ok.value.run_time, '07:00');
assert.strictEqual(ok.value.notify_before, true, 'the reminder is on unless switched off');
assert.strictEqual(ok.value.day_of_month, null);

const reject = (patch, pattern) => {
  const out = s.validateScheduleInput({ ...base, ...patch });
  assert.strictEqual(out.ok, false, `expected a refusal for ${JSON.stringify(patch)}`);
  assert.match(out.message, pattern);
};
reject({ service: 'electricity' }, /only airtime and data/i);
reject({ service: 'tv' }, /only airtime and data/i);
reject({ phone: '06031234567' }, /valid nigerian phone/i);
reject({ amount: 50 }, /minimum airtime/i);
reject({ amount: 150.5 }, /whole naira/i);
reject({ amount: 60000 }, /at most/i);
reject({ frequency: 'daily' }, /weekly or monthly/i);
reject({ day_of_week: undefined }, /day of the week/i);
reject({ day_of_week: 7 }, /day of the week/i);
reject({ frequency: 'monthly', day_of_month: 32 }, /between 1 and 31/i);
reject({ run_time: '24:00' }, /recharge time/i);
reject({ service: 'data', plan_id: '' }, /data plan/i);

assert.strictEqual(s.validateScheduleInput({ ...base, notify_before: false }).value.notify_before, false);
assert.strictEqual(s.validateScheduleInput({ ...base, amount: 100 }, { minAirtime: 100 }).ok, true);

// A nickname lands on a push banner: control characters out, capped.
const labelled = s.validateScheduleInput({ ...base, label: '  Mom\u0000\n  Lagos  '.padEnd(80, 'x') });
assert.ok(!/[\u0000-\u001f]/.test(labelled.value.label));
assert.ok(labelled.value.label.startsWith('Mom Lagos'));
assert.ok(labelled.value.label.length <= 40);

// Monthly keeps its own day and drops the weekday.
const month = s.validateScheduleInput({ ...base, frequency: 'monthly', day_of_month: '31', day_of_week: 3 });
assert.strictEqual(month.value.day_of_month, 31);
assert.strictEqual(month.value.day_of_week, null);

/* -------------------------------------------------------------- retries */

assert.deepStrictEqual(s.retryDelaysMinutes(), [60, 180, 360]);
assert.strictEqual(s.maxAttempts(), 4, 'one run plus the three retries the design promises');
const t0 = new Date('2026-10-12T06:00:00Z');
assert.strictEqual(iso(s.nextRetryAt(1, t0)), '2026-10-12T07:00:00.000Z');
assert.strictEqual(iso(s.nextRetryAt(3, t0)), '2026-10-12T12:00:00.000Z');
assert.strictEqual(s.nextRetryAt(4, t0), null, 'the fourth attempt was the last');

process.env.SCHEDULED_TOPUPS_RETRY_MINUTES = '5, 10';
assert.strictEqual(s.maxAttempts(), 3);
process.env.SCHEDULED_TOPUPS_RETRY_MINUTES = 'nonsense';
assert.strictEqual(s.maxAttempts(), 4, 'an unreadable setting falls back rather than disabling retries');
delete process.env.SCHEDULED_TOPUPS_RETRY_MINUTES;

/* ------------------------------------------------- what a failure means */

const socket = code => ({ cause: Object.assign(new Error('fetch failed'), { cause: { code } }) });

// May have been delivered: refunded, and never bought again by a timer.
assert.strictEqual(
  s.classifyVendFailure({ ambiguous: true, kind: 'outage', statusCode: 504, ...socket('ECONNRESET') }),
  'final',
);
assert.strictEqual(s.classifyVendFailure({ ambiguous: true, kind: 'outage', statusCode: 504 }), 'final');
// Provably never left the building: safe to try again later.
assert.strictEqual(
  s.classifyVendFailure({ ambiguous: true, kind: 'outage', statusCode: 504, ...socket('ECONNREFUSED') }),
  'retry',
);
assert.strictEqual(s.classifyVendFailure({ floatExhausted: true, statusCode: 503 }), 'retry', 'our float, not their schedule');
assert.strictEqual(s.classifyVendFailure({ misconfigured: true, statusCode: 503 }), 'retry');
assert.strictEqual(s.classifyVendFailure({ statusCode: 429 }), 'retry');
// The schedule itself is wrong: retrying buys nothing but another refund.
assert.strictEqual(s.classifyVendFailure({ kind: 'input', statusCode: 400 }), 'pause');
assert.strictEqual(s.classifyVendFailure({ kind: 'limit', statusCode: 400 }), 'pause');
assert.strictEqual(s.classifyVendFailure({ kind: 'unknown', statusCode: 400 }), 'final');

console.log('✅ topupSchedule.helper tests passed');
