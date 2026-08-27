// Security checklist DDL: admin audit trail, account-deletion grace period,
// automatic payroll retry.
//
// Prisma CLI cannot reach Neon from this machine (P1001 over IPv6), so the DDL
// goes over pg like the other apply-*-ddl scripts. Every statement is guarded,
// so re-running is a no-op.
//
// After this: `npx prisma generate` - the audit writer no-ops until the client
// knows about the model.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  // Admin actions. No FK to users on purpose: deleting a user must not delete
  // the record of who deleted them.
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
     id          serial PRIMARY KEY,
     actor       text NOT NULL DEFAULT 'admin',
     action      text NOT NULL,
     method      text,
     path        text,
     target_type text,
     target_id   text,
     status_code integer,
     ip          text,
     user_agent  text,
     metadata    jsonb,
     created_at  timestamp(3) NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at)`,
  `CREATE INDEX IF NOT EXISTS admin_audit_log_target_type_target_id_idx ON admin_audit_log (target_type, target_id)`,

  // Cooling period before an account is actually wiped.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamp(3)`,
  `CREATE INDEX IF NOT EXISTS users_deletion_scheduled_at_idx ON users (deletion_scheduled_at)`,

  // Unattended retry of failed staff transfers, with a ceiling.
  `ALTER TABLE staffpay_payroll_runs ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE staffpay_payroll_runs ADD COLUMN IF NOT EXISTS next_retry_at timestamp(3)`,
  `CREATE INDEX IF NOT EXISTS staffpay_payroll_runs_next_retry_at_idx ON staffpay_payroll_runs (next_retry_at)`,
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
