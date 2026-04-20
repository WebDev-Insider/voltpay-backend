const express = require('express');
const router = express.Router();
const userAuth = require('../middlewares/userAuth.middleware');
const BillHeroController = require('../controllers/billHero.controller');

router.get('/bill-hero/me', userAuth, BillHeroController.me);
router.get('/bill-hero/leaderboard', userAuth, BillHeroController.leaderboard);
router.get('/bill-hero/history', userAuth, BillHeroController.history);
router.post('/bill-hero/claim', userAuth, BillHeroController.claim);

module.exports = router;
