const express = require('express');
const router = express.Router();

const SupportController = require('../controllers/support.controller');
const { uploadAnyAttachments } = require('../middlewares/upload.middleware');

// Create support ticket with optional attachments
router.post('/ticket/create', uploadAnyAttachments, SupportController.createTicket);

module.exports = router;
