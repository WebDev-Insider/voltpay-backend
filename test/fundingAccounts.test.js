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
 *    7  provider failures read as something the customer can act on
 *    8  a double tap opens one account - and a Redis blip is not a "no"
 *    9  the PaymentPoint webhook credits once, however often it is delivered
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

const { protect, blindIndex, revealText } = require('../src/helpers/pii.helper');

/* ========================================================================== */
/*  the fake database                                                         */
/* ========================================================================== */

const db = { funding: [], kyc: new Map(), users: new Map(), ledger: [], nextId: 1 };

function matches(row, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!cond.some(c => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) {
        if (value === cond.not) return false;
        continue;
      }
      if ('path' in cond) {
        const got = cond.path.reduce((o, p) => (o == null ? undefined : o[p]), value);
        if (got !== cond.equals) return false;
        continue;
      }
      throw new Error(`fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
    }
    if (value !== cond) return false;
  }
  return true;
}

const P2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (`tx_ref`)'), { code: 'P2002' });

function insertFunding(data) {
  const row = { id: db.nextId++, credited_at: null, created_at: new Date(), ...data };
  db.funding.push(row);
  return row;
}

const fakePrisma = {
  fundingTransaction: {
    async findMany({ where, orderBy } = {}) {
      const rows = db.funding.filter(r => matches(r, where));
      if (orderBy?.id === 'desc') rows.sort((a, b) => b.id - a.id);
      return rows.map(r => ({ ...r }));
    },
    async findFirst({ where } = {}) {
      const row = db.funding.find(r => matches(r, where));
      return row ? { ...row } : null;
    },
    async findUnique({ where }) {
      const row = db.funding.find(r => r.tx_ref === where.tx_ref);
      return row ? { ...row } : null;
    },
    async create({ data }) {
      if (db.funding.some(r => r.tx_ref === data.tx_ref)) throw P2002();
      return { ...insertFunding(data) };
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
      rows.forEach(r => Object.assign(r, data));
      return { count: rows.length };
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

const spy = { deltas: [], pushes: [], security: [], ppCreate: [] };

// What the next PaymentPoint create answers. An Error is thrown; `gate` holds
// the call open until released, for the double-tap case.
const provider = { ppCreate: null, gate: null };

stub('../database/prisma', fakePrisma);
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (tx, wallet, ownerId, delta) => {
    spy.deltas.push({ wallet, ownerId: Number(ownerId), delta: delta.toString() });
  },
});
stub('../src/services/notify.service', {
  notifyUser: async args => {
    spy.pushes.push(args);
    return true;
  },
});
stub('../src/services/alerts.service', {
  securityEvent: (scope, message, context) => spy.security.push({ scope, context }),
  paymentFailure: () => null,
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
// webhook still runs the real signature check.
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
  const user = {
    id,
    firstname_enc: protect(first, 'name').enc,
    lastname_enc: protect(last, 'name').enc,
    email_enc: protect(`${first}.${last}@example.com`.toLowerCase(), 'email').enc,
    mobile_enc: protect(mobile, 'mobile').enc,
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

    const row = fundingRow('ppcust_CUS100');
    assert.strictEqual(row.status, 'virtual_account');
    assert.strictEqual(row.amount.toString(), '0');
    assert.strictEqual(row.raw_payload.provider, 'paymentpoint');
    assert.strictEqual(row.raw_payload.nin_idx, blindIndex('22222222222', 'nin_slip'));
    assert.strictEqual(revealText(row.raw_payload.account_name_enc), 'VoltPay-Ada Obi');
    const stored = JSON.stringify(row);
    assert.ok(!stored.includes('22222222222'), 'the NIN itself is never stored');
    assert.ok(!stored.includes('x@example.com') && !stored.includes('08030000000'), "PaymentPoint's customer block is not kept");
    assert.ok(!stored.includes('Ada'), 'the account name is encrypted');

    assert.deepStrictEqual(res.body.data.bankAccounts, [
      { provider: 'paymentpoint', bankName: 'PalmPay', accountNumber: '6600000001', accountName: 'VoltPay-Ada Obi' },
    ]);

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

    // ...and an old placeholder with no account on it is nothing at all.
    const hana0 = makeUser(60, 'Hadi', 'Bala', '2348031234591');
    insertFunding({ user_id: 60, tx_ref: 'ppcust_EMPTY60', status: 'virtual_account', amount: 0, raw_payload: { bankAccounts: [] } });
    assert.deepStrictEqual((await state(hana0)).bankAccounts, []);
  }

  /* ---- 7  provider failures ---------------------------------------------- */
  const hana = makeUser(7, 'Hana', 'Musa', '2348031234573');
  {
    // PaymentPoint answers 200 with status:error - its refusal reaches the user.
    provider.ppCreate = Object.assign(new Error('Invalid NIN supplied'), { statusCode: 200 });
    let res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.remark, 'provider_declined');
    assert.strictEqual(msg(res), 'PalmPay could not open your account: Invalid NIN supplied.');

    // Our credentials: generic, and nothing about keys.
    provider.ppCreate = Object.assign(new Error('Unauthorized. Invalid API key.'), { statusCode: 401 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.remark, 'provider_unavailable');
    assert.strictEqual(msg(res), 'PalmPay accounts are not available right now. Please try again in a few minutes.');

    // An HTML error page is never shown as a message.
    provider.ppCreate = Object.assign(new Error('<html><body>502 Bad Gateway</body></html>'), { statusCode: 400 });
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!msg(res).includes('<'));

    // Our own misconfiguration does not leak env names.
    provider.ppCreate = new Error('Missing required env: PAYMENTPOINT_API_KEY');
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);
    assert.ok(!/env|PAYMENTPOINT/.test(msg(res)));

    // A response with no account in it is an outage, not an account.
    provider.ppCreate = { status: 'success', customer: { customer_id: 'CUS700' }, bankAccounts: [] };
    res = await open(hana, { nin: '88888888888' });
    assert.strictEqual(res.statusCode, 503);

    assert.strictEqual(db.funding.filter(r => r.user_id === 7).length, 0, 'a failed open leaves no registration behind');

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
    assert.strictEqual(results.find(r => r.statusCode === 409).body.remark, 'account_in_progress');
    assert.strictEqual(spy.ppCreate.length - before, 1, 'exactly one provider call');
    assert.strictEqual(db.funding.filter(r => r.user_id === 8).length, 1);
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
    const sign = raw => crypto.createHmac('sha256', 'pp-secret').update(raw.toString('utf8')).digest('hex');
    const deliver = (payload, signature) => {
      const rawBody = Buffer.from(JSON.stringify(payload));
      return call(funding.webhook, { body: payload, rawBody, headers: { 'paymentpoint-signature': signature ?? sign(rawBody) } });
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

  console.log('fundingAccounts.test.js passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
