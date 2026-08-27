const prisma = require('../../database/prisma');
const { blindIndex } = require('../helpers/pii.helper');

function normalizeResetType(type) {
  const t = String(type || 'pin').trim().toLowerCase();
  if (t === 'signup' || t === 'register' || t === 'registration') return 'signup';
  if (t === 'password' || t === 'password_reset') return 'password';
  // New-device login verification. Kept separate so a code mailed for one
  // purpose can never be replayed against another.
  if (t === 'device' || t === 'new_device') return 'device';
  // Bringing a self-deactivated account back. Separate from 'device' so a
  // reactivation code cannot be spent on a new-device login, or the reverse.
  if (t === 'reactivate' || t === 'reactivation') return 'reactivate';
  return 'pin';
}

async function ensurePasswordResetsTable() {
  await prisma.$queryRaw`SELECT 1`;
}

// Signup codes are verified on the first step of the registration wizard but
// only consumed when the account is created, so they have to outlive the
// address and password steps. Reset codes stay short-lived.
const TOKEN_TTL_MS = {
  signup: 20 * 60 * 1000,
  device: 10 * 60 * 1000,
  reactivate: 10 * 60 * 1000,
  // 10 minutes, not 5: the app now lets you leave for your inbox and come back
  // to the OTP step, and a code that dies while you are in the mail app just
  // sends everyone through "resend".
  password: 10 * 60 * 1000,
  pin: 10 * 60 * 1000,
};

async function insertToken(userId, email, token, type) {
  const normalizedType = normalizeResetType(type);
  const created = await prisma.passwordReset.create({
    data: {
      user_id: userId ? Number(userId) : null,
      email: null,
      email_idx: blindIndex(email, 'email'),
      type: normalizedType,
      token: '',
      token_idx: blindIndex(`${normalizedType}:${token}`, 'reset_token'),
      expires_at: new Date(Date.now() + (TOKEN_TTL_MS[normalizedType] || TOKEN_TTL_MS.pin)),
      used: false,
    },
  });
  return created;
}

async function findLatestByEmailAndToken(email, token, type) {
  const normalizedType = normalizeResetType(type);
  const row = await prisma.passwordReset.findFirst({
    where: {
      email_idx: blindIndex(email, 'email'),
      type: normalizedType,
      token_idx: blindIndex(`${normalizedType}:${token}`, 'reset_token'),
      used: false,
      expires_at: { gt: new Date() },
    },
    orderBy: { created_at: 'desc' },
  });
  return row || null;
}

async function markUsed(id) {
  await prisma.passwordReset.update({
    where: { id: Number(id) },
    data: { used: true },
  });
}

module.exports = {
  TOKEN_TTL_MS,
  ensurePasswordResetsTable,
  normalizeResetType,
  insertToken,
  findLatestByEmailAndToken,
  markUsed,
};
