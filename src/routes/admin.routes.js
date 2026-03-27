const express = require('express')
const router = express.Router()

const AdminController = require('../controllers/admin.controller')
const AdminNotificationCampaignsController = require('../controllers/adminNotificationCampaigns.controller')

router.get('/stats', AdminController.getStats)
router.get('/users', AdminController.listUsers)
router.get('/users/:id', AdminController.getUser)
router.patch('/users/:id/status', AdminController.updateUserStatus)
router.post('/users/:id/reset-pin', AdminController.resetUserPin)
router.patch('/users/:id/role', AdminController.updateUserRole)
router.delete('/users/:id', AdminController.deleteUser)
router.patch('/users/status/bulk', AdminController.bulkUpdateUserStatus)

router.get('/notification-campaigns', AdminNotificationCampaignsController.listCampaigns)
router.post('/notification-campaigns', AdminNotificationCampaignsController.createCampaign)
router.get('/notification-campaigns/:id', AdminNotificationCampaignsController.getCampaign)
router.post('/notification-campaigns/:id/send', AdminNotificationCampaignsController.sendCampaign)

module.exports = router
