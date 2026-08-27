const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const KycController = require('../controllers/kyc.controller');
const { upload } = require('../middlewares/upload.middleware');

// NOTHING ON THIS ROUTER CARRIES `requireKyc`, AND THAT IS LOAD-BEARING.
//
// The BVN check debits the customer's wallet ₦60. kycGate freezes a wallet once
// it has received the unverified funding limit, so putting the gate in front of
// these routes would mean a frozen user cannot pay to verify, cannot verify, and
// can never thaw - a permanent lock with no way out but support. Do not add it
// here. The gate belongs on the routes that SPEND, which is where it is:
// bills, sendMoney, requestMoney, betting, verification.

// Each submission is a paid lookup - billed to the customer whether or not it
// matches, because ArewaSmart bills us the same way - and a probe against a
// national register, so this is a spend cap, an anti-enumeration control, and a
// cap on how much of somebody's wallet a stolen token can burn. Keyed by user,
// not IP: a stolen token must not get a fresh budget by changing network.
//
// 5/hour is ₦300 at the current fee. Worth keeping in mind if the fee moves.
const bvnLimit = rateLimit({ windowMs: 60 * 60_000, max: 5, name: 'kyc-bvn-submit', byUser: true });

// The slip costs no provider money, so this is not a spend cap - it caps two
// other things. A 5MB upload per attempt is real bandwidth and real storage, and
// on the far side of it is a human reviewer whose queue anyone could otherwise
// fill. Lower than the BVN's 5 because a legitimate user needs one good photo,
// not five: they retry a BVN because a register said no, but a slip that has
// been sent is simply waiting.
const slipLimit = rateLimit({ windowMs: 60 * 60_000, max: 3, name: 'kyc-nin-slip-submit', byUser: true });

router.get('/kyc/status', userAuth, KycController.status);

// { bvn, pin } - two fields, and the verdict arrives in the response. The lookup
// is synchronous, so there is no callback route here and nothing on this router
// is public. The PIN is there because this is a wallet debit like any other.
router.post('/kyc/bvn/verify', userAuth, bvnLimit, KycController.submitBvn);

// The manual path, for a user with no BVN: a photo of the NIN slip, reviewed by
// a person. multipart/form-data, one file on the field `slip`.
//
// The limiter runs BEFORE multer, so a caller over their budget is refused
// before 5MB is read off the socket - the other way round we would pay for the
// upload and then throw it away.
router.post('/kyc/nin-slip', userAuth, slipLimit, upload.single('slip'), KycController.submitNinSlip);

// The bank account: required of everybody, whichever identity route they used.
//
// Free and instant, so this limiter is not a spend cap. It is there because
// Paystack's /bank/resolve will happily answer for any account number in the
// country, and an unlimited authenticated endpoint in front of it is an
// account-name lookup service. 20/hour is far more than a person changing banks
// needs and far less than enumeration wants.
const bankLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'kyc-bank-verify', byUser: true });

router.get('/kyc/banks', userAuth, KycController.listBanks);
router.post('/kyc/bank/verify', userAuth, bankLimit, KycController.verifyBankAccount);

// NIN *number* verification is withdrawn - a different thing entirely to the
// slip route above, which is a reviewed document. The route stays only so
// installed APKs get 410 and a sentence instead of a 404 - the handler returns a
// constant, touches no database and calls no provider, so there is nothing here
// to rate-limit and no spend to cap.
router.post('/kyc/nin/verify', userAuth, KycController.submitNin);

module.exports = router;
