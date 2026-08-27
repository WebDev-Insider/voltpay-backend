const express = require('express');
const router = express.Router();

const SupportController = require('../controllers/support.controller');
const rateLimit = require('../middlewares/rateLimit.middleware');
const { uploadAnyAttachments } = require('../middlewares/upload.middleware');

// Creating a ticket sends mail and uploads files, so it is worth capping.
// Replies are cheaper but sit on the same thread, so they get a wider budget.
const createLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'support-create', byUser: true });
const replyLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, name: 'support-reply', byUser: true });

router.get('/ticket', SupportController.listTickets);
router.post('/ticket/create', createLimit, uploadAnyAttachments, SupportController.createTicket);
router.get('/ticket/view/:id', SupportController.viewTicket);
router.post('/ticket/reply/:id', replyLimit, uploadAnyAttachments, SupportController.replyTicket);
router.post('/ticket/close/:id', SupportController.closeTicket);
router.post('/ticket/reopen/:id', SupportController.reopenTicket);
router.post('/ticket/rate/:id', SupportController.rateTicket);

module.exports = router;
