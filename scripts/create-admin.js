// Seed an admin account. Used once to create the first superadmin - after that
// admins are created from the dashboard, where the action is audited.
//
//   node scripts/create-admin.js --name ada --email ada@voltpay.ng
//   node scripts/create-admin.js --name ada --email ada@voltpay.ng --role finance
//   node scripts/create-admin.js --email ada@voltpay.ng --reset
//
// The password is generated, printed once and stored only as a scrypt hash.
// The account is created with must_change_password, so whoever receives it has
// to set their own before the dashboard will do anything.

require('dotenv').config();
const { randomUUID } = require('crypto');
const prisma = require('../database/prisma');
const { hashSecret } = require('../src/helpers/pii.helper');
const {
  ROLES,
  findAdminByEmail,
  emailFields,
  normalizeEmail,
  isValidEmail,
  validateAdminPassword,
} = require('../src/helpers/adminAccount.helper');

const PASSWORD_DOMAIN = 'admin_password';

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : String(process.argv[i + 1] || '');
}

function generatePassword() {
  return `Vp!${randomUUID().replace(/-/g, '').slice(0, 16)}A1`;
}

(async () => {
  if (!prisma.adminUser) {
    throw new Error('prisma.adminUser is missing - run: node scripts/apply-admin-ddl.js && npx prisma generate');
  }

  const email = normalizeEmail(arg('--email'));
  const name = arg('--name').trim().slice(0, 64);
  const role = arg('--role', 'superadmin');
  const reset = process.argv.includes('--reset');

  if (!isValidEmail(email)) throw new Error('--email is required and must be a valid address');
  if (!ROLES.includes(role)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`);

  const password = arg('--password') || generatePassword();
  const invalid = validateAdminPassword(password);
  if (invalid) throw new Error(invalid);

  const hashed = await hashSecret(password, PASSWORD_DOMAIN);
  const existing = await findAdminByEmail(email);

  if (existing && !reset) {
    throw new Error(`An admin already exists for that email (id ${existing.id}). Pass --reset to issue a new password.`);
  }

  const row = existing
    ? await prisma.adminUser.update({
      where: { id: existing.id },
      // Dropping the session id logs out anyone holding the old password.
      data: { password: hashed, must_change_password: true, status: 1, active_session_id: null },
    })
    : await prisma.adminUser.create({
      data: { name: name || email.split('@')[0], ...emailFields(email), password: hashed, role, must_change_password: true },
    });

  console.log('');
  console.log(existing ? 'Password reset.' : 'Admin created.');
  console.log(`  id       ${row.id}`);
  console.log(`  name     ${row.name}`);
  console.log(`  role     ${row.role}`);
  console.log(`  password ${password}`);
  console.log('');
  console.log('Shown once. It is stored only as a hash. They must change it at first login.');

  await prisma.$disconnect();
})().catch(async e => {
  console.error('FAILED:', e.message);
  try { await prisma.$disconnect(); } catch (_) { /* already closed */ }
  process.exit(1);
});
