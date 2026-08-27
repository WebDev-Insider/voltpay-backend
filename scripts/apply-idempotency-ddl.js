// Replay guard for money routes: one row per payment attempt, keyed by a
// digest of (user, endpoint, client key).
//
// Prisma CLI cannot reach Neon from this machine (P1001 over IPv6), so the DDL
// goes over pg like the other apply-*-ddl scripts. Every statement is guarded,
// so re-running is a no-op.
//
// After this: `npx prisma generate` - the middleware degrades to the old
// behaviour (and warns) until the client knows about the model.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  // key_idx is a keyed digest, never the raw client key - same rule as every
  // other *_idx column. The unique index is what makes two racing taps safe.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     id              serial PRIMARY KEY,
     key_idx         text NOT NULL,
     user_id         integer NOT NULL,
     endpoint        text NOT NULL,
     fingerprint     text NOT NULL,
     status          text NOT NULL DEFAULT 'in_flight',
     response_status integer,
     response_body   jsonb,
     created_at      timestamp(3) NOT NULL DEFAULT now(),
     updated_at      timestamp(3) NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_key_idx_key ON idempotency_keys (key_idx)`,
  `CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at)`,
  `CREATE INDEX IF NOT EXISTS idempotency_keys_user_id_created_at_idx ON idempotency_keys (user_id, created_at)`,
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
