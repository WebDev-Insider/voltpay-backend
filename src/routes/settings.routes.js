const express = require('express');
const router = express.Router();

const SettingsController = require('../controllers/settings.controller');

router.get('/get-countries', SettingsController.getCountries);
router.get('/language/:code', SettingsController.getLanguage);
router.get('/general-setting', SettingsController.getGeneralSetting);
router.get('/module-setting', SettingsController.getModuleSetting);

module.exports = router;
