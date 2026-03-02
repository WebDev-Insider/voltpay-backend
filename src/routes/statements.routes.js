const express = require('express');
const router = express.Router();

const StatementsController = require('../controllers/statements.controller');
const userAuth = require('../middlewares/userAuth.middleware');

router.get('/statements', userAuth, StatementsController.getStatements);

module.exports = router;
