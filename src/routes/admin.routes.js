const express = require('express')
const router = express.Router()

const AdminController = require('../controllers/admin.controller')

router.get('/stats', AdminController.getStats)
router.get('/users', AdminController.listUsers)
router.get('/users/:id', AdminController.getUser)
router.patch('/users/:id/status', AdminController.updateUserStatus)
router.post('/users/:id/reset-pin', AdminController.resetUserPin)
router.patch('/users/:id/role', AdminController.updateUserRole)
router.patch('/users/status/bulk', AdminController.bulkUpdateUserStatus)

module.exports = router
