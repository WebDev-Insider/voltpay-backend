/**
 * Bill Champions - who pays the most bills on VoltPay, and the card we post
 * about it.
 *
 * Mounted under /api/admin behind adminAuth.middleware. Read-only: nothing here
 * writes, and nothing here sends. The output of this screen leaves the building
 * as a social post, which is the whole reason its rules are stricter than a
 * reporting screen's would otherwise need to be.
 *
 * Four rules, each of which exists because getting it wrong is public:
 *
 *   1. `categorize()` from ledgerCategory.helper decides what a row was spent
 *      on. It is shared with the monthly statement and the spending-insight
 *      push, so a champion's total here and the total on their own statement
 *      cannot drift apart. Airtime and data share `remark: 'mobile_recharge'`
 *      and are only told apart in `meta`, which is exactly the split a
 *      hand-rolled groupBy would get wrong.
 *
 *   2. Refunds come off - from the leaderboard and from the totals printed
 *      beside it. A declined bill is refunded with a credit carrying
 *      `meta.reversal_of` (billSettlement.helper), and on this rail the decline
 *      can arrive minutes later on the webhook. The leaderboard matches each
 *      refund to its own purchase by `trx`, read with no upper bound - a Sunday
 *      purchase refunded on Monday must not still be standing on the podium.
 *      The platform totals net the window's refunds in aggregate and clamp at
 *      zero, which is how statements.controller and spendingInsights.service
 *      already do it. Same rule Bill Hero applies.
 *
 *   3. Betting is not a utility bill and is excluded outright. It is spend, it
 *      is categorised, and it would inflate someone straight to the top - and
 *      "congratulations to our top customer" over a gambling total is not a
 *      post this company can make.
 *
 *   4. Only live customer accounts are eligible, and they are dropped before
 *      the ranking is cut down to candidates rather than after. A blocked,
 *      deactivated, deleted or staff-held account cannot be shouted out, and
 *      the internal test accounts are the ones most likely to top an unfiltered
 *      chart - which is exactly how, filtered afterwards, they would crowd real
 *      customers out of the candidate window before anyone looked at them.
 *
 * Rules 2 and 4 apply to the four stat cards as much as to the leaderboard.
 * They did not always: the totals were the raw debit aggregate, refunds and
 * staff accounts still in them, sitting above a leaderboard that had both taken
 * out - and "top 10 are X% of the spend" divided the one by the other.
 */
const prisma = require('../../database/prisma');
const { revealUserFields } = require('../helpers/pii.helper');
const { categorize } = require('../helpers/ledgerCategory.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');
const { startOfWeekLagosUtc } = require('./billHero.controller');

// The three remarks bills.controller writes (SERVICES.dbRemark). `betting` is
// deliberately absent - see rule 3.
const BILL_REMARKS = ['mobile_recharge', 'cable_tv', 'utility_bill'];

// The categories `categorize()` can return for those remarks, in the order they
// should appear in a stacked bar. Anything outside this list is a row that
// reached us through a remark we did not ask for, and is dropped.
const CATEGORIES = ['airtime', 'data', 'electricity', 'tv'];

const CATEGORY_LABEL = {
  airtime: 'Airtime',
  data: 'Data',
  electricity: 'Electricity',
  tv: 'TV subscription',
};

const DEBIT = '-';

// The credit leg of a bill refund. `billSettlement.settleFailure` is the only
// writer on the ledger that creates a `+` row carrying a bill remark - every
// other credit is `fund_account`, `receive_money` or `betting` - so this pair of
// filters *is* the refund, and finding one needs no JSON predicate on `meta`.
const CREDIT = '+';

// Stage 1 ranks every eligible payer in SQL; stage 2 opens the rows of the
// plausible winners only. Stage 1 is already netted and already filtered, so the
// multiplier is no longer headroom for refunds reshuffling the order. It is
// headroom for the one way the two stages can still disagree: stage 1 nets a
// window's refunds in aggregate, stage 2 matches each refund to the purchase it
// cancels, and a bill bought just before the window and refunded just inside it
// is counted differently by the two. That gap is small, so this can be.
const CANDIDATE_MULTIPLIER = 5;
const MIN_CANDIDATES = 60;

function fail(res, message, remark = 'validation_error', code = 400) {
  return res.status(code).json({ remark, status: 'error', message: [message], data: null });
}

function ok(res, data, message = 'OK', remark = 'bill_champions') {
  return res.json({ remark, status: 'success', message: [message], data });
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}

/**
 * The Nigerian calendar window a period name refers to.
 *
 * Built from lagosMidnightUtc rather than `new Date(y, m, 1)`, so "this month"
 * means the same window on a Lagos box and on Render's UTC one. A purchase at
 * 00:30 WAT on the 1st is 23:30 UTC on the last of the previous month, and
 * would otherwise be credited to the wrong champion.
 */
function windowFor(period, now = new Date()) {
  const p = lagosDateParts(now);

  if (period === 'week') {
    return { start: startOfWeekLagosUtc(now), label: 'This week' };
  }

  if (period === 'year') {
    return { start: lagosMidnightUtc(p.year, 1, 1), label: `${p.year}` };
  }

  if (period === 'all') {
    // Not a real instant, just "before VoltPay existed". Safe to leave
    // unbounded because stage 1 aggregates in SQL and stage 2 only ever opens
    // the candidate users' own rows.
    return { start: new Date(0), label: 'All time' };
  }

  return { start: lagosMidnightUtc(p.year, p.month, 1), label: 'This month' };
}

/** An empty per-category tally, so every champion has the same shape. */
function emptyCategories() {
  const out = {};

  for (const key of CATEGORIES) out[key] = { spend: 0, count: 0 };

  return out;
}

/**
 * Fold ledger rows into one entry per user, refunds netted off.
 *
 * Pure and exported so the rules above can be checked without a database -
 * `test/adminBillChampions.test.js` is the only thing standing between a
 * refunded purchase and a public post about it.
 *
 * `debits` are bill debits in the window. `reversals` are the credit legs of
 * refunds, from the window start onwards with no upper bound: a refund is
 * matched to its purchase by `meta.reversal_of`, not by when it landed.
 */
function tallyBillRows(debits, reversals) {
  const refunded = new Set();

  for (const r of reversals || []) {
    const ref = r?.meta && typeof r.meta === 'object' ? r.meta.reversal_of : null;

    if (ref) refunded.add(String(ref));
  }

  const byUser = new Map();

  for (const row of debits || []) {
    if (refunded.has(String(row?.trx))) continue;

    const amount = num(row?.amount);

    if (amount <= 0) continue;

    const category = categorize(row);

    // A remark outside BILL_REMARKS cannot reach here through the query, but a
    // future remark that categorises to `transfer` or `other` would - and it
    // must not be counted as a bill just because it arrived.
    if (!CATEGORIES.includes(category)) continue;

    const uid = Number(row?.user_id);

    if (!Number.isFinite(uid)) continue;

    const entry = byUser.get(uid) || {
      user_id: uid,
      spend: 0,
      count: 0,
      categories: emptyCategories(),
      first_paid_at: null,
      last_paid_at: null,
    };

    entry.spend += amount;
    entry.count += 1;
    entry.categories[category].spend += amount;
    entry.categories[category].count += 1;

    const at = row?.created_at ? new Date(row.created_at) : null;

    if (at && !Number.isNaN(at.getTime())) {
      if (!entry.first_paid_at || at < entry.first_paid_at) entry.first_paid_at = at;
      if (!entry.last_paid_at || at > entry.last_paid_at) entry.last_paid_at = at;
    }

    byUser.set(uid, entry);
  }

  return byUser;
}

/** The category a champion spent the most on, for the "known for" line. */
function topCategory(categories) {
  let best = null;

  for (const key of CATEGORIES) {
    const spend = categories[key]?.spend || 0;

    if (spend > 0 && (!best || spend > best.spend)) best = { key, spend };
  }

  return best ? best.key : null;
}

/**
 * The accounts that may not appear on this page, as an id set.
 *
 * Asked as "who is excluded" rather than "which of these payers is eligible",
 * because the exclusion set is inherently small - staff accounts, blocked and
 * deactivated customers, deleted ones - while the payer set on `period=all` is
 * the whole customer base, and an `IN (...)` of that size is not a query to put
 * behind a page load. wallet_transactions carries no relation to User, so this
 * cannot be a join and has to be a set held in memory either way.
 */
async function ineligibleUserIds() {
  const rows = await prisma.user.findMany({
    where: { NOT: { status: 1, role: 'customer' } },
    select: { id: true },
  });

  return new Set(rows.map(r => Number(r.id)));
}

/**
 * Per-user net spend, the ranking, and the platform totals - from the two
 * per-user aggregates stage 1 reads.
 *
 * Pure and exported, because this is the arithmetic printed on the four stat
 * cards and it was the part of this controller no test could reach. The totals
 * used to be the raw debit aggregate, which is how they came to disagree with
 * the leaderboard directly underneath them.
 *
 * Refunds come off the way statements.controller and spendingInsights.service
 * take them off: subtract the reversal credits that landed in the window, then
 * clamp at zero. A bill bought in one window and refunded in the next leaves the
 * later window holding a credit with no debit to cancel, and nobody paid less
 * than nothing. The leaderboard does not depend on this approximation - stage 2
 * matches each refund to its own purchase by `trx`.
 *
 * A user who nets to nothing is dropped rather than kept at zero: they are not
 * a payer this window, and counting them would put people in "people paying"
 * whose every bill was handed back.
 */
function netPlatformRows(debits, credits, ineligible = new Set()) {
  const refunds = new Map();

  for (const c of credits || []) {
    const uid = Number(c?.user_id);

    if (!Number.isFinite(uid)) continue;

    refunds.set(uid, { spend: num(c?._sum?.amount), count: Number(c?._count?._all || 0) });
  }

  const rows = [];
  const totals = { spend: 0, count: 0, payers: 0 };

  for (const d of debits || []) {
    const uid = Number(d?.user_id);

    if (!Number.isFinite(uid) || ineligible.has(uid)) continue;

    const back = refunds.get(uid) || { spend: 0, count: 0 };
    const spend = Math.max(0, num(d?._sum?.amount) - back.spend);
    const count = Math.max(0, Number(d?._count?._all || 0) - back.count);

    if (spend <= 0) continue;

    rows.push({ user_id: uid, spend, count });

    totals.spend += spend;
    totals.count += count;
    totals.payers += 1;
  }

  // Ordered here rather than in SQL: the ranking is by net spend, which is a
  // subtraction across two queries and has no expression as an ORDER BY.
  rows.sort((a, b) => b.spend - a.spend || b.count - a.count || a.user_id - b.user_id);

  return { rows, totals };
}

/**
 * GET /admin/bill-champions?period=month&limit=10
 *
 * The leaderboard, the mix behind it, and the one row the shout-out card is
 * built from.
 */
async function getChampions(req, res) {
  try {
    const allowed = ['week', 'month', 'year', 'all'];
    const period = allowed.includes(String(req.query.period || '').toLowerCase())
      ? String(req.query.period).toLowerCase()
      : 'month';

    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 3), 25);

    const now = new Date();
    const { start, label } = windowFor(period, now);

    const windowWhere = { remark: { in: BILL_REMARKS }, created_at: { gte: start } };

    // Stage 1: one row per payer for the bills, one row per payer for the
    // refunds, and the small set of accounts that may not appear at all. Both
    // aggregates are bounded by the customer base rather than by the ledger, so
    // this stays affordable on `all`.
    //
    // No `orderBy` on either groupBy - see netPlatformRows for why the ranking
    // cannot be a SQL sort.
    const [grossByUser, refundByUser, ineligible] = await Promise.all([
      prisma.walletTransaction.groupBy({
        by: ['user_id'],
        where: { ...windowWhere, trx_type: DEBIT },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.walletTransaction.groupBy({
        by: ['user_id'],
        where: { ...windowWhere, trx_type: CREDIT },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      ineligibleUserIds(),
    ]);

    // `ranked` is already netted, already filtered and already ordered, so the
    // candidate cut below can no longer spend its budget on staff accounts.
    const { rows: ranked, totals: platform } = netPlatformRows(grossByUser, refundByUser, ineligible);

    if (!ranked.length) {
      return ok(res, {
        period,
        window: { start: start.toISOString(), end: now.toISOString(), label },
        totals: { spend: '0.00', count: 0, payers: 0 },
        mix: CATEGORIES.map(key => ({ key, label: CATEGORY_LABEL[key], spend: '0.00', count: 0 })),
        leaderboard: [],
        champion: null,
      });
    }

    const candidateIds = ranked
      .slice(0, Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES))
      .map(r => Number(r.user_id));

    // Stage 2. Rows are opened only for candidates, and only the columns the
    // tally needs - `details` and `other_data` carry a protected counterparty
    // name and have no business on a leaderboard.
    const [debits, reversals, users] = await Promise.all([
      prisma.walletTransaction.findMany({
        where: { ...windowWhere, trx_type: DEBIT, user_id: { in: candidateIds } },
        select: { user_id: true, trx: true, amount: true, remark: true, meta: true, created_at: true },
      }),
      // No upper bound, and no `trx_type` filter beyond the credit leg being the
      // only thing that carries `reversal_of`: a refund for a purchase inside
      // the window may well have landed after it closed.
      prisma.walletTransaction.findMany({
        where: {
          remark: { in: BILL_REMARKS },
          trx_type: CREDIT,
          user_id: { in: candidateIds },
          created_at: { gte: start },
        },
        select: { meta: true },
      }),
      // Rule 4 has already dropped these ids in stage 1; repeating it here is
      // the second of two independent guards, and costs a predicate on a lookup
      // that is happening anyway. An ineligible account must not reach even the
      // mix behind the chart.
      prisma.user.findMany({
        where: { id: { in: candidateIds }, status: 1, role: 'customer' },
        select: {
          id: true,
          firstname_enc: true,
          lastname_enc: true,
          username_enc: true,
          image: true,
          created_at: true,
        },
      }),
    ]);

    const eligible = new Map(users.map(u => [Number(u.id), u]));

    const tally = tallyBillRows(
      debits.filter(r => eligible.has(Number(r.user_id))),
      reversals,
    );

    const sorted = Array.from(tally.values())
      .filter(e => e.spend > 0)
      .sort((a, b) => b.spend - a.spend || b.count - a.count || a.user_id - b.user_id)
      .slice(0, limit);

    const leaderboard = sorted.map((entry, index) => {
      const row = eligible.get(entry.user_id);
      const revealed = row ? revealUserFields(row) : {};

      return {
        rank: index + 1,
        user: {
          id: entry.user_id,
          // Name and username only. A shout-out card never needs an email or a
          // phone number, and the surest way to keep one off a screenshot is to
          // not send it to the screen.
          firstname: revealed.firstname || '',
          lastname: revealed.lastname || '',
          username: revealed.username || '',
          image: row?.image || '',
          member_since: row?.created_at || null,
        },
        spend: entry.spend.toFixed(2),
        count: entry.count,
        categories: CATEGORIES.map(key => ({
          key,
          label: CATEGORY_LABEL[key],
          spend: entry.categories[key].spend.toFixed(2),
          count: entry.categories[key].count,
        })),
        top_category: topCategory(entry.categories),
        first_paid_at: entry.first_paid_at,
        last_paid_at: entry.last_paid_at,
      };
    });

    // The mix is across the leaderboard, not the platform. The page badges it
    // inside the card headed "The leaderboard", so the label already matches the
    // data - this is a scope, not a shortfall.
    //
    // It is a choice rather than a limit. `meta` is jsonb, so the airtime/data
    // split is a CASE expression away and would aggregate platform-wide in the
    // database, returning four rows. Two things are wrong with that, and neither
    // is cost:
    //
    //   - the CASE would be a second implementation of `categorize()`, in
    //     another language, which rule 1 exists to stop. The two would have to
    //     agree forever about a split subtle enough to carry its own regression
    //     test: `meta.service` is stamped before `meta.type`, so a version that
    //     reads `type` alone files every still-processing data bundle as
    //     airtime. Whichever copy is edited alone is the one that goes wrong.
    //   - refunds would have to be netted per category. `netPlatformRows` nets
    //     them per user, which is the only granularity a refund credit's own row
    //     supports without opening it - it carries `reversal_of`, not a category.
    //
    // The other route to platform scope - pulling every bill row in the window
    // and tallying it here - keeps one implementation but reads the whole ledger
    // window to draw one line of badges.
    //
    // So if this ever must be platform-wide: give ledgerCategory.helper a SQL
    // fragment that `categorize()` and the query both derive from. Do not copy
    // the CASE into this file.
    const mix = CATEGORIES.map(key => {
      const spend = sorted.reduce((sum, e) => sum + e.categories[key].spend, 0);
      const count = sorted.reduce((sum, e) => sum + e.categories[key].count, 0);

      return { key, label: CATEGORY_LABEL[key], spend: spend.toFixed(2), count };
    });

    return ok(res, {
      period,
      window: { start: start.toISOString(), end: now.toISOString(), label },
      totals: {
        spend: platform.spend.toFixed(2),
        count: platform.count,
        payers: platform.payers,
      },
      mix,
      leaderboard,
      champion: leaderboard[0] || null,
    });
  } catch (e) {
    console.error('adminBillChampions.getChampions error', e);

    return fail(res, 'Failed to load bill champions', 'error', 500);
  }
}

module.exports = {
  getChampions,
  // Exported for the test, and for anything that later needs the same rules.
  tallyBillRows,
  netPlatformRows,
  windowFor,
  topCategory,
  BILL_REMARKS,
  CATEGORIES,
  CATEGORY_LABEL,
};
