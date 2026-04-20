const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const BettingController = require('../controllers/betting.controller');

router.get('/betting/companies', userAuth, BettingController.companies);
router.post('/betting/verify', userAuth, BettingController.verifyCustomer);
router.post('/betting/store', userAuth, BettingController.store);
router.get('/betting/query', userAuth, BettingController.query);
router.post('/betting/cancel', userAuth, BettingController.cancel);

router.post('/betting/callback', BettingController.callback);
router.get('/betting/callback', BettingController.callback);

module.exports = router;
