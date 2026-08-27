const express = require('express');
const router = express.Router();

const AppVersionController = require('../controllers/appVersion.controller');

// Public - listed in PUBLIC_API_PATHS in server.js. A blocked build has no
// session, and asking whether it is blocked must not need one.
router.get('/app/version-check', AppVersionController.versionCheck);

module.exports = router;
