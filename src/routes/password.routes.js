// PIN / password recovery by email code.
//
// Every route here is unauthenticated by definition - the whole point is to let
// in someone who cannot log in - so the Redis limiter is the only thing standing
// in front of them. Each one is keyed on `email` as well as the IP, so one
// person retrying cannot spend another's budget from behind the same carrier
// NAT, and rotating IPs cannot buy extra guesses against one address.
//
// The numbers are chosen per route rather than shared, because the three abuse
// cases are different:
//
//  - **verify-code and reset are guessing oracles.** The code is six digits, so
//    an unlimited endpoint is a million tries against any address the attacker
//    knows - and `reset` sets a new PIN on success, which is full account
//    takeover. 10 per 15 minutes makes exhausting the space take years, while
//    still forgiving a user who fat-fingers the code a few times. This is the
//    reason this file has limits at all.
//  - **email is a sending cost and an inbox.** Each call mails a real address
//    and writes a passwordReset row, so an open endpoint is a mail bomb aimed
//    at a customer and a bill aimed at us. 5 per 15 minutes is well above what
//    a genuine "resend" needs.
//
// The limiter fails open to an in-process counter if Redis is unavailable
// (rateLimit.middleware) - weaker, but never a lockout.
const express = require('express');
const router = express.Router();

const PasswordController = require('../controllers/password.controller');
const rateLimit = require('../middlewares/rateLimit.middleware');

const requestLimit = rateLimit({
  name: 'password_email',
  windowMs: 15 * 60 * 1000,
  max: 5,
  field: 'email',
});

// One instance, mounted on both code routes on purpose. The middleware holds no
// per-route state - the counter lives in Redis under the bucket name - so the
// two endpoints share a single window. Giving them a limiter each would hand an
// attacker twice the guesses against the same six-digit code for free.
const codeLimit = rateLimit({
  name: 'password_code',
  windowMs: 15 * 60 * 1000,
  max: 10,
  field: 'email',
});

// POST /password/email - Request a PIN reset code via email
router.post('/password/email', requestLimit, PasswordController.requestResetEmail);

// POST /password/verify-code - Verify the PIN reset code sent via email
router.post('/password/verify-code', codeLimit, PasswordController.verifyCode);

// POST /password/reset - Reset the user's PIN using email + code
router.post('/password/reset', codeLimit, PasswordController.resetPin);

module.exports = router;
