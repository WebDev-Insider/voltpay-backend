const express = require('express');
const router = express.Router();

const AssetsController = require('../controllers/assets.controller');

router.get('/assets/images/user/profile/:filename', AssetsController.getProfileImage);
router.get('/assets/images/country/:filename', AssetsController.getCountryFlag);
router.get('/assets/images/user/profile//:filename', AssetsController.getDoubleSlashProfileImage);
router.get('/assets/images/user/profile/https:*', AssetsController.getUrlEncodedProfileImage);

module.exports = router;
