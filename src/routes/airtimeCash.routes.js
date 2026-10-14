const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const AirtimeCashController = require('../controllers/airtimeCash.controller');
const { requireFeature } = require('../helpers/featureFlag.helper');

// Two switches, deliberately. `airtime_cash` stops new conversions - a
// MySubWallet incident - while `withdrawals` stops payouts. Paying out cash a
// customer already converted must not depend on the conversion rail being up,
// so the withdraw route only answers to the second one. Reads stay up under
// both, so the app can still show what is owed.
const conversionsEnabled = requireFeature('airtime_cash');
const withdrawalsEnabled = requireFeature('withdrawals');

// KYC is enforced in the service rather than by requireKyc here: that gate
// only trips on money funded into the wallet, which this feature never does.
// See airtimeCash.helper requireKyc().

// A code is a text message to whatever number the body names. One limiter
// instance for start and resend - one counter, not one each - and the service
// adds a per-line ceiling across every account on top.
const otpLimit = rateLimit({ windowMs: 30 * 60_000, max: 8, name: 'airtime-cash-otp', byUser: true });
const verifyLimit = rateLimit({ windowMs: 10 * 60_000, max: 15, name: 'airtime-cash-verify', byUser: true });
// The Share & Sell PIN is guessed against here, so the cap is per account.
const convertLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'airtime-cash-convert', byUser: true });
// Same reasoning and number as /kyc/bank/verify: Paystack resolves any account
// in the country, and an uncapped endpoint in front of it is a lookup service.
const accountLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'airtime-cash-account', byUser: true });
// Takes the VoltPay PIN.
const withdrawLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'airtime-cash-withdraw', byUser: true });

router.get('/airtime-cash', userAuth, AirtimeCashController.home);
router.get('/airtime-cash/conversions', userAuth, AirtimeCashController.conversions);
router.get('/airtime-cash/conversions/:id', userAuth, AirtimeCashController.details);

router.post('/airtime-cash/start', userAuth, conversionsEnabled, otpLimit, AirtimeCashController.start);
router.post('/airtime-cash/conversions/:id/resend', userAuth, conversionsEnabled, otpLimit, AirtimeCashController.resend);
router.post('/airtime-cash/conversions/:id/verify', userAuth, conversionsEnabled, verifyLimit, AirtimeCashController.verify);
router.post(
  '/airtime-cash/conversions/:id/convert',
  userAuth,
  conversionsEnabled,
  convertLimit,
  // A retried convert whose answer was lost replays the first answer rather
  // than moving the airtime twice. The status guard in the service is the
  // other half.
  idempotency({ name: 'airtime_cash_convert' }),
  AirtimeCashController.convert,
);

router.get('/airtime-cash/withdraw', userAuth, AirtimeCashController.withdrawOptions);
router.post('/airtime-cash/payout-account/resolve', userAuth, accountLimit, AirtimeCashController.resolveAccount);
router.post(
  '/airtime-cash/withdraw',
  userAuth,
  withdrawalsEnabled,
  withdrawLimit,
  idempotency({ name: 'airtime_cash_withdraw' }),
  AirtimeCashController.withdraw,
);
router.get('/airtime-cash/withdrawals/:id', userAuth, AirtimeCashController.withdrawal);

module.exports = router;
