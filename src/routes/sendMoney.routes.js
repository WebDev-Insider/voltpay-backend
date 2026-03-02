const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const SendMoneyController = require('../controllers/sendMoney.controller');

router.get('/send-money', userAuth, SendMoneyController.info);
router.post('/send-money/store', userAuth, SendMoneyController.store);
router.get('/send-money/history', userAuth, SendMoneyController.history);

module.exports = router;
