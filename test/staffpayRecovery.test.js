/**
 * The two money decisions taken when a payroll process dies mid-transfer.
 *
 * What must not break:
 *   1. A refund only follows a rejection. If Paystack timed out, the transfer
 *      may exist - refunding then pays the staff member AND credits the wallet
 *      back, and the company is short by that salary with nothing to show it.
 *   2. A 404 only means "never sent" once the row has gone untouched for the
 *      whole stranded window. Treating a fresh 404 that way would refund a
 *      transfer Paystack simply had not registered yet, and the retry would
 *      then send a second one.
 *
 * Run with: node test/staffpayRecovery.test.js
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.STAFFPAY_STRANDED_AFTER_MS = '600000'; // 10 minutes

const {
  isDefiniteRejection,
  isNeverSent,
  strandedAfterMs,
} = require('../src/services/staffpayPayroll.service');

const err = (statusCode, message = 'x') => Object.assign(new Error(message), { statusCode });

// --- when a refund is allowed ---------------------------------------------
assert.strictEqual(isDefiniteRejection(err(400)), true, 'Paystack said no - the money never moved');
assert.strictEqual(isDefiniteRejection(err(401)), true);
assert.strictEqual(isDefiniteRejection(err(404)), true);
assert.strictEqual(isDefiniteRejection(err(499)), true);

assert.strictEqual(isDefiniteRejection(err(500)), false, 'a Paystack fault is not proof the transfer failed');
assert.strictEqual(isDefiniteRejection(err(502)), false);
assert.strictEqual(isDefiniteRejection(err(504)), false, 'timeout: the transfer may well exist');
assert.strictEqual(isDefiniteRejection(new Error('socket hang up')), false, 'no status at all is not a rejection');
assert.strictEqual(isDefiniteRejection(null), false);

// --- when a 404 may be believed -------------------------------------------
const now = Date.now();
const window = strandedAfterMs();
assert.strictEqual(window, 600000, 'the window is read from the environment');

assert.strictEqual(
  isNeverSent(err(404), new Date(now - window - 1000), now),
  true,
  'untouched for longer than the window: the submit died before Paystack saw it',
);
assert.strictEqual(
  isNeverSent(err(404), new Date(now - 5000), now),
  false,
  'five seconds old: Paystack has simply not registered it yet',
);
assert.strictEqual(
  isNeverSent(err(404), new Date(now - window + 1000), now),
  false,
  'the boundary belongs to the live transfer, not to the refund',
);
assert.strictEqual(
  isNeverSent(err(500), new Date(now - window - 1000), now),
  false,
  'only a 404 says Paystack never heard of the reference',
);
assert.strictEqual(isNeverSent(err(404), 'not a date', now), false, 'an unreadable timestamp decides nothing');

// --- the floor ------------------------------------------------------------
delete process.env.STAFFPAY_STRANDED_AFTER_MS;
assert.strictEqual(strandedAfterMs(), 600000, 'default is ten minutes');
process.env.STAFFPAY_STRANDED_AFTER_MS = '1000';
assert.strictEqual(strandedAfterMs(), 60000, 'a one-second window would fight live runs - floored at a minute');

console.log('✅ staffpay recovery: refund only on rejection, 404 only believed when stale');
