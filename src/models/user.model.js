const prisma = require('../../database/prisma');
const bcrypt = require('bcryptjs');

async function findBasicByEmail(email) {
  const user = await prisma.user.findFirst({
    where: {
      email: email ? { equals: String(email), mode: 'insensitive' } : null,
    },
    select: { id: true, email: true },
  });
  return user || null;
}

async function findByEmail(email) {
  const user = await prisma.user.findFirst({
    where: {
      email: email ? { equals: String(email), mode: 'insensitive' } : null,
    },
  });
  return user || null;
}

async function updatePinById(userId, pin) {
  const hashed = await bcrypt.hash(String(pin), 10);
  await prisma.user.update({
    where: { id: Number(userId) },
    data: { pin: hashed },
  });
}

async function updatePasswordById(userId, password) {
  const hashed = await bcrypt.hash(String(password), 10);
  await prisma.user.update({
    where: { id: Number(userId) },
    data: { password: hashed },
  });
}

module.exports = { findBasicByEmail, findByEmail, updatePinById, updatePasswordById };
