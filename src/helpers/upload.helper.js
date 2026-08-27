// Single place the API talks to UploadThing. Multer keeps files in memory
// (upload.middleware.js), so everything here starts from a Buffer.
//
// UploadThing is storage only - unlike the CDN it replaced there is no
// server-side resize/crop, so the size ceiling is the multer limit and the app
// is what downscales before sending.
const { UTApi } = require('uploadthing/server');

let client = null;

function utapi() {
  const token = process.env.UPLOADTHING_TOKEN;
  if (!token) {
    throw new Error('UPLOADTHING_TOKEN is not set');
  }
  if (!client) client = new UTApi({ token });
  return client;
}

function isUploadThingUrl(url) {
  const value = String(url || '');
  return value.includes('.ufs.sh/f/') || value.includes('utfs.io/f/');
}

/** The key is the last path segment - that is all deleteFiles needs. */
function fileKeyFromUrl(url) {
  if (!isUploadThingUrl(url)) return '';
  const clean = String(url).split('?')[0].replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

/**
 * @param {{buffer: Buffer, originalname?: string, mimetype?: string}} file  a multer memory-storage file
 * @returns {Promise<{url: string, key: string, name: string, size: number}>}
 */
async function uploadFile(file, { prefix = 'upload' } = {}) {
  if (!file || !file.buffer) throw new Error('No file provided');

  const extension = String(file.originalname || '').includes('.')
    ? String(file.originalname).slice(String(file.originalname).lastIndexOf('.'))
    : '';
  const name = `${prefix}_${Date.now()}${extension}`;

  const payload = new File([file.buffer], name, {
    type: file.mimetype || 'application/octet-stream',
  });

  const result = await utapi().uploadFiles(payload);
  const entry = Array.isArray(result) ? result[0] : result;

  if (!entry || entry.error || !entry.data) {
    throw new Error(entry?.error?.message || 'UploadThing upload failed');
  }

  return {
    // ufsUrl is the current field; url is the older alias still returned by v7.
    url: entry.data.ufsUrl || entry.data.url,
    key: entry.data.key,
    name: entry.data.name,
    size: entry.data.size,
  };
}

/**
 * Best effort: a replaced profile picture should not linger, but failing to
 * delete the old file must never fail the request that uploaded the new one.
 */
async function deleteFileByUrl(url) {
  const key = fileKeyFromUrl(url);
  if (!key) return false;
  try {
    await utapi().deleteFiles(key);
    return true;
  } catch (error) {
    console.warn('⚠️ UploadThing delete failed:', error.message);
    return false;
  }
}

module.exports = { uploadFile, deleteFileByUrl, fileKeyFromUrl, isUploadThingUrl };
