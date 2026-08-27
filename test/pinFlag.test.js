/**
 * The `pn` field the app writes its "this account has a PIN" flag from.
 *
 * The bug this guards: `req.user` is the userCache shape, where `pin` is null
 * and `has_pin` carries the truth. Reading `.pin` made /user-info answer "no
 * PIN" for everyone, so opening Edit Profile flipped the app's local flag off
 * and every PIN gate then refused to run.
 */

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const assert = require('assert');
const { pinFlag } = require('../src/helpers/pii.helper');

// A raw database row: the hash itself is present.
assert.strictEqual(pinFlag({ id: 1, pin: 'b3v1$salt$digest' }), '1');
assert.strictEqual(pinFlag({ id: 1, pin: null }), '0');

// The `req.user` shape. `pin` is nulled on purpose - `has_pin` is the answer.
assert.strictEqual(pinFlag({ id: 1, pin: null, has_pin: true }), '1', 'cached row with a PIN must report 1');
assert.strictEqual(pinFlag({ id: 1, pin: null, has_pin: false }), '0');

// has_pin wins even when both are present, because it is the field the cache
// maintains; a stale `pin` should never override it.
assert.strictEqual(pinFlag({ pin: null, has_pin: true }), '1');

assert.strictEqual(pinFlag(null), '0');
assert.strictEqual(pinFlag(undefined), '0');
assert.strictEqual(pinFlag({}), '0');

// The cache shaper and the flag must agree - this is the contract that broke.
const { __test } = require('../src/services/userCache.service');
if (__test && __test.forCache) {
  assert.strictEqual(pinFlag(__test.forCache({ id: 1, pin: 'hash', password: 'p', recovery_hash: null })), '1');
  assert.strictEqual(pinFlag(__test.forCache({ id: 1, pin: null, password: 'p', recovery_hash: null })), '0');
}

console.log('✅ pinFlag tests passed');
