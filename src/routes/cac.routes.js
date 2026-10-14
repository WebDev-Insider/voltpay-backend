const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const { uploadCacDocuments } = require('../middlewares/upload.middleware');
const CacController = require('../controllers/cac.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// The kill switch stops NEW business: a new form and a payment. It does not
// stop a customer already paid from answering "needs more info" or downloading
// their documents - switching the service off must not strand them.
const serviceEnabled = requireFeature('cac_registration');

// Each limiter runs BEFORE multer, so a caller over budget is refused before
// three photographs are read off the socket.
//
// A form is three uploads to storage and, behind it, a person's time.
const createLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'cac-create', byUser: true });
const updateLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'cac-update', byUser: true });
// Takes the VoltPay PIN, so this is also the PIN-guessing budget.
const payLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'cac-pay', byUser: true });
const checkoutLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'cac-checkout', byUser: true });
// Each verify is a Paystack call, and the app polls it while a checkout is open.
const verifyLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, name: 'cac-verify', byUser: true });
// A completed company can hold several documents, each one download.
const downloadLimit = rateLimit({ windowMs: 10 * 60_000, max: 60, name: 'cac-documents', byUser: true });

router.get('/cac', userAuth, CacController.home);
router.get('/cac/applications', userAuth, CacController.applications);
router.get('/cac/applications/:id', userAuth, CacController.details);

router.post('/cac/applications', userAuth, serviceEnabled, createLimit, uploadCacDocuments, CacController.create);
router.post('/cac/applications/:id/update', userAuth, updateLimit, uploadCacDocuments, CacController.update);
router.delete('/cac/applications/:id', userAuth, updateLimit, CacController.discard);

router.post(
  '/cac/applications/:id/pay/wallet',
  userAuth,
  serviceEnabled,
  // A wallet debit like any other, so the spend gate applies. It runs before
  // idempotency: a refusal here moved nothing and must not burn the key the
  // retry-after-verifying will carry.
  requireKyc,
  payLimit,
  // A retried payment whose answer was lost replays the first answer instead of
  // charging again. The guarded claim in the service is the other half.
  idempotency({ name: 'cac_pay_wallet' }),
  CacController.payWallet,
);
// Opens a checkout - moves nothing - so no KYC gate and no idempotency key: a
// repeat within the window is handed the checkout it already has.
router.post('/cac/applications/:id/paystack', userAuth, serviceEnabled, checkoutLimit, CacController.paystackInit);
// Never behind the switch: money may already be on its way.
router.post('/cac/applications/:id/paystack/verify', userAuth, verifyLimit, CacController.paystackVerify);

// What CAC issued - the certificate and everything with it - once completed.
router.get('/cac/applications/:id/deliverables/:docId', userAuth, downloadLimit, CacController.deliverable);

// Public (see PUBLIC_API_PATHS in server.js). A static page that settles nothing.
router.get('/cac/paystack/callback', CacController.paystackCallback);

module.exports = router;
