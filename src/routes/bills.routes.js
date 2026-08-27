const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const BillsController = require('../controllers/bills.controller');
const PairgateWebhook = require('../controllers/pairgateWebhook.controller');
const ClubkonnectWebhook = require('../controllers/clubkonnectWebhook.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// Kill switch. Catalogue and lookups stay up so the app can still render, the
// two calls that move money do not.
const billsEnabled = requireFeature('bills');

// A PIN is four or five digits. Without a server-side ceiling, a stolen access
// token is enough to walk the whole keyspace, so confirm is capped per account
// rather than per IP.
const confirmLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'bills-confirm', byUser: true });

// The lookups hit the provider on a cache miss, so they are capped too - a tight
// loop on meter validation is both a provider bill and an enumeration oracle.
const lookupLimit = rateLimit({ windowMs: 60_000, max: 30, name: 'bills-lookup', byUser: true });

// The webhooks are unauthenticated by necessity, and every delivery that cannot
// be verified from its own body costs one status call against a global budget of
// sixty a minute. Unlimited, a flood of forged deliveries would starve live
// vending of provider calls - a payments outage caused from outside. Keyed on
// IP, and set well above anything either provider would send.
//
// One limiter, shared. Separate budgets would let a flood on the unsigned
// endpoint spend the calls the other rail's vends need anyway, since the two
// providers' rate limits are the thing actually being protected and a forger
// picks whichever endpoint is cheapest.
const webhookLimit = rateLimit({ windowMs: 60_000, max: 240, name: 'bills-webhook' });

// Catalogue
router.get('/bills/airtime/providers', userAuth, BillsController.airtimeProviders);
router.get('/bills/data/providers', userAuth, BillsController.dataProviders);
router.get('/bills/data/plans/:provider', userAuth, BillsController.dataPlans);
router.get('/bills/tv/providers', userAuth, BillsController.tvProviders);
router.get('/bills/tv/packages/:provider', userAuth, BillsController.tvPackages);
router.get('/bills/electricity/providers', userAuth, BillsController.electricityProviders);

// Customer lookups
router.post('/bills/tv/validate', userAuth, lookupLimit, BillsController.tvValidate);
router.post('/bills/electricity/validate', userAuth, lookupLimit, BillsController.electricityValidate);

// Price it, then pay it. `service` is one of airtime | data | tv | electricity.
// The KYC lock is checked on the quote too, so a frozen wallet is told before
// the PIN sheet rather than after it.
router.post('/bills/:service/quote', userAuth, billsEnabled, requireKyc, lookupLimit, BillsController.quote);
// The vend can take longer than a Nigerian mobile connection stays up. The
// idempotency guard sits in front of the balance reserve so a retry of the
// same attempt replays the first answer instead of debiting again.
router.post(
  '/bills/:service/confirm',
  userAuth,
  billsEnabled,
  requireKyc,
  confirmLimit,
  idempotency({ name: 'bills_confirm' }),
  BillsController.confirm,
);

// Receipt refresh - reads the ledger row, so it shares the lookup budget.
router.get('/bills/status/:trx', userAuth, lookupLimit, BillsController.status);

// Delivery notifications. No userAuth: the caller is a provider, not a customer,
// and both paths are allowlisted in server.js.
//
// PairGate authenticates by HMAC when a secret is configured (see the
// controller). This is the only route on which a PairGate electricity token ever
// arrives.
router.post('/bills/webhook/pairgate', webhookLimit, PairgateWebhook.webhook);

// ClubKonnect has no signature scheme at all, so its callback is never trusted
// on its own - the controller re-reads every outcome over the authenticated API
// before settling. GET as well as POST: their callback has been observed
// arriving as a bare query string, and a 404 on it would just burn their retries.
router.post('/bills/webhook/clubkonnect', webhookLimit, ClubkonnectWebhook.webhook);
router.get('/bills/webhook/clubkonnect', webhookLimit, ClubkonnectWebhook.webhook);

module.exports = router;
