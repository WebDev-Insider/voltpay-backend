/**
 * node test/airtimeCash.test.js
 *
 * Airtime to Cash end to end - convert, admin unlock, withdraw - against a fake
 * database and stubbed providers. No network, no Redis, no Postgres.
 *
 *   1. Prices are the spec's: MTN 75% less ₦100, Airtel 70%; the default
 *      network PINs are refused before anything is sent.
 *   2. The OTP: a one-minute window, resend only once it has expired, capped
 *      per draft and per line across every account, wrong codes counted.
 *   3. Step 3 moves airtime once: a race sends one request, a retry replays
 *      the answer, a refusal keeps the line verified under a FRESH request-id,
 *      and an unreadable answer is kept as unconfirmed - never dropped.
 *   4. Nothing unlocks itself: only an admin moves processing -> available,
 *      and an unconfirmed conversion needs an explicit vouch with a note.
 *   5. Withdraw: PIN, KYC and an account in the customer's own name; one
 *      transfer per claim; success, failure, reversal, a lost answer and a
 *      transfer Paystack never saw all end with the money owed somewhere.
 *   6. The sweep finishes everything nobody else did, and pages ops once.
 *   7. Nothing private leaks: the Share & Sell PIN is never stored, the line
 *      and the token are ciphertext, the app never sees our margin.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYSTACK_SECRET_KEY = 'sk_test_airtime_cash';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
for (const key of Object.keys(process.env)) if (key.startsWith('A2C_')) delete process.env[key];
process.env.NODE_ENV = 'test';
// The in-request retries of a conversion's record, without the wait.
process.env.A2C_RECORD_RETRY_MS = '0';

const { Prisma } = require('@prisma/client');

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
const OTHER_USER = 8;
let db;
const ids = { airtimeCashConversion: 0, airtimeCashEvent: 0, airtimeCashWithdrawal: 0 };

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
    // SQL semantics: `<> x` never matches NULL.
    if (op === 'not' && !(value != null && !eq(value, arg))) return false;
    if (op === 'in' && !arg.some(a => eq(value, a))) return false;
    if (op === 'lte' && !(value != null && time(value) <= time(arg))) return false;
    if (op === 'lt' && !(value != null && time(value) < time(arg))) return false;
    if (op === 'gte' && !(value != null && time(value) >= time(arg))) return false;
    if (op === 'gt' && !(value != null && time(value) > time(arg))) return false;
    if (op === 'startsWith' && !(typeof value === 'string' && value.startsWith(arg))) return false;
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
      row[key] = Number(row[key] || 0) + delta;
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
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const DEFAULTS = {
  airtimeCashConversion: () => ({
    status: 'awaiting_otp', phone_format: null, amount: null, payout_rate_bps: null, fee: null, payout: null,
    provider_rate_bps: null, provider_credit: null, margin: null, provider_status: null, provider_request_id: null,
    provider_message: null, provider_token_enc: null, otp_sends: 0, otp_attempts: 0, convert_attempts: 0,
    otp_sent_at: null, otp_expires_at: null, otp_verified_at: null, submitted_at: null, converted_at: null,
    provider_checked_at: null, available_at: null, settled_by: null, withdrawal_id: null, withdrawn_at: null,
    failed_at: null, failure_reason: null, unconfirmed_alerted_at: null, settlement_alerted_at: null,
  }),
  airtimeCashEvent: () => ({ actor: 'system', note: null, meta: null, from_status: null, to_status: null }),
  airtimeCashWithdrawal: () => ({
    fee: 0, provider_fee: 0, conversion_count: 0, bank_name: null, account_last4: null, account_name_enc: null,
    account_source: null, save_account: false, recipient_code: null, transfer_code: null, status: 'pending',
    failure_reason: null, provider_message: null, submitted_at: null, completed_at: null,
  }),
  user: () => ({}),
  kycVerification: () => ({}),
};

const UNIQUE = {
  airtimeCashConversion: ['reference', 'provider_request_id'],
  airtimeCashWithdrawal: ['reference'],
};

function insert(table, data) {
  const now = new Date();
  const row = { ...DEFAULTS[table](), created_at: now, updated_at: now, ...plain(data) };
  for (const col of UNIQUE[table] || []) {
    if (row[col] != null && db[table].some(r => r[col] === row[col])) throw P2002();
  }
  if (table in ids) row.id = ++ids[table];
  db[table].push(row);
  return row;
}

function model(table) {
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
      return clone(insert(table, data));
    },
    async createMany({ data }) {
      for (const item of data) insert(table, item);
      return { count: data.length };
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
    async aggregate({ where, _sum }) {
      const rows = db[table].filter(r => matches(r, where));
      const sum = {};
      for (const k of Object.keys(_sum || {})) sum[k] = rows.length ? rows.reduce((n, r) => n + Number(r[k] || 0), 0) : null;
      return { _sum: sum };
    },
    async groupBy({ by, where, _sum }) {
      const groups = new Map();
      for (const r of db[table].filter(x => matches(x, where))) {
        const key = by.map(k => r[k]).join('|');
        const g = groups.get(key) || {
          ...Object.fromEntries(by.map(k => [k, r[k]])),
          _count: { _all: 0 },
          _sum: Object.fromEntries(Object.keys(_sum || {}).map(k => [k, 0])),
        };
        g._count._all += 1;
        for (const k of Object.keys(_sum || {})) g._sum[k] += Number(r[k] || 0);
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  };
}

const fakePrisma = {
  user: model('user'),
  kycVerification: model('kycVerification'),
  airtimeCashConversion: model('airtimeCashConversion'),
  airtimeCashEvent: model('airtimeCashEvent'),
  airtimeCashWithdrawal: model('airtimeCashWithdrawal'),
  // Rolls back on a throw, exactly as Postgres would.
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

const spy = { msw: [], requery: [], resolve: [], recipients: [], transfers: [], verify: [], pushes: [], alerts: [], security: [] };
const pushKeys = new Set();
let answers = {};
let kycVerified = true;

stub('../database/prisma', fakePrisma);
// The real wording rules - pure functions, and the subject of the 2026-10-12
// fix - so these tests check what production reads, not a copy of it.
const realMsw = require('../src/funding/mysubwallet.service');
stub('../src/funding/mysubwallet.service', {
  isCashPendingWording: realMsw.isCashPendingWording,
  isClearCashDecline: realMsw.isClearCashDecline,
  startAirtimeCash: async args => {
    spy.msw.push({ step: 1, ...args });
    if (answers.start instanceof Error) throw answers.start;
    return answers.start || { token: 'tok-step1', phoneFormat: 'local' };
  },
  verifyAirtimeCashOtp: async args => {
    spy.msw.push({ step: 2, ...args });
    if (answers.verify instanceof Error) throw answers.verify;
    return answers.verify || { token: 'tok-step2' };
  },
  completeAirtimeCash: async args => {
    spy.msw.push({ step: 3, ...args });
    if (answers.completeGate) await answers.completeGate;
    const a = answers.complete;
    if (a instanceof Error) throw a;
    return a || { status: 'successful', credited: null };
  },
  getTransactionStatus: async ref => {
    spy.requery.push(ref);
    return answers.requery || { status: 'not_found' };
  },
  // GET /api/balance as the adapter hands it back; `answers.balance` overrides.
  getWalletBalance: async () =>
    answers.balance || { balance: 80_000, airtime_to_cash_balance: 1_400, retrieved_at: '2026-10-12T15:00:00.000Z' },
  isConfigured: () => true,
  floatVerdict: () => 'healthy',
});
stub('../src/funding/paystack.service', {
  resolveAccount: async args => {
    spy.resolve.push(args);
    if (answers.resolve instanceof Error) throw answers.resolve;
    return { data: { account_name: answers.resolveName || 'ADA OBI NWOSU' } };
  },
  listBanks: async () => [
    { code: '058', name: 'GTBank' },
    { code: '50211', name: 'Kuda Bank' },
  ],
  createTransferRecipient: async args => {
    spy.recipients.push(args);
    return { recipient_code: `RCP_${spy.recipients.length}` };
  },
  initiateTransfer: async args => {
    spy.transfers.push(args);
    if (answers.transferGate) await answers.transferGate;
    const a = answers.transfer;
    if (a instanceof Error) throw a;
    return { data: a || { status: 'pending', transfer_code: `TRF_${spy.transfers.length}` } };
  },
  verifyTransfer: async ref => {
    spy.verify.push(ref);
    const a = answers.verifyTransfer;
    if (a instanceof Error) throw a;
    return { data: a || { status: 'pending' } };
  },
  transferFeeNaira: amount => (amount <= 5_000 ? 10 : amount <= 50_000 ? 25 : 50),
  getBalance: async () => ({ balance_kobo: 2_000_000 }),
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
  paymentFailure: p => spy.alerts.push(p),
  captureError: () => {},
  securityEvent: (scope, message, ctx) => spy.security.push({ scope, ctx }),
});
stub('../src/services/userAudit.service', { logUserEvent: async () => null, logMoneyEvent: async () => null });
stub('../src/helpers/kycGate.helper', { isKycVerified: async () => kycVerified, checkSpendKyc: async () => ({ ok: true }) });
stub('../src/helpers/featureFlag.helper', { isFeatureEnabled: async () => true, requireFeature: () => (req, res, next) => next() });
// The real encryption, so stored values are provably not plain text; only the
// PIN check is faked - scrypt is slow and not what is under test.
const realPii = require('../src/helpers/pii.helper');
stub('../src/helpers/pii.helper', { ...realPii, verifySecret: async pin => ({ ok: pin === '1234', needsRehash: false }) });

const A2C = require('../src/helpers/airtimeCash.helper');
const service = require('../src/services/airtimeCash.service');
const controller = require('../src/controllers/airtimeCash.controller');
const adminController = require('../src/controllers/adminAirtimeCash.controller');

/* ---------------------------------------------------------------- helpers */

const KYC_ACCOUNT = '0123456789';

function reset() {
  db = {
    user: [
      { id: USER_ID, pin: 'hashed', firstname_enc: realPii.encryptValue('Ada'), lastname_enc: realPii.encryptValue('Nwosu') },
      { id: OTHER_USER, pin: 'hashed', firstname_enc: realPii.encryptValue('Bayo'), lastname_enc: realPii.encryptValue('Ade') },
    ],
    kycVerification: [
      {
        user_id: USER_ID,
        account_status: 'verified',
        account_number_enc: realPii.encryptValue(KYC_ACCOUNT),
        account_number_idx: realPii.blindIndex(KYC_ACCOUNT, 'account_number'),
        account_name_enc: realPii.encryptValue('ADA OBI NWOSU'),
        bank_code: '058',
        bank_name: 'GTBank',
      },
    ],
    airtimeCashConversion: [],
    airtimeCashEvent: [],
    airtimeCashWithdrawal: [],
  };
  for (const k of Object.keys(spy)) spy[k] = [];
  pushKeys.clear();
  answers = {};
  kycVerified = true;
}

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

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
    Promise.resolve(
      handler({ headers: {}, params: {}, query: {}, body: {}, admin: { name: 'finance-ada', role: 'finance' }, ...req, user: { id: req?.userId || USER_ID } }, res),
    ).catch(reject);
  });
}

const conv = id => db.airtimeCashConversion.find(r => r.id === id);
const wd = id => db.airtimeCashWithdrawal.find(r => r.id === id);
const pushSubjects = () => spy.pushes.map(p => p.subject);
const eventsOf = id => db.airtimeCashEvent.filter(e => e.conversion_id === id);
const step3 = () => spy.msw.filter(c => c.step === 3);
const ago = ms => new Date(Date.now() - ms);

/** Through the three steps to `processing`, confirmed. */
async function converted({ network = 'MTN', phone = '08031234567', amount = 5000, userId = USER_ID } = {}) {
  const draft = await service.startConversion({ userId, network, phone });
  await service.verifyOtp({ userId, id: draft.id, otp: '4821' });
  const { row } = await service.convert({ userId, id: draft.id, amount, sharePin: '7391' });
  return row;
}

async function available(opts) {
  const row = await converted(opts);
  await service.markAvailable({ ids: [row.id], actor: 'finance-ada' });
  return conv(row.id);
}

/* ------------------------------------------------------------------ tests */

(async () => {
  /* ------------------------------------------------- 1. the prices */

  const price = (n, a) => A2C.moneyStr(A2C.quote(n, a).payoutKobo);
  assert.strictEqual(price('MTN', 1000), '650.00', 'MTN: 1000 x 75% - 100');
  assert.strictEqual(price('MTN', 5000), '3650.00', 'the design screen: 5000 -> 3,650');
  assert.strictEqual(price('AIRTEL', 1000), '700.00', 'Airtel: 1000 x 70%');
  assert.strictEqual(A2C.moneyStr(A2C.quote('MTN', 1000).marginKobo), '100.00', 'the flat fee is the MTN margin');
  assert.strictEqual(A2C.moneyStr(A2C.quote('MTN', 1001).payoutKobo), '650.75', 'kobo-exact, never a float');

  assert.strictEqual(A2C.validateAmount('MTN', 999).ok, false, 'below the minimum');
  assert.strictEqual(A2C.validateAmount('MTN', 50_001).ok, false, 'above the maximum');
  assert.strictEqual(A2C.validateAmount('MTN', 1500.5).ok, false, 'whole naira only');
  assert.strictEqual(A2C.validateAmount('MTN', '5,000').ok, true);

  assert.strictEqual(A2C.validateSharePin('MTN', '0000').remark, 'default_share_pin', "MTN's default PIN cannot transfer");
  assert.strictEqual(A2C.validateSharePin('AIRTEL', '1234').remark, 'default_share_pin', "Airtel's default PIN cannot transfer");
  assert.strictEqual(A2C.validateSharePin('MTN', '1234').ok, true, "Airtel's default is a fine MTN PIN");
  assert.strictEqual(A2C.validateSharePin('MTN', '12a4').ok, false);
  // Exactly four digits - the length both networks and MySubWallet's docs use.
  for (const wrong of ['739', '73912', '739124']) {
    assert.strictEqual(A2C.validateSharePin('MTN', wrong).remark, 'invalid_share_pin', `${wrong.length} digits is not a Share & Sell PIN`);
  }
  assert.strictEqual(A2C.validateSharePin('AIRTEL', '7391').ok, true);

  process.env.A2C_MTN_FEE = '50';
  process.env.A2C_AIRTEL_PAYOUT_RATE = '72';
  assert.strictEqual(price('MTN', 1000), '700.00', 'the fee is configuration');
  assert.strictEqual(price('AIRTEL', 1000), '720.00', 'a rate can be given as a percentage');
  process.env.A2C_AIRTEL_PAYOUT_RATE = '150';
  assert.strictEqual(price('AIRTEL', 1000), '700.00', 'a rate above 100% falls back - never pay out more than was sent');
  delete process.env.A2C_MTN_FEE;
  delete process.env.A2C_AIRTEL_PAYOUT_RATE;

  /* ---------------------------------- 2. convert: the happy path */

  reset();
  const draft = await service.startConversion({ userId: USER_ID, network: 'mtn', phone: '+234 803 123 4567' });
  assert.strictEqual(draft.status, 'awaiting_otp');
  assert.strictEqual(draft.otp_sends, 1);
  assert.ok(!String(draft.phone_enc).includes('803'), 'the line is ciphertext');
  assert.ok(!String(draft.provider_token_enc).includes('tok-step1'), 'the token is ciphertext');
  assert.deepStrictEqual(spy.msw[0], { step: 1, network: 'MTN', phone: '08031234567', format: undefined });

  const state = service.otpState(draft);
  assert.ok(state.expires_in > 55 && state.expires_in <= 60, 'a one-minute code');
  assert.strictEqual(state.can_resend, false, 'resend waits for the code to expire');
  assert.strictEqual(state.length, 4, 'the app draws four boxes - the network sends a 4-digit code');

  // A code of the wrong length never reaches step 2, and costs no attempt.
  for (const wrong of ['482', '482109']) {
    assert.strictEqual((await rejects(service.verifyOtp({ userId: USER_ID, id: draft.id, otp: wrong }))).remark, 'validation_error');
  }
  assert.strictEqual(spy.msw.filter(c => c.step === 2).length, 0);
  assert.strictEqual(db.airtimeCashConversion.find(r => r.id === draft.id).otp_attempts, 0);

  const verified = await service.verifyOtp({ userId: USER_ID, id: draft.id, otp: '48 21' });
  assert.strictEqual(verified.status, 'otp_verified');
  assert.deepStrictEqual(
    { step: spy.msw[1].step, otp: spy.msw[1].otp, token: spy.msw[1].token },
    { step: 2, otp: '4821', token: 'tok-step1' },
    'step 2 carries the step-1 token',
  );

  const out = await respond(controller.convert, { params: { id: draft.id }, body: { amount: 5000, share_pin: '7391' } });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  const c1 = conv(draft.id);
  assert.strictEqual(c1.status, 'processing');
  assert.strictEqual(c1.provider_status, 'confirmed');
  assert.deepStrictEqual([c1.amount, c1.fee, c1.payout, c1.margin], [5000, 100, 3650, 100]);
  assert.strictEqual(c1.provider_token_enc, null, 'the token is dropped once spent');
  assert.strictEqual(step3()[0].token, 'tok-step2', 'step 3 carries the step-2 token');
  assert.strictEqual(step3()[0].reference, c1.reference, 'attempt one is sent under the reference itself');
  assert.strictEqual(step3()[0].sharePin, '7391');
  assert.deepStrictEqual(pushSubjects(), ['Airtime converted']);
  assert.deepStrictEqual(eventsOf(c1.id).map(e => e.event), ['otp_sent', 'otp_verified', 'status', 'status']);

  // What the app gets: the customer's numbers and the timeline, never ours.
  const shown = out.body.data.conversion;
  assert.deepStrictEqual([shown.amount, shown.fee, shown.payout, shown.rate_label], ['5000.00', '100.00', '3650.00', '75%']);
  assert.strictEqual(shown.status_label, 'Processing settlement');
  assert.strictEqual(shown.withdrawable, false);
  assert.deepStrictEqual(shown.timeline.map(s => s.state), ['done', 'current', 'pending', 'pending']);
  assert.ok(!/margin|provider_rate|provider_credit|token/.test(JSON.stringify(out.body)), 'our side of the deal stays on the server');

  // The Share & Sell PIN went to the provider and nowhere else.
  for (const row of db.airtimeCashConversion) assert.ok(!Object.values(row).includes('7391'), 'never a column');
  assert.ok(!JSON.stringify(db.airtimeCashEvent).includes('share_pin'), 'never in the trail');

  // A retried convert after a lost answer replays - no second transfer.
  const replay = await service.convert({ userId: USER_ID, id: draft.id, amount: 5000, sharePin: '7391' });
  assert.strictEqual(replay.replay, true);
  assert.strictEqual(step3().length, 1);

  // Somebody else's conversion is not found.
  await assert.rejects(service.conversionDetails({ userId: OTHER_USER, id: draft.id }), e => e.remark === 'not_found');

  /* -------------------------------------------------- 3. the OTP */

  reset();
  const d2 = await service.startConversion({ userId: USER_ID, network: 'AIRTEL', phone: '08021234567' });
  assert.strictEqual((await rejects(service.resendOtp({ userId: USER_ID, id: d2.id }))).remark, 'otp_not_expired');

  conv(d2.id).otp_expires_at = ago(1_000);
  assert.strictEqual((await rejects(service.verifyOtp({ userId: USER_ID, id: d2.id, otp: '4821' }))).remark, 'otp_expired');
  assert.strictEqual(spy.msw.filter(c => c.step === 2).length, 0, 'an expired code is refused before the provider is asked');

  const resent = await service.resendOtp({ userId: USER_ID, id: d2.id });
  assert.strictEqual(resent.otp_sends, 2);
  assert.ok(service.otpState(resent).expires_in > 55, 'a fresh minute');

  // Two resends at once text one code.
  conv(d2.id).otp_expires_at = ago(1_000);
  const racing = await Promise.allSettled([
    service.resendOtp({ userId: USER_ID, id: d2.id }),
    service.resendOtp({ userId: USER_ID, id: d2.id }),
  ]);
  assert.strictEqual(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.strictEqual(conv(d2.id).otp_sends, 3);

  // The per-draft ceiling closes the draft.
  conv(d2.id).otp_sends = A2C.otpMaxSends();
  conv(d2.id).otp_expires_at = ago(1_000);
  assert.strictEqual((await rejects(service.resendOtp({ userId: USER_ID, id: d2.id }))).remark, 'otp_limit');
  assert.strictEqual(conv(d2.id).status, 'abandoned');

  // Wrong codes are counted, and run out.
  reset();
  const d3 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  answers.verify = Object.assign(new Error('That code was not accepted. Check it and try again, or request a new one.'), { statusCode: 400, kind: 'input' });
  const wrong = await rejects(service.verifyOtp({ userId: USER_ID, id: d3.id, otp: '0000' }));
  assert.strictEqual(wrong.remark, 'otp_invalid');
  assert.strictEqual(wrong.data.otp.attempts_left, A2C.MAX_OTP_ATTEMPTS - 1);
  assert.strictEqual(conv(d3.id).status, 'awaiting_otp', 'a typo keeps the draft open');
  conv(d3.id).otp_attempts = A2C.MAX_OTP_ATTEMPTS;
  assert.strictEqual((await rejects(service.verifyOtp({ userId: USER_ID, id: d3.id, otp: '0000' }))).remark, 'otp_attempts');
  assert.strictEqual(conv(d3.id).status, 'abandoned');

  // One live draft per person: starting again closes the last one.
  reset();
  const first = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  assert.strictEqual(conv(first.id).status, 'abandoned');
  assert.strictEqual(conv(first.id).provider_token_enc, null);

  // A provider refusal on the first send leaves nothing to resend to.
  reset();
  answers.start = Object.assign(new Error('That phone number was not accepted for this network.'), { statusCode: 400, kind: 'input' });
  const notSent = await rejects(service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' }));
  assert.strictEqual(notSent.statusCode, 400);
  assert.strictEqual(db.airtimeCashConversion[0].status, 'abandoned');

  // The per-line ceiling counts every account, so nobody can use us to flood a phone.
  reset();
  const lineIdx = realPii.blindIndex('08031234567', 'mobile');
  db.airtimeCashConversion.push({ ...DEFAULTS.airtimeCashConversion(), id: 900, user_id: OTHER_USER, reference: 'A2C-OLD', network: 'MTN', phone_enc: 'x', phone_idx: lineIdx, status: 'abandoned', otp_sends: A2C.LINE_SENDS_PER_HOUR, created_at: new Date(), updated_at: new Date() });
  assert.strictEqual((await rejects(service.startConversion({ userId: USER_ID, network: 'MTN', phone: '0803 123 4567' }))).remark, 'otp_limit');
  assert.strictEqual(spy.msw.length, 0, 'refused before any text is sent');

  // A line converting for a second account is flagged, not blocked.
  reset();
  db.airtimeCashConversion.push({ ...DEFAULTS.airtimeCashConversion(), id: 901, user_id: OTHER_USER, reference: 'A2C-OTHER', network: 'MTN', phone_enc: 'x', phone_idx: lineIdx, status: 'withdrawn', created_at: ago(5 * 60 * 60_000), updated_at: new Date() });
  await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  assert.deepStrictEqual(spy.security.map(s => s.scope), ['airtime_cash.shared_line']);

  // KYC first, at both ends.
  reset();
  kycVerified = false;
  const kyc = await respond(controller.start, { body: { network: 'MTN', phone: '08031234567' } });
  assert.strictEqual(kyc.status, 403);
  assert.strictEqual(kyc.body.remark, 'kyc_required', 'the remark the app turns into the verification prompt');
  assert.strictEqual(spy.msw.length, 0);

  assert.strictEqual((await rejects(service.startConversion({ userId: USER_ID, network: 'GLO', phone: '08051234567' }))).statusCode, 400);

  /* ------------------------------------- 4. step 3 under pressure */

  // A race sends one request.
  reset();
  const d4 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d4.id, otp: '4821' });
  let release;
  answers.completeGate = new Promise(r => (release = r));
  const both = Promise.allSettled([
    service.convert({ userId: USER_ID, id: d4.id, amount: 2000, sharePin: '7391' }),
    service.convert({ userId: USER_ID, id: d4.id, amount: 2000, sharePin: '7391' }),
  ]);
  await new Promise(r => setTimeout(r, 20));
  release();
  const settled = await both;
  assert.strictEqual(step3().length, 1, 'one transfer of airtime, however many taps');
  assert.strictEqual(settled.filter(r => r.status === 'fulfilled').length, 1);
  assert.strictEqual(settled.find(r => r.status === 'rejected').reason.remark, 'in_progress');

  // A wrong PIN keeps the line verified, and the retry goes out under a NEW request-id.
  reset();
  const d5 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d5.id, otp: '4821' });
  answers.complete = Object.assign(new Error('The network did not accept that Share & Sell PIN. Check it and try again.'), { statusCode: 400, kind: 'input', wrongPin: true, providerMessage: 'Incorrect transfer PIN' });
  const pinErr = await rejects(service.convert({ userId: USER_ID, id: d5.id, amount: 1000, sharePin: '7391' }));
  assert.strictEqual(pinErr.remark, 'wrong_share_pin');
  assert.strictEqual(pinErr.data.attempts_left, A2C.MAX_CONVERT_ATTEMPTS - 1);
  assert.strictEqual(conv(d5.id).status, 'otp_verified');
  assert.strictEqual(conv(d5.id).provider_message, 'Incorrect transfer PIN', 'their words, kept for operators');
  answers.complete = undefined;
  await service.convert({ userId: USER_ID, id: d5.id, amount: 1000, sharePin: '7392' });
  assert.deepStrictEqual(step3().map(c => c.reference), [conv(d5.id).reference, `${conv(d5.id).reference}-2`], 'a reused request-id would replay the refusal');
  assert.strictEqual(conv(d5.id).status, 'processing');

  // Refusals run out, and close the draft.
  reset();
  const d6 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d6.id, otp: '4821' });
  answers.complete = Object.assign(new Error('This line does not have enough airtime for that amount.'), { statusCode: 400, kind: 'input', lineBalance: true });
  for (let i = 1; i < A2C.MAX_CONVERT_ATTEMPTS; i += 1) {
    assert.strictEqual((await rejects(service.convert({ userId: USER_ID, id: d6.id, amount: 1000, sharePin: '7391' }))).remark, 'insufficient_airtime');
  }
  const last = await rejects(service.convert({ userId: USER_ID, id: d6.id, amount: 1000, sharePin: '7391' }));
  assert.strictEqual(last.data.closed, true);
  assert.strictEqual(conv(d6.id).status, 'abandoned');
  assert.ok(spy.alerts.length === 0, "the line's airtime is never our incident");

  // A lapsed verification closes at once.
  reset();
  const d7 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d7.id, otp: '4821' });
  answers.complete = Object.assign(new Error('Your verification has expired. Request a new code to continue.'), { statusCode: 400, kind: 'input', sessionExpired: true });
  assert.strictEqual((await rejects(service.convert({ userId: USER_ID, id: d7.id, amount: 1000, sharePin: '7391' }))).remark, 'session_expired');
  assert.strictEqual(conv(d7.id).status, 'abandoned');

  // The default network PIN never reaches the provider.
  reset();
  const d8 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d8.id, otp: '4821' });
  assert.strictEqual((await rejects(service.convert({ userId: USER_ID, id: d8.id, amount: 1000, sharePin: '0000' }))).remark, 'default_share_pin');
  // A 6-digit PIN is refused the same way: before step 3, not by the network.
  assert.strictEqual((await rejects(service.convert({ userId: USER_ID, id: d8.id, amount: 1000, sharePin: '739124' }))).remark, 'invalid_share_pin');
  assert.strictEqual(step3().length, 0);
  assert.strictEqual(conv(d8.id).status, 'otp_verified', 'nothing spent, nothing counted');
  assert.strictEqual(conv(d8.id).convert_attempts, 0, 'a refused PIN costs no attempt');

  // The daily limit counts what already moved.
  process.env.A2C_DAILY_LIMIT = '6000';
  reset();
  await converted({ amount: 5000 });
  const d9 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d9.id, otp: '4821' });
  const daily = await rejects(service.convert({ userId: USER_ID, id: d9.id, amount: 2000, sharePin: '7391' }));
  assert.strictEqual(daily.remark, 'daily_limit');
  assert.match(daily.message, /1,000 more today/);
  delete process.env.A2C_DAILY_LIMIT;

  // An unreadable answer is KEPT - unconfirmed, visible, and asked about again.
  reset();
  const d10 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d10.id, otp: '4821' });
  answers.complete = Object.assign(new Error('This service is briefly unavailable.'), { statusCode: 504, ambiguous: true, kind: 'outage' });
  const lost = await respond(controller.convert, { params: { id: d10.id }, body: { amount: 2000, share_pin: '7391' } });
  assert.strictEqual(lost.status, 200, 'not an error - the airtime may be gone');
  assert.strictEqual(lost.body.data.conversion.status_label, 'Confirming with network');
  assert.strictEqual(conv(d10.id).status, 'processing');
  assert.strictEqual(conv(d10.id).provider_status, 'unknown');
  assert.deepStrictEqual(pushSubjects(), ['Confirming your conversion']);

  // Unconfirmed cannot be unlocked without somebody vouching for it.
  const blind = await service.markAvailable({ ids: [d10.id], actor: 'finance-ada' });
  assert.deepStrictEqual(blind.skipped, [{ id: d10.id, reason: 'unconfirmed' }]);
  assert.strictEqual((await rejects(service.markAvailable({ ids: [d10.id], actor: 'finance-ada', confirmUnconfirmed: true, note: 'ok' }))).remark, 'note_required');

  // The sweep asks again - once the requery vend() already made inline is five
  // minutes old - and the answer settles it.
  answers.requery = { status: 'successful' };
  assert.strictEqual((await service.sweep()).confirmed, 0, 'not hammered straight after the inline requery');
  conv(d10.id).provider_checked_at = ago(6 * 60_000);
  const swept = await service.sweep();
  assert.strictEqual(swept.confirmed, 1);
  assert.strictEqual(conv(d10.id).provider_status, 'confirmed');
  assert.deepStrictEqual(spy.requery, [conv(d10.id).provider_request_id], 'asked about by the request-id actually sent');
  assert.deepStrictEqual(pushSubjects(), ['Confirming your conversion', 'Airtime converted']);

  // Failed on requery: failed, and the customer is told.
  reset();
  const d11 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d11.id, otp: '4821' });
  answers.complete = Object.assign(new Error('x'), { statusCode: 504, ambiguous: true });
  await service.convert({ userId: USER_ID, id: d11.id, amount: 2000, sharePin: '7391' });
  answers.requery = { status: 'failed' };
  conv(d11.id).provider_checked_at = ago(6 * 60_000);
  await service.sweep();
  assert.strictEqual(conv(d11.id).status, 'failed');
  assert.ok(pushSubjects().includes('Conversion not completed'));

  // Never answered: ops are paged once it has waited, and only once.
  reset();
  const d12 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: d12.id, otp: '4821' });
  answers.complete = Object.assign(new Error('x'), { statusCode: 504, ambiguous: true });
  await service.convert({ userId: USER_ID, id: d12.id, amount: 2000, sharePin: '7391' });
  conv(d12.id).converted_at = ago(A2C.UNCONFIRMED_ALERT_MS + 60_000);
  conv(d12.id).provider_checked_at = ago(10 * 60_000);
  await service.sweep();
  conv(d12.id).provider_checked_at = ago(10 * 60_000);
  await service.sweep();
  assert.strictEqual(spy.alerts.filter(a => a.action === 'airtime_cash_unconfirmed').length, 1);
  assert.strictEqual(conv(d12.id).status, 'processing', 'still owed, still visible - never silently dropped');

  // Vouched for, with a note: unlocked, and the note is in the trail.
  const vouched = await service.markAvailable({ ids: [d12.id], actor: 'finance-ada', confirmUnconfirmed: true, note: 'Checked MySubWallet dashboard: credited at 14:02' });
  assert.deepStrictEqual(vouched.updated, [d12.id]);
  const noteEvent = eventsOf(d12.id).find(e => e.to_status === 'available');
  assert.strictEqual(noteEvent.actor, 'admin:finance-ada');
  assert.ok(String(noteEvent.note).startsWith('enc:'), 'admin notes are ciphertext at rest');
  assert.strictEqual(noteEvent.meta.confirmed_by_admin, true);

  // A process that died mid-submit: asked about; unknown is kept, never dropped.
  reset();
  const d13 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  Object.assign(conv(d13.id), { status: 'submitting', amount: 1000, payout: 650, fee: 100, provider_request_id: conv(d13.id).reference, updated_at: ago(A2C.STRANDED_SUBMIT_MS + 60_000) });
  await service.sweep();
  assert.strictEqual(conv(d13.id).status, 'processing');
  assert.strictEqual(conv(d13.id).provider_status, 'unknown');

  const d14 = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234568' });
  Object.assign(conv(d14.id), { status: 'submitting', provider_request_id: `${conv(d14.id).reference}`, updated_at: ago(A2C.STRANDED_SUBMIT_MS + 60_000) });
  answers.requery = { status: 'failed' };
  await service.sweep();
  // Failed, never abandoned: a step 3 that was sent stays somewhere a person
  // can see it, and an admin can still record it if MySubWallet was wrong.
  assert.strictEqual(conv(d14.id).status, 'failed', 'a sent step 3 never goes back to an invisible state');
  assert.ok(pushSubjects().includes('Conversion not completed'));

  // Drafts nobody came back to are closed and their tokens dropped.
  reset();
  const stale = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  conv(stale.id).updated_at = ago(A2C.DRAFT_TTL_MS + 60_000);
  await service.sweep();
  assert.strictEqual(conv(stale.id).status, 'abandoned');
  assert.strictEqual(conv(stale.id).provider_token_enc, null);

  /* ------------------------------------------ 5. the admin unlock */

  reset();
  const p1 = await converted({ amount: 5000 });
  const p2 = await converted({ network: 'AIRTEL', phone: '08021234567', amount: 1000 });
  const bulk = await respond(adminController.markAvailable, { body: { ids: [p1.id, p2.id, 999] } });
  assert.strictEqual(bulk.status, 200);
  assert.deepStrictEqual(bulk.body.data.updated, [p1.id, p2.id]);
  assert.deepStrictEqual(bulk.body.data.skipped, [{ id: 999, reason: 'not_found' }]);
  assert.strictEqual(bulk.body.data.payout_total, '4350.00');
  assert.strictEqual(conv(p1.id).settled_by, 'finance-ada');
  assert.strictEqual(pushSubjects().filter(s => s === 'Cash ready to withdraw').length, 2);

  // Again: nothing moves twice, nobody is told twice.
  const again = await service.markAvailable({ ids: [p1.id], actor: 'finance-ada' });
  assert.deepStrictEqual(again.skipped, [{ id: p1.id, reason: 'status_available' }]);
  assert.strictEqual(pushSubjects().filter(s => s === 'Cash ready to withdraw').length, 2);

  // Mark failed needs a reason, and never touches money in flight.
  const p3 = await converted({ amount: 1000 });
  assert.strictEqual((await rejects(service.markFailed({ id: p3.id, actor: 'finance-ada', note: 'no' }))).remark, 'note_required');
  await service.markFailed({ id: p3.id, actor: 'finance-ada', note: 'MySubWallet never credited this - ticket 41' });
  assert.strictEqual(conv(p3.id).status, 'failed');
  assert.ok(pushSubjects().includes('Conversion not completed'));

  // The overview adds up.
  const ov = await respond(adminController.overview, {});
  assert.strictEqual(ov.status, 200);
  assert.deepStrictEqual(
    [ov.body.data.cards.available.count, ov.body.data.cards.available.payout, ov.body.data.cards.failed.count],
    [2, '4350.00', 1],
  );
  assert.strictEqual(ov.body.data.funding.paystack.balance, '20000.00');
  assert.strictEqual(ov.body.data.funding.shortfall, '0.00');

  /* ------------------------------------------------- 6. withdraw */

  // To the verified KYC account: resolved again, the name checked, one transfer.
  const opts = await respond(controller.withdrawOptions, {});
  assert.strictEqual(opts.body.data.available_total, '4350.00');
  assert.deepStrictEqual(opts.body.data.accounts.map(a => [a.source, a.account_masked]), [['kyc', '****6789']]);
  assert.ok(!JSON.stringify(opts.body).includes(KYC_ACCOUNT), 'the full account number never leaves the server');

  assert.strictEqual((await rejects(service.withdraw({ userId: USER_ID, conversionIds: 'all', account: { source: 'kyc' }, pin: '9999' }))).remark, 'invalid_pin');
  assert.strictEqual(spy.transfers.length, 0);

  const wOut = await respond(controller.withdraw, { body: { conversion_ids: 'all', account: { source: 'kyc' }, pin: '1234' } });
  assert.strictEqual(wOut.status, 200, JSON.stringify(wOut.body));
  assert.strictEqual(wOut.body.data.withdrawal.status, 'processing');
  const w1 = db.airtimeCashWithdrawal[0];
  assert.ok(w1.reference.startsWith('a2cw-'), 'the prefix the shared webhook routes on');
  assert.deepStrictEqual(spy.resolve[0], { account_number: KYC_ACCOUNT, bank_code: '058' });
  assert.deepStrictEqual(spy.transfers.map(t => t.amountKobo), [435_000], 'both conversions, one transfer, in kobo');
  assert.strictEqual(spy.transfers[0].reference, w1.reference);
  assert.deepStrictEqual([conv(p1.id).status, conv(p2.id).status], ['withdrawing', 'withdrawing']);
  assert.strictEqual(w1.provider_fee, 10, "Paystack's fee is ours, recorded for the margin");
  assert.strictEqual(w1.fee, 0, 'and free to the customer');
  assert.ok(!String(w1.account_number_enc).includes('6789'));

  // Nothing left to withdraw while it is in flight.
  assert.strictEqual((await rejects(service.withdraw({ userId: USER_ID, conversionIds: 'all', account: { source: 'kyc' }, pin: '1234' }))).remark, 'nothing_to_withdraw');

  // The webhook settles it; the poll, arriving second, is a no-op.
  assert.strictEqual(await service.handleTransferEvent({ event: 'transfer.success', data: { reference: w1.reference, transfer_code: 'TRF_1' } }), true);
  assert.strictEqual(wd(w1.id).status, 'success');
  assert.deepStrictEqual([conv(p1.id).status, conv(p2.id).status], ['withdrawn', 'withdrawn']);
  answers.verifyTransfer = { status: 'success' };
  assert.strictEqual(await service.syncWithdrawal(wd(w1.id)), false);
  await service.handleTransferEvent({ event: 'transfer.success', data: { reference: w1.reference } });
  assert.strictEqual(pushSubjects().filter(s => s === 'Withdrawal successful').length, 1, 'told once');

  // The timeline reads withdrawn, with the bank.
  const det = await service.conversionDetails({ userId: USER_ID, id: p1.id });
  assert.deepStrictEqual(det.timeline.map(s => s.state), ['done', 'done', 'done', 'done']);
  assert.match(det.timeline[3].subtitle, /GTBank \*\*\*\*6789/);

  // Reversed by the bank: owed again, so available again.
  await service.handleTransferEvent({ event: 'transfer.reversed', data: { reference: w1.reference } });
  assert.strictEqual(wd(w1.id).status, 'reversed');
  assert.deepStrictEqual([conv(p1.id).status, conv(p2.id).status], ['available', 'available']);
  assert.strictEqual(conv(p1.id).withdrawal_id, null);
  assert.ok(pushSubjects().includes('Withdrawal returned'));

  // Other people's references are not ours.
  assert.strictEqual(await service.handleTransferEvent({ event: 'transfer.success', data: { reference: 'SPPAY-1-2-x' } }), false);
  assert.strictEqual(await service.handleTransferEvent({ event: 'transfer.success', data: { reference: 'a2cw-unknown' } }), false);

  // Refused on our side (our Paystack balance): released at once, ops paged,
  // and the customer told plainly - not that their bank failed them.
  answers.transfer = Object.assign(new Error('Your balance is not enough to fulfil this request'), { statusCode: 400 });
  const refused = await respond(controller.withdraw, { body: { conversion_ids: [p1.id], account: { source: 'kyc' }, pin: '1234' } });
  assert.strictEqual(refused.status, 502);
  assert.strictEqual(refused.body.remark, 'withdrawal_failed');
  assert.match(refused.body.message[0], /briefly unavailable/);
  assert.strictEqual(conv(p1.id).status, 'available');
  assert.strictEqual(conv(p1.id).withdrawal_id, null);
  assert.ok(spy.alerts.some(a => a.provider === 'paystack' && a.action === 'transfer'), 'our float is an incident');

  // A lost answer: in flight, until Paystack's own record decides.
  answers.transfer = Object.assign(new Error('Paystack request timed out'), { statusCode: 504 });
  answers.verifyTransfer = { status: 'pending' };
  await service.withdraw({ userId: USER_ID, conversionIds: [p1.id], account: { source: 'kyc' }, pin: '1234' });
  const w3 = db.airtimeCashWithdrawal[db.airtimeCashWithdrawal.length - 1];
  assert.strictEqual(w3.status, 'processing');
  assert.strictEqual(conv(p1.id).status, 'withdrawing', 'never released on a timeout');
  w3.updated_at = ago(2 * 60_000);
  await service.sweep();
  assert.strictEqual(wd(w3.id).status, 'processing', 'pending at Paystack stays pending');
  answers.verifyTransfer = { status: 'success' };
  wd(w3.id).updated_at = ago(2 * 60_000);
  await service.sweep();
  assert.strictEqual(wd(w3.id).status, 'success');
  assert.strictEqual(conv(p1.id).status, 'withdrawn');

  // A transfer Paystack never saw: released once the stranded window has passed.
  answers.transfer = Object.assign(new Error('socket hang up'), { statusCode: 504 });
  await service.withdraw({ userId: USER_ID, conversionIds: [p2.id], account: { source: 'kyc' }, pin: '1234' });
  const w4 = db.airtimeCashWithdrawal[db.airtimeCashWithdrawal.length - 1];
  answers.verifyTransfer = Object.assign(new Error('Transfer not found'), { statusCode: 404 });
  w4.updated_at = ago(2 * 60_000);
  await service.sweep();
  assert.strictEqual(wd(w4.id).status, 'processing', 'a 404 right after submit is Paystack catching up');
  wd(w4.id).updated_at = ago(service.STRANDED_TRANSFER_MS + 60_000);
  await service.sweep();
  assert.strictEqual(wd(w4.id).status, 'failed');
  assert.strictEqual(conv(p2.id).status, 'available', 'owed again, withdrawable again');

  // Two withdrawals racing for one conversion: one transfer.
  answers.transfer = undefined;
  let open;
  answers.transferGate = new Promise(r => (open = r));
  const transfersBefore = spy.transfers.length;
  const duel = Promise.allSettled([
    service.withdraw({ userId: USER_ID, conversionIds: [p2.id], account: { source: 'kyc' }, pin: '1234' }),
    service.withdraw({ userId: USER_ID, conversionIds: [p2.id], account: { source: 'kyc' }, pin: '1234' }),
  ]);
  await new Promise(r => setTimeout(r, 20));
  open();
  const duelled = await duel;
  answers.transferGate = undefined;
  assert.strictEqual(spy.transfers.length - transfersBefore, 1, 'one claim, one transfer');
  assert.strictEqual(duelled.filter(r => r.status === 'rejected').length, 1);
  assert.strictEqual(
    db.airtimeCashWithdrawal.filter(w => w.status === 'pending').length,
    0,
    "the loser's withdrawal row rolled back with its claim",
  );

  // A new account must be in the customer's own name - and a mismatch never
  // says whose it is.
  reset();
  await available({ amount: 2000 });
  answers.resolveName = 'JOHN DOE';
  const theirs = await respond(controller.resolveAccount, { body: { bank_code: '50211', account_number: '2014452610' } });
  assert.strictEqual(theirs.status, 400);
  assert.strictEqual(theirs.body.remark, 'name_mismatch');
  assert.ok(!JSON.stringify(theirs.body).includes('JOHN'), 'never an account-name lookup service');
  assert.match(theirs.body.message[0], /Ada Nwosu/, 'their own name is safe to show them');
  assert.deepStrictEqual(spy.security.map(s => s.scope), ['airtime_cash.payout_name_mismatch']);
  assert.strictEqual(
    (await rejects(service.withdraw({ userId: USER_ID, conversionIds: 'all', account: { bank_code: '50211', account_number: '2014452610' }, pin: '1234' }))).remark,
    'name_mismatch',
  );
  assert.strictEqual(spy.transfers.length, 0);

  answers.resolveName = 'NWOSU ADA CHIOMA';
  const mine = await respond(controller.resolveAccount, { body: { bank_code: '50211', account_number: '2014452610' } });
  assert.strictEqual(mine.status, 200);
  assert.deepStrictEqual([mine.body.data.account_name, mine.body.data.bank_name, mine.body.data.account_masked], ['NWOSU ADA CHIOMA', 'Kuda Bank', '****2610']);
  await service.withdraw({ userId: USER_ID, conversionIds: 'all', account: { bank_code: '50211', account_number: '2014452610' }, pin: '1234', saveAccount: true });
  const saved = await service.payoutAccounts(USER_ID);
  assert.deepStrictEqual(saved.map(a => [a.source, a.bank_name, a.account_masked]), [['kyc', 'GTBank', '****6789'], ['saved', 'Kuda Bank', '****2610']]);

  // A processing conversion cannot be withdrawn, by id or otherwise.
  reset();
  const locked = await converted({ amount: 1000 });
  assert.strictEqual(
    (await rejects(service.withdraw({ userId: USER_ID, conversionIds: [locked.id], account: { source: 'kyc' }, pin: '1234' }))).remark,
    'nothing_to_withdraw',
  );
  kycVerified = false;
  assert.strictEqual((await rejects(service.withdraw({ userId: USER_ID, conversionIds: 'all', account: { source: 'kyc' }, pin: '1234' }))).remark, 'kyc_required');
  kycVerified = true;

  /* ---------------------------------------- 7. waiting on settlement */

  reset();
  const waiting = await converted({ amount: 1000 });
  conv(waiting.id).converted_at = ago((A2C.settlementAlertHours() + 1) * 60 * 60_000);
  await service.sweep();
  await service.sweep();
  const settlementAlerts = spy.alerts.filter(a => a.action === 'airtime_cash_settlement');
  assert.strictEqual(settlementAlerts.length, 1, 'paged once, not every five minutes');
  assert.match(settlementAlerts[0].message, /fund Paystack/);

  // The home screen: totals, and only the customer's side of each rate.
  const home = await respond(controller.home, {});
  assert.strictEqual(home.status, 200);
  assert.strictEqual(home.body.data.summary.pending_total, '650.00');
  assert.deepStrictEqual(home.body.data.networks.map(n => [n.code, n.rate_label, n.fee]), [['MTN', '75%', '100.00'], ['AIRTEL', '70%', '0.00']]);
  assert.ok(!/provider|margin/.test(JSON.stringify(home.body.data.networks)));
  assert.strictEqual(home.body.data.limits.otp_seconds, 60);

  /* ------ 9. 2026-10-12: a conversion MySubWallet accepted is always recorded */

  // 9a. The live answer that was lost: accepted, still working. Recorded on the
  //     spot as the customer's pending cash - never rolled back to a draft.
  reset();
  const live = await service.startConversion({ userId: USER_ID, network: 'AIRTEL', phone: '08021234567' });
  await service.verifyOtp({ userId: USER_ID, id: live.id, otp: '4821' });
  answers.complete = { status: 'processing', accepted: true, message: 'Checking transaction... We will notify you once it is successful.', credited: null };
  const liveOut = await respond(controller.convert, { params: { id: live.id }, body: { amount: 1000, share_pin: '7391' } });
  assert.strictEqual(liveOut.status, 200);
  assert.strictEqual(conv(live.id).status, 'processing', 'credited as pending - never filed as a refusal');
  assert.strictEqual(conv(live.id).provider_status, 'pending');
  assert.match(conv(live.id).provider_message, /Checking transaction/, 'their words, kept for whoever confirms it');
  assert.strictEqual(conv(live.id).payout, 700, 'Airtel 70% - rates unchanged');
  assert.deepStrictEqual(pushSubjects(), ['Confirming your conversion'], 'told it is being confirmed, never "available"');
  const liveHome = await respond(controller.home, {});
  assert.strictEqual(liveHome.body.data.summary.pending_total, '700.00');
  assert.strictEqual(liveHome.body.data.conversions[0].withdrawable, false, 'no withdrawal until settled');

  // 9b. Retrying the same conversion never credits twice: one step 3, one
  //     row, one push - and recording it again is a no-op.
  await service.convert({ userId: USER_ID, id: live.id, amount: 1000, sharePin: '7391' });
  assert.strictEqual(step3().length, 1);
  assert.strictEqual(await service.recoverConversion(conv(live.id), { providerStatus: 'confirmed', via: 'test' }), false);
  assert.strictEqual(spy.pushes.length, 1);
  assert.strictEqual((await respond(controller.home, {})).body.data.summary.pending_total, '700.00', 'counted once');

  // 9c. A refusal whose words prove nothing either way is kept, not rolled back.
  reset();
  const vagueDraft = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: vagueDraft.id, otp: '4821' });
  answers.complete = Object.assign(new Error('The network did not complete the transfer.'), {
    statusCode: 400,
    ambiguous: true,
    unclassified: true,
    providerMessage: 'Something went wrong',
    httpStatus: 403,
    mysubwallet: { status: 'fail', message: 'Something went wrong' },
  });
  await service.convert({ userId: USER_ID, id: vagueDraft.id, amount: 2000, sharePin: '7391' });
  assert.deepStrictEqual([conv(vagueDraft.id).status, conv(vagueDraft.id).provider_status], ['processing', 'unknown']);
  assert.strictEqual(eventsOf(vagueDraft.id).find(e => e.to_status === 'processing').meta.via, 'unclassified_refusal');

  // 9d. The database blinks after MySubWallet answered: retried in the
  //     request, recorded once.
  reset();
  const blip = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: blip.id, otp: '4821' });
  const realUpdateMany = fakePrisma.airtimeCashConversion.updateMany;
  let writeFailures = 2;
  fakePrisma.airtimeCashConversion.updateMany = async args => {
    if (args?.data?.status === 'processing' && writeFailures > 0) {
      writeFailures -= 1;
      throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1017' });
    }
    return realUpdateMany(args);
  };
  const blipOut = await service.convert({ userId: USER_ID, id: blip.id, amount: 5000, sharePin: '7391' });
  assert.strictEqual(conv(blip.id).status, 'processing', 'recorded on the third try');
  assert.strictEqual(blipOut.deferred, false);
  assert.strictEqual(pushSubjects().filter(s => s === 'Airtime converted').length, 1);

  // 9e. The database stays down through every try: the customer is told it was
  //     received (never an error they would convert again from), the row waits
  //     in `submitting`, and the sweep records it - visible, never dropped.
  reset();
  const down = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: down.id, otp: '4821' });
  writeFailures = Infinity;
  const downOut = await respond(controller.convert, { params: { id: down.id }, body: { amount: 5000, share_pin: '7391' } });
  assert.strictEqual(downOut.status, 200, 'MySubWallet answered - the customer must not retry');
  assert.match(downOut.body.message[0], /received/);
  assert.strictEqual(downOut.body.data.conversion.status, 'processing');
  assert.strictEqual(conv(down.id).status, 'submitting', 'the write did not land...');
  // The customer already sees it, shown as pending.
  const downHome = await respond(controller.home, {});
  assert.deepStrictEqual(downHome.body.data.conversions.map(c => [c.status, c.status_label]), [['processing', 'Confirming with network']]);
  assert.strictEqual(downHome.body.data.summary.pending_total, '3650.00');
  writeFailures = 0;
  fakePrisma.airtimeCashConversion.updateMany = realUpdateMany;
  conv(down.id).updated_at = ago(A2C.STRANDED_SUBMIT_MS + 60_000);
  await service.sweep();
  assert.strictEqual(conv(down.id).status, 'processing', '...and the sweep records it');
  await service.sweep();
  assert.strictEqual(eventsOf(down.id).filter(e => e.to_status === 'processing').length, 1, 'recorded exactly once');

  // 9f. Already-missed conversions - the row conversion #8 was left as:
  //     abandoned after an accepted step 3. Found, recovered as pending,
  //     dated when it was sent, the customer told - once.
  reset();
  const missed = await service.startConversion({ userId: USER_ID, network: 'AIRTEL', phone: '08021234567' });
  const sentAt = ago(7 * 60 * 60_000);
  Object.assign(conv(missed.id), {
    status: 'abandoned', convert_attempts: 1, amount: 1000, fee: 0, payout: 700, payout_rate_bps: 7000,
    provider_request_id: conv(missed.id).reference, submitted_at: sentAt, provider_token_enc: null,
    provider_message: 'Checking transaction... We will notify you once it is successful.',
  });
  const declinedDraft = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  Object.assign(conv(declinedDraft.id), {
    status: 'abandoned', convert_attempts: 1, amount: 1000, payout: 650, provider_message: 'Incorrect transfer PIN',
  });
  const dry = await service.reconcileMisfiled({ apply: false });
  assert.deepStrictEqual(dry.recovered.map(r => r.id), [missed.id], 'only the accepted one is evidence');
  assert.strictEqual(conv(missed.id).status, 'abandoned', 'a dry run writes nothing');
  assert.strictEqual(spy.pushes.length, 0);
  const recoverySweep = await service.sweep();
  assert.strictEqual(recoverySweep.recovered, 1);
  assert.deepStrictEqual([conv(missed.id).status, conv(missed.id).provider_status], ['processing', 'pending']);
  assert.strictEqual(new Date(conv(missed.id).converted_at).getTime(), sentAt.getTime(), 'dated when it actually happened');
  assert.strictEqual(conv(declinedDraft.id).status, 'abandoned', 'a PIN refusal moved nothing and stays closed');
  assert.deepStrictEqual(pushSubjects(), ['Airtime conversion now reflected']);
  await service.sweep();
  assert.strictEqual(spy.pushes.length, 1, 'recovered once, told once');
  const recoveredEvent = eventsOf(missed.id).find(e => e.event === 'recovered');
  assert.deepStrictEqual([recoveredEvent.meta.via, recoveredEvent.meta.from], ['reclassified', 'abandoned'], 'every recovery is in the trail');

  // 9g. The admin half - conversion #5's shape: unknown, then marked failed,
  //     but MySubWallet's dashboard shows it credited.
  reset();
  const five = await service.startConversion({ userId: USER_ID, network: 'AIRTEL', phone: '08021234567' });
  await service.verifyOtp({ userId: USER_ID, id: five.id, otp: '4821' });
  answers.complete = Object.assign(new Error('x'), { statusCode: 504, ambiguous: true });
  await service.convert({ userId: USER_ID, id: five.id, amount: 1000, sharePin: '7391' });
  await service.markFailed({ id: five.id, actor: 'finance-ada', note: 'No answer from the network' });
  assert.strictEqual(conv(five.id).status, 'failed');
  assert.strictEqual((await rejects(service.recordProviderSuccess({ id: five.id, actor: 'finance-ada', note: 'ok' }))).remark, 'note_required');
  const recorded = await respond(adminController.recordProviderSuccess, {
    params: { id: five.id },
    body: { note: 'MySubWallet A2C history: Airtel 1,000 credited 01:09 WAT' },
  });
  assert.strictEqual(recorded.status, 200);
  assert.deepStrictEqual([conv(five.id).status, conv(five.id).provider_status, conv(five.id).failure_reason], ['processing', 'confirmed', null]);
  assert.ok(pushSubjects().includes('Airtime conversion now reflected'));
  const adminRecovery = eventsOf(five.id).find(e => e.event === 'recovered');
  assert.strictEqual(adminRecovery.actor, 'admin:finance-ada');
  assert.ok(String(adminRecovery.note).startsWith('enc:'), 'the evidence note is ciphertext at rest');
  assert.strictEqual((await rejects(service.recordProviderSuccess({ id: five.id, actor: 'finance-ada', note: 'second time around' }))).remark, 'already_recorded');
  const noStepThree = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  assert.strictEqual((await rejects(service.recordProviderSuccess({ id: noStepThree.id, actor: 'finance-ada', note: 'never sent anything' }))).remark, 'not_recordable');
  // Then settlement as ever: confirmed by the admin, so it unlocks without a vouch.
  assert.deepStrictEqual((await service.markAvailable({ ids: [five.id], actor: 'finance-ada' })).updated, [five.id]);

  // 9h. What support sees: search by the line or a reference, a needs-review
  //     queue, and whether the customer was credited.
  reset();
  const inFlight = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  Object.assign(conv(inFlight.id), { status: 'submitting', convert_attempts: 1, amount: 1000, payout: 650, provider_request_id: `${conv(inFlight.id).reference}` });
  const unrecordedOne = await service.startConversion({ userId: OTHER_USER, network: 'AIRTEL', phone: '08021234567' });
  Object.assign(conv(unrecordedOne.id), { status: 'abandoned', convert_attempts: 2, amount: 1000, payout: 700, provider_request_id: `${conv(unrecordedOne.id).reference}-2`, provider_message: 'Transaction failed' });
  const pinTypo = await service.startConversion({ userId: OTHER_USER, network: 'MTN', phone: '08031234568' });
  Object.assign(conv(pinTypo.id), { status: 'abandoned', convert_attempts: 1, amount: 1000, payout: 650, provider_message: 'Incorrect transfer PIN' });

  assert.deepStrictEqual(service.reviewState(conv(inFlight.id)).needs_review, 'in_flight');
  assert.deepStrictEqual(service.reviewState(conv(unrecordedOne.id)).needs_review, 'unrecorded');
  assert.strictEqual(service.reviewState(conv(pinTypo.id)).needs_review, null, 'a proven refusal needs nobody');
  assert.strictEqual(service.reviewState(conv(unrecordedOne.id)).recordable, true);

  const review = await respond(adminController.listConversions, { query: { needs_review: '1' } });
  assert.deepStrictEqual(review.body.data.items.map(i => i.id).sort(), [inFlight.id, unrecordedOne.id].sort());
  assert.strictEqual(review.body.data.counts.needs_review, 2);
  const unrecordedRow = review.body.data.items.find(i => i.id === unrecordedOne.id);
  assert.deepStrictEqual(
    [unrecordedRow.step3_sent, unrecordedRow.user_credited, unrecordedRow.provider_reference, unrecordedRow.provider_message],
    [true, false, `${conv(unrecordedOne.id).reference}-2`, 'Transaction failed'],
  );

  const byLine = await respond(adminController.listConversions, { query: { phone: '+234 802 123 4567' } });
  assert.deepStrictEqual(byLine.body.data.items.map(i => i.id), [unrecordedOne.id], 'found by the line through its blind index - drafts included');
  const byRequestId = await respond(adminController.listConversions, { query: { q: `${conv(unrecordedOne.id).reference}-2` } });
  assert.deepStrictEqual(byRequestId.body.data.items.map(i => i.id), [unrecordedOne.id], 'found by the request-id step 3 went out under');
  const reviewAndSearch = await respond(adminController.listConversions, { query: { needs_review: '1', q: conv(inFlight.id).reference } });
  assert.deepStrictEqual(reviewAndSearch.body.data.items.map(i => i.id), [inFlight.id], 'a search narrows the review queue, never replaces it');
  assert.strictEqual((await respond(adminController.listConversions, { query: { phone: '12345' } })).status, 400);

  const ov2 = await respond(adminController.overview, {});
  assert.deepStrictEqual(ov2.body.data.needs_review, { count: 2, in_flight: 1, unconfirmed: 0, unrecorded: 1 });
  assert.strictEqual(ov2.body.data.owed_to_customers.pending, '650.00', 'a step 3 in flight is owed as pending');
  assert.strictEqual(ov2.body.data.owed_to_customers.total, '650.00');
  // MySubWallet's own Airtime to Cash balance - where conversions land - beside
  // what we owe, and never confused with the bills float.
  assert.deepStrictEqual(ov2.body.data.airtime_to_cash_balance, {
    available: true,
    balance: '1400.00',
    retrieved_at: '2026-10-12T15:00:00.000Z',
  });
  assert.strictEqual(ov2.body.data.funding.mysubwallet.balance, '80000.00', 'the bills float stays its own figure');
  answers.balance = { balance: 80_000, airtime_to_cash_balance: null };
  assert.deepStrictEqual(
    (await respond(adminController.overview, {})).body.data.airtime_to_cash_balance,
    { available: false, reason: 'not_reported' },
    'a balance they did not send is unknown, never 0',
  );
  answers.balance = { balance: null, airtime_to_cash_balance: 0 };
  assert.strictEqual(
    (await respond(adminController.overview, {})).body.data.airtime_to_cash_balance.balance,
    '0.00',
    'a real zero is shown even when the float is unreadable',
  );

  // 9i. A refusal proven by a flag rather than by wording - an expired session,
  //     their rate limit - is stamped when it happens, so it never reads later
  //     as "sent, never recorded" and never joins the review queue.
  reset();
  const lapsed = await service.startConversion({ userId: USER_ID, network: 'MTN', phone: '08031234567' });
  await service.verifyOtp({ userId: USER_ID, id: lapsed.id, otp: '4821' });
  answers.complete = Object.assign(new Error('Your verification expired. Start again.'), {
    statusCode: 400,
    sessionExpired: true,
    providerMessage: 'Verification token expired',
  });
  assert.strictEqual((await rejects(service.convert({ userId: USER_ID, id: lapsed.id, amount: 1000, sharePin: '7391' }))).remark, 'session_expired');
  assert.deepStrictEqual([conv(lapsed.id).status, conv(lapsed.id).provider_status], ['abandoned', 'declined']);
  assert.strictEqual(realMsw.isClearCashDecline({ providerMessage: 'Verification token expired' }), false, 'the words alone prove nothing...');
  assert.strictEqual(service.reviewState(conv(lapsed.id)).needs_review, null, '...the stamp does');
  assert.strictEqual((await respond(adminController.listConversions, { query: { needs_review: '1' } })).body.data.items.length, 0);
  assert.strictEqual((await service.reconcileMisfiled({ apply: false })).recovered.length, 0);
  const rateLimited = { status: 'otp_verified', convert_attempts: 1, payout: 650, provider_message: 'Too Many Attempts.' };
  assert.strictEqual(service.reviewState({ ...rateLimited, provider_status: 'declined' }).needs_review, null);
  // The same words on a row from before the stamp prove nothing either way,
  // so a person looks - the conservative side.
  assert.strictEqual(service.reviewState({ ...rateLimited, provider_status: null }).needs_review, 'unrecorded');

  // 9j. The line has used today's transfer (MySubWallet's answer to #9 and
  //     #10): told why at once, the draft closed - the line cannot use it
  //     again today - never shown as pending, nothing left to review.
  reset();
  const limited = await service.startConversion({ userId: USER_ID, network: 'AIRTEL', phone: '08021234567' });
  await service.verifyOtp({ userId: USER_ID, id: limited.id, otp: '4821' });
  answers.complete = Object.assign(
    new Error('This line has reached its airtime transfer limit for today. Try again tomorrow, or convert from another line.'),
    {
      statusCode: 400,
      kind: 'limit',
      dailyLimit: true,
      providerMessage:
        'This Airtel line has already converted airtime today. Airtel allows only one transfer per line per day — please try again tomorrow, or use another line.',
    },
  );
  const limitErr = await rejects(service.convert({ userId: USER_ID, id: limited.id, amount: 1000, sharePin: '7391' }));
  assert.strictEqual(limitErr.remark, 'line_daily_limit');
  assert.match(limitErr.message, /limit for today/);
  assert.ok(!/new code/.test(limitErr.message), 'not a code problem - a new code would not help today');
  assert.strictEqual(limitErr.data.closed, true, 'the app drops the draft');
  assert.deepStrictEqual([conv(limited.id).status, conv(limited.id).provider_status], ['abandoned', 'declined']);
  assert.strictEqual(spy.pushes.length, 0, 'never told it is pending');
  assert.strictEqual(service.reviewState(conv(limited.id)).needs_review, null);
  assert.strictEqual((await respond(controller.home, {})).body.data.summary.pending_total, '0.00');

  /* ------------------- 10. the full history behind the home's newest four */

  // The app's home shows the newest four; "View all" pages through the rest on
  // the server, with the home's own tab meanings.
  reset();
  const history = [];
  for (let i = 0; i < 6; i += 1) {
    const row = await converted({ phone: `0803123450${i}`, amount: 1000 });
    conv(row.id).created_at = ago((6 - i) * 60_000);
    history.push(row.id);
  }
  const newestFirst = [...history].reverse();
  const firstPage = await service.listConversions({ userId: USER_ID, perPage: 4, page: 1 });
  const secondPage = await service.listConversions({ userId: USER_ID, perPage: 4, page: 2 });
  assert.deepStrictEqual(firstPage.conversions.map(c => c.id), newestFirst.slice(0, 4), 'newest first');
  assert.strictEqual(firstPage.has_more, true);
  assert.deepStrictEqual(secondPage.conversions.map(c => c.id), newestFirst.slice(4));
  assert.strictEqual(secondPage.has_more, false, 'every conversion reachable, none twice');

  // "Withdrawn" carries money still on its way to the bank, as the home's tab does.
  Object.assign(conv(history[0]), { status: 'withdrawn' });
  Object.assign(conv(history[1]), { status: 'withdrawing' });
  const banked = await respond(controller.conversions, { query: { status: 'withdrawn' } });
  assert.deepStrictEqual(banked.body.data.conversions.map(c => c.id).sort(), [history[0], history[1]].sort());
  const settling = await respond(controller.conversions, { query: { status: 'processing' } });
  assert.strictEqual(settling.body.data.conversions.length, 4);

  /* ------------------------------------- 8. deployed before its DDL */

  // The timer starts on every boot. Before `npm run ddl:airtime-cash` the
  // tables are missing, and that must idle the sweep - not page ops every
  // five minutes. Any other database error still surfaces.
  const realFindMany = fakePrisma.airtimeCashWithdrawal.findMany;
  fakePrisma.airtimeCashWithdrawal.findMany = async () => {
    throw Object.assign(new Error('The table `public.airtime_cash_withdrawals` does not exist in the current database.'), { code: 'P2021' });
  };
  assert.deepStrictEqual(await service.sweep(), { skipped: 'no_tables' });
  fakePrisma.airtimeCashWithdrawal.findMany = async () => {
    throw Object.assign(new Error('connection reset'), { code: 'P1017' });
  };
  await assert.rejects(service.sweep(), /connection reset/, 'a real outage is not swallowed');
  fakePrisma.airtimeCashWithdrawal.findMany = realFindMany;

  console.log('✅ airtimeCash flow tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
