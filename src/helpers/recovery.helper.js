const bip39 = require('bip39');
const { hashSecret, verifySecret } = require('./pii.helper');

// Verify-only secret, exactly like the PIN and the password: the plain phrase is
// handed to the user once at signup and never stored. Only the scrypt hash lives
// in the database, so a full database read cannot take over an account.
const RECOVERY_DOMAIN = 'recovery';
const WORD_COUNT = 12;

// 128 bits of entropy + 4-bit checksum = 132 bits = 12 words.
function generateRecoveryPhrase() {
  return bip39.generateMnemonic(128);
}

// BIP39 words are lowercase and single-space separated. Users retype the phrase
// on another device, so fold case and collapse whitespace before hashing or the
// same phrase would produce a different digest.
function normalizeRecoveryPhrase(input) {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Word count + BIP39 checksum. Rejects typos before they cost a verify attempt.
function isValidRecoveryPhrase(input) {
  const phrase = normalizeRecoveryPhrase(input);
  if (!phrase) return false;
  if (phrase.split(' ').length !== WORD_COUNT) return false;
  return bip39.validateMnemonic(phrase);
}

async function hashRecoveryPhrase(phrase) {
  return hashSecret(normalizeRecoveryPhrase(phrase), RECOVERY_DOMAIN);
}

async function verifyRecoveryPhrase(phrase, stored) {
  return verifySecret(normalizeRecoveryPhrase(phrase), stored, RECOVERY_DOMAIN);
}

module.exports = {
  RECOVERY_DOMAIN,
  WORD_COUNT,
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  isValidRecoveryPhrase,
  hashRecoveryPhrase,
  verifyRecoveryPhrase,
};
