const express = require('express');
const router = express.Router();

const TransactionsController = require('../controllers/transactions.controller');

const userAuth = require('../middlewares/userAuth.middleware');

router.get('/transactions', userAuth, TransactionsController.getTransactions);

router.get('/transactions/export', userAuth, TransactionsController.exportTransactions);

module.exports = router;
