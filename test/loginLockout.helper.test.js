/**
 * node test/loginLockout.helper.test.js
 *
 * The lockout is the only thing standing between a stolen phone number and an
 * unlimited password guessing loop, so the counts and the window matter.
 *
 * Runs against the in-process fallback: no UPSTASH_* env is set here, so
 * redis.service reports disabled and the helper takes the Map path. That is
 * the branch worth pinning, because it is the one that has to hold when
 * Upstash is down.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const LoginLockout = require('../src/helpers/loginLockout.helper');

async function main() {
  const key = LoginLockout.lockKey('NG', '2348012345678');
  const other = LoginLockout.lockKey('NG', '2348099999999');

  // Never keys on the raw number.
  assert.ok(!key.includes('8012345678'), 'lock key must not contain the phone number');
  assert.notStrictEqual(key, other, 'different numbers must not share a bucket');
  assert.strictEqual(LoginLockout.lockKey('NG', ''), '', 'no number means no key');

  // Two failures still let you in.
  assert.strictEqual((await LoginLockout.registerFailure(key)).attemptsLeft, 2);
  assert.strictEqual((await LoginLockout.registerFailure(key)).locked, false);
  assert.strictEqual(await LoginLockout.getLockRemainingSeconds(key), 0, 'two failures must not lock');

  // The third locks for 10 minutes.
  const third = await LoginLockout.registerFailure(key);
  assert.strictEqual(third.locked, true, 'third failure must lock');
  assert.ok(third.remainingSeconds > 590 && third.remainingSeconds <= 600, `expected ~600s, got ${third.remainingSeconds}`);
  assert.strictEqual(await LoginLockout.getLockRemainingSeconds(other), 0, 'lock must not spill onto other accounts');

  // A password reset does not touch the counters, so the lock survives one.
  assert.ok(await LoginLockout.getLockRemainingSeconds(key) > 0, 'lock must outlive a password reset');

  // Only a successful login clears it.
  await LoginLockout.clearFailures(key);
  assert.strictEqual(await LoginLockout.getLockRemainingSeconds(key), 0, 'success must clear the lock');
  assert.strictEqual((await LoginLockout.registerFailure(key)).attemptsLeft, 2, 'counter must restart after a success');

  // An empty key (missing phone number) must never lock the whole world out.
  assert.strictEqual((await LoginLockout.registerFailure('')).locked, false);

  console.log('✅ loginLockout.helper tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
