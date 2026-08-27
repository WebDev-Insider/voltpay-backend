#!/usr/bin/env node
/**
 * Recompute the spend figures on existing monthly_statements rows.
 *
 * Two fixes landed in statements.controller after these rows were written:
 *   1. the airtime/data split read meta.type, which is only stamped once the
 *      provider accepts - so every still-processing data bundle was filed as
 *      airtime;
 *   2. refunds were counted as spend, so a purchase the provider declined
 *      inflated the month.
 *
 * A monthly_statements row is a cache of a computation, not a record of
 * anything that happened, so it is safe to recompute. Only the five spend
 * figures are touched:
 *
 *     total_transaction_amount, airtime_spent, data_spent,
 *     electricity_spent, cable_spent
 *
 * Balances, counts and transactions_snapshot are left exactly as they are -
 * they were never affected, and rewriting correct data is how a backfill turns
 * into an incident.
 *
 *   node scripts/backfill-statements.js --verify   # how many rows are stale
 *   node scripts/backfill-statements.js --dry      # print every change, write none
 *   node scripts/backfill-statements.js            # write
 *   node scripts/backfill-statements.js --user=42  # one user
 *
 * Idempotent and safe to re-run: a row already holding the right numbers is
 * skipped, so a second pass reports 0 changed.
 *
 * Month boundaries come from statements.controller's own monthRange(), which is
 * anchored to Lagos rather than the host clock, so this can be run from
 * anywhere and still slice the month the way the API does.
 *
 * Prints user ids and amounts only, never a name, email or phone.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const prisma = require('../database/prisma');
const { Prisma } = require('@prisma/client');
const { summarizeMonth, monthRange } = require('../src/controllers/statements.controller');

const BATCH = 200;

const FIELDS = [
  ['total_transaction_amount', 'monthlyDebitTotal'],
  ['airtime_spent', 'airtimeSpent'],
  ['data_spent', 'dataSpent'],
  ['electricity_spent', 'electricitySpent'],
  ['cable_spent', 'cableSpent'],
];

function flag(name) {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
}

function money(v) {
  try {
    return (v instanceof Prisma.Decimal ? v : new Prisma.Decimal(String(v ?? '0'))).toFixed(2);
  } catch (_) {
    return '0.00';
  }
}

/** What this row should hold, and whether that differs from what it does hold. */
async function recompute(row) {
  const { start, endExclusive } = monthRange({ month: row.month, year: row.year });

  const rows = await prisma.walletTransaction.findMany({
    where: { user_id: row.user_id, created_at: { gte: start, lt: endExclusive } },
    select: { trx_type: true, amount: true, remark: true, meta: true },
  });

  const fresh = summarizeMonth(rows);
  const changes = [];
  const data = {};

  for (const [column, key] of FIELDS) {
    const before = money(row[column]);
    const after = money(fresh[key]);
    if (before === after) continue;
    changes.push(`${column} ${before} -> ${after}`);
    data[column] = fresh[key];
  }

  return { changes, data };
}

(async () => {
  const dry = Boolean(flag('dry'));
  const verify = Boolean(flag('verify'));
  const userArg = flag('user');
  const write = !dry && !verify;

  if (!prisma.monthlyStatement) {
    console.error('❌ Prisma has no monthlyStatement model. Run prisma generate.');
    process.exit(1);
  }

  const where = userArg && userArg !== true ? { user_id: Number(userArg) } : {};
  const total = await prisma.monthlyStatement.count({ where });
  if (!total) {
    console.log('ℹ️  No monthly_statements rows to check.');
    await prisma.$disconnect();
    process.exit(0);
  }

  let cursor = 0;
  let seen = 0;
  let stale = 0;
  let written = 0;

  for (;;) {
    const batch = await prisma.monthlyStatement.findMany({
      where: { ...where, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      seen += 1;
      let result;
      try {
        result = await recompute(row);
      } catch (e) {
        console.error(`   ⚠️  statement ${row.id} (user ${row.user_id}, ${row.year}-${String(row.month).padStart(2, '0')}) failed: ${e?.message || e}`);
        continue;
      }

      if (!result.changes.length) continue;
      stale += 1;

      if (!verify) {
        console.log(`   user ${row.user_id} ${row.year}-${String(row.month).padStart(2, '0')}: ${result.changes.join(', ')}`);
      }

      if (write) {
        await prisma.monthlyStatement.update({ where: { id: row.id }, data: result.data });
        written += 1;
      }
    }

    console.log(`   ...${seen}/${total} checked`);
  }

  console.log(`\nrows checked: ${seen}`);
  console.log(`rows stale:   ${stale}`);

  if (verify) {
    console.log(stale ? '\n❌ stale rows present - run without --verify to fix them' : '\n✅ clean - every row matches what the endpoint would compute');
  } else if (dry) {
    console.log('\n🔍 Dry run. Nothing was written.');
  } else {
    console.log(`rows written: ${written}`);
    console.log('\n✅ Backfill complete. Re-run with --verify to confirm 0 stale.');
  }

  await prisma.$disconnect();
  process.exit(verify && stale ? 1 : 0);
})();
