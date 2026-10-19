// Scheduled top-ups: standing orders for airtime and data, and their run log.
//
//   scheduled_topups       one row per standing order
//   scheduled_topup_runs   one row per schedule per cycle
//       UNIQUE (schedule_id, cycle_key) is the double-charge guard. The worker
//       claims a cycle by inserting this row, so two instances - or a schedule
//       edited mid-week - can never buy the same week or month twice.
//
// Additive only: two new tables, nothing existing is touched. Prisma CLI
// cannot reach Neon from this machine, so the DDL goes over pg on DIRECT_URL
// like every other script here. Re-running is a no-op.
//
// Later columns are added with ALTER ... IF NOT EXISTS at the end of the list,
// because CREATE TABLE IF NOT EXISTS skips a table that is already there whole:
//   plan_gateway (2026-10-19) - which bills provider issued plan_id. Run this
//                 before deploying the multi-provider bills release, or the
//                 scheduled top-up reads fail on the missing column.
require('dotenv').config();
const { Client } = require('pg');
const dns = require('dns');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS scheduled_topups (
     id              serial PRIMARY KEY,
     user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
     service         text NOT NULL,
     provider        text NOT NULL,
     phone_enc       text NOT NULL,
     label           text,
     amount          numeric(15,2) NOT NULL,
     plan_id         text,
     plan_name       text,
     plan_validity   text,
     frequency       text NOT NULL,
     day_of_week     integer,
     day_of_month    integer,
     run_time        text NOT NULL,
     timezone        text NOT NULL DEFAULT 'Africa/Lagos',
     status          text NOT NULL DEFAULT 'active',
     pause_reason    text,
     notify_before   boolean NOT NULL DEFAULT true,
     next_run_at     timestamp(3),
     last_run_at     timestamp(3),
     reminder_cycle  text,
     deleted_at      timestamp(3),
     created_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS scheduled_topups_user_id_status_idx
     ON scheduled_topups (user_id, status)`,
  // The worker's due scan: active rows whose next_run_at has passed.
  `CREATE INDEX IF NOT EXISTS scheduled_topups_status_next_run_at_idx
     ON scheduled_topups (status, next_run_at)`,

  `CREATE TABLE IF NOT EXISTS scheduled_topup_runs (
     id              serial PRIMARY KEY,
     schedule_id     integer NOT NULL REFERENCES scheduled_topups(id) ON DELETE CASCADE ON UPDATE CASCADE,
     user_id         integer NOT NULL,
     cycle_key       text NOT NULL,
     scheduled_for   timestamp(3) NOT NULL,
     status          text NOT NULL DEFAULT 'running',
     attempts        integer NOT NULL DEFAULT 0,
     amount          numeric(15,2) NOT NULL,
     trx             text,
     next_retry_at   timestamp(3),
     failure_code    text,
     failure_message text,
     completed_at    timestamp(3),
     created_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS scheduled_topup_runs_schedule_id_cycle_key_key
     ON scheduled_topup_runs (schedule_id, cycle_key)`,
  // Retry pickup, and the processing / stranded sweeps, all lead with status.
  `CREATE INDEX IF NOT EXISTS scheduled_topup_runs_status_next_retry_at_idx
     ON scheduled_topup_runs (status, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS scheduled_topup_runs_schedule_id_created_at_idx
     ON scheduled_topup_runs (schedule_id, created_at)`,
  `ALTER TABLE scheduled_topups ADD COLUMN IF NOT EXISTS plan_gateway text`,
];

/**
 * An A record for `hostname`, tried three ways - see the same function in
 * apply-staffpay-scheduler-ddl.js for why a plain resolve4() is not enough on
 * this machine.
 */
async function resolveHostIp(hostname) {
  try {
    const { address } = await dns.promises.lookup(hostname, { family: 4 });
    return { ip: address, via: 'OS resolver (retry)' };
  } catch (_) { /* fall through */ }

  const configured = dns.promises.getServers()
    .filter(s => !/^(127\.|::1$|0\.0\.0\.0)/.test(s));

  for (const [servers, via] of [[configured, 'configured DNS'], [['1.1.1.1', '8.8.8.8'], 'public DNS']]) {
    if (!servers.length) continue;
    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(servers);
      const [ip] = await resolver.resolve4(hostname);
      if (ip) return { ip, via };
    } catch (_) { /* try the next set */ }
  }

  throw new Error(
    `could not resolve ${hostname}. DNS is down on this machine - check the router, ` +
    'or run this script from a network that resolves.',
  );
}

// Neon routes on SNI, so the original hostname stays as `servername` when the
// connection falls back to an IP.
async function connect() {
  const url = new URL(process.env.DIRECT_URL);
  const ssl = { rejectUnauthorized: false, servername: url.hostname };
  try {
    const client = new Client({ connectionString: process.env.DIRECT_URL, ssl });
    await client.connect();
    return client;
  } catch (e) {
    if (e?.code !== 'EAI_AGAIN' && e?.code !== 'ENOTFOUND') throw e;
    const { ip, via } = await resolveHostIp(url.hostname);
    const client = new Client({
      host: ip,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      ssl,
    });
    await client.connect();
    console.log(`note  resolved ${url.hostname} to ${ip} via ${via} (OS resolver failed first)`);
    return client;
  }
}

(async () => {
  const client = await connect();

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
