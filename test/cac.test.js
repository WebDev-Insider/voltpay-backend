/**
 * node test/cac.test.js
 *
 * CAC Registration end to end - draft, pay, process, documents, refund -
 * for all three types, against a fake database and stubbed Paystack and
 * storage. No network, no Redis, no Postgres. The real balance helper and the
 * real encryption run.
 *
 *   1. The rules: whole-naira prices, each type's form (a company's shares add
 *      up to 100%, an NGO has two trustees and a constitution, every person a
 *      NIN the phone only ever sees four digits of), files judged by their own
 *      bytes (an SVG never gets in), the timeline.
 *   2. The price is the admin's, per type: no price, no sale; the charge is
 *      the type's price at payment and is frozen onto the application.
 *   3. A draft is never work: invisible to the admin queue and unprocessable.
 *   4. Wallet: PIN, a quote that must still be the price, one debit, all or
 *      nothing - a short wallet leaves the draft a draft.
 *   5. Paystack: one checkout per window, settled only on Paystack's word, by
 *      whichever of webhook/verify/sweep gets there first - once. Money that
 *      arrives for an application already paid goes back to the wallet.
 *   6. Processing: every admin step is guarded, needs-more-info round-trips,
 *      an admin hands over several documents, the certificate is required to
 *      complete, and the customer downloads them only then.
 *   7. Reject with a refund credits the wallet exactly once, and only finance
 *      or superadmin may do it.
 *   8. Companies and NGOs: every person's documents, removed people's files
 *      deleted, a paid application cannot change type.
 *   9. The sweep finishes checkouts nobody verified and wipes stale drafts.
 *  10. Nothing personal is stored or logged in plain text.
 */
const assert = require('assert');
const { Writable } = require('stream');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYSTACK_SECRET_KEY = 'sk_test_cac';
process.env.PUBLIC_BASE_URL = 'https://api.voltpay.test';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
for (const key of Object.keys(process.env)) if (key.startsWith('CAC_')) delete process.env[key];
process.env.NODE_ENV = 'test';

const { Prisma } = require('@prisma/client');

/* ---------------------------------------------------------- fake database */

const USER_ID = 7;
const OTHER_USER = 8;
let db;
const ids = { cacApplication: 0, cacApplicationEvent: 0, cacPayment: 0, cacDeliverable: 0, walletTransaction: 0, appSetting: 0 };

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
    // SQL semantics: comparisons never match NULL.
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
  // Prisma's @updatedAt, and a millisecond later than whatever stamped it last -
  // the optimistic guards key on it, so two writes must never share a value.
  if (!('updated_at' in data)) row.updated_at = new Date(Math.max(Date.now(), time(row.updated_at || 0) + 1));
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
  cacApplication: () => ({
    registration_type: 'business_name', status: 'draft', payment_status: 'unpaid', payment_method: null,
    payment_reference: null, amount_paid: null, documents_enc: null, registered_name_enc: null,
    registration_number_enc: null, admin_note_enc: null, resubmissions: 0, paid_at: null, submitted_at: null,
    started_at: null, info_requested_at: null, info_provided_at: null, completed_at: null, rejected_at: null,
    refunded_at: null, refund_trx: null,
  }),
  cacApplicationEvent: () => ({ from_status: null, to_status: null, actor: 'system', note_enc: null, meta: null }),
  cacDeliverable: () => ({ label_enc: null, size: null, uploaded_by: null }),
  cacPayment: () => ({
    amount_received: null, status: 'pending', provider_status: null, authorization_url: null, failure_reason: null,
    refund_trx: null, paid_at: null, checked_at: null,
  }),
  walletTransaction: () => ({ details: null, other_data: null, meta: null }),
  appSetting: () => ({ description: null }),
  user: () => ({}),
};

const UNIQUE = {
  cacApplication: ['reference'],
  cacPayment: ['reference'],
  walletTransaction: ['trx'],
  appSetting: ['setting_key'],
};

function insert(table, data) {
  const now = new Date();
  const row = { ...DEFAULTS[table](), created_at: now, updated_at: now, ...plain(data) };
  for (const col of UNIQUE[table] || []) {
    if (row[col] != null && db[table].some(r => r[col] === row[col])) throw P2002();
  }
  if (table in ids && row.id == null) row.id = ++ids[table];
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
    async delete({ where }) {
      const row = db[table].find(r => matches(r, where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      db[table] = db[table].filter(r => r !== row);
      return clone(row);
    },
    async deleteMany({ where } = {}) {
      const before = db[table].length;
      db[table] = db[table].filter(r => !matches(r, where));
      return { count: before - db[table].length };
    },
    async upsert({ where, update, create }) {
      const row = db[table].find(r => matches(r, where));
      if (row) {
        applyData(row, update);
        return clone(row);
      }
      return clone(insert(table, create));
    },
    async aggregate({ where, _sum }) {
      const rows = db[table].filter(r => matches(r, where));
      const sum = {};
      for (const k of Object.keys(_sum || {})) sum[k] = rows.length ? rows.reduce((n, r) => n + Number(r[k] || 0), 0) : null;
      return { _sum: sum };
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

const fakePrisma = {
  user: model('user'),
  appSetting: model('appSetting'),
  cacApplication: model('cacApplication'),
  cacApplicationEvent: model('cacApplicationEvent'),
  cacPayment: model('cacPayment'),
  cacDeliverable: model('cacDeliverable'),
  walletTransaction: model('walletTransaction'),
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

const spy = { init: [], verify: [], uploads: [], deleted: [], pushes: [], emails: [], errors: [], adminLogs: [], flags: [] };
const pushKeys = new Set();
const storage = new Map();
let paystackRecords = {};
let answers = {};
let featureOn = true;
let uploadSeq = 0;

stub('../database/prisma', fakePrisma);
stub('../src/funding/paystack.service', {
  initializeTransaction: async args => {
    spy.init.push(args);
    if (answers.init instanceof Error) throw answers.init;
    return { authorization_url: `https://checkout.paystack.com/${args.reference}`, reference: args.reference, raw: {} };
  },
  verifyTransaction: async reference => {
    spy.verify.push(reference);
    const r = paystackRecords[reference];
    if (r instanceof Error) throw r;
    if (!r) throw Object.assign(new Error('Transaction reference not found'), { statusCode: 400 });
    return { raw: {}, data: r };
  },
});
stub('../src/helpers/upload.helper', {
  uploadFile: async (file, { prefix }) => {
    if (answers.uploadFail) throw new Error('UploadThing down');
    uploadSeq += 1;
    const url = `https://app.ufs.sh/f/key${uploadSeq}`;
    storage.set(url, { buffer: file.buffer, mime: file.mimetype });
    spy.uploads.push({ prefix, mime: file.mimetype, name: file.originalname, url });
    return { url, key: `key${uploadSeq}`, name: file.originalname, size: file.buffer.length };
  },
  deleteFileByUrl: async url => {
    spy.deleted.push(url);
    storage.delete(url);
    return true;
  },
  fileKeyFromUrl: url => String(url).split('/').pop(),
  isUploadThingUrl: url => String(url).includes('.ufs.sh/f/'),
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
stub('../src/services/email.service', {
  sendCacCertificateEmail: async args => {
    spy.emails.push(args);
    return { queued: true };
  },
});
stub('../src/services/userAudit.service', { logUserEvent: async () => null, logMoneyEvent: async () => null });
stub('../src/services/alerts.service', {
  captureError: (scope, e, ctx) => spy.errors.push({ scope, message: e?.message, ctx }),
  paymentFailure: () => {},
  securityEvent: () => {},
});
stub('../src/services/audit.service', {
  logAdminAction: async entry => spy.adminLogs.push(entry),
  clientIp: () => '127.0.0.1',
});
stub('../src/helpers/featureFlag.helper', {
  isFeatureEnabled: async () => featureOn,
  setFeature: async (slug, enabled) => {
    spy.flags.push({ slug, enabled });
    featureOn = Boolean(enabled);
    return { slug, enabled: featureOn };
  },
  requireFeature: () => (req, res, next) => next(),
  FEATURES: { cac_registration: 'CAC business name registration' },
});
// The real encryption, so stored values are provably not plain text; only the
// PIN check is faked - scrypt is slow and not what is under test.
const realPii = require('../src/helpers/pii.helper');
stub('../src/helpers/pii.helper', { ...realPii, verifySecret: async pin => ({ ok: pin === '1234', needsRehash: false }) });

const CAC = require('../src/helpers/cac.helper');
const service = require('../src/services/cac.service');
const controller = require('../src/controllers/cac.controller');
const adminController = require('../src/controllers/adminCac.controller');

/* ---------------------------------------------------------------- helpers */

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const file = (buffer, mimetype, originalname) => [{ buffer, mimetype, originalname }];
const FILES = (over = {}) => ({
  // The phone's own file names carry the person's name - they must not survive.
  valid_id: file(PDF, 'application/pdf', 'Ada Nwosu NIN.pdf'),
  passport: file(JPG, 'image/jpeg', 'ada passport.jpg'),
  signature: file(PNG, 'image/png', 'signature.png'),
  ...over,
});
/** The three documents for one member slot. */
const MEMBER_FILES = slot => ({
  [`${slot}_valid_id`]: file(JPG, 'image/jpeg', `${slot} id.jpg`),
  [`${slot}_passport`]: file(JPG, 'image/jpeg', `${slot} face.jpg`),
  [`${slot}_signature`]: file(PNG, 'image/png', `${slot} sign.png`),
});

const FORM = {
  proposed_name_1: 'Ada Obi Ventures',
  proposed_name_2: 'Ada Obi Global Concepts',
  proposed_name_3: 'AdaObi Stores',
  nature_of_business: 'Fashion design and sales',
  business_address: '12 Allen Avenue, Ikeja, Lagos',
  owner_name: 'Ada Obi Nwosu',
  dob: '1994-05-17',
  phone: '0803 123 4567',
  email: 'Ada@Example.com',
  residential_address: '4 Opebi Road, Ikeja, Lagos',
  // Copied off a slip, spaces and all.
  nin: '1234 5678 901',
};
const OWNER_NIN = '12345678901';

/** Another person on a form. Each has their own NIN, made from their phone. */
const PERSON = (name, phone) => ({
  full_name: name,
  nin: `2${phone.replace(/D/g, '').slice(-10)}`,
  dob: '1990-01-15',
  phone,
  email: `${name.split(' ')[0].toLowerCase()}@example.com`,
  residential_address: '9 Admiralty Way, Lekki, Lagos',
});

const LTD_FORM = (over = {}) => ({
  ...FORM,
  registration_type: 'limited_company',
  proposed_name_1: 'Nwosu Technologies Limited',
  proposed_name_2: 'Nwosu Tech Solutions Limited',
  proposed_name_3: 'NT Digital Limited',
  nature_of_business: 'Software development and IT consulting',
  share_capital: '1000000',
  owner_shares: '40',
  members: JSON.stringify([
    { slot: 'm1', role: 'both', shares: 40, ...PERSON('Chidi Okafor Eze', '08051112222') },
    { slot: 'm2', role: 'shareholder', shares: 20, ...PERSON('Bola Ahmed Tinu', '08063334444') },
  ]),
  ...over,
});

const NGO_FORM = (over = {}) => ({
  ...FORM,
  registration_type: 'incorporated_trustees',
  proposed_name_1: 'Hope Rising Foundation',
  proposed_name_2: 'Hope Rising Initiative',
  proposed_name_3: 'Rising Hope Trust',
  nature_of_business: 'To provide free primary education materials to children in rural communities across Nigeria',
  members: JSON.stringify([{ slot: 'm1', ...PERSON('Ngozi Grace Obi', '08077778888') }]),
  ...over,
});

const PRICE = 35000; // business name, the partner's price
const LTD_PRICE = 55000;
const NGO_PRICE = 150000;
const START_BALANCE = 500_000;
const ADMIN = { name: 'ops-ada', role: 'support', id: 3 };
const FINANCE = { name: 'fin-bayo', role: 'finance', id: 4 };

function reset() {
  db = {
    user: [
      { id: USER_ID, pin: 'hashed', balance: START_BALANCE, balance_mac: null, email_enc: realPii.encryptValue('ada@voltpay.ng'), firstname_enc: realPii.encryptValue('Ada'), lastname_enc: realPii.encryptValue('Nwosu') },
      { id: OTHER_USER, pin: 'hashed', balance: 1_000, balance_mac: null, firstname_enc: realPii.encryptValue('Bayo'), lastname_enc: realPii.encryptValue('Ade') },
    ],
    appSetting: [],
    cacApplication: [],
    cacApplicationEvent: [],
    cacPayment: [],
    cacDeliverable: [],
    walletTransaction: [],
  };
  for (const k of Object.keys(spy)) spy[k] = [];
  pushKeys.clear();
  storage.clear();
  paystackRecords = {};
  answers = {};
  featureOn = true;
}

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function respond(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
      end() {
        resolve({ status: this.statusCode, body: null });
      },
    };
    Promise.resolve(
      handler(
        {
          headers: {},
          params: {},
          query: {},
          body: {},
          originalUrl: '/api/admin/cac',
          admin: ADMIN,
          ...req,
          user: { id: req.userId || USER_ID },
        },
        res,
      ),
    ).catch(reject);
  });
}

/** A writable `res` for the streamed downloads. */
function streamRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.headers = {};
  res.statusCode = 200;
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.body = () => Buffer.concat(chunks);
  return res;
}

const appRow = id => db.cacApplication.find(r => r.id === id);
const docsOf = id => CAC.revealDocuments(appRow(id));
const balance = (uid = USER_ID) => Number(db.user.find(u => u.id === uid).balance);
const eventsOf = id => db.cacApplicationEvent.filter(e => e.application_id === id).map(e => e.event);
const ledger = (remark, uid = USER_ID) => db.walletTransaction.filter(t => t.remark === remark && t.user_id === uid);
const paymentsOf = id => db.cacPayment.filter(p => p.application_id === id);
const pushSubjects = () => spy.pushes.map(p => p.subject);
const ago = ms => new Date(Date.now() - ms);
const docState = (view, kind) => view.documents.find(d => d.kind === kind);

async function setPrice(type, price) {
  await service.updateSettings({ registration_type: type, price: String(price) });
}

/** The partner's prices, as an admin would save them. */
async function partnerPrices() {
  await setPrice('business_name', PRICE);
  await setPrice('limited_company', LTD_PRICE);
  await setPrice('incorporated_trustees', NGO_PRICE);
}

async function draft({ userId = USER_ID, form = FORM, files = FILES() } = {}) {
  return service.createDraft({ userId, body: form, files });
}

function paystackSuccess(reference, kobo = PRICE * 100) {
  paystackRecords[reference] = { status: 'success', amount: kobo, currency: 'NGN', paid_at: new Date().toISOString() };
}

/* ------------------------------------------------------------------ tests */

(async () => {
  /* ------------------------------------------------------------ 1. rules */

  assert.strictEqual(CAC.parsePrice('35000'), 35000);
  assert.strictEqual(CAC.parsePrice('150,000'), 150000);
  assert.strictEqual(CAC.parsePrice('35000.50'), null, 'whole naira only - kobo conversion must be exact');
  assert.strictEqual(CAC.parsePrice('50'), null, 'below the floor');
  assert.strictEqual(CAC.parsePrice(''), null);
  assert.strictEqual(CAC.parsePrice(null), null);

  const today = new Date('2026-10-12T12:00:00Z');
  const good = CAC.validateDetails(FORM, null, { today });
  assert.ok(good.ok, good.message);
  assert.strictEqual(good.details.registration_type, 'business_name', 'a business name unless told otherwise');
  assert.strictEqual(good.details.phone, '2348031234567', 'stored as 234xxxxxxxxxx');
  assert.strictEqual(good.details.email, 'ada@example.com');
  assert.deepStrictEqual(good.details.members, [], 'a business name has no other people');
  assert.strictEqual(good.details.share_capital, undefined);
  assert.strictEqual(good.details.nin, OWNER_NIN, 'the NIN, without the spaces it was copied with');
  assert.strictEqual(good.details.id_type, 'nin', 'the ID is the NIN slip or card');
  assert.strictEqual(
    CAC.validateDetails({ ...FORM, id_type: 'voters_card' }, null, { today }).details.id_type,
    'nin',
    "an older app's id_type is not read",
  );

  const bad = (form, field) => {
    const r = CAC.validateDetails(form, null, { today });
    assert.ok(!r.ok, `expected ${field} to be refused`);
    assert.strictEqual(r.field, field, r.message);
    return r;
  };
  bad({ ...FORM, dob: '2010-01-01' }, 'dob'); // a minor
  bad({ ...FORM, dob: '2008-10-13' }, 'dob'); // eighteen tomorrow
  bad({ ...FORM, dob: '2001-02-30' }, 'dob'); // not a date
  bad({ ...FORM, proposed_name_3: 'ada obi ventures' }, 'proposed_name_3'); // the same name twice
  bad({ ...FORM, proposed_name_2: '' }, 'proposed_name_2'); // two names are required
  // ...and a third is a spare, never a requirement.
  const twoNames = CAC.validateDetails({ ...FORM, proposed_name_3: '' }, null, { today });
  assert.ok(twoNames.ok, twoNames.message);
  assert.deepStrictEqual(twoNames.details.proposed_names, ['Ada Obi Ventures', 'Ada Obi Global Concepts']);
  bad({ ...FORM, proposed_name_1: '<b>Ada</b>' }, 'proposed_name_1');
  bad({ ...FORM, phone: '0123' }, 'phone');
  bad({ ...FORM, owner_name: 'Ada' }, 'owner_name');
  bad({ ...FORM, email: 'ada@' }, 'email');
  bad({ ...FORM, nin: '' }, 'nin'); // mandatory for every proprietor, director and trustee
  bad({ ...FORM, nin: '1234567890' }, 'nin'); // ten digits
  bad({ ...FORM, nin: '1234567890A' }, 'nin');
  bad({ ...FORM, business_address: 'Lagos' }, 'business_address');
  bad({ ...FORM, registration_type: 'cooperative' }, 'registration_type');
  assert.ok(CAC.validateDetails({ ...FORM, dob: '2008-10-12' }, null, { today }).ok, 'eighteen today is eighteen');

  // A partial update is validated as the whole merged object.
  const merged = CAC.validateDetails({ business_address: '1 New Road, Yaba, Lagos' }, good.details, { today });
  assert.ok(merged.ok);
  assert.deepStrictEqual(CAC.changedFields(good.details, merged.details), ['business_address']);

  // The phone is only ever shown four digits of a NIN, so on an edit it sends
  // the box empty. That keeps the number for the same person - and only them.
  const kept = CAC.validateDetails({ ...FORM, nin: '', residential_address: '7 Awolowo Way, Ikeja, Lagos' }, good.details, { today });
  assert.ok(kept.ok, kept.message);
  assert.strictEqual(kept.details.nin, OWNER_NIN);
  const renamed = CAC.validateDetails({ ...FORM, nin: '', owner_name: 'Bola Ade Okon' }, good.details, { today });
  assert.strictEqual(renamed.field, 'nin', "a different owner never inherits the last one's NIN");
  assert.ok(/NIN again/.test(renamed.message), renamed.message);
  const retyped = CAC.validateDetails({ ...FORM, nin: '98765432109', owner_name: 'Bola Ade Okon' }, good.details, { today });
  assert.ok(retyped.ok && retyped.details.nin === '98765432109');

  // A limited company: share capital, and shares that add up to 100%.
  const ltd = CAC.validateDetails(LTD_FORM(), null, { today });
  assert.ok(ltd.ok, ltd.message);
  assert.strictEqual(ltd.details.share_capital, 1_000_000);
  assert.strictEqual(ltd.details.owner_shares, 40);
  assert.deepStrictEqual(ltd.details.members.map(m => [m.slot, m.role, m.shares, m.phone]), [
    ['m1', 'both', 40, '2348051112222'],
    ['m2', 'shareholder', 20, '2348063334444'],
  ]);
  assert.ok(/add up to 90%/.test(bad(LTD_FORM({ owner_shares: '30' }), 'owner_shares').message));
  bad(LTD_FORM({ share_capital: '50000' }), 'share_capital'); // below CAMA's minimum
  bad(LTD_FORM({ share_capital: '5000000' }), 'share_capital'); // above the standard package
  bad(LTD_FORM({ members: JSON.stringify([{ slot: 'm1', role: 'chairman', ...PERSON('Chidi Okafor Eze', '08051112222') }]) }), 'm1.role');
  bad(LTD_FORM({ members: JSON.stringify([{ slot: 'm1', role: 'both', shares: 60, ...PERSON('Chidi', '08051112222') }]) }), 'm1.full_name');
  bad(LTD_FORM({ members: JSON.stringify([{ slot: 'm9', role: 'both', shares: 60, ...PERSON('Chidi Okafor Eze', '08051112222') }]) }), 'members');
  bad(LTD_FORM({ members: 'not json' }), 'members');
  const tooMany = ['m1', 'm2', 'm3', 'm4', 'm4'].map((slot, i) => ({ slot, role: 'director', ...PERSON(`Person Number${i}`, '08051112222') }));
  bad(LTD_FORM({ members: JSON.stringify(tooMany) }), 'members');
  // A director-only member holds no shares, whatever is sent.
  const dir = CAC.validateDetails(
    LTD_FORM({ owner_shares: '100', members: JSON.stringify([{ slot: 'm3', role: 'director', shares: 50, ...PERSON('Chidi Okafor Eze', '08051112222') }]) }),
    null,
    { today },
  );
  assert.ok(dir.ok, dir.message);
  assert.strictEqual(dir.details.members[0].shares, 0);
  // A sole director-shareholder owns it all without saying so.
  const sole = CAC.validateDetails({ ...FORM, registration_type: 'limited_company', share_capital: '100000' }, null, { today });
  assert.ok(sole.ok, sole.message);
  assert.strictEqual(sole.details.owner_shares, 100);

  // Every director has a NIN of their own.
  const ltdMembers = JSON.parse(LTD_FORM().members);
  bad(LTD_FORM({ members: JSON.stringify([{ ...ltdMembers[0], nin: '' }, ltdMembers[1]]) }), 'm1.nin');
  assert.ok(
    /same NIN/.test(bad(LTD_FORM({ members: JSON.stringify([ltdMembers[0], { ...ltdMembers[1], nin: OWNER_NIN }]) }), 'm2.nin').message),
    'two people, one NIN',
  );
  // An edit sends members without their NINs, as the app does; each keeps theirs.
  const noNins = ltdMembers.map(m => ({ ...m, nin: '' }));
  const ltdKept = CAC.validateDetails(LTD_FORM({ nin: '', members: JSON.stringify(noNins) }), ltd.details, { today });
  assert.ok(ltdKept.ok, ltdKept.message);
  assert.deepStrictEqual(ltdKept.details.members.map(m => m.nin), ltd.details.members.map(m => m.nin));
  // m2 removed and somebody new added into the freed slot: they bring their own.
  const newcomer = { slot: 'm2', role: 'shareholder', shares: 20, ...PERSON('Kemi Bello Ojo', '08099990000'), nin: '' };
  const reused = CAC.validateDetails(LTD_FORM({ nin: '', members: JSON.stringify([noNins[0], newcomer]) }), ltd.details, { today });
  assert.strictEqual(reused.field, 'm2.nin', reused.message);
  assert.ok(/NIN again/.test(reused.message), 'never the last person\'s number');

  // Incorporated trustees: two trustees at least, aims and objectives up to 500.
  const ngo = CAC.validateDetails(NGO_FORM(), null, { today });
  assert.ok(ngo.ok, ngo.message);
  assert.strictEqual(ngo.details.members.length, 1);
  assert.strictEqual(ngo.details.share_capital, undefined, 'an NGO has no shares');
  assert.ok(/at least 1 more trustee/.test(bad(NGO_FORM({ members: '[]' }), 'members').message));
  assert.ok(CAC.validateDetails(NGO_FORM({ nature_of_business: 'x'.repeat(400) }), null, { today }).ok, 'aims may run long');
  bad({ ...FORM, nature_of_business: 'x'.repeat(400) }, 'nature_of_business'); // a business name's may not

  // The documents each form calls for.
  assert.deepStrictEqual(CAC.requiredDocuments(good.details).map(d => d.kind), ['valid_id', 'passport', 'signature']);
  assert.strictEqual(CAC.requiredDocuments(ltd.details).length, 9);
  const ngoDocs = CAC.requiredDocuments(ngo.details);
  assert.deepStrictEqual(ngoDocs.map(d => d.kind), ['valid_id', 'passport', 'signature', 'm1_valid_id', 'm1_passport', 'm1_signature', 'constitution']);
  assert.strictEqual(ngoDocs[3].label, 'Trustee 2 - NIN slip or card');
  assert.strictEqual(ngoDocs[3].phrase, "Trustee 2's NIN slip or card");

  // The phone sees four digits of anybody's NIN; the admin view sees them all.
  const ninRow = { id: 1, reference: 'CAC-NINTEST1', status: 'draft', registration_type: 'limited_company', details_enc: CAC.protectDetails(ltd.details) };
  const customerView = CAC.publicApplication(ninRow, { detail: true }).details;
  assert.strictEqual(customerView.nin, undefined);
  assert.strictEqual(customerView.nin_last4, '8901');
  assert.ok(customerView.members.every(m => m.nin === undefined && /^\d{4}$/.test(m.nin_last4)), 'no member NIN either');
  assert.ok(!JSON.stringify(customerView).includes(OWNER_NIN));
  const adminView = CAC.publicApplication(ninRow, { detail: true, fullNin: true }).details;
  assert.strictEqual(adminView.nin, OWNER_NIN);
  assert.deepStrictEqual(adminView.members.map(m => m.nin), ltd.details.members.map(m => m.nin));
  assert.ok(CAC.UPLOAD_FIELDS.includes('m4_signature') && CAC.UPLOAD_FIELDS.includes('constitution'), 'multer is told about every slot');

  assert.strictEqual(CAC.sniffType(JPG), 'image/jpeg');
  assert.strictEqual(CAC.sniffType(PNG), 'image/png');
  assert.strictEqual(CAC.sniffType(PDF), 'application/pdf');
  assert.strictEqual(CAC.sniffType(WEBP), 'image/webp');
  assert.strictEqual(CAC.sniffType(SVG), null, 'an SVG is never an accepted type');
  assert.strictEqual(CAC.sniffType(Buffer.from('GIF89a......')), null);
  assert.strictEqual(CAC.cleanRegistrationNumber('business_name', 'BN 1234567'), 'BN1234567');
  assert.strictEqual(CAC.cleanRegistrationNumber('limited_company', '1234567'), 'RC1234567');
  assert.strictEqual(CAC.cleanRegistrationNumber('incorporated_trustees', 'IT-123456'), 'IT123456');
  assert.strictEqual(CAC.cleanRegistrationNumber('limited_company', 'BN 1234567'), null, 'a company number is an RC number');
  assert.strictEqual(CAC.cleanRegistrationNumber('business_name', ''), '');

  const steps = row => CAC.timeline(row).map(s => `${s.key}:${s.state}`);
  assert.deepStrictEqual(steps({ status: 'submitted' }), ['submitted:done', 'in_progress:pending', 'completed:pending']);
  assert.deepStrictEqual(steps({ status: 'in_progress', started_at: today }), ['submitted:done', 'in_progress:current', 'completed:pending']);
  assert.deepStrictEqual(
    steps({ status: 'needs_more_info', started_at: today }),
    ['submitted:done', 'in_progress:done', 'needs_more_info:current', 'completed:pending'],
  );
  assert.deepStrictEqual(steps({ status: 'rejected', refunded_at: today }), ['submitted:done', 'in_progress:pending', 'rejected:failed']);
  assert.deepStrictEqual(steps({ status: 'completed', started_at: today }), ['submitted:done', 'in_progress:done', 'completed:done']);

  /* --------------------------------------------- 2. the admin's prices */

  reset();
  let s = await service.getSettings();
  assert.deepStrictEqual(s.types.map(t => [t.code, t.price, t.available]), [
    ['business_name', null, false],
    ['limited_company', null, false],
    ['incorporated_trustees', null, false],
  ], 'no price anywhere in the code');
  assert.strictEqual(s.available, false);
  assert.strictEqual((await rejects(draft())).remark, 'price_unavailable', 'no price, no sale');
  assert.strictEqual(spy.uploads.length, 0, 'refused before a single file went up');

  process.env.CAC_PRICE_BUSINESS_NAME = '20000';
  assert.strictEqual((await service.getSettings()).types[0].price, 20000, 'env bridges a deployment that has not set one');
  delete process.env.CAC_PRICE_BUSINESS_NAME;

  assert.strictEqual((await rejects(service.updateSettings({ price: '35000' }))).statusCode, 400, 'a price is always for a type');
  assert.strictEqual((await rejects(setPrice('cooperative', 1000))).statusCode, 400);
  assert.strictEqual((await rejects(setPrice('business_name', '35000.5'))).statusCode, 400);
  assert.strictEqual((await rejects(service.updateSettings({ registration_type: 'business_name', processing_time: 'x' }))).statusCode, 400);

  await partnerPrices();
  await service.updateSettings({ registration_type: 'incorporated_trustees', processing_time: '4-6 weeks' });
  s = await service.getSettings();
  assert.deepStrictEqual(s.types.map(t => [t.code, t.price, t.available]), [
    ['business_name', 35000, true],
    ['limited_company', 55000, true],
    ['incorporated_trustees', 150000, true],
  ]);
  assert.strictEqual(s.types[2].processing_time, '4-6 weeks', 'each type quotes its own turnaround');
  assert.strictEqual(s.types[0].processing_time, '5-10 working days');
  assert.strictEqual(db.appSetting.find(r => r.setting_key === 'cac_price_limited_company').setting_value, '55000');

  // One type paused, the rest still on sale.
  await service.updateSettings({ registration_type: 'limited_company', enabled: false });
  assert.strictEqual((await rejects(draft({ form: LTD_FORM(), files: { ...FILES(), ...MEMBER_FILES('m1'), ...MEMBER_FILES('m2') } }))).remark, 'type_unavailable');
  assert.strictEqual((await service.getSettings()).available, true);
  await service.updateSettings({ registration_type: 'limited_company', enabled: true });
  // The whole service off.
  await service.updateSettings({ enabled: false });
  assert.strictEqual((await rejects(draft())).remark, 'feature_disabled');
  await service.updateSettings({ enabled: true });

  /* --------------------------------------------- 3. a draft is never work */

  const missing = await rejects(draft({ files: FILES({ signature: undefined }) }));
  assert.strictEqual(missing.remark, 'validation_error');
  assert.strictEqual(missing.data.field, 'signature');
  assert.strictEqual(missing.message, 'Attach the signature specimen');
  const svg = await rejects(draft({ files: FILES({ passport: file(SVG, 'image/jpeg', 'face.jpg') }) }));
  assert.strictEqual(svg.data.field, 'passport', 'judged by its bytes, not by the type the phone claimed');
  const pdfPassport = await rejects(draft({ files: FILES({ passport: file(PDF, 'application/pdf', 'p.pdf') }) }));
  assert.strictEqual(pdfPassport.message, 'The passport photograph must be a JPG or PNG photo');
  assert.strictEqual(spy.uploads.length, 0, 'every file is checked before any is uploaded');

  answers.uploadFail = true;
  assert.strictEqual((await rejects(draft())).remark, 'upload_failed');
  assert.strictEqual(db.cacApplication.length, 0, 'a storage failure leaves no row pointing at nothing');
  answers.uploadFail = false;

  const d1 = await draft();
  assert.strictEqual(d1.status, 'draft');
  assert.strictEqual(d1.payment_status, 'unpaid');
  assert.strictEqual(d1.registration_type, 'business_name');
  assert.ok(/^CAC-[A-HJ-NP-Z2-9]{8}$/.test(d1.reference), d1.reference);
  assert.strictEqual(d1.details.phone, '2348031234567');
  assert.strictEqual(docState(d1, 'valid_id').mime_type, 'application/pdf');
  assert.strictEqual(docState(d1, 'passport').mime_type, 'image/jpeg');
  assert.ok(d1.documents.every(d => d.uploaded && !('url' in d)), 'states only - never a link');
  assert.strictEqual(d1.timeline.length, 0, 'nothing to track before it is paid');
  assert.strictEqual(d1.quote.price, PRICE, 'the draft carries its type\'s live price for the review screen');
  assert.ok(spy.uploads.every(u => /^(valid_id|passport|signature)\.(pdf|jpg|png)$/.test(u.name)), 'our file names, never the phone\'s');

  const raw1 = appRow(d1.id);
  assert.ok(raw1.details_enc.startsWith('enc:v1:'));
  assert.ok(raw1.documents_enc.startsWith('enc:v1:'), 'the document links are bearer tokens - stored encrypted');
  assert.strictEqual(raw1.registration_type, 'business_name');

  // Invisible to the queue, and unprocessable.
  assert.strictEqual((await service.adminList({})).items.length, 0);
  assert.strictEqual((await rejects(service.adminTransition({ id: d1.id, action: 'start', admin: ADMIN }))).statusCode, 404);
  assert.strictEqual((await rejects(service.adminDetail(d1.id))).statusCode, 404);
  assert.strictEqual((await service.listForUser(USER_ID)).applications.length, 0, 'not in My Applications either');
  const home1 = await service.home(USER_ID);
  assert.strictEqual(home1.draft.id, d1.id, 'the home offers to resume it');
  assert.strictEqual(home1.service.types.find(t => t.code === 'business_name').price, PRICE);

  // One draft per customer, updated in place - its files replaced, not orphaned.
  const oldUrls = spy.uploads.map(u => u.url);
  const d1b = await draft({ form: { ...FORM, proposed_name_1: 'Ada Obi Couture' } });
  assert.strictEqual(d1b.id, d1.id, 'the same draft');
  assert.strictEqual(d1b.reference, d1.reference);
  assert.strictEqual(db.cacApplication.length, 1);
  assert.deepStrictEqual([...spy.deleted].sort(), [...oldUrls].sort(), 'the replaced files are deleted');
  assert.strictEqual(d1b.business_name, 'Ada Obi Couture');

  // Another customer cannot read it.
  assert.strictEqual((await rejects(service.detailForUser(OTHER_USER, d1.id))).statusCode, 404);

  /* -------------------------------------------------------- 4. wallet */

  assert.strictEqual((await rejects(service.payWithWallet({ userId: USER_ID, id: d1.id, pin: '9999', expectedAmount: PRICE }))).remark, 'invalid_pin');
  const changed = await rejects(service.payWithWallet({ userId: USER_ID, id: d1.id, pin: '1234', expectedAmount: 22500 }));
  assert.strictEqual(changed.remark, 'price_changed', 'the customer approved a different amount');
  assert.strictEqual(changed.data.price, PRICE);
  assert.strictEqual(balance(), START_BALANCE, 'nothing charged');

  // A short wallet: all or nothing.
  db.user.find(u => u.id === USER_ID).balance = 10_000;
  const short = await rejects(service.payWithWallet({ userId: USER_ID, id: d1.id, pin: '1234', expectedAmount: PRICE }));
  assert.strictEqual(short.remark, 'insufficient_balance');
  assert.strictEqual(appRow(d1.id).status, 'draft', 'the claim was rolled back with the debit');
  assert.strictEqual(appRow(d1.id).payment_status, 'unpaid');
  assert.strictEqual(balance(), 10_000);
  assert.strictEqual(ledger('cac_registration').length, 0);
  db.user.find(u => u.id === USER_ID).balance = START_BALANCE;

  const paid1 = await service.payWithWallet({ userId: USER_ID, id: d1.id, pin: '1234', expectedAmount: PRICE });
  assert.strictEqual(paid1.alreadyPaid, false);
  let a1 = appRow(d1.id);
  assert.strictEqual(a1.status, 'submitted');
  assert.strictEqual(a1.payment_status, 'paid');
  assert.strictEqual(a1.payment_method, 'wallet');
  assert.strictEqual(a1.amount_paid, PRICE);
  assert.ok(a1.paid_at && a1.submitted_at);
  assert.strictEqual(balance(), START_BALANCE - PRICE, 'debited exactly once');
  assert.ok(db.user.find(u => u.id === USER_ID).balance_mac, 'the balance MAC was re-stamped');
  const debit = ledger('cac_registration');
  assert.strictEqual(debit.length, 1);
  assert.strictEqual(debit[0].trx_type, '-');
  assert.strictEqual(debit[0].amount, PRICE);
  assert.deepStrictEqual(Object.keys(debit[0].meta).sort(), ['application_id', 'reference', 'registration_type', 'source']);
  assert.strictEqual(paymentsOf(d1.id).length, 1);
  assert.strictEqual(paymentsOf(d1.id)[0].status, 'success');
  assert.deepStrictEqual(eventsOf(d1.id), ['created', 'draft_updated', 'paid']);
  const paidPush = spy.pushes.find(p => p.subject === 'CAC application submitted');
  assert.ok(paidPush, 'payment success is notified');
  assert.strictEqual(paidPush.pushData.type, 'cac', 'the tap routes to CAC');
  assert.strictEqual(paidPush.data.application_id, d1.id);
  assert.ok(/business name application/.test(paidPush.message), paidPush.message);

  // Paying twice charges once.
  const again = await service.payWithWallet({ userId: USER_ID, id: d1.id, pin: '1234', expectedAmount: PRICE });
  assert.strictEqual(again.alreadyPaid, true);
  assert.strictEqual(balance(), START_BALANCE - PRICE);

  // A later price change never touches what was paid.
  await setPrice('business_name', 40000);
  assert.strictEqual(appRow(d1.id).amount_paid, PRICE);
  await setPrice('business_name', PRICE);

  // Now it is the customer's application and the admin's work.
  const mine = await service.listForUser(USER_ID);
  assert.deepStrictEqual(mine.applications.map(a => a.status), ['submitted']);
  const queue = await service.adminList({ status: 'submitted' });
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(queue.counts.submitted, 1);
  assert.strictEqual(queue.items[0].owner_name, 'Ada Obi Nwosu');
  assert.strictEqual(queue.items[0].registration_type, 'business_name');
  assert.strictEqual(queue.stats.collected, PRICE);

  /* ------------------------------------------------------ 5. Paystack */

  // A new draft for a second business, paid by card.
  const d2 = await draft({ form: { ...FORM, proposed_name_1: 'Nwosu Logistics', proposed_name_2: 'Nwosu Movers', proposed_name_3: 'NW Express' } });
  assert.notStrictEqual(d2.id, d1.id, 'a paid application is not a draft to update');
  const c1 = await service.initializePaystack({ userId: USER_ID, id: d2.id, expectedAmount: PRICE });
  assert.ok(c1.reference.startsWith(`CACPAY-${d2.id}-`));
  assert.strictEqual(spy.init[0].amountKobo, PRICE * 100, 'kobo, exactly');
  assert.strictEqual(spy.init[0].email, 'ada@voltpay.ng', 'billed to the profile email');
  assert.strictEqual(spy.init[0].callback_url, 'https://api.voltpay.test/api/cac/paystack/callback');
  assert.strictEqual(spy.init[0].metadata.purpose, 'cac_registration');
  const c2 = await service.initializePaystack({ userId: USER_ID, id: d2.id, expectedAmount: PRICE });
  assert.strictEqual(c2.reference, c1.reference, 'a second tap gets the same checkout');
  assert.strictEqual(spy.init.length, 1);

  // Not paid yet: nothing changes, whatever the app says.
  paystackRecords[c1.reference] = { status: 'abandoned', amount: PRICE * 100, currency: 'NGN' };
  let v = await service.verifyPaystack({ userId: USER_ID, id: d2.id, reference: c1.reference });
  assert.strictEqual(v.result.paid, false);
  assert.strictEqual(v.result.state, 'abandoned');
  assert.strictEqual(appRow(d2.id).status, 'draft');
  assert.strictEqual((await rejects(service.verifyPaystack({ userId: OTHER_USER, id: d2.id, reference: c1.reference }))).statusCode, 404);

  // Paystack down: an outage is never read as "not paid" and changes nothing.
  paystackRecords[c1.reference] = Object.assign(new Error('Paystack request timed out'), { statusCode: 504 });
  assert.strictEqual((await rejects(service.verifyPaystack({ userId: USER_ID, id: d2.id, reference: c1.reference }))).remark, 'verify_unavailable');
  assert.strictEqual(appRow(d2.id).payment_status, 'unpaid');

  // Paid. Verify and webhook race; one wins, nothing happens twice.
  paystackSuccess(c1.reference);
  const [r1, r2] = await Promise.all([
    service.verifyPaystack({ userId: USER_ID, id: d2.id, reference: c1.reference }),
    service.settlePaystack(c1.reference, { source: 'webhook' }),
  ]);
  assert.ok(r1.result.paid && r2.paid);
  const a2 = appRow(d2.id);
  assert.strictEqual(a2.status, 'submitted');
  assert.strictEqual(a2.payment_method, 'paystack');
  assert.strictEqual(a2.payment_reference, c1.reference);
  assert.strictEqual(eventsOf(d2.id).filter(e => e === 'paid').length, 1, 'paid once');
  assert.strictEqual(balance(), START_BALANCE - PRICE, 'a card payment never touches the wallet');
  assert.strictEqual((await service.settlePaystack(c1.reference, { source: 'webhook' })).paid, true, 'a redelivery is a no-op');
  assert.strictEqual(eventsOf(d2.id).filter(e => e === 'paid').length, 1);

  // The double payment: checkout opened, wallet paid, old checkout finished.
  const d3 = await draft({ form: { ...FORM, proposed_name_1: 'Obi Farms', proposed_name_2: 'Obi Agro', proposed_name_3: 'Obi Harvest' } });
  const c3 = await service.initializePaystack({ userId: USER_ID, id: d3.id, expectedAmount: PRICE });
  paystackRecords[c3.reference] = { status: 'abandoned', amount: PRICE * 100, currency: 'NGN' };
  await service.payWithWallet({ userId: USER_ID, id: d3.id, pin: '1234', expectedAmount: PRICE });
  assert.strictEqual(balance(), START_BALANCE - 2 * PRICE);
  paystackSuccess(c3.reference);
  const dup = await service.settlePaystack(c3.reference, { source: 'webhook' });
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(balance(), START_BALANCE - PRICE, 'the second payment came straight back');
  const back = ledger('cac_refund');
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].trx_type, '+');
  assert.strictEqual(back[0].meta.reason, 'duplicate');
  assert.strictEqual(db.cacPayment.find(p => p.reference === c3.reference).status, 'refunded_to_wallet');
  assert.strictEqual(appRow(d3.id).payment_method, 'wallet', 'still paid once, the first way');
  assert.ok(eventsOf(d3.id).includes('duplicate_payment_refunded'));
  assert.ok(pushSubjects().includes('Payment returned to your wallet'));
  await service.settlePaystack(c3.reference, { source: 'sweep' });
  assert.strictEqual(ledger('cac_refund').length, 1, 'handed back once');

  // ...and the ordinary case never gets that far: the wallet asks Paystack first.
  const d4 = await draft({ form: { ...FORM, proposed_name_1: 'Ada Bakes', proposed_name_2: 'Ada Pastries', proposed_name_3: 'Ada Oven' } });
  const c4 = await service.initializePaystack({ userId: USER_ID, id: d4.id, expectedAmount: PRICE });
  paystackSuccess(c4.reference);
  const balBefore = balance();
  const pre = await service.payWithWallet({ userId: USER_ID, id: d4.id, pin: '1234', expectedAmount: PRICE });
  assert.strictEqual(pre.alreadyPaid, true, 'the open checkout was already paid');
  assert.strictEqual(balance(), balBefore, 'and the wallet was not charged');
  assert.strictEqual(appRow(d4.id).payment_method, 'paystack');

  // A checkout that could not be opened is failed, not left pending.
  const d5 = await draft({ form: { ...FORM, proposed_name_1: 'Ada Prints', proposed_name_2: 'Ada Press', proposed_name_3: 'Ada Ink' } });
  answers.init = Object.assign(new Error('Paystack request timed out'), { statusCode: 504 });
  assert.strictEqual((await rejects(service.initializePaystack({ userId: USER_ID, id: d5.id, expectedAmount: PRICE }))).remark, 'paystack_unavailable');
  assert.strictEqual(paymentsOf(d5.id)[0].status, 'failed');
  answers.init = null;

  // Short money (Paystack fixes the amount, but if it ever lands short): back it goes.
  const c5 = await service.initializePaystack({ userId: USER_ID, id: d5.id, expectedAmount: PRICE });
  paystackSuccess(c5.reference, 1_000_000);
  const shortPaid = await service.settlePaystack(c5.reference, { source: 'webhook' });
  assert.strictEqual(shortPaid.state, 'amount_mismatch');
  assert.strictEqual(appRow(d5.id).payment_status, 'unpaid', 'a short payment buys nothing');
  assert.strictEqual(ledger('cac_refund').filter(t => t.meta.reason === 'short_payment')[0].amount, 10_000, 'what did arrive is returned');

  /* ---------------------------------------------------- 6. processing */

  const id1 = d1.id;
  const upload = (over = {}) =>
    service.adminUploadDeliverable({ id: id1, file: { buffer: PDF }, kind: 'certificate', admin: ADMIN, ...over });
  assert.strictEqual((await rejects(service.adminTransition({ id: id1, action: 'complete', admin: ADMIN }))).remark, 'invalid_transition');
  assert.strictEqual((await rejects(upload())).remark, 'invalid_transition', 'no documents before somebody has started');

  await service.adminTransition({ id: id1, action: 'start', admin: ADMIN });
  a1 = appRow(id1);
  assert.strictEqual(a1.status, 'in_progress');
  assert.ok(a1.started_at);
  assert.ok(pushSubjects().includes('Your CAC application is in progress'));
  assert.strictEqual(db.cacApplicationEvent.filter(e => e.event === 'started')[0].actor, 'admin:ops-ada');
  assert.strictEqual((await rejects(service.adminTransition({ id: id1, action: 'start', admin: ADMIN }))).remark, 'invalid_transition', 'two admins, one start');

  assert.strictEqual((await rejects(service.adminTransition({ id: id1, action: 'complete', admin: ADMIN }))).remark, 'certificate_required');
  assert.strictEqual((await rejects(service.adminTransition({ id: id1, action: 'request_info', note: 'blurry', admin: ADMIN }))).statusCode, 400, 'a request must say what is needed');

  await service.adminTransition({
    id: id1,
    action: 'request_info',
    note: 'Your passport photograph is too dark - please upload a clearer one',
    admin: ADMIN,
  });
  let view = await service.detailForUser(USER_ID, id1);
  assert.strictEqual(view.status, 'needs_more_info');
  assert.strictEqual(view.can_edit, true);
  assert.strictEqual(view.admin_note, 'Your passport photograph is too dark - please upload a clearer one');
  assert.deepStrictEqual(view.timeline.map(t => t.key), ['submitted', 'in_progress', 'needs_more_info', 'completed']);
  assert.ok(view.history.find(h => h.event === 'info_requested').note, 'the request is shown to the customer');
  const needsPush = spy.pushes.find(p => p.subject === 'More information needed for your CAC application');
  assert.ok(needsPush.message.startsWith('Your passport photograph is too dark - please upload a clearer one. Open application'));

  // Sent back unchanged: refused, so it is not asked the same question again.
  assert.strictEqual((await rejects(service.updateApplication({ userId: USER_ID, id: id1, body: {}, files: {} }))).remark, 'nothing_changed');
  // Somebody else's application: not found.
  assert.strictEqual((await rejects(service.updateApplication({ userId: OTHER_USER, id: id1, body: {}, files: FILES() }))).statusCode, 404);
  // Bought as a business name, it stays one.
  assert.strictEqual(
    (await rejects(service.updateApplication({ userId: USER_ID, id: id1, body: { registration_type: 'limited_company' }, files: {} }))).remark,
    'type_locked',
  );

  const passportBefore = docsOf(id1).passport.url;
  view = await service.updateApplication({ userId: USER_ID, id: id1, body: {}, files: { passport: file(WEBP, 'image/webp', 'new.webp') } });
  a1 = appRow(id1);
  assert.strictEqual(view.status, 'submitted', 'back in the queue for an admin\'s eyes');
  assert.strictEqual(a1.resubmissions, 1);
  assert.strictEqual(a1.admin_note_enc, null, 'the request is cleared once answered');
  assert.strictEqual(docsOf(id1).passport.mime, 'image/webp');
  assert.ok(docsOf(id1).valid_id.url, 'the documents not replaced are kept');
  assert.ok(spy.deleted.includes(passportBefore), 'the replaced photograph is deleted');
  const provided = db.cacApplicationEvent.find(e => e.event === 'info_provided');
  assert.deepStrictEqual(provided.meta, { fields: [], documents: ['passport'] }, 'names of what changed, never values');
  assert.strictEqual(provided.actor, 'user');
  assert.ok((await service.adminList({ status: 'submitted' })).items.find(i => i.id === id1).resubmitted);

  // A submitted application cannot be edited.
  assert.strictEqual((await rejects(service.updateApplication({ userId: USER_ID, id: id1, body: { phone: '08099999999' }, files: {} }))).remark, 'not_editable');

  await service.adminTransition({ id: id1, action: 'start', admin: ADMIN });
  // What CAC issued, handed over one file at a time. Refused when it is not a
  // file we take, not a kind this type issues, or an "other" with no name.
  assert.strictEqual((await rejects(upload({ file: { buffer: SVG } }))).statusCode, 400);
  const wrongNumber = await rejects(upload({ registrationNumber: 'RC-12' }));
  assert.ok(/BN 1234567/.test(wrongNumber.message), 'a business name takes a BN number');
  assert.strictEqual((await rejects(upload({ kind: 'memart' }))).statusCode, 400, 'a business name has no MEMART');
  assert.strictEqual((await rejects(upload({ kind: 'other' }))).statusCode, 400, 'an "other" document needs a name');

  // The certificate, and two more beside it.
  await upload({ registeredName: 'Ada Obi Couture', registrationNumber: 'BN 3456789' });
  await upload({ kind: 'status_report', file: { buffer: JPG } });
  await upload({ kind: 'other', label: 'Letter of acknowledgement', file: { buffer: PNG } });
  const issuedTo = id => db.cacDeliverable.filter(d => d.application_id === id);
  let issued = issuedTo(id1);
  assert.deepStrictEqual(issued.map(d => d.kind), ['certificate', 'status_report', 'other']);
  assert.deepStrictEqual(issued.map(d => d.mime), ['application/pdf', 'image/jpeg', 'image/png'], 'judged by their bytes');
  assert.ok(issued.every(d => d.url_enc.startsWith('enc:v1:')), 'the links are encrypted');
  assert.ok(issued[2].label_enc.startsWith('enc:v1:'), 'and so is what the admin called one');
  assert.ok(issued.every(d => d.uploaded_by === 'admin:ops-ada'));
  a1 = appRow(id1);
  assert.ok(a1.registration_number_enc.startsWith('enc:v1:') && a1.registered_name_enc.startsWith('enc:v1:'));
  assert.strictEqual(eventsOf(id1).filter(e => e === 'deliverable_uploaded').length, 3);

  // A second certificate replaces the first - there is only ever one - and a
  // replacement that does not restate the number keeps it.
  const firstCertUrl = CAC.safeText(issued[0].url_enc);
  await upload({});
  issued = issuedTo(id1);
  assert.strictEqual(issued.filter(d => d.kind === 'certificate').length, 1, 'replaced, not added');
  assert.ok(spy.deleted.includes(firstCertUrl), 'the replaced file is deleted');
  assert.strictEqual(CAC.safeText(appRow(id1).registration_number_enc), 'BN3456789');

  // A wrong file goes: its row, its bytes, and a record that it went.
  const wrongDoc = issued.find(d => d.kind === 'other');
  await service.adminDeleteDeliverable({ id: id1, docId: wrongDoc.id, admin: ADMIN });
  assert.ok(!issuedTo(id1).some(d => d.id === wrongDoc.id));
  assert.ok(spy.deleted.includes(CAC.safeText(wrongDoc.url_enc)));
  assert.ok(eventsOf(id1).includes('deliverable_removed'));
  assert.strictEqual(
    (await rejects(service.adminDeleteDeliverable({ id: d3.id, docId: issued[0].id, admin: ADMIN }))).statusCode,
    404,
    "one application's document is never reachable through another",
  );

  // Without a certificate there is nothing to complete with.
  await service.adminDeleteDeliverable({ id: id1, docId: issuedTo(id1).find(d => d.kind === 'certificate').id, admin: ADMIN });
  assert.strictEqual((await rejects(service.adminTransition({ id: id1, action: 'complete', admin: ADMIN }))).remark, 'certificate_required');
  await upload({});

  // Nothing is handed out while the work is in hand.
  view = await service.detailForUser(USER_ID, id1);
  assert.deepStrictEqual(view.deliverables, [], 'not before completion');
  assert.strictEqual(view.registration_number, null, 'not shown before completion');
  assert.strictEqual(view.details.nin, undefined, 'the phone never gets the whole NIN back');
  assert.strictEqual(view.details.nin_last4, '8901');
  const early = await respond(controller.deliverable, { params: { id: String(id1), docId: String(issuedTo(id1)[0].id) } });
  assert.strictEqual(early.status, 403);
  assert.strictEqual(early.body.remark, 'documents_unavailable');

  await service.adminTransition({ id: id1, action: 'complete', admin: ADMIN });
  view = await service.detailForUser(USER_ID, id1);
  assert.strictEqual(view.status, 'completed');
  assert.deepStrictEqual(view.deliverables.map(d => d.kind), ['certificate', 'status_report'], 'certificate first');
  const [cert, report] = view.deliverables;
  assert.strictEqual(cert.label, 'Certificate of Registration of Business Name');
  assert.strictEqual(cert.file_name, `${view.reference}-Certificate.pdf`);
  assert.strictEqual(report.label, 'Status report');
  assert.strictEqual(report.file_name, `${view.reference}-Status-report.jpg`);
  assert.ok(!JSON.stringify(view).includes('ufs.sh'), 'no storage link reaches the phone');
  assert.strictEqual(view.registration_number, 'BN3456789');
  assert.strictEqual(view.registered_name, 'Ada Obi Couture');
  const donePush = spy.pushes.find(p => p.subject === 'Your CAC documents are ready');
  assert.ok(/certificate and 1 more document/.test(donePush.message), donePush.message);
  assert.strictEqual(spy.emails.length, 1, 'completion is also emailed');
  assert.strictEqual(spy.emails[0].to, 'ada@voltpay.ng');
  assert.strictEqual(spy.emails[0].registrationNumber, 'BN3456789');
  assert.strictEqual(spy.emails[0].typeLabel, 'Business Name (Enterprise)');
  assert.deepStrictEqual(spy.emails[0].documents, ['Certificate of Registration of Business Name', 'Status report']);

  // Completed: the certificate can be replaced but never removed...
  assert.strictEqual(
    (await rejects(service.adminDeleteDeliverable({ id: id1, docId: cert.id, admin: ADMIN }))).remark,
    'certificate_locked',
  );
  // ...and a document that comes later is added, and the customer told.
  const tinUp = await respond(adminController.uploadDeliverable, {
    params: { id: String(id1) },
    body: { kind: 'tin' },
    file: { buffer: PDF, mimetype: 'application/pdf', originalname: 'Ada TIN.pdf' },
  });
  assert.strictEqual(tinUp.status, 200, JSON.stringify(tinUp.body));
  assert.strictEqual(tinUp.body.message[0], 'Document uploaded');
  assert.deepStrictEqual(tinUp.body.data.application.deliverables.map(d => d.kind), ['certificate', 'status_report', 'tin']);
  assert.ok(pushSubjects().includes('New document for your CAC registration'));
  view = await service.detailForUser(USER_ID, id1);
  assert.deepStrictEqual(view.deliverables.map(d => d.kind), ['certificate', 'status_report', 'tin']);

  // The download streams the bytes - the storage link never leaves the server.
  const realFetch = global.fetch;
  global.fetch = async url => {
    const stored = storage.get(url);
    return stored ? new Response(stored.buffer, { status: 200 }) : new Response('nope', { status: 404 });
  };
  const out = streamRes();
  await service.deliverableForUser(out, USER_ID, id1, cert.id);
  assert.strictEqual(out.headers['content-type'], 'application/pdf');
  assert.strictEqual(out.headers['content-disposition'], `attachment; filename="${view.reference}-Certificate.pdf"`);
  assert.strictEqual(out.headers['x-content-type-options'], 'nosniff');
  assert.ok(out.body().equals(PDF), 'the certificate bytes, as stored');
  const reportOut = streamRes();
  await service.deliverableForUser(reportOut, USER_ID, id1, report.id);
  assert.ok(reportOut.body().equals(JPG), 'every document, not only the certificate');
  assert.strictEqual((await rejects(service.deliverableForUser(streamRes(), OTHER_USER, id1, cert.id))).statusCode, 404, 'owner only');
  assert.strictEqual((await rejects(service.deliverableForUser(streamRes(), USER_ID, id1, 99999))).statusCode, 404);

  // The admin's view of a document streams too, and is logged without a value in it.
  const docOut = streamRes();
  const viewed = await adminController.viewDocument(
    { params: { id: String(id1), kind: 'passport' }, headers: {}, admin: ADMIN, originalUrl: '/api/admin/cac/applications/1/documents/passport' },
    docOut,
  );
  assert.strictEqual(viewed, undefined);
  assert.strictEqual(docOut.headers['content-type'], 'image/webp');
  assert.ok(docOut.body().equals(WEBP));
  assert.strictEqual(spy.adminLogs.at(-1).action, 'admin.cac_document_viewed');
  assert.deepStrictEqual(spy.adminLogs.at(-1).metadata, { admin_id: 3, kind: 'passport' });
  const unknownKind = await respond(adminController.viewDocument, { params: { id: String(id1), kind: 'm3_passport' } });
  assert.strictEqual(unknownKind.status, 404, 'a slot this application does not use');
  const certAsDocument = await respond(adminController.viewDocument, { params: { id: String(id1), kind: 'certificate' } });
  assert.strictEqual(certAsDocument.status, 404, 'issued documents have their own endpoint');
  const issuedOut = streamRes();
  await adminController.viewDeliverable(
    {
      params: { id: String(id1), docId: String(report.id) },
      headers: {},
      admin: ADMIN,
      originalUrl: `/api/admin/cac/applications/${id1}/deliverables/${report.id}`,
    },
    issuedOut,
  );
  assert.ok(issuedOut.body().equals(JPG));
  assert.strictEqual(issuedOut.headers['content-disposition'], `inline; filename="${view.reference}-Status-report.jpg"`);
  assert.strictEqual(spy.adminLogs.at(-1).action, 'admin.cac_deliverable_viewed');
  assert.deepStrictEqual(spy.adminLogs.at(-1).metadata, { admin_id: 3, deliverable_id: report.id, kind: 'status_report' });
  global.fetch = realFetch;

  const detail = await respond(adminController.getApplication, { params: { id: String(id1) } });
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(
    detail.body.data.application.documents.find(d => d.kind === 'passport').path,
    `cac/applications/${id1}/documents/passport`,
  );
  const adminDocs = detail.body.data.application.deliverables;
  assert.deepStrictEqual(adminDocs.map(d => d.kind), ['certificate', 'status_report', 'tin']);
  assert.strictEqual(adminDocs[0].path, `cac/applications/${id1}/deliverables/${cert.id}`);
  assert.strictEqual(adminDocs[0].removable, false, 'a completed application keeps its certificate');
  assert.strictEqual(adminDocs[1].removable, true);
  assert.strictEqual(adminDocs[0].uploaded_by, 'admin:ops-ada');
  assert.strictEqual(detail.body.data.application.details.nin, OWNER_NIN, 'the admin, who files it with CAC, reads it whole');
  assert.strictEqual(detail.body.data.actions.upload_documents, true, 'still open after completion');
  assert.ok(!JSON.stringify(detail.body.data).includes('ufs.sh'), 'no storage link reaches the dashboard');
  assert.strictEqual(spy.adminLogs.at(-1).action, 'admin.cac_application_viewed');
  assert.ok(!JSON.stringify(spy.adminLogs).includes('Ada Obi'), 'a disclosure is never written into its own record');
  assert.ok(!JSON.stringify(spy.adminLogs).includes(OWNER_NIN));
  assert.strictEqual(detail.body.data.actions.refund, false);

  // At most MAX_DELIVERABLES on one application - except that a certificate
  // is a swap, so it still goes up on a full one.
  for (let i = issuedTo(id1).length; i < CAC.MAX_DELIVERABLES; i += 1) {
    await upload({ kind: 'other', label: `Extra page ${i}`, file: { buffer: PNG } });
  }
  assert.strictEqual((await rejects(upload({ kind: 'other', label: 'One too many', file: { buffer: PNG } }))).remark, 'too_many_documents');
  await upload({});
  assert.strictEqual(issuedTo(id1).length, CAC.MAX_DELIVERABLES);
  assert.ok(pushSubjects().includes('Your CAC certificate was updated'));

  /* ------------------------------------------------- 7. reject + refund */

  const id3 = d3.id; // paid by wallet, its duplicate already handed back
  const forbidden = await respond(adminController.reject, {
    params: { id: String(id3) },
    body: { note: 'The proposed names are all taken', refund: true },
    admin: ADMIN,
  });
  assert.strictEqual(forbidden.status, 403, 'support may reject, but not refund');
  assert.strictEqual(appRow(id3).status, 'submitted', 'and nothing happened');

  const beforeRefund = balance();
  const rejected = await respond(adminController.reject, {
    params: { id: String(id3) },
    body: { note: 'The proposed names are all taken', refund: true },
    admin: FINANCE,
  });
  assert.strictEqual(rejected.status, 200, JSON.stringify(rejected.body));
  const a3 = appRow(id3);
  assert.strictEqual(a3.status, 'rejected');
  assert.strictEqual(a3.payment_status, 'refunded');
  assert.ok(a3.refunded_at && a3.refund_trx);
  assert.strictEqual(balance(), beforeRefund + PRICE, 'the price, back to the wallet');
  const refundRow = db.walletTransaction.find(t => t.trx === a3.refund_trx);
  assert.strictEqual(refundRow.trx_type, '+');
  assert.strictEqual(refundRow.meta.reversal_of, a3.payment_reference, 'reads as the reversal of the debit');
  assert.ok(eventsOf(id3).includes('rejected') && eventsOf(id3).includes('refunded'));
  const rejectPush = spy.pushes.find(p => p.subject === 'Your CAC application was not successful');
  assert.ok(/The proposed names are all taken\. ₦35,000 has been refunded/.test(rejectPush.message), rejectPush.message);
  view = await service.detailForUser(USER_ID, id3);
  assert.strictEqual(view.admin_note, 'The proposed names are all taken');
  assert.strictEqual(view.refunded, true);
  assert.strictEqual(view.timeline.at(-1).state, 'failed');

  assert.strictEqual((await rejects(service.adminRefund({ id: id3, admin: FINANCE }))).remark, 'already_refunded');
  assert.strictEqual(balance(), beforeRefund + PRICE, 'refunded once');

  // Rejected without a refund, refunded later by finance.
  await service.adminTransition({ id: d4.id, action: 'reject', note: 'Owner ID does not match the applicant', admin: ADMIN });
  assert.strictEqual(appRow(d4.id).payment_status, 'paid');
  const preLater = balance();
  await service.adminRefund({ id: d4.id, admin: FINANCE });
  assert.strictEqual(balance(), preLater + PRICE);
  assert.ok(pushSubjects().includes('CAC registration refunded'));
  assert.strictEqual((await rejects(service.adminTransition({ id: d4.id, action: 'start', admin: ADMIN }))).remark, 'unpaid', 'a refunded application is not work');

  /* ------------------------------------------ 8. companies and NGOs */

  // d5 is still a business name draft. Switching it to a limited company asks
  // for every director's and shareholder's documents.
  const ltdFiles = { ...FILES(), ...MEMBER_FILES('m1'), ...MEMBER_FILES('m2') };
  const noM2 = { ...FILES(), ...MEMBER_FILES('m1') };
  const missingM2 = await rejects(draft({ form: LTD_FORM(), files: noM2 }));
  assert.strictEqual(missingM2.message, "Attach Director / shareholder 3's NIN slip or card");
  assert.strictEqual(missingM2.data.field, 'm2_valid_id');

  const ltdDraft = await draft({ form: LTD_FORM(), files: ltdFiles });
  assert.strictEqual(ltdDraft.id, d5.id, 'the one draft, now a company');
  assert.strictEqual(ltdDraft.registration_type, 'limited_company');
  assert.strictEqual(ltdDraft.quote.price, LTD_PRICE, 'quoted at the company price');
  assert.strictEqual(ltdDraft.type.members.max, 4);
  assert.strictEqual(ltdDraft.details.members.length, 2);
  assert.strictEqual(ltdDraft.details.members[0].role_label, 'Director and shareholder');
  assert.strictEqual(ltdDraft.documents.length, 9);
  assert.ok(ltdDraft.documents.every(d => d.uploaded));
  assert.ok(spy.uploads.some(u => u.name === 'm2_passport.jpg'), 'member files under our names too');

  // The old business-name price no longer pays for it.
  const stale = await rejects(service.payWithWallet({ userId: USER_ID, id: ltdDraft.id, pin: '1234', expectedAmount: PRICE }));
  assert.strictEqual(stale.remark, 'price_changed');
  assert.strictEqual(stale.data.price, LTD_PRICE);

  // A shareholder leaves before payment: their documents go with them.
  const m2Urls = ['m2_valid_id', 'm2_passport', 'm2_signature'].map(k => docsOf(ltdDraft.id)[k].url);
  const fewer = await service.updateApplication({
    userId: USER_ID,
    id: ltdDraft.id,
    body: {
      owner_shares: '60',
      members: JSON.stringify([{ slot: 'm1', role: 'both', shares: 40, ...PERSON('Chidi Okafor Eze', '08051112222') }]),
    },
    files: {},
  });
  assert.strictEqual(fewer.details.members.length, 1);
  assert.strictEqual(fewer.documents.length, 6);
  assert.ok(m2Urls.every(u => spy.deleted.includes(u)), 'a removed person\'s files are deleted');
  assert.ok(!docsOf(ltdDraft.id).m2_passport, 'and gone from the map');
  assert.ok(docsOf(ltdDraft.id).m1_passport, 'the others are untouched');

  const ltdBalance = balance();
  await service.payWithWallet({ userId: USER_ID, id: ltdDraft.id, pin: '1234', expectedAmount: LTD_PRICE });
  assert.strictEqual(balance(), ltdBalance - LTD_PRICE, 'charged the company price');
  assert.strictEqual(appRow(ltdDraft.id).amount_paid, LTD_PRICE);
  const ltdQueue = await service.adminList({ type: 'limited_company' });
  assert.deepStrictEqual(ltdQueue.items.map(i => i.id), [ltdDraft.id], 'the queue filters by type');
  assert.strictEqual(ltdQueue.items[0].registration_type_label, 'Limited Company');
  const ltdDetail = await service.adminDetail(ltdDraft.id);
  assert.ok(ltdDetail.application.documents.find(d => d.kind === 'm1_valid_id').path.endsWith('/documents/m1_valid_id'));
  await service.adminTransition({ id: ltdDraft.id, action: 'start', admin: ADMIN });
  const ltdUpload = over =>
    service.adminUploadDeliverable({ id: ltdDraft.id, file: { buffer: PDF }, kind: 'certificate', admin: ADMIN, ...over });
  assert.ok(/RC 1234567/.test((await rejects(ltdUpload({ registrationNumber: 'BN 1' }))).message));
  await ltdUpload({ registrationNumber: '1234567' });
  await ltdUpload({ kind: 'memart' });
  await service.adminTransition({ id: ltdDraft.id, action: 'complete', admin: ADMIN });
  const ltdDone = await service.detailForUser(USER_ID, ltdDraft.id);
  assert.strictEqual(ltdDone.registration_number, 'RC1234567');
  assert.deepStrictEqual(ltdDone.deliverables.map(d => d.label), ['Certificate of Incorporation', 'Memorandum and Articles of Association']);
  assert.strictEqual(ltdDone.deliverables[1].file_name, `${ltdDone.reference}-Memorandum-and-Articles-of-Association.pdf`);

  // An NGO: a second trustee and a constitution, at the NGO price.
  const ngoFiles = { ...FILES(), ...MEMBER_FILES('m1'), constitution: file(PDF, 'application/pdf', 'Our Constitution.pdf') };
  assert.ok(/at least 1 more trustee/.test((await rejects(draft({ form: NGO_FORM({ members: '[]' }), files: FILES() }))).message));
  const noConstitution = await rejects(draft({ form: NGO_FORM(), files: { ...FILES(), ...MEMBER_FILES('m1') } }));
  assert.strictEqual(noConstitution.message, 'Attach the constitution');
  const ngoDraft = await draft({ form: NGO_FORM(), files: ngoFiles });
  assert.strictEqual(ngoDraft.registration_type, 'incorporated_trustees');
  assert.strictEqual(ngoDraft.quote.price, NGO_PRICE);
  assert.strictEqual(ngoDraft.quote.processing_time, '4-6 weeks');
  assert.strictEqual(docState(ngoDraft, 'constitution').mime_type, 'application/pdf');
  assert.strictEqual(docState(ngoDraft, 'm1_valid_id').label, 'Trustee 2 - NIN slip or card');

  const ngoCheckout = await service.initializePaystack({ userId: USER_ID, id: ngoDraft.id, expectedAmount: NGO_PRICE });
  assert.strictEqual(spy.init.at(-1).amountKobo, NGO_PRICE * 100, 'the checkout is for the NGO price');
  paystackSuccess(ngoCheckout.reference, NGO_PRICE * 100);
  assert.strictEqual((await service.settlePaystack(ngoCheckout.reference, { source: 'webhook' })).paid, true);
  assert.strictEqual(appRow(ngoDraft.id).amount_paid, NGO_PRICE);

  // A trustee's documents can be replaced when the reviewer asks.
  await service.adminTransition({ id: ngoDraft.id, action: 'request_info', note: "Trustee 2's photograph is blurred", admin: ADMIN });
  const m1Before = docsOf(ngoDraft.id).m1_passport.url;
  const answered = await service.updateApplication({
    userId: USER_ID,
    id: ngoDraft.id,
    body: {},
    files: { m1_passport: file(PNG, 'image/png', 'clear.png') },
  });
  assert.strictEqual(answered.status, 'submitted');
  assert.strictEqual(docsOf(ngoDraft.id).m1_passport.mime, 'image/png');
  assert.ok(spy.deleted.includes(m1Before));
  // ...but the last other trustee cannot be removed: CAC needs two.
  await service.adminTransition({ id: ngoDraft.id, action: 'request_info', note: 'Please confirm the trustees again', admin: ADMIN });
  assert.strictEqual(
    (await rejects(service.updateApplication({ userId: USER_ID, id: ngoDraft.id, body: { members: '[]' }, files: {} }))).data.field,
    'members',
  );

  /* ---------------------------------------------------------- 9. sweep */

  // A checkout nobody verified and whose webhook never came.
  const d6 = await draft({ form: { ...FORM, proposed_name_1: 'Ada Gifts', proposed_name_2: 'Ada Hampers', proposed_name_3: 'Ada Presents' } });
  const c6 = await service.initializePaystack({ userId: USER_ID, id: d6.id, expectedAmount: PRICE });
  db.cacPayment.find(p => p.reference === c6.reference).created_at = ago(10 * 60_000);
  paystackSuccess(c6.reference);
  let swept = await service.sweep();
  assert.strictEqual(swept.settled, 1);
  assert.strictEqual(appRow(d6.id).status, 'submitted', 'paid without anybody asking');

  // A checkout a day old and never paid: abandoned, not failed.
  const d7 = await draft({ form: { ...FORM, proposed_name_1: 'Ada Tech', proposed_name_2: 'Ada Labs', proposed_name_3: 'Ada Systems' } });
  const c7 = await service.initializePaystack({ userId: USER_ID, id: d7.id, expectedAmount: PRICE });
  db.cacPayment.find(p => p.reference === c7.reference).created_at = ago(25 * 60 * 60_000);
  paystackRecords[c7.reference] = { status: 'abandoned', amount: PRICE * 100, currency: 'NGN' };
  swept = await service.sweep();
  assert.strictEqual(swept.abandoned, 1);
  assert.strictEqual(db.cacPayment.find(p => p.reference === c7.reference).status, 'abandoned');

  // A draft nobody came back to: the form and the photographs go, a tombstone stays.
  db.cacApplication.find(r => r.id === d7.id).updated_at = ago(15 * 24 * 60 * 60_000);
  const filesOf7 = Object.values(docsOf(d7.id)).map(d => d.url);
  swept = await service.sweep();
  assert.strictEqual(swept.retired, 1);
  const t7 = appRow(d7.id);
  assert.strictEqual(t7.status, 'discarded');
  assert.deepStrictEqual(CAC.revealDetails(t7), {}, 'the form is wiped');
  assert.strictEqual(t7.documents_enc, null);
  assert.ok(filesOf7.length === 3 && filesOf7.every(u => spy.deleted.includes(u)), 'and so are the files');
  assert.strictEqual((await rejects(service.detailForUser(USER_ID, d7.id))).statusCode, 404);

  // ...and if that abandoned checkout is completed after all, the money comes back.
  const preLate = balance();
  paystackSuccess(c7.reference);
  const late = await service.settlePaystack(c7.reference, { source: 'webhook' });
  assert.strictEqual(late.duplicate, true);
  assert.strictEqual(balance(), preLate + PRICE, 'a payment for a discarded draft is handed back');

  // The customer can drop a draft themselves.
  const d8 = await draft({ form: { ...FORM, proposed_name_1: 'Ada Homes', proposed_name_2: 'Ada Realty', proposed_name_3: 'Ada Estates' } });
  assert.deepStrictEqual(await service.discardDraft({ userId: USER_ID, id: d8.id }), { discarded: true });
  assert.strictEqual(appRow(d8.id).status, 'discarded');
  assert.strictEqual((await rejects(service.discardDraft({ userId: USER_ID, id: id1 }))).remark, 'not_a_draft', 'a completed application is not discardable');

  // Deployed before `npm run ddl:cac`: the sweep idles instead of paging ops.
  const realFindMany = fakePrisma.cacPayment.findMany;
  fakePrisma.cacPayment.findMany = async () => {
    throw Object.assign(new Error('The table `public.cac_payments` does not exist in the current database.'), { code: 'P2021' });
  };
  assert.deepStrictEqual(await service.sweep(), { skipped: 'no_tables' });
  // ...and a table made by an older run of the script, missing a column. The
  // pg adapter does not even say which: "(not available)".
  fakePrisma.cacPayment.findMany = async () => {
    throw Object.assign(new Error('The column `(not available)` does not exist in the current database.'), { code: 'P2022' });
  };
  assert.deepStrictEqual(await service.sweep(), { skipped: 'no_tables' }, 'a schema behind the code idles the sweep too');
  fakePrisma.cacPayment.findMany = async () => {
    throw Object.assign(new Error('connection reset'), { code: 'P1017' });
  };
  await assert.rejects(service.sweep(), /connection reset/, 'a real outage is not swallowed');
  fakePrisma.cacPayment.findMany = realFindMany;

  /* --------------------------------------------- 10. nothing in plain text */

  const everything = JSON.stringify({
    applications: db.cacApplication,
    events: db.cacApplicationEvent,
    payments: db.cacPayment,
    deliverables: db.cacDeliverable,
    ledger: db.walletTransaction,
  });
  for (const secret of [
    'Ada Obi Nwosu', '2348031234567', '08031234567', '1994-05-17', 'Allen Avenue', 'Opebi', 'ada@example.com',
    'ufs.sh', 'too dark', 'BN3456789', 'RC1234567', 'Couture', 'Chidi Okafor', 'Ngozi Grace', '2348077778888',
    'Hope Rising', 'Admiralty Way', OWNER_NIN, '28051112222', '28077778888', 'Letter of acknowledgement',
  ]) {
    assert.ok(!everything.includes(secret), `"${secret}" is stored in plain text`);
  }

  /* ------------------------------------------------- 11. the HTTP layer */

  const home = await respond(controller.home, {});
  assert.strictEqual(home.status, 200);
  assert.deepStrictEqual(home.body.data.service.types.map(t => t.price), [PRICE, LTD_PRICE, NGO_PRICE]);
  assert.strictEqual(home.body.data.service.types[1].share_capital.min, 100_000);
  assert.ok(!JSON.stringify(home.body).includes('ufs.sh'));

  const created = await respond(controller.create, { body: { ...FORM, proposed_name_1: 'Ada Wears' }, files: FILES() });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.body.remark, 'cac_draft_saved');
  const invalid = await respond(controller.create, { body: { ...FORM, dob: '2015-01-01' }, files: FILES() });
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(invalid.body.data.field, 'dob');

  // The kill switch stops new business, never the customers already paid.
  featureOn = false;
  const off = await respond(controller.create, { body: FORM, files: FILES() });
  assert.strictEqual(off.status, 503);
  assert.strictEqual(off.body.remark, 'feature_disabled');
  const stillMine = await respond(controller.details, { params: { id: String(id1) } });
  assert.strictEqual(stillMine.status, 200);
  assert.strictEqual(stillMine.body.data.application.status, 'completed');
  featureOn = true;

  // The database behind the code: a 503 the customer can retry and an admin
  // message that names the fix - never a 500 with a Prisma stack in the log.
  const realFindFirst = fakePrisma.cacApplication.findFirst;
  const realCount = fakePrisma.cacApplication.count;
  const behind = async () => {
    throw Object.assign(new Error('Invalid `prisma.cacApplication.findMany()` invocation: The column `(not available)` does not exist in the current database.'), {
      code: 'P2022',
    });
  };
  fakePrisma.cacApplication.findFirst = behind;
  fakePrisma.cacApplication.count = behind;
  const customerSide = await respond(controller.home, {});
  assert.strictEqual(customerSide.status, 503);
  assert.strictEqual(customerSide.body.remark, 'service_unavailable');
  const adminSide = await respond(adminController.listApplications, {});
  assert.strictEqual(adminSide.status, 503);
  assert.ok(/npm run ddl:cac/.test(adminSide.body.message[0]), 'the admin is told the fix');
  fakePrisma.cacApplication.findFirst = realFindFirst;
  fakePrisma.cacApplication.count = realCount;

  const list = await respond(adminController.listApplications, { query: { status: 'rejected' } });
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.data.items.map(i => i.id).sort(), [id3, d4.id].sort());

  // The dashboard's settings call: one type at a time, and it says which.
  const saved = await respond(adminController.updateSettings, {
    body: { registration_type: 'business_name', price: 36000 },
    admin: FINANCE,
  });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.data.types[0].price, 36000);
  assert.strictEqual(saved.body.data.min_price, 100);

  const page = await new Promise(resolve => {
    controller.paystackCallback({ query: { reference: '<script>alert(1)</script>' } }, {
      setHeader() {},
      status() {
        return this;
      },
      send: html => resolve(html),
    });
  });
  assert.ok(page.includes('return to VoltPay'));
  assert.ok(!page.includes('<script>'), 'the callback page reflects nothing from its URL');

  assert.strictEqual(spy.errors.filter(e => e.scope !== 'cac.paystack_amount_mismatch').length, 0, JSON.stringify(spy.errors));

  console.log('✅ CAC registration tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
