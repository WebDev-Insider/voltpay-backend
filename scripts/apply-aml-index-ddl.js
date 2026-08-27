// The indexes behind the AML report.
//
// `adminRisk.getAmlReport` scans a date window over two money sources with no
// account filter at all:
//
//   wallet_transactions              WHERE created_at >= <window> ORDER BY created_at DESC
//   staffpay_funding_transactions    WHERE status = 'successful' AND credited_at >= <window>
//
// Neither had an index that could be opened for it. `wallet_transactions`
// carries (user_id, created_at) and (remark, trx_type, created_at), and
// `staffpay_funding_transactions` carries (company_id, created_at) - every one
// of them leads with a column the AML scan does not constrain, and an
// unconstrained leading column means the planner cannot use the index at all.
// So the compliance screen was paying for a sequential scan of the largest table
// in the system, plus a sort, on every render.
//
// The outbound StaffPay side already has what it needs: StaffPayPayrollItem
// declares @@index([status, paid_at]), which serves the SUCCESSFUL-items read
// exactly. Nothing to build there.
//
// Column order:
//
//   wallet_transactions            (created_at) - a lone range column
//   staffpay_funding_transactions  (status, credited_at) - equality first, the
//                                  range last, the only order a B-tree can use
//                                  both of. Same shape as the payroll item
//                                  index it mirrors.
//
// -- why this script is not wrapped in a transaction -------------------------
//
// CREATE INDEX CONCURRENTLY is not allowed in a transaction block, and
// CONCURRENTLY is not optional on `wallet_transactions`: a plain CREATE INDEX
// takes a SHARE lock, which blocks every INSERT for as long as the build runs.
// That table is where airtime, data, bills, transfers and refunds all land, so
// a non-concurrent build is a total payments outage lasting however long
// Postgres needs. Slower and online beats faster and down.
//
// The cost of CONCURRENTLY is that a failed build leaves an INVALID index behind
// rather than nothing - and an invalid index is worse than a missing one,
// because `IF NOT EXISTS` then skips it forever while the planner ignores it. So
// each index is checked for that first and dropped if found.
//
// Re-running is a no-op. Safe to run against a live database.
require('dotenv').config();
const { Client } = require('pg');

// Prisma's own naming for these @@index declarations. They have to match, or
// `prisma db push` sees a missing index and builds a second one.
const INDEXES = [
  {
    name: 'wallet_transactions_created_at_idx',
    table: 'wallet_transactions',
    columns: '(created_at)',
  },
  {
    name: 'staffpay_funding_transactions_status_credited_at_idx',
    table: 'staffpay_funding_transactions',
    columns: '(status, credited_at)',
  },
];

async function indexState(client, name) {
  const { rows } = await client.query(
    `SELECT i.indisvalid, i.indisready
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [name],
  );

  return rows[0] || null;
}

/** An index left behind by a CONCURRENTLY build that did not finish. */
async function dropIfInvalid(client, name) {
  const state = await indexState(client, name);

  if (!state) return false;

  if (state.indisvalid && state.indisready) {
    console.log(`skip  ${name} already exists and is valid`);

    return true;
  }

  console.log(`warn  ${name} exists but is INVALID - a previous build failed part way`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  console.log(`ok    dropped the invalid ${name}`);

  return false;
}

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // The builds read each table twice and there is no bound on how long that
  // takes. A timeout firing half way does not give up cheaply - it leaves the
  // invalid index above.
  await client.query('SET statement_timeout = 0');

  const analyzed = new Set();

  for (const { name, table, columns } of INDEXES) {
    if (await dropIfInvalid(client, name)) continue;

    console.log(`...   building ${name} - this does not block writes, and may take a while`);
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${columns}`);

    // CONCURRENTLY can report success and still have produced an index the
    // planner will not use, so the run is not finished until this says so.
    const state = await indexState(client, name);

    if (!state || !state.indisvalid) {
      throw new Error(`${name} was created but is not valid - re-run this script`);
    }

    console.log(`ok    ${name} is valid`);
    analyzed.add(table);
  }

  // Fresh indexes, no statistics behind them yet. Without this the planner may
  // keep choosing the sequential scan it was choosing before, and the run looks
  // like it did nothing.
  for (const table of analyzed) {
    console.log(`...   analyzing ${table}`);
    await client.query(`ANALYZE ${table}`);
  }

  await client.end();
  console.log('done - no `prisma generate` needed, an index adds nothing to the client');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
