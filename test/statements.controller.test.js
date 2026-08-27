// These figures are written to monthly_statements, so a wrong one outlives the
// request that computed it. Two ways it goes wrong: the airtime/data split
// (both are remark `mobile_recharge`) and refunds counted as spend.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { summarizeMonth, monthRange } = require('../src/controllers/statements.controller');

const str = d => d.toFixed(2);

// --- month boundaries ----------------------------------------------------
// The month is the Nigerian one, pinned to UTC+1, and must not move with the
// host clock - that is the whole reason monthRange does not use
// `new Date(year, month - 1, 1)`, which under Asia/Tokyo would open August at
// 2026-07-31T15:00:00Z and pull eight hours of the wrong day into the month.
//
// Node re-reads process.env.TZ on assignment, so this genuinely moves the
// process clock rather than just setting a string.
const HOSTILE_ZONES = ['Africa/Lagos', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati'];
const originalTz = process.env.TZ;
let zonesChecked = 0;

for (const tz of HOSTILE_ZONES) {
  process.env.TZ = tz;
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== tz) {
    console.log(`   (skipped ${tz} - this runtime ignores process.env.TZ)`);
    continue;
  }
  zonesChecked += 1;

  const july = monthRange({ month: 7, year: 2026 });
  const aug = monthRange({ month: 8, year: 2026 });

  assert.strictEqual(aug.start.toISOString(), '2026-07-31T23:00:00.000Z', `August start under ${tz}`);
  assert.strictEqual(aug.endExclusive.toISOString(), '2026-08-31T23:00:00.000Z', `August end under ${tz}`);

  // December must roll into next January, not month 13 of the same year.
  assert.strictEqual(
    monthRange({ month: 12, year: 2026 }).endExclusive.toISOString(),
    '2026-12-31T23:00:00.000Z',
    `December end under ${tz}`
  );

  // A purchase at 00:30 WAT on 1 August is 23:30 UTC on 31 July. It belongs to
  // August; reading the server clock on a UTC host files it under July.
  const justAfterMidnightWat = new Date('2026-07-31T23:30:00Z');
  assert.ok(justAfterMidnightWat >= aug.start && justAfterMidnightWat < aug.endExclusive, `WAT midnight rollover under ${tz}`);
  assert.ok(justAfterMidnightWat >= july.endExclusive, `not still in July under ${tz}`);

  // The last minute of July in Lagos stays in July.
  const lastMinuteOfJuly = new Date('2026-07-31T22:59:00Z');
  assert.ok(lastMinuteOfJuly >= july.start && lastMinuteOfJuly < july.endExclusive, `July tail under ${tz}`);

  // Months must tile with no gap and no overlap.
  assert.strictEqual(july.endExclusive.getTime(), aug.start.getTime(), `July/August tiling under ${tz}`);
}

if (originalTz === undefined) delete process.env.TZ;
else process.env.TZ = originalTz;

assert.ok(zonesChecked > 0, 'no timezone could be exercised - the boundary check proved nothing');
console.log(`   month boundaries hold under ${zonesChecked} timezone(s)`);

// --- the split -----------------------------------------------------------
// meta.service is stamped when the debit row is created; meta.type only after
// the provider accepts. A still-processing bundle has one and not the other,
// and must not be filed as airtime.
const split = summarizeMonth([
  { trx_type: '-', amount: '1500', remark: 'mobile_recharge', meta: { service: 'data' } },
  { trx_type: '-', amount: '2000', remark: 'mobile_recharge', meta: { service: 'data', type: 'data' } },
  { trx_type: '-', amount: '500', remark: 'mobile_recharge', meta: { service: 'airtime' } },
  { trx_type: '-', amount: '300', remark: 'mobile_recharge', meta: null },
  { trx_type: '-', amount: '4000', remark: 'utility_bill', meta: {} },
  { trx_type: '-', amount: '2500', remark: 'cable_tv', meta: {} },
]);
assert.strictEqual(str(split.dataSpent), '3500.00');
assert.strictEqual(str(split.airtimeSpent), '800.00');
assert.strictEqual(str(split.electricitySpent), '4000.00');
assert.strictEqual(str(split.cableSpent), '2500.00');
assert.strictEqual(str(split.monthlyDebitTotal), '10800.00');

// --- refunds -------------------------------------------------------------
// A declined purchase leaves both legs in the ledger. Neither is spend.
const refunded = summarizeMonth([
  { trx_type: '-', amount: '1000', remark: 'mobile_recharge', meta: { service: 'data' } },
  { trx_type: '-', amount: '700', remark: 'mobile_recharge', meta: { service: 'data' } },
  { trx_type: '+', amount: '700', remark: 'mobile_recharge', meta: { service: 'data', reversal_of: 'data123' } },
]);
assert.strictEqual(str(refunded.dataSpent), '1000.00');
assert.strictEqual(str(refunded.monthlyDebitTotal), '1000.00');

// A wallet top-up is a credit, but not a reversal - it is not negative spend.
const funded = summarizeMonth([
  { trx_type: '-', amount: '1000', remark: 'mobile_recharge', meta: { service: 'airtime' } },
  { trx_type: '+', amount: '50000', remark: 'fund_account', meta: {} },
]);
assert.strictEqual(str(funded.airtimeSpent), '1000.00');
assert.strictEqual(str(funded.monthlyDebitTotal), '1000.00');

// A refund for last month's purchase lands in this month with nothing to
// cancel. Floor at zero - a negative on a statement reads as a bug.
const orphan = summarizeMonth([
  { trx_type: '+', amount: '700', remark: 'mobile_recharge', meta: { service: 'airtime', reversal_of: 'air123' } },
  { trx_type: '-', amount: '1200', remark: 'utility_bill', meta: {} },
]);
assert.strictEqual(str(orphan.airtimeSpent), '0.00');
assert.strictEqual(str(orphan.electricitySpent), '1200.00');
assert.strictEqual(str(orphan.monthlyDebitTotal), '1200.00');

// --- precision -----------------------------------------------------------
// Decimal, not float: 0.1 + 0.2 must be 0.30, and kobo must not drift over a
// long month.
const kobo = summarizeMonth(
  Array.from({ length: 3 }, () => ({ trx_type: '-', amount: '0.10', remark: 'mobile_recharge', meta: { service: 'data' } }))
);
assert.strictEqual(str(kobo.dataSpent), '0.30');

assert.strictEqual(str(summarizeMonth([]).monthlyDebitTotal), '0.00');

console.log('✅ statements.controller tests passed');
