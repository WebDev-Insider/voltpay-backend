// Single place the API talks to UploadThing. Multer keeps files in memory
// (upload.middleware.js), so everything here starts from a Buffer.
//
// UploadThing is storage only - unlike the CDN it replaced there is no
// server-side resize/crop, so the size ceiling is the multer limit and the app
// is what downscales before sending.
const { UTApi } = require('uploadthing/server');
const { envValue } = require('./env.helper');

let client = null;

// UploadThing v7 decodes the token with Effect's Schema.Uint8ArrayFromBase64,
// which is a STRICT RFC 4648 decoder - a stray quote, a space or a dropped `=`
// makes it throw. Node's own `Buffer.from(t, 'base64')` silently ignores those
// characters and decodes anyway, so "it decodes fine locally" proves nothing.
// That gap is the whole bug: the token looks valid to every obvious check and
// still fails at the vendor.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Why a token is unusable, phrased so the log says what to fix. Returns null
 * when the token is well formed. Never returns the token or any part of it -
 * it carries the account's apiKey.
 */
function describeTokenProblem(token) {
  if (!BASE64.test(token)) {
    return 'it contains characters that are not base64 - usually a wrapping quote, a space or a newline';
  }
  if (token.length % 4 !== 0) {
    return 'its length is not a multiple of 4 - the trailing "=" padding was probably dropped';
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return 'it is base64 but does not decode to JSON - check it is the v7 token, not a legacy sk_live secret';
  }
  const shaped =
    parsed &&
    typeof parsed.apiKey === 'string' &&
    typeof parsed.appId === 'string' &&
    Array.isArray(parsed.regions);
  return shaped ? null : 'it decodes to JSON but is not { apiKey, appId, regions[] }';
}

function utapi() {
  if (client) return client;

  // envValue trims and unquotes, so a token pasted into Render with the quotes
  // from its .env line now works rather than failing on every upload.
  const token = envValue('UPLOADTHING_TOKEN');
  if (!token) {
    throw new Error('UPLOADTHING_TOKEN is not set');
  }

  // Checked here rather than left to the SDK: UploadThing raises the same
  // "Invalid token" for every cause, and support.controller swallows it per
  // file, so the log said an attachment failed but never said why.
  const problem = describeTokenProblem(token);
  if (problem) {
    throw new Error(
      `UPLOADTHING_TOKEN is malformed - ${problem}. Re-copy the v7 token from the ` +
        'UploadThing dashboard and paste it with no surrounding quotes and no trailing space.'
    );
  }

  client = new UTApi({ token });
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

module.exports = {
  uploadFile,
  deleteFileByUrl,
  fileKeyFromUrl,
  isUploadThingUrl,
  // Exported for test/upload.helper.test.js - the token shapes are what broke.
  describeTokenProblem,
};
