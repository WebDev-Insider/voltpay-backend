// The Bill Hero data reward picks a 500MB plan out of the provider catalogue by
// parsing free-text plan names. If that picker drifts, a user who earned a
// reward gets whatever bundle happened to sort first - so it gets a check.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAIRGATE_API_KEY = process.env.PAIRGATE_API_KEY || 'pg_test';

const {
  pickBestDataPlan,
  networkFromName,
  normalizeNgLocal,
  startOfWeekLagosUtc,
  claimWindowForWeek,
  isoWeekKey,
  tallyRows,
} = require('../src/controllers/billHero.controller');

// --- network names -------------------------------------------------------
// The label the app sends, normalised to something pairgate.networkSlug knows.
assert.strictEqual(networkFromName('mtn'), 'MTN');
assert.strictEqual(networkFromName('9 Mobile'), '9MOBILE');
assert.strictEqual(networkFromName('Etisalat'), '9MOBILE');
assert.strictEqual(networkFromName('Globacom'), 'GLO');
assert.strictEqual(networkFromName('Vodafone'), '');

// Whatever this returns has to survive the provider's own slug lookup, or the
// reward vend fails at dispatch with "Unknown network".
const { networkSlug } = require('../src/funding/pairgate.service');
for (const label of ['mtn', '9 Mobile', 'Etisalat', 'Globacom', 'Airtel']) {
  assert.ok(networkSlug(networkFromName(label)), `networkSlug rejected ${label}`);
}

// --- phone ---------------------------------------------------------------
assert.strictEqual(normalizeNgLocal('2348031234567'), '08031234567');
assert.strictEqual(normalizeNgLocal('+234 803 123 4567'), '08031234567');
assert.strictEqual(normalizeNgLocal('06031234567'), '');

// --- plan picking --------------------------------------------------------
const catalogue = [
  { id: '1', name: '500MB - 30 days', amount: 150 },
  { id: '2', name: '1GB - 30 days', amount: 300 },
  { id: '3', name: '500MB Weekly Plan', amount: 130 },
  { id: '4', name: '2GB - 30 days', amount: 600 },
  { id: '5', name: '10GB Monthly', amount: 2500 },
];

// Both 500MB plans are the same distance from target, so price breaks the tie.
assert.strictEqual(pickBestDataPlan(catalogue).id, '3');

// A 1GB bundle must never be handed out as the 500MB reward while a real
// 500MB plan exists.
assert.strictEqual(pickBestDataPlan(catalogue).name.includes('500MB'), true);

// A plan with no id or a zero price is not buyable and must never be chosen.
assert.strictEqual(pickBestDataPlan([{ id: '', name: '500MB', amount: 150 }]), null);
assert.strictEqual(pickBestDataPlan([{ id: '9', name: '500MB', amount: 0 }]), null);

// Nothing near 500MB: fall back to the closest of what exists rather than
// leaving the user unable to claim inside the 24h window.
assert.strictEqual(pickBestDataPlan([
  { id: '7', name: '5GB Monthly', amount: 1500 },
  { id: '8', name: '1GB Monthly', amount: 300 },
]).id, '8');

assert.strictEqual(pickBestDataPlan([]), null);
assert.strictEqual(pickBestDataPlan(null), null);

// 512MB sits inside the band and beats a far-away bundle.
assert.strictEqual(pickBestDataPlan([
  { id: '10', name: '3GB Monthly', amount: 900 },
  { id: '11', name: '512MB Daily', amount: 120 },
]).id, '11');

// The band is tight enough that 1GB is not treated as a 500MB match when a
// nearer option exists, and wide enough to accept 600MB.
assert.strictEqual(pickBestDataPlan([
  { id: '12', name: '1GB Monthly', amount: 300 },
  { id: '13', name: '600MB Weekly', amount: 200 },
]).id, '13');

// --- week boundaries -----------------------------------------------------
// The week decides whether a recharge counts towards the challenge and whether
// the claim button is live, so it has to be the Nigerian week regardless of
// where the process runs. Node re-reads process.env.TZ on assignment, so this
// genuinely moves the process clock rather than setting a string.
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

  // Wednesday 5 Aug 2026, 10:00 WAT.
  const wed = startOfWeekLagosUtc(new Date('2026-08-05T09:00:00Z'));
  assert.strictEqual(wed.toISOString(), '2026-08-02T23:00:00.000Z', `week start under ${tz}`);

  // 00:30 WAT on Monday is 23:30Z Sunday. It opens the new week; the old code
  // built the boundary an hour late and filed it under the week just closed.
  const justAfterMidnightWat = new Date('2026-08-02T23:30:00Z');
  assert.strictEqual(
    startOfWeekLagosUtc(justAfterMidnightWat).toISOString(),
    '2026-08-02T23:00:00.000Z',
    `WAT Monday rollover under ${tz}`
  );
  assert.ok(justAfterMidnightWat >= wed, `recharge counts in its own week under ${tz}`);

  // 23:30 WAT Sunday (22:30Z) is the last half hour of the closing week.
  assert.strictEqual(
    startOfWeekLagosUtc(new Date('2026-08-02T22:30:00Z')).toISOString(),
    '2026-07-26T23:00:00.000Z',
    `Sunday tail under ${tz}`
  );

  // A Monday must anchor to itself, not jump back a week.
  assert.strictEqual(startOfWeekLagosUtc(new Date('2026-08-03T09:00:00Z')).toISOString(), '2026-08-02T23:00:00.000Z');

  // Crossing a month and a year backwards.
  assert.strictEqual(startOfWeekLagosUtc(new Date('2026-08-01T09:00:00Z')).toISOString(), '2026-07-26T23:00:00.000Z');
  assert.strictEqual(startOfWeekLagosUtc(new Date('2026-01-01T09:00:00Z')).toISOString(), '2025-12-28T23:00:00.000Z');

  // Saturday 00:00 WAT for 24h, as real instants - these are sent to the app as
  // ISO strings, so an hour of drift shows up as a countdown that lies.
  const { start, end } = claimWindowForWeek(wed);
  assert.strictEqual(start.toISOString(), '2026-08-07T23:00:00.000Z', `claim start under ${tz}`);
  assert.strictEqual(end.toISOString(), '2026-08-08T23:00:00.000Z', `claim end under ${tz}`);

  // Saturday 00:30 WAT is inside; Friday 23:30 WAT is not.
  assert.ok(new Date('2026-08-07T23:30:00Z') >= start, `Saturday 00:30 WAT claimable under ${tz}`);
  assert.ok(new Date('2026-08-07T22:30:00Z') < start, `Friday 23:30 WAT not claimable under ${tz}`);

  // The window has to sit inside the week it belongs to.
  assert.ok(start > wed && end <= new Date(wed.getTime() + 7 * 24 * 60 * 60 * 1000), `claim window inside week under ${tz}`);

  // The key is the Lagos week, so a moment either side of WAT midnight that
  // shares a week must share a key.
  assert.strictEqual(isoWeekKey(new Date('2026-08-05T09:00:00Z')), '2026-W32', `week key under ${tz}`);
  assert.strictEqual(isoWeekKey(justAfterMidnightWat), '2026-W32', `key rolls at WAT midnight under ${tz}`);
  assert.strictEqual(isoWeekKey(new Date('2026-08-02T22:30:00Z')), '2026-W31', `previous key under ${tz}`);
  // 1 Jan 2026 is a Thursday, so it belongs to W01 of 2026, not W53 of 2025.
  assert.strictEqual(isoWeekKey(new Date('2026-01-01T09:00:00Z')), '2026-W01', `new year key under ${tz}`);
}

if (originalTz === undefined) delete process.env.TZ;
else process.env.TZ = originalTz;

assert.ok(zonesChecked > 0, 'no timezone could be exercised - the boundary check proved nothing');
console.log(`   week boundaries hold under ${zonesChecked} timezone(s)`);

// --- what counts towards the challenge -----------------------------------
// The tally decides whether a free ₦200 airtime or 500MB goes out, so a row
// that should not count is money given away.
const recharge = (trx, type, user_id = 1) => ({ user_id, trx, meta: { type } });
const reversal = trx => ({ meta: { reversal_of: trx } });

const tally = tallyRows(
  [
    recharge('a1', 'airtime'),
    recharge('a2', 'airtime'),
    recharge('d1', 'data'),
    // Provider declined this one and the money went back.
    recharge('a3', 'airtime'),
    // Still in flight: meta.type is only stamped once the provider accepts.
    { user_id: 1, trx: 'a4', meta: { service: 'airtime' } },
    { user_id: 1, trx: 'a5', meta: null },
    // A second user must not leak into the first user's count.
    recharge('b1', 'data', 2),
  ],
  [reversal('a3')]
);

const one = tally.get(1);
assert.strictEqual(one.airtime_count, 2, 'refunded and pending recharges must not count');
assert.strictEqual(one.data_count, 1);
assert.strictEqual(one.points, 2 * 10 + 1 * 10);
assert.strictEqual(tally.get(2).data_count, 1);
assert.strictEqual(tally.get(2).airtime_count, 0);

// A refund arriving in the following week still cancels its purchase - the
// reversal query has no upper bound for exactly this case.
assert.strictEqual(
  tallyRows([recharge('d9', 'data')], [reversal('d9')]).get(1),
  undefined,
  'a wholly refunded week leaves no progress'
);

// A credit with no reversal_of (a wallet top-up) cancels nothing.
assert.strictEqual(tallyRows([recharge('a7', 'airtime')], [{ meta: {} }, { meta: null }]).get(1).airtime_count, 1);

// Ten refunded airtime recharges must not reach the 10-recharge target.
const allRefunded = tallyRows(
  Array.from({ length: 10 }, (_, i) => recharge(`x${i}`, 'airtime')),
  Array.from({ length: 10 }, (_, i) => reversal(`x${i}`))
);
assert.strictEqual(allRefunded.size, 0, 'ten declined recharges must not earn a reward');

assert.strictEqual(tallyRows([], []).size, 0);
assert.strictEqual(tallyRows(null, null).size, 0);

console.log('✅ billHero.controller tests passed');
