const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const VerificationController = require('../controllers/verification.controller');

router.post('/verification-process/verify/pin', userAuth, VerificationController.verifyPin);

router.post('/pin/validate', userAuth, VerificationController.validatePin);

router.post('/verify-email', userAuth, VerificationController.verifyEmail);

router.post('/verify-mobile', userAuth, VerificationController.verifyMobile);

router.get('/resend-verify/:type', userAuth, VerificationController.resendVerify);

module.exports = router;
