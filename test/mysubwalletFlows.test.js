/**
 * node test/mysubwalletFlows.test.js
 *
 * The settlement paths around the MySubWallet adapter, against a fake database
 * and a stubbed API - no network, no Redis, no Postgres:
 *
 *   1. The webhook believes nothing in its body. It is one unsigned URL for
 *      bills and Bill Hero, so the outcome is re-read over the authenticated
 *      requery and the row is found by our own reference - and a row another
 *      provider sold (a Payvessel betting top-up, a legacy PairGate bill) is
 *      never touched.
 *   2. Nothing depends on that webhook firing - their dashboard offers no
 *      callback setting - so the receipt poll / sweep path (`reconcile`) has to
 *      settle a bill, token included, on its own.
 *   3. The bills sweep keeps its hands off betting rows whatever gateway they
 *      carry.
 *   4. A prepaid bill parked waiting for its token is still asked about, in a
 *      sweep pass of its own - so a token a later requery carries reaches the
 *      receipt, and parked bills never hold the slots a refund needs.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.MYSUBWALLET_API_KEY = 'msw_live_key';
process.env.MYSUBWALLET_RECOVERY_DELAY_MS = '0';
process.env.MYSUBWALLET_CATALOGUE_GAP_MS = '0';
process.env.PROVIDER_MAX_RETRIES = '0';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ---------------------------------------------------------- fake database */

const db = { ledger: [], claims: [] };
// Every query the sweep makes, and the rows it is handed back, by bill_status.
let sweepQueries = [];
const sweepRows = {};

const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));

const fakePrisma = {
  walletTransaction: {
    async findUnique({ where }) {
      return clone(db.ledger.find(r => r.trx === where.trx));
    },
    async update({ where, data }) {
      const row = db.ledger.find(r => r.trx === where.trx);
      Object.assign(row, clone(data));
      return clone(row);
    },
    // The guarded write reconcile stamps a found order's reference with: by
    // trx, and only while the row's status is still the one it read.
    async updateMany({ where, data }) {
      const hits = db.ledger.filter(r => r.trx === where.trx && (!where.meta || r.meta?.[where.meta.path[0]] === where.meta.equals));
      hits.forEach(r => Object.assign(r, clone(data)));
      return { count: hits.length };
    },
    async findMany(args) {
      sweepQueries.push(args);
      return clone(sweepRows[args?.where?.AND?.[1]?.meta?.equals] || []);
    },
  },
  billHeroClaim: {
    async findFirst({ where }) {
      const claim = db.claims.find(
        c => c.provider_ref === where.provider_ref && c.status === where.status && (!where.provider || c.provider === where.provider)
      );
      return claim ? { ...clone(claim), updated_at: new Date(claim.updated_at) } : null;
    },
    // The guarded write every reward transition goes through.
    async updateMany({ where, data }) {
      const hits = db.claims.filter(
        c =>
          c.id === where.id &&
          c.status === where.status &&
          (c.provider_ref ?? null) === (where.provider_ref ?? null) &&
          new Date(where.updated_at).getTime() === c.updated_at
      );
      hits.forEach(c => Object.assign(c, clone(data), { updated_at: c.updated_at + 1 }));
      return { count: hits.length };
    },
  },
};

/* ------------------------------------------------------- module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// `respond`, when set, decides what settlement answers - a parked bill, say.
const spy = { outcomes: [], alerts: [], respond: null };

stub('../database/prisma', fakePrisma);
stub('../src/services/alerts.service', { paymentFailure: p => spy.alerts.push(p) });
stub('../src/services/notify.service', { notifyUser: async () => true });
// Settlement itself has its own coverage (billSettlement.test.js); here the
// question is only what it was asked to do, and with what.
stub('../src/helpers/billSettlement.helper', {
  AWAITING_TOKEN: 'awaiting_token',
  applyOutcome: async args => {
    spy.outcomes.push(args);
    return spy.respond ? spy.respond(args) : { applied: true };
  },
  findByProviderReference: async () => null,
});

/* ----------------------------------------------------------- fake API */

let routes = [];

function route(method, path, reply) {
  routes = routes.filter(r => !(r.method === method && r.path === path));
  routes.push({ method, path, reply: typeof reply === 'function' ? reply : () => reply });
}

function networkError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = String(opts.method || 'GET').toUpperCase();
  const match = routes.find(r => r.method === method && r.path === u.pathname);
  if (!match) throw new Error(`unrouted ${method} ${u.pathname}`);
  const out = await match.reply();
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return { status: out.status || 200, headers: { get: () => null }, text: async () => text };
};

const requeryAnswer = (transaction_status, extra = {}) => ({
  status: 200,
  body: { status: 'success', data: { transaction_status, ...extra } },
});

/* ---------------------------------------------------- code under test */

const webhookController = require('../src/controllers/mysubwalletWebhook.controller');
const { reconcile, sweepProcessingBills } = require('../src/helpers/billReconcile.helper');

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

const deliver = body => respond(webhookController.webhook, { body });

function seed() {
  db.ledger = [
    { trx: 'ele_1', user_id: 7, trx_type: '-', remark: 'utility_bill', amount: '1000.00', meta: { gateway: 'mysubwallet', service: 'electricity', bill_status: 'processing' }, other_data: {} },
    { trx: 'bet_1', user_id: 7, trx_type: '-', remark: 'betting', amount: '1000.00', meta: { gateway: 'payvessel', bill_status: 'processing' }, other_data: {} },
    { trx: 'air_old', user_id: 7, trx_type: '-', remark: 'mobile_recharge', amount: '100.00', meta: { gateway: 'pairgate', bill_status: 'processing' }, other_data: {} },
  ];
  // A reward MySubWallet accepted and has not yet confirmed: "Processing".
  db.claims = [
    {
      id: 1,
      user_id: 7,
      reward_type: 'airtime',
      reward_value: 200,
      provider_ref: 'bh_airtime_1',
      status: 'processing',
      provider: 'mysubwallet',
      provider_payload: { delivery: 'pending', attempts: 1, reference: 'bh_airtime_1' },
      updated_at: Date.now() - 10 * 60_000,
    },
  ];
  spy.outcomes = [];
}

(async () => {
  /* ============================================================ webhook */

  // A bill, settled from the authenticated requery - token included.
  seed();
  route('GET', '/api/requery/ele_1', requeryAnswer('success', { token: '1111-2222-3333-4444-5555' }));
  let out = await deliver({ status: 'success', 'request-id': 'ele_1', response: 'Recharge successful.' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(
    [spy.outcomes[0].trx, spy.outcomes[0].status, spy.outcomes[0].token],
    ['ele_1', 'successful', '1111-2222-3333-4444-5555']
  );

  // A forged "success" for a vend that failed: the body's word is never used.
  seed();
  route('GET', '/api/requery/ele_1', requeryAnswer('failed'));
  await deliver({ status: 'success', 'request-id': 'ele_1', response: 'Token: 9999-9999-9999-9999-9999' });
  assert.strictEqual(spy.outcomes[0].status, 'failed', 'their requery decides, not the post');
  assert.strictEqual(spy.outcomes[0].token, '', 'and a token in the body is ignored on a failed vend');

  // A delivered vend whose requery carries no token: the body's token is used.
  // A junk one on a genuinely delivered bill is recoverable; a missing one is not.
  seed();
  route('GET', '/api/requery/ele_1', requeryAnswer('success'));
  await deliver({ status: 'success', 'request-id': 'ele_1', response: 'Token: 1234-5678-9012-3456-7890' });
  assert.strictEqual(spy.outcomes[0].token, '1234-5678-9012-3456-7890');

  // A Payvessel betting row is another provider's - never settled from here,
  // even if somebody posts its reference to this URL.
  seed();
  route('GET', '/api/requery/bet_1', requeryAnswer('failed'));
  out = await deliver({ status: 'fail', 'request-id': 'bet_1' });
  assert.strictEqual(out.body.remark, 'ignored');
  assert.strictEqual(spy.outcomes.length, 0, 'no settlement of a betting row');
  assert.strictEqual(db.ledger.find(r => r.trx === 'bet_1').meta.bill_status, 'processing');

  // Same for a legacy row from a removed provider.
  seed();
  route('GET', '/api/requery/air_old', requeryAnswer('failed'));
  out = await deliver({ status: 'fail', 'request-id': 'air_old' });
  assert.strictEqual(out.body.remark, 'ignored');
  assert.strictEqual(spy.outcomes.length, 0);

  // A Bill Hero reward that failed after being accepted is re-sent
  // automatically - the same transition the reward sweep makes.
  seed();
  route('GET', '/api/requery/bh_airtime_1', requeryAnswer('failed'));
  out = await deliver({ status: 'fail', 'request-id': 'bh_airtime_1' });
  assert.strictEqual(out.body.remark, 'ok');
  assert.strictEqual(db.claims[0].status, 'processing', 'still the customer\'s reward');
  assert.strictEqual(db.claims[0].provider_payload.delivery, 'retrying', 'and due a re-send');

  seed();
  route('GET', '/api/requery/bh_airtime_1', requeryAnswer('success'));
  await deliver({ status: 'success', 'request-id': 'bh_airtime_1' });
  assert.strictEqual(db.claims[0].status, 'claimed', 'confirmed: now "Delivered"');

  // Unknown to their requery: acknowledged, nothing moves.
  seed();
  route('GET', '/api/requery/nobody', { status: 404, body: { status: 'fail', message: 'Transaction not found.' } });
  out = await deliver({ status: 'success', 'request-id': 'nobody' });
  assert.strictEqual(out.body.remark, 'ignored');
  assert.strictEqual(spy.outcomes.length, 0);

  // Their requery is down: refuse, so they deliver again.
  route('GET', '/api/requery/ele_1', () => {
    throw networkError();
  });
  out = await deliver({ status: 'success', 'request-id': 'ele_1' });
  assert.strictEqual(out.status, 503);

  out = await deliver({ status: 'success' });
  assert.strictEqual(out.body.remark, 'ignored', 'no reference, nothing to ask about');

  /* =============================================== no webhook: reconcile */

  // The path every pending bill actually takes while their dashboard has no
  // callback setting: the receipt poll and the sweep ask directly.
  seed();
  const billRow = db.ledger.find(r => r.trx === 'ele_1');
  const aged = row => ({ ...row, created_at: new Date(Date.now() - 60_000).toISOString() });

  route('GET', '/api/requery/ele_1', requeryAnswer('success', { token: '1111-2222-3333-4444-5555' }));
  const result = await reconcile(aged(billRow), { minAgeMs: 0 });
  assert.strictEqual(result.checked, true);
  assert.strictEqual(spy.outcomes[0].status, 'successful');
  assert.strictEqual(spy.outcomes[0].token, '1111-2222-3333-4444-5555', 'a requery can finish a receipt on its own');

  // A betting row is never the bills sweep's: Payvessel's is another gateway
  // outright, and one on a bills gateway is still excluded by remark.
  const bettingRow = aged(db.ledger.find(r => r.trx === 'bet_1'));
  assert.deepStrictEqual(await reconcile(bettingRow, { minAgeMs: 0 }), { checked: false, reason: 'other_gateway' });
  assert.deepStrictEqual(
    await reconcile({ ...bettingRow, meta: { gateway: 'mysubwallet', bill_status: 'processing' } }, { minAgeMs: 0 }),
    { checked: false, reason: 'other_rail' },
    'betting shares no settlement with bills, whichever provider it is on'
  );
  assert.deepStrictEqual(await reconcile(aged(db.ledger.find(r => r.trx === 'air_old')), { minAgeMs: 0 }), {
    checked: false,
    reason: 'other_gateway',
  });

  /* ================================== a prepaid bill waiting for its token */

  // A bill row of its own, keyed on its own reference. Not spread from
  // billRow.meta: the reconcile above stamped `provider_reference: 'ele_1'` on
  // that, and a copy would requery ele_1's order instead of its own.
  const ownBill = (trx, meta = {}) => ({
    ...billRow,
    trx,
    meta: { gateway: 'mysubwallet', service: 'electricity', provider_reference: trx, bill_status: 'processing', ...meta },
  });

  // Parked - the provider said delivered and gave no token - and still asked
  // about. That is how a token a later requery carries reaches the receipt.
  seed();
  const parkedRow = aged(ownBill('ele_2', { meter_type: 'prepaid', bill_status: 'awaiting_token' }));
  route('GET', '/api/requery/ele_2', requeryAnswer('success', { token: '2222-3333-4444-5555-6666' }));
  const fromParked = await reconcile(parkedRow, { minAgeMs: 0 });
  assert.strictEqual(fromParked.checked, true, 'a parked bill is still open');
  assert.strictEqual(spy.outcomes[0].token, '2222-3333-4444-5555-6666', 'and its token completes it');

  // A closed one is never asked about again.
  assert.deepStrictEqual(await reconcile(aged(ownBill('ele_3', { bill_status: 'successful' })), { minAgeMs: 0 }), {
    checked: false,
    reason: 'not_processing',
  });

  /* ================================================================ sweep */

  // Bills in flight first, then a pass of their own for bills waiting on a
  // token, so those can never take the slots a failed bill needs to refund.
  sweepQueries = [];
  await sweepProcessingBills();
  assert.strictEqual(sweepQueries.length, 2);
  const [mainPass, tokenPass] = sweepQueries;
  assert.strictEqual(mainPass.where.AND[1].meta.equals, 'processing');
  assert.strictEqual(mainPass.take, 20);
  assert.strictEqual(tokenPass.where.AND[1].meta.equals, 'awaiting_token');
  assert.strictEqual(tokenPass.take, 5);
  assert.ok(
    sweepQueries.every(q => q.where.remark.notIn.includes('betting')),
    'neither pass of the sweep query touches betting'
  );

  // Two bills hours old. One is parked on this pass - it is waiting on a token,
  // not on a stuck biller, and parking raised its own alert - so only the one
  // the provider still calls pending is reported stuck.
  const hoursOld = row => ({ ...row, created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
  sweepRows.processing = [hoursOld(ownBill('ele_4', { meter_type: 'prepaid' })), hoursOld(ownBill('ele_5'))];
  route('GET', '/api/requery/ele_4', requeryAnswer('success'));
  route('GET', '/api/requery/ele_5', requeryAnswer('pending'));
  spy.respond = args =>
    args.trx === 'ele_4'
      ? { applied: false, reason: 'awaiting_token', parked: true }
      : { applied: false, reason: 'not_final' };
  spy.alerts = [];
  spy.outcomes = [];
  const swept = await sweepProcessingBills();
  assert.deepStrictEqual(
    spy.outcomes.map(o => [o.trx, o.status]),
    [
      ['ele_4', 'successful'],
      ['ele_5', 'processing'],
    ],
    'each bill asked about under its own reference'
  );
  assert.strictEqual(swept.stuck, 1, 'only the bill still pending counts as stuck');
  assert.strictEqual(spy.alerts.filter(a => a.action === 'stuck_bills').length, 1);
  spy.respond = null;
  sweepRows.processing = [];

  console.log('✅ mysubwallet flow tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
