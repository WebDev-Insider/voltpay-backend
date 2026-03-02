const express = require('express');
const router = express.Router();

const AuthController = require('../controllers/auth.controller');

router.post('/login', AuthController.login);
router.post('/register', AuthController.register);
router.post('/authentication', AuthController.authentication);
router.get('/authorization', AuthController.getAuthorization);
router.post('/authorization', AuthController.postAuthorization);

module.exports = router;
