/**
 * node test/fundingAccounts.test.js
 *
 * The Fund Account flow - one PalmPay account per user, through PaymentPoint,
 * opened with the user's own NIN - driven through the real controller with
 * Prisma and PaymentPoint's create call faked in front of it.
 *
 * What it pins, because each one is a way to lose money or leak a NIN:
 *
 *    1  GET never provisions, and says when accounts are unavailable
 *    2  a missing, malformed or someone-else's NIN is refused for free
 *    3  a typed NIN opens the account; only its blind index is kept, and
 *       PaymentPoint's plain-text customer block is not
 *    4  an approved NIN slip is reused - the typed number is never read
 *    5  one user, one account: a second request returns the first
 *    6  rows from dropped providers, legacy rows and empty placeholders
 *    7  provider refusals read as something the customer can act on, and
 *       leave nothing behind
 *    8  a double tap opens one account - and a Redis blip is not a "no"
 *    9  the PaymentPoint webhook credits once, however often it is delivered
 *   10  accepted without an account: pending, keyed for the webhook, and
 *       finished by PaymentPoint's account event
 *   11  a timeout is pending, not a failure: the hold, the claimed NIN, and a
 *       retry that finishes the same row
 *   12  "already exists" pages ops once, and the export links it
 *   13  a payment for a customer we never recorded: placed by email AND
 *       phone, never by one of them, never to two people
 *   14  a payment into a pending customer finishes its account
 *   15  the shapes PaymentPoint might answer in
 *   16  a failure we cannot read is assumed to have opened something
 *   17  the sweep nudges and pages once each, and never reverts a ready row
 *   18  PaymentPoint's export is read, and linked on the same rule
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYMENTPOINT_API_KEY = 'pp-key';
process.env.PAYMENTPOINT_SECRET_KEY = 'pp-secret';
process.env.PAYMENTPOINT_BUSINESS_ID = 'pp-biz';
delete process.env.PAYMENTPOINT_WEBHOOK_SECRET;
delete process.env.PAYMENTPOINT_BANK_CODES;
delete process.env.FUNDING_VA_RETRY_AFTER_MS;
delete process.env.FUNDING_VA_SLOW_RETRY_AFTER_MS;
delete process.env.FUNDING_VA_NUDGE_AFTER_MS;
delete process.env.FUNDING_VA_ALERT_AFTER_MS;

const { protect, blindIndex, revealText } = require('../src/helpers/pii.helper');

/* ========================================================================== */
/*  the fake database                                                         */
/* ========================================================================== */

const db = { funding: [], kyc: new Map(), users: new Map(), ledger: [], nextId: 1 };

// updated_at moves on every write, strictly, so a guard on it means what it
// means in Postgres: "nobody wrote this row since I read it".
let clock = Date.now();
const tick = () => new Date((clock += 1));

function sameValue(a, b) {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function matches(row, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!cond.some(c => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) {
        if (sameValue(value, cond.not)) return false;
        continue;
      }
      if ('path' in cond) {
        const got = cond.path.reduce((o, p) => (o == null ? undefined : o[p]), value);
        if (got !== cond.equals) return false;
        continue;
      }
      throw new Error(`fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
    }
    if (!sameValue(value, cond)) return false;
  }
  return true;
}

const P2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (`tx_ref`)'), { code: 'P2002' });
// What a read hands back: a snapshot. Columns keep their types (Date,
// Decimal); the JSON column is a deep copy, as it would be off the wire, so a
// stale read stays stale after the row is written.
const copy = row =>
  row ? { ...row, raw_payload: row.raw_payload == null ? row.raw_payload : JSON.parse(JSON.stringify(row.raw_payload)) } : null;

function insertFunding(data) {
  const now = tick();
  const row = { id: db.nextId++, credited_at: null, created_at: now, updated_at: now, ...data };
  db.funding.push(row);
  return row;
}

const fakePrisma = {
  fundingTransaction: {
    async findMany({ where, orderBy } = {}) {
      const rows = db.funding.filter(r => matches(r, where));
      if (orderBy?.id === 'desc') rows.sort((a, b) => b.id - a.id);
      if (orderBy?.id === 'asc') rows.sort((a, b) => a.id - b.id);
      return rows.map(copy);
    },
    async findFirst({ where } = {}) {
      return copy(db.funding.find(r => matches(r, where)));
    },
    async findUnique({ where }) {
      return copy(db.funding.find(r => (where.id != null ? r.id === where.id : r.tx_ref === where.tx_ref)));
    },
    async create({ data }) {
      if (db.funding.some(r => r.tx_ref === data.tx_ref)) throw P2002();
      return copy(insertFunding(data));
    },
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const d of data) {
        if (db.funding.some(r => r.tx_ref === d.tx_ref)) {
          if (skipDuplicates) continue;
          throw P2002();
        }
        insertFunding(d);
        count += 1;
      }
      return { count };
    },
    async updateMany({ where, data }) {
      const rows = db.funding.filter(r => matches(r, where));
      if (data.tx_ref && rows.some(r => db.funding.some(o => o !== r && o.tx_ref === data.tx_ref))) throw P2002();
      rows.forEach(r => Object.assign(r, data, { updated_at: tick() }));
      return { count: rows.length };
    },
    async deleteMany({ where }) {
      const before = db.funding.length;
      db.funding = db.funding.filter(r => !matches(r, where));
      return { count: before - db.funding.length };
    },
  },
  kycVerification: {
    async findUnique({ where }) {
      const row = db.kyc.get(where.user_id);
      return row ? { ...row } : null;
    },
    async findFirst({ where }) {
      const row = [...db.kyc.values()].find(r => matches(r, where));
      return row ? { user_id: row.user_id } : null;
    },
  },
  user: {
    async update({ where, data }) {
      Object.assign(db.users.get(where.id) || {}, data);
      return {};
    },
    async findUnique({ where }) {
      const u = db.users.get(Number(where.id));
      return u ? { ...u } : null;
    },
    async findMany({ where }) {
      return [...db.users.values()].filter(u => matches(u, where)).map(u => ({ ...u }));
    },
  },
  walletTransaction: {
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const d of data) {
        if (db.ledger.some(r => r.trx === d.trx)) {
          if (skipDuplicates) continue;
          throw P2002();
        }
        db.ledger.push({ ...d });
        count += 1;
      }
      return { count };
    },
  },
  $transaction: async fn => fn(fakePrisma),
};

/* ========================================================================== */
/*  fakes, installed before the controller is loaded                          */
/* ========================================================================== */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { deltas: [], pushes: [], security: [], alerts: [], ppCreate: [] };

// What the next PaymentPoint create answers. An Error is thrown; `gate` holds
// the call open until released, for the double-tap case.
const provider = { ppCreate: null, gate: null };

stub('../database/prisma', fakePrisma);
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (tx, wallet, ownerId, delta) => {
    spy.deltas.push({ wallet, ownerId: Number(ownerId), delta: delta.toString() });
  },
});
// The real one dedupes on client_message_id (a P2002 on the stored row).
const sentMessageIds = new Set();
stub('../src/services/notify.service', {
  notifyUser: async args => {
    if (args.clientMessageId) {
      if (sentMessageIds.has(args.clientMessageId)) return false;
      sentMessageIds.add(args.clientMessageId);
    }
    spy.pushes.push(args);
    return true;
  },
});
stub('../src/services/alerts.service', {
  securityEvent: (scope, message, context) => spy.security.push({ scope, context }),
  paymentFailure: args => spy.alerts.push(args),
  captureError: () => null,
});
stub('../src/services/cache.service', { dropUserActivity: () => null });
// Off by default, so the in-process half of the account lock is what most
// cases exercise. Case 8b switches it on to test the shared half.
const fakeRedis = {
  isEnabled: () => false,
  isHealthy: () => false,
  key: (...parts) => parts.join(':'),
  command: async () => null,
  pipeline: async () => null,
  del: async () => null,
};
stub('../src/services/redis.service', fakeRedis);

// The real PaymentPoint module with only its network call replaced, so the
// webhook still runs the real signature check and the real parsing.
const realPP = require('../src/funding/paymentpoint.service');
stub('../src/funding/paymentpoint.service', {
  ...realPP,
  createVirtualAccount: async args => {
    spy.ppCreate.push(args);
    if (provider.gate) await provider.gate;
    if (provider.ppCreate === null) throw new Error('test bug: provider.ppCreate was not set for this case');
    if (provider.ppCreate instanceof Error) throw provider.ppCreate;
    return { raw: provider.ppCreate };
  },
});

const funding = require('../src/funding/funding.controller');

/* ========================================================================== */
/*  harness                                                                   */
/* ========================================================================== */

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = payload => {
    res.body = payload;
    return res;
  };
  res.send = payload => {
    res.body = payload;
    return res;
  };
  return res;
}

async function call(handler, { user = null, method = 'POST', body = {}, headers = {}, rawBody = null } = {}) {
  const res = mockRes();
  await handler({ user, method, body, headers, rawBody }, res);
  return res;
}

const open = (user, body) => call(funding.virtualAccount, { user, body });
const state = async user => (await call(funding.virtualAccount, { user, method: 'GET' })).body.data;
const msg = res => (Array.isArray(res.body?.message) ? res.body.message.join(' ') : String(res.body?.message ?? ''));

function makeUser(id, first, last, mobile) {
  const email = `${first}.${last}@example.com`.toLowerCase();
  const user = {
    id,
    status: 1,
    firstname_enc: protect(first, 'name').enc,
    lastname_enc: protect(last, 'name').enc,
    email_enc: protect(email, 'email').enc,
    mobile_enc: protect(mobile, 'mobile').enc,
    email_idx: blindIndex(email, 'email'),
    mobile_idx: blindIndex(mobile, 'mobile'),
  };
  db.users.set(id, user);
  return user;
}

const ppAccount = (customerId, accountNumber, accountName) => ({
  status: 'success',
  message: 'Virtual account created successfully',
  customer: { customer_id: customerId, customer_name: accountName, customer_email: 'x@example.com', customer_phone_number: '08030000000' },
  bankAccounts: [{ bankCode: '20946', bankName: 'PalmPay', accountNumber, accountName, Reserved_Account_Id: `R${customerId}` }],
});

const fundingRow = txRef => db.funding.find(r => r.tx_ref === txRef);
const rowsOf = userId => db.funding.filter(r => r.user_id === userId && r.status === 'virtual_account');
const pushesTo = (userId, type) => spy.pushes.filter(p => p.userId === userId && (!type || p.type === type));
// Push the row's clock back so its hold - or its age - has passed.
function age(row, ms) {
  const past = new Date(Date.now() - ms).toISOString();
  row.raw_payload = { ...row.raw_payload, requested_at: past, last_sent_at: past };
}

const sign = raw => crypto.createHmac('sha256', 'pp-secret').update(raw.toString('utf8')).digest('hex');
const deliver = (payload, signature) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return call(funding.webhook, { body: payload, rawBody, headers: { 'paymentpoint-signature': signature ?? sign(rawBody) } });
};

/* ========================================================================== */
/*  cases                                                                     */
/* ========================================================================== */

(async () => {
  /* ---- 1  GET never provisions ----------------------------------------- */
  const ada = makeUser(1, 'Ada', 'Obi', '2348031234567');
  {
    const s = await state(ada);
    assert.deepStrictEqual(s.bankAccounts, []);
    assert.strictEqual(s.provider, 'paymentpoint');
    assert.strictEqual(s.nin_required, true);
    assert.strictEqual(s.nin_on_file, false);
    assert.strictEqual(s.available, true);
    assert.strictEqual(s.account_status, 'none');
    assert.strictEqual(s.pending, null);
    assert.strictEqual(s.options, undefined, 'one account type - nothing to choose between');
    assert.strictEqual(spy.ppCreate.length, 0, 'opening the screen must never open an account');

    // No keys: the screen is told, and a tap is refused before any call.
    delete process.env.PAYMENTPOINT_BUSINESS_ID;
    assert.strictEqual((await state(ada)).available, false);
    const refused = await open(ada, { nin: '22222222222' });
    assert.strictEqual(refused.statusCode, 503);
    assert.strictEqual(refused.body.remark, 'provider_unavailable');
    assert.strictEqual(spy.ppCreate.length, 0);
    process.env.PAYMENTPOINT_BUSINESS_ID = 'pp-biz';
  }

  /* ---- 2  bad NINs are refused before PaymentPoint is called ------------ */
  const bola = makeUser(2, 'Bola', 'Ade', '2348031234568');
  {
    let res = await open(ada, {});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.remark, 'nin_required');

    res = await open(ada, { nin: '1234567890' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.remark, 'invalid_nin');

    // Someone else's NIN slip - pending claims it too, as in kyc.controller.
    db.kyc.set(2, {
      user_id: 2,
      nin_slip_status: 'pending',
      nin_slip_number_enc: protect('11111111111', 'nin_slip').enc,
      nin_slip_number_idx: blindIndex('11111111111', 'nin_slip'),
    });
    res = await open(ada, { nin: '111-1111-1111' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'nin_in_use');
    assert.ok(spy.security.some(e => e.scope === 'funding.nin_reuse' && e.context.user_id === 1 && e.context.existing_user_id === 2));

    assert.strictEqual(spy.ppCreate.length, 0, 'no refused NIN may reach PaymentPoint');
    assert.strictEqual(rowsOf(1).length, 0, 'a NIN refused here writes no attempt');
  }

  /* ---- 3  a typed NIN opens the account; only its blind index is kept --- */
  {
    provider.ppCreate = ppAccount('CUS100', '6600000001', 'VoltPay-Ada Obi');
    const res = await open(ada, { nin: '22222222222' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    const sent = spy.ppCreate.at(-1);
    assert.strictEqual(sent.idType, 'nin');
    assert.strictEqual(sent.idNumber, '22222222222');
    assert.deepStrictEqual(sent.bankCode, ['20946']);
    assert.strictEqual(sent.businessId, 'pp-biz');
    assert.strictEqual(sent.phoneNumber, '08031234567');
    assert.strictEqual(sent.name, 'Ada Obi');

    assert.strictEqual(rowsOf(1).length, 1, 'the attempt row became the registration - one row, not two');
    const row = fundingRow('ppcust_CUS100');
    assert.strictEqual(row.status, 'virtual_account');
    assert.strictEqual(row.amount.toString(), '0');
    assert.strictEqual(row.raw_payload.provider, 'paymentpoint');
    assert.strictEqual(row.raw_payload.state, undefined, 'a registration is not pending');
    assert.strictEqual(row.raw_payload.nin_idx, blindIndex('22222222222', 'nin_slip'));
    assert.strictEqual(row.raw_payload.email_idx, blindIndex('ada.obi@example.com', 'email'));
    assert.strictEqual(row.raw_payload.phone_idx, blindIndex('08031234567', 'mobile'));
    assert.strictEqual(revealText(row.raw_payload.account_name_enc), 'VoltPay-Ada Obi');
    const stored = JSON.stringify(row);
    assert.ok(!stored.includes('22222222222'), 'the NIN itself is never stored');
    assert.ok(!stored.includes('x@example.com') && !stored.includes('08030000000'), "PaymentPoint's customer block is not kept");
    assert.ok(!stored.includes('ada.obi') && !stored.includes('08031234567'), 'what we sent is kept as blind indexes only');
    assert.ok(!stored.includes('Ada'), 'the account name is encrypted');

    assert.deepStrictEqual(res.body.data.bankAccounts, [
      { provider: 'paymentpoint', bankName: 'PalmPay', accountNumber: '6600000001', accountName: 'VoltPay-Ada Obi' },
    ]);
    assert.strictEqual(res.body.data.account_status, 'ready');
    assert.strictEqual(pushesTo(1, 'funding_account').length, 0, 'the customer was on the screen - no push');

    // ...and now that NIN is Ada's: Bola cannot open an account on it.
    const stolen = await open(bola, { nin: '22222222222' });
    assert.strictEqual(stolen.statusCode, 409);
    assert.strictEqual(stolen.body.remark, 'nin_in_use');
    assert.strictEqual(spy.ppCreate.length, 1);
  }

  /* ---- 4  an approved slip is reused, and the typed number is ignored ---- */
  const chi = makeUser(3, 'Chi', 'Eze', '2348031234569');
  {
    db.kyc.set(3, {
      user_id: 3,
      nin_slip_status: 'approved',
      nin_slip_number_enc: protect('33333333333', 'nin_slip').enc,
      nin_slip_number_idx: blindIndex('33333333333', 'nin_slip'),
    });
    const s = await state(chi);
    assert.strictEqual(s.nin_required, false);
    assert.strictEqual(s.nin_on_file, true);

    provider.ppCreate = ppAccount('CUS300', '6600000003', 'VoltPay-Chi Eze');
    const res = await open(chi, { nin: '44444444444' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    assert.strictEqual(spy.ppCreate.at(-1).idNumber, '33333333333', 'the register-checked NIN wins over anything typed');

    const noNinTyped = makeUser(30, 'Dele', 'Ojo', '2348031234599');
    db.kyc.set(30, {
      user_id: 30,
      nin_slip_status: 'approved',
      nin_slip_number_enc: protect('30303030303', 'nin_slip').enc,
      nin_slip_number_idx: blindIndex('30303030303', 'nin_slip'),
    });
    provider.ppCreate = ppAccount('CUS3030', '6600003030', 'VoltPay-Dele Ojo');
    assert.strictEqual((await open(noNinTyped, {})).statusCode, 200, 'nothing to type when the NIN is on file');
  }

  /* ---- 5  one user, one account ---------------------------------------- */
  {
    const calls = spy.ppCreate.length;
    // Whatever `provider` an older or newer client sends, there is one account.
    for (const body of [{ nin: '22222222222' }, { provider: 'budpay' }, { provider: 'paymentpoint', nin: '22222222222' }]) {
      const res = await open(ada, body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.data.bankAccounts.length, 1);
    }
    assert.strictEqual(spy.ppCreate.length, calls, 'a second request returns the account, it does not open another');
  }

  /* ---- 6  leftover and legacy rows -------------------------------------- */
  {
    // A row from a provider that was tried and dropped is not an account: its
    // number cannot credit anyone, so it is never shown - and it does not stop
    // the user opening the real one.
    const efe = makeUser(4, 'Efe', 'Uche', '2348031234570');
    insertFunding({
      user_id: 4,
      tx_ref: 'bpcust_CUS_dropped',
      status: 'virtual_account',
      amount: 0,
      raw_payload: { provider: 'budpay', account_number: '6156839504', bank_name: 'Globus Bank' },
    });
    assert.deepStrictEqual((await state(efe)).bankAccounts, []);
    provider.ppCreate = ppAccount('CUS400', '6600000004', 'VoltPay-Efe Uche');
    const res = await open(efe, { nin: '55555555555' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    assert.strictEqual(res.body.data.bankAccounts[0].accountNumber, '6600000004');

    // A row written before registrations were normalised still renders...
    const gbenga = makeUser(6, 'Gbenga', 'Ola', '2348031234572');
    insertFunding({
      user_id: 6,
      tx_ref: 'ppcust_OLD6',
      status: 'virtual_account',
      amount: 0,
      raw_payload: {
        customer: { customer_id: 'OLD6', customer_name: 'Gbenga Ola' },
        bankAccounts: [
          { bankName: 'PalmPay', accountNumber: '6600000006', accountName: 'VoltPay-Gbenga Ola' },
          { bankName: 'Opay', accountNumber: '7700000006', accountName: 'VoltPay-Gbenga Ola' },
        ],
      },
    });
    const s = await state(gbenga);
    assert.deepStrictEqual(s.bankAccounts, [
      { provider: 'paymentpoint', bankName: 'PalmPay', accountNumber: '6600000006', accountName: 'VoltPay-Gbenga Ola' },
    ], 'legacy multi-bank rows still show one account');
    assert.strictEqual(s.customer, null);

    // ...an old placeholder with no account on it is nothing at all...
    const hadi = makeUser(60, 'Hadi', 'Bala', '2348031234591');
    insertFunding({ user_id: 60, tx_ref: 'ppcust_EMPTY60', status: 'virtual_account', amount: 0, raw_payload: { bankAccounts: [] } });
    assert.deepStrictEqual((await state(hadi)).bankAccounts, []);
    assert.strictEqual((await state(hadi)).account_status, 'none');

    // ...and when PaymentPoint hands that same customer back, the placeholder
    // makes way for the real registration instead of blocking it.
    provider.ppCreate = ppAccount('EMPTY60', '6600000060', 'VoltPay-Hadi Bala');
    const reopened = await open(hadi, { nin: '60606060606' });
    assert.strictEqual(reopened.statusCode, 200, msg(reopened));
    assert.strictEqual(reopened.body.data.bankAccounts[0].accountNumber, '6600000060');
    assert.strictEqual(rowsOf(60).length, 1);
    assert.strictEqual(fundingRow('ppcust_EMPTY60').raw_payload.account_number, '6600000060');
  }

  /* ---- 7  provider refusals ---------------------------------------------- */
  const hana = makeUser(7, 'Hana', 'Musa', '2348031234573');
  {
    // PaymentPoint answers 200 with status:error - its refusal reaches the user.
    provider.ppCreate = Object.assign(new Error('Invalid NIN supplied'), { kind: 'declined', statusCode: 200 });
    let res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.remark, 'provider_declined');
    assert.strictEqual(msg(res), 'PalmPay could not open your account: Invalid NIN supplied.');

    // Our credentials: generic, and nothing about keys.
    provider.ppCreate = Object.assign(new Error('Unauthorized. Invalid API key.'), { kind: 'http', statusCode: 401 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.remark, 'provider_unavailable');
    assert.strictEqual(msg(res), 'PalmPay accounts are not available right now. Please try again in a few minutes.');

    // An HTML error page is never shown as a message.
    provider.ppCreate = Object.assign(new Error('<html><body>502 Bad Gateway</body></html>'), { kind: 'http', statusCode: 400 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!msg(res).includes('<'));

    // Our own misconfiguration does not leak env names.
    provider.ppCreate = Object.assign(new Error('Missing required env: PAYMENTPOINT_API_KEY'), { kind: 'config', statusCode: 503 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);
    assert.ok(!/env|PAYMENTPOINT/.test(msg(res)));

    // A request that never left: nothing can exist.
    provider.ppCreate = Object.assign(new Error('connect ECONNREFUSED'), { kind: 'unreachable', statusCode: 503 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);

    assert.strictEqual(rowsOf(7).length, 0, 'a refused open leaves no attempt behind - the NIN is not held');

    const { providerFailure, readableProviderText } = funding.__test;
    assert.strictEqual(providerFailure({ statusCode: 429 }).status, 503);
    assert.strictEqual(readableProviderText('x'.repeat(201)), '');
    assert.strictEqual(readableProviderText('BVN is mandatory'), 'BVN is mandatory.');
  }

  /* ---- 8  a double tap opens one account -------------------------------- */
  const ife = makeUser(8, 'Ife', 'Ade', '2348031234574');
  {
    let release;
    provider.gate = new Promise(resolve => (release = resolve));
    provider.ppCreate = ppAccount('CUS800', '6600000008', 'VoltPay-Ife Ade');
    const before = spy.ppCreate.length;

    const first = open(ife, { nin: '80808080808' });
    const second = open(ife, { nin: '80808080808' });
    // Let both reach the lock before PaymentPoint answers.
    await new Promise(resolve => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    provider.gate = null;

    assert.deepStrictEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    const loser = results.find(r => r.statusCode === 409).body.remark;
    assert.ok(['account_in_progress', 'account_pending'].includes(loser), loser);
    assert.strictEqual(spy.ppCreate.length - before, 1, 'exactly one provider call');
    assert.strictEqual(rowsOf(8).length, 1);
  }

  /* ---- 8b  ...and across instances, without lying during an outage ------ */
  {
    fakeRedis.isEnabled = () => true;
    fakeRedis.isHealthy = () => true;

    // Another instance holds the lock: refused before any provider call.
    const jide = makeUser(9, 'Jide', 'Ola', '2348031234575');
    provider.ppCreate = ppAccount('CUS900', '6600000009', 'VoltPay-Jide Ola');
    fakeRedis.pipeline = async () => [null, '1'];
    const before = spy.ppCreate.length;
    let res = await open(jide, { nin: '90909090909' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'account_in_progress');
    assert.strictEqual(spy.ppCreate.length, before);
    assert.strictEqual(rowsOf(9).length, 0, 'no attempt is written without the lock');

    // Redis answered nothing. That is an outage, not a holder: telling the
    // customer "already being set up" would be false, so they are served.
    fakeRedis.pipeline = async () => null;
    res = await open(jide, { nin: '90909090909' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    assert.strictEqual(spy.ppCreate.length, before + 1);

    // Won the lock: it is released once the account exists.
    const kola = makeUser(10, 'Kola', 'Ade', '2348031234576');
    const released = [];
    provider.ppCreate = ppAccount('CUS1000', '6600000010', 'VoltPay-Kola Ade');
    fakeRedis.pipeline = async () => ['OK', '1'];
    fakeRedis.del = async (...keys) => {
      released.push(...keys);
      return 1;
    };
    res = await open(kola, { nin: '10101010101' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(released, ['lock:funding-va:10']);

    fakeRedis.isEnabled = () => false;
    fakeRedis.isHealthy = () => false;
  }

  /* ---- 9  the PaymentPoint webhook credits once ------------------------- */
  {
    // Ada holds ppcust_CUS100.
    const body = {
      notification_status: 'payment_successful',
      transaction_id: 'PPTX1',
      amount_paid: 2000,
      settlement_amount: 1990,
      settlement_fee: 10,
      customer: { customer_id: 'CUS100' },
      sender: { name: 'Tunde Ojo' },
    };

    // A forged delivery is refused and credits nothing.
    let res = await deliver(body, 'deadbeef');
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(spy.deltas.length, 0);
    assert.ok(spy.security.some(e => e.scope === 'webhook.bad_signature'));

    res = await deliver(body);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(spy.deltas, [{ wallet: 'user', ownerId: 1, delta: '1990' }]);
    const ledger = db.ledger.find(l => l.trx === 'pp_PPTX1');
    assert.strictEqual(ledger.amount.toString(), '1990');
    assert.strictEqual(ledger.charge.toString(), '10');
    assert.strictEqual(ledger.total_amount.toString(), '2000');
    assert.strictEqual(ledger.remark, 'fund_account');
    assert.strictEqual(ledger.other_data.note, 'PaymentPoint');
    assert.ok(!JSON.stringify(ledger.meta).includes('Tunde'), 'meta carries ids, never a name');
    assert.strictEqual(spy.pushes.at(-1).message, 'Tunde Ojo sent you ₦1,990.00');
    assert.ok(!JSON.stringify(spy.pushes.at(-1).data).includes('Tunde'), 'the persisted notification names nobody');

    // Delivered again: acknowledged, not credited, not re-announced.
    const pushes = spy.pushes.length;
    res = await deliver(body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(spy.deltas.length, 1, 'a redelivered webhook credits nothing');
    assert.strictEqual(spy.pushes.length, pushes);

    // A pending row that already exists uncredited is claimed, not skipped.
    // With create-and-catch inside the transaction this was unreachable on
    // Postgres: the caught P2002 had already aborted it.
    insertFunding({ user_id: 1, tx_ref: 'pp_PPTX2', amount: 0, currency: 'NGN', status: 'pending', raw_payload: null });
    res = await deliver({ ...body, transaction_id: 'PPTX2' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(spy.deltas.length, 2);
    assert.ok(fundingRow('pp_PPTX2').credited_at instanceof Date);
  }

  /* ---- 10  accepted, no account yet: pending, then the account event ---- */
  {
    provider.ppCreate = { status: 'success', message: 'Account creation in progress', customer: { customer_id: 'CUS700' }, bankAccounts: [] };
    const res = await open(hana, { nin: '77777777777' });
    assert.strictEqual(res.statusCode, 409, 'pending is a 4xx, so every installed build shows its message');
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.ok(/verifying your details/.test(msg(res)), msg(res));
    assert.strictEqual(res.body.data.account_status, 'pending');
    assert.deepStrictEqual(res.body.data.bankAccounts, []);
    assert.strictEqual(res.body.data.pending.can_retry, false);

    const row = fundingRow('ppcust_CUS700');
    assert.ok(row, 'keyed by the customer id, so the webhook finds it in one lookup');
    assert.strictEqual(row.raw_payload.state, 'pending');
    assert.strictEqual(row.raw_payload.last_outcome, 'provider_pending');
    assert.strictEqual(row.raw_payload.nin_idx, blindIndex('77777777777', 'nin_slip'));
    assert.strictEqual(rowsOf(7).length, 1);

    // PaymentPoint finishes the account and says so - no amount on it.
    let hook = await deliver({
      event: 'virtual_account.created',
      status: 'success',
      customer: { customer_id: 'CUS700' },
      bankAccounts: [{ bankCode: '20946', bankName: 'PalmPay', accountNumber: '6600000007', accountName: 'VoltPay-Hana Musa' }],
    });
    assert.strictEqual(hook.statusCode, 200);
    const s = await state(hana);
    assert.strictEqual(s.account_status, 'ready');
    assert.deepStrictEqual(s.bankAccounts, [
      { provider: 'paymentpoint', bankName: 'PalmPay', accountNumber: '6600000007', accountName: 'VoltPay-Hana Musa' },
    ]);
    assert.strictEqual(rowsOf(7).length, 1, 'the pending row became the registration');
    assert.strictEqual(fundingRow('ppcust_CUS700').raw_payload.nin_idx, blindIndex('77777777777', 'nin_slip'), 'the NIN claim survives');
    assert.strictEqual(pushesTo(7, 'funding_account').length, 1, 'the customer was told to wait, so they are told it is ready');
    assert.strictEqual(pushesTo(7, 'funding_account')[0].clientMessageId, 'va_ready:7');

    // Delivered again: nothing new.
    hook = await deliver({
      event: 'virtual_account.created',
      customer: { customer_id: 'CUS700' },
      bankAccounts: [{ bankCode: '20946', bankName: 'PalmPay', accountNumber: '6600000007', accountName: 'VoltPay-Hana Musa' }],
    });
    assert.strictEqual(hook.statusCode, 200);
    assert.strictEqual(pushesTo(7, 'funding_account').length, 1);
  }

  /* ---- 11  a timeout is pending, not a failure --------------------------- */
  const kemi = makeUser(11, 'Kemi', 'Bello', '2348031234577');
  {
    provider.ppCreate = Object.assign(new Error('PaymentPoint request timed out'), { kind: 'timeout', statusCode: 504 });
    let res = await open(kemi, { nin: '12121212121' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.ok(/still confirming/.test(msg(res)), msg(res));

    assert.strictEqual(rowsOf(11).length, 1, 'the attempt was written before PaymentPoint was asked, and kept');
    const row = rowsOf(11)[0];
    assert.ok(row.tx_ref.startsWith('ppreq_11_'), row.tx_ref);
    assert.strictEqual(row.raw_payload.last_outcome, 'timeout');
    assert.strictEqual(row.raw_payload.sends, 1);

    let s = await state(kemi);
    assert.strictEqual(s.account_status, 'pending');
    assert.strictEqual(s.pending.can_retry, false);
    assert.ok(s.pending.retry_in_seconds > 0 && s.pending.retry_in_seconds <= 120);

    // A tap inside the hold is told to wait - no NIN asked, PaymentPoint not called.
    const calls = spy.ppCreate.length;
    res = await open(kemi, {});
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.strictEqual(spy.ppCreate.length, calls);

    // While it might exist, the NIN stays claimed.
    const tobi = makeUser(111, 'Tobi', 'Ade', '2348031234111');
    res = await open(tobi, { nin: '12121212121' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'nin_in_use');

    // The hold passes; the retry finds the account. Same row, one row.
    age(row, 3 * 60_000);
    s = await state(kemi);
    assert.strictEqual(s.pending.can_retry, true);
    assert.strictEqual(s.pending.retry_in_seconds, 0);

    // A refused retry keeps the row - the first send's outcome is still open.
    provider.ppCreate = Object.assign(new Error('Invalid NIN'), { kind: 'declined', statusCode: 200 });
    res = await open(kemi, { nin: '12121212122' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(rowsOf(11).length, 1);
    assert.strictEqual(rowsOf(11)[0].raw_payload.last_outcome, 'refused');
    assert.strictEqual(
      rowsOf(11)[0].raw_payload.nin_idx,
      blindIndex('12121212121', 'nin_slip'),
      'a send that opened nothing does not move the claim off the one that might have',
    );
    assert.strictEqual((await state(kemi)).pending.can_retry, true, 'a refusal is the customer\'s to fix at once');

    provider.ppCreate = ppAccount('CUS1100', '6600000011', 'VoltPay-Kemi Bello');
    res = await open(kemi, { nin: '12121212121' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    assert.strictEqual(res.body.data.bankAccounts[0].accountNumber, '6600000011');
    assert.strictEqual(rowsOf(11).length, 1);
    assert.strictEqual(rowsOf(11)[0].tx_ref, 'ppcust_CUS1100', 'renamed onto the key the webhook looks up');
    assert.strictEqual(rowsOf(11)[0].raw_payload.nin_idx, blindIndex('12121212121', 'nin_slip'));
  }

  /* ---- 12  "already exists": ops are paged once; the export links it ---- */
  const lola = makeUser(12, 'Lola', 'Ade', '2348031234578');
  {
    provider.ppCreate = Object.assign(new Error('The given data was invalid.'), {
      kind: 'http',
      statusCode: 422,
      providerErrors: ['The email has already been taken.'],
    });
    let res = await open(lola, { nin: '13131313131' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.ok(/linking it/.test(msg(res)), msg(res));

    const row = rowsOf(12)[0];
    assert.strictEqual(row.raw_payload.last_outcome, 'exists_at_provider');
    assert.ok(row.raw_payload.alerted_at);
    const paged = spy.alerts.filter(a => a.userId === 12 && a.action === 'virtual_account');
    assert.strictEqual(paged.length, 1);
    assert.ok(/funding:reconcile/.test(paged[0].message));
    assert.ok(!JSON.stringify(paged).includes('lola'), 'ids only');

    // PaymentPoint has it: asking again soon cannot help, so it waits longer.
    const s = await state(lola);
    assert.ok(s.pending.retry_in_seconds > 120);

    // The export row - PaymentPoint's record of what we sent.
    const exportRow = {
      customerId: 'CUS1200',
      account: { accountNumber: '6600000012', accountName: 'VoltPay-Lola Ade', bankName: 'PalmPay', bankCode: '20946' },
      contact: { email: 'lola.ade@example.com', phone: '08031234578' },
    };
    let out = await funding.linkProviderAccount(exportRow, { apply: false });
    assert.strictEqual(out.outcome, 'would_link');
    assert.strictEqual(out.userId, 12);
    assert.strictEqual(rowsOf(12)[0].raw_payload.state, 'pending', 'a dry run writes nothing');
    assert.strictEqual(pushesTo(12, 'funding_account').length, 0);

    out = await funding.linkProviderAccount(exportRow, { apply: true });
    assert.strictEqual(out.outcome, 'linked');
    assert.strictEqual((await state(lola)).bankAccounts[0].accountNumber, '6600000012');
    assert.strictEqual(rowsOf(12).length, 1);
    assert.strictEqual(rowsOf(12)[0].tx_ref, 'ppcust_CUS1200');
    assert.strictEqual(pushesTo(12, 'funding_account').length, 1);

    out = await funding.linkProviderAccount(exportRow, { apply: true });
    assert.strictEqual(out.outcome, 'already_linked');
    assert.strictEqual(pushesTo(12, 'funding_account').length, 1, 'a second run announces nothing');

    // Somebody else's number in the export is never shown to this user.
    out = await funding.linkProviderAccount({ ...exportRow, account: { ...exportRow.account, accountNumber: '6600009999' } }, { apply: true });
    assert.strictEqual(out.outcome, 'has_other_account');
    assert.strictEqual((await state(lola)).bankAccounts[0].accountNumber, '6600000012');
  }

  /* ---- 13  a payment for a customer we never recorded -------------------- */
  const musa = makeUser(13, 'Musa', 'Garba', '2348031234579');
  {
    const payment = (txId, customer, extra = {}) => ({
      notification_status: 'payment_successful',
      transaction_id: txId,
      amount_paid: 5000,
      settlement_amount: 4950,
      settlement_fee: 50,
      customer,
      sender: { name: 'Ngozi Eke', account_number: '0123456789' },
      ...extra,
    });

    // Opened before attempts were recorded: no row anywhere. Email AND phone
    // both lead to Musa, so it is his - credited, and recorded.
    let res = await deliver(
      payment('PPTX13', { customer_id: 'CUS1300', email: 'musa.garba@example.com', phone: '08031234579' }, {
        receiver: { account_number: '6600000013', name: 'VoltPay-Musa Garba' },
      }),
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(spy.deltas.at(-1), { wallet: 'user', ownerId: 13, delta: '4950' });
    const s = await state(musa);
    assert.strictEqual(s.bankAccounts[0].accountNumber, '6600000013', 'the account it landed in - never the sender\'s');
    assert.strictEqual(s.bankAccounts[0].accountName, 'VoltPay-Musa Garba');
    assert.ok(fundingRow('ppcust_CUS1300'), 'the next payment is a one-lookup credit');
    assert.strictEqual(pushesTo(13, 'funding_account').length, 1);
    assert.strictEqual(pushesTo(13, 'credit_alert').length, 1);

    const deltas = spy.deltas.length;
    res = await deliver(
      payment('PPTX13', { customer_id: 'CUS1300', email: 'musa.garba@example.com', phone: '08031234579' }, {
        receiver: { account_number: '6600000013' },
      }),
    );
    assert.strictEqual(spy.deltas.length, deltas, 'redelivered: credited once');

    // One identifier is not enough - it can have changed hands since.
    const alerts = spy.alerts.length;
    res = await deliver(payment('PPTX14', { customer_id: 'CUS1400', email: 'kola.ade@example.com' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(spy.deltas.length, deltas, 'not credited on an email alone');
    assert.strictEqual(spy.alerts.length, alerts + 1);
    assert.strictEqual(spy.alerts.at(-1).reference, 'pp_PPTX14');
    assert.strictEqual(spy.alerts.at(-1).amount, '4950');

    // The email says Ada, the phone says Bola: nobody.
    res = await deliver(payment('PPTX15', { customer_id: 'CUS1500', email: 'ada.obi@example.com', phone: '08031234568' }));
    assert.strictEqual(spy.deltas.length, deltas, 'two people implicated is nobody');
    assert.ok(/more than one/.test(spy.alerts.at(-1).message));
    assert.ok(!fundingRow('ppcust_CUS1500'));
    assert.ok(!JSON.stringify(spy.alerts.slice(alerts)).includes('example.com'), 'alerts carry ids, never an email');
  }

  /* ---- 14  a payment into a pending customer finishes its account -------- */
  const nkem = makeUser(14, 'Nkem', 'Obi', '2348031234580');
  {
    provider.ppCreate = { status: 'pending', customer: { customer_id: 'CUS1400B' } };
    let res = await open(nkem, { nin: '14141414141' });
    assert.strictEqual(res.body.remark, 'account_pending');

    res = await deliver({
      notification_status: 'payment_successful',
      transaction_id: 'PPTX16',
      amount_paid: 1000,
      customer: { customer_id: 'CUS1400B' },
      receiver: { account_number: '6600000014', account_name: 'VoltPay-Nkem Obi' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(spy.deltas.at(-1), { wallet: 'user', ownerId: 14, delta: '1000' });
    assert.strictEqual((await state(nkem)).bankAccounts[0].accountNumber, '6600000014');
    assert.strictEqual(pushesTo(14, 'funding_account').length, 1);

    // A payment-shaped body is never an account event, whatever its amount:
    // its envelope can carry the SENDER's number, and showing that as the
    // customer's account would send their transfers to a stranger.
    const rita = makeUser(20, 'Rita', 'Uzo', '2348031234584');
    provider.ppCreate = { status: 'pending', customer: { customer_id: 'CUS2000' } };
    await open(rita, { nin: '20202020202' });
    res = await deliver({
      notification_status: 'payment_failed',
      transaction_id: 'PPTX20',
      amount_paid: 0,
      customer: { customer_id: 'CUS2000' },
      account_number: '0123456789',
      account_name: 'Sender Person',
    });
    assert.strictEqual(res.statusCode, 200);
    const s = await state(rita);
    assert.strictEqual(s.account_status, 'pending', "the sender's number is never the customer's account");
    assert.deepStrictEqual(s.bankAccounts, []);
  }

  /* ---- 15  the shapes PaymentPoint might answer in ----------------------- */
  {
    const shapes = [
      // a `data` envelope, snake_case, status: true, `customer.id`
      [{ status: true, data: { customer: { id: 'CUS1501' }, bank_accounts: [{ bank_code: '20946', bank_name: 'PalmPay', account_number: '6600001501', account_name: 'VoltPay-A' }] } }, '6600001501'],
      // one account object, not a list
      [{ status: 'Success', data: { customerId: 'CUS1502', account: { accountNumber: '6600001502', accountName: 'VoltPay-B', bankName: 'PalmPay' } } }, '6600001502'],
      // two banks back: the PalmPay one
      [{ status: 'success', customer: { customer_id: 'CUS1503' }, bankAccounts: [{ bankName: 'Opay', accountNumber: '7700001503' }, { bankName: 'PalmPay', bankCode: '20946', accountNumber: '6600001503' }] }, '6600001503'],
    ];
    let id = 150;
    for (const [body, expected] of shapes) {
      const u = makeUser(id, 'Shape', `Case${id}`, `23480312${String(id).padStart(5, '0')}`);
      provider.ppCreate = body;
      const res = await open(u, { nin: `150000${String(id).padStart(5, '0')}` });
      assert.strictEqual(res.statusCode, 200, `${JSON.stringify(body)} -> ${msg(res)}`);
      assert.strictEqual(res.body.data.bankAccounts[0].accountNumber, expected);
      id += 1;
    }

    // Not a NUBAN - a reserved-account id is nothing anybody can pay into.
    const u4 = makeUser(160, 'Shape', 'Nuban', '2348031216000');
    provider.ppCreate = { status: 'success', customer: { customer_id: 'CUS1504' }, bankAccounts: [{ accountNumber: 'R1504', bankName: 'PalmPay' }] };
    let res = await open(u4, { nin: '16000000000' });
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.deepStrictEqual(res.body.data.bankAccounts, []);

    // A refusal whose body quotes the account it already holds is that account.
    const u5 = makeUser(161, 'Shape', 'Quoted', '2348031216100');
    provider.ppCreate = Object.assign(new Error('Customer already exists'), {
      kind: 'http',
      statusCode: 409,
      paymentpoint: { status: 'error', message: 'Customer already exists', data: { customer: { customer_id: 'CUS1505' }, bankAccounts: [{ accountNumber: '6600001505', bankName: 'PalmPay' }] } },
    });
    res = await open(u5, { nin: '16100000000' });
    assert.strictEqual(res.statusCode, 200, msg(res));
    assert.strictEqual(res.body.data.bankAccounts[0].accountNumber, '6600001505');
  }

  /* ---- 16  a failure we cannot read is assumed to have opened something -- */
  const obi = makeUser(17, 'Obi', 'Nna', '2348031234581');
  {
    provider.ppCreate = new Error('socket hang up');
    const res = await open(obi, { nin: '17171717171' });
    assert.strictEqual(res.body.remark, 'account_pending');
    assert.strictEqual(rowsOf(17)[0].raw_payload.last_outcome, 'server_error');

    const { classifyCreate } = funding.__test;
    const kinds = [
      [{ kind: 'unreadable', statusCode: 502 }, 'pending'],
      [{ kind: 'network', statusCode: 504 }, 'pending'],
      [{ kind: 'http', statusCode: 500 }, 'pending'],
      [{ kind: 'http', statusCode: 408 }, 'pending'],
      [{ kind: 'http', statusCode: 429 }, 'refused'],
      [{ kind: 'http', statusCode: 400, message: 'Customer does not exist' }, 'refused'],
    ];
    for (const [fields, expected] of kinds) {
      const verdict = classifyCreate({ raw: null, error: Object.assign(new Error(fields.message || 'x'), fields) });
      assert.strictEqual(verdict.kind, expected, JSON.stringify(fields));
    }
  }

  /* ---- 17  the sweep --------------------------------------------------- */
  {
    const row = rowsOf(17)[0];
    // Fresh: nothing to do yet.
    let out = await funding.sweepPendingAccounts();
    assert.strictEqual(out.nudged, 0);

    // Eleven minutes on, with nothing resolved: the customer's tap would
    // finish it, and the NIN is theirs to send again, so they are told - once.
    age(row, 11 * 60_000);
    out = await funding.sweepPendingAccounts();
    assert.strictEqual(out.nudged, 1);
    const nudge = pushesTo(17, 'funding_account');
    assert.strictEqual(nudge.length, 1);
    assert.ok(/Try Again/.test(nudge[0].message));
    out = await funding.sweepPendingAccounts();
    assert.strictEqual(out.nudged, 0, 'once');

    // Thirty-one minutes: ops are paged, once, in one alert.
    age(rowsOf(17)[0], 31 * 60_000);
    const before = spy.alerts.length;
    out = await funding.sweepPendingAccounts();
    assert.ok(out.alerted >= 1);
    assert.strictEqual(spy.alerts.length, before + 1, 'one summary alert, not one per row');
    assert.ok(spy.alerts.at(-1).context.row_ids.includes(row.id));
    out = await funding.sweepPendingAccounts();
    assert.strictEqual(out.alerted, 0);

    // A row that turns ready between the sweep's read and its write is not
    // put back to pending: the write is guarded on updated_at.
    const pip = makeUser(18, 'Pip', 'Ola', '2348031234582');
    provider.ppCreate = Object.assign(new Error('timed out'), { kind: 'timeout', statusCode: 504 });
    await open(pip, { nin: '18181818181' });
    const live = rowsOf(18)[0];
    age(live, 45 * 60_000);
    const stale = copy(live);
    const linked = await funding.linkProviderAccount(
      { customerId: 'CUS1800', account: { accountNumber: '6600000018', accountName: 'VoltPay-Pip Ola' }, contact: { email: 'pip.ola@example.com', phone: '08031234582' } },
      { apply: true },
    );
    assert.strictEqual(linked.outcome, 'linked');

    const realFindMany = fakePrisma.fundingTransaction.findMany;
    fakePrisma.fundingTransaction.findMany = async () => [stale];
    const alertsBefore = spy.alerts.length;
    out = await funding.sweepPendingAccounts();
    fakePrisma.fundingTransaction.findMany = realFindMany;
    assert.strictEqual(out.alerted, 0);
    assert.strictEqual(spy.alerts.length, alertsBefore);
    assert.strictEqual((await state(pip)).bankAccounts[0].accountNumber, '6600000018', 'still ready');
    assert.strictEqual(rowsOf(18)[0].raw_payload.alerted_at, undefined);
  }

  /* ---- 18  PaymentPoint's export, read and linked ------------------------ */
  {
    const { parseCsv, toRecord } = require('../scripts/reconcile-paymentpoint-accounts');
    // Opened before attempts were recorded: nothing of Quinn's on our side.
    const quinn = makeUser(19, 'Quinn', 'Eze', '2348031234583');
    const csv =
      'Customer ID,Customer Name,Email,Phone Number,Bank Name,"Account Number"\r\n' +
      'CUS1900,"Eze, Quinn",quinn.eze@example.com,08031234583,PalmPay,6600000019\r\n' +
      'CUS1901,Somebody,nobody@example.com,,PalmPay,6600000020\r\n' +
      'CUS1902,Broken,quinn.eze@example.com,08031234583,PalmPay,R-1902\r\n';
    const { headers, records } = parseCsv(csv);
    assert.deepStrictEqual(headers, ['Customer ID', 'Customer Name', 'Email', 'Phone Number', 'Bank Name', 'Account Number']);
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[0]['Customer Name'], 'Eze, Quinn', 'a quoted comma is part of the field');

    const [r1, r2, r3] = records.map(toRecord);
    assert.strictEqual(r1.customerId, 'CUS1900');
    assert.strictEqual(r1.account.accountNumber, '6600000019');
    assert.deepStrictEqual(r1.contact, { email: 'quinn.eze@example.com', phone: '08031234583' });
    assert.strictEqual(r3.account, null, 'not a NUBAN');

    assert.strictEqual((await funding.linkProviderAccount(r1, { apply: true })).outcome, 'linked');
    assert.strictEqual((await state(quinn)).bankAccounts[0].accountNumber, '6600000019');
    assert.strictEqual(fundingRow('ppcust_CUS1900').user_id, 19);
    assert.strictEqual(pushesTo(19, 'funding_account').length, 1);
    assert.strictEqual((await funding.linkProviderAccount(r2, { apply: true })).outcome, 'unmatched', 'an email alone links nobody');
    assert.strictEqual((await funding.linkProviderAccount(r3, { apply: true })).outcome, 'invalid');

    // A saved createVirtualAccount answer is an export row too.
    const saved = toRecord(ppAccount('CUS1903', '6600000021', 'VoltPay-X'));
    assert.strictEqual(saved.customerId, 'CUS1903');
    assert.strictEqual(saved.account.accountNumber, '6600000021');
    assert.deepStrictEqual(saved.contact, { email: 'x@example.com', phone: '08030000000' });
  }

  console.log('fundingAccounts.test.js passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
