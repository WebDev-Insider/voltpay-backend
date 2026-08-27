// The insight is a sentence about someone's money, sent unprompted. If the
// windows slip a day or a refund is counted as spend, the number is wrong in
// public - so the categorising, the netting and the wording get a check.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  windowsFor,
  summarize,
  buildInsight,
} = require('../src/services/spendingInsights.service');
const { categorize } = require('../src/helpers/ledgerCategory.helper');
const { lagosDateParts } = require('../src/helpers/lagosTime.helper');

// --- categories ----------------------------------------------------------
// Airtime and data share the mobile_recharge remark. `service` is stamped at
// creation, `type` only after the provider accepts.
assert.strictEqual(categorize({ remark: 'mobile_recharge', meta: { service: 'data' } }), 'data');
assert.strictEqual(categorize({ remark: 'mobile_recharge', meta: { type: 'data' } }), 'data');
assert.strictEqual(categorize({ remark: 'mobile_recharge', meta: { service: 'airtime' } }), 'airtime');
// No meta at all must not silently become data.
assert.strictEqual(categorize({ remark: 'mobile_recharge', meta: null }), 'airtime');
assert.strictEqual(categorize({ remark: 'utility_bill' }), 'electricity');
assert.strictEqual(categorize({ remark: 'cable_tv' }), 'tv');
assert.strictEqual(categorize({ remark: 'send_money' }), 'transfer');
assert.strictEqual(categorize({ remark: 'staffpay_funding' }), 'other');

// --- windows -------------------------------------------------------------
// Wednesday 2026-08-05, 10:00 WAT. Lagos is UTC+1, so 09:00Z.
const wed = new Date('2026-08-05T09:00:00Z');
const week = windowsFor('week', wed);
// Closed week = Mon 27 Jul .. Mon 3 Aug, opening at Lagos midnight (23:00Z prior day).
assert.strictEqual(week.current.start.toISOString(), '2026-07-26T23:00:00.000Z');
assert.strictEqual(week.current.end.toISOString(), '2026-08-02T23:00:00.000Z');
assert.strictEqual(week.previous.start.toISOString(), '2026-07-19T23:00:00.000Z');
assert.strictEqual(week.previous.end.toISOString(), '2026-07-26T23:00:00.000Z');
assert.strictEqual(week.key, '2026-07-26');

// A Monday must report the week that just closed, not the one it is standing in.
const mon = windowsFor('week', new Date('2026-08-03T08:00:00Z'));
assert.strictEqual(mon.current.start.toISOString(), '2026-07-26T23:00:00.000Z');
assert.strictEqual(mon.current.end.toISOString(), '2026-08-02T23:00:00.000Z');

// Sunday belongs to the week that started the Monday before it.
const sun = windowsFor('week', new Date('2026-08-09T08:00:00Z'));
assert.strictEqual(sun.current.end.toISOString(), '2026-08-02T23:00:00.000Z');

const month = windowsFor('month', new Date('2026-08-01T08:00:00Z'));
assert.strictEqual(month.current.start.toISOString(), '2026-06-30T23:00:00.000Z');
assert.strictEqual(month.current.end.toISOString(), '2026-07-31T23:00:00.000Z');
assert.strictEqual(month.previous.start.toISOString(), '2026-05-31T23:00:00.000Z');
assert.strictEqual(month.key, '2026-07');

// January must roll the year back, not land on month 0.
const jan = windowsFor('month', new Date('2026-01-01T08:00:00Z'));
assert.strictEqual(jan.key, '2025-12');
assert.strictEqual(jan.previous.start.toISOString(), '2025-10-31T23:00:00.000Z');

// Just before Lagos midnight is still the previous day.
assert.strictEqual(lagosDateParts(new Date('2026-08-04T22:59:00Z')).day, 4);
assert.strictEqual(lagosDateParts(new Date('2026-08-04T23:01:00Z')).day, 5);

// --- summing -------------------------------------------------------------
const win = { start: new Date('2026-07-26T23:00:00Z'), end: new Date('2026-08-02T23:00:00Z') };
const rows = [
  { trx_type: '-', amount: '5000', remark: 'mobile_recharge', meta: { service: 'data' }, created_at: new Date('2026-07-28T10:00:00Z') },
  { trx_type: '-', amount: '1200', remark: 'mobile_recharge', meta: { service: 'data' }, created_at: new Date('2026-07-30T10:00:00Z') },
  { trx_type: '-', amount: '900', remark: 'mobile_recharge', meta: { service: 'airtime' }, created_at: new Date('2026-07-29T10:00:00Z') },
  { trx_type: '-', amount: '3000', remark: 'utility_bill', meta: {}, created_at: new Date('2026-07-29T12:00:00Z') },
  { trx_type: '-', amount: '2000', remark: 'send_money', meta: {}, created_at: new Date('2026-07-29T13:00:00Z') },
  // Declined purchase and its reversal: both rows exist, neither is spend.
  { trx_type: '-', amount: '700', remark: 'mobile_recharge', meta: { service: 'airtime' }, created_at: new Date('2026-07-31T09:00:00Z') },
  { trx_type: '+', amount: '700', remark: 'mobile_recharge', meta: { service: 'airtime', reversal_of: 'air123' }, created_at: new Date('2026-07-31T09:05:00Z') },
  // A wallet top-up is not spend.
  { trx_type: '+', amount: '50000', remark: 'fund_account', meta: {}, created_at: new Date('2026-07-27T09:00:00Z') },
  // Outside the window.
  { trx_type: '-', amount: '9999', remark: 'mobile_recharge', meta: { service: 'data' }, created_at: new Date('2026-08-03T10:00:00Z') },
];

const got = summarize(rows, win);
assert.strictEqual(got.byCategory.data, 6200);
// 900 kept + 700 declined - 700 refunded. The declined purchase nets out.
assert.strictEqual(got.byCategory.airtime, 900);
assert.strictEqual(got.byCategory.electricity, 3000);
assert.strictEqual(got.byCategory.transfer, 2000);
assert.strictEqual(got.total, 6200 + 900 + 3000 + 2000);
assert.strictEqual(got.byCategory.fund_account, undefined);

// A purchase on the last day of a period, refunded on the first day of the
// next, leaves that next period holding a reversal with nothing to cancel.
// It must floor at zero, not report negative spend.
const orphanRefund = summarize(
  [
    { trx_type: '+', amount: '700', remark: 'mobile_recharge', meta: { service: 'airtime', reversal_of: 'air123' }, created_at: new Date('2026-07-27T09:00:00Z') },
    { trx_type: '-', amount: '1000', remark: 'utility_bill', meta: {}, created_at: new Date('2026-07-28T09:00:00Z') },
  ],
  win
);
assert.strictEqual(orphanRefund.byCategory.airtime, 0);
assert.strictEqual(orphanRefund.byCategory.electricity, 1000);
// The clamped category must not drag the total below what was really spent.
assert.strictEqual(orphanRefund.total, 1000);

// --- the two summarisers must agree --------------------------------------
// The statement uses Decimal and the push uses Number, so they are two
// implementations of one rule. If they drift, a user reads one airtime figure
// in their statement and a different one in the notification about it.
const { summarizeMonth } = require('../src/controllers/statements.controller');
const viaStatement = summarizeMonth(rows.filter(r => r.created_at >= win.start && r.created_at < win.end));
assert.strictEqual(Number(viaStatement.dataSpent.toFixed(2)), got.byCategory.data);
assert.strictEqual(Number(viaStatement.airtimeSpent.toFixed(2)), got.byCategory.airtime);
assert.strictEqual(Number(viaStatement.electricitySpent.toFixed(2)), got.byCategory.electricity);
assert.strictEqual(Number(viaStatement.monthlyDebitTotal.toFixed(2)), got.total);

const orphanViaStatement = summarizeMonth([
  { trx_type: '+', amount: '700', remark: 'mobile_recharge', meta: { service: 'airtime', reversal_of: 'air123' } },
  { trx_type: '-', amount: '1000', remark: 'utility_bill', meta: {} },
]);
assert.strictEqual(Number(orphanViaStatement.airtimeSpent.toFixed(2)), orphanRefund.byCategory.airtime);
assert.strictEqual(Number(orphanViaStatement.monthlyDebitTotal.toFixed(2)), orphanRefund.total);

// --- wording -------------------------------------------------------------
const insight = buildInsight({
  period: 'month',
  current: { total: 12100, byCategory: { data: 6200, airtime: 900, electricity: 3000, transfer: 2000 } },
  previous: { total: 9000, byCategory: { data: 4769, airtime: 900 } },
});
assert.strictEqual(insight.subject, 'Your monthly spending summary');
assert.strictEqual(insight.top, 'data');
assert.strictEqual(
  insight.message,
  'You spent ₦6,200 on data last month - 30% more than the month before. That is part of ₦12,100 in total.'
);

// Spending less has to read as less, not as a negative increase.
assert.ok(
  buildInsight({
    period: 'week',
    current: { total: 2000, byCategory: { data: 2000 } },
    previous: { total: 4000, byCategory: { data: 4000 } },
  }).message.includes('50% less than the week before')
);

// A first-ever period has nothing to compare against, so no comparison clause.
const noHistory = buildInsight({
  period: 'week',
  current: { total: 2000, byCategory: { data: 2000 } },
  previous: { total: 0, byCategory: {} },
});
assert.strictEqual(noHistory.message, 'You spent ₦2,000 on data last week. That is part of ₦2,000 in total.');

// A few percent either way is not a habit worth a push about.
assert.ok(
  buildInsight({
    period: 'week',
    current: { total: 2050, byCategory: { data: 2050 } },
    previous: { total: 2000, byCategory: { data: 2000 } },
  }).message.includes('about the same as the week before')
);

// Transfers are spend but never the headline - the point is bill overspending.
const transfersOnly = buildInsight({
  period: 'week',
  current: { total: 50000, byCategory: { transfer: 50000 } },
  previous: { total: 25000, byCategory: { transfer: 25000 } },
});
assert.strictEqual(transfersOnly.top, null);
assert.strictEqual(transfersOnly.message, 'You spent ₦50,000 last week - 100% more than the week before.');

// Nothing spent, nothing sent.
assert.strictEqual(buildInsight({ period: 'week', current: { total: 0, byCategory: {} }, previous: null }), null);

console.log('✅ spendingInsights tests passed');
