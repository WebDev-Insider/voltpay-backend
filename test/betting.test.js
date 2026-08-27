/**
 * node test/betting.test.js
 *
 * No network, no database. Covers the three pieces of the Payvessel betting
 * rail that are pure logic and expensive to get wrong:
 *
 *   1. which billers count as betting - Payvessel returns airtime, data and
 *      betting from one endpoint with no category field, so a bad filter puts
 *      MTN in the betting dropdown
 *   2. the amount floor carried per biller
 *   3. the order status collapse - an unrecognised status must read as
 *      "processing", because "failed" refunds and "success" settles, and
 *      guessing either from a status we do not know is a money bug.
 */
const assert = require('assert');

const { __test, MIN_AMOUNT } = require('../src/funding/payvesselBiller.service');
const { isBettingBiller, toCompany, normalizeOrder } = __test;

/* ------------------------------------------------------------- the filter */

assert.strictEqual(isBettingBiller({ biller_name: 'Bet9ja' }), true);
assert.strictEqual(isBettingBiller({ biller_name: 'SportyBet' }), true);
assert.strictEqual(isBettingBiller({ biller_name: '1xBet' }), true);

assert.strictEqual(isBettingBiller({ biller_name: 'MTN' }), false, 'a network is airtime, not betting');
assert.strictEqual(isBettingBiller({ biller_name: 'Airtel Data' }), false);
assert.strictEqual(isBettingBiller({ biller_name: '9mobile' }), false);
assert.strictEqual(isBettingBiller({ biller_name: '9 Mobile Data' }), false);
assert.strictEqual(isBettingBiller({ biller_name: 'Glo' }), false);

assert.strictEqual(isBettingBiller({ biller_name: 'Bet9ja', status: 0 }), false,
  'an explicitly unavailable biller must not be offered');
assert.strictEqual(isBettingBiller({ biller_name: 'Bet9ja', status: 1 }), true);
assert.strictEqual(isBettingBiller({ biller_name: 'Bet9ja', status: null }), true,
  'no status is not the same as status 0');

/* -------------------------------------------------------------- the amounts */

const noFloor = toCompany({ biller_id: 'BET9JA', biller_name: 'Bet9ja' });
assert.strictEqual(noFloor.min_amount, MIN_AMOUNT, 'a biller with no floor falls back to the provider floor');
assert.strictEqual(MIN_AMOUNT, 100, 'Payvessel betting orders start at ₦100');
assert.strictEqual(noFloor.max_amount, null, 'no ceiling means no ceiling, not zero');

// Every shape Payvessel uses for "this biller published no ceiling". Number(null)
// and Number('') are both 0, so any of these leaking through as 0 reaches the app
// as a ₦0 cap and rejects every amount the customer types.
for (const blank of [null, undefined, '', 0, '0']) {
  const row = toCompany({ biller_id: 'BET9JA', biller_name: 'Bet9ja', max_amount: blank });
  assert.strictEqual(row.max_amount, null, `max_amount ${JSON.stringify(blank)} means no ceiling`);
}
assert.strictEqual(
  toCompany({ biller_id: 'SB', biller_name: 'SportyBet', min_amount: 0 }).min_amount,
  MIN_AMOUNT,
  'a floor of 0 is not a floor - fall back to the provider floor',
);

const ownFloor = toCompany({ biller_id: 'SB', biller_name: 'SportyBet', min_amount: 500, max_amount: 100000 });
assert.strictEqual(ownFloor.min_amount, 500, "the biller's own floor wins");
assert.strictEqual(ownFloor.max_amount, 100000);

assert.strictEqual(toCompany({ biller_name: 'No id' }), null, 'a biller with no id cannot be ordered from');
assert.strictEqual(toCompany({ biller_id: 'Bet_9ja_X' }).name, 'Bet_9ja_X', 'a nameless biller shows its id');
assert.strictEqual(toCompany({ biller_id: 'MixedCase_Id' }).code, 'MixedCase_Id',
  'biller ids are case sensitive - normalising one breaks the order');

/* --------------------------------------------------------------- the status */

const success = normalizeOrder({ data: { status: 'success', merchant_reference: 'bet_1', order_reference: 'PV-1' } });
assert.strictEqual(success.status, 'success');
assert.strictEqual(success.merchant_reference, 'bet_1');
assert.strictEqual(success.order_reference, 'PV-1');

assert.strictEqual(normalizeOrder({ data: { status: 'failed' } }).status, 'failed');
assert.strictEqual(normalizeOrder({ data: { status: 'cancelled' } }).status, 'failed',
  'a cancelled order delivered nothing, so it refunds like a failed one');

assert.strictEqual(normalizeOrder({ data: { status: 'pending' } }).status, 'processing');
assert.strictEqual(normalizeOrder({ data: { status: 'processing' } }).status, 'processing');
assert.strictEqual(normalizeOrder({ data: { status: 'something_new' } }).status, 'processing',
  'an unknown status must not settle or refund - it waits for a verify that knows');
assert.strictEqual(normalizeOrder({}).status, 'processing', 'an empty body is not a failure');
assert.strictEqual(normalizeOrder(null).status, 'processing');

// A webhook posts the order flat; verify wraps it in `data`. Both must read.
assert.strictEqual(normalizeOrder({ status: 'success', merchant_reference: 'bet_2' }).merchant_reference, 'bet_2');

assert.strictEqual(normalizeOrder({ data: { status: 'failed', error_message: 'Invalid account' } }).error_message,
  'Invalid account');
assert.strictEqual(normalizeOrder({ data: { status: 'failed', error_message: '' } }).error_message, null,
  'an empty reason is no reason');

console.log('betting: all assertions passed');
