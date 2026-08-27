/**
 * Payday arithmetic for automatic payroll.
 *
 * What must not break: the day a salary lands. Payday is configurable from the
 * 25th to the 29th, so the month-length clamp is the whole game - a 29 that
 * rolls into the next month means a staff member is paid in March for February,
 * and a 29 clamped to 28 means every payday is silently a day early.
 *
 * Run: node test/staffpayScheduler.test.js
 */

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { nextDueAtUtc } = require('../src/services/staffpayScheduler.service');

const monthly = (payment_day, start_date, last_paid_at = null) => ({
  frequency: 'monthly',
  payment_day,
  start_date: new Date(start_date),
  last_paid_at: last_paid_at ? new Date(last_paid_at) : null,
});

const ymd = d => d.toISOString().slice(0, 10);

// First cycle: payday in the joining month, once it is on or after the start.
assert.strictEqual(ymd(nextDueAtUtc(monthly(25, '2026-08-11'))), '2026-08-25');

// Joined after this month's payday - waits for next month, does not backdate.
assert.strictEqual(ymd(nextDueAtUtc(monthly(25, '2026-08-27'))), '2026-09-25');

// The 29th is a legal payday (MAX_PAYMENT_DAY) and must not be clamped to 28.
assert.strictEqual(ymd(nextDueAtUtc(monthly(29, '2026-08-01'))), '2026-08-29');

// February is short: the 29th means the last day of the month, not March 1st.
assert.strictEqual(ymd(nextDueAtUtc(monthly(29, '2027-02-01'))), '2027-02-28');
assert.strictEqual(ymd(nextDueAtUtc(monthly(29, '2026-01-01', '2026-01-29'))), '2026-02-28');

// Leap year still gets its 29th.
assert.strictEqual(ymd(nextDueAtUtc(monthly(29, '2028-01-01', '2028-01-29'))), '2028-02-29');

// After a payout, next due is the same day one month on - December wraps.
assert.strictEqual(ymd(nextDueAtUtc(monthly(25, '2026-01-01', '2026-12-25'))), '2027-01-25');

// Non-monthly frequencies keep their fixed offsets.
assert.strictEqual(
  ymd(nextDueAtUtc({ frequency: 'weekly', start_date: new Date('2026-08-01'), last_paid_at: new Date('2026-08-25') })),
  '2026-09-01',
);
assert.strictEqual(
  ymd(nextDueAtUtc({ frequency: 'bi-weekly', start_date: new Date('2026-08-01'), last_paid_at: new Date('2026-08-25') })),
  '2026-09-08',
);

// An unreadable start date must not become "due now".
assert.strictEqual(nextDueAtUtc({ frequency: 'monthly', payment_day: 25, start_date: 'not-a-date' }), null);

console.log('✅ staffpayScheduler payday arithmetic OK');
