/**
 * Device-bound biometric login credential.
 *
 * The phone stores a random token in its keystore instead of the user's
 * password. The token is worth less than a password: it only works from the
 * device that enrolled it, it grants a login and nothing else, and it can be
 * revoked server side without the user changing anything they remember.
 *
 * Stored the same way as the PIN - `hashSecret` in the `biometric` domain, so
 * a database read hands out no working credential. See pii.helper.js.
 */
const crypto = require('crypto');
const prisma = require('../../database/prisma');
const { hashSecret, verifySecret } = require('./pii.helper');
const { invalidateUser } = require('../services/userCache.service');

const TOKEN_BYTES = 32;

/**
 * Replaces any existing credential - one device per account, matching the
 * single active session the rest of auth already enforces. Returns the plain
 * token, which is the only time it exists outside the phone.
 */
async function issueBiometricToken(userId, deviceId) {
  const device = String(deviceId || '').trim();
  if (!device) throw new Error('issueBiometricToken: device id is required');

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      biometric_hash: await hashSecret(token, 'biometric'),
      biometric_device_id: device,
      biometric_set_at: new Date(),
    },
  });
  await invalidateUser(userId);
  return token;
}

/**
 * True only when the token matches *and* it came from the device it was
 * enrolled on. Both halves are required: the device id alone is guessable and
 * the token alone would survive being lifted off a backup.
 */
async function verifyBiometricToken(user, token, deviceId) {
  const stored = String(user?.biometric_hash || '');
  const boundDevice = String(user?.biometric_device_id || '').trim();
  const device = String(deviceId || '').trim();
  if (!stored || !boundDevice || !device) return false;
  if (device !== boundDevice) return false;

  const check = await verifySecret(String(token || ''), stored, 'biometric');
  return check.ok === true;
}

/**
 * Called wherever the credential must stop working: the user turns biometrics
 * off, the password changes or is reset, the account moves to another device,
 * or the account is deleted. Failing quietly is deliberate - a revoke that
 * throws must not take down the password change that triggered it.
 */
async function revokeBiometric(userId) {
  try {
    await prisma.user.update({
      where: { id: Number(userId) },
      data: {
        biometric_hash: null,
        biometric_device_id: null,
        biometric_set_at: null,
      },
    });
    await invalidateUser(userId);
  } catch (e) {
    console.warn('⚠️ Failed to revoke biometric credential for user', userId, e?.message || e);
  }
}

module.exports = { issueBiometricToken, verifyBiometricToken, revokeBiometric };
