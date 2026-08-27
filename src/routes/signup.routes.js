const express = require('express');
const router = express.Router();

const SignupController = require('../controllers/signup.controller');
const rateLimit = require('../middlewares/rateLimit.middleware');

// GET /signup/availability - live username / email availability for the form
router.get(
  '/signup/availability',
  rateLimit({ name: 'signup_availability', windowMs: 60 * 1000, max: 40 }),
  SignupController.checkAvailability,
);

// POST /signup/email - Request a signup email verification OTP
router.post(
  '/signup/email',
  rateLimit({ name: 'signup_otp', windowMs: 10 * 60 * 1000, max: 5, field: 'email' }),
  SignupController.requestEmailOtp,
);

// POST /signup/verify-email - Check the OTP without consuming it
router.post(
  '/signup/verify-email',
  rateLimit({ name: 'signup_verify', windowMs: 10 * 60 * 1000, max: 10, field: 'email' }),
  SignupController.verifySignupEmailOtp,
);

// POST /signup/register - Verify OTP and create account
router.post(
  '/signup/register',
  rateLimit({ name: 'signup_register', windowMs: 10 * 60 * 1000, max: 10, field: 'email' }),
  SignupController.registerWithEmailOtp,
);

module.exports = router;
