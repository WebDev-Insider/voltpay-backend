/**
 * Account status gate.
 *
 * The thing that must not break: a self-deactivated account (status 2) has to
 * answer with the `account_deactivated` remark, not `blocked`. The app routes
 * off that string - get it wrong and a user who deactivated their own account
 * is told to contact support with no way back in.
 *
 * Also guards the enumeration property: reactivation is the only caller allowed
 * to pass a deactivated user through, and an admin block (status 0) must stay
 * shut even for it.
 */

const assert = require('assert');
const {
  ACTIVE,
  BLOCKED,
  DEACTIVATED,
  isActive,
  isDeactivated,
  inactiveResponse,
} = require('../src/helpers/accountStatus.helper');

assert.strictEqual(isActive({ status: ACTIVE }), true);
assert.strictEqual(isActive({ status: DEACTIVATED }), false);
assert.strictEqual(isActive({ status: BLOCKED }), false);
assert.strictEqual(isActive(null), false);

// Status arrives as a string from a JSON cache round-trip.
assert.strictEqual(isActive({ status: '1' }), true);
assert.strictEqual(isDeactivated({ status: '2' }), true);

const deactivated = inactiveResponse({ status: DEACTIVATED });
assert.strictEqual(deactivated.code, 403);
assert.strictEqual(deactivated.body.remark, 'account_deactivated');
assert.strictEqual(deactivated.body.data.can_reactivate, true);

const blocked = inactiveResponse({ status: BLOCKED });
assert.strictEqual(blocked.code, 403);
assert.strictEqual(blocked.body.remark, 'blocked');
assert.strictEqual(blocked.body.data, null);
// A blocked account must not be told it can bring itself back.
assert.ok(!/reactivate/i.test(blocked.body.message[0]));

// The gate as resolveUserForDeviceFlow applies it.
function passes(user, allowDeactivated) {
  return isActive(user) || (allowDeactivated && isDeactivated(user));
}
assert.strictEqual(passes({ status: ACTIVE }, false), true);
assert.strictEqual(passes({ status: DEACTIVATED }, false), false, 'login must not admit a deactivated account');
assert.strictEqual(passes({ status: DEACTIVATED }, true), true, 'reactivation must admit it');
assert.strictEqual(passes({ status: BLOCKED }, true), false, 'an admin block is not self-serve');

// The reactivation OTP lives in its own namespace, so a code mailed for one
// purpose cannot be redeemed against the other.
const PasswordResetModel = require('../src/models/passwordReset.model');
assert.strictEqual(PasswordResetModel.normalizeResetType('reactivate'), 'reactivate');
assert.strictEqual(PasswordResetModel.normalizeResetType('reactivation'), 'reactivate');
assert.notStrictEqual(PasswordResetModel.normalizeResetType('device'), 'reactivate');
assert.ok(PasswordResetModel.TOKEN_TTL_MS.reactivate > 0);

console.log('✅ accountStatus tests passed');
