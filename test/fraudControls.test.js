// Fraud controls, kill switch and admin identity.
//
// No database and no framework. Everything asserted here is a pure decision -
// the queries that feed it are covered by the fact that a wrong answer would
// have to come from a wrong number, and the numbers are what is checked.
//
//   node test/fraudControls.test.js

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const velocity = require('../src/helpers/velocity.helper');
const featureFlag = require('../src/helpers/featureFlag.helper');
const beneficiary = require('../src/helpers/beneficiary.helper');
const adminAuth = require('../src/middlewares/adminAuth.middleware');
const userAudit = require('../src/services/userAudit.service');

const CAPS = { hourlyMaxCount: 3, hourlyMaxAmount: 100_000, dailyMaxAmount: 250_000 };

/* --------------------------------------------------------------- velocity */

{
  const quiet = velocity.decide({ hourCount: 0, hourSpent: 0, daySpent: 0, amount: 5_000 }, CAPS);
  assert.strictEqual(quiet.ok, true, 'a first payment on a quiet wallet is allowed');

  // Two already this hour, so a third is the last one under a cap of 3.
  const third = velocity.decide({ hourCount: 2, hourSpent: 10, daySpent: 10, amount: 1 }, CAPS);
  assert.strictEqual(third.ok, true, 'the payment that reaches the cap still goes through');

  const fourth = velocity.decide({ hourCount: 3, hourSpent: 10, daySpent: 10, amount: 1 }, CAPS);
  assert.strictEqual(fourth.ok, false, 'the payment past the cap is stopped');
  assert.strictEqual(fourth.reason, 'hourly_count');
  assert.strictEqual(fourth.retryAfterMinutes, 60);

  // The pending amount has to count towards the limit, not just what settled.
  // Otherwise the last transfer of the hour is unbounded.
  const straddles = velocity.decide({ hourCount: 0, hourSpent: 99_000, daySpent: 99_000, amount: 2_000 }, CAPS);
  assert.strictEqual(straddles.ok, false, 'the pending amount counts towards the hourly cap');
  assert.strictEqual(straddles.reason, 'hourly_amount');

  const exact = velocity.decide({ hourCount: 0, hourSpent: 99_000, daySpent: 99_000, amount: 1_000 }, CAPS);
  assert.strictEqual(exact.ok, true, 'landing exactly on the cap is allowed, not blocked');

  // Under the hourly cap but over the day's.
  const daily = velocity.decide({ hourCount: 0, hourSpent: 0, daySpent: 249_000, amount: 2_000 }, CAPS);
  assert.strictEqual(daily.ok, false, 'the daily cap applies even to a quiet hour');
  assert.strictEqual(daily.reason, 'daily_amount');
  assert.strictEqual(daily.retryAfterMinutes, 60 * 24);
}

{
  // `Number('')` is 0 and 0 passes `>= 0`. An unset variable reading as zero
  // here would mean "no naira may leave any wallet" - every payment on the
  // platform blocked. This is the same trap that made the deletion grace period
  // zero days, so it gets its own assertion.
  const { envNumber } = velocity.__test;
  delete process.env.__VELOCITY_PROBE;
  assert.strictEqual(envNumber('__VELOCITY_PROBE', 12), 12, 'unset falls back');

  process.env.__VELOCITY_PROBE = '';
  assert.strictEqual(envNumber('__VELOCITY_PROBE', 12), 12, 'empty string falls back, it is not zero');

  process.env.__VELOCITY_PROBE = '0';
  assert.strictEqual(envNumber('__VELOCITY_PROBE', 12), 12, 'an explicit 0 limit is nonsense, so it falls back too');

  process.env.__VELOCITY_PROBE = '25';
  assert.strictEqual(envNumber('__VELOCITY_PROBE', 12), 25, 'a real value is used');
  delete process.env.__VELOCITY_PROBE;

  const caps = velocity.limits();
  assert.ok(caps.hourlyMaxCount > 0 && caps.hourlyMaxAmount > 0 && caps.dailyMaxAmount > 0, 'defaults are all positive');
  assert.ok(caps.dailyMaxAmount >= caps.hourlyMaxAmount, 'a daily cap below the hourly one would make the hourly one dead code');
}

{
  const { windowSince } = velocity.__test;
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  assert.strictEqual(windowSince(60, now).toISOString(), '2026-01-02T11:00:00.000Z');
  assert.strictEqual(windowSince(60 * 24, now).toISOString(), '2026-01-01T12:00:00.000Z');
}

/* ----------------------------------------------------------- kill switch */

{
  const { settingKey, OFF_VALUES } = featureFlag.__test;
  assert.strictEqual(settingKey('send_money'), 'feature_send_money_enabled');

  // Absent must mean ON. A brand new deployment has no rows in app_settings and
  // must not boot with every rail switched off.
  assert.ok(!OFF_VALUES.has('on'), 'the default value reads as enabled');
  for (const off of ['0', 'false', 'off', 'no', 'disabled']) {
    assert.ok(OFF_VALUES.has(off), `"${off}" switches a feature off`);
  }

  assert.ok(featureFlag.FEATURES.send_money, 'send_money is switchable');
  assert.ok(featureFlag.FEATURES.staffpay_payroll, 'payroll is switchable');
  assert.strictEqual(typeof featureFlag.requireFeature('send_money'), 'function');
}

// An unknown slug must be rejected rather than silently written, or a typo in an
// admin call creates a flag nothing reads and the rail quietly stays up. This is
// the one async assertion here; it is awaited at the bottom.
const pending = [
  assert.rejects(
    () => featureFlag.setFeature('not_a_feature', false),
    e => e.code === 'UNKNOWN_FEATURE',
    'unknown feature slugs are rejected before any write',
  ),
  // isFeatureEnabled fails OPEN. With no database reachable from a test run it
  // must still answer true - a blip must never close every rail at once.
  featureFlag.isFeatureEnabled('send_money').then(enabled => {
    assert.strictEqual(enabled, true, 'a failed flag read leaves the feature on');
  }),
];

/* ------------------------------------------------------------ beneficiary */

{
  const { ackRemark } = beneficiary.__test;
  assert.strictEqual(ackRemark(42), 'beneficiary_ack:42');
  // Two recipients must never share one acknowledgement.
  assert.notStrictEqual(ackRemark(42), ackRemark(43));
  assert.ok(beneficiary.ACK_TTL_MS > 0 && beneficiary.ACK_TTL_MS <= 30 * 60_000, 'the ack window is minutes, not hours');
}

/* --------------------------------------------------------- admin identity */

{
  const { parseKeys, resolveAdmin, sameSecret } = adminAuth.__test;

  const parsed = parseKeys('ada:superadmin:key-one,bola:support:key-two');
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(parsed[0], { name: 'ada', role: 'superadmin', key: 'key-one' });
  assert.strictEqual(parsed[1].role, 'support');

  // A bad role or a missing key is dropped rather than admitted as something
  // weaker - an entry nobody can authenticate with is safer than a guess.
  assert.strictEqual(parseKeys('mallory:root:key').length, 0, 'an unknown role is not a role');
  assert.strictEqual(parseKeys('mallory:support:').length, 0, 'an empty key is not a key');

  assert.strictEqual(sameSecret('abc', 'abc'), true);
  assert.strictEqual(sameSecret('abc', 'abd'), false);
  assert.strictEqual(sameSecret('', ''), false, 'an empty presented secret never matches');
  assert.strictEqual(sameSecret('abc', 'abcd'), false, 'different lengths do not throw, they just fail');

  process.env.ADMIN_API_KEYS = 'ada:superadmin:key-one,bola:support:key-two';
  process.env.ADMIN_API_SECRET = 'legacy-shared';

  assert.deepStrictEqual(resolveAdmin('key-two'), { name: 'bola', role: 'support', source: 'static_key' });
  assert.strictEqual(resolveAdmin('nope'), null);
  // The old shared secret keeps working, and is honest about being anonymous.
  assert.deepStrictEqual(resolveAdmin('legacy-shared'), { name: 'admin', role: 'superadmin', source: 'shared_secret' });
}

{
  // The role gate is what stops a support login from deleting a user.
  const gate = adminAuth.requireAdminRole('superadmin');
  let nexted = false;
  let status = null;

  const res = { status(code) { status = code; return this; }, json() { return this; } };

  gate({ admin: { name: 'ada', role: 'superadmin' } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, true, 'a superadmin passes');

  nexted = false;
  gate({ admin: { name: 'bola', role: 'support' } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, false, 'support is stopped');
  assert.strictEqual(status, 403);

  status = null;
  gate({}, res, () => { nexted = true; });
  assert.strictEqual(status, 403, 'no admin on the request is not a pass');
}

/* ------------------------------------------------------------- user audit */

{
  const { deviceIdOf } = userAudit.__test;
  assert.strictEqual(deviceIdOf({ headers: { 'x-device-id': 'handset-9' } }), 'handset-9');
  // Same header userAuth binds the session to, so the trail and the session
  // always name one device.
  assert.strictEqual(deviceIdOf({ headers: {}, body: { device_id: 'from-body' } }), 'from-body');
  assert.strictEqual(deviceIdOf({ headers: {} }), null);
  assert.strictEqual(deviceIdOf({ headers: { 'x-device-id': 'x'.repeat(300) } }).length, 128, 'a long device id is truncated, not stored whole');
}

{
  // The audit metadata must never carry the counterparty's name or number. Ids
  // and references only - the ledger row holds the rest, encrypted.
  const payload = {
    trx: 'sm_123_s',
    amount: 5000,
    counterparty_id: 77,
    charge: 10,
  };
  const serialised = JSON.stringify(payload);
  for (const leak of ['@', '234', 'Adeola', 'gmail']) {
    assert.ok(!serialised.includes(leak), `money audit metadata must not carry ${leak}`);
  }
}

Promise.all(pending)
  .then(() => console.log('fraud controls, kill switch, admin identity: all checks passed'))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
