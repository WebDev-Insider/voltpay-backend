const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const RequestMoneyController = require('../controllers/requestMoney.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// Creating a request costs the sender nothing but lands a push on someone
// else's phone, so the cap here is an anti-spam measure, not a money guard.
const createLimit = rateLimit({ windowMs: 10 * 60_000, max: 15, name: 'request-money-create', byUser: true });
// Paying verifies a 4-digit PIN and settles the transfer in the same call, so
// it is a guessing oracle. Same budget as verification-process/verify/pin.
const payLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'request-money-pay', byUser: true });

router.get('/request-money/create', userAuth, RequestMoneyController.info);
router.post('/request-money/store', userAuth, requireFeature('request_money'), createLimit, RequestMoneyController.store);
router.get('/request-money/history', userAuth, RequestMoneyController.sentHistory);
router.get('/request-money/received-history', userAuth, RequestMoneyController.receivedHistory);
router.post(
  '/request/money-approve/:id',
  userAuth,
  requireFeature('request_money'),
  // Approving is paying, so it is gated. Creating a request is not - a frozen
  // wallet may still ask someone else for money.
  requireKyc,
  payLimit,
  idempotency({ name: 'request_money_approve' }),
  RequestMoneyController.approve,
);
router.post('/request-money/reject/:id', userAuth, RequestMoneyController.reject);
router.post('/request-money/cancel/:id', userAuth, RequestMoneyController.cancel);

module.exports = router;
