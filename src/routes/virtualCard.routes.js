const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const VirtualCardController = require('../controllers/virtualCard.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// The kill switch stops NEW business: a new card and a top-up. It never stops a
// customer seeing, freezing or revealing the card they already own - switching
// the service off must not leave anyone unable to freeze a card they lost.
const serviceEnabled = requireFeature('virtual_card');

// A create is a paid KYC enrolment at Payvessel and a PIN check, so it is the
// tightest budget here. Each limiter that takes a PIN is also that route's
// PIN-guessing budget.
const createLimit = rateLimit({ windowMs: 60 * 60_000, max: 6, name: 'vcard-create', byUser: true });
const validateLimit = rateLimit({ windowMs: 60 * 60_000, max: 30, name: 'vcard-validate', byUser: true });
const fundLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'vcard-fund', byUser: true });
// Each quote may re-read the card's balance at Payvessel, and the screen asks
// as the customer types.
const quoteLimit = rateLimit({ windowMs: 10 * 60_000, max: 60, name: 'vcard-quote', byUser: true });
const freezeLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'vcard-freeze', byUser: true });
// The card number itself. Generous enough for "I closed it before I copied
// the CVV", tight enough that a stolen session cannot sit and harvest it.
const revealLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'vcard-reveal', byUser: true });
// Takes the PIN and is permanent: a small budget, which is also the
// PIN-guessing budget for this route. The preview reads Payvessel.
const terminateLimit = rateLimit({ windowMs: 60 * 60_000, max: 10, name: 'vcard-terminate', byUser: true });
const terminatePreviewLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, name: 'vcard-terminate-preview', byUser: true });

router.get('/virtual-card', userAuth, VirtualCardController.home);
router.get('/virtual-card/form', userAuth, VirtualCardController.form);
router.get('/virtual-card/transactions', userAuth, VirtualCardController.transactions);
router.post('/virtual-card/validate', userAuth, serviceEnabled, validateLimit, VirtualCardController.validate);

router.post(
  '/virtual-card/create',
  userAuth,
  serviceEnabled,
  // A wallet debit like any other, so the spend gate applies, before
  // idempotency: a refusal here moved nothing and must not burn the key the
  // retry-after-verifying will carry. The service additionally requires FULL
  // verification - the gate alone lets an unverified wallet spend below its
  // funding limit, and a card needs a verified identity.
  requireKyc,
  createLimit,
  // A retried create whose answer was lost replays the first answer instead of
  // charging and enrolling again. The one-live-card index is the other half.
  idempotency({ name: 'virtual_card_create' }),
  VirtualCardController.create,
);

router.get('/virtual-card/quote', userAuth, quoteLimit, VirtualCardController.quote);
router.post(
  '/virtual-card/fund',
  userAuth,
  serviceEnabled,
  requireKyc,
  fundLimit,
  // One key per top-up attempt. With the one-top-up-in-flight index, a lost
  // answer can never become a second debit.
  idempotency({ name: 'virtual_card_fund' }),
  VirtualCardController.fund,
);

// Never behind the kill switch: a customer must always be able to stop their
// card, whatever state the service is in.
router.post('/virtual-card/freeze', userAuth, freezeLimit, VirtualCardController.freeze);
router.post('/virtual-card/unfreeze', userAuth, freezeLimit, VirtualCardController.unfreeze);
router.post('/virtual-card/reveal', userAuth, revealLimit, VirtualCardController.reveal);
// Closing a card is never behind the kill switch either, and not behind the KYC
// spend gate: it debits nothing - it hands the card's money back. No card id
// is taken from the request: a customer can only ever reach their own card.
router.get('/virtual-card/terminate', userAuth, terminatePreviewLimit, VirtualCardController.terminationPreview);
router.post('/virtual-card/terminate', userAuth, terminateLimit, VirtualCardController.terminate);

// Public (see PUBLIC_API_PATHS in server.js). Authenticated by its HMAC.
router.post('/virtual-card/webhook', VirtualCardController.webhook);

module.exports = router;
