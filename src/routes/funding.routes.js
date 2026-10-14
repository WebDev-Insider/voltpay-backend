const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const FundingController = require('../funding/funding.controller');

// Opening an account is a PaymentPoint call carrying the user's NIN. Ten an
// hour is far more than anyone opening their own account needs, and it bounds
// how many NINs one login can try against the provider.
const accountLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'funding-virtual-account', byUser: true });

router.post('/funding/initiate', userAuth, accountLimit, FundingController.initiate);
router.get('/funding/virtual-account', userAuth, FundingController.virtualAccount);
// POST is what actually provisions the account (user taps the button)
router.post('/funding/virtual-account', userAuth, accountLimit, FundingController.virtualAccount);
router.post('/funding/verify', userAuth, FundingController.verify);
router.post('/funding/reconcile', userAuth, FundingController.reconcile);

// Flutterwave will redirect the user to this URL after checkout
router.get('/funding/callback', FundingController.callback);

// PaymentPoint's webhook - never behind userAuth (server.js lists it as
// public). Authenticated by its HMAC signature inside the controller.
router.post('/funding/webhook', FundingController.webhook);

module.exports = router;
