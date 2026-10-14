// The output of this screen becomes a public post with somebody's name on it.
// Every rule that decides who is on it gets a check here, because the failure
// mode is not a wrong number on a dashboard - it is congratulating a customer
// on money that was refunded back into their wallet, in front of everyone.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  tallyBillRows,
  netPlatformRows,
  windowFor,
  topCategory,
  BILL_REMARKS,
  CATEGORIES,
} = require('../src/controllers/adminBillChampions.controller');

const debit = (user_id, trx, amount, remark, meta = {}, created_at = '2026-08-10T09:00:00Z') => ({
  user_id,
  trx,
  amount,
  remark,
  meta,
  trx_type: '-',
  created_at: new Date(created_at),
});

// --- what counts as a utility bill ---------------------------------------
// Betting is spend and it categorises cleanly, which is exactly why it has to
// be kept out on purpose: an unfiltered chart would put a gambling total on the
// company's Instagram.
assert.ok(!BILL_REMARKS.includes('betting'), 'betting must not be a bill remark');
assert.ok(!CATEGORIES.includes('betting'), 'betting must not be a champion category');
assert.deepStrictEqual(BILL_REMARKS, ['mobile_recharge', 'cable_tv', 'utility_bill']);

// A row that slips through the query on a remark we did not ask for still has
// to be dropped by the tally - the two guards are independent on purpose.
{
  const t = tallyBillRows([debit(1, 'x1', 5000, 'send_money'), debit(1, 'x2', 900, 'betting')], []);

  assert.strictEqual(t.size, 0, 'transfers and betting must not reach the leaderboard');
}

// --- the airtime / data split --------------------------------------------
// Both are `mobile_recharge`; only `meta` tells them apart, and `meta.type` is
// stamped later than `meta.service`. Reading type alone files every still
// processing data bundle as airtime.
{
  const t = tallyBillRows(
    [
      debit(7, 'a1', 500, 'mobile_recharge', { service: 'airtime', type: 'airtime' }),
      debit(7, 'd1', 2000, 'mobile_recharge', { service: 'data' }),
      debit(7, 'e1', 5000, 'utility_bill', { service: 'electricity' }),
      debit(7, 't1', 4400, 'cable_tv', { service: 'tv' }),
    ],
    [],
  );

  const e = t.get(7);

  assert.strictEqual(e.count, 4);
  assert.strictEqual(e.spend, 11900);
  assert.strictEqual(e.categories.airtime.spend, 500);
  assert.strictEqual(e.categories.data.spend, 2000, 'a processing data bundle must not be filed as airtime');
  assert.strictEqual(e.categories.electricity.spend, 5000);
  assert.strictEqual(e.categories.tv.spend, 4400);
  assert.strictEqual(topCategory(e.categories), 'electricity');
}

// --- refunds -------------------------------------------------------------
// The reason this file exists. A declined bill is refunded with a credit
// carrying meta.reversal_of, and a vend accepted as pending can be declined on
// the webhook minutes later.
{
  const debits = [
    debit(9, 'ok-1', 3000, 'utility_bill'),
    debit(9, 'bad-1', 90000, 'utility_bill'),
    debit(9, 'bad-2', 90000, 'cable_tv'),
  ];

  const reversals = [{ meta: { reversal_of: 'bad-1' } }, { meta: { reversal_of: 'bad-2' } }];

  const e = tallyBillRows(debits, reversals).get(9);

  assert.strictEqual(e.spend, 3000, 'refunded purchases must not count towards the podium');
  assert.strictEqual(e.count, 1);
  assert.strictEqual(e.categories.tv.count, 0, 'a fully refunded category must not appear in the mix');
}

// A user whose every bill was refunded has no entry at all, rather than a zero
// one - a ₦0.00 champion is worse than an empty leaderboard.
{
  const t = tallyBillRows([debit(11, 'r1', 8000, 'cable_tv')], [{ meta: { reversal_of: 'r1' } }]);

  assert.strictEqual(t.size, 0);
}

// A reversal with no meta, or meta that is not an object, must not throw and
// must not silently cancel everything.
{
  const t = tallyBillRows([debit(12, 'k1', 1000, 'utility_bill')], [{ meta: null }, { meta: 'oops' }, {}]);

  assert.strictEqual(t.get(12).spend, 1000);
}

// --- ordering ------------------------------------------------------------
// Gross order and net order can differ, which is the whole point of stage 2.
{
  const t = tallyBillRows(
    [
      debit(1, 'g1', 100000, 'utility_bill'),
      debit(2, 'g2', 60000, 'utility_bill'),
      debit(2, 'g3', 30000, 'cable_tv'),
    ],
    [{ meta: { reversal_of: 'g1' } }],
  );

  const order = Array.from(t.values()).sort((a, b) => b.spend - a.spend).map(e => e.user_id);

  assert.deepStrictEqual(order, [2], 'the gross leader must lose the crown once refunds are netted');
}

// --- amounts -------------------------------------------------------------
// Amounts arrive as Prisma Decimal, which is a string once it crosses JSON.
{
  const e = tallyBillRows([debit(3, 's1', '2500.50', 'utility_bill')], []).get(3);

  assert.strictEqual(e.spend, 2500.5);
}

// A zero or negative amount is not a bill payment and must not earn a count.
{
  const t = tallyBillRows([debit(4, 'z1', 0, 'utility_bill'), debit(4, 'n1', -500, 'cable_tv')], []);

  assert.strictEqual(t.size, 0);
}

// --- first / last seen ---------------------------------------------------
{
  const e = tallyBillRows(
    [
      debit(5, 'm1', 1000, 'utility_bill', {}, '2026-08-20T09:00:00Z'),
      debit(5, 'm2', 1000, 'utility_bill', {}, '2026-08-02T09:00:00Z'),
      debit(5, 'm3', 1000, 'utility_bill', {}, '2026-08-11T09:00:00Z'),
    ],
    [],
  ).get(5);

  assert.strictEqual(e.first_paid_at.toISOString(), '2026-08-02T09:00:00.000Z');
  assert.strictEqual(e.last_paid_at.toISOString(), '2026-08-20T09:00:00.000Z');
}

// --- the platform totals -------------------------------------------------
// The four stat cards. These used to be the raw debit aggregate - refunds still
// in them, staff and blocked accounts still in them - printed directly above a
// leaderboard that had both taken out, with "top 10 are X% of the spend"
// dividing the one by the other. The numbers on this page have to describe the
// same set of people as the names on it.
const agg = (user_id, spend, count) => ({ user_id, _sum: { amount: spend }, _count: { _all: count } });

{
  const { rows, totals } = netPlatformRows(
    // 99 is staff, 98 is a blocked customer, 1 refunded 90,000 of 100,000.
    [agg(99, 500000, 1), agg(98, 300000, 1), agg(1, 100000, 2), agg(2, 6000, 1)],
    [agg(1, 90000, 1)],
    new Set([99, 98]),
  );

  assert.strictEqual(totals.spend, 16000, 'staff and blocked spend must not reach the stat cards');
  assert.strictEqual(totals.count, 2, 'a refunded bill is not a bill paid');
  assert.strictEqual(totals.payers, 2, 'an ineligible account is not a person paying');
  assert.deepStrictEqual(rows.map(r => r.user_id), [1, 2]);
}

// Ranking is by net, and it is done before the candidate cut - so the gross
// leader losing the crown has to be visible here, not only in the tally.
{
  const { rows } = netPlatformRows([agg(1, 100000, 1), agg(2, 90000, 2)], [agg(1, 95000, 1)]);

  assert.deepStrictEqual(rows.map(r => r.user_id), [2, 1], 'the gross leader must not still rank first');
}

// A user whose every bill was handed back is not a payer. Zero people paying is
// a truthful empty state; two people paying nothing is not.
{
  const { rows, totals } = netPlatformRows([agg(5, 8000, 1)], [agg(5, 8000, 1)]);

  assert.strictEqual(rows.length, 0);
  assert.strictEqual(totals.payers, 0);
  assert.strictEqual(totals.spend, 0);
}

// A bill bought before the window and refunded inside it leaves the window
// holding a credit with no debit to cancel. Clamp at zero - nobody paid less
// than nothing. Same clamp statements.controller and spendingInsights.service
// apply, and the reason the leaderboard matches refunds by `trx` instead.
{
  const { rows, totals } = netPlatformRows([agg(6, 1000, 1)], [agg(6, 50000, 1)]);

  assert.strictEqual(totals.spend, 0, 'a windowed subtraction must never go negative');
  assert.strictEqual(totals.count, 0);
  assert.strictEqual(rows.length, 0);
}

// Spend and count are clamped independently, because a window can hold more
// refund credits than it holds bills: two small refunds of last month's
// purchases against one large bill this month. The spend still stands, and a
// negative count would come off the platform total as if a bill had un-happened.
{
  const { rows, totals } = netPlatformRows([agg(8, 10000, 1)], [agg(8, 500, 2)]);

  assert.strictEqual(totals.spend, 9500, 'a spend that survives its refunds must still be counted');
  assert.strictEqual(totals.count, 0, 'a bill count must never go negative');
  assert.strictEqual(rows.length, 1);
}

// A refund credit belonging to someone with no bills in the window must not
// invent a payer.
{
  const { rows, totals } = netPlatformRows([agg(1, 5000, 1)], [agg(7, 3000, 1)]);

  assert.deepStrictEqual(rows.map(r => r.user_id), [1]);
  assert.strictEqual(totals.payers, 1);
}

// Prisma hands _sum.amount back as a Decimal, which is a string once it crosses
// JSON - the same trap tallyBillRows has.
assert.strictEqual(netPlatformRows([agg(1, '2500.50', 1)], []).totals.spend, 2500.5);

assert.strictEqual(netPlatformRows([], []).totals.payers, 0);
assert.strictEqual(netPlatformRows(null, null).rows.length, 0);

// --- windows -------------------------------------------------------------
// Lagos calendar, not the server's. On a UTC host the first hour of a month
// would otherwise be credited to the previous month's champion.
{
  // 2026-08-05 is a Wednesday. 10:00 WAT = 09:00Z.
  const wed = new Date('2026-08-05T09:00:00Z');

  assert.strictEqual(windowFor('month', wed).start.toISOString(), '2026-07-31T23:00:00.000Z');
  assert.strictEqual(windowFor('week', wed).start.toISOString(), '2026-08-02T23:00:00.000Z');
  assert.strictEqual(windowFor('year', wed).start.toISOString(), '2025-12-31T23:00:00.000Z');
  assert.strictEqual(windowFor('all', wed).start.getTime(), 0);

  // 00:30 WAT on the 1st is still the new month, even though it is 23:30Z on
  // the last of the old one.
  const justAfterMidnight = new Date('2026-07-31T23:30:00Z');

  assert.strictEqual(windowFor('month', justAfterMidnight).start.toISOString(), '2026-07-31T23:00:00.000Z');

  // An unknown period falls back to the month rather than to an unbounded read.
  assert.strictEqual(windowFor('nonsense', wed).start.toISOString(), '2026-07-31T23:00:00.000Z');
}

// --- empty ---------------------------------------------------------------
assert.strictEqual(tallyBillRows([], []).size, 0);
assert.strictEqual(tallyBillRows(null, null).size, 0);
assert.strictEqual(topCategory({ airtime: { spend: 0 }, data: { spend: 0 } }), null);

console.log('adminBillChampions.test.js OK');
