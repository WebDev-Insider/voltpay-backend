const crypto = require('crypto');

function keyFromString(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;

  if (/^[0-9a-f]{64}$/i.test(v)) {
    return Buffer.from(v, 'hex');
  }

  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch (_) {}

  const utf = Buffer.from(v, 'utf8');
  if (utf.length === 32) return utf;

  return null;
}

function getEncryptionKey() {
  const key = keyFromString(process.env.STAFFPAY_ENCRYPTION_KEY) || keyFromString(process.env.JWT_SECRET);
  if (!key || key.length !== 32) {
    throw new Error('Missing/invalid STAFFPAY_ENCRYPTION_KEY. Provide 32 bytes (hex/base64/32-char string).');
  }
  return key;
}

function encryptString(plaintext) {
  const text = String(plaintext ?? '');
  const key = getEncryptionKey();

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptString(payload) {
  const raw = String(payload || '');
  const [ivB64, tagB64, ctB64] = raw.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Invalid encrypted payload');

  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = {
  encryptString,
  decryptString,
  keyFromString,
};
