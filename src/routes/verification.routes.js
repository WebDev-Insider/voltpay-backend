const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const VerificationController = require('../controllers/verification.controller');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');

// Every route below is a guessing oracle for a short secret (4-digit PIN,
// password, 6-digit OTP), and userAuth alone does not stop a stolen access
// token from grinding through the keyspace. Keyed by user id, not IP, so
// changing network does not reset the budget.
// verifyPin also settles the transaction, so its budget has to leave room for a
// business running a burst of transfers - 20 guesses per 10 min is still ~3
// days of grinding to cover 1% of a 4-digit keyspace.
const payLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'verify-pin-pay', byUser: true });
// These two verify only. One shared bucket, so hopping between them does not
// buy extra guesses.
const secretLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'verify-secret', byUser: true });
const codeLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'verify-code', byUser: true });
// Each resend sends a real email, so this one is an outbound-spend cap too.
const resendLimit = rateLimit({ windowMs: 10 * 60_000, max: 5, name: 'verify-resend', byUser: true });

// This is the settlement call for every pending-payload module (send money,
// payment, cash-out, ...), so it is the one that must not run twice. A client
// that sends X-Idempotency-Key gets the first answer replayed instead of a
// second debit; one that does not is passed straight through, as before.
// Every remark this settles - air_time, data_bundle, electricity, cable_tv,
// send_money, betting - is an outgoing payment, so the KYC lock covers the lot
// from one place. It is checked before the PIN is even compared: a frozen
// wallet should not be told "wrong PIN" for a payment that could not settle.
router.post(
  '/verification-process/verify/pin',
  userAuth,
  requireKyc,
  payLimit,
  idempotency({ name: 'verify_pin_settle' }),
  VerificationController.verifyPin,
);

router.post('/pin/validate', userAuth, secretLimit, VerificationController.validatePin);

router.post('/password/validate', userAuth, secretLimit, VerificationController.validatePassword);

router.post('/verify-email', userAuth, codeLimit, VerificationController.verifyEmail);

router.post('/verify-mobile', userAuth, codeLimit, VerificationController.verifyMobile);

router.get('/resend-verify/:type', userAuth, resendLimit, VerificationController.resendVerify);

module.exports = router;
