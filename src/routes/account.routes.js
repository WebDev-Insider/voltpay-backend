const express = require('express');
const router = express.Router();

const AccountController = require('../controllers/account.controller');
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');

// A copy of everything held about the caller (NDPA right of access). Rate
// limited because it is the heaviest read in the API and nobody needs it twice
// a minute - and it is offered next to the delete button, since after the grace
// period the user cannot sign in to ask for it.
router.get(
  '/account/export',
  userAuth,
  rateLimit({ name: 'account_export', windowMs: 60 * 60 * 1000, max: 5, byUser: true }),
  AccountController.exportAccountData,
);

// Reversible close. Behind a session, and the password is re-checked inside.
router.post('/account/deactivate', userAuth, AccountController.deactivateAccount);

// Public by necessity - a deactivated account cannot hold a session. Both steps
// re-check the password, so the limits below are the only thing standing
// between a stolen phone number and unlimited guesses.
router.post(
  '/account/reactivate/request',
  rateLimit({ name: 'reactivate_otp', windowMs: 10 * 60 * 1000, max: 5, field: 'mobile_number' }),
  AccountController.requestReactivation,
);
router.post(
  '/account/reactivate/confirm',
  rateLimit({ name: 'reactivate_confirm', windowMs: 15 * 60 * 1000, max: 8, field: 'mobile_number' }),
  AccountController.confirmReactivation,
);

// Asking for deletion is destructive and re-checks the password, so it is rate
// limited per user: a session that has been taken over gets three tries at the
// password here, not unlimited ones.
const deleteRequestLimit = rateLimit({
  name: 'account_delete_request',
  windowMs: 15 * 60 * 1000,
  max: 5,
  byUser: true,
});

// Two paths, one handler: /delete-account is what the app already calls.
router.post('/delete-account', userAuth, deleteRequestLimit, AccountController.deleteAccount);
router.post('/account/delete-request', userAuth, deleteRequestLimit, AccountController.deleteAccount);

// Cancelling a scheduled deletion is reactivation - the account is deactivated
// from the moment deletion is asked for, so there is no session to authenticate
// with and the same three factors (password, emailed code, recovery phrase)
// are what proves ownership. Same handler, under the name the flow has in the
// app, so the client does not have to know they are one thing.
router.post(
  '/account/cancel-deletion',
  rateLimit({ name: 'cancel_deletion', windowMs: 15 * 60 * 1000, max: 8, field: 'mobile_number' }),
  AccountController.confirmReactivation,
);

module.exports = router;
