const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const ScheduledTopupController = require('../controllers/scheduledTopup.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// The bills kill switch covers standing orders too: a schedule is a bill
// bought later. Reads and the controls that only reduce spending (pause,
// delete) stay up so the app can still render and the customer can stop one.
const billsEnabled = requireFeature('bills');

// Create and edit take the PIN, so they are capped per account like the bills
// confirm endpoint - a stolen access token must not be enough to walk the
// keyspace.
const pinLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'scheduled-topup-pin', byUser: true });

// Preview prices a data plan from the catalogue on a cache miss.
const previewLimit = rateLimit({ windowMs: 60_000, max: 30, name: 'scheduled-topup-preview', byUser: true });

router.get('/scheduled-topups', userAuth, ScheduledTopupController.list);

// The KYC lock is checked before the PIN sheet rather than after it, as on the
// bills quote: a frozen wallet is told now, not at 07:00 on Monday.
router.post('/scheduled-topups/preview', userAuth, billsEnabled, requireKyc, previewLimit, ScheduledTopupController.preview);
router.post(
  '/scheduled-topups',
  userAuth,
  billsEnabled,
  requireKyc,
  pinLimit,
  // A retried create replays the first answer instead of saving a second
  // standing order - which would buy the same top-up twice every cycle.
  idempotency({ name: 'scheduled_topup_create' }),
  ScheduledTopupController.create,
);

router.get('/scheduled-topups/:id', userAuth, ScheduledTopupController.show);
router.get('/scheduled-topups/:id/runs', userAuth, ScheduledTopupController.runs);
router.put('/scheduled-topups/:id', userAuth, billsEnabled, requireKyc, pinLimit, ScheduledTopupController.update);
router.post('/scheduled-topups/:id/pause', userAuth, ScheduledTopupController.pause);
router.post('/scheduled-topups/:id/resume', userAuth, billsEnabled, requireKyc, ScheduledTopupController.resume);
router.delete('/scheduled-topups/:id', userAuth, ScheduledTopupController.remove);

module.exports = router;
