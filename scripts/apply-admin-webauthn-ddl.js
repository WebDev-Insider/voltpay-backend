// Admin fingerprint sign-in DDL: the passkeys admins register, and the
// one-time challenges each fingerprint prompt signs.
//
// Over pg like the other apply-*-ddl scripts (Prisma CLI cannot reach Neon
// from this machine). Every statement is guarded, so re-running is a no-op.
// admin_users itself is not touched: until this has run, the passkey routes
// answer 503 and password sign-in carries on exactly as before.
//
// After this: `npx prisma generate` (the deploy's npm install does it too).
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  // The public half of each passkey. The private half never leaves the
  // admin's device. Deleting an admin takes their passkeys with them.
  `CREATE TABLE IF NOT EXISTS admin_webauthn_credentials (
     id            serial PRIMARY KEY,
     admin_id      integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
     credential_id text NOT NULL,
     public_key    text NOT NULL,
     algorithm     integer NOT NULL,
     sign_count    bigint NOT NULL DEFAULT 0,
     user_handle   text NOT NULL,
     backed_up     boolean NOT NULL DEFAULT false,
     label_enc     text,
     last_used_at  timestamp(3),
     created_at    timestamp(3) NOT NULL DEFAULT now()
   )`,
  // Sign-in looks a passkey up by the id the device presents.
  `CREATE UNIQUE INDEX IF NOT EXISTS admin_webauthn_credentials_credential_id_key
     ON admin_webauthn_credentials (credential_id)`,
  `CREATE INDEX IF NOT EXISTS admin_webauthn_credentials_admin_id_idx ON admin_webauthn_credentials (admin_id)`,

  // One row per prompt: spent on first use, dead after two minutes. A table
  // rather than Redis because Redis fails open, and a challenge check that
  // fails open accepts a replay.
  // user_handle: the account id a setup offered, kept server side so the
  // passkey is saved under exactly what the device was told.
  `CREATE TABLE IF NOT EXISTS admin_webauthn_challenges (
     id          text PRIMARY KEY,
     purpose     text NOT NULL,
     admin_id    integer,
     challenge   text NOT NULL,
     user_handle text,
     expires_at  timestamp(3) NOT NULL,
     used_at     timestamp(3),
     created_at  timestamp(3) NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS admin_webauthn_challenges_expires_at_idx ON admin_webauthn_challenges (expires_at)`,
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
  console.log('done - now run: npx prisma generate');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
