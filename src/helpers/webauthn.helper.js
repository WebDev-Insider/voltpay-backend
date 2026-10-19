// WebAuthn (passkeys): fingerprint sign-in for the admin console.
//
// A passkey is a key pair made by the device's own authenticator - an Android
// fingerprint sensor, Touch ID / Face ID, Windows Hello. The private half
// never leaves the device and is only used after the fingerprint (or the
// device PIN) checks out; the server keeps the public half and checks
// signatures against it. Nothing biometric ever reaches this server - the
// fingerprint unlocks a key on the phone, and what arrives here is a
// signature over a one-time challenge.
//
// Written in-house on Node's crypto, like totp.helper, rather than pulled in
// as a package: it is a reader for three fixed byte formats (CBOR, COSE keys,
// WebAuthn authenticator data) plus signature checks Node already ships.
// test/adminWebauthn.test.js drives it with real ES256, Ed25519 and RS256 keys.
//
// Deliberately NOT done: attestation verification. Registration asks for
// `attestation: 'none'` - which make of phone holds the key does not matter,
// because registering only happens inside a session that has already proved
// the password, so the key belongs to that admin whatever made it.

const crypto = require('crypto');
const { parseOrigins } = require('./cors.helper');

// authenticatorData flag bits (WebAuthn §6.1).
const FLAG_UP = 0x01; // user present: somebody touched the device
const FLAG_UV = 0x04; // user verified: fingerprint / face / device PIN
const FLAG_BS = 0x10; // backed up: a synced passkey (iCloud Keychain, Google)
const FLAG_AT = 0x40; // attested credential data follows
const FLAG_ED = 0x80; // extensions follow

// COSE algorithm ids we accept, in the order offered to the browser.
const ALG_ES256 = -7;
const ALG_EDDSA = -8;
const ALG_RS256 = -257;
const ALGORITHMS = [ALG_ES256, ALG_EDDSA, ALG_RS256];

const CBOR_MAX_DEPTH = 16;

class WebAuthnError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => {
  throw new WebAuthnError(code);
};

const sha256 = data => crypto.createHash('sha256').update(data).digest();

const fromB64url = value => Buffer.from(String(value || ''), 'base64url');

// "https://admin.voltpay.ng" - a bare web origin, so `*` and stray paths in a
// shared list are skipped rather than trusted.
function isWebOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
  } catch (e) {
    return false;
  }
}

const hostOf = origin => new URL(origin).hostname;

/**
 * Where the dashboard lives. The device locks every passkey to one website's
 * hostname (its RP ID), and the server has to know that address from its own
 * configuration - never from the request, because "this passkey only works
 * on our site" is the whole of the anti-phishing guarantee.
 *
 * The address is ADMIN_WEBAUTHN_ORIGINS if set, otherwise CORS_ALLOWED_ORIGINS,
 * which already has to name the dashboard (VPS_DEPLOY.md) - so a server set up
 * by the checklist needs nothing new. That list may also name Flutter web, so
 * by default no single RP ID is pinned: the browser uses the page's own
 * hostname, and every signature is held to the hostname of the allow-listed
 * origin it came from. ADMIN_WEBAUTHN_RP_ID pins one instead (a parent domain
 * shared by several hosts).
 *
 * Returns `{ rpId, origins }`, rpId null when each page uses its own. Nothing
 * configured: off in production (null); the dashboard on localhost:3000 in
 * development.
 */
function relyingParty() {
  const rpId = String(process.env.ADMIN_WEBAUTHN_RP_ID || '').trim().toLowerCase() || null;
  let origins = parseOrigins(process.env.ADMIN_WEBAUTHN_ORIGINS || process.env.CORS_ALLOWED_ORIGINS).filter(isWebOrigin);

  if (!origins.length) {
    if (process.env.NODE_ENV === 'production') return null;
    origins = ['http://localhost:3000'];
  }

  // A browser refuses a pinned RP ID that is not the page's own host or a
  // parent of it, so a mismatch here could never work - say so at once
  // instead of failing every fingerprint with a signature-shaped error.
  if (rpId && !origins.every(origin => hostOf(origin) === rpId || hostOf(origin).endsWith(`.${rpId}`))) {
    console.error('❌ ADMIN_WEBAUTHN_RP_ID does not cover every dashboard origin - fingerprint sign-in is off');
    return null;
  }

  return { rpId, origins };
}

function generateChallenge() {
  return crypto.randomBytes(32).toString('base64url');
}

// ------------------------------------------------------------------ CBOR

/**
 * One CBOR item at `pos`. Covers what authenticators emit (RFC 8949 with the
 * CTAP2 canonical rules): no indefinite lengths and no floats, so meeting
 * either means the input is not an authenticator's and is refused.
 */
function readCbor(buf, pos, depth = 0) {
  if (depth > CBOR_MAX_DEPTH) fail('cbor_too_deep');
  if (pos >= buf.length) fail('cbor_truncated');

  const major = buf[pos] >> 5;
  const info = buf[pos] & 0x1f;
  let at = pos + 1;
  let arg;

  if (info < 24) arg = info;
  else if (info === 24) {
    if (at + 1 > buf.length) fail('cbor_truncated');
    arg = buf.readUInt8(at);
    at += 1;
  } else if (info === 25) {
    if (at + 2 > buf.length) fail('cbor_truncated');
    arg = buf.readUInt16BE(at);
    at += 2;
  } else if (info === 26) {
    if (at + 4 > buf.length) fail('cbor_truncated');
    arg = buf.readUInt32BE(at);
    at += 4;
  } else if (info === 27) {
    if (at + 8 > buf.length) fail('cbor_truncated');
    const big = buf.readBigUInt64BE(at);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('cbor_unsupported');
    arg = Number(big);
    at += 8;
  } else fail('cbor_unsupported');

  switch (major) {
    case 0:
      return { value: arg, pos: at };
    case 1:
      return { value: -1 - arg, pos: at };
    case 2:
    case 3: {
      if (at + arg > buf.length) fail('cbor_truncated');
      const bytes = buf.subarray(at, at + arg);
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), pos: at + arg };
    }
    case 4:
    case 5: {
      // Every item takes at least one byte, so a count past the end of the
      // buffer is a lie - refuse it before allocating anything for it.
      if (arg > buf.length - at) fail('cbor_truncated');
      const isMap = major === 5;
      const out = isMap ? new Map() : [];
      for (let i = 0; i < arg; i += 1) {
        const first = readCbor(buf, at, depth + 1);
        at = first.pos;
        if (isMap) {
          const second = readCbor(buf, at, depth + 1);
          at = second.pos;
          out.set(first.value, second.value);
        } else out.push(first.value);
      }
      return { value: out, pos: at };
    }
    case 6:
      // A tag: its content is the value.
      return readCbor(buf, at, depth + 1);
    default:
      if (info === 20) return { value: false, pos: at };
      if (info === 21) return { value: true, pos: at };
      if (info === 22) return { value: null, pos: at };
      return fail('cbor_unsupported');
  }
}

/** A whole buffer that must be exactly one CBOR item. */
function decodeCbor(buf) {
  const { value, pos } = readCbor(buf, 0);
  if (pos !== buf.length) fail('cbor_trailing');
  return value;
}

// ----------------------------------------------------- authenticator data

function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) fail('auth_data_short');

  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  let pos = 37;
  let attested = null;

  if (flags & FLAG_AT) {
    if (pos + 18 > buf.length) fail('auth_data_short');
    pos += 16; // AAGUID - which make of authenticator; not used, see the top
    const idLength = buf.readUInt16BE(pos);
    pos += 2;
    if (!idLength || pos + idLength > buf.length) fail('auth_data_short');
    const credentialId = Buffer.from(buf.subarray(pos, pos + idLength));
    pos += idLength;
    const key = readCbor(buf, pos);
    pos = key.pos;
    attested = { credentialId, cose: key.value };
  }

  if (flags & FLAG_ED) pos = readCbor(buf, pos).pos;
  if (pos !== buf.length) fail('auth_data_trailing');

  return { rpIdHash, flags, signCount, attested };
}

/** A COSE public key (a CBOR map with integer labels) as a Node KeyObject. */
function coseToPublicKey(cose) {
  if (!(cose instanceof Map)) fail('key_invalid');

  const kty = cose.get(1);
  const alg = cose.get(3);
  const b64 = label => {
    const value = cose.get(label);
    if (!Buffer.isBuffer(value) || !value.length) fail('key_invalid');
    return value.toString('base64url');
  };

  let jwk;
  if (kty === 2 && alg === ALG_ES256 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64(-2), y: b64(-3) };
  else if (kty === 1 && alg === ALG_EDDSA && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64(-2) };
  else if (kty === 3 && alg === ALG_RS256) jwk = { kty: 'RSA', n: b64(-1), e: b64(-2) };
  else fail('key_unsupported');

  try {
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
  } catch (e) {
    // Off-curve points and the like: Node refuses them, and so do we.
    return fail('key_invalid');
  }
}

// ------------------------------------------------------------ client data

function checkClientData(encoded, type, expectedChallenge, origins) {
  const raw = fromB64url(encoded);
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    fail('client_data_invalid');
  }
  if (!data || data.type !== type) fail('client_data_type');
  if (typeof data.challenge !== 'string' || !expectedChallenge || data.challenge !== expectedChallenge) {
    fail('challenge_mismatch');
  }
  if (!origins.includes(data.origin)) fail('origin_mismatch');
  // Asked for from inside another site's iframe.
  if (data.crossOrigin === true) fail('cross_origin');
  return { raw, origin: data.origin };
}

// The RP ID a signature must have been made for: the pinned one, or else the
// hostname of the (already allow-listed) page the browser says it came from.
const expectedRpIdHash = (rpId, origin) => sha256(rpId || hostOf(origin));

function checkFlags(flags) {
  if (!(flags & FLAG_UP)) fail('user_not_present');
  // UV is the fingerprint itself: a passkey used without it is a key used by
  // whoever is holding the phone.
  if (!(flags & FLAG_UV)) fail('user_not_verified');
}

// ---------------------------------------------------------------- ceremonies

/**
 * A new passkey, as navigator.credentials.create() returned it (binary fields
 * base64url). Returns what to store - never the private key, which the server
 * never sees.
 */
function verifyRegistration({ credential, expectedChallenge, rpId, origins }) {
  const response = credential?.response || {};
  if (credential?.type !== 'public-key') fail('credential_type');

  const clientData = checkClientData(response.clientDataJSON, 'webauthn.create', expectedChallenge, origins);

  const attestation = decodeCbor(fromB64url(response.attestationObject));
  if (!(attestation instanceof Map)) fail('attestation_invalid');

  const parsed = parseAuthData(attestation.get('authData'));
  if (!parsed.rpIdHash.equals(expectedRpIdHash(rpId, clientData.origin))) fail('rp_id_mismatch');
  checkFlags(parsed.flags);
  if (!parsed.attested) fail('no_credential');

  const credentialId = parsed.attested.credentialId.toString('base64url');
  // The id the browser reports has to be the one inside the signed-over data.
  if (credential.rawId && String(credential.rawId) !== credentialId) fail('credential_id_mismatch');

  const { key, alg } = coseToPublicKey(parsed.attested.cose);

  return {
    credentialId,
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    algorithm: alg,
    signCount: parsed.signCount,
    backedUp: Boolean(parsed.flags & FLAG_BS),
  };
}

/**
 * A sign-in, as navigator.credentials.get() returned it, checked against the
 * stored passkey `{ publicKey, algorithm, signCount, userHandle }`.
 */
function verifyAuthentication({ credential, expectedChallenge, rpId, origins, stored }) {
  const response = credential?.response || {};
  if (credential?.type !== 'public-key') fail('credential_type');

  const clientData = checkClientData(response.clientDataJSON, 'webauthn.get', expectedChallenge, origins);

  const authData = fromB64url(response.authenticatorData);
  const parsed = parseAuthData(authData);
  if (!parsed.rpIdHash.equals(expectedRpIdHash(rpId, clientData.origin))) fail('rp_id_mismatch');
  checkFlags(parsed.flags);

  // A discoverable passkey answers with the account it was made for.
  if (response.userHandle && String(response.userHandle) !== stored.userHandle) fail('user_handle_mismatch');

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: fromB64url(stored.publicKey), format: 'der', type: 'spki' });
    const signed = Buffer.concat([authData, sha256(clientData.raw)]);
    const signature = fromB64url(response.signature);

    if (stored.algorithm === ALG_ES256) ok = crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature);
    else if (stored.algorithm === ALG_RS256) ok = crypto.verify('sha256', signed, key, signature);
    else if (stored.algorithm === ALG_EDDSA) ok = crypto.verify(null, signed, key, signature);
  } catch (e) {
    ok = false;
  }
  if (!ok) fail('bad_signature');

  // A key that counts must keep counting up; one that went backwards may have
  // been copied. Synced passkeys always report 0 and are exempt.
  const before = Number(stored.signCount) || 0;
  if ((parsed.signCount > 0 || before > 0) && parsed.signCount <= before) fail('counter_regressed');

  return { signCount: parsed.signCount, backedUp: Boolean(parsed.flags & FLAG_BS) };
}

module.exports = {
  ALGORITHMS,
  WebAuthnError,
  relyingParty,
  generateChallenge,
  verifyRegistration,
  verifyAuthentication,
  __test: { decodeCbor, parseAuthData, coseToPublicKey, FLAG_UP, FLAG_UV, FLAG_BS, FLAG_AT, FLAG_ED },
};
