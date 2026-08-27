// Account deletion lifecycle columns on users.
//
// deletion_scheduled_at already exists; this adds the ask, the reason and the
// terminal stamp. Additive only - nothing is dropped and no default changes, so
// a row mid-flight through the old flow keeps working. Prisma CLI cannot reach
// Neon from this machine, so the DDL goes over pg. Re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamp(3)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_reason text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamp(3)`,
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
  console.log('done');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
