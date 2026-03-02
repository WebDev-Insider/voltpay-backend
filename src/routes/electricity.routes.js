const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const ElectricityController = require('../controllers/electricity.controller');

router.get('/electricity/create', userAuth, ElectricityController.create);
router.get('/electricity/operators-by-country/:countryID', userAuth, ElectricityController.operatorsByCountry);
router.post('/electricity/verify', userAuth, ElectricityController.verify);
router.post('/electricity/store', userAuth, ElectricityController.store);
router.get('/electricity/status/:trx', userAuth, ElectricityController.status);

module.exports = router;
