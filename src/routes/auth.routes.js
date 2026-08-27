const express = require('express');
const router = express.Router();

const AuthController = require('../controllers/auth.controller');
const rateLimit = require('../middlewares/rateLimit.middleware');
const userAuth = require('../middlewares/userAuth.middleware');

router.post('/login', rateLimit({ name: 'login', windowMs: 10 * 60 * 1000, max: 15, field: 'mobile_number' }), AuthController.login);

// Signup and the code that completes it. Both were open, and both are worth a
// window: `register` creates rows and sends mail, and `authentication` checks a
// six-digit signup code, which is the same guessing oracle the password reset
// routes are limited for. Keyed on the mobile number so one handset retrying
// cannot exhaust a shared carrier NAT's budget.
router.post(
  '/register',
  rateLimit({ name: 'register', windowMs: 15 * 60 * 1000, max: 10, field: 'mobile_number' }),
  AuthController.register,
);
router.post(
  '/authentication',
  rateLimit({ name: 'authentication', windowMs: 15 * 60 * 1000, max: 10, field: 'mobile_number' }),
  AuthController.authentication,
);
router.get('/authorization', AuthController.getAuthorization);
// Exchanges a verified Firebase phone token for a session, so a successful call
// is a login. Limited like the rest of them.
router.post(
  '/authorization',
  rateLimit({ name: 'authorization', windowMs: 15 * 60 * 1000, max: 10, field: 'mobile_number' }),
  AuthController.postAuthorization,
);

// New-device / web login: email code, then the 12-word recovery phrase.
router.post(
  '/login/device-otp',
  rateLimit({ name: 'device_otp', windowMs: 10 * 60 * 1000, max: 5, field: 'mobile_number' }),
  AuthController.requestDeviceOtp,
);
router.post(
  '/login/recovery',
  rateLimit({ name: 'recovery_login', windowMs: 15 * 60 * 1000, max: 8, field: 'mobile_number' }),
  AuthController.loginWithRecoveryPhrase,
);

// Biometric login. Enrolment needs a live session (the phone has already
// proved the password); the login itself is unauthenticated, so it carries the
// same lockout and rate limit as the password login it replaces.
router.post(
  '/login/biometric',
  rateLimit({ name: 'biometric_login', windowMs: 10 * 60 * 1000, max: 15, field: 'mobile_number' }),
  AuthController.loginWithBiometric,
);
router.post('/biometric/register', userAuth, AuthController.registerBiometric);
router.delete('/biometric', userAuth, AuthController.revokeBiometricCredential);

module.exports = router;
