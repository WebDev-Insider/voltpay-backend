const express = require('express');
const router = express.Router();

const { uploadSingleImage } = require('../middlewares/upload.middleware');
const UploadController = require('../controllers/upload.controller');

router.post('/upload-image', uploadSingleImage, UploadController.uploadImage);

module.exports = router;
