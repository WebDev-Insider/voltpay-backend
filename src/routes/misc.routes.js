const express = require('express');
const router = express.Router();

const MiscController = require('../controllers/misc.controller');

router.post('/add-device-token', MiscController.addDeviceToken);
router.post('/logout', MiscController.postLogout);
router.get('/logout', MiscController.getLogout);

module.exports = router;
