const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const DataController = require('../controllers/data.controller');

router.get('/data/create', userAuth, DataController.create);
router.get('/data/operators-by-country/:countryID', userAuth, DataController.operatorsByCountry);
router.get('/data/bundles/:billerCode', userAuth, DataController.bundles);
router.post('/data/store', userAuth, DataController.store);

module.exports = router;
