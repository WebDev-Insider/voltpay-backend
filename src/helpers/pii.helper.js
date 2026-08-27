/**
 * PII protection helper.
 *
 * No user data is stored in plain text. Two mechanisms, chosen by whether the
 * value ever has to be read back:
 *
 *   1. Verify-only secrets (PIN, password, recovery phrase)
 *      -> hashSecret() / verifySecret(). One-way, unrecoverable.
 *         pepper (keyed Blake3, key lives in env not DB) + per-record random
 *         salt + scrypt (memory-hard). A bare hash is not enough for a 4-digit
 *         PIN: 10^4 candidates fall instantly to a GPU. scrypt is what makes a
 *         leaked column useless.
 *
 *   2. Operational PII (email, mobile, names, address, state, city, zip)
 *      -> protect() / reveal() + blindIndex(). AES-256-GCM ciphertext at rest,
 *         plus a keyed deterministic index so we can still look up and enforce
 *         uniqueness without ever storing the plain value. You cannot email a
 *         hash or file a CBN/KYC report against one, so these must stay
 *         recoverable - encryption, not hashing, is the control that keeps them
 *         out of plain text.
 *
 * Keys (both required, 32 bytes as hex / base64 / 32-char string):
 *   PII_HASH_KEY  - pepper + blind index key. Rotating it invalidates every
 *                   blind index and every secret hash, so treat as permanent.
 *   PII_ENC_KEY   - AES-256-GCM key for the ciphertext columns.
 * Keep them distinct from JWT_SECRET: a leaked signing key must not also
 * decrypt the user table.
 *
 * Digest: Blake3 in keyed mode (@noble/hashes, audited, zero-dependency).
 * Keyed mode is a native part of the BLAKE3 spec, so it is a PRF directly -
 * no HMAC construction wrapped around it. Every stored hash carries
 * HASH_VERSION, so the primitive can be swapped again without locking anyone
 * out: add a branch to verifySecret and let needsRehash upgrade rows on login.
 */

const crypto = require('crypto');
const { blake3 } = require('@noble/hashes/blake3.js');
const { keyFromString } = require('./encryption.helper');

const HASH_VERSION = 'b3v1';
const LEGACY_HASH_VERSION = 'b2b1'; // keyed blake2b512, pre-2026-08-02
const SALT_BYTES = 16;
const SCRYPT_KEYLEN = 32;
// N=2^15 ~ 32MB per hash. Raise if login latency budget allows.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function requireKey(envName) {
  const key = keyFromString(process.env[envName]);
  if (!key || key.length !== 32) {
    throw new Error(`Missing/invalid ${envName}. Provide 32 bytes (hex/base64/32-char string).`);
  }
  return key;
}

/**
 * Keyed Blake3 over domain || 0x00 || value. The domain separator is what stops
 * a PIN hash from ever validating as a password, or an email index from
 * colliding with a username index.
 */
function pepper(value, domain) {
  const input = Buffer.concat([
    Buffer.from(String(domain || 'default'), 'utf8'),
    Buffer.from([0]),
    Buffer.from(String(value ?? ''), 'utf8'),
  ]);
  return Buffer.from(blake3(input, { key: requireKey('PII_HASH_KEY') }));
}

/** Pre-Blake3 pepper. Only used to verify (and then upgrade) legacy rows. */
function legacyPepper(value, domain) {
  return crypto
    .createHmac('blake2b512', requireKey('PII_HASH_KEY'))
    .update(String(domain || 'default'))
    .update('\x00')
    .update(String(value ?? ''), 'utf8')
    .digest();
}

/**
 * Canonical form of a value before it is indexed, so the same real-world
 * identity always produces the same blind index regardless of how it was typed.
 */
function normalize(value, domain) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  switch (domain) {
    case 'email':
    case 'username':
      return v.toLowerCase();
    case 'mobile':
      return v.replace(/\D/g, '');
    case 'name':
    case 'address':
    case 'state':
    case 'city':
      return v.toLowerCase().replace(/\s+/g, ' ');
    case 'zip':
      return v.toUpperCase().replace(/\s+/g, '');
    default:
      return v;
  }
}

/**
 * One account, one string - for *counting* against an account, never for
 * indexing one.
 *
 * `normalize(v, 'mobile')` strips punctuation but keeps the digits it was
 * given, so 0803xxxxxxx, 803xxxxxxx and 234803xxxxxxx stay three different
 * values. That is correct for `mobile_idx`, where each accepted variant is
 * indexed separately so any of them finds the record - but it is wrong for
 * anything that counts attempts, because a lookup treats all three as one
 * account while the counter treats them as three. An attacker just re-types
 * the number and gets a fresh budget:
 *
 *   0803 1234567  -> 3 login attempts
 *   8031234567    -> 3 more
 *   2348031234567 -> 3 more
 *
 * The last ten digits are what every Nigerian form shares, so that is the
 * bucket. Non-NG numbers keep their digits, matching the single exact variant
 * buildMobileWhereForCountry looks them up by.
 *
 * NEVER use this for a `*_idx` column. The blind indexes are already written;
 * changing what feeds them means every lookup misses until a full
 * `scripts/backfill-pii.js --reindex`, which is a login outage.
 */
function canonicalMobile(country, value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (String(country ?? '').trim().toUpperCase() !== 'NG') return digits;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Deterministic keyed digest for equality lookups on encrypted columns.
 * Deterministic by necessity - equal inputs give equal output, so an attacker
 * holding the index can tell two users share a value, but cannot invert it
 * without PII_HASH_KEY.
 */
function blindIndex(value, domain) {
  const norm = normalize(value, domain);
  if (!norm) return null;
  return pepper(norm, `idx:${domain}`).toString('hex').slice(0, 64);
}

/**
 * scrypt costs ~75ms of CPU. Always use the async form: the sync one would
 * block the event loop for that whole time, so concurrent logins would queue
 * behind each other and stall every other request on the process.
 */
function scrypt(input, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, salt, keylen, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** One-way hash for values that are only ever compared, never read back. */
async function hashSecret(plaintext, domain = 'secret') {
  const value = String(plaintext ?? '');
  if (!value) throw new Error('hashSecret: empty value');
  const salt = crypto.randomBytes(SALT_BYTES);
  const digest = await scrypt(pepper(value, domain), salt, SCRYPT_KEYLEN);
  return `${HASH_VERSION}$${salt.toString('base64')}$${digest.toString('base64')}`;
}

/**
 * Constant-time verify. Returns false for anything unparseable rather than
 * throwing, so a malformed column can never authenticate.
 *
 * Legacy bcrypt hashes still verify (existing users must not be locked out) and
 * are reported via needsRehash so callers can upgrade the record on next login.
 */
async function verifySecret(plaintext, stored, domain = 'secret') {
  const value = String(plaintext ?? '');
  const raw = String(stored ?? '');
  if (!value || !raw) return { ok: false, needsRehash: false };

  const version = raw.startsWith(`${HASH_VERSION}$`)
    ? HASH_VERSION
    : raw.startsWith(`${LEGACY_HASH_VERSION}$`)
      ? LEGACY_HASH_VERSION
      : null;

  if (version) {
    const [, saltB64, digestB64] = raw.split('$');
    if (!saltB64 || !digestB64) return { ok: false, needsRehash: false };
    try {
      const expected = Buffer.from(digestB64, 'base64');
      const peppered = version === HASH_VERSION ? pepper(value, domain) : legacyPepper(value, domain);
      const actual = await scrypt(peppered, Buffer.from(saltB64, 'base64'), expected.length);
      const ok = crypto.timingSafeEqual(expected, actual);
      return { ok, needsRehash: ok && version !== HASH_VERSION };
    } catch (_) {
      return { ok: false, needsRehash: false };
    }
  }

  if (/^\$2[aby]?\$/.test(raw)) {
    const bcrypt = require('bcryptjs');
    const ok = await bcrypt.compare(value, raw);
    return { ok, needsRehash: ok };
  }

  // Anything else is a plain-text leftover. Never accept it - a row that was
  // written before this rule existed must go through recovery, not walk in on
  // a string compare.
  return { ok: false, needsRehash: false };
}

function encryptValue(plaintext) {
  const text = String(plaintext ?? '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', requireKey('PII_ENC_KEY'), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptValue(payload) {
  const raw = String(payload ?? '');
  if (!raw) return '';
  const [ivB64, tagB64, ctB64] = raw.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireKey('PII_ENC_KEY'), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Free-text columns that may embed someone's name or number - the ledger's
 * `details` and `other_data.subtitle` are the ones that matter. They are not
 * looked up, only displayed, so they need no blind index.
 *
 * The tag makes the two readable apart: rows written before this rule stay
 * plain and still render, and a value is only decrypted when we put it there.
 */
const TEXT_PREFIX = 'enc:v1:';

function protectText(value) {
  const v = String(value ?? '');
  return v ? TEXT_PREFIX + encryptValue(v) : v;
}

function revealText(value) {
  const v = String(value ?? '');
  if (!v.startsWith(TEXT_PREFIX)) return v;
  try {
    return decryptValue(v.slice(TEXT_PREFIX.length));
  } catch (e) {
    console.error('❌ Failed to decrypt ledger text:', e?.message || e);
    return '';
  }
}

// Columns that must never reach a client: the verify-only hashes, the raw
// ciphertext/index columns, and the balance MAC.
// `recovery_hash` and `biometric_hash` are listed by their real column names.
// The older `recovery_phrase` entry never matched a column - the row has no
// such field - so any caller that selected the hash alongside publicUser would
// have shipped it. Nothing did, and now nothing can.
const NEVER_EXPOSE =
  /^(password|pin|recovery_phrase|recovery_hash|biometric_hash|balance_mac|active_session_id)$|_enc$|_idx$/;

/**
 * Whole user row, safe to spread into a response: secrets dropped, PII
 * decrypted back to the field names the app already sends.
 * Use this instead of `...user` - a bare spread ships the password hash.
 */
function publicUser(user) {
  if (!user) return null;
  const out = {};
  for (const [key, value] of Object.entries(user)) {
    if (NEVER_EXPOSE.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...revealUserFields(user) };
}

/**
 * The `pn` field: does this account have a transaction PIN?
 *
 * Reads `has_pin` first because a row that came from `req.user` has been
 * through userCache.service, which nulls `pin` and leaves that boolean in its
 * place. A plain `row.pin ? '1' : '0'` therefore answers "no PIN" for every
 * account that has one - and the app writes its local flag from this field, so
 * the user gets sent to Security to set a PIN they already set.
 */
function pinFlag(row) {
  const has = row && row.has_pin !== undefined ? row.has_pin : Boolean(row && row.pin);
  return has ? '1' : '0';
}

/**
 * Decrypt a walletTransaction row's display strings for an API response.
 * Returns `{ details, other_data }` ready to spread over the mapped row.
 */
function revealLedgerText(row) {
  const other = row?.other_data && typeof row.other_data === 'object' ? { ...row.other_data } : {};
  if (other.subtitle) other.subtitle = revealText(other.subtitle);
  return { details: revealText(row?.details || ''), other_data: other };
}

/** Encrypt + index in one step. Returns the pair of column values to store. */
function protect(value, domain) {
  const v = String(value ?? '').trim();
  if (!v) return { enc: null, idx: null };
  return { enc: encryptValue(v), idx: blindIndex(v, domain) };
}

/** Read a protected column back. Returns '' when unset; throws if tampered. */
function reveal(enc) {
  if (enc === null || enc === undefined || enc === '') return '';
  return decryptValue(enc);
}

/**
 * Balance stays a numeric column: it must support atomic SQL arithmetic
 * (`balance: { increment }` inside prisma.$transaction). Hashing or encrypting
 * it would break every money path and force read-modify-write, which is how
 * concurrent credits get lost. Instead it is tamper-evident - any direct DB
 * edit that does not also forge this MAC is detectable.
 */
function balanceMac(ownerKey, balance) {
  return pepper(`${String(ownerKey)}:${String(balance)}`, 'balance').toString('base64');
}

function verifyBalanceMac(ownerKey, balance, mac) {
  if (!mac) return false;
  const expected = Buffer.from(balanceMac(ownerKey, balance), 'base64');
  const actual = Buffer.from(String(mac), 'base64');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// The User columns that are stored encrypted, and the blind-index domain each
// one uses. Add a field here and both helpers below pick it up.
const USER_PII_FIELDS = {
  firstname: 'name',
  lastname: 'name',
  username: 'username',
  email: 'email',
  mobile: 'mobile',
  address: 'address',
  state: 'state',
  city: 'city',
  zip: 'zip',
};

// Only these get a blind index - the rest are never looked up by value.
const USER_INDEXED_FIELDS = new Set(['username', 'email', 'mobile']);

/**
 * Turn a plain { firstname, email, mobile, ... } patch into the protected
 * columns to write. Plain columns are explicitly nulled so a create or update
 * can never leave a plain-text value behind.
 */
function protectUserFields(input = {}) {
  const data = {};
  for (const [field, domain] of Object.entries(USER_PII_FIELDS)) {
    if (!(field in input)) continue;
    const { enc, idx } = protect(input[field], domain);
    data[`${field}_enc`] = enc;
    if (USER_INDEXED_FIELDS.has(field)) data[`${field}_idx`] = idx;
    data[field] = null;
  }
  return data;
}

/**
 * Decrypt a user row for a response. Falls back to the plain column while it
 * still exists so reads keep working mid-migration; returns '' once dropped.
 */
function revealUserFields(user) {
  if (!user) return {};
  const out = {};
  for (const field of Object.keys(USER_PII_FIELDS)) {
    const enc = user[`${field}_enc`];
    if (enc) {
      try {
        out[field] = reveal(enc);
        continue;
      } catch (e) {
        console.error(`❌ Failed to decrypt ${field} for user ${user.id}:`, e?.message || e);
        out[field] = '';
        continue;
      }
    }
    out[field] = user[field] ?? '';
  }
  return out;
}

module.exports = {
  normalize,
  canonicalMobile,
  blindIndex,
  protectUserFields,
  revealUserFields,
  publicUser,
  pinFlag,
  USER_PII_FIELDS,
  USER_INDEXED_FIELDS,
  hashSecret,
  verifySecret,
  protect,
  reveal,
  encryptValue,
  decryptValue,
  protectText,
  revealText,
  revealLedgerText,
  balanceMac,
  verifyBalanceMac,
  HASH_VERSION,
};
