/**
 * The payroll engine's arithmetic and its status roll-up.
 *
 * What must not break:
 *   1. The quoted cost of a run. Under-quote by one naira per staff member and
 *      the wallet reserve is short, so a transfer is submitted with no money
 *      behind it. VAT is charged on the fees, never on the salary.
 *   2. The roll-up. A run with one transfer still in flight must read
 *      "processing", not "successful" - the second is what tells the app it is
 *      safe to stop polling and the owner that everyone got paid.
 *   3. The history month. A Nigerian calendar month starts at 00:00 WAT, so the
 *      first hour of every month belongs to the month it looks like.
 *
 * The DB-touching paths (reserve, refund-once, retry) are not covered here;
 * they need a live Postgres. Run with: node test/staffpayPayroll.test.js
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

// Pin the tiers and the VAT rate so the expected totals below are arithmetic,
// not a reading of whatever this machine's .env happens to say.
delete process.env.PAYSTACK_TRANSFER_FEE_SMALL;
delete process.env.PAYSTACK_TRANSFER_FEE_MID;
delete process.env.PAYSTACK_TRANSFER_FEE_LARGE;
delete process.env.STAFFPAY_VAT_RATE;
delete process.env.STAFFPAY_DEFAULT_PAYOUT_TIME;

const {
  feesFor,
  voltpayFee,
  itemCost,
  rollUpStatus,
  payoutTimeOrDefault,
  friendlyFailureReason,
} = require('../src/services/staffpayPayroll.service');
const { publicPayrollRun } = require('../src/helpers/staffpayPii.helper');
const { transferFeeNaira } = require('../src/funding/paystack.service');
const { monthYearRange, csvCell } = require('../src/controllers/staffpay.controller');

const n = d => Number(d.toString());

// --- Paystack transfer fee tiers -----------------------------------------
assert.strictEqual(transferFeeNaira(5000), 10, '≤ ₦5,000 is the cheap tier');
assert.strictEqual(transferFeeNaira(5001), 25);
assert.strictEqual(transferFeeNaira(50000), 25, 'the boundary belongs to the lower tier');
assert.strictEqual(transferFeeNaira(50001), 50);

// --- VoltPay's margin -----------------------------------------------------
assert.strictEqual(n(voltpayFee(1000)), 20, '1% of ₦1,000 is below the ₦20 floor');
assert.strictEqual(n(voltpayFee(5000)), 50);
assert.strictEqual(n(voltpayFee(500000)), 200, '1% of ₦500,000 is above the ₦200 cap');

// --- the quote ------------------------------------------------------------
// VAT is 7.5% of (provider fee + VoltPay fee). Charging it on the salary too
// would add thousands per staff member.
const small = feesFor(5000);
assert.strictEqual(n(small.provider), 10);
assert.strictEqual(n(small.volt), 50);
assert.strictEqual(n(small.vat), 4.5);
assert.strictEqual(n(small.total), 5064.5);

const capped = feesFor(60000);
assert.strictEqual(n(capped.provider), 50);
assert.strictEqual(n(capped.volt), 200);
assert.strictEqual(n(capped.vat), 18.75);
assert.strictEqual(n(capped.total), 60268.75);

// Rounding lands on two decimals, not on a fraction of a kobo.
const rounded = feesFor(50000);
assert.strictEqual(n(rounded.vat), 16.88, '0.075 × 225 = 16.875 rounds up');
assert.strictEqual(n(rounded.total), 50241.88);

// The refund path prices an item from its stored columns; that has to agree
// with what was reserved, or a failure refunds the wrong amount.
assert.strictEqual(
  n(itemCost({ amount: '5000', provider_fee: '10', voltpay_fee: '50', vat: '4.5' })),
  n(small.total),
);

// --- run status -----------------------------------------------------------
const st = statuses => rollUpStatus(statuses.map(status => ({ status })));

assert.strictEqual(st(['SUCCESSFUL', 'SUCCESSFUL']), 'successful');
assert.strictEqual(st(['SUCCESSFUL', 'NEW']), 'processing', 'one still in flight is not a finished run');
assert.strictEqual(st(['SUCCESSFUL', 'PENDING']), 'processing');
assert.strictEqual(st(['FAILED', 'FAILED']), 'failed');
assert.strictEqual(st(['SUCCESSFUL', 'FAILED']), 'partial', 'a partial run is what enables Retry Failed Transfers');
assert.strictEqual(st([]), 'failed', 'a run with no items never paid anyone');

// --- the schedule ---------------------------------------------------------
assert.strictEqual(payoutTimeOrDefault({ payout_time: '14:30' }), '14:30');
assert.strictEqual(payoutTimeOrDefault(null), '09:00', 'no AutoPay toggle: unset means the default, not "never"');
assert.strictEqual(payoutTimeOrDefault({ payout_time: 'later' }), '09:00');

// --- history month, in WAT ------------------------------------------------
const feb = monthYearRange(2, 2026);
assert.strictEqual(feb.gte.toISOString(), '2026-01-31T23:00:00.000Z', 'February starts at 00:00 WAT');
assert.strictEqual(feb.lt.toISOString(), '2026-02-28T23:00:00.000Z');

const dec = monthYearRange(12, 2026);
assert.strictEqual(dec.lt.toISOString(), '2026-12-31T23:00:00.000Z', 'December rolls into the next year');

const year = monthYearRange(null, 2026);
assert.strictEqual(year.gte.toISOString(), '2025-12-31T23:00:00.000Z');
assert.strictEqual(year.lt.toISOString(), '2026-12-31T23:00:00.000Z');

assert.strictEqual(monthYearRange(13, 2026), null);
assert.strictEqual(monthYearRange(0, 2026), null);
assert.strictEqual(monthYearRange(1, 'abc'), null);

// --- CSV quoting ----------------------------------------------------------
assert.strictEqual(csvCell('Ada Obi'), 'Ada Obi');
assert.strictEqual(csvCell('Obi, Ada'), '"Obi, Ada"', 'a comma in a name must not shift the columns');
assert.strictEqual(csvCell('He said "hi"'), '"He said ""hi"""');
assert.strictEqual(csvCell(null), '');

// --- Provider failure wording ---------------------------------------------
// A merchant-side failure must never be phrased as the business's fault: the
// wallet is funded and already refunded when this text is written.
const MERCHANT = 'Payouts are temporarily unavailable. Your wallet was not debited - please try again shortly.';

assert.strictEqual(
  friendlyFailureReason('Your balance is not enough fulfil this request'),
  MERCHANT,
  "Paystack's own float message must not be shown as the company's balance",
);
assert.strictEqual(friendlyFailureReason('Insufficient funds'), MERCHANT);
assert.strictEqual(friendlyFailureReason('Transfers are not enabled on this account'), MERCHANT);
assert.strictEqual(friendlyFailureReason('Transfer requires OTP'), MERCHANT);

// Bank-side reasons are the business's to act on, so they pass through as the
// bank wrote them.
assert.strictEqual(friendlyFailureReason('Account does not exist'), 'Account does not exist');
assert.strictEqual(friendlyFailureReason('Account name mismatch'), 'Account name mismatch');

// No reason is not a failure.
assert.strictEqual(friendlyFailureReason(''), null);
assert.strictEqual(friendlyFailureReason(null), null);
assert.strictEqual(friendlyFailureReason(undefined), null);

// --- The raw provider payload stays server-side ---------------------------
const run = publicPayrollRun({
  id: 1,
  items: [{ id: 9, complete_message: MERCHANT, raw_payload: { reason: 'Your balance is not enough' } }],
});
assert.strictEqual(run.items[0].raw_payload, undefined, 'raw_payload must not reach the app');
assert.strictEqual(run.items[0].complete_message, MERCHANT);

console.log('✅ staffpayPayroll tests passed');
