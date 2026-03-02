const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const AirtimeController = require('../controllers/airtime.controller');

router.get('/airtime/create', userAuth, AirtimeController.create);
router.get('/airtime/operators-by-country/:countryID', userAuth, AirtimeController.operatorsByCountry);
router.post('/airtime/store', userAuth, AirtimeController.store);
router.get('/airtime/history', userAuth, AirtimeController.history);

module.exports = router;
