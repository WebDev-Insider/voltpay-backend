/**
 * node test/billsMultiProvider.test.js
 *
 * The money paths across all three bills providers, end to end through the
 * real purchase core (bills.controller executePurchase), the real settlement
 * and the real reconciler - against a fake database and fake provider hosts.
 * No network, no Redis, no Postgres.
 *
 *   1. Every bill records its provider (`meta.gateway`), the provider's
 *      reference and our own (`meta.reference` = trx).
 *   2. Success, refusal and refund on ClubKonnect: debit first, refund on a
 *      clear refusal, the reversal stamped with the provider that sold it.
 *   3. CashBuddy's lost answers: never refunded on the spot; found in their
 *      history and adopted, or refunded once after enough complete looks and
 *      enough time - never guessing between two candidates.
 *   4. Historical isolation: a bill is always asked about at the provider that
 *      sold it, whatever the switch says now, and references never cross.
 *   5. Electricity can never be bought through ClubKonnect - not even by a
 *      caller that skips the switch.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.MYSUBWALLET_API_KEY = 'msw_live_key';
process.env.MYSUBWALLET_RECOVERY_DELAY_MS = '0';
process.env.CLUBKONNECT_USER_ID = 'CK123';
process.env.CLUBKONNECT_API_KEY = 'ck_secret';
process.env.CLUBKONNECT_RECOVERY_DELAY_MS = '0';
process.env.CASHBUDDY_API_KEY = 'cb_live_test';
process.env.CASHBUDDY_USER_ID = 'f7a1c3b2-0001-4e8d-bcf1-aabbccddeeff';
process.env.PROVIDER_MAX_RETRIES = '0';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

const { Prisma } = require('@prisma/client');

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
let db;

function resetDb({ balance = 10_000 } = {}) {
  db = { user: [{ id: USER_ID, balance }], walletTransaction: [], appSetting: [] };
}

const isDecimal = v => Boolean(v) && typeof v === 'object' && Prisma.Decimal.isDecimal(v);

function plain(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return new Date(v.getTime());
  if (isDecimal(v)) return Number(v.toString());
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const p = plain(x);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return v;
}

const clone = v => (v == null ? null : structuredClone(v));
const time = v => (v instanceof Date ? v.getTime() : v);
const eq = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && time(a) === time(b));

function matchField(value, cond) {
  if (cond === null || cond instanceof Date || isDecimal(cond) || typeof cond !== 'object') return eq(value, plain(cond));
  for (const [op, raw] of Object.entries(cond)) {
    const arg = plain(raw);
    if (op === 'not' && !(value != null && !eq(value, arg))) return false;
    if (op === 'in' && !arg.some(a => eq(value, a))) return false;
    if (op === 'notIn' && arg.some(a => eq(value, a))) return false;
    if (op === 'lt' && !(value != null && time(value) < time(arg))) return false;
    if (op === 'gt' && !(value != null && time(value) > time(arg))) return false;
    if (op === 'gte' && !(value != null && time(value) >= time(arg))) return false;
    if (op === 'equals' && !eq(value, arg)) return false;
  }
  return true;
}

function matches(row, where = {}) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') {
      if (!cond.some(w => matches(row, w))) return false;
    } else if (key === 'AND') {
      if (!cond.every(w => matches(row, w))) return false;
    } else if (cond && typeof cond === 'object' && Array.isArray(cond.path)) {
      let v = row[key];
      for (const part of cond.path) v = v?.[part];
      if (!eq(v, cond.equals)) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyData(row, data) {
  for (const [key, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && !isDecimal(v) && ('increment' in v || 'decrement' in v)) {
      const delta = v.increment != null ? plain(v.increment) : -plain(v.decrement);
      row[key] = Math.round((Number(row[key] || 0) + delta) * 100) / 100;
    } else {
      row[key] = plain(v);
    }
  }
}

function project(row, select) {
  if (!row || !select) return clone(row);
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, clone(row[k])]));
}

function model(table) {
  return {
    async findUnique({ where, select }) {
      return project(db[table].find(r => matches(r, where)) || null, select);
    },
    async findFirst({ where }) {
      return clone(db[table].find(r => matches(r, where)) || null);
    },
    async findMany({ where, orderBy, take }) {
      let rows = db[table].filter(r => matches(r, where));
      const [[key, dir] = []] = Object.entries(orderBy || {});
      if (key) rows = rows.sort((a, b) => (time(a[key]) - time(b[key])) * (dir === 'desc' ? -1 : 1));
      return clone(rows.slice(0, take || undefined));
    },
    async count({ where }) {
      return db[table].filter(r => matches(r, where)).length;
    },
    async create({ data }) {
      const row = { created_at: new Date(), ...plain(data) };
      if (table === 'walletTransaction' && db[table].some(r => r.trx === row.trx)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      db[table].push(row);
      return clone(row);
    },
    async update({ where, data }) {
      const row = db[table].find(r => matches(r, where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      applyData(row, data);
      return clone(row);
    },
    async updateMany({ where, data }) {
      const rows = db[table].filter(r => matches(r, where));
      rows.forEach(r => applyData(r, data));
      return { count: rows.length };
    },
  };
}

const fakePrisma = {
  user: model('user'),
  walletTransaction: model('walletTransaction'),
  appSetting: model('appSetting'),
  async $transaction(fn) {
    const snapshot = structuredClone(db);
    try {
      return await fn(fakePrisma);
    } catch (e) {
      db = snapshot;
      throw e;
    }
  },
};

/* ------------------------------------------------------- module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { alerts: [] };

stub('../database/prisma', fakePrisma);
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (tx, wallet, ownerId, delta) => {
    const user = db.user.find(u => u.id === Number(ownerId));
    user.balance = Math.round((user.balance + Number(delta.toString())) * 100) / 100;
    return clone(user);
  },
  restampBalance: async (tx, wallet, ownerId) => clone(db.user.find(u => u.id === Number(ownerId))),
});
stub('../src/services/pending.service', { getPending: async () => null, setPending: async () => true, clearPending: async () => true });
stub('../src/services/alerts.service', { paymentFailure: p => spy.alerts.push(p), captureError: () => {}, securityEvent: () => {} });
stub('../src/services/userAudit.service', { logMoneyEvent: async () => null, logUserEvent: async () => null });
stub('../src/helpers/velocity.helper', { checkVelocity: async () => ({ ok: true }) });

/* ------------------------------------------------- fake provider hosts */

let routes = {};
let calls = [];

function route(host, method, path, reply) {
  routes[`${host} ${method} ${path}`] = typeof reply === 'function' ? reply : () => reply;
}

const MSW = 'api.mysubwallet.ng';
const CK = 'www.nellobytesystems.com';
const CB = 'kfxncgvpzwpucjaqlief.supabase.co';

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = String(opts.method || 'GET').toUpperCase();
  const path = u.pathname.replace('/functions/v1/partner-api', '');
  const query = Object.fromEntries(u.searchParams.entries());
  calls.push({ host: u.host, method, path, query });
  const handler = routes[`${u.host} ${method} ${path}`];
  if (!handler) throw new Error(`unrouted ${method} ${u.host}${path}`);
  const out = await handler({ query, body: opts.body ? JSON.parse(opts.body) : null });
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return { status: out.status || 200, headers: { get: () => null }, text: async () => text };
};

function networkError() {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
}

/* ---------------------------------------------------- code under test */

const bills = require('../src/funding/billsProvider');
const billsController = require('../src/controllers/bills.controller');
const settlement = require('../src/helpers/billSettlement.helper');
const reconciler = require('../src/helpers/billReconcile.helper');

const { reconcile, sweepProcessingBills, recipientIndex } = reconciler;
const AIRTIME = { key: 'airtime', ...billsController.SERVICES.airtime };
const ELECTRICITY = { key: 'electricity', ...billsController.SERVICES.electricity };

function airtimePending(gateway, over = {}) {
  return {
    gateway,
    service: 'airtime',
    provider: 'MTN',
    phone_local: '08031234567',
    phone_msisdn: '2348031234567',
    amount: 500,
    charge: 0,
    total: 500,
    item_name: 'Airtime',
    ...over,
  };
}

function buy(gateway, over = {}) {
  return billsController.executePurchase({
    userId: USER_ID,
    service: AIRTIME,
    pending: airtimePending(gateway, over),
    gateway,
    upstream: bills.adapterFor(gateway),
  });
}

const row = trx => db.walletTransaction.find(r => r.trx === trx);
const balance = () => db.user[0].balance;
const ago = minutes => new Date(Date.now() - minutes * 60_000);

// An unconfirmed CashBuddy airtime row, as executePurchase leaves one.
function unconfirmedRow(trx, { minutes = 5, phone = '08031234567', amount = 500, extra = {} } = {}) {
  const r = {
    trx,
    user_id: USER_ID,
    trx_type: '-',
    remark: 'mobile_recharge',
    amount,
    total_amount: amount,
    details: '',
    other_data: { title: 'Airtime', feedback: 'Processing' },
    meta: {
      gateway: 'cashbuddy',
      service: 'airtime',
      provider: 'MTN',
      reference: trx,
      provider_reference: '',
      bill_status: 'processing',
      unconfirmed: true,
      recipient_idx: recipientIndex('airtime', phone),
      vend_amount: amount,
      ...extra,
    },
    created_at: ago(minutes),
  };
  db.walletTransaction.push(r);
  return clone(r);
}

function history(orders) {
  route(CB, 'GET', '/bills', { body: { success: true, transactions: orders, pagination: { page: 1, limit: 50, total: orders.length } } });
}

const historyBill = (reference, createdAt, over = {}) => ({
  id: `id_${reference}`,
  service_type: 'airtime',
  amount: 500,
  status: 'completed',
  vtpass_reference: reference,
  phone_number: '08031234567',
  created_at: new Date(createdAt).toISOString(),
  ...over,
});

async function settle(r) {
  reconciler.__test.lastChecked.clear();
  return reconcile(clone(row(r.trx)), { minAgeMs: 0 });
}

(async () => {
  /* ============================================== ClubKonnect: delivered */

  resetDb();
  routes = {};
  calls = [];
  route(CK, 'GET', '/APIAirtimeV1.asp', { body: { orderid: '777', statuscode: '200', status: 'ORDER_COMPLETED' } });
  let result = await buy('clubkonnect');
  assert.strictEqual(result.outcome, 'delivered');
  assert.strictEqual(result.processing, false);
  let meta = row(result.trx).meta;
  assert.strictEqual(meta.gateway, 'clubkonnect', 'the provider is recorded');
  assert.strictEqual(meta.provider_reference, '777', 'their reference is recorded');
  assert.strictEqual(meta.reference, result.trx, 'and our own');
  assert.strictEqual(meta.bill_status, 'successful');
  assert.strictEqual(meta.unconfirmed, undefined, 'lookup-by-history fields only where they are needed');
  assert.strictEqual(meta.recipient_idx, undefined);
  assert.strictEqual(balance(), 9_500, 'debited once');
  assert.deepStrictEqual(calls.map(c => `${c.host}${c.path}`), [`${CK}/APIAirtimeV1.asp`]);
  assert.strictEqual(calls[0].query.RequestID, result.trx, 'our trx went out as their RequestID');

  /* =========================================== ClubKonnect: refused, refunded */

  resetDb();
  routes = {};
  route(CK, 'GET', '/APIAirtimeV1.asp', { body: { status: 'ORDER_ERROR', statuscode: '409', remark: 'INVALID_RECIPIENT' } });
  result = await buy('clubkonnect');
  assert.strictEqual(result.outcome, 'provider_failed');
  assert.strictEqual(result.error.kind, 'input');
  assert.strictEqual(result.refund.applied, true);
  assert.strictEqual(balance(), 10_000, 'the money came back');
  assert.strictEqual(row(result.trx).meta.bill_status, 'failed');
  const reversal = row(`${result.trx}_r`);
  assert.ok(reversal, 'a visible credit leg');
  assert.strictEqual(reversal.meta.gateway, 'clubkonnect', 'stamped with the provider that sold it');

  // An outage on our side of ClubKonnect is still refunded - and paged.
  resetDb();
  routes = {};
  route(CK, 'GET', '/APIAirtimeV1.asp', { body: { statuscode: '417', status: 'ORDER_ERROR', remark: 'INSUFFICIENT_BALANCE' } });
  result = await buy('clubkonnect');
  assert.strictEqual(result.outcome, 'provider_failed');
  assert.ok(result.error.floatExhausted);
  assert.strictEqual(balance(), 10_000);

  /* ============================================ CashBuddy: delivered */

  resetDb();
  routes = {};
  route(CB, 'POST', '/bills', { body: { success: true, reference: 'vt_ok', status: 'delivered' } });
  result = await buy('cashbuddy');
  assert.strictEqual(result.processing, false);
  meta = row(result.trx).meta;
  assert.strictEqual(meta.gateway, 'cashbuddy');
  assert.strictEqual(meta.provider_reference, 'vt_ok');
  assert.strictEqual(meta.unconfirmed, false, 'their reference came back');
  assert.ok(meta.recipient_idx && !JSON.stringify(meta).includes('8031234567'), 'a blind index, never the number');

  /* ============================== CashBuddy: lost answer is NOT refunded */

  resetDb();
  routes = {};
  calls = [];
  route(CB, 'POST', '/bills', () => {
    throw networkError();
  });
  result = await buy('cashbuddy');
  assert.strictEqual(result.outcome, 'delivered', 'not a refusal: it may have been delivered');
  assert.strictEqual(result.processing, true);
  const lost = row(result.trx);
  assert.strictEqual(lost.meta.unconfirmed, true);
  assert.strictEqual(lost.meta.provider_reference, '');
  assert.strictEqual(lost.meta.vend_amount, 500);
  assert.strictEqual(lost.meta.recipient_idx, recipientIndex('airtime', '+2348031234567'), 'every phone form agrees');
  assert.strictEqual(balance(), 9_500, 'held, not refunded on the spot');
  assert.ok(!row(`${result.trx}_r`));
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 1, 'never sent twice');

  // Found in their history: adopted and settled.
  routes = {};
  history([
    historyBill('vt_other_phone', Date.now(), { phone_number: '08099999999' }),
    historyBill('vt_other_amount', Date.now(), { amount: 1000 }),
    historyBill('vt_found', new Date(lost.created_at).getTime() + 5_000),
  ]);
  lost.created_at = ago(2);
  let outcome = await settle(lost);
  assert.strictEqual(outcome.adopted, true);
  assert.strictEqual(row(lost.trx).meta.provider_reference, 'vt_found', 'matched on recipient AND amount');
  assert.strictEqual(row(lost.trx).meta.unconfirmed, false);
  assert.strictEqual(row(lost.trx).meta.bill_status, 'successful');
  assert.strictEqual(balance(), 9_500);

  // Once adopted it is an ordinary bill, asked about by its reference.
  row(lost.trx).meta.bill_status = 'processing';
  route(CB, 'GET', '/bills/vt_found', { body: { success: true, transaction: { status: 'failed', vtpass_reference: 'vt_found' } } });
  outcome = await settle(lost);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(balance(), 10_000, 'a later failure still refunds it');

  /* ================== CashBuddy: absent - refunded once, after looks AND time */

  resetDb({ balance: 9_500 });
  routes = {};
  history([]);
  const old = unconfirmedRow('air_absent', { minutes: 40 });
  outcome = await settle(old);
  assert.strictEqual(outcome.reason, 'not_found_yet');
  assert.strictEqual(row(old.trx).meta.lookup_misses, 1);
  await settle(old);
  assert.strictEqual(balance(), 9_500, 'two looks are not enough');
  outcome = await settle(old);
  assert.strictEqual(outcome.applied, true, 'the third complete look refunds it');
  assert.strictEqual(balance(), 10_000);
  assert.strictEqual(row(old.trx).meta.bill_status, 'failed');
  assert.strictEqual(row(old.trx).meta.unconfirmed, reconciler.__test.REFUNDING, 'claimed before it was paid');
  outcome = await settle(old);
  assert.strictEqual(outcome.reason, 'not_processing', 'and never twice');
  assert.strictEqual(db.walletTransaction.filter(r => r.trx === 'air_absent_r').length, 1);

  // Young: any number of empty looks waits for the time.
  resetDb({ balance: 9_500 });
  history([]);
  const young = unconfirmedRow('air_young', { minutes: 5, extra: { lookup_misses: 9 } });
  outcome = await settle(young);
  assert.strictEqual(outcome.reason, 'not_found_yet');
  assert.strictEqual(balance(), 9_500);

  // A partial read proves nothing and is not counted.
  resetDb({ balance: 9_500 });
  routes = {};
  const busy = Array.from({ length: 50 }, (_, i) => historyBill(`vt_busy_${i}`, Date.now(), { phone_number: '08099999999' }));
  route(CB, 'GET', '/bills', { body: { success: true, transactions: busy, pagination: { page: 1, limit: 50, total: 5000 } } });
  const crowded = unconfirmedRow('air_crowded', { minutes: 40, extra: { lookup_misses: 5 } });
  outcome = await settle(crowded);
  assert.strictEqual(outcome.reason, 'incomplete_listing');
  assert.strictEqual(row(crowded.trx).meta.lookup_misses, 5, 'not counted');
  assert.strictEqual(balance(), 9_500, 'and not refunded');

  // Their history is down: not evidence either.
  routes = {};
  route(CB, 'GET', '/bills', { status: 503, body: { success: false, error: 'INTERNAL_ERROR' } });
  outcome = await settle(crowded);
  assert.strictEqual(outcome.reason, 'provider_error');
  assert.strictEqual(balance(), 9_500);

  /* ========================================= CashBuddy: never guess between two */

  // Two orders fit one row.
  resetDb({ balance: 9_500 });
  routes = {};
  const twin = unconfirmedRow('air_twin', { minutes: 3 });
  history([historyBill('vt_a', Date.now() - 60_000), historyBill('vt_b', Date.now() - 30_000)]);
  outcome = await settle(twin);
  assert.strictEqual(outcome.reason, 'ambiguous_match');
  assert.strictEqual(row(twin.trx).meta.unconfirmed, true, 'left for a person');

  // One order fits, but two of our rows could own it.
  resetDb({ balance: 9_000 });
  routes = {};
  const first = unconfirmedRow('air_rival_1', { minutes: 3 });
  unconfirmedRow('air_rival_2', { minutes: 2 });
  history([historyBill('vt_c', Date.now() - 60_000)]);
  outcome = await settle(first);
  assert.strictEqual(outcome.reason, 'ambiguous_match');
  assert.strictEqual(row(first.trx).meta.provider_reference, '');

  // An order another row already holds is that row's, not this one's.
  resetDb({ balance: 9_000 });
  routes = {};
  db.walletTransaction.push({ trx: 'air_owner', user_id: USER_ID, trx_type: '-', meta: { gateway: 'cashbuddy', provider_reference: 'vt_taken', bill_status: 'successful' }, created_at: ago(3) });
  const orphan = unconfirmedRow('air_orphan', { minutes: 3 });
  history([historyBill('vt_taken', Date.now() - 60_000)]);
  outcome = await settle(orphan);
  assert.strictEqual(outcome.reason, 'not_found_yet');
  assert.strictEqual(row(orphan.trx).meta.provider_reference, '');

  /* ===================================================== historical isolation */

  // The switch now says ClubKonnect for airtime. Rows sold by others are still
  // asked about where they were sold.
  resetDb();
  routes = {};
  calls = [];
  db.appSetting.push({ setting_key: 'bills_provider_airtime', setting_value: 'clubkonnect' });
  assert.strictEqual(await bills.getProviderName('airtime'), 'clubkonnect');

  const seed = (trx, gateway, providerReference) => {
    const r = { trx, user_id: USER_ID, trx_type: '-', remark: 'mobile_recharge', amount: 100, total_amount: 100, details: '', other_data: {}, meta: { gateway, service: 'airtime', reference: trx, provider_reference: providerReference, bill_status: 'processing' }, created_at: ago(10) };
    db.walletTransaction.push(r);
    return clone(r);
  };

  route(MSW, 'GET', '/api/requery/air_msw_1', { body: { status: 'success', data: { transaction_status: 'success' } } });
  route(CK, 'GET', '/APIQueryV1.asp', ({ query }) => ({ body: { orderid: query.OrderID || '9001', statuscode: '200', status: 'ORDER_COMPLETED' } }));
  route(CB, 'GET', '/bills/vt_hist', { body: { success: true, transaction: { status: 'completed', vtpass_reference: 'vt_hist' } } });

  await settle(seed('air_msw_1', 'mysubwallet', 'air_msw_1'));
  await settle(seed('air_ck_1', 'clubkonnect', '4242'));
  await settle(seed('air_ck_2', 'clubkonnect', ''));
  await settle(seed('air_cb_1', 'cashbuddy', 'vt_hist'));

  assert.deepStrictEqual(
    calls.map(c => `${c.host} ${c.path} ${c.query.OrderID || c.query.RequestID || ''}`.trim()),
    [
      `${MSW} /api/requery/air_msw_1`,
      `${CK} /APIQueryV1.asp 4242`,
      `${CK} /APIQueryV1.asp air_ck_2`,
      `${CB} /bills/vt_hist`,
    ],
    'each row asked about at the provider that sold it, by that provider\'s reference'
  );
  for (const trx of ['air_msw_1', 'air_ck_1', 'air_ck_2', 'air_cb_1']) {
    assert.strictEqual(row(trx).meta.bill_status, 'successful', `${trx} settled`);
  }
  // Found by our own reference, the order id is stamped for next time - and
  // the settlement is not undone by it (it used to be: the stamp rewrote the
  // row from a copy read before settling).
  assert.strictEqual(row('air_ck_2').meta.provider_reference, '9001');

  // The refund case of the same bug: a found-by-our-reference bill that failed
  // must end "failed" with one refund - not refunded and stuck "Processing".
  routes = {};
  route(CK, 'GET', '/APIQueryV1.asp', { body: { orderid: '9002', statuscode: '516', status: 'ORDER_CANCELLED', remark: 'Not a valid subscriber' } });
  const before = balance();
  await settle(seed('air_ck_3', 'clubkonnect', ''));
  assert.strictEqual(row('air_ck_3').meta.bill_status, 'failed');
  assert.strictEqual(balance(), before + 100, 'refunded');
  await settle(row('air_ck_3'));
  assert.strictEqual(db.walletTransaction.filter(r => r.trx === 'air_ck_3_r').length, 1, 'once');

  // References are each provider's own namespace.
  resetDb();
  db.walletTransaction.push(
    { trx: 'x_ck', meta: { gateway: 'clubkonnect', provider_reference: 'R1' } },
    { trx: 'x_cb', meta: { gateway: 'cashbuddy', provider_reference: 'R1' } }
  );
  assert.strictEqual((await settlement.findByProviderReference('R1', 'cashbuddy')).trx, 'x_cb');
  assert.strictEqual((await settlement.findByProviderReference('R1', 'clubkonnect')).trx, 'x_ck');

  // The sweep covers every registered provider, and still never betting.
  resetDb();
  routes = {};
  calls = [];
  route(MSW, 'GET', '/api/requery/s_msw', { body: { status: 'success', data: { transaction_status: 'pending' } } });
  route(CK, 'GET', '/APIQueryV1.asp', { body: { orderid: '1', statuscode: '100', status: 'ORDER_RECEIVED' } });
  route(CB, 'GET', '/bills/s_cb', { body: { success: true, transaction: { status: 'pending' } } });
  seed('s_msw', 'mysubwallet', 's_msw');
  seed('s_ck', 'clubkonnect', '1');
  seed('s_cb', 'cashbuddy', 's_cb');
  db.walletTransaction.push({ ...clone(row('s_ck')), trx: 's_bet', remark: 'betting' });
  reconciler.__test.lastChecked.clear();
  const swept = await sweepProcessingBills();
  assert.strictEqual(swept.checked, 3);
  assert.deepStrictEqual(new Set(calls.map(c => c.host)), new Set([MSW, CK, CB]));

  /* ======================================== electricity never via ClubKonnect */

  resetDb();
  routes = {};
  calls = [];
  let refused = null;
  try {
    await billsController.executePurchase({
      userId: USER_ID,
      service: ELECTRICITY,
      pending: { gateway: 'clubkonnect', service: 'electricity', provider: 'IKEDC', meter_number: '1234567890', meter_type: 'prepaid', phone_local: '08031234567', phone_msisdn: '2348031234567', amount: 1000, total: 1000, item_name: 'PREPAID meter' },
      gateway: 'clubkonnect',
      upstream: bills.adapterFor('clubkonnect'),
    });
  } catch (e) {
    refused = e;
  }
  assert.strictEqual(refused?.code, 'PROVIDER_NOT_ALLOWED');
  assert.strictEqual(balance(), 10_000, 'nothing reserved');
  assert.strictEqual(db.walletTransaction.length, 0, 'nothing written');
  assert.strictEqual(calls.length, 0, 'nothing sent');

  // And the switch cannot be pointed there either.
  try {
    await bills.setProvider('electricity', 'clubkonnect');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.strictEqual(e.code, 'PROVIDER_NOT_ALLOWED');
  }

  console.log('✅ bills multi-provider flow tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
