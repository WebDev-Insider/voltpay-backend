const express = require('express');
const router = express.Router();

const SignupController = require('../controllers/signup.controller');

// POST /signup/email - Request a signup email verification OTP
router.post('/signup/email', SignupController.requestEmailOtp);

// POST /signup/register - Verify OTP and create account
router.post('/signup/register', SignupController.registerWithEmailOtp);

module.exports = router;
