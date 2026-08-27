/**
 * Admin edits to a user's locked profile fields.
 *
 * This endpoint exists because the app refuses to let a person rewrite their own
 * legal name, email or phone - so support is the only path, and it has to be a
 * narrow one. What is pinned here is the narrowness:
 *
 *   - email and mobile are credentials (login matches on mobile_idx, a password
 *     reset is mailed to email), so a support agent cannot touch them and a
 *     probe for them learns nothing about the account - case 4;
 *   - a changed email is an unverified email - case 5;
 *   - the values are written encrypted through protectUserFields and the plain
 *     columns are nulled, never left behind - case 2;
 *   - nothing goes out that another account already holds - case 6;
 *   - the account holder is always told, and the notice names the fields but
 *     never the values, because that row is stored as plain text - case 7;
 *   - an audit-worthy action requires a reason, and a deleted account is refused
 *     outright - cases 1 and 8.
 *
 * Prisma, the notifier and the audit services are faked in front of the
 * controller.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { protect, blindIndex, reveal } = require('../src/helpers/pii.helper');
const { DELETED, ACTIVE } = require('../src/helpers/accountStatus.helper');

const EMAIL = 'ada@example.com';
const MOBILE = '2348012345678';

// --- state ----------------------------------------------------------------
const state = {};

function resetState() {
  state.user = {
    id: 42,
    status: ACTIVE,
    role: 'customer',
    country_code: 'NG',
    balance: '0',
    image: null,
    ev: '1',
    sv: '1',
    kv: '1',
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    firstname: null,
    lastname: null,
    firstname_enc: protect('Chinoso', 'name').enc,
    lastname_enc: protect('Obi', 'name').enc,
    username_enc: protect('ada', 'username').enc,
    email_enc: protect(EMAIL, 'email').enc,
    mobile_enc: protect(MOBILE, 'mobile').enc,
    address_enc: protect('12 Marina', 'address').enc,
    state_enc: protect('Lagos', 'state').enc,
    city_enc: null,
    zip_enc: null,
  };
  state.updates = [];
  state.notified = [];
  state.events = [];
  state.invalidated = [];
  // Blind indexes that belong to SOMEBODY ELSE. Anything in here must be
  // refused as a duplicate.
  state.takenIdx = new Set();
}

// --- fakes, installed before the controller is loaded ----------------------
const noop = async () => null;

/** Every *_idx value the where-clause is asking about, flattened. */
function requestedIndexes(where = {}) {
  const out = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(value)) {
      for (const branch of value) out.push(...requestedIndexes(branch));
    } else if (key.endsWith('_idx') && value) {
      out.push(value);
    }
  }
  return out;
}

const models = {
  user: {
    findUnique: async ({ where }) => (where.id === state.user.id ? { ...state.user } : null),
    // Only ever called by the duplicate check.
    findFirst: async ({ where }) =>
      requestedIndexes(where).some(idx => state.takenIdx.has(idx)) ? { id: 99 } : null,
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

stub('../src/services/notify.service', {
  notifyUser: async args => {
    state.notified.push(args);
    return true;
  },
});

stub('../src/services/userAudit.service', {
  logUserEvent: async args => {
    state.events.push(args);
    return true;
  },
  listUserEvents: noop,
});

stub('../src/services/userCache.service', {
  invalidateUser: async id => {
    state.invalidated.push(id);
    return true;
  },
  getCachedUser: noop,
});

stub('../src/services/alerts.service', { captureError: () => null, captureAlert: () => null });

const { updateUserProfile, __test } = require('../src/controllers/adminUserProfile.controller');

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

const REASON = 'Ticket #4821 - misspelled at signup';

async function patch(body, { role = 'superadmin', id = 42 } = {}) {
  const res = mockRes();
  await updateUserProfile(
    { headers: {}, ip: '10.0.0.1', admin: { name: 'ada.admin', role }, params: { id: String(id) }, body },
    res,
  );
  return res;
}

(async () => {
  // 1. A reason is mandatory - the audit row is the whole point of the endpoint.
  resetState();
  let res = await patch({ firstname: 'Chinonso' });
  assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
  assert.strictEqual(res.body.remark, 'reason_required');
  assert.strictEqual(state.updates.length, 0, 'a refused edit writes nothing');

  res = await patch({ reason: REASON });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'nothing_to_update');

  // 2. The happy path: name corrected, stored encrypted, plain column nulled.
  resetState();
  res = await patch({ reason: REASON, firstname: 'Chinonso' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.remark, 'user_profile_updated');
  assert.deepStrictEqual(res.body.data.changed, ['firstname'], 'only the field that moved');

  const write = state.updates[0];
  assert.ok(write.firstname_enc, 'the new name is written to the ciphertext column');
  assert.strictEqual(reveal(write.firstname_enc), 'Chinonso');
  assert.strictEqual(write.firstname, null, 'the plain column is nulled, never left with a value');
  assert.ok(!('lastname_enc' in write), 'a field that was not sent is not touched');
  assert.strictEqual(res.body.data.user.firstname, 'Chinonso', 'the response carries the decrypted value back');
  assert.deepStrictEqual(state.invalidated, [42], 'the cached row is dropped so the next request sees this');

  // No ciphertext or secret column escapes through the response.
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('_enc'), 'publicUser strips the ciphertext columns');
  assert.ok(!serialized.includes('_idx'), 'and the blind indexes');

  // 3. Saving the value that is already there is a no-op, not a notification.
  resetState();
  res = await patch({ reason: REASON, firstname: 'Chinoso', lastname: 'Obi' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.remark, 'user_profile_unchanged');
  assert.strictEqual(state.updates.length, 0);
  assert.strictEqual(state.notified.length, 0, 'nothing changed, so the user is not told it did');

  // 4. Email and mobile are credentials. Support cannot move them, and the
  //    refusal happens before the account is even read.
  resetState();
  res = await patch({ reason: REASON, email: 'new@example.com' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
  assert.strictEqual(state.updates.length, 0);

  res = await patch({ reason: REASON, mobile: '2348099999999' }, { role: 'finance' });
  assert.strictEqual(res.statusCode, 403);

  // Mixed batch: one sensitive field poisons the whole request rather than
  // silently applying the harmless half.
  res = await patch({ reason: REASON, firstname: 'Chinonso', email: 'new@example.com' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(state.updates.length, 0, 'the name is not written either');

  // 5. A superadmin can, and the verified flag drops with it.
  resetState();
  res = await patch({ reason: REASON, email: 'new@example.com' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(state.updates[0].ev, '0', 'an address nobody confirmed is not a verified address');
  assert.strictEqual(reveal(state.updates[0].email_enc), 'new@example.com');
  assert.ok(state.updates[0].email_idx, 'the blind index is rewritten, or login and reset stop finding the row');
  assert.strictEqual(state.updates[0].email_idx, blindIndex('new@example.com', 'email'));
  assert.ok(!('kv' in state.updates[0]), 'KYC is left alone - a support fix is usually a correction towards the ID');

  resetState();
  res = await patch({ reason: REASON, mobile: '2348099999999' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.updates[0].sv, '0');
  assert.ok(!('ev' in state.updates[0]), 'a phone change does not un-verify the email');

  // 6. Somebody else's email, username or phone is refused.
  resetState();
  state.takenIdx.add(blindIndex('taken@example.com', 'email'));
  res = await patch({ reason: REASON, email: 'taken@example.com' });
  assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.remark, 'email_exists');
  assert.strictEqual(state.updates.length, 0);

  resetState();
  state.takenIdx.add(blindIndex('ngozi', 'username'));
  res = await patch({ reason: REASON, username: 'ngozi' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.remark, 'username_exists');

  // Every Nigerian spelling of the same number is one phone. A row indexed as
  // 08031234567 must block an admin typing 2348031234567.
  resetState();
  state.takenIdx.add(blindIndex('08031234567', 'mobile'));
  res = await patch({ reason: REASON, mobile: '2348031234567' });
  assert.strictEqual(res.statusCode, 409, 'the 234/0 variants of one number are not two numbers');
  assert.strictEqual(state.updates.length, 0);

  // 7. The account holder hears about it - and the notice names the field, not
  //    the value. That row lives in the database as plain text.
  resetState();
  res = await patch({ reason: REASON, email: 'new@example.com' });
  assert.strictEqual(state.notified.length, 1);
  assert.strictEqual(state.notified[0].userId, 42);
  assert.strictEqual(state.notified[0].type, 'security');

  const notice = JSON.stringify(state.notified[0]);
  assert.ok(!notice.includes('new@example.com'), 'the new address must not be written into the notification row');
  assert.ok(!notice.includes(EMAIL), 'nor the old one');
  assert.ok(notice.includes('email address'), 'the field is named so the user knows what to check');

  // The user's own trail records who did it and to which fields - never values.
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].event, 'profile.admin_updated');
  assert.strictEqual(state.events[0].metadata.actor, 'ada.admin');
  assert.deepStrictEqual(state.events[0].metadata.fields, ['email']);
  // metadata is the only part of this call that is persisted as free-form JSON -
  // userAudit.service takes ip, device and user-agent off `req` and nothing else.
  assert.ok(!JSON.stringify(state.events[0].metadata).includes('new@example.com'));

  // 8. Refusals that change nothing.
  resetState();
  state.user.status = DELETED;
  res = await patch({ reason: REASON, firstname: 'Chinonso' });
  assert.strictEqual(res.statusCode, 409, 'a closed account is a retention record, not an editable profile');
  assert.strictEqual(state.updates.length, 0);

  resetState();
  res = await patch({ reason: REASON, firstname: 'Chinonso' }, { id: 'abc' });
  assert.strictEqual(res.statusCode, 400);

  resetState();
  res = await patch({ reason: REASON, firstname: '   ' });
  assert.strictEqual(res.statusCode, 400, 'a name cannot be cleared');
  assert.strictEqual(state.updates.length, 0);

  resetState();
  res = await patch({ reason: REASON, firstname: 'Chin0nso' });
  assert.strictEqual(res.statusCode, 400, 'the same name rule the sign-up form enforces');

  resetState();
  res = await patch({ reason: REASON, state: 'Atlantis' });
  assert.strictEqual(res.statusCode, 400, 'a Nigerian account gets a Nigerian state');

  resetState();
  res = await patch({ reason: REASON, zip: '10a' });
  assert.strictEqual(res.statusCode, 400);

  resetState();
  res = await patch({ reason: 'oops', firstname: 'Chinonso' });
  assert.strictEqual(res.statusCode, 400, 'a reason has to say something');

  // 9. The optional address block CAN be cleared - unlike a name, an empty
  //    address is a real state.
  resetState();
  res = await patch({ reason: REASON, address: '' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(state.updates[0].address_enc, null);
  assert.strictEqual(state.updates[0].address, null);

  // 10. 'lagos' and 'Lagos' are one state. Stored canonically so the statement
  //     and KYC screens agree with each other.
  resetState();
  res = await patch({ reason: REASON, state: 'lagos' }, { role: 'support' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.remark, 'user_profile_unchanged', 'canonicalised back to what is already stored');

  // 11. Anything not on the list is ignored outright - status, role, balance and
  //     the PIN each have their own gated endpoint.
  resetState();
  const rejected = __test.collectPatch({ balance: '999999', role: 'admin', status: 1, pin: '1111', firstname: 'Chinonso' });
  assert.deepStrictEqual(Object.keys(rejected), ['firstname']);

  res = await patch({ reason: REASON, balance: '999999', role: 'admin', pin: '1111' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'nothing_to_update', 'no editable field was sent, whatever else was');
  assert.strictEqual(state.updates.length, 0);

  console.log('✅ adminUserProfile tests passed');
})().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
