// RFC 6238 TOTP, over node's own crypto. No new package: HMAC-SHA1 is in the
// stdlib and base32 is twenty lines, which is less code than auditing a
// dependency that sits on the admin login path.
//
// SHA-1 here is not a security shortcut - it is what every authenticator app
// implements, and HMAC-SHA1 is unbroken. The secret is 20 random bytes and the
// code is dead 30 seconds later.
//
// The secret is stored encrypted (totp_secret_enc), never hashed: a TOTP secret
// has to be readable to check the next code, so it is operational data, not a
// verify-only secret. Same distinction as email vs PIN.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side. Phone clocks drift; two steps would double the window
// an attacker gets for a stolen code.
const DRIFT_STEPS = 1;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('totp: invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes, base32 encoded - the length RFC 4226 recommends for SHA-1. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buf).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset, so an
  // attacker cannot predict which 4 bytes of the digest become the code.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentCode(secret, now = Date.now()) {
  return codeAt(secret, Math.floor(now / 1000 / STEP_SECONDS));
}

/**
 * Constant-time compare across the drift window. Returns false for anything
 * unparseable rather than throwing, so a corrupt secret column can never
 * authenticate.
 */
function verifyToken(secret, token, now = Date.now()) {
  const candidate = String(token || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(candidate)) return false;

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const presented = Buffer.from(candidate, 'utf8');

  let matched = false;
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    let expected;
    try {
      expected = Buffer.from(codeAt(secret, counter + drift), 'utf8');
    } catch (e) {
      return false;
    }
    // No early break: the loop always runs the full window so a match on the
    // first step is not distinguishable by timing from a match on the last.
    if (expected.length === presented.length && crypto.timingSafeEqual(expected, presented)) matched = true;
  }
  return matched;
}

/**
 * The string an authenticator app scans. `issuer` shows as the account label.
 *
 * Built by hand, not with URLSearchParams: that encodes a space as `+`
 * (form encoding), and an authenticator reads the query as a URI, so the issuer
 * arrives as the literal "VoltPay+Admin" and no longer matches the "VoltPay
 * Admin:" prefix on the label. Apps that check the two agree reject the URI.
 */
function otpauthUri({ secret, account, issuer = 'VoltPay Admin' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = [
    ['secret', secret],
    ['issuer', issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(DIGITS)],
    ['period', String(STEP_SECONDS)],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `otpauth://totp/${label}?${params}`;
}

module.exports = {
  generateSecret,
  currentCode,
  verifyToken,
  otpauthUri,
  STEP_SECONDS,
  DIGITS,
  __test: { base32Encode, base32Decode, codeAt },
};
