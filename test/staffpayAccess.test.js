/**
 * The StaffPay gate.
 *
 * Two things must not break:
 *   1. Only an approved business with a live subscription may reach a bulk
 *      transfer. Either half missing = locked out, and the 403 has to carry the
 *      remark the app switches on, or a pending business is told to pay and a
 *      lapsed one is told to re-apply.
 *   2. Renewing early extends the existing year instead of restarting it.
 *      Getting that wrong takes ₦150k and hands back less time than was paid for.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { decideAccess, denyResponse, DEFAULT_PRICE } = require('../src/helpers/staffpayAccess.helper');
const { computeSubscriptionWindow, SUBSCRIPTION_YEARS } = require('../src/controllers/staffpaySubscription.controller');

// --- the decision ---------------------------------------------------------
const live = { expires_at: new Date(Date.now() + 86_400_000) };

assert.strictEqual(decideAccess({ verification: { status: 'approved' }, subscription: live }).can_use_staffpay, true);
assert.strictEqual(
  decideAccess({ verification: { status: 'approved' }, subscription: null }).can_use_staffpay,
  false,
  'approved but unpaid must not run payroll',
);
assert.strictEqual(
  decideAccess({ verification: { status: 'pending' }, subscription: live }).can_use_staffpay,
  false,
  'paying does not substitute for KYB',
);
assert.strictEqual(decideAccess({ verification: null, subscription: null }).verification_status, 'not_submitted');

// A decline reason is only surfaced on a declined application - it must not
// leak onto a row that was later re-reviewed back to pending.
assert.strictEqual(decideAccess({ verification: { status: 'declined', decline_reason: 'Blurry CAC' } }).decline_reason, 'Blurry CAC');
assert.strictEqual(decideAccess({ verification: { status: 'pending', decline_reason: 'Blurry CAC' } }).decline_reason, null);

// --- the 403 the app routes on -------------------------------------------
const deny = state => denyResponse(decideAccess(state));

assert.strictEqual(deny({ verification: { status: 'approved' }, subscription: live }), null, 'a verified payer is let through');

const pending = deny({ verification: { status: 'pending' }, subscription: null });
assert.strictEqual(pending.code, 403);
assert.strictEqual(pending.body.remark, 'staffpay_not_verified');

const lapsed = deny({ verification: { status: 'approved' }, subscription: null });
assert.strictEqual(
  lapsed.body.remark,
  'staffpay_subscription_required',
  'a lapsed payer must be asked to renew, not to re-apply',
);

// --- subscription window --------------------------------------------------
const paidAt = new Date('2026-03-01T10:00:00Z');

const fresh = computeSubscriptionWindow(paidAt, null);
assert.strictEqual(fresh.startsAt.getTime(), paidAt.getTime());
assert.strictEqual(fresh.expiresAt.getFullYear(), paidAt.getFullYear() + SUBSCRIPTION_YEARS);

// Renewed with four months left: the new year stacks on top of them.
const remaining = new Date('2026-07-01T10:00:00Z');
const renewed = computeSubscriptionWindow(paidAt, remaining);
assert.strictEqual(renewed.startsAt.getTime(), remaining.getTime());
assert.strictEqual(renewed.expiresAt.getTime(), new Date('2027-07-01T10:00:00Z').getTime());

// Renewed after a lapse: the dead time is not credited back.
assert.strictEqual(
  computeSubscriptionWindow(paidAt, new Date('2026-01-01T10:00:00Z')).startsAt.getTime(),
  paidAt.getTime(),
);

assert.ok(DEFAULT_PRICE > 0);

console.log('✅ staffpayAccess tests passed');
