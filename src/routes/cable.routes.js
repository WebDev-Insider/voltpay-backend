const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const CableController = require('../controllers/cable.controller');

router.get('/cable-tv/create', userAuth, CableController.create);
router.get('/cable-tv/operators-by-country/:countryID', userAuth, CableController.operatorsByCountry);
router.get('/cable-tv/bundles/:service', userAuth, CableController.bundles);
router.post('/cable-tv/verify', userAuth, CableController.verify);
router.post('/cable-tv/store', userAuth, CableController.store);

module.exports = router;
