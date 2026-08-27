/**
 * Admin recovery-phrase reset.
 *
 * The one thing that must never break here is the ORDER. The phrase is a
 * one-way digest, so replacing it destroys whatever the user still had. If the
 * hash were written before the email were confirmed accepted, a send that
 * failed would leave the account with an old phrase that no longer verifies and
 * a new one nobody ever received - a permanent lockout from recovery login,
 * created by the support action meant to fix one.
 *
 * So: send first, write only on confirmation. Cases 2 and 3 are that rule.
 *
 * Also pinned: the plaintext never appears in the response (case 4), the words
 * that were mailed actually verify against what was stored (case 1 - otherwise
 * the whole exercise is a lockout with extra steps), the destination is read
 * from the encrypted column and not from the request (case 5), and a hash never
 * escapes through the lookup (case 7).
 *
 * Prisma, Brevo and the notifier are faked in front of the controller.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { protect } = require('../src/helpers/pii.helper');
const { verifyRecoveryPhrase, isValidRecoveryPhrase } = require('../src/helpers/recovery.helper');
const { DELETED, ACTIVE } = require('../src/helpers/accountStatus.helper');

const EMAIL = 'ada@example.com';

// --- state ----------------------------------------------------------------
const state = {};

function resetState() {
  state.user = {
    id: 42,
    status: ACTIVE,
    role: 'customer',
    country_code: 'NG',
    image: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    firstname_enc: protect('Ada', 'name').enc,
    lastname_enc: protect('Obi', 'name').enc,
    username_enc: protect('ada', 'username').enc,
    email_enc: protect(EMAIL, 'email').enc,
    mobile_enc: protect('2348012345678', 'mobile').enc,
    recovery_hash: 'OLD-HASH',
    recovery_set_at: new Date('2025-01-01T00:00:00.000Z'),
  };
  state.updates = [];
  state.sent = [];
  state.notified = [];
  state.delivery = { queued: true, id: 'msg-1', provider: 'brevo' };
  state.auditRows = [];
}

// --- fakes, installed before the controller is loaded ----------------------
const noop = async () => null;

const models = {
  user: {
    findUnique: async ({ where }) => (where.id === state.user.id ? { ...state.user } : null),
    findFirst: async () => ({ ...state.user }),
    findMany: async ({ where }) =>
      (where?.id?.in || []).includes(state.user.id) ? [{ ...state.user }] : [],
    update: async ({ data }) => {
      state.updates.push(data);
      Object.assign(state.user, data);
      return { ...state.user };
    },
  },
};

const fakePrisma = new Proxy(
  { $transaction: async fn => fn(fakePrisma) },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in models) return models[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
      return new Proxy({}, { get: () => noop });
    },
  },
);

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../database/prisma', fakePrisma);

stub('../src/services/email.service', {
  sendRecoveryPhraseEmail: async args => {
    state.sent.push(args);
    return state.delivery;
  },
});

stub('../src/services/notify.service', {
  notifyUser: async args => {
    state.notified.push(args);
    return true;
  },
});

stub('../src/services/audit.service', {
  listAdminActions: async () => ({
    items: state.auditRows,
    pagination: { page: 1, perPage: 20, total: state.auditRows.length, totalPages: 1 },
  }),
  logAdminAction: noop,
  logSystemAction: noop,
  clientIp: () => '127.0.0.1',
});

const { lookupUser, resetRecoveryPhrase, listResets, __test } = require('../src/controllers/adminRecovery.controller');

// --- harness ---------------------------------------------------------------
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    return res;
  };
  return res;
}

const reqBase = { headers: {}, ip: '10.0.0.1', admin: { name: 'ada.admin', role: 'superadmin' } };

async function reset(id = 42) {
  const res = mockRes();
  await resetRecoveryPhrase({ ...reqBase, params: { id: String(id) }, body: {} }, res);
  return res;
}

async function lookup(q) {
  const res = mockRes();
  await lookupUser({ ...reqBase, query: { q } }, res);
  return res;
}

(async () => {
  // 1. Happy path: mailed, stored, and the two agree.
  resetState();

  let res = await reset();
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.remark, 'recovery_phrase_reset');
  assert.strictEqual(state.sent.length, 1, 'exactly one email');
  assert.strictEqual(state.updates.length, 1, 'exactly one write');

  const mailed = state.sent[0].phrase;
  assert.ok(isValidRecoveryPhrase(mailed), 'a phrase that fails BIP39 validation is rejected at login');
  assert.strictEqual(mailed.split(' ').length, 12);

  const stored = state.updates[0].recovery_hash;
  assert.notStrictEqual(stored, 'OLD-HASH', 'the old hash is gone');
  // `.ok`, not the object: verifySecret returns { ok, needsRehash }, and an
  // object is always truthy - a bare check here would pass for any phrase.
  assert.strictEqual(
    (await verifyRecoveryPhrase(mailed, stored)).ok,
    true,
    'the words in the inbox must verify against the stored hash, or the user is locked out',
  );
  assert.strictEqual(
    (await verifyRecoveryPhrase('one two three four five six seven eight nine ten eleven twelve', stored)).ok,
    false,
  );
  assert.ok(state.updates[0].recovery_set_at instanceof Date, 'recovery_set_at is stamped');

  // The owner is told on a channel the person who ran the reset does not control.
  assert.strictEqual(state.notified.length, 1);
  assert.strictEqual(state.notified[0].userId, 42);

  // 2. Provider refused: nothing is changed, and the old phrase still works.
  resetState();
  state.delivery = { queued: false, error: { code: 'bad_request' }, provider: 'brevo' };

  res = await reset();
  assert.strictEqual(res.statusCode, 502, JSON.stringify(res.body));
  assert.strictEqual(state.updates.length, 0, 'a failed send must not rotate the hash');
  assert.strictEqual(state.user.recovery_hash, 'OLD-HASH');
  assert.strictEqual(state.notified.length, 0, 'nothing happened, so nobody is told it did');

  // 3. No BREVO_API_KEY: the service reports "queued" and drops the mail on the
  //    floor. Treated as a hard failure - accepting it would rotate the hash
  //    against a phrase that reached nobody.
  resetState();
  state.delivery = { queued: true, dev: true };

  res = await reset();
  assert.strictEqual(res.statusCode, 503, JSON.stringify(res.body));
  assert.strictEqual(state.updates.length, 0, 'dev mode must not rotate the hash');
  assert.strictEqual(state.user.recovery_hash, 'OLD-HASH');

  // 4. The plaintext never comes back to the dashboard.
  resetState();
  res = await reset();

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(state.sent[0].phrase), 'the phrase must not be in the response');
  for (const word of state.sent[0].phrase.split(' ')) {
    assert.ok(!serialized.includes(`"${word}"`), 'no word of the phrase leaks through the response');
  }
  assert.strictEqual(res.body.data.email_masked, 'a**@example.com');

  // 5. The destination is the address on file, decrypted - never anything the
  //    caller supplied. Otherwise an admin could mail a live phrase to an inbox
  //    they control.
  resetState();
  const spoofRes = mockRes();
  await resetRecoveryPhrase(
    { ...reqBase, params: { id: '42' }, body: { email: 'attacker@evil.test', to: 'attacker@evil.test' } },
    spoofRes,
  );
  assert.strictEqual(spoofRes.statusCode, 200);
  assert.strictEqual(state.sent[0].to, EMAIL, 'the request body cannot redirect the mail');

  // 6. Refusals that change nothing.
  resetState();
  state.user.status = DELETED;
  res = await reset();
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(state.updates.length, 0);
  assert.strictEqual(state.sent.length, 0, 'a deleted account is refused before any mail goes out');

  resetState();
  state.user.email_enc = null;
  res = await reset();
  assert.strictEqual(res.statusCode, 422, 'no address on file, nowhere to send it');
  assert.strictEqual(state.updates.length, 0);

  resetState();
  const badId = mockRes();
  await resetRecoveryPhrase({ ...reqBase, params: { id: 'abc' }, body: {} }, badId);
  assert.strictEqual(badId.statusCode, 400);

  // 7. Lookup reports whether a phrase exists, and never hands over the hash.
  resetState();
  res = await lookup(EMAIL);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.user.email, EMAIL);
  assert.strictEqual(res.body.data.recovery.has_phrase, true);
  assert.ok(!JSON.stringify(res.body).includes('OLD-HASH'), 'the digest must never reach the dashboard');
  assert.ok(!('recovery_hash' in res.body.data.user));

  resetState();
  state.user.recovery_hash = null;
  res = await lookup(EMAIL);
  assert.strictEqual(res.body.data.recovery.has_phrase, false, 'accounts predating the feature read as "never set"');

  const blank = mockRes();
  await lookupUser({ ...reqBase, query: { q: '  ' } }, blank);
  assert.strictEqual(blank.statusCode, 400);

  // 8. History: the address is masked, and a 4xx row does not read as a reset
  //    that happened.
  resetState();
  state.auditRows = [
    { id: 1, actor: 'ada.admin', metadata: { actor_role: 'superadmin' }, target_id: '42', status_code: 200, ip: '10.0.0.1', created_at: new Date() },
    { id: 2, actor: 'ada.admin', metadata: null, target_id: '42', status_code: 502, ip: '10.0.0.1', created_at: new Date() },
  ];

  const history = mockRes();
  await listResets({ ...reqBase, query: {} }, history);
  assert.strictEqual(history.statusCode, 200, JSON.stringify(history.body));

  const [ok, failed] = history.body.data.items;
  assert.strictEqual(ok.succeeded, true);
  assert.strictEqual(ok.email_masked, 'a**@example.com');
  assert.strictEqual(ok.actor_role, 'superadmin');
  assert.strictEqual(failed.succeeded, false, '502 is an attempt, not a reset');
  assert.ok(!JSON.stringify(history.body).includes(EMAIL), 'the full address stays off the log screen');

  // 9. maskEmail keeps the domain and the first character, and nothing else.
  assert.strictEqual(__test.maskEmail('jadeedgetech@gmail.com'), 'j***********@gmail.com');
  assert.strictEqual(__test.maskEmail('a@b.com'), 'a*@b.com');
  assert.strictEqual(__test.maskEmail('@nolocal.com'), '', 'no local part, nothing to confirm');
  assert.strictEqual(__test.maskEmail(''), '');
  assert.strictEqual(__test.maskEmail(null), '');

  console.log('✅ adminRecovery tests passed');
})().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
