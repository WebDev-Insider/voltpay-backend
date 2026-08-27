const express = require('express');
const router = express.Router();

const UserController = require('../controllers/user.controller');
const { uploadSingleImage } = require('../middlewares/upload.middleware');
const userAuth = require('../middlewares/userAuth.middleware');

router.get('/user-info', userAuth, UserController.userInfo);
router.post('/user/exist', userAuth, UserController.userExist);
router.post('/profile-setting', userAuth, uploadSingleImage, UserController.profileSetting);
router.post('/user-data-submit', uploadSingleImage, UserController.userDataSubmit);
router.post('/change-password', userAuth, UserController.changePassword);
// Account lifecycle (deactivate / reactivate / delete) lives in account.routes.js

module.exports = router;
