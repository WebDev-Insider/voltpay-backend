const express = require('express');
const router = express.Router();

const DashboardController = require('../controllers/dashboard.controller');
const userAuth = require('../middlewares/userAuth.middleware');

router.get('/dashboard', userAuth, DashboardController.getDashboard);

module.exports = router;
