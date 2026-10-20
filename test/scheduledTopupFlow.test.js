/**
 * node test/scheduledTopupFlow.test.js
 *
 * Scheduled top-ups end to end - the controller a customer talks to and the
 * worker that buys - against a fake database and a stubbed provider. No
 * network, no Redis, no Postgres.
 *
 *   1. Create is PIN-authorised, priced on the server and refuses duplicates.
 *   2. A due schedule is bought once per cycle: through the pay button's own
 *      reserve / vend / ledger path, by exactly one of two racing workers, and
 *      never twice in a week however the schedule is edited.
 *   3. A low balance retries and says so; a refused vend is refunded and either
 *      retried, paused or closed depending on what the refusal means.
 *   4. Pending vends, dead workers, reminders, price rises and pauses all finish
 *      themselves.
 *   5. The bills pay button behaves exactly as before the purchase core was
 *      shared with the worker.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.SCHEDULED_TOPUPS_RETRY_MINUTES;
process.env.NODE_ENV = 'test';

const { Prisma } = require('@prisma/client');

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
let db;
const ids = { scheduledTopup: 0, scheduledTopupRun: 0 };

function resetDb({ balance = 10_000 } = {}) {
  db = {
    user: [{ id: USER_ID, balance, status: 1, pin: 'hashed' }],
    walletTransaction: [],
    scheduledTopup: [],
    scheduledTopupRun: [],
  };
}

const isDecimal = v => Boolean(v) && typeof v === 'object' && Prisma.Decimal.isDecimal(v);

// What Prisma would store: Decimals become numbers, undefined keys vanish.
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
const time = v => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v);
const eq = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && time(a) === time(b));

function matchField(value, cond) {
  if (cond === null || cond instanceof Date || isDecimal(cond) || typeof cond !== 'object') return eq(value, plain(cond));
  for (const [op, raw] of Object.entries(cond)) {
    const arg = plain(raw);
    // SQL semantics: `<> x` never matches NULL.
    if (op === 'not' && !(value != null && !eq(value, arg))) return false;
    if (op === 'in' && !arg.some(a => eq(value, a))) return false;
    if (op === 'lte' && !(value != null && time(value) <= time(arg))) return false;
    if (op === 'lt' && !(value != null && time(value) < time(arg))) return false;
    if (op === 'gte' && !(value != null && time(value) >= time(arg))) return false;
    if (op === 'gt' && !(value != null && time(value) > time(arg))) return false;
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
  if (!('updated_at' in data)) row.updated_at = new Date();
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
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const DEFAULTS = {
  scheduledTopup: () => ({ status: 'active', timezone: 'Africa/Lagos', notify_before: true, pause_reason: null, reminder_cycle: null, label: null, deleted_at: null, last_run_at: null }),
  scheduledTopupRun: () => ({ status: 'running', attempts: 0, trx: null, next_retry_at: null, failure_code: null, failure_message: null, completed_at: null }),
  walletTransaction: () => ({}),
  user: () => ({}),
};

function duplicateOf(table, row) {
  if (table === 'walletTransaction') return db.walletTransaction.some(r => r.trx === row.trx);
  if (table === 'scheduledTopupRun') {
    return db.scheduledTopupRun.some(r => r.schedule_id === row.schedule_id && r.cycle_key === row.cycle_key);
  }
  return false;
}

function insert(table, data) {
  const now = new Date();
  const row = { ...DEFAULTS[table](), created_at: now, updated_at: now, ...plain(data) };
  if (duplicateOf(table, row)) throw P2002();
  if (table in ids) row.id = ++ids[table];
  db[table].push(row);
  return row;
}

function uniqueWhere(where) {
  if (where.schedule_id_cycle_key) return { ...where.schedule_id_cycle_key };
  return where;
}

function model(table) {
  return {
    async findUnique({ where, select }) {
      return project(db[table].find(r => matches(r, uniqueWhere(where))) || null, select);
    },
    async findFirst({ where, orderBy, select }) {
      return project(sortRows(db[table].filter(r => matches(r, where)), orderBy)[0] || null, select);
    },
    async findMany({ where, orderBy, take, skip = 0, distinct, select } = {}) {
      let rows = sortRows(db[table].filter(r => matches(r, where)), orderBy);
      if (distinct) {
        const seen = new Set();
        rows = rows.filter(r => {
          const key = distinct.map(k => r[k]).join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      rows = rows.slice(skip, take ? skip + take : undefined);
      return rows.map(r => project(r, select));
    },
    async create({ data }) {
      return clone(insert(table, data));
    },
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const item of data) {
        try {
          insert(table, item);
          count += 1;
        } catch (e) {
          if (!(skipDuplicates && e.code === 'P2002')) throw e;
        }
      }
      return { count };
    },
    async update({ where, data }) {
      const row = db[table].find(r => matches(r, uniqueWhere(where)));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      applyData(row, data);
      return clone(row);
    },
    async updateMany({ where, data }) {
      const rows = db[table].filter(r => matches(r, where));
      rows.forEach(r => applyData(r, data));
      return { count: rows.length };
    },
    async deleteMany({ where }) {
      const before = db[table].length;
      db[table] = db[table].filter(r => !matches(r, where));
      return { count: before - db[table].length };
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
    async aggregate({ where, _sum }) {
      const rows = db[table].filter(r => matches(r, where));
      const sum = {};
      for (const k of Object.keys(_sum || {})) sum[k] = rows.length ? rows.reduce((n, r) => n + Number(r[k] || 0), 0) : null;
      return { _sum: sum };
    },
  };
}

const fakePrisma = {
  user: model('user'),
  walletTransaction: model('walletTransaction'),
  scheduledTopup: model('scheduledTopup'),
  scheduledTopupRun: model('scheduledTopupRun'),
  // Interactive transactions roll back on a throw, exactly as Postgres would -
  // the run stamp written inside a reserve that then fails must disappear.
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

const spy = { vends: [], pushes: [], alerts: [], cleared: [] };
const pushKeys = new Set();

// What the provider answers next. An Error is thrown.
let vendAnswer = { status: 'success', reference: 'MSW-1' };
let kycAnswer = { ok: true };
const NETWORKS = ['MTN', 'AIRTEL', 'GLO', '9MOBILE'].map((name, i) => ({ name, code: String(i + 1), id: String(i + 1) }));
const plans = {
  MTN: [
    { id: '19', name: '1GB (SME)', amount: 500, validity: '30 days', duration_days: 30, plan_type: 'SME' },
    { id: '20', name: '10GB (CG)', amount: 4500, validity: '30 days', duration_days: 30, plan_type: 'CG' },
  ],
};

const upstream = {
  MIN_AMOUNTS: { airtime: 50, electricity: 500 },
  SUPPORTS_REQUEST_ID_LOOKUP: true,
  listAirtimeProvidersCached: async () => NETWORKS,
  listDataProvidersCached: async () => NETWORKS,
  listDataPlansCached: async network => clone(plans[network] || []),
  buyAirtime: async args => vend('airtime', args),
  buyData: async args => vend('data', args),
  parseVendResult: json => ({
    status: json.status,
    reference: json.reference || '',
    order_no: '',
    token: '',
    units: '',
    amount: Number(json.amount || 0),
  }),
};

function vend(service, args) {
  spy.vends.push({ service, ...args });
  if (vendAnswer instanceof Error) throw vendAnswer;
  return vendAnswer;
}

stub('../database/prisma', fakePrisma);
stub('../src/funding/billsProvider', {
  resolve: async () => ({ name: 'mysubwallet', provider: upstream }),
  getProviderName: async () => 'mysubwallet',
  adapterFor: () => upstream,
  isKnownProvider: name => name === 'mysubwallet',
  PROVIDER_LABELS: { mysubwallet: 'MySubWallet' },
  DEFAULT_PROVIDER: 'mysubwallet',
  ADAPTERS: { mysubwallet: upstream },
  SERVICES: { airtime: 'Airtime', data: 'Data bundles', tv: 'Cable TV', electricity: 'Electricity' },
});
stub('../src/helpers/balance.helper', {
  applyBalanceDelta: async (tx, wallet, ownerId, delta) => {
    const user = db.user.find(u => u.id === Number(ownerId));
    user.balance = Math.round((user.balance + Number(delta.toString())) * 100) / 100;
    return clone(user);
  },
  restampBalance: async (tx, wallet, ownerId) => clone(db.user.find(u => u.id === Number(ownerId))),
});
let pendingPayload = null;
stub('../src/services/pending.service', {
  getPending: async () => clone(pendingPayload),
  setPending: async () => true,
  clearPending: async (userId, remark) => spy.cleared.push(remark),
});
// The real encryption, so the stored number is provably not plain text; only
// the PIN check is faked - scrypt is the slow part and not what is under test.
const realPii = require('../src/helpers/pii.helper');
stub('../src/helpers/pii.helper', { ...realPii, verifySecret: async pin => ({ ok: pin === '1234', needsRehash: false }) });
stub('../src/services/alerts.service', {
  paymentFailure: p => spy.alerts.push(p),
  captureError: () => {},
  securityEvent: () => {},
});
stub('../src/services/userAudit.service', { logMoneyEvent: async () => null, logUserEvent: async () => null });
stub('../src/helpers/velocity.helper', { checkVelocity: async () => ({ ok: true }) });
stub('../src/helpers/kycGate.helper', { checkSpendKyc: async () => kycAnswer });
stub('../src/helpers/featureFlag.helper', { isFeatureEnabled: async () => true, requireFeature: () => (req, res, next) => next() });
stub('../src/helpers/billReconcile.helper', { reconcile: async () => ({ checked: false }), sweepProcessingBills: async () => ({}) });
// The real notify service writes a row with a unique client_message_id; the
// stub keeps that one property, which is what makes a push exactly-once.
stub('../src/services/notify.service', {
  notifyUser: async args => {
    const key = `${args.userId}|${args.clientMessageId}`;
    if (args.clientMessageId && pushKeys.has(key)) return false;
    pushKeys.add(key);
    spy.pushes.push(args);
    return true;
  },
});

const settlement = require('../src/helpers/billSettlement.helper');
const billsController = require('../src/controllers/bills.controller');
const worker = require('../src/services/scheduledTopup.service');
const controller = require('../src/controllers/scheduledTopup.controller');
const { nextRunAt } = require('../src/helpers/topupSchedule.helper');

/* ---------------------------------------------------------------- helpers */

function respond(handler, req) {
  return new Promise((resolve, reject) => {
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
    Promise.resolve(handler({ headers: {}, params: {}, query: {}, ...req, user: { id: USER_ID } }, res)).catch(reject);
  });
}

function reset({ balance = 10_000 } = {}) {
  resetDb({ balance });
  spy.vends = [];
  spy.pushes = [];
  spy.alerts = [];
  spy.cleared = [];
  pushKeys.clear();
  vendAnswer = { status: 'success', reference: 'MSW-1' };
  kycAnswer = { ok: true };
  plans.MTN[0].amount = 500;
}

const airtimeBody = (patch = {}) => ({
  service: 'airtime',
  provider: 'MTN',
  phone: '08031234567',
  label: 'Mom',
  amount: 2000,
  frequency: 'weekly',
  day_of_week: 1,
  run_time: '07:00',
  notify_before: true,
  pin: '1234',
  ...patch,
});

async function createSchedule(patch = {}) {
  const out = await respond(controller.create, { body: airtimeBody(patch) });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  return out.body.data.schedule;
}

// Make a schedule due at `slot`, as the worker would find it.
function dueAt(scheduleId, slot) {
  const row = db.scheduledTopup.find(s => s.id === scheduleId);
  row.next_run_at = new Date(slot);
  return row;
}

const balance = () => db.user[0].balance;
const runOf = scheduleId => db.scheduledTopupRun.filter(r => r.schedule_id === scheduleId);
const debits = () => db.walletTransaction.filter(r => r.trx_type === '-');
const refunds = () => db.walletTransaction.filter(r => r.trx_type === '+');
const pushTitles = () => spy.pushes.map(p => p.subject);
const minutes = (date, n) => new Date(new Date(date).getTime() + n * 60_000);

// Monday 12 October 2026, 07:00 Lagos.
const MONDAY = new Date('2026-10-12T06:00:00Z');
const JUST_AFTER = minutes(MONDAY, 0.5);

(async () => {
  /* ========================================================== create */

  reset();
  let out = await respond(controller.create, { body: airtimeBody({ pin: '' }) });
  assert.strictEqual(out.status, 400);
  assert.match(out.body.message[0], /PIN is required/);

  out = await respond(controller.create, { body: airtimeBody({ pin: '9999' }) });
  assert.strictEqual(out.status, 401);
  assert.strictEqual(out.body.remark, 'invalid_pin', 'the app keeps the session on this remark');
  assert.strictEqual(db.scheduledTopup.length, 0, 'a wrong PIN saves nothing');

  out = await respond(controller.create, { body: airtimeBody({ service: 'electricity' }) });
  assert.strictEqual(out.status, 400);
  assert.match(out.body.message[0], /only airtime and data/i);

  out = await respond(controller.create, { body: airtimeBody({ provider: 'SMILE' }) });
  assert.strictEqual(out.status, 400, 'a network this rail does not sell is refused once, now - not every Monday');

  const before = new Date();
  let schedule = await createSchedule();
  const saved = db.scheduledTopup[0];
  assert.strictEqual(schedule.phone, '08031234567', 'the owner reads their own recipient back');
  assert.strictEqual(schedule.phone_display, '+234 803 123 4567');
  assert.strictEqual(schedule.label, 'Mom');
  assert.ok(!saved.phone_enc.includes('8031234567'), 'the recipient number is never stored in plain text');
  assert.ok(saved.label.startsWith('enc:v1:'), 'the nickname names a person, so it is protected text');
  assert.strictEqual(schedule.cadence_label, 'Weekly • Every Monday at 07:00 AM');
  assert.strictEqual(new Date(schedule.next_run_at).getUTCDay(), 1, 'Monday...');
  assert.strictEqual(new Date(schedule.next_run_at).getUTCHours(), 6, '...07:00 Lagos is 06:00 UTC');
  assert.ok(new Date(schedule.next_run_at) > before, 'the first run is in the future');

  out = await respond(controller.create, { body: airtimeBody() });
  assert.strictEqual(out.status, 409, 'a double tap is not a second standing order');
  assert.strictEqual(db.scheduledTopup.length, 1);

  // Data: the price is the catalogue's, whatever the client sends.
  out = await respond(controller.create, {
    body: airtimeBody({ service: 'data', plan_id: '20', amount: 1, label: 'Office' }),
  });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.data.schedule.amount, '4500.00', 'a client-sent price is ignored');
  assert.strictEqual(out.body.data.schedule.plan_name, '10GB (CG)');

  out = await respond(controller.create, { body: airtimeBody({ service: 'data', plan_id: '404' }) });
  assert.strictEqual(out.status, 400);
  assert.match(out.body.message[0], /no longer available/);

  // Preview is the confirm screen: priced, dated, and nothing saved.
  const count = db.scheduledTopup.length;
  out = await respond(controller.preview, { body: airtimeBody({ phone: '08051234567', pin: undefined }) });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.data.frequency_label, 'Weekly (Every Monday)');
  assert.strictEqual(out.body.data.time_label, '07:00 AM (WAT)');
  assert.strictEqual(out.body.data.fee, '0.00');
  assert.strictEqual(out.body.data.sufficient_balance, true);
  assert.match(out.body.data.failure_rule, /Retry 3x/);
  assert.match(out.body.data.first_run_label, /^Mon, \d+ \w{3} \d{4}, 07:00 AM$/);
  assert.strictEqual(db.scheduledTopup.length, count, 'a preview saves nothing');

  /* ===================================================== a due run */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = { status: 'success', reference: 'MSW-1' };

  let summary = await worker.tick(JUST_AFTER);
  assert.strictEqual(summary.started, 1);
  assert.strictEqual(balance(), 8000, 'the wallet paid for it');
  assert.strictEqual(spy.vends.length, 1);
  assert.deepStrictEqual(
    { service: spy.vends[0].service, provider: spy.vends[0].provider, number: spy.vends[0].number, amount: spy.vends[0].amount },
    { service: 'airtime', provider: 'MTN', number: '08031234567', amount: 2000 },
  );

  let [run] = runOf(schedule.id);
  const [debit] = debits();
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.attempts, 1);
  assert.strictEqual(run.cycle_key, 'wk:2026-10-12');
  assert.strictEqual(run.trx, debit.trx, 'the run names its ledger row');
  assert.strictEqual(spy.vends[0].reference, debit.trx, 'our trx is their request-id');
  // The ledger row is an ordinary bill: the same rail, the same receipt.
  assert.strictEqual(debit.remark, 'mobile_recharge');
  assert.strictEqual(debit.meta.bill_status, 'successful');
  assert.strictEqual(debit.meta.gateway, 'mysubwallet');
  assert.strictEqual(debit.meta.source, 'scheduled_topup');
  assert.strictEqual(debit.meta.schedule_id, schedule.id);
  assert.strictEqual(debit.meta.run_id, run.id);
  assert.ok(!JSON.stringify(debit.meta).includes('8031234567'), 'no phone number in meta');
  assert.ok(debit.details.startsWith('enc:v1:'), 'the counterparty line is protected text');

  const slotRow = db.scheduledTopup.find(s => s.id === schedule.id);
  assert.strictEqual(slotRow.next_run_at.toISOString(), '2026-10-19T06:00:00.000Z', 'next Monday');

  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up successful']);
  assert.match(spy.pushes[0].message, /₦2,000\.00 MTN airtime sent to Mom/);
  assert.match(spy.pushes[0].message, /Next run: Mon, 19 Oct 2026, 07:00 AM/);
  assert.strictEqual(spy.pushes[0].type, 'scheduled_topup');
  assert.deepStrictEqual(
    Object.keys(spy.pushes[0].data).sort(),
    ['run_id', 'schedule_id', 'status', 'type'],
    'ids only in the stored payload',
  );
  // notifyUser does not copy `type` into the FCM payload, so the tap handler
  // only routes this push to the schedule if `data` carries it.
  assert.strictEqual(spy.pushes[0].data.type, 'scheduled_topup');
  assert.strictEqual(spy.pushes[0].data.schedule_id, schedule.id);

  // The same minute again buys nothing.
  await worker.tick(JUST_AFTER);
  assert.strictEqual(spy.vends.length, 1);
  assert.strictEqual(balance(), 8000);

  /* ========================================= one cycle, bought once */

  // Monday's top-up moved to Friday after Monday's ran: Friday is in the same
  // Lagos week, so the cycle is refused - and the slot still moves on.
  slotRow.day_of_week = 5;
  dueAt(schedule.id, '2026-10-16T06:00:00Z');
  await worker.tick(minutes('2026-10-16T06:00:00Z', 0.5));
  assert.strictEqual(spy.vends.length, 1, 'no second purchase in the same week');
  assert.strictEqual(balance(), 8000);
  assert.strictEqual(slotRow.next_run_at.toISOString(), '2026-10-23T06:00:00.000Z');

  // Two workers find the same due slot at the same moment. One buys it.
  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  const [a, b] = await Promise.all([worker.runDueSchedules(JUST_AFTER), worker.runDueSchedules(JUST_AFTER)]);
  assert.strictEqual(a + b, 1, 'exactly one instance claims the slot');
  assert.strictEqual(spy.vends.length, 1);
  assert.strictEqual(debits().length, 1);
  assert.strictEqual(balance(), 8000);

  /* =========================================== pause, resume, delete */

  reset();
  schedule = await createSchedule();
  out = await respond(controller.pause, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.body.data.schedule.status, 'paused');
  assert.strictEqual(out.body.data.schedule.next_run_label, '', 'a paused schedule shows no next run');
  dueAt(schedule.id, MONDAY);
  await worker.tick(JUST_AFTER);
  assert.strictEqual(spy.vends.length, 0, 'paused schedules are skipped');
  assert.strictEqual(runOf(schedule.id).length, 0);

  out = await respond(controller.resume, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.body.data.schedule.status, 'active');
  assert.ok(new Date(out.body.data.schedule.next_run_at) > new Date(), 'resume plans forward from now, never a stale slot');

  // Another customer's schedule reads exactly like no schedule at all.
  db.scheduledTopup[0].user_id = 99;
  out = await respond(controller.show, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 404);
  db.scheduledTopup[0].user_id = USER_ID;

  out = await respond(controller.remove, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(db.scheduledTopup[0].status, 'deleted');
  assert.strictEqual(db.scheduledTopup[0].phone_enc, '', 'the recipient number goes with it');
  assert.strictEqual(db.scheduledTopup[0].label, null);
  out = await respond(controller.list, {});
  assert.strictEqual(out.body.data.schedules.length, 0);
  out = await respond(controller.show, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 404);

  /* =================================== low balance: retry, then pay */

  reset({ balance: 500 });
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'retrying');
  assert.strictEqual(run.failure_code, 'insufficient_balance');
  assert.strictEqual(run.next_retry_at.toISOString(), minutes(JUST_AFTER, 60).toISOString());
  assert.strictEqual(run.trx, null, 'the trx stamp rolled back with the refused reserve');
  assert.strictEqual(db.walletTransaction.length, 0, 'nothing reserved, nothing written');
  assert.strictEqual(spy.vends.length, 0, 'the provider never heard about it');
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up delayed']);
  assert.match(spy.pushes[0].message, /Fund your wallet/);

  await worker.tick(minutes(JUST_AFTER, 30));
  assert.strictEqual(runOf(schedule.id)[0].status, 'retrying', 'not before its time');

  db.user[0].balance = 5000;
  await worker.tick(minutes(JUST_AFTER, 61));
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.attempts, 2);
  assert.strictEqual(balance(), 3000);
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up delayed', 'Scheduled top-up successful']);

  /* ======================== low balance all four times: missed, once */

  reset({ balance: 0 });
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  let clock = JUST_AFTER;
  await worker.tick(clock);
  for (const wait of [60, 180, 360]) {
    clock = minutes(clock, wait + 1);
    await worker.tick(clock);
  }
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.attempts, 4);
  assert.strictEqual(run.failure_code, 'insufficient_balance');
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up delayed', 'Scheduled top-up missed']);
  assert.match(spy.pushes[1].message, /after 4 attempts/);
  assert.match(spy.pushes[1].message, /Next run: Mon, 19 Oct 2026/);
  await worker.tick(minutes(clock, 600));
  assert.strictEqual(runOf(schedule.id)[0].attempts, 4, 'a closed cycle is not retried');

  /* ======================== refused number: refunded and paused */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = Object.assign(new Error('That phone number was not accepted for this network.'), { statusCode: 400, kind: 'input' });
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.failure_code, 'provider_rejected');
  assert.strictEqual(balance(), 10_000, 'every naira back');
  assert.strictEqual(refunds().length, 1);
  assert.strictEqual(refunds()[0].trx, `${run.trx}_r`, 'the statement shows the reversal');
  assert.strictEqual(db.scheduledTopup[0].status, 'paused');
  assert.strictEqual(db.scheduledTopup[0].pause_reason, 'provider_rejected');
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up paused']);
  out = await respond(controller.list, {});
  assert.match(out.body.data.schedules[0].pause_message, /network refused/);

  // Editing the schedule is the fix the pause asked for, so it lifts it.
  out = await respond(controller.update, {
    params: { id: String(schedule.id) },
    body: airtimeBody({ phone: '08061234567' }),
  });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.data.schedule.status, 'active');
  assert.strictEqual(out.body.data.schedule.phone, '08061234567');

  /* ========================= our outage: refunded, then retried */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = Object.assign(new Error('This service is briefly unavailable.'), { statusCode: 503, floatExhausted: true, kind: 'outage' });
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'retrying', 'an empty float is ours to fix, not a reason to skip the week');
  assert.strictEqual(balance(), 10_000);
  assert.strictEqual(spy.pushes.length, 0, 'not the customer\'s problem - nothing to tell them yet');
  const firstTrx = spy.vends[0].reference;

  vendAnswer = { status: 'success', reference: 'MSW-2' };
  await worker.tick(minutes(JUST_AFTER, 61));
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(spy.vends.length, 2);
  assert.notStrictEqual(spy.vends[1].reference, firstTrx, 'a retry is a fresh purchase on a fresh trx');
  assert.strictEqual(balance(), 8000, 'refunded once, charged once');

  /* =============== ambiguous: refunded, and never re-bought by a timer */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = Object.assign(new Error('This service is briefly unavailable.'), {
    statusCode: 504,
    kind: 'outage',
    ambiguous: true,
    cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  });
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.next_retry_at, null);
  assert.strictEqual(balance(), 10_000);
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up failed']);
  assert.match(spy.pushes[0].message, /refunded/);
  await worker.tick(minutes(JUST_AFTER, 600));
  assert.strictEqual(spy.vends.length, 1, 'an order that may have landed is never sent again');

  /* ================================= pending: settled from the ledger */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = { status: 'pending', reference: 'MSW-P' };
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'processing');
  assert.strictEqual(spy.pushes.length, 0, 'no push until the outcome is known');

  await settlement.settleSuccess({ trx: run.trx });
  await worker.tick(minutes(JUST_AFTER, 5));
  assert.strictEqual(runOf(schedule.id)[0].status, 'success');
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up successful']);

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  vendAnswer = { status: 'pending', reference: 'MSW-Q' };
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  await settlement.settleFailure({ trx: run.trx, reason: 'failed on requery' });
  await worker.tick(minutes(JUST_AFTER, 5));
  assert.strictEqual(runOf(schedule.id)[0].status, 'failed');
  assert.strictEqual(balance(), 10_000);
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up failed']);

  /* ===================================== a worker that died mid-run */

  reset();
  schedule = await createSchedule();
  const stale = minutes(JUST_AFTER, -11);
  // Died before reserving: nothing moved, so the cycle simply goes again.
  db.scheduledTopupRun.push({
    id: ++ids.scheduledTopupRun, schedule_id: schedule.id, user_id: USER_ID, cycle_key: 'wk:2026-10-12',
    scheduled_for: MONDAY, status: 'running', attempts: 1, amount: 2000, trx: null, next_retry_at: null,
    failure_code: null, failure_message: null, completed_at: null, created_at: stale, updated_at: stale,
  });
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'retrying');
  await worker.tick(minutes(JUST_AFTER, 1));
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'success', 'picked up and finished by the next tick');
  assert.strictEqual(run.attempts, 2);
  assert.strictEqual(spy.vends.length, 1);

  // Died after reserving: the ledger row is the truth, and nothing is re-bought.
  reset();
  schedule = await createSchedule();
  db.walletTransaction.push({
    user_id: USER_ID, trx: 'air_dead_1', trx_type: '-', amount: 2000, charge: 0, total_amount: 2000,
    remark: 'mobile_recharge', details: '', other_data: {}, meta: { gateway: 'mysubwallet', service: 'airtime', bill_status: 'processing' },
    created_at: stale, updated_at: stale,
  });
  db.scheduledTopupRun.push({
    id: ++ids.scheduledTopupRun, schedule_id: schedule.id, user_id: USER_ID, cycle_key: 'wk:2026-10-12',
    scheduled_for: MONDAY, status: 'running', attempts: 1, amount: 2000, trx: 'air_dead_1', next_retry_at: null,
    failure_code: null, failure_message: null, completed_at: null, created_at: stale, updated_at: stale,
  });
  await worker.tick(JUST_AFTER);
  assert.strictEqual(runOf(schedule.id)[0].status, 'processing', 'handed to the ledger sync, not retried');
  assert.strictEqual(spy.vends.length, 0);

  /* ==================================== price rose: paused, not charged */

  reset();
  out = await respond(controller.create, { body: airtimeBody({ service: 'data', plan_id: '19', label: 'Son' }) });
  schedule = out.body.data.schedule;
  assert.strictEqual(schedule.amount, '500.00');
  plans.MTN[0].amount = 600;
  dueAt(schedule.id, MONDAY);
  await worker.tick(JUST_AFTER);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.failure_code, 'price_changed');
  assert.match(run.failure_message, /₦500\.00 to ₦600\.00/);
  assert.strictEqual(db.walletTransaction.length, 0, 'never charged more than was approved');
  assert.strictEqual(db.scheduledTopup[0].status, 'paused');

  out = await respond(controller.resume, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 409, 'resuming would only fail again - edit it instead');
  assert.strictEqual(out.body.remark, 'price_changed');

  // Cheaper than approved is fine: the customer pays the live, lower price.
  plans.MTN[0].amount = 450;
  out = await respond(controller.resume, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 200);
  dueAt(schedule.id, '2026-10-19T06:00:00Z');
  await worker.tick(minutes('2026-10-19T06:00:00Z', 0.5));
  assert.strictEqual(balance(), 9550);
  assert.strictEqual(runOf(schedule.id).find(r => r.cycle_key === 'wk:2026-10-19').status, 'success');
  assert.strictEqual(spy.vends.at(-1).planId, '19');

  /* ============================================ KYC lock: paused */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  kycAnswer = { ok: false, reason: 'kyc_required', message: 'Verify your identity to keep spending.' };
  await worker.tick(JUST_AFTER);
  assert.strictEqual(spy.vends.length, 0, 'a standing order is not a way round the KYC lock');
  assert.strictEqual(db.walletTransaction.length, 0);
  assert.strictEqual(db.scheduledTopup[0].pause_reason, 'kyc_required');
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up paused']);

  /* ========================================= missed during an outage */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  const thursday = new Date('2026-10-15T10:00:00Z');
  await worker.tick(thursday);
  [run] = runOf(schedule.id);
  assert.strictEqual(run.status, 'skipped', 'a Monday top-up is not bought on Thursday');
  assert.strictEqual(run.failure_code, 'missed');
  assert.strictEqual(spy.vends.length, 0);
  assert.strictEqual(
    db.scheduledTopup[0].next_run_at.toISOString(),
    nextRunAt(db.scheduledTopup[0], thursday).toISOString(),
    'one catch-up decision, not one purchase per missed week',
  );
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up missed']);

  /* ================================================== the reminder */

  reset({ balance: 1500 });
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  await worker.tick(minutes(MONDAY, -30));
  assert.deepStrictEqual(pushTitles(), ['Scheduled top-up at 07:00 AM']);
  assert.match(spy.pushes[0].message, /Your balance is ₦1,500\.00 - fund your wallet/);
  await worker.tick(minutes(MONDAY, -20));
  assert.strictEqual(spy.pushes.length, 1, 'one reminder per cycle');
  assert.strictEqual(spy.vends.length, 0, 'a reminder buys nothing');

  db.scheduledTopup[0].notify_before = false;
  db.scheduledTopup[0].reminder_cycle = null;
  await worker.tick(minutes(MONDAY, -10));
  assert.strictEqual(spy.pushes.length, 1, 'switched off means off');

  /* ================================================ details + stats */

  reset();
  schedule = await createSchedule();
  dueAt(schedule.id, MONDAY);
  await worker.tick(JUST_AFTER);
  dueAt(schedule.id, '2026-10-19T06:00:00Z');
  await worker.tick(minutes('2026-10-19T06:00:00Z', 0.5));
  out = await respond(controller.show, { params: { id: String(schedule.id) } });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.data.stats, {
    successful_runs: 2,
    failed_runs: 0,
    total_runs: 2,
    success_rate: 100,
    total_disbursed: '4000.00',
  });
  assert.strictEqual(out.body.data.recent_runs.length, 2);
  assert.strictEqual(out.body.data.recent_runs[0].cycle_key, 'wk:2026-10-19', 'newest first');
  assert.strictEqual(out.body.data.schedule.reference, `STU-${String(schedule.id).padStart(6, '0')}`);

  out = await respond(controller.runs, { params: { id: String(schedule.id) }, query: { page: '1' } });
  assert.strictEqual(out.body.data.runs.length, 2);
  assert.strictEqual(out.body.data.has_more, false);

  out = await respond(controller.list, {});
  assert.strictEqual(out.body.data.summary.active, 1);
  assert.strictEqual(out.body.data.schedules[0].last_run.status, 'success');

  /* ============================== the pay button, unchanged by sharing */

  reset();
  pendingPayload = {
    gateway: 'mysubwallet', service: 'airtime', provider: 'MTN', phone_local: '08031234567',
    phone_msisdn: '2348031234567', amount: 1000, item_name: 'Airtime', charge: 0, total: 1000,
  };
  const confirm = () => respond(billsController.confirm, { params: { service: 'airtime' }, body: { pin: '1234', service: 'airtime' } });

  vendAnswer = { status: 'success', reference: 'MSW-C' };
  out = await confirm();
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.remark, 'airtime_success');
  assert.strictEqual(out.body.data.status, 'successful');
  assert.strictEqual(out.body.data.post_balance, '9000.00');
  assert.strictEqual(balance(), 9000);
  assert.strictEqual(debits()[0].meta.source, undefined, 'a tap is not stamped as scheduled');
  assert.deepStrictEqual(spy.cleared, ['air_time']);

  reset({ balance: 100 });
  out = await confirm();
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.remark, 'insufficient_balance');
  assert.strictEqual(db.walletTransaction.length, 0);
  assert.strictEqual(spy.vends.length, 0);
  assert.deepStrictEqual(spy.cleared, [], 'the quote survives a top-up and retry');

  reset();
  vendAnswer = Object.assign(new Error('That phone number was not accepted for this network.'), { statusCode: 400, kind: 'input' });
  out = await confirm();
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.remark, 'provider_error');
  assert.strictEqual(balance(), 10_000, 'refunded');
  assert.strictEqual(refunds().length, 1);
  assert.deepStrictEqual(spy.cleared, ['air_time']);

  console.log('✅ scheduled top-up flow tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
