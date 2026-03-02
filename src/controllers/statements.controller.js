const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

function parseMonthYear({ month, year }) {
  const now = new Date();
  const m = Number.parseInt(String(month ?? ''), 10);
  const y = Number.parseInt(String(year ?? ''), 10);
  const monthNum = Number.isFinite(m) && m >= 1 && m <= 12 ? m : (now.getMonth() + 1);
  const yearNum = Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : now.getFullYear();
  return { month: monthNum, year: yearNum };
}

function monthRange({ month, year }) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const endExclusive = new Date(year, month, 1, 0, 0, 0, 0);
  return { start, endExclusive };
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

    let monthlyDebitTotal = new Prisma.Decimal('0');
    let airtimeSpent = new Prisma.Decimal('0');
    let dataSpent = new Prisma.Decimal('0');
    let electricitySpent = new Prisma.Decimal('0');
    let cableSpent = new Prisma.Decimal('0');

    for (const r of monthRows) {
      if (String(r.trx_type) !== '-') continue;
      const amt = toDecimal(r.amount);
      monthlyDebitTotal = monthlyDebitTotal.plus(amt);

      const remark = String(r.remark || '').toLowerCase();
      if (remark === 'utility_bill') {
        electricitySpent = electricitySpent.plus(amt);
        continue;
      }
      if (remark === 'cable_tv') {
        cableSpent = cableSpent.plus(amt);
        continue;
      }

      if (remark === 'mobile_recharge') {
        const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
        const t = String(meta.type || '').toLowerCase();
        if (t === 'data') dataSpent = dataSpent.plus(amt);
        else airtimeSpent = airtimeSpent.plus(amt);
      }
    }

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

module.exports = { getStatements };
