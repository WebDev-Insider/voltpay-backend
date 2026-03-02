const prisma = require('../../database/prisma');

async function ensurePasswordResetsTable() {
  await prisma.$queryRaw`SELECT 1`;
}

async function insertToken(userId, email, token) {
  const created = await prisma.passwordReset.create({
    data: {
      user_id: userId ? Number(userId) : null,
      email: email ? String(email).trim() : null,
      token: String(token),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      used: false,
    },
  });
  return created;
}

async function findLatestByEmailAndToken(email, token) {
  const row = await prisma.passwordReset.findFirst({
    where: {
      email: email ? { equals: String(email).trim(), mode: 'insensitive' } : null,
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
  insertToken,
  findLatestByEmailAndToken,
  markUsed,
};
