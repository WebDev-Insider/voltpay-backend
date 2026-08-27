// The index behind Bill Champions.
//
// `adminBillChampions.getChampions` runs two platform-wide aggregates over
// `wallet_transactions`, both of the same shape:
//
//   WHERE remark IN ('mobile_recharge','cable_tv','utility_bill')
//     AND trx_type = '-'   -- and again for '+', the refund leg
//     AND created_at >= <window start>
//   GROUP BY user_id
//
// Neither column is indexed today, so both are sequential scans of the largest
// table in the system, and `period=all` scans all of it twice. The screen
// worked; it was just paying full price for every render.
//
// Column order is by selectivity, with the range last - the only order a B-tree
// can use all three of:
//
//   remark      three values out of ~eight, and `= ANY(...)` is still an index
//               qual, so it narrows hardest and goes first.
//   trx_type    equality, but it only ever halves the rows.
//   created_at  a range. A range column ends the usable prefix, so anything
//               after it would be dead weight.
//
// This does nothing for `adminOps.getRevenue` or `spendingInsights.service`,
// which filter on trx_type + created_at with no remark at all: an unconstrained
// leading column means the index cannot be opened. That is a separate index if
// those ever need one - it is deliberately not this one.
//
// -- why this script is not wrapped in a transaction -------------------------
//
// Every other apply-*-ddl script in here runs inside BEGIN/COMMIT. This one
// cannot, because CREATE INDEX CONCURRENTLY is not allowed in a transaction
// block, and CONCURRENTLY is not optional here: a plain CREATE INDEX takes a
// SHARE lock on `wallet_transactions`, which blocks every INSERT for as long as
// the build runs. That table is where airtime, data, bills, transfers and
// refunds all land, so the non-concurrent build is a total payments outage
// lasting however long Postgres needs. Slower and online beats faster and down.
//
// The cost of CONCURRENTLY is that a failed build leaves an INVALID index
// behind rather than nothing - and an invalid index is worse than a missing
// one, because `IF NOT EXISTS` then skips it forever while the planner ignores
// it. So the first thing this does is look for that and drop it.
//
// Re-running is a no-op. Safe to run against a live database.
require('dotenv').config();
const { Client } = require('pg');

const TABLE = 'wallet_transactions';

// Prisma's own naming for @@index([remark, trx_type, created_at]). It has to
// match, or `prisma db push` sees a missing index and builds a second one.
const INDEX = 'wallet_transactions_remark_trx_type_created_at_idx';

/** An index left behind by a CONCURRENTLY build that did not finish. */
async function dropIfInvalid(client) {
  const { rows } = await client.query(
    `SELECT i.indisvalid, i.indisready
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [INDEX],
  );

  if (!rows.length) return;

  if (rows[0].indisvalid && rows[0].indisready) {
    console.log(`skip  ${INDEX} already exists and is valid`);

    return;
  }

  console.log(`warn  ${INDEX} exists but is INVALID - a previous build failed part way`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
  console.log(`ok    dropped the invalid ${INDEX}`);
}

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // The build reads the table twice and there is no bound on how long that
  // takes. A timeout firing half way does not give up cheaply - it leaves the
  // invalid index above.
  await client.query('SET statement_timeout = 0');

  await dropIfInvalid(client);

  console.log(`...   building ${INDEX} - this does not block writes, and may take a while`);
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX}
       ON ${TABLE} (remark, trx_type, created_at)`,
  );

  // CONCURRENTLY can report success and still have produced an index the
  // planner will not use, so the run is not finished until this says so.
  const { rows } = await client.query(
    `SELECT i.indisvalid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [INDEX],
  );

  if (!rows.length || !rows[0].indisvalid) {
    throw new Error(`${INDEX} was created but is not valid - re-run this script`);
  }

  console.log(`ok    ${INDEX} is valid`);

  // Fresh index, no statistics behind it yet. Without this the planner may keep
  // choosing the sequential scan it was choosing before, and the run looks like
  // it did nothing.
  console.log(`...   analyzing ${TABLE}`);
  await client.query(`ANALYZE ${TABLE}`);

  await client.end();
  console.log('done - no `prisma generate` needed, an index adds nothing to the client');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
