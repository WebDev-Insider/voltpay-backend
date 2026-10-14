/**
 * node test/bettingFlow.test.js
 *
 * The betting money path, end to end through POST /verify-pin, against a fake
 * database and a stubbed Payvessel - no network, no Redis, no Postgres.
 *
 *   1. The wallet is reserved *before* Payvessel hears anything, with the guard
 *      in the SQL. The rail used to order first and debit after, and two
 *      confirms on one pending payload could both fund the bookmaker while only
 *      one debit landed - a free top-up out of our Payvessel wallet.
 *   2. Every order that did not land is refunded with a visible credit leg, and
 *      an order whose answer was lost is asked about before it is refunded.
 *   3. An outage reads as one: never "fetch failed", never the provider's name.
 *   4. The receipt answers from the ledger once a row is settled, and a
 *      Payvessel hiccup never breaks it.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';
process.env.PUBLIC_BASE_URL = 'https://voltpay.example';

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
const db = { users: new Map(), ledger: [] };
const events = [];

const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
const num = v => Number(v?.toString?.() ?? v ?? 0);
const P2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (`trx`)'), { code: 'P2002' });

const fakePrisma = {
  user: {
    async findUnique({ where }) {
      return clone(db.users.get(Number(where.id)));
    },
    // The conditional reserve. The guard is the whole point, so the fake
    // enforces it exactly as the SQL would.
    async updateMany({ where, data }) {
      const user = db.users.get(Number(where.id));
      if (!user) return { count: 0 };
      if (where.balance?.gte !== undefined && !(user.balance >= num(where.balance.gte))) return { count: 0 };
      user.balance = Math.round((user.balance - num(data.balance.decrement)) * 100) / 100;
      events.push('reserve');
      return { count: 1 };
    },
    async update({ where, data }) {
      const user = db.users.get(Number(where.id));
      Object.assign(user, data);
      return clone(user);
    },
  },
  walletTransaction: {
    async findUnique({ where }) {
      return clone(db.ledger.find(r => r.trx === where.trx));
    },
    async create({ data }) {
      if (db.ledger.some(r => r.trx === data.trx)) throw P2002();
      const row = { ...clone(data), created_at: new Date().toISOString() };
      db.ledger.push(row);
      return clone(row);
    },
    async update({ where, data }) {
      const row = db.ledger.find(r => r.trx === where.trx);
      Object.assign(row, clone(data));
      return clone(row);
    },
  },
  $transaction: async fn => fn(fakePrisma),
};

/* ------------------------------------------------------- module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { alerts: [], cleared: [], created: [], verified: [] };
let pendingPayload = null;

// What Payvessel answers next. An Error is thrown.
const payvessel = { create: null, verify: null };

stub('../database/prisma', fakePrisma);
stub('../src/funding/payvesselBiller.service', {
  MIN_AMOUNT: 100,
  listBettingCompanies: async () => [],
  resolveBettingItemId: async () => 'ITEM-RESOLVED',
  validateAccount: async () => '',
  createOrder: async args => {
    events.push('order');
    spy.created.push(args);
    if (payvessel.create instanceof Error) throw payvessel.create;
    return payvessel.create;
  },
  verifyOrder: async ref => {
    spy.verified.push(ref);
    if (payvessel.verify instanceof Error) throw payvessel.verify;
    return payvessel.verify;
  },
});
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (tx, wallet, ownerId, delta) => {
    const user = db.users.get(Number(ownerId));
    user.balance = Math.round((user.balance + num(delta)) * 100) / 100;
    return clone(user);
  },
  restampBalance: async (tx, wallet, ownerId) => clone(db.users.get(Number(ownerId))),
});
stub('../src/services/pending.service', {
  getPending: async () => clone(pendingPayload),
  setPending: async () => true,
  clearPending: async (userId, remark) => spy.cleared.push(remark),
});
stub('../src/helpers/pii.helper', {
  verifySecret: async () => ({ ok: true }),
  revealUserFields: u => u,
  protectText: s => `enc(${s})`,
  revealLedgerText: row => ({ details: row?.details || '' }),
});
stub('../src/services/alerts.service', { paymentFailure: p => spy.alerts.push(p) });
stub('../src/services/userAudit.service', { logMoneyEvent: async () => {} });
stub('../src/helpers/velocity.helper', { checkVelocity: async () => ({ ok: true }) });
stub('../src/helpers/featureFlag.helper', { isFeatureEnabled: async () => true, requireFeature: () => (req, res, next) => next() });
stub('../src/services/email.service', { sendResetEmail: async () => {} });
stub('../src/helpers/beneficiary.helper', { clearAcknowledgement: async () => {} });
stub('../src/helpers/country.helper', { getCountryByCode: () => null });

const verification = require('../src/controllers/verification.controller');
const betting = require('../src/controllers/betting.controller');

/* ---------------------------------------------------------------- helpers */

function respond(handler, req) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    handler(req, res);
  });
}

function reset({ balance = 5000 } = {}) {
  db.users = new Map([[USER_ID, { id: USER_ID, balance, pin: 'hashed' }]]);
  db.ledger = [];
  events.length = 0;
  spy.alerts = [];
  spy.cleared = [];
  spy.created = [];
  spy.verified = [];
  payvessel.create = null;
  payvessel.verify = null;
  pendingPayload = {
    betting_company: '2269',
    betting_company_name: 'Bet9ja',
    item_id: 'ITEM-1',
    customer_id: 'CUST1',
    customer_name: 'JOHN',
    amount: 1000,
  };
}

const order = (status, extra = {}) => ({ status, raw_status: status, order_reference: '', error_message: null, ...extra });
const confirm = () => respond(verification.verifyPin, { user: { id: USER_ID }, body: { pin: '1234', remark: 'betting' }, headers: {} });
const debitRow = () => db.ledger.find(r => r.trx_type === '-');
const refundRow = () => db.ledger.find(r => r.trx_type === '+');
const balance = () => db.users.get(USER_ID).balance;

(async () => {
  /* ----------------------------------------------------- funded on the spot */

  reset();
  payvessel.create = order('success', { order_reference: 'PV-1' });
  let out = await confirm();

  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.remark, 'betting_success');
  assert.strictEqual(out.body.data.status, 'successful');
  assert.strictEqual(out.body.data.provider_reference, 'PV-1');
  assert.deepStrictEqual(events, ['reserve', 'order'], 'the wallet is reserved before Payvessel hears a word');
  assert.strictEqual(balance(), 4000);

  let row = debitRow();
  assert.deepStrictEqual(spy.created[0], {
    billerId: '2269',
    itemId: 'ITEM-1',
    rechargeAccount: 'CUST1',
    amount: 1000,
    reference: row.trx,
    webhookUrl: 'https://voltpay.example/api/betting/callback',
  });
  assert.strictEqual(row.meta.gateway, 'payvessel');
  assert.strictEqual(row.meta.item_id, 'ITEM-1');
  assert.strictEqual(row.meta.provider_reference, 'PV-1');
  assert.strictEqual(row.meta.bill_status, 'successful');
  assert.strictEqual(row.other_data.feedback, 'Successful');
  // The customer id names the counterparty: ledger text only, never meta.
  assert.strictEqual(JSON.stringify(row.meta).includes('CUST1'), false, 'no betting account id in meta');
  assert.deepStrictEqual(spy.cleared, ['betting']);

  /* ------------------------------------------- accepted, funding afterwards */

  reset();
  payvessel.create = order('processing', { order_reference: 'PV-2' });
  out = await confirm();
  assert.strictEqual(out.body.data.status, 'processing');
  assert.strictEqual(debitRow().meta.bill_status, 'processing');
  assert.strictEqual(debitRow().meta.provider_reference, 'PV-2', 'Payvessel\'s own reference is kept for the settle');
  assert.strictEqual(refundRow(), undefined, 'processing is not a failure');

  /* ------------------------------------------------ refused, in their words */

  reset();
  payvessel.create = order('failed', { error_message: 'Invalid customer account' });
  out = await confirm();
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.remark, 'provider_error');
  assert.strictEqual(out.body.message[0], 'Invalid customer account', 'a reason the customer can act on is kept');
  assert.strictEqual(balance(), 5000, 'every naira back');
  assert.strictEqual(debitRow().meta.bill_status, 'refunded');
  assert.strictEqual(debitRow().other_data.feedback, 'Failed');
  assert.ok(refundRow(), 'the statement shows the reversal, not a balance that silently healed');
  assert.strictEqual(refundRow().trx, `${debitRow().trx}_r`);
  assert.strictEqual(refundRow().meta.gateway, 'payvessel');
  assert.strictEqual(spy.alerts.length, 0, 'a customer mistake pages nobody');

  /* --------------------------------------- our Payvessel wallet is empty */

  reset();
  payvessel.create = Object.assign(new Error('Betting top-ups are temporarily unavailable'), { statusCode: 503 });
  payvessel.verify = Object.assign(new Error('Order not found'), { statusCode: 404 });
  out = await confirm();
  assert.strictEqual(out.status, 503);
  assert.strictEqual(out.body.message[0], 'Betting top-ups are temporarily unavailable. Please try again shortly.');
  assert.strictEqual(balance(), 5000);
  assert.ok(refundRow());
  assert.strictEqual(spy.alerts.length, 1);
  assert.deepStrictEqual([spy.alerts[0].provider, spy.alerts[0].action], ['payvessel', 'float']);

  /* ------------------------------------ the customer cannot afford it */

  reset({ balance: 500 });
  payvessel.create = order('success');
  out = await confirm();
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.remark, 'insufficient_balance');
  assert.strictEqual(spy.created.length, 0, 'no reserve, no order');
  assert.strictEqual(db.ledger.length, 0);
  assert.strictEqual(balance(), 500);

  /* ------------------------------------ the answer was lost; it landed */

  reset();
  payvessel.create = new TypeError('fetch failed');
  payvessel.verify = order('success', { order_reference: 'PV-9' });
  out = await confirm();
  assert.strictEqual(out.body.data.status, 'successful', 'found on verify: kept, not refunded');
  assert.strictEqual(spy.created.length, 1, 'and never ordered twice');
  assert.deepStrictEqual(spy.verified, [debitRow().trx], 'asked about by our own reference');
  assert.strictEqual(refundRow(), undefined);
  assert.strictEqual(balance(), 4000);

  /* ------------------------------ the answer was lost; it never landed */

  reset();
  payvessel.create = new TypeError('fetch failed');
  payvessel.verify = Object.assign(new Error('Order not found'), { statusCode: 404 });
  out = await confirm();
  assert.strictEqual(out.status, 503, 'an outage, not the customer\'s mistake');
  assert.strictEqual(out.body.message[0], 'Betting top-ups are temporarily unavailable. Please try again shortly.', 'never "fetch failed"');
  assert.strictEqual(balance(), 5000, 'nothing was funded, so everything comes back');
  assert.ok(refundRow());

  // A payload from before item ids were carried still orders.
  reset();
  delete pendingPayload.item_id;
  payvessel.create = order('success');
  await confirm();
  assert.strictEqual(spy.created[0].itemId, 'ITEM-RESOLVED');

  /* ============================================================ receipt */

  // A refunded row answers from the ledger, and Payvessel is not asked: an
  // order it never received could read as anything but refunded.
  reset();
  payvessel.create = order('failed');
  await confirm();
  const refundedTrx = debitRow().trx;
  spy.verified = [];
  out = await respond(betting.query, { user: { id: USER_ID }, query: { trx: refundedTrx } });
  assert.strictEqual(out.body.data.status, 'failed');
  assert.strictEqual(spy.verified.length, 0, 'a settled row is not requeried');

  // A processing row is asked about, and settled by the answer.
  reset();
  payvessel.create = order('processing', { order_reference: 'PV-3' });
  await confirm();
  const pendingTrx = debitRow().trx;
  payvessel.verify = order('success', { order_reference: 'PV-3' });
  out = await respond(betting.query, { user: { id: USER_ID }, query: { trx: pendingTrx } });
  assert.strictEqual(out.body.data.status, 'success');
  assert.strictEqual(debitRow().meta.bill_status, 'successful');

  // Payvessel down while the customer watches the receipt: still an answer.
  reset();
  payvessel.create = order('processing');
  await confirm();
  payvessel.verify = Object.assign(new Error('Payvessel request failed (502)'), { statusCode: 502 });
  out = await respond(betting.query, { user: { id: USER_ID }, query: { trx: debitRow().trx } });
  assert.strictEqual(out.status, 200, 'a provider hiccup never breaks the receipt');
  assert.strictEqual(out.body.data.status, 'processing');

  // Someone else's reference reads exactly like no reference at all.
  out = await respond(betting.query, { user: { id: 99 }, query: { trx: debitRow().trx } });
  assert.strictEqual(out.status, 404);

  /* =========================================================== callback */

  // Payvessel's callback is unsigned too: the reference is read, the outcome is
  // re-fetched, and a failed order is refunded exactly once.
  reset();
  payvessel.create = order('processing');
  await confirm();
  const callbackTrx = debitRow().trx;
  payvessel.verify = order('failed');
  out = await respond(betting.callback, { body: { status: 'success', merchant_reference: callbackTrx } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(debitRow().meta.bill_status, 'refunded', 'the body said success; Payvessel said failed');
  assert.strictEqual(balance(), 5000);

  out = await respond(betting.callback, { body: { status: 'failed', merchant_reference: callbackTrx } });
  assert.strictEqual(db.ledger.filter(r => r.trx_type === '+').length, 1, 'a late duplicate never refunds twice');
  assert.strictEqual(balance(), 5000);

  out = await respond(betting.callback, { body: {}, query: {} });
  assert.strictEqual(out.status, 400, 'no reference, nothing to ask about');

  console.log('✅ betting flow tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
