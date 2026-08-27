// staffpay_payroll_items.paid_at - when the salary actually landed.
//
// Reporting used to bucket "staff paid per day" on updated_at, which is
// @updatedAt: it moves whenever the webhook, the sync poll or the stranded
// sweep touches a row. That put payments under the wrong day and, because the
// window filter matched the touch rather than the payment, pulled months-old
// items into a 7-day chart.
//
// paid_at is stamped once on the transition into SUCCESSFUL and cleared when a
// retry puts an item back to NEW, so it only ever means one thing.
//
// Additive and idempotent. Existing SUCCESSFUL rows are backfilled from
// updated_at - the closest thing to a payment time that survives in those rows,
// and correct for any item that was not touched again after it succeeded.
// Nothing else reads the column yet, so the backfill cannot regress a balance.
// Prisma CLI cannot reach Neon from this machine, so the DDL goes over pg.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  `ALTER TABLE staffpay_payroll_items ADD COLUMN IF NOT EXISTS paid_at timestamp(3)`,
  `CREATE INDEX IF NOT EXISTS staffpay_payroll_items_status_paid_at_idx
     ON staffpay_payroll_items (status, paid_at)`,
  // Backfill only where we have nothing better. Never overwrites a stamped row,
  // so re-running this script cannot move a payment date.
  `UPDATE staffpay_payroll_items
      SET paid_at = updated_at
    WHERE status = 'SUCCESSFUL' AND paid_at IS NULL`,
  // A non-successful item was never paid; make sure no backfill or earlier
  // experiment left a date on one.
  `UPDATE staffpay_payroll_items
      SET paid_at = NULL
    WHERE status <> 'SUCCESSFUL' AND paid_at IS NOT NULL`,
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
      const res = await client.query(sql);
      const rows = typeof res.rowCount === 'number' && /^UPDATE/i.test(sql.trim())
        ? ` (${res.rowCount} row(s))`
        : '';
      console.log(`ok    ${sql.split('\n')[0].trim()}${rows}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  const { rows } = await client.query(
    `SELECT status, count(*)::int AS n, count(paid_at)::int AS stamped
       FROM staffpay_payroll_items GROUP BY status ORDER BY n DESC`,
  );
  console.log('\nitems by status (stamped = has paid_at):');
  for (const r of rows) console.log(`  ${String(r.status).padEnd(12)} ${r.n} total, ${r.stamped} stamped`);

  await client.end();
  console.log('\ndone');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
