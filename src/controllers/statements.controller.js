const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { categorize, isReversal } = require('../helpers/ledgerCategory.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');

function parseMonthYear({ month, year }) {
  // "This month" is the Nigerian one. On a UTC host the first hour of every
  // month would otherwise still default to the previous month.
  const now = lagosDateParts(new Date());
  const m = Number.parseInt(String(month ?? ''), 10);
  const y = Number.parseInt(String(year ?? ''), 10);
  const monthNum = Number.isFinite(m) && m >= 1 && m <= 12 ? m : now.month;
  const yearNum = Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : now.year;
  return { month: monthNum, year: yearNum };
}

/**
 * The month, in Nigerian time, as UTC instants.
 *
 * Not `new Date(year, month - 1, 1)`: that reads the server's timezone, so the
 * same statement covers different transactions on a Lagos host and a UTC one.
 * A purchase at 00:30 WAT on the 1st is 23:30 UTC the day before, and lands in
 * the previous month's statement on a UTC box. Same anchor the spending-insight
 * windows use, so a statement and the notification about it cover one period.
 *
 * `month + 1` is deliberate - lagosMidnightUtc normalises month 13 to next
 * January.
 */
function monthRange({ month, year }) {
  return {
    start: lagosMidnightUtc(year, month, 1),
    endExclusive: lagosMidnightUtc(year, month + 1, 1),
  };
}

function toDecimal(v) {
  try {
    if (v instanceof Prisma.Decimal) return v;
    if (v == null) return new Prisma.Decimal('0');
    return new Prisma.Decimal(String(v));
  } catch (_) {
    return new Prisma.Decimal('0');
  }
}

function moneyStr(dec) {
  const d = toDecimal(dec);
  return d.toFixed(2);
}

async function sumByTypeSince({ userId, since }) {
  if (!prisma.walletTransaction) return { plus: new Prisma.Decimal('0'), minus: new Prisma.Decimal('0') };

  const [plusAgg, minusAgg] = await Promise.all([
    prisma.walletTransaction.aggregate({
      _sum: { amount: true },
      where: {
        user_id: Number(userId),
        trx_type: '+',
        created_at: { gte: since },
      },
    }),
    prisma.walletTransaction.aggregate({
      _sum: { amount: true },
      where: {
        user_id: Number(userId),
        trx_type: '-',
        created_at: { gte: since },
      },
    }),
  ]);

  return {
    plus: toDecimal(plusAgg?._sum?.amount),
    minus: toDecimal(minusAgg?._sum?.amount),
  };
}

/**
 * What a month's rows add up to, per category.
 *
 * Decimal throughout, unlike the Number arithmetic in
 * spendingInsights.service.summarize() - that one rounds to a sentence, this one
 * is written to monthly_statements and read back as a figure.
 *
 * A refund is a credit that cancels a debit of the same kind (bills.controller
 * `refund()` stamps meta.reversal_of), so it comes back off the spend. Without
 * that, a purchase the provider declined reads as money gone - and because this
 * statement is persisted, the wrong number outlives the request that computed it.
 */
function summarizeMonth(rows) {
  const zero = () => new Prisma.Decimal('0');
  const byCategory = {};

  for (const r of rows || []) {
    const debit = String(r.trx_type) === '-';
    if (!debit && !isReversal(r)) continue;

    const amt = debit ? toDecimal(r.amount) : toDecimal(r.amount).negated();
    // categorize() is shared with the spending-insight push, so the statement
    // and the notification cannot quote different airtime/data numbers.
    const cat = categorize(r);
    byCategory[cat] = (byCategory[cat] || zero()).plus(amt);
  }

  // A refund can land in the month after its purchase, leaving that month
  // holding a reversal with no debit to cancel. Nobody spent less than nothing,
  // and a negative on a statement reads as a bug.
  //
  // Clamp each category first, then total them - clamping a running total
  // instead would leave the headline figure smaller than the categories printed
  // under it. Same order as spendingInsights.service.summarize().
  let monthlyDebitTotal = zero();
  for (const key of Object.keys(byCategory)) {
    if (byCategory[key].lessThan(0)) byCategory[key] = zero();
    monthlyDebitTotal = monthlyDebitTotal.plus(byCategory[key]);
  }

  const at = key => byCategory[key] || zero();

  return {
    monthlyDebitTotal,
    airtimeSpent: at('airtime'),
    dataSpent: at('data'),
    electricitySpent: at('electricity'),
    cableSpent: at('tv'),
  };
}

async function getStatements(req, res) {
  try {
    console.log('📥 Statements request (controller):', req.query);

    const user = req.user;
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const { month, year } = parseMonthYear(req.query || {});
    const { start, endExclusive } = monthRange({ month, year });

    const userId = Number(user.id);
    const currentBalance = toDecimal(user.balance ?? '0');

    // Balance at the start/end of the requested month
    const [{ plus: plusFromStart, minus: minusFromStart }, { plus: plusFromEnd, minus: minusFromEnd }] = await Promise.all([
      sumByTypeSince({ userId, since: start }),
      sumByTypeSince({ userId, since: endExclusive }),
    ]);

    const netFromStart = plusFromStart.minus(minusFromStart);
    const netFromEnd = plusFromEnd.minus(minusFromEnd);
    const startingBalance = currentBalance.minus(netFromStart);
    const endingBalance = currentBalance.minus(netFromEnd);

    // Month transactions
    let monthRows = [];
    try {
      if (prisma.walletTransaction) {
        monthRows = await prisma.walletTransaction.findMany({
          where: {
            user_id: userId,
            created_at: { gte: start, lt: endExclusive },
          },
          orderBy: { created_at: 'desc' },
          select: {
            trx: true,
            trx_type: true,
            amount: true,
            remark: true,
            details: true,
            meta: true,
            other_data: true,
            created_at: true,
          },
        });
      }
    } catch (e) {
      console.error('Error loading wallet transactions for statements:', e);
      monthRows = [];
    }

    const totalTxCount = monthRows.length;

    const {
      monthlyDebitTotal,
      airtimeSpent,
      dataSpent,
      electricitySpent,
      cableSpent,
    } = summarizeMonth(monthRows);

    const snapshot = monthRows.slice(0, 500).map(r => ({
      trx: String(r.trx || ''),
      trx_type: String(r.trx_type || ''),
      amount: moneyStr(r.amount),
      remark: String(r.remark || ''),
      details: r.details ? String(r.details) : '',
      meta: r.meta || null,
      other_data: r.other_data || null,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    }));

    // Persist snapshot (if model is migrated). If month has no transactions, clear any existing snapshot.
    try {
      if (prisma.monthlyStatement) {
        if (totalTxCount === 0) {
          await prisma.monthlyStatement
            .delete({
              where: {
                user_id_year_month: {
                  user_id: userId,
                  year,
                  month,
                },
              },
            })
            .catch(() => null);
        } else {
          await prisma.monthlyStatement.upsert({
            where: {
              user_id_year_month: {
                user_id: userId,
                year,
                month,
              },
            },
            create: {
              user_id: userId,
              year,
              month,
              starting_balance: startingBalance,
              ending_balance: endingBalance,
              total_transaction_amount: monthlyDebitTotal,
              total_transaction_count: totalTxCount,
              airtime_spent: airtimeSpent,
              data_spent: dataSpent,
              electricity_spent: electricitySpent,
              cable_spent: cableSpent,
              transactions_snapshot: snapshot,
              generated_at: new Date(),
            },
            update: {
              starting_balance: startingBalance,
              ending_balance: endingBalance,
              total_transaction_amount: monthlyDebitTotal,
              total_transaction_count: totalTxCount,
              airtime_spent: airtimeSpent,
              data_spent: dataSpent,
              electricity_spent: electricitySpent,
              cable_spent: cableSpent,
              transactions_snapshot: snapshot,
              generated_at: new Date(),
            },
          });
        }
      }
    } catch (e) {
      console.error('Failed to persist monthly statement:', e);
    }

    const response = {
      remark: 'statements',
      status: 'success',
      message: ['Statements fetched successfully'],
      data: {
        starting_balance: moneyStr(startingBalance),
        total_transaction_amount: moneyStr(monthlyDebitTotal),
        total_transaction_count: String(totalTxCount),
        total_commission: '0.00',
        current_balance: moneyStr(endingBalance),
        airtime_spent: moneyStr(airtimeSpent),
        data_spent: moneyStr(dataSpent),
        electricity_spent: moneyStr(electricitySpent),
        cable_spent: moneyStr(cableSpent),
        month: String(month),
        year: String(year),
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching statements (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch statements'],
      data: null
    });
  }
}

module.exports = {
  getStatements,
  // Exported for test/statements.controller.test.js and
  // scripts/backfill-statements.js - the backfill has to slice the month on
  // exactly the same boundaries this endpoint does, or it writes rows that a
  // fresh fetch immediately disagrees with.
  summarizeMonth,
  monthRange,
};
