const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const FundingController = require('../funding/funding.controller');

router.post('/funding/initiate', userAuth, FundingController.initiate);
router.get('/funding/virtual-account', userAuth, FundingController.virtualAccount);
router.post('/funding/verify', userAuth, FundingController.verify);
router.post('/funding/reconcile', userAuth, FundingController.reconcile);

// Flutterwave will redirect the user to this URL after checkout
router.get('/funding/callback', FundingController.callback);

// Webhook from Flutterwave (do not protect with userAuth)
router.post('/funding/webhook', FundingController.webhook);

module.exports = router;
