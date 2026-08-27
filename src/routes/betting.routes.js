const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const BettingController = require('../controllers/betting.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

router.get('/betting/companies', userAuth, BettingController.companies);
router.post('/betting/verify', userAuth, BettingController.verifyCustomer);
router.post('/betting/store', userAuth, requireFeature('betting'), requireKyc, idempotency({ name: 'betting_store' }), BettingController.store);
router.get('/betting/query', userAuth, BettingController.query);

router.post('/betting/callback', BettingController.callback);
router.get('/betting/callback', BettingController.callback);

module.exports = router;
