/**
 * A pretend WebAuthn authenticator, for the admin fingerprint tests.
 *
 * There is no phone in a test, so this plays one: real ES256 / Ed25519 /
 * RS256 key pairs, and authenticatorData, attestation objects and
 * clientDataJSON built byte for byte the way a device builds them. What it
 * signs, webauthn.helper has to verify exactly as it would a phone's.
 *
 * Not a test itself - required by adminWebauthn.test.js and
 * adminPasskeyFlow.test.js.
 */

const crypto = require('crypto');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const b64 = buf => Buffer.from(buf).toString('base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest();

// --- a minimal CBOR encoder: what an authenticator writes ----------------
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    return Buffer.concat([cborHead(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error(`cbor: cannot encode ${typeof value}`);
}

/** A device with one key. `alg` is the COSE id: -7, -8 or -257. */
function makeAuthenticator(alg = -7) {
  let keys;
  let cose;
  const field = (jwk, name) => Buffer.from(jwk[name], 'base64url');

  if (alg === -7) {
    keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, field(jwk, 'x')], [-3, field(jwk, 'y')]]);
  } else if (alg === -8) {
    keys = crypto.generateKeyPairSync('ed25519');
    const jwk = keys.publicKey.export({ format: 'jwk' });
    cose = new Map([[1, 1], [3, -8], [-1, 6], [-2, field(jwk, 'x')]]);
  } else {
    keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    cose = new Map([[1, 3], [3, -257], [-1, field(jwk, 'n')], [-2, field(jwk, 'e')]]);
  }

  const sign = data => {
    if (alg === -7) return crypto.sign('sha256', data, { key: keys.privateKey, dsaEncoding: 'der' });
    if (alg === -8) return crypto.sign(null, data, keys.privateKey);
    return crypto.sign('sha256', data, keys.privateKey);
  };

  return { alg, credentialId: crypto.randomBytes(16), cose, sign };
}

function authData({ rpId, flags, counter = 0, attested = null }) {
  const head = Buffer.alloc(37);
  sha256(rpId).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter, 33);
  if (!attested) return head;
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(attested.credentialId.length);
  return Buffer.concat([head, Buffer.alloc(16), idLength, attested.credentialId, cbor(attested.cose)]);
}

const clientData = ({ type, challenge, origin, crossOrigin = false }) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }), 'utf8');

/** What navigator.credentials.create() hands back, binary fields as base64url. */
function register(auth, opts) {
  const { challenge, rpId, origin, type = 'webauthn.create', flags = FLAG_UP | FLAG_UV | FLAG_AT, crossOrigin } = opts;
  const attestationObject = cbor(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      // Like a real authenticator: no AT flag, no key bytes.
      ['authData', authData({ rpId, flags, attested: flags & FLAG_AT ? auth : null })],
    ])
  );
  return {
    id: b64(auth.credentialId),
    rawId: opts.rawId || b64(auth.credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64(clientData({ type, challenge, origin, crossOrigin })),
      attestationObject: b64(attestationObject),
    },
  };
}

/** What navigator.credentials.get() hands back. `signer` signs as another key; `tamper` edits authData after signing. */
function signIn(auth, opts) {
  const { challenge, rpId, origin, type = 'webauthn.get', flags = FLAG_UP | FLAG_UV, counter = 0, userHandle } = opts;
  const cd = clientData({ type, challenge, origin });
  const ad = authData({ rpId, flags, counter });
  const signature = (opts.signer || auth).sign(Buffer.concat([ad, sha256(cd)]));
  return {
    id: b64(auth.credentialId),
    rawId: b64(auth.credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64(cd),
      authenticatorData: b64(opts.tamper ? opts.tamper(ad) : ad),
      signature: b64(signature),
      userHandle,
    },
  };
}

module.exports = { b64, cbor, makeAuthenticator, register, signIn, FLAG_UP, FLAG_UV, FLAG_BS, FLAG_AT };
