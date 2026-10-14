const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const requireKyc = require('../middlewares/kycGate.middleware');
const BillsController = require('../controllers/bills.controller');
const MysubwalletWebhook = require('../controllers/mysubwalletWebhook.controller');
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

// The webhook is unauthenticated by necessity, and every delivery costs one
// status call against the provider's rate budget - the same budget live vending
// spends. Unlimited, a flood of forged deliveries would starve vending of
// provider calls: a payments outage caused from outside. Keyed on IP, and set
// well above anything the provider would send.
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

// Delivery notifications. No userAuth: the caller is a provider, not a
// customer, and the path is allowlisted in server.js.
//
// MySubWallet has no signature scheme, so the callback is never trusted on its
// own - the controller re-reads every outcome over the authenticated requery
// before settling. Bills and Bill Hero rewards report here.
//
// **Optional.** Their docs say the callback URL is set on their dashboard, but
// as of 2026-10-06 the dashboard offers no such setting, so nothing calls this
// yet. Nothing depends on it: most purchases answer on the purchase call
// itself, and a pending one is settled by the receipt poll and the bills sweep,
// which ask MySubWallet directly. If the setting ever appears, point it at
// `<PUBLIC_BASE_URL><API_PREFIX>/bills/webhook/mysubwallet` and settlement
// simply gets faster.
router.post('/bills/webhook/mysubwallet', webhookLimit, MysubwalletWebhook.webhook);

module.exports = router;
