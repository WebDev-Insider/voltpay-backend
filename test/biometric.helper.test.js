/**
 * node test/biometric.helper.test.js
 *
 * Covers the half of the biometric credential that decides whether a login is
 * granted. `verifyBiometricToken` is pure over the user row, so it is testable
 * without a database - the issue/revoke halves are just writes.
 *
 * What must never regress: the right token from the wrong device is a no.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/db';

const { hashSecret } = require('../src/helpers/pii.helper');
const { verifyBiometricToken } = require('../src/helpers/biometric.helper');

(async function run() {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = 'device-abc-123';
  const user = {
    biometric_hash: await hashSecret(token, 'biometric'),
    biometric_device_id: device,
  };

  assert.ok(!user.biometric_hash.includes(token), 'stored hash must not contain the token');

  assert.ok(await verifyBiometricToken(user, token, device), 'right token from right device must pass');

  // The whole point of the device binding: a lifted token is dead elsewhere.
  assert.ok(!(await verifyBiometricToken(user, token, 'other-device')), 'right token from another device must fail');
  assert.ok(!(await verifyBiometricToken(user, token, '')), 'missing device id must fail');
  assert.ok(!(await verifyBiometricToken(user, token, '   ')), 'blank device id must fail');

  const other = crypto.randomBytes(32).toString('base64url');
  assert.ok(!(await verifyBiometricToken(user, other, device)), 'wrong token must fail');
  assert.ok(!(await verifyBiometricToken(user, '', device)), 'empty token must fail');
  assert.ok(!(await verifyBiometricToken(user, null, device)), 'null token must fail');

  // A revoked row is all nulls; it must not become a wildcard.
  const revoked = { biometric_hash: null, biometric_device_id: null };
  assert.ok(!(await verifyBiometricToken(revoked, token, device)), 'revoked credential must fail');
  assert.ok(!(await verifyBiometricToken(revoked, '', '')), 'revoked credential must fail on empties too');
  assert.ok(!(await verifyBiometricToken(null, token, device)), 'missing user must fail');

  // Enrolled but device column lost: fail closed, do not fall back to token only.
  const halfRow = { biometric_hash: user.biometric_hash, biometric_device_id: null };
  assert.ok(!(await verifyBiometricToken(halfRow, token, device)), 'no bound device must fail closed');

  console.log('✅ biometric.helper tests passed');
})().catch(err => {
  console.error('❌ biometric.helper tests failed');
  console.error(err);
  process.exit(1);
});
