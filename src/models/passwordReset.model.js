const prisma = require('../../database/prisma');

function normalizeResetType(type) {
  const t = String(type || 'pin').trim().toLowerCase();
  if (t === 'password' || t === 'password_reset') return 'password';
  return 'pin';
}

async function ensurePasswordResetsTable() {
  await prisma.$queryRaw`SELECT 1`;
}

async function insertToken(userId, email, token, type) {
  const normalizedType = normalizeResetType(type);
  const created = await prisma.passwordReset.create({
    data: {
      user_id: userId ? Number(userId) : null,
      email: email ? String(email).trim() : null,
      type: normalizedType,
      token: String(token),
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      used: false,
    },
  });
  return created;
}

async function findLatestByEmailAndToken(email, token, type) {
  const normalizedType = normalizeResetType(type);
  const row = await prisma.passwordReset.findFirst({
    where: {
      email: email ? { equals: String(email).trim(), mode: 'insensitive' } : null,
      type: normalizedType,
      token: String(token),
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
  ensurePasswordResetsTable,
  normalizeResetType,
  insertToken,
  findLatestByEmailAndToken,
  markUsed,
};
