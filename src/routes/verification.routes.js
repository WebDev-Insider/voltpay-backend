const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const VerificationController = require('../controllers/verification.controller');

router.post('/verification-process/verify/pin', userAuth, VerificationController.verifyPin);

router.post('/pin/validate', userAuth, VerificationController.validatePin);

module.exports = router;
