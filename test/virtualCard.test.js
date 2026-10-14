/**
 * node test/virtualCard.test.js
 *
 * USD Virtual Mastercard end to end - create, activate, fund, freeze, reveal,
 * webhook, sweep - against a fake database and a stubbed Payvessel. No network,
 * no Redis, no Postgres. The real balance helper, the real encryption, the
 * real idempotency middleware and the real HMAC check run.
 *
 * The fake database rolls a failed transaction back exactly (an undo log, not
 * a snapshot, so a concurrent request's writes survive), runs transactions one
 * at a time the way row locks would, and enforces the two partial unique
 * indexes the DDL creates - one live card per user, one top-up in flight per
 * card - because those indexes ARE the race guards being tested.
 *
 *   1. Pricing: whole cents, the fee floor, rounding that cannot lose money.
 *   2. Create: one debit; a refusal refunds once; our outage refunds and pages;
 *      a lost answer is never refunded on the spot - it is found by reading
 *      back, or refunded only after several good reads over the window.
 *   3. Fund: one debit of amount + fee; a refusal refunds and restores fees
 *      owed; a lost answer is matched in the card's history or refunded once.
 *   4. Races and replays: two creates, two top-ups, a retried request with the
 *      same idempotency key - one debit each time.
 *   5. Limits, KYC, PIN, one identity per account - refused before any debit.
 *   6. Webhook: signature required; a recovered fee is owed once.
 *   7. Reveal: PIN-gated, never stored. Freeze: an admin's hold is not the
 *      customer's to lift. Termination: what Payvessel returns is credited once.
 *   8. Nothing personal is stored in plain text.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYVESSEL_API_KEY = 'PVKEY-test';
process.env.PAYVESSEL_API_SECRET = 'PVSECRET-test';
delete process.env.PAYVESSEL_WEBHOOK_SECRET;
delete process.env.PAYVESSEL_WEBHOOK_IPS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
for (const key of Object.keys(process.env)) if (key.startsWith('VCARD_')) delete process.env[key];
process.env.NODE_ENV = 'test';

const { Prisma } = require('@prisma/client');

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
const OTHER_USER = 8;
const PIN = '1234';
let db;
let ids;

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
  if (Array.isArray(cond.path)) {
    let v = value;
    for (const p of cond.path) v = v == null ? undefined : v[p];
    return eq(v, cond.equals);
  }
  for (const [op, raw] of Object.entries(cond)) {
    const arg = plain(raw);
    if (op === 'not' && !(arg === null ? value != null : value != null && !eq(value, arg))) return false;
    if (op === 'in' && !arg.some(a => eq(value, a))) return false;
    if (op === 'lte' && !(value != null && time(value) <= time(arg))) return false;
    if (op === 'lt' && !(value != null && time(value) < time(arg))) return false;
    if (op === 'gte' && !(value != null && time(value) >= time(arg))) return false;
    if (op === 'gt' && !(value != null && time(value) > time(arg))) return false;
  }
  return true;
}

function matches(row, where = {}) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') {
      if (!cond.some(w => matches(row, w))) return false;
    } else if (key === 'AND') {
      if (!cond.every(w => matches(row, w))) return false;
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
  if (!('updated_at' in data) && 'updated_at' in row) row.updated_at = new Date(Math.max(Date.now(), time(row.updated_at || 0) + 1));
}

function project(row, select) {
  if (!row || !select) return clone(row);
  const out = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = clone(row[k]);
  return out;
}

function sortRows(rows, orderBy) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap(o => Object.entries(o));
  return rows.sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = time(a[k]);
      const y = time(b[k]);
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const DEFAULTS = {
  virtualCard: () => ({
    provider: 'payvessel', provider_card_id: null, status: 'creating', provider_status: null, brand: 'MASTERCARD', currency: 'USD',
    name_enc: null, masked_pan_enc: null, expiry_enc: null, balance_cents: 0, balance_synced_at: null, refund_trx: null,
    bvn_idx: null, nin_idx: null, create_state: 'pending', create_attempted_at: null, create_checks: 0, failure_reason: null,
    provider_message: null, fee_due_cents: 0, first_funded_at: null, fund_reminder_at: null, activated_at: null, frozen_at: null,
    frozen_by: null, failed_at: null, terminated_at: null, termination_refund_trx: null, pending_alerted_at: null, checked_at: null,
  }),
  virtualCardFunding: () => ({
    status: 'processing', provider_state: 'pending', fee_due_cents: 0, cost_rate_kobo: null, provider_txn_id: null, provider_message: null,
    failure_reason: null, refund_trx: null, checks: 0, sent_at: null, settled_at: null, checked_at: null,
  }),
  virtualCardTransaction: () => ({ status: null, fee_cents: 0, currency: 'USD', merchant_enc: null, merchant_country: null, description_enc: null }),
  virtualCardEvent: () => ({ actor: 'system', meta: null }),
  virtualCardWebhook: () => ({ card_id: null, provider_reference: null, outcome: 'received', detail: null, attempts: 1, received_at: new Date(), processed_at: null }),
  walletTransaction: () => ({ details: null, other_data: null, meta: null }),
  appSetting: () => ({ description: null }),
  idempotencyKey: () => ({ response_status: null, response_body: null }),
  kycVerification: () => ({}),
  fundingTransaction: () => ({}),
  user: () => ({}),
};

const UNIQUE = {
  virtualCard: ['reference', 'provider_card_id', 'termination_refund_trx'],
  virtualCardFunding: ['reference', 'provider_txn_id'],
  virtualCardTransaction: ['provider_txn_id'],
  virtualCardWebhook: ['delivery_key'],
  walletTransaction: ['trx'],
  appSetting: ['setting_key'],
  idempotencyKey: ['key_idx'],
  kycVerification: ['user_id'],
};

// The partial unique indexes from scripts/apply-virtual-card-ddl.js.
const LIVE = ['creating', 'active', 'frozen'];
const PARTIAL = {
  virtualCard: (row, rows) => LIVE.includes(row.status) && rows.some(r => r.user_id === row.user_id && LIVE.includes(r.status)),
  virtualCardFunding: (row, rows) => row.status === 'processing' && rows.some(r => r.card_id === row.card_id && r.status === 'processing'),
};

function insert(table, data) {
  const now = new Date();
  const row = { ...DEFAULTS[table](), created_at: now, updated_at: now, ...plain(data) };
  for (const col of UNIQUE[table] || []) {
    if (row[col] != null && db[table].some(r => r[col] === row[col])) throw P2002();
  }
  if (PARTIAL[table]?.(row, db[table])) throw P2002();
  if (row.id == null) row.id = ++ids[table];
  db[table].push(row);
  return row;
}

function model(table, undo) {
  const remember = fn => undo && undo.push(fn);
  return {
    async findUnique({ where, select }) {
      return project(db[table].find(r => matches(r, where)) || null, select);
    },
    async findFirst({ where, orderBy, select } = {}) {
      return project(sortRows(db[table].filter(r => matches(r, where)), orderBy)[0] || null, select);
    },
    async findMany({ where, orderBy, take, skip = 0, select } = {}) {
      const rows = sortRows(db[table].filter(r => matches(r, where)), orderBy).slice(skip, take ? skip + take : undefined);
      return rows.map(r => project(r, select));
    },
    async count({ where } = {}) {
      return db[table].filter(r => matches(r, where)).length;
    },
    async create({ data }) {
      const row = insert(table, data);
      remember(() => (db[table] = db[table].filter(r => r !== row)));
      return clone(row);
    },
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const d of data) {
        try {
          const row = insert(table, d);
          remember(() => (db[table] = db[table].filter(r => r !== row)));
          count += 1;
        } catch (e) {
          if (!(skipDuplicates && e.code === 'P2002')) throw e;
        }
      }
      return { count };
    },
    async update({ where, data }) {
      const row = db[table].find(r => matches(r, where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      const before = clone(row);
      applyData(row, data);
      remember(() => Object.assign(row, before));
      return clone(row);
    },
    async updateMany({ where, data }) {
      const rows = db[table].filter(r => matches(r, where));
      for (const row of rows) {
        const before = clone(row);
        applyData(row, data);
        remember(() => Object.assign(row, before));
      }
      return { count: rows.length };
    },
    async deleteMany({ where } = {}) {
      const gone = db[table].filter(r => matches(r, where));
      db[table] = db[table].filter(r => !matches(r, where));
      remember(() => db[table].push(...gone));
      return { count: gone.length };
    },
    async delete({ where }) {
      const row = db[table].find(r => matches(r, where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      db[table] = db[table].filter(r => r !== row);
      remember(() => db[table].push(row));
      return clone(row);
    },
    async upsert({ where, update, create }) {
      const row = db[table].find(r => matches(r, where));
      if (row) {
        const before = clone(row);
        applyData(row, update);
        remember(() => Object.assign(row, before));
        return clone(row);
      }
      const made = insert(table, create);
      remember(() => (db[table] = db[table].filter(r => r !== made)));
      return clone(made);
    },
    async aggregate({ where, _sum, _count }) {
      const rows = db[table].filter(r => matches(r, where));
      const sum = {};
      for (const k of Object.keys(_sum || {})) sum[k] = rows.length ? rows.reduce((n, r) => n + Number(r[k] || 0), 0) : null;
      return { _sum: sum, ...(_count ? { _count: { _all: rows.length } } : {}) };
    },
    async groupBy({ by, where }) {
      const groups = new Map();
      for (const r of db[table].filter(x => matches(x, where))) {
        const key = by.map(k => r[k]).join('|');
        const g = groups.get(key) || { ...Object.fromEntries(by.map(k => [k, r[k]])), _count: { _all: 0 } };
        g._count._all += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  };
}

const TABLES = Object.keys(DEFAULTS);

function client(undo) {
  return Object.fromEntries(TABLES.map(t => [t, model(t, undo)]));
}

// Transactions run one at a time (row locks would serialise these writes) and
// a failure undoes exactly its own writes - never a concurrent request's.
let txChain = Promise.resolve();
const fakePrisma = {
  ...client(null),
  async $transaction(fn) {
    const run = async () => {
      const undo = [];
      try {
        return await fn(client(undo));
      } catch (e) {
        for (const u of undo.reverse()) u();
        throw e;
      }
    };
    const p = txChain.then(run, run);
    txChain = p.catch(() => {});
    return p;
  },
};

/* ------------------------------------------------------- module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { pushes: [], paged: [], errors: [], security: [] };
const pushKeys = new Set();
let kycVerified = true;

stub('../database/prisma', fakePrisma);

const real = require('../src/funding/payvesselCard.service');
const pv = {};
const kindError = (kind, message = 'provider said no') => Object.assign(new Error(message), { kind, providerMessage: message });
const answer = a => {
  if (a instanceof Error) throw a;
  return clone(a);
};
stub('../src/funding/payvesselCard.service', {
  ...real,
  isConfigured: () => true,
  createCard: async args => {
    pv.calls.push(['create', args]);
    return answer(pv.create);
  },
  getCard: async (id, opts = {}) => {
    pv.calls.push(['get', id, opts.withSecrets ? 'secrets' : 'plain']);
    // A function may hand back a promise - a Payvessel that answers late.
    return answer(typeof pv.get === 'function' ? await pv.get(id, opts) : pv.get);
  },
  listCards: async () => {
    pv.calls.push(['list']);
    return answer(pv.list);
  },
  fundCard: async (id, cents) => {
    pv.calls.push(['fund', id, cents]);
    return answer(pv.fund);
  },
  freezeCard: async id => {
    pv.calls.push(['freeze', id]);
    return answer(pv.freeze);
  },
  unfreezeCard: async id => {
    pv.calls.push(['unfreeze', id]);
    return answer(pv.unfreeze);
  },
  terminateCard: async id => {
    pv.calls.push(['terminate', id]);
    return answer(pv.terminate);
  },
  listTransactions: async id => {
    pv.calls.push(['txns', id]);
    return answer(pv.txns);
  },
  walletBalance: async () => ({ available_cents: 1_000_000, ledger_cents: 1_000_000, currency: 'USD' }),
});
// The real notify writes a row keyed on client_message_id; the stub keeps that
// one property, which is what makes a push exactly-once.
stub('../src/services/notify.service', {
  notifyUser: async args => {
    const key = `${args.userId}|${args.clientMessageId}`;
    if (args.clientMessageId && pushKeys.has(key)) return false;
    pushKeys.add(key);
    spy.pushes.push(args);
    return true;
  },
});
stub('../src/services/alerts.service', {
  captureError: (scope, e) => spy.errors.push({ scope, message: e?.message }),
  paymentFailure: async p => spy.paged.push(p),
  securityEvent: (scope, message, ctx) => spy.security.push({ scope, message, ctx }),
  isEnabled: () => false,
});
stub('../src/services/userAudit.service', { logUserEvent: async () => null, logMoneyEvent: async () => null, listUserEvents: async () => [] });
stub('../src/helpers/kycGate.helper', {
  isKycVerified: async () => kycVerified,
  checkSpendKyc: async () => ({ ok: true }),
});

const pii = require('../src/helpers/pii.helper');
const VC = require('../src/helpers/virtualCard.helper');
const service = require('../src/services/virtualCard.service');
const controller = require('../src/controllers/virtualCard.controller');
const idempotency = require('../src/middlewares/idempotency.middleware');

/* ------------------------------------------------------------------ setup */

const BVN = '22345678901';
const NIN = '12345678901';
const MASKED = '557350******7848';
const PAN = '5573507899627848';
// A JPEG by its bytes: the magic number, then enough body to pass the floor.
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(6000)]).toString('base64');
let PIN_HASH;

function seed() {
  ids = Object.fromEntries(TABLES.map(t => [t, 0]));
  db = Object.fromEntries(TABLES.map(t => [t, []]));
  const now = new Date();
  for (const [uid, first, last, email, mobile] of [
    [USER_ID, 'Ada', 'Obi', 'ada@example.com', '2348031234567'],
    [OTHER_USER, 'Bola', 'Tinubu', 'bola@example.com', '2348039999999'],
  ]) {
    insert('user', {
      id: uid,
      balance: 50_000,
      balance_mac: null,
      pin: PIN_HASH,
      ...pii.protectUserFields({ firstname: first, lastname: last, email, mobile, address: '12 Allen Avenue', state: 'Lagos', city: 'Ikeja', zip: '100001' }),
    });
  }
  insert('kycVerification', {
    user_id: USER_ID,
    status: 'verified',
    bvn_enc: pii.protect(BVN, 'bvn').enc,
    bvn_idx: pii.blindIndex(BVN, 'bvn'),
    nin_slip_status: 'none',
    first_name_enc: pii.protect('Ada', 'name').enc,
    last_name_enc: pii.protect('Obi', 'name').enc,
    dob_enc: pii.protect('15/05/1990', 'dob').enc,
  });
  for (const [k, v] of [['vcard_creation_fee', '5000'], ['vcard_fx_cost_rate', '1550']]) {
    insert('appSetting', { setting_key: k, setting_value: v, created_at: now, updated_at: now });
  }
}

function reset() {
  seed();
  spy.pushes = [];
  spy.paged = [];
  spy.errors = [];
  spy.security = [];
  pushKeys.clear();
  kycVerified = true;
  pv.calls = [];
  pv.create = { id: 'pv-1', status: 'PENDING', masked_pan: '', expiry: '', balance_cents: 0 };
  pv.get = activeCard();
  pv.list = [];
  pv.fund = activeCard({ balance_cents: 1265 });
  pv.freeze = activeCard({ status: 'FROZEN' });
  pv.unfreeze = activeCard();
  pv.terminate = activeCard({ status: 'TERMINATED', balance_cents: 0 });
  pv.txns = [];
}

/** Payvessel answering Get a Card differently on each read: before, after. */
function reads(...answers) {
  let i = 0;
  return () => {
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (a instanceof Error) throw a;
    return a;
  };
}

function activeCard(over = {}) {
  return { id: 'pv-1', status: 'ACTIVE', masked_pan: MASKED, expiry: '08/31', name: 'Ada Obi', card_name: 'Ada Obi', customer_name: 'OBI ADA', kind: 'customer', balance_cents: 0, ...over };
}

const body = (over = {}) => ({
  consent: true,
  expected_fee: 5000,
  image: `data:image/jpeg;base64,${PHOTO}`,
  street: '12 Allen Avenue',
  state: 'Lagos',
  lga: 'Ikeja',
  postal_code: '100001',
  nin: NIN,
  ...over,
});

const balance = (uid = USER_ID) => db.user.find(u => u.id === uid).balance;
const ledger = (uid = USER_ID) => db.walletTransaction.filter(t => t.user_id === uid);
const card = () => db.virtualCard[db.virtualCard.length - 1];
const ago = ms => new Date(Date.now() - ms);
const calls = name => pv.calls.filter(c => c[0] === name);
const tick = () => new Promise(r => setImmediate(r));

/** A live, funded-able card straight into the table, as activation leaves it. */
function liveCard(over = {}) {
  return insert('virtualCard', {
    user_id: USER_ID,
    reference: VC.newReference('VC'),
    provider_card_id: 'pv-1',
    status: 'active',
    provider_status: 'ACTIVE',
    create_state: 'accepted',
    name_enc: pii.protectText('Ada Obi'),
    masked_pan_enc: pii.protectText(MASKED),
    expiry_enc: pii.protectText('08/31'),
    balance_cents: 0,
    balance_synced_at: new Date(),
    creation_fee: 5000,
    creation_trx: 'vcard_seed',
    bvn_idx: pii.blindIndex(BVN, 'bvn'),
    nin_idx: pii.blindIndex(NIN, 'nin_slip'),
    activated_at: new Date(),
    checked_at: new Date(),
    ...over,
  });
}

async function refused(promise, remark) {
  try {
    await promise;
  } catch (e) {
    assert.strictEqual(e.remark, remark, `expected ${remark}, got ${e.remark}: ${e.message}`);
    return e;
  }
  throw new Error(`expected a ${remark} refusal, but it went through`);
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false };
  res.status = code => ((res.statusCode = code), res);
  res.set = (k, v) => ((res.headers[k.toLowerCase()] = v), res);
  res.json = b => ((res.body = b), (res.headersSent = true), res);
  res.end = () => res;
  return res;
}

/** The real middleware in front of the real controller, as the router runs them. */
async function viaIdempotency(name, handler, req) {
  const res = fakeRes();
  await idempotency({ name })(req, res, () => handler(req, res));
  await tick();
  return res;
}

/* ------------------------------------------------------------------ tests */

let passed = 0;
let failed = 0;
async function test(name, fn) {
  reset();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.error(e);
  }
}

async function main() {
  PIN_HASH = await pii.hashSecret(PIN, 'pin');

  console.log('pricing');

  await test('₦20,000 at ₦1,550 + 2% buys $12.65, the $1 fee floor applies, the total is exact', async () => {
    const s = await service.getSettings();
    assert.strictEqual(s.fx.customer_rate_kobo, 158_100);
    const q = VC.quoteFunding({ amountNgn: 20000, settings: s });
    assert.strictEqual(q.cents, 1265); // 20,000 / 1,581 = 12.6502 -> down to 12.65
    assert.strictEqual(q.fee_cents, 100); // 2.5% is 32c, under the $1 floor
    assert.strictEqual(q.fee_kobo, 158_100);
    assert.strictEqual(q.total_kobo, 2_158_100);
    const big = VC.quoteFunding({ amountNgn: 1_000_000, settings: s });
    assert.strictEqual(big.fee_cents, Math.ceil(big.cents * 0.025)); // above the floor, 2.5% rounded up
  });

  await test('an unset dollar rate means no top-ups, and a stale one stops them', async () => {
    db.appSetting = db.appSetting.filter(r => r.setting_key !== 'vcard_fx_cost_rate');
    assert.strictEqual((await service.getSettings()).funding_available, false);
    insert('appSetting', { setting_key: 'vcard_fx_cost_rate', setting_value: '1550', created_at: ago(48 * 3_600_000), updated_at: ago(48 * 3_600_000) });
    const s = await service.getSettings();
    assert.strictEqual(s.funding_available, false);
    assert.match(s.funding_unavailable_reason, /dollar rate/);
    assert.strictEqual(VC.publicSettings(s).rate, null, 'no rate is shown that nobody can buy at');
  });

  console.log('create');

  await test('one debit, one ledger row, the card waits on Payvessel - identity sent, never stored', async () => {
    const out = await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    assert.strictEqual(out.processing, true);
    assert.strictEqual(balance(), 45_000);
    assert.strictEqual(ledger().length, 1);
    assert.deepStrictEqual([ledger()[0].trx_type, ledger()[0].total_amount, ledger()[0].remark], ['-', 5000, 'virtual_card']);
    assert.strictEqual(card().status, 'creating');
    assert.strictEqual(card().provider_card_id, 'pv-1');
    assert.strictEqual(card().create_state, 'accepted');
    const [, sent] = calls('create')[0];
    assert.strictEqual(sent.kyc.bvn, BVN, 'the BVN on file is used');
    assert.strictEqual(sent.kyc.nin, NIN, 'the typed NIN is used');
    assert.strictEqual(sent.kyc.dob, '1990-05-15', "the register's date, in Payvessel's format");
    assert.strictEqual(sent.kyc.phone, '08031234567', 'the 11-digit local form');
    assert.ok(sent.kyc.image.startsWith('data:image/jpeg;base64,'));
    assert.strictEqual(sent.reference, card().reference);
    assert.strictEqual(sent.brand, 'MASTERCARD');
    assert.strictEqual(sent.prefundCents, 100, 'created holding the $1 Payvessel requires');
    const stored = JSON.stringify(db);
    for (const secret of [BVN, NIN, PHOTO.slice(0, 40), 'ada@example.com', '08031234567']) {
      assert.ok(!stored.includes(secret), `stored in plain text: ${secret.slice(0, 12)}`);
    }
  });

  await test('Payvessel refuses: the fee comes back once, the card is failed with their reason', async () => {
    pv.create = kindError('refused', 'BVN: BVN ••• could not be verified');
    const e = await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'card_declined');
    assert.strictEqual(e.statusCode, 422);
    assert.strictEqual(e.data.refunded, true);
    assert.match(e.message, /could not be verified/);
    assert.match(e.message, /₦5,000\.00 has been returned/);
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(card().status, 'failed');
    assert.ok(card().refund_trx);
    assert.deepStrictEqual(ledger().map(t => t.trx_type).sort(), ['+', '-']);
    // Again, from anywhere: the guarded claim refuses a second refund.
    assert.strictEqual(await service.__test.refundCreation(card(), { reason: 'again' }), false);
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(ledger().length, 2);
    // A failed attempt is not a live card - the customer can try again.
    pv.create = { id: 'pv-2', status: 'PENDING' };
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    assert.strictEqual(balance(), 45_000);
  });

  await test('our outage (float, keys) refunds, pages ops, and never blames the customer', async () => {
    pv.create = kindError('float', 'Insufficient wallet balance');
    const e = await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'card_unavailable');
    assert.strictEqual(e.statusCode, 503);
    assert.ok(!/insufficient/i.test(e.message), 'our float is not the customer\'s problem');
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(spy.paged.length, 1);
    assert.strictEqual(spy.paged[0].provider, 'payvessel');
  });

  await test('a lost answer keeps the fee; the sweep finds the card by name and time and activates it', async () => {
    pv.create = kindError('ambiguous', 'transport: timeout');
    const out = await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    assert.strictEqual(out.processing, true);
    assert.strictEqual(balance(), 45_000, 'NOT refunded - the create may have run');
    assert.strictEqual(card().create_state, 'unknown');
    assert.strictEqual(card().provider_card_id, null);
    pv.list = [
      activeCard({ id: 'pv-other', card_name: 'Someone Else', customer_name: 'ELSE SOMEONE', created_at: new Date().toISOString() }),
      activeCard({ id: 'pv-9', created_at: new Date().toISOString() }),
    ];
    card().updated_at = ago(2 * 60_000);
    await service.sweep();
    assert.strictEqual(card().status, 'active');
    assert.strictEqual(card().provider_card_id, 'pv-9');
    assert.strictEqual(pii.revealText(card().masked_pan_enc), MASKED);
    assert.strictEqual(ledger().length, 1, 'no refund');
    assert.strictEqual(spy.pushes.filter(p => /ready/.test(p.subject)).length, 1);
    assert.strictEqual(calls('create').length, 1, 'never re-sent');
  });

  await test('a lost answer with nothing at Payvessel is refunded only after three good reads over the window, once', async () => {
    pv.create = kindError('ambiguous');
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    const row = () => db.virtualCard[0];
    for (let i = 0; i < 3; i += 1) await service.settleCreating(clone(row()));
    assert.strictEqual(row().status, 'creating', 'three reads, but the window has not passed');
    row().create_attempted_at = ago(31 * 60_000);
    await service.settleCreating(clone(row()));
    assert.strictEqual(row().status, 'failed');
    assert.strictEqual(balance(), 50_000);
    assert.ok(spy.paged.some(p => p.action === 'card_create_unconfirmed'), 'ops told it was refunded on absence of evidence');
    await service.settleCreating(clone(row()));
    assert.strictEqual(ledger().length, 2, 'refunded once');
  });

  await test('a read that fails is not evidence of anything', async () => {
    pv.create = kindError('ambiguous');
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    card().create_attempted_at = ago(60 * 60_000);
    card().create_checks = 10;
    pv.list = kindError('outage', 'HTTP 502');
    await assert.rejects(service.settleCreating(clone(card())));
    assert.strictEqual(card().status, 'creating');
    assert.strictEqual(card().create_checks, 10);
    assert.strictEqual(balance(), 45_000);
  });

  await test('debited but never sent (the process died): refunded without asking Payvessel', async () => {
    const row = insert('virtualCard', { user_id: USER_ID, reference: 'VC-DEADPROC', status: 'creating', create_state: 'pending', creation_fee: 5000, creation_trx: 'vcard_dead', updated_at: ago(3 * 60_000) });
    db.user[0].balance = 45_000;
    insert('walletTransaction', { user_id: USER_ID, trx: 'vcard_dead', trx_type: '-', amount: 5000, charge: 0, total_amount: 5000, remark: 'virtual_card' });
    await service.sweep();
    assert.strictEqual(db.virtualCard.find(r => r.id === row.id).status, 'failed');
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(pv.calls.length, 0, 'nobody asked Payvessel about a request it never received');
  });

  await test('PENDING -> ACTIVE stores the card face encrypted and pushes once; FAILED refunds once', async () => {
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    await service.settleCreating(clone(card()));
    await service.settleCreating(clone(card()));
    assert.strictEqual(card().status, 'active');
    assert.strictEqual(pii.revealText(card().expiry_enc), '08/31');
    assert.ok(!JSON.stringify(db).includes(MASKED), 'the masked number is ciphertext at rest');
    assert.strictEqual(spy.pushes.filter(p => /ready/.test(p.subject)).length, 1);
    const pub = VC.publicCard(card());
    assert.deepStrictEqual([pub.name, pub.masked_pan, pub.last4, pub.expiry], ['ADA OBI', MASKED, '7848', '08/31']);
    assert.ok(pub.fund_by, 'a never-funded card carries its deadline');

    reset();
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    pv.get = { id: 'pv-1', status: 'FAILED' };
    await service.settleCreating(clone(card()));
    await service.settleCreating(clone(card()));
    assert.strictEqual(card().status, 'failed');
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(ledger().length, 2);
    assert.strictEqual(spy.pushes.filter(p => /could not be created/.test(p.subject)).length, 1);
  });

  await test('two creates racing: one card, one debit, one enrolment', async () => {
    const [a, b] = await Promise.allSettled([
      service.createCard({ userId: USER_ID, body: body(), pin: PIN }),
      service.createCard({ userId: USER_ID, body: body(), pin: PIN }),
    ]);
    const outcomes = [a, b].map(r => (r.status === 'fulfilled' ? 'ok' : r.reason.remark)).sort();
    assert.deepStrictEqual(outcomes, ['card_exists', 'ok']);
    assert.strictEqual(db.virtualCard.length, 1);
    assert.strictEqual(balance(), 45_000);
    assert.strictEqual(calls('create').length, 1);
  });

  await test('refused before any debit: wrong PIN, short wallet, no KYC, no consent, BVN or NIN on another account', async () => {
    await refused(service.createCard({ userId: USER_ID, body: body(), pin: '9999' }), 'invalid_pin');
    db.user[0].balance = 100;
    await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'insufficient_balance');
    assert.strictEqual(db.virtualCard.length, 0, 'the card row rolled back with the debit');
    assert.strictEqual(ledger().length, 0);
    db.user[0].balance = 50_000;
    kycVerified = false;
    await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'kyc_required');
    kycVerified = true;
    await refused(service.createCard({ userId: USER_ID, body: body({ consent: false }), pin: PIN }), 'consent_required');
    await refused(service.createCard({ userId: USER_ID, body: body({ image: Buffer.from('<svg/>').toString('base64') }), pin: PIN }), 'photo_invalid');
    await refused(service.createCard({ userId: USER_ID, body: body({ postal_code: '12' }), pin: PIN }), 'validation_error');
    insert('virtualCard', { user_id: OTHER_USER, reference: 'VC-OTHER', status: 'active', creation_fee: 5000, creation_trx: 'x', nin_idx: pii.blindIndex(NIN, 'nin_slip') });
    await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'identity_in_use');
    assert.strictEqual(spy.security.length, 1);
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(calls('create').length, 0, 'Payvessel never asked');
  });

  console.log('creation price');

  await test('the creation price is the admin\'s: what they set is what is charged, and a refund returns what was paid', async () => {
    await service.updateSettings({ creation_fee: '7500' });
    assert.strictEqual((await service.getSettings()).creation_fee, 7500);
    pv.create = { id: 'pv-1', status: 'PENDING' };
    await service.createCard({ userId: USER_ID, body: body({ expected_fee: 7500 }), pin: PIN });
    assert.strictEqual(balance(), 50_000 - 7500);
    assert.strictEqual(card().creation_fee, 7500, 'the price paid is frozen onto the card');
    // The admin moves the price; then Payvessel fails the card. The customer
    // gets back what THEY paid, not today's price.
    await service.updateSettings({ creation_fee: '9000' });
    pv.get = { id: 'pv-1', status: 'FAILED' };
    await service.settleCreating(clone(card()));
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(ledger().find(t => t.trx_type === '+').total_amount, 7500);
  });

  await test('no price set means no card can be bought - never a free one', async () => {
    db.appSetting = db.appSetting.filter(r => r.setting_key !== 'vcard_creation_fee');
    const s = await service.getSettings();
    assert.strictEqual(s.creation_available, false);
    assert.strictEqual(VC.publicSettings(s).creation_fee, null);
    await refused(service.validateApplication(USER_ID, body()), 'creation_unavailable');
    await refused(service.createCard({ userId: USER_ID, body: body(), pin: PIN }), 'creation_unavailable');
    await refused(service.updateSettings({ creation_fee: '0' }), 'validation_error');
    await refused(service.updateSettings({ creation_fee: '4999.50' }), 'validation_error');
    assert.strictEqual(balance(), 50_000);
  });

  await test('a price changed after review is refused with the new price - before the PIN, before any debit', async () => {
    await service.updateSettings({ creation_fee: '6000' });
    const e = await refused(service.createCard({ userId: USER_ID, body: body({ expected_fee: 5000 }), pin: 'wrong' }), 'price_changed');
    assert.strictEqual(e.statusCode, 409);
    assert.strictEqual(e.data.creation_fee, 6000);
    assert.match(e.message, /₦6,000\.00/);
    await refused(service.createCard({ userId: USER_ID, body: body({ expected_fee: undefined }), pin: PIN }), 'validation_error');
    assert.strictEqual(db.virtualCard.length, 0);
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(calls('create').length, 0);
  });

  await test('Payvessel gets the starting balance it requires: never under $1, the admin can raise it', async () => {
    // The real adapter's request body, with the network replaced.
    const realFetch = global.fetch;
    let sentBody = null;
    global.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { status: 201, text: async () => JSON.stringify({ status: true, data: { id: 'pv-x', status: 'PENDING' } }) };
    };
    try {
      await real.createCard({ reference: 'VC-TEST', name: 'Ada Obi', prefundCents: 100, kyc: {} });
      assert.strictEqual(sentBody.prefund_amount, '1.00');
      await real.createCard({ reference: 'VC-TEST2', name: 'Ada Obi', prefundCents: 0, kyc: {} });
      assert.strictEqual(sentBody.prefund_amount, '1.00', 'a missing or zero figure still sends the floor');
    } finally {
      global.fetch = realFetch;
    }

    await refused(service.updateSettings({ create_prefund_usd: '0.50' }), 'validation_error');
    await service.updateSettings({ create_prefund_usd: '5' });
    assert.strictEqual(VC.publicSettings(await service.getSettings()).starting_balance_usd, '5.00');
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    assert.strictEqual(calls('create')[0][1].prefundCents, 500);
    assert.strictEqual(ledger()[0].meta.prefund_cents, 500);
    // It activates holding its starting balance: funded, so no 21-day warning.
    pv.get = activeCard({ balance_cents: 500 });
    await service.settleCreating(clone(card()));
    assert.ok(card().first_funded_at);
    assert.strictEqual(VC.publicCard(card()).fund_by, null);
  });

  console.log('fund');

  await test('one debit of amount + fee, Payvessel asked for the dollars, the balance is Payvessel\'s', async () => {
    liveCard();
    const out = await service.fundCard({ userId: USER_ID, amountNgn: '20000', expectedTotal: 21581, pin: PIN });
    assert.strictEqual(out.processing, false);
    assert.strictEqual(balance(), 50_000 - 21_581);
    const row = ledger()[0];
    assert.deepStrictEqual([row.trx_type, row.amount, row.charge, row.total_amount], ['-', 20000, 1581, 21581]);
    assert.strictEqual(row.other_data.feedback, 'Successful');
    assert.deepStrictEqual(calls('fund')[0].slice(1), ['pv-1', 1265]);
    assert.strictEqual(db.virtualCardFunding[0].status, 'successful');
    assert.strictEqual(card().balance_cents, 1265);
    assert.ok(card().first_funded_at);
  });

  await test('a moved price is refused with the new quote, before the PIN and before any debit', async () => {
    liveCard();
    const e = await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', expectedTotal: 21000, pin: 'wrong' }), 'quote_changed');
    assert.strictEqual(e.data.quote.total_ngn, 21581);
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(db.virtualCardFunding.length, 0);
  });

  await test('Payvessel refuses a top-up: refunded once, the fees it was settling are owed again', async () => {
    liveCard({ fee_due_cents: 50 });
    pv.fund = kindError('refused', 'Card is not active');
    const e = await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'funding_declined');
    assert.strictEqual(e.data.refunded, true);
    assert.deepStrictEqual(calls('fund')[0].slice(1), ['pv-1', 1215], 'the fee due came out of what was sent');
    assert.strictEqual(balance(), 50_000);
    const f = db.virtualCardFunding[0];
    assert.strictEqual(f.status, 'failed');
    assert.strictEqual(card().fee_due_cents, 50, 'still owed');
    assert.strictEqual(await service.__test.refundFunding(clone(f), { reason: 'again' }), false);
    assert.strictEqual(ledger().length, 2);
    assert.strictEqual(ledger().find(t => t.trx_type === '-').other_data.feedback, 'Failed');
  });

  await test('our outage on a top-up refunds and pages ops', async () => {
    liveCard();
    pv.fund = kindError('misconfigured', 'Unauthorized. Please check your API key.');
    const e = await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'funding_unavailable');
    assert.strictEqual(e.statusCode, 503);
    assert.ok(!/api key/i.test(e.message));
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(spy.paged.length, 1);
  });

  await test('a lost top-up answer is matched in the card history - success, no refund, listed once', async () => {
    liveCard();
    pv.fund = kindError('ambiguous', 'HTTP 504');
    const out = await service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN });
    assert.strictEqual(out.processing, true);
    assert.strictEqual(balance(), 50_000 - 21_581);
    assert.strictEqual(db.virtualCardFunding[0].provider_state, 'unknown');
    pv.txns = [
      { id: 'tx-old', type: 'FUNDING', entry: 'CREDIT', status: 'SUCCESS', amount_cents: 1265, occurred_at: ago(60 * 60_000).toISOString() },
      { id: 'tx-1', type: 'FUNDING', entry: 'CREDIT', status: 'SUCCESS', amount_cents: 1265, occurred_at: new Date().toISOString() },
    ];
    pv.get = activeCard({ balance_cents: 1265 });
    db.virtualCardFunding[0].updated_at = ago(3 * 60_000);
    await service.sweep();
    const f = db.virtualCardFunding[0];
    assert.strictEqual(f.status, 'successful');
    assert.strictEqual(f.provider_txn_id, 'tx-1', 'not the one from before we sent');
    assert.strictEqual(ledger().length, 1, 'no refund');
    assert.strictEqual(ledger()[0].other_data.feedback, 'Successful');
    const feed = (await service.transactions(USER_ID)).items;
    assert.strictEqual(feed.filter(i => i.kind === 'top_up' && i.amount_usd === '12.65' && i.status === 'successful').length, 2, 'our top-up + the old unrelated one, each once');
    assert.ok(!feed.some(i => i.reference === 'tx-1'), "Payvessel's row for our top-up is folded into ours");
  });

  await test('a lost top-up with nothing in the history is refunded after the window, once', async () => {
    liveCard();
    pv.fund = kindError('ambiguous');
    await service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN });
    const f = () => db.virtualCardFunding[0];
    for (let i = 0; i < 3; i += 1) await service.resolveFunding(clone(f()));
    assert.strictEqual(f().status, 'processing', 'three reads, window not passed');
    f().sent_at = ago(31 * 60_000);
    await service.resolveFunding(clone(f()));
    assert.strictEqual(f().status, 'failed');
    assert.strictEqual(balance(), 50_000);
    await service.resolveFunding(clone(f()));
    assert.strictEqual(ledger().length, 2);
    assert.strictEqual(spy.pushes.filter(p => /did not go through/.test(p.subject)).length, 1);
  });

  await test('one top-up in flight per card: a second is refused while the first is unconfirmed', async () => {
    liveCard();
    pv.fund = kindError('ambiguous');
    await service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN });
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'funding_in_progress');
    assert.strictEqual(balance(), 50_000 - 21_581, 'one debit');
    assert.strictEqual(calls('fund').length, 1);
  });

  await test('limits refuse before any debit: daily, card balance, minimum, frozen, stale rate', async () => {
    const c = liveCard();
    insert('virtualCardFunding', { card_id: c.id, user_id: USER_ID, reference: 'f-today', status: 'successful', amount_ngn: 1, fee_ngn: 0, total_ngn: 1, amount_cents: 99_000, fee_cents: 0, provider_amount_cents: 99_000, rate_kobo: 158_100 });
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'daily_limit');
    db.virtualCardFunding = [];
    c.balance_cents = 499_500;
    db.virtualCard[0].balance_cents = 499_500;
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'balance_limit');
    db.virtualCard[0].balance_cents = 0;
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '1000', pin: PIN }), 'below_minimum');
    db.virtualCard[0].status = 'frozen';
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'card_frozen');
    db.virtualCard[0].status = 'active';
    const rate = db.appSetting.find(r => r.setting_key === 'vcard_fx_cost_rate');
    rate.updated_at = ago(30 * 3_600_000);
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'funding_unavailable');
    assert.strictEqual(balance(), 50_000);
    assert.strictEqual(calls('fund').length, 0);
  });

  console.log('idempotency');

  await test('the same key replays the first answer: one card, one debit, one enrolment', async () => {
    const req = () => ({ user: { id: USER_ID }, headers: { 'x-idempotency-key': 'attempt-1' }, body: { ...body(), pin: PIN } });
    const first = await viaIdempotency('virtual_card_create', controller.create, req());
    assert.strictEqual(first.body.status, 'success');
    const second = await viaIdempotency('virtual_card_create', controller.create, req());
    assert.strictEqual(second.body.replayed, true);
    assert.strictEqual(second.body.data.card.reference, first.body.data.card.reference);
    assert.strictEqual(db.virtualCard.length, 1);
    assert.strictEqual(balance(), 45_000);
    assert.strictEqual(calls('create').length, 1);
    // A refusal is an answer too: replayed, not re-run.
    reset();
    pv.create = kindError('refused', 'NIN: invalid');
    const declined = await viaIdempotency('virtual_card_create', controller.create, req());
    assert.strictEqual(declined.statusCode, 422);
    const again = await viaIdempotency('virtual_card_create', controller.create, req());
    assert.strictEqual(again.body.replayed, true);
    assert.strictEqual(calls('create').length, 1);
    assert.strictEqual(balance(), 50_000);
  });

  await test('a replayed top-up is one debit; a different payload on the same key is refused', async () => {
    liveCard();
    const req = amount => ({ user: { id: USER_ID }, headers: { 'x-idempotency-key': 'fund-1' }, body: { amount, pin: PIN } });
    const first = await viaIdempotency('virtual_card_fund', controller.fund, req('20000'));
    assert.strictEqual(first.body.status, 'success');
    const second = await viaIdempotency('virtual_card_fund', controller.fund, req('20000'));
    assert.strictEqual(second.body.replayed, true);
    assert.strictEqual(calls('fund').length, 1);
    assert.strictEqual(balance(), 50_000 - 21_581);
    const other = await viaIdempotency('virtual_card_fund', controller.fund, req('30000'));
    assert.strictEqual(other.statusCode, 422);
    assert.strictEqual(other.body.remark, 'idempotency_conflict');
  });

  await test('routes: create and fund carry the KYC gate and a key; freeze, unfreeze and reveal never sit behind the kill switch', async () => {
    const router = require('../src/routes/virtualCard.routes');
    const chain = path => router.stack.find(l => l.route?.path === path).route.stack.map(s => s.handle.name);
    for (const path of ['/virtual-card/create', '/virtual-card/fund']) {
      const names = chain(path);
      assert.ok(names.includes('featureGate'), `${path}: kill switch`);
      assert.ok(names.includes('requireKyc'), `${path}: KYC gate`);
      assert.ok(names.includes('idempotencyMiddleware'), `${path}: idempotency`);
      assert.ok(names.indexOf('requireKyc') < names.indexOf('idempotencyMiddleware'), `${path}: a KYC refusal must not burn the key`);
    }
    for (const path of ['/virtual-card/freeze', '/virtual-card/unfreeze', '/virtual-card/reveal']) {
      assert.ok(!chain(path).includes('featureGate'), `${path} must work with the service switched off`);
    }
    assert.ok(!chain('/virtual-card/webhook').includes('userAuth'), 'the webhook is authenticated by its signature');
  });

  console.log('webhook, reveal, freeze, termination');

  function signed(payload, secret = 'PVSECRET-test') {
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac('sha512', secret).update(raw).digest('hex');
    return { headers: { 'payvessel-http-signature': sig }, rawBody: raw, body: payload, ip: '3.255.23.38' };
  }

  await test('a recovered cross-border fee is owed once, and comes out of the next top-up', async () => {
    liveCard();
    const fee = {
      event: 'card.transaction',
      card_id: 'pv-1',
      reference: 'MIDEN_ISSUER_FEE_evt-1',
      event_type: 'cross_border_fee',
      status: 'successful',
      amount: '0.50',
      currency: 'USD',
      charged_from: 'merchant_wallet',
      created_at: new Date().toISOString(),
    };
    const forged = signed(fee, 'not-our-secret');
    const bad = fakeRes();
    await controller.webhook(forged, bad);
    assert.strictEqual(bad.statusCode, 401);
    assert.strictEqual(card().fee_due_cents, 0);
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes();
      await controller.webhook(signed(fee), res);
      assert.strictEqual(res.statusCode, 200);
    }
    assert.strictEqual(card().fee_due_cents, 50, 'delivered twice, owed once');
    assert.strictEqual(spy.pushes.filter(p => /processing fee/i.test(p.subject)).length, 1);
    const q = await service.quote(USER_ID, '20000');
    assert.strictEqual(q.quote.fee_due_usd, '0.50');
    assert.strictEqual(q.quote.card_receives_usd, '12.15');
  });

  await test('a lifecycle webhook is not believed - the card is read back from Payvessel', async () => {
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    pv.get = { id: 'pv-1', status: 'PENDING' };
    const res = fakeRes();
    await controller.webhook(signed({ event: 'issuing.created.failed', reference: card().reference }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(card().status, 'creating', 'Payvessel itself still says PENDING');
    assert.strictEqual(balance(), 45_000);
  });

  await test('webhook answers before the read-back: Payvessel never waits on Payvessel', async () => {
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    let release;
    const slow = new Promise(r => (release = r));
    pv.get = () => slow; // Get a Card hangs until released
    const res = fakeRes();
    const pending = controller.webhook(signed({ event: 'issuing.created.successful', reference: card().reference, card: { id: 'pv-1' } }), res);
    for (let i = 0; i < 20 && !res.body; i += 1) await tick();
    assert.ok(res.body, 'answered while the read-back is still waiting');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(card().status, 'creating');
    release(activeCard());
    await pending;
    assert.strictEqual(card().status, 'active', 'the read-back finished the job after the answer');
    assert.strictEqual(db.virtualCardWebhook[0].outcome, 'processed');
    assert.strictEqual(db.virtualCardWebhook[0].card_id, card().id);
  });

  await test('a resent delivery is recognised: applied once, pushed once, counted twice', async () => {
    liveCard();
    const payment = {
      event: 'issuing.transaction',
      card_id: 'pv-1',
      reference: 'dd7412f3-aa14',
      amount: 15.49,
      currency: 'USD',
      mode: 'DEBIT',
      status: 'SUCCESS',
      type: 'AUTHORIZATION',
      merchant: { name: 'NETFLIX.COM', country: 'US' },
      created_at: new Date().toISOString(),
    };
    const first = fakeRes();
    await controller.webhook(signed(payment), first);
    const second = fakeRes();
    await controller.webhook(signed(payment), second);
    assert.strictEqual(second.body.data.duplicate, true);
    assert.strictEqual(db.virtualCardTransaction.length, 1);
    const pushes = spy.pushes.filter(p => p.subject === 'USD card payment');
    assert.strictEqual(pushes.length, 1);
    assert.match(pushes[0].message, /You paid \$15\.49 at NETFLIX\.COM/);
    assert.strictEqual(db.virtualCardWebhook.length, 1);
    assert.strictEqual(db.virtualCardWebhook[0].attempts, 2);
    assert.ok(!JSON.stringify(db.virtualCardWebhook).includes('NETFLIX'), 'the log keeps ids and outcomes, never the body');
  });

  await test('a decline is pushed with Payvessel\'s reason; a settlement and a top-up are not pushed again', async () => {
    liveCard();
    const base = { card_id: 'pv-1', currency: 'USD', merchant: { name: 'META ADS' }, created_at: new Date().toISOString() };
    for (const [ref, extra] of [
      ['d-1', { event: 'issuing.transaction', mode: 'DEBIT', status: 'FAILED', type: 'DECLINE', amount: 40, description: 'Insufficient funds' }],
      ['s-1', { event: 'issuing.transaction', mode: 'DEBIT', status: 'SUCCESS', type: 'SETTLEMENT', amount: 15.49 }],
      ['f-1', { event: 'issuing.transaction', mode: 'CREDIT', status: 'SUCCESS', type: 'FUNDING', amount: 12.65 }],
    ]) {
      await controller.webhook(signed({ ...base, ...extra, reference: ref }), fakeRes());
    }
    assert.strictEqual(spy.pushes.length, 1);
    assert.strictEqual(spy.pushes[0].subject, 'Card payment declined');
    assert.match(spy.pushes[0].message, /\$40\.00 payment at META ADS was declined: Insufficient funds/);
    assert.strictEqual(spy.pushes[0].type, 'virtual_card');
  });

  await test('an event we cannot place is acknowledged and logged as ignored, never retried forever', async () => {
    for (const payload of [
      { event: 'issuing.transaction', card_id: 'pv-unknown', reference: 'x-1', amount: 5, mode: 'DEBIT', type: 'AUTHORIZATION' },
      { event: 'issuing.activation', card_id: 'pv-1', activation_code: '866026' },
    ]) {
      const res = fakeRes();
      await controller.webhook(signed(payload), res);
      assert.strictEqual(res.statusCode, 200);
    }
    assert.deepStrictEqual(db.virtualCardWebhook.map(w => w.outcome), ['ignored', 'ignored']);
    assert.ok(!JSON.stringify(db).includes('866026'), 'an activation code is never stored');
  });

  await test('a delivery that fails answers 500 so Payvessel resends, and the resend is applied', async () => {
    liveCard();
    const payment = { event: 'issuing.transaction', card_id: 'pv-1', reference: 'p-9', amount: 3, mode: 'DEBIT', status: 'SUCCESS', type: 'AUTHORIZATION', created_at: new Date().toISOString() };
    const realCreateMany = fakePrisma.virtualCardTransaction.createMany;
    fakePrisma.virtualCardTransaction.createMany = async () => {
      throw new Error('connection reset');
    };
    const failed = fakeRes();
    await controller.webhook(signed(payment), failed);
    fakePrisma.virtualCardTransaction.createMany = realCreateMany;
    assert.strictEqual(failed.statusCode, 500);
    assert.strictEqual(db.virtualCardWebhook[0].outcome, 'failed');
    const retried = fakeRes();
    await controller.webhook(signed(payment), retried);
    assert.strictEqual(retried.statusCode, 200);
    assert.strictEqual(db.virtualCardWebhook[0].outcome, 'processed');
    assert.strictEqual(db.virtualCardTransaction.length, 1);
    assert.strictEqual(spy.pushes.length, 1);
  });

  await test('the admin sees the URL to configure and whether Payvessel is calling', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.voltpay.ng/';
    try {
      let status = await service.webhookStatus();
      assert.strictEqual(status.url, 'https://api.voltpay.ng/api/virtual-card/webhook');
      assert.strictEqual(status.last_received_at, null);
      liveCard();
      await controller.webhook(signed({ event: 'issuing.terminated', card_id: 'pv-unknown', amount: 0 }), fakeRes());
      status = (await service.adminOverview()).webhook;
      assert.strictEqual(status.received_24h, 1);
      assert.strictEqual(status.last_event, 'issuing.terminated');
      assert.strictEqual(status.last_outcome, 'ignored');
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  await test('reveal: PIN first, the number once with no-store, nothing kept', async () => {
    liveCard();
    pv.get = (id, opts) => (opts.withSecrets ? { ...activeCard({ balance_cents: 900 }), card_number: PAN, cvv: '321', billing_address: { street: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos', postal_code: '100001', country: 'Nigeria' } } : activeCard());
    await refused(service.revealDetails({ userId: USER_ID, pin: '0000' }), 'invalid_pin');
    assert.strictEqual(calls('get').length, 0, 'no credentials fetched for a wrong PIN');
    const res = fakeRes();
    await controller.reveal({ user: { id: USER_ID }, body: { pin: PIN }, headers: {} }, res);
    assert.strictEqual(res.body.status, 'success');
    assert.strictEqual(res.body.data.details.card_number, PAN);
    assert.strictEqual(res.body.data.details.cvv, '321');
    assert.strictEqual(res.body.data.expires_in, 30);
    assert.match(res.headers['cache-control'], /no-store/);
    const stored = JSON.stringify(db);
    assert.ok(!stored.includes(PAN) && !stored.includes('"cvv"'), 'the number and CVV are never written');
    assert.ok(db.virtualCardEvent.some(e => e.event === 'revealed' && e.meta == null));
    assert.strictEqual(card().balance_cents, 900, 'the balance that came with it is kept');
  });

  await test("freeze: the customer's own freeze is theirs to lift; an admin's is not", async () => {
    liveCard();
    await service.freeze({ userId: USER_ID });
    assert.deepStrictEqual([card().status, card().frozen_by], ['frozen', 'user']);
    await refused(service.unfreeze({ userId: USER_ID, pin: '0000' }), 'invalid_pin');
    await service.unfreeze({ userId: USER_ID, pin: PIN });
    assert.strictEqual(card().status, 'active');
    await service.adminSetFrozen({ id: card().id, frozen: true, note: 'chargeback review', admin: { name: 'ops' } });
    assert.deepStrictEqual([card().status, card().frozen_by], ['frozen', 'admin:ops']);
    await refused(service.unfreeze({ userId: USER_ID, pin: PIN }), 'frozen_by_admin');
    assert.strictEqual(VC.publicCard(card()).frozen_by_admin, true);
    // A freeze Payvessel did not apply is not reported as applied.
    await service.adminSetFrozen({ id: card().id, frozen: false, admin: { name: 'ops' } });
    pv.freeze = activeCard({ status: 'ACTIVE' });
    await refused(service.freeze({ userId: USER_ID }), 'card_action_failed');
    assert.strictEqual(card().status, 'active');
  });

  await test("termination: what Payvessel returned is credited at the cost rate, once", async () => {
    liveCard({ balance_cents: 1200 });
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes();
      await controller.webhook(signed({ event: 'issuing.terminated', card_id: 'pv-1', amount: 12, reason: 'Insufficient Funds', reference: 'term-1' }), res);
      assert.strictEqual(res.statusCode, 200);
    }
    assert.strictEqual(card().status, 'terminated');
    assert.strictEqual(balance(), 50_000 + 18_600, '$12.00 at ₦1,550, no margin');
    assert.strictEqual(ledger().length, 1);
    assert.strictEqual(spy.pushes.filter(p => /closed/.test(p.subject)).length, 1);
  });

  console.log('terminate');

  await test('terminate: closed at Payvessel then here; the balance comes back at the cost rate less fees owed, once', async () => {
    liveCard({ balance_cents: 1240, fee_due_cents: 50 });
    pv.get = activeCard({ balance_cents: 1240 });
    const out = await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(out.alreadyTerminated, false);
    assert.strictEqual(card().status, 'terminated');
    assert.ok(card().terminated_at);
    // $12.40 - $0.50 owed = $11.90, at ₦1,550 (cost, no margin) = ₦18,445.00
    assert.strictEqual(balance(), 50_000 + 18_445);
    assert.strictEqual(ledger().length, 1);
    assert.deepStrictEqual([ledger()[0].trx_type, ledger()[0].total_amount, ledger()[0].trx], ['+', 18_445, `vcterm_${card().reference}`]);
    assert.strictEqual(card().fee_due_cents, 0, 'the fees owed were settled out of it');
    const events = db.virtualCardEvent.map(e => e.event);
    for (const e of ['terminate_requested', 'terminated', 'balance_returned']) assert.ok(events.includes(e), e);
    assert.strictEqual(db.virtualCardEvent.find(e => e.event === 'terminate_requested').meta.balance_cents, 1240, 'recorded before the call');
    assert.deepStrictEqual(pv.calls.map(c => c[0]), ['get', 'terminate'], 'read, terminate - nothing more');
    const pushes = spy.pushes.filter(p => p.subject === 'USD card terminated');
    assert.strictEqual(pushes.length, 1);
    assert.match(pushes[0].message, /\$11\.90 \(₦18,445\.00\) has been returned/);
    assert.match(pushes[0].message, /\$0\.50 of card fees/);

    // Again: already terminated - an answer, not an error, and nothing moves.
    const again = await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(again.alreadyTerminated, true);
    assert.strictEqual(calls('terminate').length, 1);
    // Payvessel's own figure arriving later is kept, never credited twice -
    // and one that disagrees with what we credited pages ops, once.
    await controller.webhook(signed({ event: 'issuing.terminated', card_id: 'pv-1', amount: 11.5, reference: 'term-late' }), fakeRes());
    assert.strictEqual(ledger().length, 1);
    assert.ok(db.virtualCardEvent.some(e => e.event === 'termination_amount_reported' && e.meta.cents === 1150 && e.meta.credited_basis_cents === 1240));
    await controller.webhook(signed({ event: 'issuing.terminated', card_id: 'pv-1', amount: 11.5, reference: 'term-late-2' }), fakeRes());
    const mismatch = spy.paged.filter(p => p.action === 'termination_amount_mismatch');
    assert.strictEqual(mismatch.length, 1);
    assert.match(mismatch[0].message, /returned \$11\.50 .* credited from \$12\.40/);
    assert.strictEqual(ledger().length, 1);

    // A closed card does nothing; a new card is allowed.
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'no_card');
    await refused(service.revealDetails({ userId: USER_ID, pin: PIN }), 'card_not_ready');
    await refused(service.freeze({ userId: USER_ID }), 'no_card');
    pv.create = { id: 'pv-2', status: 'PENDING' };
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    assert.strictEqual(card().status, 'creating', 'one live card per user - and a terminated one is not live');
  });

  await test('already terminated at Payvessel: closed here cleanly, no terminate call, no guess', async () => {
    liveCard({ balance_cents: 0 });
    pv.get = activeCard({ status: 'TERMINATED', balance_cents: 0 });
    const out = await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(out.alreadyTerminated, true);
    assert.strictEqual(card().status, 'terminated');
    assert.strictEqual(calls('terminate').length, 0);
    assert.strictEqual(ledger().length, 0);
    assert.strictEqual(spy.paged.length, 0);

    // Payvessel refusing the terminate with "already terminated" is the same
    // thing: the read-back decides, and the recorded balance is credited.
    reset();
    liveCard({ balance_cents: 300 });
    pv.get = reads(activeCard({ balance_cents: 300 }), activeCard({ status: 'TERMINATED', balance_cents: 0 }));
    pv.terminate = kindError('refused', 'Card already terminated');
    await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(card().status, 'terminated');
    assert.strictEqual(balance(), 50_000 + 4650);
  });

  await test('provider failure: Payvessel says the card is still open - nothing changes, and we say so', async () => {
    liveCard({ balance_cents: 900 });
    pv.get = activeCard({ balance_cents: 900 });
    pv.terminate = kindError('refused', 'Card cannot be terminated at this time');
    const e = await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'termination_failed');
    assert.strictEqual(e.statusCode, 422);
    assert.match(e.message, /Nothing has changed/);
    assert.strictEqual(card().status, 'active');
    assert.strictEqual(ledger().length, 0);
    assert.ok(db.virtualCardEvent.some(ev => ev.event === 'terminate_failed'));

    pv.terminate = kindError('misconfigured', 'Unauthorized. Please check your API key.');
    const outage = await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'termination_failed');
    assert.strictEqual(outage.statusCode, 503);
    assert.strictEqual(spy.paged.length, 1);
    assert.strictEqual(card().status, 'active');

    // A refusal proves nothing happened even when the read-back fails - it is
    // a failure, not a pending termination that would hold the card.
    pv.terminate = kindError('refused', 'Card cannot be terminated at this time');
    pv.get = reads(activeCard({ balance_cents: 900 }), kindError('outage', 'HTTP 502'));
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'termination_failed');

    // Every request above is closed, so the card takes money as before.
    pv.get = activeCard({ balance_cents: 900 });
    const q = await service.quote(USER_ID, '20000');
    assert.ok(q.quote, 'a failed termination does not hold the card');

    // Payvessel unreachable before anything is asked: nothing recorded at all.
    const before = db.virtualCardEvent.length;
    pv.get = kindError('outage', 'HTTP 502');
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'termination_unavailable');
    assert.strictEqual(card().status, 'active');
    assert.strictEqual(db.virtualCardEvent.length, before);
  });

  await test('a lost terminate answer is finished by the sweep, from the balance recorded before the call', async () => {
    liveCard({ balance_cents: 1000 });
    pv.get = reads(activeCard({ balance_cents: 1000 }), kindError('outage', 'HTTP 502'));
    pv.terminate = kindError('ambiguous', 'transport: timeout');
    const out = await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(out.pending, true);
    assert.strictEqual(card().status, 'active', 'not closed here on a guess');
    assert.strictEqual(ledger().length, 0);
    await refused(service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN }), 'card_terminating');
    pv.get = activeCard({ status: 'TERMINATED', balance_cents: 0 });
    await service.sweep();
    assert.strictEqual(card().status, 'terminated');
    assert.strictEqual(balance(), 50_000 + 15_500, '$10.00 recorded before the call, at ₦1,550');
    await service.sweep();
    assert.strictEqual(ledger().length, 1, 'credited once');
    const told = spy.pushes.filter(p => /terminated|closed/.test(p.subject));
    assert.strictEqual(told.length, 1);
    assert.strictEqual(told[0].subject, 'USD card terminated', 'worded for the customer who asked, not as a partner closure');
  });

  await test('an accepted terminate that never shows: closed as not done, the customer told, its balance never credited later', async () => {
    liveCard({ balance_cents: 1000 });
    pv.get = activeCard({ balance_cents: 1000 });
    pv.terminate = activeCard({ status: 'ACTIVE', balance_cents: 1000 });
    const out = await service.terminate({ userId: USER_ID, pin: PIN });
    assert.strictEqual(out.pending, true, 'accepted is not the same as closed');
    assert.strictEqual(card().status, 'active');

    await service.sweep();
    assert.ok(!db.virtualCardEvent.some(e => e.event === 'terminate_failed'), 'still pending inside the window');
    await service.sweep({ now: new Date(Date.now() + 31 * 60_000) });
    assert.ok(db.virtualCardEvent.some(e => e.event === 'terminate_failed' && e.meta.kind === 'still_open'));
    const told = spy.pushes.filter(p => p.subject === 'Your USD card was not terminated');
    assert.strictEqual(told.length, 1);
    assert.match(told[0].message, /nothing has changed/);
    await service.sweep({ now: new Date(Date.now() + 40 * 60_000) });
    assert.strictEqual(spy.pushes.filter(p => p.subject === 'Your USD card was not terminated').length, 1, 'told once');
    assert.ok((await service.quote(USER_ID, '20000')).quote, 'the card takes money again');

    // Weeks later the customer has spent it all, and Payvessel closes the card
    // on its own without naming an amount. The old request's $10.00 is NOT
    // credited - nothing is guessed, ops are paged.
    db.virtualCard[0].balance_cents = 0;
    await controller.webhook(signed({ event: 'issuing.terminated', card_id: 'pv-1', reference: 'term-own' }), fakeRes());
    assert.strictEqual(card().status, 'terminated');
    assert.strictEqual(ledger().length, 0);
    assert.strictEqual(balance(), 50_000);
  });

  await test('another customer cannot terminate this card - there is no card id to point at', async () => {
    liveCard({ balance_cents: 1000 });
    await refused(service.terminate({ userId: OTHER_USER, pin: PIN }), 'no_card');
    await refused(service.terminationPreview(OTHER_USER), 'no_card');
    assert.strictEqual(card().status, 'active');
    assert.strictEqual(pv.calls.length, 0);
    const router = require('../src/routes/virtualCard.routes');
    const routes = router.stack.filter(l => l.route?.path?.includes('terminate'));
    assert.ok(routes.length >= 2 && routes.every(l => !l.route.path.includes(':')), 'the customer routes take no id');
    assert.ok(routes.every(l => l.route.stack.some(s => s.handle.name === 'userAuth')), 'signed-in customers only');
    assert.ok(routes.every(l => !l.route.stack.some(s => s.handle.name === 'featureGate')), 'closing a card is never behind the kill switch');
    const adminRoutes = require('fs').readFileSync(require.resolve('../src/routes/admin.routes'), 'utf8');
    assert.match(adminRoutes, /router\.post\('\/virtual-cards\/:id\/terminate', cardMoney,/, 'admin terminate is finance/superadmin only');
  });

  await test('refused before Payvessel is asked: admin hold, top-up in flight, card being made, stale rate with money, wrong PIN', async () => {
    const c = liveCard({ status: 'frozen', frozen_by: 'admin:ops', balance_cents: 0 });
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'frozen_by_admin');
    await refused(service.adminTerminate({ id: c.id, note: 'short', admin: { name: 'ops' } }), 'note_required');
    pv.get = activeCard({ status: 'FROZEN', balance_cents: 0 });
    await service.adminTerminate({ id: c.id, note: 'Chargeback confirmed by the bank', admin: { name: 'ops' } });
    assert.strictEqual(card().status, 'terminated', 'an admin can close a card under its own hold');
    assert.ok(db.virtualCardEvent.some(e => e.event === 'terminate_requested' && e.actor === 'admin:ops' && /Chargeback/.test(e.meta.note)));
    assert.strictEqual(spy.pushes.filter(p => /closed/.test(p.subject)).length, 1);

    reset();
    const live = liveCard({ balance_cents: 500 });
    insert('virtualCardFunding', { card_id: live.id, user_id: USER_ID, reference: 'f-open', status: 'processing', amount_ngn: 1, fee_ngn: 0, total_ngn: 1, amount_cents: 100, fee_cents: 0, provider_amount_cents: 100, rate_kobo: 158_100 });
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'funding_in_progress');
    db.virtualCardFunding = [];
    await refused(service.terminate({ userId: USER_ID, pin: '0000' }), 'invalid_pin');
    db.appSetting.find(r => r.setting_key === 'vcard_fx_cost_rate').updated_at = ago(30 * 3_600_000);
    pv.get = activeCard({ balance_cents: 500 });
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'rate_unavailable');
    assert.strictEqual(calls('terminate').length, 0);
    db.virtualCard[0].status = 'creating';
    await refused(service.terminate({ userId: USER_ID, pin: PIN }), 'card_not_ready');
    assert.strictEqual(ledger().length, 0);
  });

  await test('the preview says what comes back - in naira, never the rate behind it', async () => {
    liveCard({ fee_due_cents: 50 });
    pv.get = activeCard({ balance_cents: 1240 });
    const p = await service.terminationPreview(USER_ID);
    assert.deepStrictEqual(
      [p.balance_usd, p.fee_due_usd, p.refund_usd, p.refund_ngn, p.can_terminate, p.balance_fresh],
      ['12.40', '0.50', '11.90', 18445, true, true],
    );
    assert.ok(!Object.keys(p).some(k => /rate/.test(k)), 'the cost rate never reaches the app');
    db.virtualCard[0].status = 'frozen';
    db.virtualCard[0].frozen_by = 'admin:ops';
    const held = await service.terminationPreview(USER_ID);
    assert.strictEqual(held.can_terminate, false);
    assert.strictEqual(held.blocked_remark, 'frozen_by_admin');
  });

  await test('nothing personal is stored in plain text across a whole card life', async () => {
    await service.createCard({ userId: USER_ID, body: body(), pin: PIN });
    await service.settleCreating(clone(card()));
    await service.fundCard({ userId: USER_ID, amountNgn: '20000', pin: PIN });
    pv.txns = [{ id: 'tx-9', type: 'AUTHORIZATION', entry: 'DEBIT', status: 'SUCCESS', amount_cents: 500, merchant: 'NETFLIX.COM Ada Obi', occurred_at: new Date().toISOString() }];
    await service.syncTransactions(clone(card()));
    const stored = JSON.stringify(db);
    for (const s of ['Ada Obi', 'ADA OBI', 'ada@example.com', '08031234567', BVN, NIN, MASKED, 'NETFLIX', '12 Allen']) {
      assert.ok(!stored.includes(s), `plain text at rest: ${s}`);
    }
    const feed = (await service.transactions(USER_ID)).items;
    assert.ok(feed.some(i => i.title === 'NETFLIX.COM Ada Obi'), 'decrypted on the way out');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
