const express = require('express');
const router = express.Router();

const PasswordController = require('../controllers/password.controller');

// POST /password/email - Request a PIN reset code via email
router.post('/password/email', PasswordController.requestResetEmail);

// POST /password/verify-code - Verify the PIN reset code sent via email
router.post('/password/verify-code', PasswordController.verifyCode);

// POST /password/reset - Reset the user's PIN using email + code
router.post('/password/reset', PasswordController.resetPin);

module.exports = router;
