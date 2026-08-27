/**
 * StaffPay company + staff PII: plain columns out, `*_enc` / `*_idx` in.
 *
 * The tables are empty, so the plain columns are dropped outright rather than
 * dual-written and backfilled. The row guard below is what makes that safe - if
 * a business has signed up since, this refuses and the migration needs a
 * backfill step (read plain, protect(), write enc) before the drops.
 *
 * Prisma CLI cannot reach Neon from this machine, so the DDL goes over pg in
 * one transaction. Re-running is a no-op.
 */
require('dotenv').config();
const { Client } = require('pg');

const TABLES = ['staffpay_companies', 'staffpay_staff'];

const STATEMENTS = [
  `ALTER TABLE staffpay_companies
     ADD COLUMN IF NOT EXISTS name_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS name_idx text,
     ADD COLUMN IF NOT EXISTS address_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS phone_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS phone_idx text,
     ADD COLUMN IF NOT EXISTS email_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS email_idx text`,
  // The default only exists to satisfy NOT NULL during the ALTER; every write
  // goes through protectCompanyFields(), so no row should ever rely on it.
  `ALTER TABLE staffpay_companies
     ALTER COLUMN name_enc DROP DEFAULT,
     ALTER COLUMN address_enc DROP DEFAULT,
     ALTER COLUMN phone_enc DROP DEFAULT,
     ALTER COLUMN email_enc DROP DEFAULT`,
  `ALTER TABLE staffpay_companies
     DROP COLUMN IF EXISTS name,
     DROP COLUMN IF EXISTS address,
     DROP COLUMN IF EXISTS phone,
     DROP COLUMN IF EXISTS email`,

  `ALTER TABLE staffpay_staff
     ADD COLUMN IF NOT EXISTS full_name_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS phone_enc text NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS phone_idx text,
     ADD COLUMN IF NOT EXISTS account_name_enc text`,
  `ALTER TABLE staffpay_staff
     ALTER COLUMN full_name_enc DROP DEFAULT,
     ALTER COLUMN phone_enc DROP DEFAULT`,
  `ALTER TABLE staffpay_staff
     DROP COLUMN IF EXISTS full_name,
     DROP COLUMN IF EXISTS phone,
     DROP COLUMN IF EXISTS account_name`,
];

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  for (const t of TABLES) {
    const { rows } = await client.query(`select count(*)::int c from ${t}`);
    if (rows[0].c !== 0) throw new Error(`${t} has ${rows[0].c} rows - needs a backfill before the plain columns are dropped`);
  }

  await client.query('BEGIN');
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].trim()} ...`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
