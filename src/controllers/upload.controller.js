const cloudinary = require('cloudinary').v2;

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

    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: 'ovopay/profiles',
          transformation: [
            { width: 400, height: 400, crop: 'fill' },
            { quality: 'auto' }
          ]
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    return res.json({
      remark: 'image_uploaded',
      status: 'success',
      message: ['Image uploaded successfully'],
      data: {
        image_url: uploadResult.secure_url,
        public_id: uploadResult.public_id,
        width: uploadResult.width,
        height: uploadResult.height
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
