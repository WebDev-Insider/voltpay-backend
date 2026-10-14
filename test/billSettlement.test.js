/**
 * node test/billSettlement.test.js
 *
 * The one place a bill's fate is decided, against a fake database - no
 * network, no Redis, no Postgres. What it pins:
 *
 *   1. A prepaid meter is not delivered until the customer holds the token. A
 *      provider "success" with no token parks the row as `awaiting_token` -
 *      still open, still "Processing" on the receipt - instead of closing it as
 *      successful with an empty space where the token should be. Closing it was
 *      permanent: nothing re-reads a settled row, so the token was never asked
 *      for again.
 *   2. Parking alerts once per bill, and only the call that moved the row does.
 *   3. A parked row is still open both ways: a token that turns up completes it,
 *      and a provider that reports a failure still refunds it.
 *   4. Nothing that has no token to wait for - postpaid, data, airtime, TV - is
 *      held back.
 *   5. A caller holding the token that lands between the read and the park is
 *      never overwritten by it.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ---------------------------------------------------------- fake database */

const db = { ledger: [] };
// Runs once, inside the next guarded write and before it matches - a second
// caller's write landing between this caller's read and its write.
let beforeGuardedWrite = null;

const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));

function matches(row, where) {
  if (where.trx !== undefined && row.trx !== where.trx) return false;
  if (where.meta) {
    const value = where.meta.path.reduce((v, key) => (v == null ? undefined : v[key]), row.meta);
    if (value !== where.meta.equals) return false;
  }
  return true;
}

const walletTransaction = {
  async findUnique({ where }) {
    return clone(db.ledger.find(r => r.trx === where.trx));
  },
  async update({ where, data }) {
    const row = db.ledger.find(r => r.trx === where.trx);
    Object.assign(row, clone(data));
    return clone(row);
  },
  async updateMany({ where, data }) {
    if (beforeGuardedWrite) {
      const race = beforeGuardedWrite;
      beforeGuardedWrite = null;
      race();
    }
    const hits = db.ledger.filter(r => matches(r, where));
    hits.forEach(r => Object.assign(r, clone(data)));
    return { count: hits.length };
  },
  async create({ data }) {
    if (db.ledger.some(r => r.trx === data.trx)) {
      throw Object.assign(new Error('Unique constraint failed on trx'), { code: 'P2002' });
    }
    db.ledger.push(clone(data));
    return clone(data);
  },
};

const fakePrisma = {
  walletTransaction,
  async $transaction(fn) {
    return fn({ walletTransaction });
  },
};

/* ------------------------------------------------------- module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { alerts: [], credits: [] };

stub('../database/prisma', fakePrisma);
stub('../src/services/alerts.service', { paymentFailure: p => spy.alerts.push(p) });
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (_tx, _kind, userId, delta) => {
    spy.credits.push({ user_id: Number(userId), amount: delta.toString() });
    return {};
  },
});

const settlement = require('../src/helpers/billSettlement.helper');

/* ------------------------------------------------------------- fixtures */

const TOKEN = '1234-5678-9012-3456-7890';

function seed(meta = {}) {
  db.ledger = [
    {
      trx: 'ele_1',
      user_id: 7,
      trx_type: '-',
      remark: 'utility_bill',
      amount: '1000.00',
      total_amount: '1000.00',
      meta: {
        gateway: 'mysubwallet',
        service: 'electricity',
        provider: 'IKEDC',
        reference: 'ele_1',
        provider_reference: 'ele_1',
        bill_status: 'processing',
        meter_type: 'prepaid',
        ...meta,
      },
      other_data: { title: 'Electricity', feedback: 'Processing', note: 'IKEDC' },
    },
  ];
  spy.alerts = [];
  spy.credits = [];
  beforeGuardedWrite = null;
}

const row = (trx = 'ele_1') => db.ledger.find(r => r.trx === trx);

(async () => {
  /* ===================================== a prepaid meter waits for its token */

  // The bug this file exists for: the provider says delivered and gives no
  // token. The row used to close as successful here, for good.
  seed();
  let out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
  assert.deepStrictEqual(out, { applied: false, reason: 'awaiting_token', parked: true });
  assert.strictEqual(row().meta.bill_status, 'awaiting_token', 'parked, not closed');
  assert.strictEqual(row().other_data.feedback, 'Processing', 'the receipt and history still say Processing');
  assert.strictEqual(row().meta.token, undefined, 'and claim no token');
  assert.ok(settlement.isOpen(row()), 'a parked row is still open');

  assert.strictEqual(spy.alerts.length, 1, 'someone is told');
  assert.strictEqual(spy.alerts[0].reference, 'ele_1', 'by our reference');
  assert.strictEqual(spy.alerts[0].provider, 'mysubwallet');
  assert.strictEqual(spy.alerts[0].userId, 7);

  // Asked again - the receipt poll, the sweep - and still no token. No second
  // write, and no second alert.
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'success', token: '   ' });
  assert.deepStrictEqual(out, { applied: false, reason: 'awaiting_token', parked: false });
  assert.strictEqual(spy.alerts.length, 1, 'one alert per bill, not one per requery');

  // The token turns up. Completed, trimmed, with the units beside it.
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful', token: ` ${TOKEN} `, units: '20.5' });
  assert.strictEqual(out.applied, true);
  assert.strictEqual(row().meta.bill_status, 'successful');
  assert.strictEqual(row().meta.token, TOKEN);
  assert.strictEqual(row().meta.units, '20.5');
  assert.strictEqual(row().other_data.feedback, 'Successful');
  assert.ok(row().meta.settled_at, 'stamped when it actually settled');

  // A late empty answer never wipes it.
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
  assert.deepStrictEqual(out, { applied: false, reason: 'already_settled' });
  assert.strictEqual(row().meta.token, TOKEN);

  // A token on the first answer goes straight to successful, and nobody is paged.
  seed();
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful', token: TOKEN });
  assert.strictEqual(out.applied, true);
  assert.strictEqual(row().meta.bill_status, 'successful');
  assert.strictEqual(row().meta.token, TOKEN);
  assert.strictEqual(spy.alerts.length, 0);

  // So does one the row already holds - the purchase call's own token, on a
  // vend it answered as pending. The requery need not repeat it.
  seed({ token: TOKEN });
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
  assert.strictEqual(out.applied, true);
  assert.strictEqual(row().meta.token, TOKEN);
  assert.strictEqual(spy.alerts.length, 0);

  /* ====================================== nothing else waits for a token */

  seed({ meter_type: 'postpaid' });
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
  assert.strictEqual(out.applied, true, 'postpaid has no token to wait for');
  assert.strictEqual(row().meta.bill_status, 'successful');

  for (const service of ['data', 'airtime', 'tv']) {
    seed({ service, meter_type: undefined });
    out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
    assert.strictEqual(out.applied, true, `${service} is delivered on the provider's word`);
    assert.strictEqual(row().meta.bill_status, 'successful');
  }
  assert.strictEqual(spy.alerts.length, 0);

  /* ============================== a parked bill can still fail and refund */

  seed({ bill_status: 'awaiting_token' });
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'failed', reason: 'Reversed by the biller' });
  assert.strictEqual(out.applied, true);
  assert.strictEqual(out.refunded, true);
  assert.strictEqual(row().meta.bill_status, 'failed');
  assert.strictEqual(row('ele_1_r').meta.bill_status, 'refunded', 'with its credit leg on the statement');
  assert.deepStrictEqual(spy.credits, [{ user_id: 7, amount: '1000' }], 'and the money back in the wallet');

  // Once failed it is closed: a stray success cannot resurrect it.
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful', token: TOKEN });
  assert.deepStrictEqual(out, { applied: false, reason: 'closed' });
  assert.strictEqual(row().meta.bill_status, 'failed');

  /* ====================================================== the race */

  // A caller holding the token lands between this caller's read and its park.
  // The park is guarded on the status it read, so it misses - and the token
  // the other caller wrote survives.
  seed();
  beforeGuardedWrite = () => {
    Object.assign(row().meta, { bill_status: 'successful', token: TOKEN });
  };
  out = await settlement.applyOutcome({ trx: 'ele_1', status: 'successful' });
  assert.deepStrictEqual(out, { applied: false, reason: 'raced', parked: false });
  assert.strictEqual(row().meta.bill_status, 'successful');
  assert.strictEqual(row().meta.token, TOKEN, 'never set back to waiting over a delivered token');
  assert.strictEqual(spy.alerts.length, 0, 'and nobody is paged about a bill that has its token');

  console.log('✅ billSettlement tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
