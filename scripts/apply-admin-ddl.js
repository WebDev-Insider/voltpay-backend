// Admin accounts DDL: the admin_users table behind /admin/auth/login.
//
// Prisma CLI cannot reach Neon from this machine (P1001 over IPv6), so the DDL
// goes over pg like the other apply-*-ddl scripts. Every statement is guarded,
// so re-running is a no-op.
//
// After this: `npx prisma generate`, then `node scripts/create-admin.js` to
// seed the first superadmin.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  // No FK to users: an admin is not a customer, and an admin's record must
  // outlive any account they touched.
  `CREATE TABLE IF NOT EXISTS admin_users (
     id                   serial PRIMARY KEY,
     name                 text NOT NULL,
     email_enc            text,
     email_idx            text,
     password             text NOT NULL,
     role                 text NOT NULL DEFAULT 'support',
     status               integer NOT NULL DEFAULT 1,
     totp_secret_enc      text,
     totp_enabled         boolean NOT NULL DEFAULT false,
     recovery_codes       jsonb,
     active_session_id    text,
     must_change_password boolean NOT NULL DEFAULT false,
     last_login_at        timestamp(3),
     last_login_ip        text,
     created_by           integer,
     created_at           timestamp(3) NOT NULL DEFAULT now(),
     updated_at           timestamp(3) NOT NULL DEFAULT now()
   )`,
  // One address, one account. The unique index is on the blind index, not the
  // ciphertext - AES-GCM is randomised, so two rows for the same email would
  // not collide on email_enc.
  `CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_idx_key ON admin_users (email_idx)`,
  `CREATE INDEX IF NOT EXISTS admin_users_role_status_idx ON admin_users (role, status)`,
];

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query('BEGIN');
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].trim()}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done - now run: npx prisma generate && node scripts/create-admin.js');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
