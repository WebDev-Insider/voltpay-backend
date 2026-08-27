const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const BillHeroController = require('../controllers/billHero.controller');
const { requireBillHeroOpen } = require('../helpers/billHeroAvailability.helper');

// The gate. Cheap enough to call on every app open, and always 200 - a shut
// promotion is an answer, not an error.
router.get('/bill-hero/status', userAuth, BillHeroController.status);

// `me` carries the availability block itself and reports zero progress for
// anything earned while shut, so it stays readable when locked - the screen
// needs it to render the lock message alongside the standing counts.
router.get('/bill-hero/me', userAuth, BillHeroController.me);
router.get('/bill-hero/leaderboard', userAuth, BillHeroController.leaderboard);
router.get('/bill-hero/history', userAuth, BillHeroController.history);

// Claiming spends real money on airtime and data, so it is the one route the
// lock closes outright.
router.post('/bill-hero/claim', userAuth, requireBillHeroOpen(), BillHeroController.claim);

module.exports = router;
