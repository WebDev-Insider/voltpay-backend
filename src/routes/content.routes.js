const express = require('express');
const router = express.Router();

const ContentController = require('../controllers/content.controller');

router.get('/policies', ContentController.getPolicies);
router.get('/faq', ContentController.getFaq);

module.exports = router;
