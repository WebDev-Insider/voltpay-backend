const express = require('express');
const router = express.Router();

const MiscController = require('../controllers/misc.controller');
const idempotency = require('../middlewares/idempotency.middleware');

router.post('/logout', MiscController.postLogout);
router.get('/logout', MiscController.getLogout);

// "Did my payment go through?" - the only safe answer to a timeout. Read-only,
// so it can be polled; auth comes from the global enforceLogin in server.js.
router.get('/payment-status/:key', idempotency.paymentStatus);

module.exports = router;
