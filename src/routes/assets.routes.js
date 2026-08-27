const express = require('express');
const router = express.Router();

const AssetsController = require('../controllers/assets.controller');

// Profile images are absolute UploadThing URLs now - the app loads them
// directly, so the redirect shim that used to unwrap CDN paths is gone.
router.get('/assets/images/country/:filename', AssetsController.getCountryFlag);

// The email logo. Mounted outside API_PREFIX so it never passes through
// enforceLogin - the fetcher is a recipient's mail client, which has no
// session and never will.
router.get('/assets/brand/:filename', AssetsController.getBrandAsset);

module.exports = router;
