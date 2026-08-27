// Admin accounts: lookup, tokens, password policy, recovery codes.
//
// Shared by adminAuth.middleware (which verifies a token on every request) and
// adminAuth.controller (which issues them), so neither has to import the other.
//
// Admin sessions are signed with ADMIN_JWT_SECRET, deliberately not JWT_SECRET.
// A leaked customer token secret would otherwise mint admin tokens, and the two
// have completely different blast radii.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../../database/prisma');
const {
  blindIndex,
  hashSecret,
  verifySecret,
  encryptValue,
  decryptValue,
} = require('./pii.helper');

const ROLES = ['support', 'finance', 'superadmin'];

const ACCESS_TYP = 'admin';
// Issued after password, spent on the 2FA code. Short-lived on purpose: it is a
// half-authenticated credential.
const CHALLENGE_TYP = 'admin_2fa';
const CHALLENGE_TTL = '5m';

const RECOVERY_CODE_COUNT = 10;

function adminJwtSecret() {
  const secret = String(process.env.ADMIN_JWT_SECRET || '').trim();
  if (!secret) return null;
  if (secret === String(process.env.JWT_SECRET || '').trim()) {
    console.error('❌ ADMIN_JWT_SECRET must differ from JWT_SECRET');
    return null;
  }
  return secret;
}

function signAdminToken(admin, sessionId) {
  const secret = adminJwtSecret();
  if (!secret) return null;
  return jwt.sign(
    { sub: String(admin.id), typ: ACCESS_TYP, sid: String(sessionId), role: admin.role },
    secret,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h' },
  );
}

function signChallengeToken(adminId) {
  const secret = adminJwtSecret();
  if (!secret) return null;
  return jwt.sign({ sub: String(adminId), typ: CHALLENGE_TYP }, secret, { expiresIn: CHALLENGE_TTL });
}

/** @returns {object|null} the payload, or null for anything that does not verify. */
function verifyAdminToken(token, expectedTyp = ACCESS_TYP) {
  const secret = adminJwtSecret();
  if (!secret || !token) return null;
  try {
    const payload = jwt.verify(String(token), secret);
    if (payload?.typ !== expectedTyp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function findAdminByEmail(email) {
  const idx = blindIndex(normalizeEmail(email), 'email');
  if (!idx) return null;
  return prisma.adminUser.findFirst({ where: { email_idx: idx } });
}

function revealAdminEmail(row) {
  if (!row?.email_enc) return '';
  try {
    return decryptValue(row.email_enc);
  } catch (e) {
    console.error('adminAccount: failed to decrypt admin email', { admin_id: row.id });
    return '';
  }
}

/**
 * Never a bare spread: the row carries the password hash, the TOTP secret and
 * the hashed recovery codes.
 */
function publicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: revealAdminEmail(row),
    role: row.role,
    status: row.status,
    totp_enabled: !!row.totp_enabled,
    must_change_password: !!row.must_change_password,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

function emailFields(email) {
  const value = normalizeEmail(email);
  return { email_enc: encryptValue(value), email_idx: blindIndex(value, 'email') };
}

// Stricter than the customer rule (8-16). An admin password guards every
// account on the platform, and there is no PIN behind it.
function validateAdminPassword(password) {
  const value = String(password || '');
  if (value.length < 12 || value.length > 72) return 'Password must be between 12 and 72 characters';
  if (!/[A-Z]/.test(value)) return 'Password must include at least one uppercase letter';
  if (!/[a-z]/.test(value)) return 'Password must include at least one lowercase letter';
  if (!/[0-9]/.test(value)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Password must include at least one symbol';
  return '';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

/**
 * Ten single-use codes for a lost authenticator. Returned in plaintext exactly
 * once, at generation; only the hashes are stored, so a database read cannot
 * bypass 2FA.
 */
async function generateRecoveryCodes() {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase());
  const hashed = await Promise.all(plain.map(code => hashSecret(code, 'admin_recovery')));
  return { plain, hashed };
}

/**
 * Checks `code` against the stored hashes and returns the list with the used
 * one removed. Returns null when nothing matched.
 */
async function consumeRecoveryCode(stored, code) {
  const candidate = String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const list = Array.isArray(stored) ? stored : [];
  if (!candidate || !list.length) return null;

  for (let i = 0; i < list.length; i += 1) {
    const { ok } = await verifySecret(candidate, list[i], 'admin_recovery');
    if (ok) return list.filter((_, idx) => idx !== i);
  }
  return null;
}

module.exports = {
  ROLES,
  ACCESS_TYP,
  CHALLENGE_TYP,
  RECOVERY_CODE_COUNT,
  adminJwtSecret,
  signAdminToken,
  signChallengeToken,
  verifyAdminToken,
  findAdminByEmail,
  revealAdminEmail,
  publicAdmin,
  emailFields,
  normalizeEmail,
  validateAdminPassword,
  isValidEmail,
  generateRecoveryCodes,
  consumeRecoveryCode,
};
