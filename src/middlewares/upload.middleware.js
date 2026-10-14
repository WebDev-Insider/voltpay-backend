const multer = require('multer');
const { UPLOAD_FIELDS: CAC_UPLOAD_FIELDS } = require('../helpers/cac.helper');

const storage = multer.memoryStorage();

/**
 * A refusal from a file filter. Tagged so the error handler can tell "your file
 * was the wrong type" (the caller's, a 400) from a crash (ours, a 500) - an
 * untagged Error here used to come back as "Internal server error".
 */
function fileTypeError(message) {
  const err = new Error(message);
  err.code = 'UPLOAD_FILE_TYPE';
  return err;
}

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
    return cb(fileTypeError('That file type is not allowed. Only image files are accepted.'));
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
    return cb(fileTypeError('That file type is not allowed. Send an image, a PDF or a Word document.'));
  }
});

const uploadSingleImage = upload.single('image');
const uploadAnyAttachments = attachmentsUpload.any();

/**
 * The customer-facing sentence for an upload multer refused, or null when the
 * error is not an upload refusal at all. Shared by the CAC routes below and by
 * the global error handler in server.js, which is what turns every other
 * route's refused upload into a 400 instead of a 500.
 */
function uploadErrorMessage(err) {
  if (!err) return null;
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return 'That file is too large. Choose a smaller one and try again.';
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return 'The upload had a file this form does not take.';
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_PART_COUNT':
      return 'The form could not be read. Please try again.';
    case 'UPLOAD_FILE_TYPE':
      return err.message;
    default:
      return err.name === 'MulterError' ? 'The upload could not be read. Please try again.' : null;
  }
}

// The body parsers' own refusals (express.json / urlencoded run on every route).
// Listed rather than guessed from a `type` field, so an unrelated error that
// happens to carry one is never mistaken for the caller's.
const BODY_REFUSALS = {
  // The client hung up mid-upload - a phone losing signal while sending a
  // photo. Nothing ran, nobody is left to answer, and it is not an incident.
  'request.aborted': { status: 400, quiet: true, message: 'The request was interrupted. Please try again.' },
  'entity.too.large': { status: 413, message: 'That request is too large. If it carries a photo, use a smaller one and try again.' },
  'entity.parse.failed': { status: 400, message: 'The request could not be read. Please try again.' },
  'request.size.invalid': { status: 400, message: 'The request could not be read. Please try again.' },
  'encoding.unsupported': { status: 415, message: 'The request could not be read. Please try again.' },
  'charset.unsupported': { status: 415, message: 'The request could not be read. Please try again.' },
  'parameters.too.many': { status: 413, message: 'The request has too many fields.' },
};

/**
 * The global error handler's answer to a body the parser refused, or null.
 * Same idea as uploadErrorMessage: the caller's request, never a 500 and never
 * an alert. `quiet` marks the hang-up, which is logged in one line and not
 * answered - the socket is already gone.
 */
function bodyErrorReply(err) {
  if (!err || typeof err.type !== 'string') return null;
  return BODY_REFUSALS[err.type] || null;
}

// CAC Registration. The filter here is only a first cut on the client's word;
// cac.helper sniffs every file's own bytes before anything is stored, and that
// is the check that counts. No SVG: these files are later served to an admin's
// browser, and an SVG can carry script.
const CAC_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf', 'application/octet-stream'];
const CAC_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

function cacFileFilter(req, file, cb) {
  const name = (file.originalname || '').toLowerCase();
  const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')) : '';
  if (CAC_MIMES.includes(file.mimetype) || CAC_EXTS.includes(ext)) return cb(null, true);
  return cb(fileTypeError('Only JPG, PNG or PDF files are accepted'));
}

// Every document a CAC form can carry - the applicant's, each other director's
// or trustee's, and the type's extras - straight from cac.helper, so a field
// the form sends is never one multer was not told about.
const cacDocuments = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: CAC_UPLOAD_FIELDS.length, fields: 30 },
  fileFilter: cacFileFilter,
}).fields(CAC_UPLOAD_FIELDS.map(name => ({ name, maxCount: 1 })));

// One document CAC issued, handed on by an admin: the certificate, a status
// report, a MEMART... One file per request, so each is checked and audited on
// its own, and a set of five is five calls rather than one all-or-nothing post.
const cacDeliverable = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: cacFileFilter,
}).single('file');

/** Run a multer handler and answer its refusals in the API's own envelope. */
function friendly(handler) {
  return function friendlyUpload(req, res, next) {
    handler(req, res, err => {
      if (!err) return next();
      const message = uploadErrorMessage(err);
      if (!message) return next(err);
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: [message], data: null });
    });
  };
}

const uploadCacDocuments = friendly(cacDocuments);
const uploadCacDeliverable = friendly(cacDeliverable);

module.exports = {
  uploadSingleImage,
  upload,
  uploadAnyAttachments,
  uploadCacDocuments,
  uploadCacDeliverable,
  uploadErrorMessage,
  bodyErrorReply,
};
