// P3: Flutterwave -> Paystack column delta for the StaffPay tables.
// Prisma CLI cannot reach Neon from this machine, so the DDL goes over pg in
// one transaction. Every statement is guarded, so re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');

const TABLES = [
  'staffpay_companies',
  'staffpay_staff',
  'staffpay_payroll_runs',
  'staffpay_payroll_items',
  'staffpay_funding_transactions',
];

const RENAMES = [
  ['staffpay_companies', 'virtual_account_order_ref', 'paystack_customer_code'],
  ['staffpay_companies', 'virtual_account_flw_ref', 'paystack_dva_id'],
  ['staffpay_funding_transactions', 'flutterwave_tx_id', 'provider_tx_id'],
  ['staffpay_payroll_runs', 'flutterwave_fee_total', 'provider_fee_total'],
  ['staffpay_payroll_items', 'flutterwave_fee', 'provider_fee'],
];

const STATEMENTS = [
  `ALTER INDEX IF EXISTS staffpay_funding_transactions_flutterwave_tx_id_key
     RENAME TO staffpay_funding_transactions_provider_tx_id_key`,
  `ALTER TABLE staffpay_staff ADD COLUMN IF NOT EXISTS paystack_recipient_code text`,
  `ALTER TABLE staffpay_payroll_runs DROP COLUMN IF EXISTS batch_id`,
  // int -> text and a new name: the old column is dropped outright because the
  // table is empty and a Paystack transfer_code is not a number.
  `ALTER TABLE staffpay_payroll_items DROP COLUMN IF EXISTS flutterwave_transfer_id`,
  `ALTER TABLE staffpay_payroll_items ADD COLUMN IF NOT EXISTS provider_transfer_id text`,
  `ALTER TABLE staffpay_payroll_items ADD COLUMN IF NOT EXISTS refunded_at timestamp(3)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staffpay_payroll_items_reference_key
     ON staffpay_payroll_items(reference)`,
];

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Renames and drops are only safe because nothing is stored yet. Refuse
  // rather than destroy a row that appeared since this was written.
  for (const t of TABLES) {
    const { rows } = await client.query(`select count(*)::int c from ${t}`);
    if (rows[0].c !== 0) throw new Error(`${t} has ${rows[0].c} rows - refusing to rename/drop columns`);
  }

  await client.query('BEGIN');
  try {
    for (const [table, from, to] of RENAMES) {
      const { rows } = await client.query(
        `select column_name from information_schema.columns where table_name = $1 and column_name = any($2)`,
        [table, [from, to]]
      );
      const names = rows.map(r => r.column_name);
      if (names.includes(to)) { console.log(`skip  ${table}.${from} -> ${to} (already renamed)`); continue; }
      if (!names.includes(from)) throw new Error(`${table}.${from} not found and ${to} missing`);
      await client.query(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
      console.log(`ok    ${table}.${from} -> ${to}`);
    }

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
