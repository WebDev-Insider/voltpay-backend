/**
 * node test/idempotency.middleware.test.js
 *
 * No network, no database: covers the two pure decisions the replay guard
 * makes. If either is wrong the guard either double-charges (two payments
 * sharing a row) or blocks a legitimate one (a retry that fails to match).
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

const { fingerprint, keyDigest } = require('../src/middlewares/idempotency.middleware');

/* fingerprint - what makes a retry "the same payment" */

// A retry of the same attempt sends the same body, so it must match.
assert.strictEqual(
  fingerprint({ service: 'airtime', amount: 500 }),
  fingerprint({ service: 'airtime', amount: 500 }),
  'identical bodies must fingerprint the same'
);

// Same key, different payment: rejected rather than replayed.
assert.notStrictEqual(
  fingerprint({ service: 'airtime', amount: 500 }),
  fingerprint({ service: 'airtime', amount: 1000 }),
  'a different amount is a different payment'
);

// The PIN is stripped: a user who mistyped it once and retried the same
// payment must still match, and the secret must never reach a stored row.
assert.strictEqual(
  fingerprint({ amount: 500, pin: '1234' }),
  fingerprint({ amount: 500, pin: '9999' }),
  'the PIN is not part of what identifies a payment'
);
assert.strictEqual(fingerprint({ amount: 500 }), fingerprint({ amount: 500, password: 'x' }));
assert.strictEqual(fingerprint(null), fingerprint({}), 'an empty body is still fingerprintable');

/* key digest - scoping */

const KEY = 'attempt-abc';
assert.strictEqual(keyDigest(1, 'bills_confirm', KEY), keyDigest(1, 'bills_confirm', KEY), 'stable');

// Two users may generate the same key; they must not collide on one row.
assert.notStrictEqual(keyDigest(1, 'bills_confirm', KEY), keyDigest(2, 'bills_confirm', KEY), 'scoped per user');

// One key must not be replayable across endpoints - a stored airtime receipt
// answering a payroll run would hide a payment that never happened.
assert.notStrictEqual(
  keyDigest(1, 'bills_confirm', KEY),
  keyDigest(1, 'staffpay_payroll_run', KEY),
  'scoped per endpoint'
);

// The raw key is never what lands in the column.
assert.ok(!keyDigest(1, 'bills_confirm', KEY).includes(KEY), 'the client key is hashed, not stored');

console.log('✅ idempotency.middleware tests passed');
