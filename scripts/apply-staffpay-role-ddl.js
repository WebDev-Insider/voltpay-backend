// Staff role replaces the staff phone number in the app.
//
// `role` is added and `phone_enc` loses its NOT NULL - nothing is dropped, so
// businesses that already captured a phone keep it. Prisma CLI cannot reach
// Neon from this machine, so the DDL goes over pg. Re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  `ALTER TABLE staffpay_staff ADD COLUMN IF NOT EXISTS role text`,
  `ALTER TABLE staffpay_staff ALTER COLUMN phone_enc DROP NOT NULL`,
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
