// Scheduler hardening columns for StaffPay payroll.
//
//   staffpay_payroll_items.cycle_key  + UNIQUE (staff_id, cycle_key)
//       The double-pay guard. One item per staff member per payday, enforced by
//       the database so two server instances cannot both disburse.
//   staffpay_payroll_runs.mode / triggered_by_user_id
//       Whether a run came from the scheduler or a person, for the admin view.
//
// Additive only - existing rows get cycle_key NULL (treated as distinct by the
// unique index, so nothing already in the table can collide) and mode
// 'manual', which is what every run created before this was. Prisma CLI cannot
// reach Neon from this machine, so the DDL goes over pg. Re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  `ALTER TABLE staffpay_payroll_items ADD COLUMN IF NOT EXISTS cycle_key text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staffpay_payroll_items_staff_id_cycle_key_key
     ON staffpay_payroll_items (staff_id, cycle_key)`,
  `ALTER TABLE staffpay_payroll_runs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE staffpay_payroll_runs ADD COLUMN IF NOT EXISTS triggered_by_user_id integer`,
  `CREATE INDEX IF NOT EXISTS staffpay_payroll_runs_mode_created_at_idx
     ON staffpay_payroll_runs (mode, created_at)`,
];

const dns = require('dns');

/**
 * An A record for `hostname`, tried three ways.
 *
 * A plain `dns.resolve4()` is not good enough here. Node hands c-ares
 * 127.0.0.1 whenever it cannot read the Windows adapter DNS config, and
 * nothing listens there, so resolve4 fails ECONNREFUSED at exactly the moment
 * the fallback is needed. Order matters:
 *
 *   1. the OS resolver again - EAI_AGAIN means "temporary failure", so the
 *      retry usually just works, and this path has the Windows cache behind it
 *   2. c-ares aimed at the real configured servers, loopback filtered out
 *   3. public resolvers, for the case where the adapter config is unreadable
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

// This machine's OS resolver intermittently answers EAI_AGAIN for the Neon host
// while the network is otherwise fine, so fall back to resolving the A record
// and connecting by IP. Neon routes on SNI, so the original hostname has to
// stay as `servername` or the endpoint cannot be found.
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
