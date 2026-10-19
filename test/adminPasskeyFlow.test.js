/**
 * Admin fingerprint sign-in, end to end through the real controller.
 *
 * The database is in memory and the phone is test/fakeAuthenticator.js, but
 * everything between them is production code: setup costs the password, a
 * passkey signs in without the password or the 6-digit code, every challenge
 * is spent once, a lockout earned by wrong passwords holds, one admin can
 * never touch another's devices, and a password change or reset takes the
 * passkeys with it.
 *
 * Run: node test/adminPasskeyFlow.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = 'customer-secret';
process.env.ADMIN_JWT_SECRET = 'admin-secret-and-different';
process.env.ADMIN_WEBAUTHN_RP_ID = 'admin.voltpay.test';
process.env.ADMIN_WEBAUTHN_ORIGINS = 'https://admin.voltpay.test';

const RP_ID = process.env.ADMIN_WEBAUTHN_RP_ID;
const ORIGIN = process.env.ADMIN_WEBAUTHN_ORIGINS;

const fake = require('./fakeAuthenticator');

/* ------------------------------------------------------------------ db */

const db = { admins: [], credentials: [], challenges: [] };

// Enough of Prisma's `where` for these three tables: equality, null, and lt.
function matchWhere(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === 'object' && !(want instanceof Date) && 'lt' in want) return row[key] < want.lt;
    if (want === null) return row[key] === null || row[key] === undefined;
    return row[key] === want;
  });
}

const prismaError = code => Object.assign(new Error(code), { code });

let credentialsMissing = false;
const credentialTable = () => {
  if (credentialsMissing) throw prismaError('P2021');
  return db.credentials;
};

let nextCredentialId = 1;

const models = {
  adminUser: {
    findUnique: async ({ where }) => db.admins.find(r => matchWhere(r, where)) || null,
    update: async ({ where, data }) => {
      const row = db.admins.find(r => matchWhere(r, where));
      if (!row) throw prismaError('P2025');
      return Object.assign(row, data);
    },
  },
  adminWebauthnCredential: {
    findUnique: async ({ where }) => credentialTable().find(r => matchWhere(r, where)) || null,
    findMany: async ({ where }) => credentialTable().filter(r => matchWhere(r, where)),
    create: async ({ data }) => {
      if (credentialTable().some(r => r.credential_id === data.credential_id)) throw prismaError('P2002');
      const row = { id: nextCredentialId++, created_at: new Date(), last_used_at: null, ...data };
      db.credentials.push(row);
      return row;
    },
    update: async ({ where, data }) => Object.assign(credentialTable().find(r => matchWhere(r, where)), data),
    deleteMany: async ({ where }) => {
      const before = credentialTable().length;
      db.credentials = db.credentials.filter(r => !matchWhere(r, where));
      return { count: before - db.credentials.length };
    },
  },
  adminWebauthnChallenge: {
    create: async ({ data }) => {
      const row = { used_at: null, created_at: new Date(), ...data };
      db.challenges.push(row);
      return row;
    },
    findUnique: async ({ where }) => db.challenges.find(r => matchWhere(r, where)) || null,
    // The guard is the point: only a row still unspent can be claimed.
    updateMany: async ({ where, data }) => {
      const rows = db.challenges.filter(r => matchWhere(r, where));
      rows.forEach(r => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }) => {
      const before = db.challenges.length;
      db.challenges = db.challenges.filter(r => !matchWhere(r, where));
      return { count: before - db.challenges.length };
    },
  },
};

const noop = async () => null;
const fakePrisma = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop in models) return models[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
      return new Proxy({}, { get: () => noop });
    },
  }
);

const audits = [];

function stub(request, exports) {
  const filename = require.resolve(path.join(__dirname, request));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../database/prisma', fakePrisma);
stub('../src/services/audit.service', {
  logAdminAction: async line => audits.push(line),
  clientIp: () => '102.89.23.144',
});

const Admin = require('../src/controllers/adminAuth.controller');
const { blindIndex, encryptValue, decryptValue, hashSecret } = require('../src/helpers/pii.helper');
const { registerFailure, clearFailures } = require('../src/helpers/loginLockout.helper');
const { verifyAdminToken } = require('../src/helpers/adminAccount.helper');

/* --------------------------------------------------------------- calls */

async function call(handler, { body = {}, params = {}, admin = null } = {}) {
  const req = { body, params, admin, method: 'POST', originalUrl: '/api/admin/auth/test', headers: {} };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler(req, res);
  return res;
}

const sessionOf = row => ({ source: 'session', id: row.id, name: row.name, role: row.role, row });
const lastAudit = action => [...audits].reverse().find(a => a.action === action);

const PASSWORD = 'Correct-Horse-9!battery';

async function main() {
  const ada = {
    id: 1,
    name: 'ada',
    email_enc: encryptValue('ada@voltpay.ng'),
    email_idx: blindIndex('ada@voltpay.ng', 'email'),
    password: await hashSecret(PASSWORD, 'admin_password'),
    role: 'superadmin',
    status: 1,
    // On purpose: a fingerprint must sign in without the 6-digit code.
    totp_enabled: true,
    totp_secret_enc: encryptValue('JBSWY3DPEHPK3PXP'),
    must_change_password: false,
    active_session_id: null,
    created_at: new Date(),
  };
  const ben = { ...ada, id: 2, name: 'ben', email_idx: blindIndex('ben@voltpay.ng', 'email'), role: 'support' };
  db.admins.push(ada, ben);

  const phone = fake.makeAuthenticator(-7);

  // --- setup costs the password ------------------------------------------
  let res = await call(Admin.passkeyRegisterOptions, { admin: sessionOf(ada), body: {} });
  assert.strictEqual(res.statusCode, 401, 'setup without the password is refused');

  res = await call(Admin.passkeyRegisterOptions, { admin: sessionOf(ada), body: { password: 'wrong' } });
  assert.strictEqual(res.statusCode, 401, 'setup with the wrong password is refused');

  res = await call(Admin.passkeyRegisterOptions, { admin: sessionOf(ada), body: { password: PASSWORD } });
  assert.strictEqual(res.statusCode, 200, 'setup with the password starts');
  const setup = res.body.data;
  assert.strictEqual(setup.options.rp.id, RP_ID, 'RP ID comes from the environment');
  assert.strictEqual(setup.options.user.name, 'ada', 'the handle, not the email, goes to the device');
  assert.strictEqual(setup.options.authenticatorSelection.userVerification, 'required', 'a fingerprint is required');
  assert.deepStrictEqual(setup.options.excludeCredentials, [], 'nothing to exclude yet');

  // --- the device answers; the passkey is saved ----------------------------
  const created = fake.register(phone, { challenge: setup.options.challenge, rpId: RP_ID, origin: ORIGIN });
  res = await call(Admin.passkeyRegister, {
    admin: sessionOf(ada),
    body: { challenge_id: setup.challenge_id, credential: created, label: 'Ada’s Pixel 8' },
  });
  assert.strictEqual(res.statusCode, 200, `registration accepted: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.data.passkey.label, 'Ada’s Pixel 8', 'label round-trips');
  assert.strictEqual(db.credentials.length, 1, 'one passkey stored');
  const stored = db.credentials[0];
  assert.strictEqual(stored.user_handle, setup.options.user.id, 'saved under the handle the device was given');
  assert.notStrictEqual(stored.label_enc, 'Ada’s Pixel 8', 'the label is encrypted at rest');
  assert.strictEqual(decryptValue(stored.label_enc), 'Ada’s Pixel 8', '...and decrypts');
  assert.ok(lastAudit('admin.passkey.added'), 'setup is audited');

  // The same answer again: the challenge is spent.
  res = await call(Admin.passkeyRegister, { admin: sessionOf(ada), body: { challenge_id: setup.challenge_id, credential: created } });
  assert.strictEqual(res.statusCode, 400, 'a setup challenge works once');

  // Another admin cannot spend Ada's setup challenge.
  res = await call(Admin.passkeyRegisterOptions, { admin: sessionOf(ada), body: { password: PASSWORD } });
  const second = res.body.data;
  assert.strictEqual(second.options.user.id, setup.options.user.id, 'one stable handle per admin');
  assert.deepStrictEqual(
    second.options.excludeCredentials.map(c => c.id),
    [stored.credential_id],
    'the device already set up is excluded'
  );
  const benAttempt = fake.register(fake.makeAuthenticator(-7), { challenge: second.options.challenge, rpId: RP_ID, origin: ORIGIN });
  res = await call(Admin.passkeyRegister, { admin: sessionOf(ben), body: { challenge_id: second.challenge_id, credential: benAttempt } });
  assert.strictEqual(res.statusCode, 400, 'a setup challenge belongs to the admin who asked for it');

  // A listing never carries the key material.
  res = await call(Admin.listPasskeys, { admin: sessionOf(ada) });
  assert.strictEqual(res.body.data.available, true);
  assert.deepStrictEqual(Object.keys(res.body.data.passkeys[0]).sort(), ['created_at', 'id', 'label', 'last_used_at', 'synced']);

  // --- sign in: the fingerprint is enough ----------------------------------
  const signInWith = async (opts = {}) => {
    const start = await call(Admin.passkeyLoginOptions);
    assert.strictEqual(start.statusCode, 200, 'sign-in starts');
    assert.strictEqual(start.body.data.options.rpId, RP_ID);
    assert.strictEqual(start.body.data.options.allowCredentials, undefined, 'no account is named up front');
    const credential = fake.signIn(opts.device || phone, {
      challenge: opts.challenge || start.body.data.options.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
      userHandle: setup.options.user.id,
      ...opts.sign,
    });
    const body = { challenge_id: start.body.data.challenge_id, credential };
    return { res: await call(Admin.passkeyLogin, { body }), body };
  };

  let attempt = await signInWith();
  assert.strictEqual(attempt.res.statusCode, 200, `fingerprint signs in: ${JSON.stringify(attempt.res.body)}`);
  const token = verifyAdminToken(attempt.res.body.data.access_token);
  assert.strictEqual(token.sub, '1', 'the session is Ada’s');
  assert.strictEqual(token.sid, ada.active_session_id, 'the session id was rotated, like any login');
  assert.strictEqual(attempt.res.body.remark, 'login_success', 'no 6-digit code was asked for');
  assert.strictEqual(lastAudit('admin.login').metadata.method, 'passkey', 'the audit says how they got in');
  assert.ok(stored.last_used_at instanceof Date, 'last used is recorded');

  // The same signed answer, replayed: its challenge is spent.
  res = await call(Admin.passkeyLogin, { body: attempt.body });
  assert.strictEqual(res.statusCode, 401, 'a sign-in cannot be replayed');
  assert.strictEqual(res.body.remark, 'invalid_challenge');

  // A fresh challenge, but an answer signed for an old one.
  attempt = await signInWith({ challenge: fake.b64(crypto.randomBytes(32)) });
  assert.strictEqual(attempt.res.statusCode, 401, 'an answer to a different challenge is refused');
  assert.strictEqual(attempt.res.body.remark, 'passkey_rejected');
  assert.strictEqual(lastAudit('admin.login.failed').metadata.reason, 'challenge_mismatch', 'the audit records why');

  // A device the server has never seen gets the very same answer.
  attempt = await signInWith({ device: fake.makeAuthenticator(-7) });
  assert.strictEqual(attempt.res.statusCode, 401, 'an unknown passkey is refused');
  assert.strictEqual(attempt.res.body.message[0], 'Fingerprint sign-in did not work. Sign in with your password instead.');

  // No fingerprint, only a touch.
  attempt = await signInWith({ sign: { flags: fake.FLAG_UP } });
  assert.strictEqual(attempt.res.statusCode, 401, 'presence without the fingerprint is refused');

  // --- a lockout earned by wrong passwords holds ---------------------------
  const lockKey = `admin:${ada.email_idx}`;
  for (let i = 0; i < 3; i += 1) await registerFailure(lockKey);
  attempt = await signInWith();
  assert.strictEqual(attempt.res.statusCode, 429, 'a locked account stays locked for the fingerprint too');
  await clearFailures(lockKey);

  // --- a disabled admin is refused, and says nothing about why ------------
  ada.status = 0;
  attempt = await signInWith();
  assert.strictEqual(attempt.res.statusCode, 401, 'a disabled admin cannot sign in');
  assert.strictEqual(attempt.res.body.remark, 'passkey_rejected', 'same answer as a bad passkey');
  ada.status = 1;

  // --- devices belong to their admin ----------------------------------------
  res = await call(Admin.removePasskey, { admin: sessionOf(ben), params: { id: String(stored.id) } });
  assert.strictEqual(res.statusCode, 404, 'one admin cannot remove another’s device');
  assert.strictEqual(db.credentials.length, 1);

  res = await call(Admin.removePasskey, { admin: sessionOf(ada), params: { id: String(stored.id) } });
  assert.strictEqual(res.statusCode, 200, 'an admin removes their own device');
  assert.strictEqual(db.credentials.length, 0);

  attempt = await signInWith();
  assert.strictEqual(attempt.res.statusCode, 401, 'a removed passkey no longer signs in');

  // --- a password change takes the passkeys with it ------------------------
  const enrol = async admin => {
    const options = await call(Admin.passkeyRegisterOptions, { admin: sessionOf(admin), body: { password: PASSWORD } });
    const answer = fake.register(fake.makeAuthenticator(-8), { challenge: options.body.data.options.challenge, rpId: RP_ID, origin: ORIGIN });
    const saved = await call(Admin.passkeyRegister, { admin: sessionOf(admin), body: { challenge_id: options.body.data.challenge_id, credential: answer } });
    assert.strictEqual(saved.statusCode, 200, 'enrolled');
  };

  await enrol(ada);
  res = await call(Admin.changePassword, {
    admin: sessionOf(ada),
    body: { current_password: PASSWORD, new_password: 'Another-Horse-10!stapler' },
  });
  assert.strictEqual(res.statusCode, 200, 'password changed');
  assert.strictEqual(res.body.data.passkeys_revoked, 1, 'the response says the passkey went');
  assert.strictEqual(db.credentials.length, 0, 'a password change revokes passkeys');

  ada.password = await hashSecret(PASSWORD, 'admin_password');
  await enrol(ada);
  res = await call(Admin.resetAdminPassword, { admin: sessionOf(ben), params: { id: '1' } });
  assert.strictEqual(res.statusCode, 200, 'superadmin reset');
  assert.strictEqual(db.credentials.length, 0, 'a reset revokes passkeys');

  // --- static keys, a server not set up, a schema behind ------------------
  res = await call(Admin.passkeyRegisterOptions, { admin: { source: 'static', name: 'admin', role: 'superadmin' }, body: {} });
  assert.strictEqual(res.statusCode, 400, 'a static key has no passkeys');

  // The reset above issued a temporary password; put the known one back.
  ada.password = await hashSecret(PASSWORD, 'admin_password');
  credentialsMissing = true;
  res = await call(Admin.listPasskeys, { admin: sessionOf(ada) });
  assert.deepStrictEqual(res.body.data, { available: false, passkeys: [] }, 'missing table reads as "not available"');
  res = await call(Admin.changePassword, {
    admin: sessionOf(ada),
    body: { current_password: PASSWORD, new_password: 'Third-Horse-11!paperclip' },
  });
  assert.strictEqual(res.statusCode, 200, 'a password change survives the passkey table being missing');
  credentialsMissing = false;

  const rpId = process.env.ADMIN_WEBAUTHN_RP_ID;
  delete process.env.ADMIN_WEBAUTHN_RP_ID;
  delete process.env.ADMIN_WEBAUTHN_ORIGINS;
  process.env.NODE_ENV = 'production';
  res = await call(Admin.passkeyLoginOptions);
  assert.strictEqual(res.statusCode, 503, 'unconfigured in production: unavailable, not broken');
  assert.strictEqual(res.body.remark, 'passkey_unavailable');
  process.env.ADMIN_WEBAUTHN_RP_ID = rpId;

  console.log('✅ adminPasskeyFlow: all assertions passed');
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
