const prisma = require('../../database/prisma');
const { notifyUser } = require('./notify.service');
const { categorize, isReversal, LABEL, BILL_CATEGORIES } = require('../helpers/ledgerCategory.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');

/**
 * Spending insights - one plain-English summary per closed week/month.
 *
 * "You spent ₦6,200 on data last month - 30% more than the month before."
 *
 * Read-only over wallet_transactions. It never touches a balance, so it is safe
 * to run twice: notifyUser() keys the row on client_message_id, which is the
 * period itself, so a restart or a double tick writes nothing the second time
 * (P2002 -> notifyUser returns false and skips the push too).
 *
 * MonthlyStatement is not used as the source: those rows only appear when a
 * user opens the statements screen, so a quiet user would have none.
 */

// A change under this is noise, not a habit.
const NOTABLE_PCT = 10;

/**
 * The two windows to compare, plus the key that makes the send idempotent.
 *
 * Always the *closed* period: run on Monday it reports Mon-Sun just gone, run
 * on the 1st it reports the whole of last month. A mid-period total would
 * compare a part-week against a full one and read as a drop every time.
 */
function windowsFor(period, now = new Date()) {
  const p = lagosDateParts(now);

  if (period === 'month') {
    const thisMonth = lagosMidnightUtc(p.year, p.month, 1);
    const lastMonth = lagosMidnightUtc(p.year, p.month - 1, 1);
    const monthBefore = lagosMidnightUtc(p.year, p.month - 2, 1);
    const k = lagosDateParts(lastMonth);
    return {
      label: 'month',
      key: `${k.year}-${String(k.month).padStart(2, '0')}`,
      current: { start: lastMonth, end: thisMonth },
      previous: { start: monthBefore, end: lastMonth },
    };
  }

  const week = 7 * 24 * 60 * 60 * 1000;
  const daysSinceMonday = (p.weekday + 6) % 7;
  const thisMonday = lagosMidnightUtc(p.year, p.month, p.day - daysSinceMonday);
  const lastMonday = new Date(thisMonday.getTime() - week);

  return {
    label: 'week',
    // Date of the Monday the window opens - unique per week without ISO week math.
    key: lastMonday.toISOString().slice(0, 10),
    current: { start: lastMonday, end: thisMonday },
    previous: { start: new Date(thisMonday.getTime() - 2 * week), end: lastMonday },
  };
}

/**
 * Total and per-category spend inside one window.
 *
 * Refunds are credits that cancel a debit in the same category (bills.controller
 * `refund()` stamps `meta.reversal_of`), so they come back off the spend -
 * otherwise a purchase the provider declined reads as money gone.
 *
 * Plain Number, not Prisma.Decimal: this is a sentence rounded to whole naira,
 * not a ledger write.
 */
function summarize(rows, { start, end }) {
  const byCategory = {};

  for (const row of rows || []) {
    const at = row?.created_at instanceof Date ? row.created_at : new Date(row?.created_at);
    if (Number.isNaN(at.getTime()) || at < start || at >= end) continue;

    const amount = Number(row?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const debit = String(row?.trx_type) === '-';
    if (!debit && !isReversal(row)) continue;

    const cat = categorize(row);
    byCategory[cat] = (byCategory[cat] || 0) + (debit ? amount : -amount);
  }

  // A refund can land in the period after its purchase, leaving this period
  // holding a reversal with no debit to cancel. Nobody spent less than nothing,
  // and "you spent ₦-700 on airtime" is not a sentence to push to anyone.
  // Same clamp as statements.controller so the two agree.
  let total = 0;
  for (const key of Object.keys(byCategory)) {
    if (byCategory[key] < 0) byCategory[key] = 0;
    total += byCategory[key];
  }

  return { total, byCategory };
}

function money(n) {
  return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

function describeDelta(now, before, label) {
  if (!(before > 0)) return '';
  const pct = Math.round(((now - before) / before) * 100);
  if (Math.abs(pct) < NOTABLE_PCT) return ` - about the same as the ${label} before`;
  return pct > 0
    ? ` - ${pct}% more than the ${label} before`
    : ` - ${Math.abs(pct)}% less than the ${label} before`;
}

function topBillCategory(byCategory) {
  let best = null;
  for (const key of BILL_CATEGORIES) {
    const amount = byCategory[key] || 0;
    if (amount > 0 && (!best || amount > best.amount)) best = { key, amount };
  }
  return best;
}

/** The sentence, or null when there is nothing worth saying. */
function buildInsight({ current, previous, period }) {
  if (!current || !(current.total > 0)) return null;

  const label = period === 'month' ? 'month' : 'week';
  const before = previous || { total: 0, byCategory: {} };
  const top = topBillCategory(current.byCategory);

  const message = top
    ? `You spent ${money(top.amount)} on ${LABEL[top.key]} last ${label}${describeDelta(top.amount, before.byCategory[top.key] || 0, label)}. That is part of ${money(current.total)} in total.`
    : `You spent ${money(current.total)} last ${label}${describeDelta(current.total, before.total, label)}.`;

  return {
    subject: label === 'month' ? 'Your monthly spending summary' : 'Your weekly spending summary',
    message,
    total: current.total,
    top: top ? top.key : null,
  };
}

/**
 * One user's summary for the closed period, or null if they spent nothing.
 *
 * Read-only, so the preview in scripts/send-spending-insights.js and the real
 * send read exactly the same numbers.
 */
async function insightForUser({ userId, period = 'week', now = new Date() }) {
  const { current, previous, key } = windowsFor(period, now);

  const rows = await prisma.walletTransaction.findMany({
    where: { user_id: Number(userId), created_at: { gte: previous.start, lt: current.end } },
    select: { trx_type: true, amount: true, remark: true, meta: true, created_at: true },
    // ponytail: a user with >1000 rows across two periods loses the oldest,
    // which is the comparison window. Raise or paginate if that shows up.
    orderBy: { created_at: 'desc' },
    take: 1000,
  });

  const insight = buildInsight({
    current: summarize(rows, current),
    previous: summarize(rows, previous),
    period,
  });

  return insight ? { ...insight, period, key } : null;
}

/** Everyone who spent something in the closed period, minus blocked accounts. */
async function spendingUserIds({ window, limit }) {
  const groups = await prisma.walletTransaction.groupBy({
    by: ['user_id'],
    where: { trx_type: '-', created_at: { gte: window.start, lt: window.end } },
    orderBy: { user_id: 'asc' },
    take: limit,
  });

  const ids = groups.map(g => Number(g.user_id)).filter(id => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  // A blocked or deactivated account still has last week's spend in the ledger
  // and must not be pushed to.
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, status: 1 },
    select: { id: true },
  });
  return users.map(u => u.id);
}

/**
 * Send one summary to everyone who spent anything in the closed period.
 *
 * Returns the number of users notified.
 */
async function sendSpendingInsights({ period = 'week', now = new Date(), limit = 5000, userIds = null } = {}) {
  if (!prisma.walletTransaction) return 0;

  const { current } = windowsFor(period, now);
  const targets = Array.isArray(userIds) && userIds.length
    ? userIds.map(Number).filter(Boolean)
    : await spendingUserIds({ window: current, limit });

  let sent = 0;

  // ponytail: one query per spending user. Fine at a few thousand; batch by
  // user_id if a tick ever starts overrunning its interval.
  for (const userId of targets) {
    try {
      const insight = await insightForUser({ userId, period, now });
      if (!insight) continue;

      // `data` is persisted, so ids and amounts only - no names, same rule as
      // the ledger `meta` column.
      const stored = await notifyUser({
        userId,
        subject: insight.subject,
        message: insight.message,
        type: 'spending_insight',
        data: { period, period_key: insight.key, total: Math.round(insight.total), top: insight.top },
        pushData: { type: 'spending_insight', period, period_key: insight.key },
        clientMessageId: `insight-${period}-${insight.key}`,
      });
      if (stored) sent += 1;
    } catch (e) {
      console.error('spending insight failed', { user_id: userId, error: e?.message || e });
    }
  }

  return sent;
}

/**
 * Hourly tick. Monthly on the 1st, weekly on Mondays, both from 09:00 WAT.
 *
 * The hour is a floor rather than an equality so a restart at 09:05 still
 * sends; the period key stops the extra ticks that follow from sending again.
 * A 1st that falls on a Monday sends the monthly summary only - two pushes in
 * one morning is spam.
 */
async function runSpendingInsightsTick(now = new Date()) {
  const enabled = String(process.env.SPENDING_INSIGHTS_ENABLED ?? 'true').trim().toLowerCase();
  if (enabled === 'false' || enabled === '0') return 0;

  const p = lagosDateParts(now);
  const sendHour = Number(process.env.SPENDING_INSIGHTS_HOUR_WAT || 9);
  if (p.hour < sendHour) return 0;

  if (p.day === 1) return sendSpendingInsights({ period: 'month', now });
  if (p.weekday === 1) return sendSpendingInsights({ period: 'week', now });
  return 0;
}

module.exports = {
  sendSpendingInsights,
  runSpendingInsightsTick,
  insightForUser,
  spendingUserIds,
  // Exported for test/spendingInsights.test.js
  windowsFor,
  summarize,
  buildInsight,
};
