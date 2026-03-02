const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common image types and octet-stream with known extensions
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/svg+xml',
      'application/octet-stream'
    ];

    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const name = (file.originalname || '').toLowerCase();
    const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')) : '';

    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('image/') || (file.mimetype === 'application/octet-stream' && imageExtensions.includes(ext))) {
      return cb(null, true);
    }
    return cb(new Error(`File type ${file.mimetype} not allowed. Only image files are accepted.`));
  }
});

// Broader middleware for support attachments: allow images + pdf + doc/docx
const attachmentsUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream'
    ];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.doc', '.docx'];
    const name = (file.originalname || '').toLowerCase();
    const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')) : '';
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext) || file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    return cb(new Error(`File type ${file.mimetype} not allowed.`));
  }
});

const uploadSingleImage = upload.single('image');
const uploadAnyAttachments = attachmentsUpload.any();

module.exports = { uploadSingleImage, upload, uploadAnyAttachments };
