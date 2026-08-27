const prisma = require('../../database/prisma');
const { blindIndex, hashSecret, revealUserFields } = require('../helpers/pii.helper');
const { revokeBiometric } = require('../helpers/biometric.helper');

// Email lives encrypted, so it cannot be matched with a WHERE on the value.
// The blind index is the keyed digest of the normalized (lowercased) email,
// which is what makes an equality lookup possible at all.
async function findBasicByEmail(email) {
  const idx = blindIndex(email, 'email');
  if (!idx) return null;
  const user = await prisma.user.findFirst({
    where: { email_idx: idx },
    select: { id: true, email_enc: true },
  });
  if (!user) return null;
  return { id: user.id, email: revealUserFields(user).email };
}

async function findByEmail(email) {
  const idx = blindIndex(email, 'email');
  if (!idx) return null;
  return (await prisma.user.findFirst({ where: { email_idx: idx } })) || null;
}

async function updatePinById(userId, pin) {
  const hashed = await hashSecret(String(pin), 'pin');
  await prisma.user.update({
    where: { id: Number(userId) },
    data: { pin: hashed },
  });
}

async function updatePasswordById(userId, password) {
  const hashed = await hashSecret(String(password), 'password');
  await prisma.user.update({
    where: { id: Number(userId) },
    data: { password: hashed },
  });
  // A password reset is what someone locked out of their account uses. Whoever
  // holds the phone must not keep a working biometric shortcut past it.
  await revokeBiometric(userId);
}

module.exports = { findBasicByEmail, findByEmail, updatePinById, updatePasswordById };
