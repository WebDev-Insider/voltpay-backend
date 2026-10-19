/**
 * Self-check for admin fingerprint sign-in (webauthn.helper).
 *
 * There is no phone here, so the test plays the authenticator: it makes real
 * ES256, Ed25519 and RS256 key pairs, builds authenticatorData, attestation
 * objects and clientDataJSON byte for byte the way a device does, and signs
 * them. Then every check the server makes is broken in turn and has to fail.
 *
 * Run: node test/adminWebauthn.test.js
 */

const assert = require('assert');
const crypto = require('crypto');

const webauthn = require('../src/helpers/webauthn.helper');
const fake = require('./fakeAuthenticator');

const { FLAG_UP, FLAG_UV, FLAG_BS, FLAG_AT } = webauthn.__test;
const { b64, makeAuthenticator } = fake;
const RP_ID = 'admin.voltpay.test';
const ORIGIN = 'https://admin.voltpay.test';
const ORIGINS = [ORIGIN];

// The device, pointed at this test's dashboard unless a case says otherwise.
const register = (auth, opts) => fake.register(auth, { rpId: RP_ID, origin: ORIGIN, ...opts });
const signIn = (auth, opts) => fake.signIn(auth, { rpId: RP_ID, origin: ORIGIN, ...opts });

function rejects(fn, code, label) {
  assert.throws(fn, e => e instanceof webauthn.WebAuthnError && e.code === code, `${label}: expected ${code}`);
}

async function main() {
  const rp = { rpId: RP_ID, origins: ORIGINS };

  // --- the happy path, for every algorithm we offer -----------------------
  for (const alg of webauthn.ALGORITHMS) {
    const auth = makeAuthenticator(alg);
    const regChallenge = webauthn.generateChallenge();
    const stored = webauthn.verifyRegistration({ credential: register(auth, { challenge: regChallenge }), expectedChallenge: regChallenge, ...rp });

    assert.strictEqual(stored.credentialId, b64(auth.credentialId), `alg ${alg}: credential id`);
    assert.strictEqual(stored.algorithm, alg, `alg ${alg}: algorithm`);
    assert.strictEqual(stored.signCount, 0, `alg ${alg}: counter`);

    const handle = b64(crypto.randomBytes(32));
    const loginChallenge = webauthn.generateChallenge();
    const result = webauthn.verifyAuthentication({
      credential: signIn(auth, { challenge: loginChallenge, userHandle: handle }),
      expectedChallenge: loginChallenge,
      ...rp,
      stored: { publicKey: stored.publicKey, algorithm: stored.algorithm, signCount: 0, userHandle: handle },
    });
    assert.strictEqual(result.signCount, 0, `alg ${alg}: synced passkey keeps counter 0`);
  }

  // --- registration: every check has to bite ------------------------------
  const auth = makeAuthenticator(-7);
  const challenge = webauthn.generateChallenge();
  const reg = opts => () =>
    webauthn.verifyRegistration({ credential: register(auth, { challenge, ...opts }), expectedChallenge: challenge, ...rp });

  rejects(reg({ challenge: webauthn.generateChallenge() }), 'challenge_mismatch', 'replayed registration');
  rejects(reg({ origin: 'https://admin.voltpay.test.evil.com' }), 'origin_mismatch', 'look-alike origin');
  rejects(reg({ type: 'webauthn.get' }), 'client_data_type', 'a sign-in passed off as a registration');
  rejects(reg({ crossOrigin: true }), 'cross_origin', 'from inside another site');
  rejects(reg({ rpId: 'voltpay.evil' }), 'rp_id_mismatch', 'a key made for another site');
  rejects(reg({ flags: FLAG_UP | FLAG_AT }), 'user_not_verified', 'no fingerprint');
  rejects(reg({ flags: FLAG_UV | FLAG_AT }), 'user_not_present', 'nobody touched it');
  rejects(reg({ flags: FLAG_UP | FLAG_UV }), 'no_credential', 'no key in the response');
  rejects(reg({ rawId: b64(crypto.randomBytes(16)) }), 'credential_id_mismatch', 'swapped credential id');

  // A P-384 key is real but not one we offered.
  const p384 = new Map([[1, 2], [3, -35], [-1, 2], [-2, crypto.randomBytes(48)], [-3, crypto.randomBytes(48)]]);
  rejects(
    () => webauthn.verifyRegistration({ credential: register({ ...auth, cose: p384 }, { challenge }), expectedChallenge: challenge, ...rp }),
    'key_unsupported',
    'unsupported algorithm'
  );

  // A P-256 "key" that is not on the curve.
  const offCurve = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 2)]]);
  rejects(
    () => webauthn.verifyRegistration({ credential: register({ ...auth, cose: offCurve }, { challenge }), expectedChallenge: challenge, ...rp }),
    'key_invalid',
    'point off the curve'
  );

  // --- sign-in: every check has to bite -----------------------------------
  const good = webauthn.verifyRegistration({ credential: register(auth, { challenge }), expectedChallenge: challenge, ...rp });
  const handle = b64(crypto.randomBytes(32));
  const login = webauthn.generateChallenge();
  const stored = { publicKey: good.publicKey, algorithm: good.algorithm, signCount: 0, userHandle: handle };
  const verify = (opts, storedOverride = {}) => () =>
    webauthn.verifyAuthentication({
      credential: signIn(auth, { challenge: login, userHandle: handle, ...opts }),
      expectedChallenge: login,
      ...rp,
      stored: { ...stored, ...storedOverride },
    });

  assert.ok(verify({})(), 'the genuine sign-in passes');
  rejects(verify({ challenge: webauthn.generateChallenge() }), 'challenge_mismatch', 'replayed sign-in');
  rejects(verify({ origin: 'https://evil.example' }), 'origin_mismatch', 'phishing origin');
  rejects(verify({ type: 'webauthn.create' }), 'client_data_type', 'registration passed off as sign-in');
  rejects(verify({ rpId: 'evil.example' }), 'rp_id_mismatch', 'assertion for another site');
  rejects(verify({ flags: FLAG_UP }), 'user_not_verified', 'no fingerprint at sign-in');
  rejects(verify({ userHandle: b64(crypto.randomBytes(32)) }), 'user_handle_mismatch', 'someone else\'s passkey');
  rejects(verify({ signer: makeAuthenticator(-7) }), 'bad_signature', 'signed by a different key');
  // Alter the counter after signing: the signature covers every byte of it.
  rejects(
    verify({ tamper: ad => Buffer.concat([ad.subarray(0, 36), Buffer.from([ad[36] ^ 1])]) }),
    'bad_signature',
    'authenticator data altered after signing'
  );

  // Counters: a counting key must count up; a copy that goes back is refused.
  assert.strictEqual(verify({ counter: 6 }, { signCount: 5 })().signCount, 6, 'counter moved forward');
  rejects(verify({ counter: 5 }, { signCount: 5 }), 'counter_regressed', 'counter did not move');
  rejects(verify({ counter: 0 }, { signCount: 5 }), 'counter_regressed', 'counter reset to zero');
  assert.ok(verify({ flags: FLAG_UP | FLAG_UV | FLAG_BS })().backedUp, 'synced passkey reported as backed up');

  // --- CBOR: hostile input fails cleanly ----------------------------------
  const { decodeCbor } = webauthn.__test;
  rejects(() => decodeCbor(Buffer.from([0x5f, 0x41, 0x00, 0xff])), 'cbor_unsupported', 'indefinite length');
  rejects(() => decodeCbor(Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff])), 'cbor_truncated', 'count larger than the input');
  rejects(() => decodeCbor(Buffer.from([0x01, 0x02])), 'cbor_trailing', 'trailing bytes');
  rejects(() => decodeCbor(Buffer.concat([Buffer.alloc(20, 0x81), Buffer.from([0x00])])), 'cbor_too_deep', 'deep nesting');
  rejects(() => decodeCbor(Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0])), 'cbor_unsupported', 'a float');
  rejects(() => decodeCbor(Buffer.from([0x58])), 'cbor_truncated', 'a length byte that never comes');

  // --- configuration -------------------------------------------------------
  const KEYS = ['NODE_ENV', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGINS', 'CORS_ALLOWED_ORIGINS'];
  const withEnv = (vars, fn) => {
    const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
  const quiet = fn => {
    const original = console.error;
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.error = original;
    }
  };

  assert.strictEqual(withEnv({ NODE_ENV: 'production' }, webauthn.relyingParty), null, 'off in production until configured');
  assert.deepStrictEqual(
    withEnv({ NODE_ENV: 'development' }, webauthn.relyingParty),
    { rpId: null, origins: ['http://localhost:3000'] },
    'localhost in development'
  );

  // Nothing new to set: the CORS allowlist already names the dashboard.
  assert.deepStrictEqual(
    withEnv(
      { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://voltpay-dashboard.vercel.app, https://app.voltpay.ng/' },
      webauthn.relyingParty
    ),
    { rpId: null, origins: ['https://voltpay-dashboard.vercel.app', 'https://app.voltpay.ng'] },
    'falls back to CORS_ALLOWED_ORIGINS, each page using its own hostname'
  );
  assert.deepStrictEqual(
    withEnv(
      { CORS_ALLOWED_ORIGINS: 'https://app.voltpay.ng', ADMIN_WEBAUTHN_ORIGINS: 'https://voltpay-dashboard.vercel.app' },
      webauthn.relyingParty
    ).origins,
    ['https://voltpay-dashboard.vercel.app'],
    'ADMIN_WEBAUTHN_ORIGINS wins over the CORS list'
  );
  assert.strictEqual(
    withEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' }, webauthn.relyingParty),
    null,
    'a wildcard is not an address - never trusted as one'
  );
  assert.deepStrictEqual(
    withEnv({ CORS_ALLOWED_ORIGINS: 'https://admin.voltpay.ng/login, https://admin.voltpay.ng' }, webauthn.relyingParty).origins,
    ['https://admin.voltpay.ng'],
    'an entry with a path is skipped'
  );
  assert.deepStrictEqual(
    withEnv({ ADMIN_WEBAUTHN_RP_ID: 'Admin.VoltPay.ng', ADMIN_WEBAUTHN_ORIGINS: 'https://admin.voltpay.ng/' }, webauthn.relyingParty),
    { rpId: 'admin.voltpay.ng', origins: ['https://admin.voltpay.ng'] },
    'normalised: lower-case RP ID, no trailing slash'
  );
  assert.ok(
    withEnv({ ADMIN_WEBAUTHN_RP_ID: 'voltpay.ng', ADMIN_WEBAUTHN_ORIGINS: 'https://admin.voltpay.ng' }, webauthn.relyingParty),
    'a parent domain is a valid RP ID'
  );
  assert.strictEqual(
    quiet(() => withEnv({ ADMIN_WEBAUTHN_RP_ID: 'admin.voltpay.ng', ADMIN_WEBAUTHN_ORIGINS: 'https://evil.com' }, webauthn.relyingParty)),
    null,
    'an origin outside the RP ID is a misconfiguration'
  );
  assert.deepStrictEqual(
    withEnv({ ADMIN_WEBAUTHN_ORIGINS: 'https://admin.voltpay.ng' }, webauthn.relyingParty),
    { rpId: null, origins: ['https://admin.voltpay.ng'] },
    'origins alone are enough - the RP ID is each page\'s own hostname'
  );

  // --- no pinned RP ID: each signature is held to its own page -------------
  // Two allowed sites, as when the CORS list names the dashboard and Flutter
  // web. A passkey made for one must never pass as coming from the other.
  const shared = { rpId: null, origins: [ORIGIN, 'https://app.voltpay.test'] };
  const own = makeAuthenticator(-7);
  const ownChallenge = webauthn.generateChallenge();
  const ownKey = webauthn.verifyRegistration({ credential: register(own, { challenge: ownChallenge }), expectedChallenge: ownChallenge, ...shared });
  const ownStored = { publicKey: ownKey.publicKey, algorithm: ownKey.algorithm, signCount: 0, userHandle: handle };
  const ownLogin = webauthn.generateChallenge();
  const ownVerify = opts => () =>
    webauthn.verifyAuthentication({
      credential: signIn(own, { challenge: ownLogin, userHandle: handle, ...opts }),
      expectedChallenge: ownLogin,
      ...shared,
      stored: ownStored,
    });

  assert.ok(ownVerify({})(), 'a passkey made on the dashboard signs in on the dashboard');
  rejects(
    ownVerify({ origin: 'https://app.voltpay.test' }),
    'rp_id_mismatch',
    'a dashboard passkey presented as if from the other allowed site'
  );
  rejects(
    () =>
      webauthn.verifyRegistration({
        credential: register(makeAuthenticator(-7), { challenge: ownChallenge, origin: 'https://app.voltpay.test' }),
        expectedChallenge: ownChallenge,
        ...shared,
      }),
    'rp_id_mismatch',
    'a key made for one host, registered as if from another'
  );

  console.log('✅ adminWebauthn: all assertions passed');
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
