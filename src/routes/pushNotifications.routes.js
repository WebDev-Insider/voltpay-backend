const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const PushNotificationsController = require('../controllers/pushNotifications.controller');

router.get('/push-notifications', userAuth, PushNotificationsController.list);
router.post('/push-notifications/ingest', userAuth, PushNotificationsController.ingest);

router.get('/notification/settings', userAuth, PushNotificationsController.getSettings);
router.post('/notification/settings', userAuth, PushNotificationsController.setSettings);

module.exports = router;
