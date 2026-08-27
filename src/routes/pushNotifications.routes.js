const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const PushNotificationsController = require('../controllers/pushNotifications.controller');
const DeviceTokenController = require('../controllers/deviceToken.controller');

router.post('/device-token', userAuth, DeviceTokenController.register);
router.delete('/device-token', userAuth, DeviceTokenController.unregister);

router.get('/push-notifications', userAuth, PushNotificationsController.list);
router.post('/push-notifications/ingest', userAuth, PushNotificationsController.ingest);

router.get('/push-notifications/unread-count', userAuth, PushNotificationsController.unreadCount);
router.post('/push-notifications/:id/read', userAuth, PushNotificationsController.markRead);
router.post('/push-notifications/read-all', userAuth, PushNotificationsController.markAllRead);
router.delete('/push-notifications/clear', userAuth, PushNotificationsController.clearAll);

module.exports = router;
