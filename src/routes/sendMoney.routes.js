const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const SendMoneyController = require('../controllers/sendMoney.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');

// Kill switch on the write only. Reading the fee table or your own history
// stays up when transfers are switched off, so the app can still explain itself.
router.get('/send-money', userAuth, SendMoneyController.info);
router.post(
  '/send-money/store',
  userAuth,
  requireFeature('send_money'),
  requireKyc,
  idempotency({ name: 'send_money_store' }),
  SendMoneyController.store,
);
router.get('/send-money/history', userAuth, SendMoneyController.history);

module.exports = router;
