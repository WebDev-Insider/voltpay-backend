const { uploadFile } = require('../helpers/upload.helper');

async function uploadImage(req, res) {
  try {
    console.log('📥 Image upload request (controller)');

    if (!req.file) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['No image file provided'],
        data: null
      });
    }

    const uploaded = await uploadFile(req.file, { prefix: 'profile' });

    return res.json({
      remark: 'image_uploaded',
      status: 'success',
      message: ['Image uploaded successfully'],
      data: {
        image_url: uploaded.url,
        file_key: uploaded.key,
        name: uploaded.name,
        size: uploaded.size
      }
    });
  } catch (error) {
    console.error('Error uploading image (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to upload image'],
      data: null
    });
  }
}

module.exports = { uploadImage };
