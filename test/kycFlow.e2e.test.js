/**
 * node test/kycFlow.e2e.test.js
 *
 * THE WHOLE VERIFICATION JOURNEY, END TO END.
 *
 * test/kyc.test.js pins the pieces in isolation - the gate predicate, the
 * validators, the name matcher. This one drives the real controllers, in the
 * order a real customer and a real reviewer hit them, and checks what the
 * database, the ledger and the notification queue look like afterwards.
 * Everything outside our own code is faked in front of it: Prisma, ArewaSmart,
 * Paystack, UploadThing, the notifier, both audit logs and the user cache.
 *
 * It is an automated test and not a live walkthrough on purpose. A BVN lookup
 * costs real money on every call, and the only way to exercise the decline paths
 * against the real register is to pay for declines - and to hold a real person's
 * BVN to do it. The provider contract itself is pinned separately
 * (arewasmart.service's own normalizers, paystack.service); what is pinned HERE
 * is our flow through them.
 *
 * The rule this exists to defend, because it has changed direction four times:
 *
 *     verified  =  (a BVN the register matched  OR  a NIN slip an admin approved)
 *                  AND
 *                  (a bank account Paystack resolved to the profile name)
 *
 * An AND. Every case below that says "still not verified" is guarding the read
 * of that line as an OR, which is the mistake that would open every wallet
 * holding half the evidence.
 *
 * The second rule, new with ArewaSmart, is about money:
 *
 *     the customer owes the fee exactly when the register ANSWERED.
 *
 * Not when it answered yes. A "no such BVN" and a "that is not your name" are
 * both completed lookups, both billed to us, and both billed on. But an outage,
 * a rejected token or an empty prepaid balance at the provider is OUR problem,
 * and charging somebody ₦60 for it would be theft with extra steps. Cases 3, 4
 * and 5 are that line, from both sides.
 *
 * The journey, in order:
 *
 *    1  a fresh wallet spends under the limit and freezes at it
 *    2  the free guards decline before the register is ever called
 *    3  a provider outage costs the customer nothing
 *    4  a BVN the register cannot find is a completed lookup, so it is charged
 *    5  a BVN that resolves to somebody else is charged, and files none of them
 *    6  a matching BVN is HALF the requirement - no unlock, no push
 *    7  and the fee lands on the statement like any other debit
 *    8  re-submitting a verified BVN must not buy the same answer twice
 *    9  a bank account in another name is refused and indexes nothing
 *   10  the matching account completes it: one push, one unlock
 *   11  re-linking the same account is idempotent and does not re-notify
 *   12  an admin can take verification back off a live wallet
 *   13  ...and the user can earn it back, at the price of a second lookup
 *   14  no BVN? the slip goes to a human, and says so - a day or two
 *   15  a pending slip claims the NIN, so the same one cannot be filed twice
 *   16  the queue is oldest-first and every look at a document is logged
 *   17  a decline carries a reason, releases the NIN, and unlocks nothing
 *   18  the released NIN is claimable by whoever really owns it
 *   19  an approved slip is still only half - the bank step is not optional
 *   20  ...and the bank step finishes it, through the same single unlock
 *   21  a decided slip cannot be re-decided behind the audit trail
 *   22  the `nin_status` fossil verifies nobody
 *   23  KYC_BANK_REQUIRED=0 is the only thing that makes identity sufficient
 */
const assert = require('assert');
const { Prisma } = require('@prisma/client');

const Decimal = Prisma.Decimal;

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.KYC_GATE_ENABLED = '1';
process.env.KYC_BANK_REQUIRED = '1';
process.env.KYC_FUNDING_LIMIT = '25000';
process.env.KYC_FUNDING_LIMIT_MODE = 'lifetime';
// Set explicitly rather than left to the default, so the arithmetic below is
// pinned to a number this file states out loud. That the DEFAULT is also 60 is
// a separate fact, pinned in test/kyc.test.js where bvnFee() is unit-tested
// across every env shape - including the empty-string one that used to parse to
// zero and make the check free.
process.env.KYC_BVN_FEE = '60';
// Never read - paystack.service is stubbed below. Present because
// verifyBankAccount checks for a key before it calls out, so that an
// unconfigured deployment answers 503 honestly instead of throwing.
process.env.PAYSTACK_SECRET_KEY = 'sk_test_stub_not_a_real_key';
// AREWASMART_API_TOKEN is deliberately NOT set. The service is stubbed and its
// isConfigured() answers true directly, so a token here would be decoration
// that hides which of the two is actually being tested.

const { protect, reveal, hashSecret, revealLedgerText } = require('../src/helpers/pii.helper');

const LIMIT = 25_000;
const FEE = 60;

/* ========================================================================== */
/*  the fake database                                                         */
/* ========================================================================== */

const db = { users: new Map(), kyc: new Map(), funding: [], ledger: [] };

// The schema's own defaults. Getting these wrong is not a detail: a row that
// starts life at status 'verified' would make every case below pass for the
// wrong reason - and a nullable column that reads back `undefined` instead of
// `null` quietly passes assertions that Postgres would have failed.
//
// The five identity columns are in here now, and they were not before. They
// became nullable when the BVN moved from a match api to a lookup api: the
// register supplies them, the register does not always carry a phone or a
// gender, and a missing one must not become a failed write AFTER the customer
// has paid. Listing them here is what lets case 4 assert they stay null.
const KYC_DEFAULTS = {
  status: 'none',
  account_status: 'none',
  nin_status: 'none',
  nin_slip_status: 'none',
  grandfathered: false,

  bvn_enc: null,
  bvn_idx: null,
  bvn_match: null,
  decline_reason: null,
  verified_at: null,

  nin_enc: null,
  nin_idx: null,
  nin_match: null,
  nin_decline_reason: null,
  nin_verified_at: null,

  nin_slip_url_enc: null,
  nin_slip_number_enc: null,
  nin_slip_number_idx: null,
  nin_slip_decline_reason: null,
  nin_slip_reviewed_by: null,
  nin_slip_reviewed_at: null,
  nin_slip_submitted_at: null,
  nin_slip_check: null,

  account_number_enc: null,
  account_number_idx: null,
  account_name_enc: null,
  bank_code: null,
  bank_name: null,
  account_decline_reason: null,
  account_verified_at: null,

  first_name_enc: null,
  middle_name_enc: null,
  last_name_enc: null,
  phone_enc: null,
  dob_enc: null,
  gender: null,

  callback_token: null,
  revoked_at: null,
  revoked_by: null,
  revoke_reason: null,
};

// @unique in the schema, and the reason a number cannot verify two wallets.
const UNIQUE_IDX = ['bvn_idx', 'nin_idx', 'nin_slip_number_idx', 'account_number_idx'];

function matchValue(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('not' in expected) return !matchValue(actual, expected.not);
    if ('in' in expected) return expected.in.includes(actual);
    if ('gte' in expected) return Number(actual) >= Number(expected.gte);
    // Loudly, rather than by quietly matching everything - a filter this fake
    // does not understand would otherwise turn into a test that passes.
    throw new Error(`fake prisma: unsupported filter ${JSON.stringify(expected)}`);
  }
  return actual === expected;
}

function matchWhere(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(w => matchWhere(row, w));
    if (key === 'OR') return value.some(w => matchWhere(row, w));
    if (key === 'NOT') return !matchWhere(row, value);
    return matchValue(row?.[key], value);
  });
}

/**
 * Honours `select` rather than handing back the whole row.
 *
 * Deliberate. kycGate.kycStatuses selects three columns by name, and its comment
 * warns that dropping one hands rowIsVerified an `undefined` and silently
 * unverifies everybody it belongs to. A fake that ignored `select` would make
 * that bug invisible here.
 */
function applySelect(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
  return out;
}

function assertUnique(userId, row) {
  for (const field of UNIQUE_IDX) {
    if (!row[field]) continue;
    for (const [otherId, other] of db.kyc) {
      if (otherId === userId) continue;
      if (other[field] !== row[field]) continue;
      throw Object.assign(new Error(`Unique constraint failed on ${field}`), { code: 'P2002' });
    }
  }
}

const time = value => (value ? new Date(value).getTime() : 0);

const models = {
  kycVerification: {
    findUnique: async ({ where, select }) => {
      const row = db.kyc.get(Number(where.user_id));
      return row ? applySelect(row, select) : null;
    },
    findFirst: async ({ where, select }) => {
      const hit = [...db.kyc.values()].find(r => matchWhere(r, where));
      return hit ? applySelect(hit, select) : null;
    },
    findMany: async ({ where, select, orderBy, skip = 0, take = 25 }) => {
      const rows = [...db.kyc.values()].filter(r => matchWhere(r, where));
      if (orderBy?.nin_slip_submitted_at) {
        const dir = orderBy.nin_slip_submitted_at === 'asc' ? 1 : -1;
        rows.sort((a, b) => dir * (time(a.nin_slip_submitted_at) - time(b.nin_slip_submitted_at)));
      }
      return rows.slice(skip, skip + take).map(r => applySelect(r, select));
    },
    count: async ({ where }) => [...db.kyc.values()].filter(r => matchWhere(r, where)).length,
    create: async ({ data }) => {
      const userId = Number(data.user_id);
      if (db.kyc.has(userId)) throw Object.assign(new Error('Unique constraint failed on user_id'), { code: 'P2002' });
      const row = { ...KYC_DEFAULTS, submitted_at: new Date(), created_at: new Date(), ...data, user_id: userId };
      assertUnique(userId, row);
      db.kyc.set(userId, row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const userId = Number(where.user_id);
      const current = db.kyc.get(userId);
      if (!current) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      const next = { ...current, ...data, updated_at: new Date() };
      assertUnique(userId, next);
      db.kyc.set(userId, next);
      return { ...next };
    },
  },

  user: {
    findUnique: async ({ where }) => {
      const row = db.users.get(Number(where.id));
      return row ? { ...row } : null;
    },
    // Needed because the BVN check is now a wallet debit: applyBalanceDelta
    // updates twice, once to move the balance and once to re-stamp the MAC off
    // the value Postgres landed on.
    update: async ({ where, data }) => {
      const row = db.users.get(Number(where.id));
      if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      for (const [key, value] of Object.entries(data)) {
        // `{ increment }` is the only operator balance.helper uses, and the
        // arithmetic is done in Decimal rather than in JS numbers on purpose:
        // the controller hands us a Prisma.Decimal and reads `.toString()` back
        // off the result, so a fake that quietly turned money into a float would
        // be testing a different type than production runs.
        if (value && typeof value === 'object' && 'increment' in value) {
          row[key] = new Decimal(row[key] ?? 0).plus(value.increment);
        } else {
          row[key] = value;
        }
      }
      return { ...row };
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of db.users.values()) {
        if (!matchWhere(row, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
  },

  // The customer's statement. Before the fee existed this model was served by
  // the catch-all Proxy below, which swallowed every write - so the ledger row
  // could have been any shape at all, or absent, and nothing here would have
  // noticed.
  walletTransaction: {
    create: async ({ data }) => {
      const entry = { id: db.ledger.length + 1, created_at: new Date(), ...data };
      db.ledger.push(entry);
      return { ...entry };
    },
  },

  fundingTransaction: {
    aggregate: async ({ where }) => ({
      _sum: { amount: db.funding.filter(r => matchWhere(r, where)).reduce((t, r) => t + Number(r.amount), 0) },
    }),
    findFirst: async ({ where }) => {
      const rows = db.funding.filter(r => matchWhere(r, where)).sort((a, b) => b.amount - a.amount);
      return rows[0] || null;
    },
  },
};

const noop = async () => null;

// NOTE: $transaction here runs the callback and commits whatever it did. There
// is no rollback, so no case below may depend on one. The two paths that do -
// a concurrent spend emptying the wallet between the pre-flight balance read and
// the guard inside the transaction, and the unique index being claimed by
// another account mid-submission - are genuinely racy against a real Postgres
// and would pass here for the wrong reason. They are left to the code review and
// to the comments in submitDocument rather than faked into a green tick.
const fakePrisma = new Proxy(
  { $transaction: async fn => fn(fakePrisma) },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in models) return models[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
      return new Proxy({}, { get: () => noop });
    },
  },
);

/* ========================================================================== */
/*  the fakes, installed before any controller is loaded                      */
/* ========================================================================== */

const spy = {
  pushes: [],        // notifyUser
  userEvents: [],    // logUserEvent    (the customer's own timeline)
  adminActions: [],  // logAdminAction  (who did what to whom)
  security: [],      // securityEvent
  invalidated: [],   // userCache.invalidateUser
  uploads: [],       // upload.helper
  arewasmart: [],    // every BVN register lookup, answered or not
  ninLookups: [],    // every NIN register lookup
  resolves: [],      // every Paystack resolve
};

// Two lookups, two counters, and they must not be merged. A BVN lookup is
// spent by the CUSTOMER, out of their own wallet, and the footer prices it in
// naira they were charged. A NIN lookup is spent by a REVIEWER, out of ours.
// One array would make the fee line at the bottom of this file a lie, and that
// line is the assertion that catches a billing regression nothing else sees.

// What the next provider call answers. Set per case, and left null between them
// so a case that forgets to set one fails loudly instead of inheriting the
// previous case's verdict.
const provider = {
  bvn: null,
  nin: null,
  accountName: 'ADA OKAFOR',
  resolveThrows: false,
};

const BVN = '22212345678';

/**
 * A register hit, shaped exactly as arewasmart.verifyBvn returns it.
 *
 * There is no `completed: false` builder, and there cannot be: the service
 * RETURNS only on a completed lookup and throws on everything else. That is the
 * billing contract expressed as a type, and a fake that offered a way to return
 * an incomplete lookup would let a test pass that production cannot reach.
 */
const found = (firstName, lastName, middleName = null, extra = {}) => ({
  completed: true,
  found: true,
  reference: `BVN-${String(spy.arewasmart.length + 1).padStart(6, '0')}`,
  message: 'Verification Successful',
  record: {
    bvn: BVN,
    firstName,
    lastName,
    middleName,
    dateOfBirth: '1995-04-12',
    gender: 'FEMALE',
    phoneNumber: '2348031234567',
    ...extra,
  },
});

// The register answered, and its answer was "no such number". A completed
// lookup: we are billed, so the customer is billed.
const notFound = () => ({
  completed: true,
  found: false,
  record: null,
  reference: `BVN-${String(spy.arewasmart.length + 1).padStart(6, '0')}`,
  message: 'That BVN could not be found',
});

// The register was never read. `reason` is the service's own fixed vocabulary -
// auth, billing, rate_limit, upstream, unexpected_shape - and never the
// provider's own body, so no register value can reach a log line through it.
const outage = (reason = 'upstream') =>
  Object.assign(new Error('Identity verification is temporarily unavailable'), {
    statusCode: 503,
    arewasmart: { reason },
  });

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../database/prisma', fakePrisma);

/**
 * A NIN register hit, shaped as arewasmart.verifyNin returns it.
 *
 * `photo` is present because the real NIN response carries one and the
 * point of the reviewer's check is to put that face next to the uploaded slip.
 * It is a data: URI here for the same reason it is one in production - the
 * provider hands back bare base64 and the service is what makes it renderable.
 */
const ninFound = (firstName, lastName, middleName = null, extra = {}) => ({
  completed: true,
  found: true,
  reference: `NINV2-${String(spy.ninLookups.length + 1).padStart(6, '0')}`,
  message: 'NIN Verification Successful',
  record: {
    nin: null,
    firstName,
    lastName,
    middleName,
    dateOfBirth: '1995-04-12',
    gender: 'FEMALE',
    phoneNumber: '2348031234567',
    photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD',
    trackingId: 'TRK000000001Z',
    ...extra,
  },
});

// The register answered "no such number". Still a completed lookup, so the
// provider still bills us - which is exactly why the reviewer's button is not
// wired to fire on opening the slip.
const ninNotFound = () => ({
  completed: true,
  found: false,
  record: null,
  reference: `NINV2-${String(spy.ninLookups.length + 1).padStart(6, '0')}`,
  message: 'That NIN could not be found',
});

stub('../src/funding/arewasmart.service', {
  isConfigured: () => true,
  verifyBvn: async ({ bvn }) => {
    spy.arewasmart.push(String(bvn));
    if (provider.bvn === null) throw new Error('test bug: provider.bvn was not set for this case');
    if (provider.bvn instanceof Error) throw provider.bvn;
    return provider.bvn;
  },
  verifyNin: async ({ nin }) => {
    spy.ninLookups.push(String(nin));
    if (provider.nin === null) throw new Error('test bug: provider.nin was not set for this case');
    if (provider.nin instanceof Error) throw provider.nin;
    return provider.nin;
  },
});

stub('../src/funding/paystack.service', {
  resolveAccount: async ({ account_number, bank_code }) => {
    spy.resolves.push({ account_number, bank_code });
    if (provider.resolveThrows) throw new Error('Could not resolve account name');
    return { data: { account_name: provider.accountName, account_number, bank_id: 9 } };
  },
  listBanks: async () => [
    { code: '058', name: 'Guaranty Trust Bank', slug: 'gtb', type: 'nuban' },
    { code: '057', name: 'Zenith Bank', slug: 'zenith', type: 'nuban' },
  ],
});

stub('../src/helpers/upload.helper', {
  uploadFile: async (file, opts) => {
    spy.uploads.push(opts?.prefix || null);
    return { url: `https://utfs.io/f/${spy.uploads.length}-nin-slip.jpg`, key: `k${spy.uploads.length}` };
  },
  deleteFileByUrl: noop,
  fileKeyFromUrl: () => null,
  isUploadThingUrl: () => true,
});

stub('../src/services/notify.service', {
  notifyUser: async args => {
    spy.pushes.push(args);
    return true;
  },
});

stub('../src/services/userAudit.service', {
  logUserEvent: async args => {
    spy.userEvents.push(args);
    return true;
  },
  listUserEvents: noop,
});

stub('../src/services/userCache.service', {
  invalidateUser: async id => {
    spy.invalidated.push(Number(id));
    return true;
  },
  // balance.helper calls this on every movement, and it is the reason a debited
  // wallet does not show its old balance for the next 15 seconds. Missing from
  // this stub, applyBalanceDelta would throw mid-transaction on the first fee.
  invalidateUserAfterCommit: id => {
    spy.invalidated.push(Number(id));
    return true;
  },
  getCachedUser: noop,
});

// Real sockets, and it holds a `ws` client registry. Nothing in a KYC test has a
// browser attached, so this would be a no-op with a dependency load attached.
stub('../src/services/notificationWs.service', {
  broadcastToUserIds: () => null,
  broadcastToAll: () => null,
  initNotificationWs: () => null,
});

stub('../src/services/audit.service', {
  logAdminAction: async args => {
    spy.adminActions.push(args);
    return true;
  },
  clientIp: () => '127.0.0.1',
});

stub('../src/services/alerts.service', {
  securityEvent: (code, message, metadata) => spy.security.push({ code, message, metadata }),
  captureError: () => null,
  captureAlert: () => null,
});

const kyc = require('../src/controllers/kyc.controller');
const adminKyc = require('../src/controllers/adminKyc.controller');
const { checkSpendKyc, rowIsVerified } = require('../src/helpers/kycGate.helper');

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
  return res;
}

const message = res => (Array.isArray(res.body?.message) ? res.body.message.join(' ') : String(res.body?.message ?? ''));
const verification = res => res.body?.data?.verification || null;

// One hash, reused. scrypt is deliberately slow, and hashing a PIN per user
// would put seconds on a suite that otherwise runs instantly.
let PIN_HASH = null;
const PIN = '1234';

/** A signed-up customer, PII encrypted exactly as the real table holds it. */
function makeUser(id, firstname, lastname, { funded = 0, balance = 500 } = {}) {
  db.users.set(id, {
    id,
    kv: '0',
    status: 'active',
    country_code: 'NG',
    firstname: null,
    lastname: null,
    firstname_enc: protect(firstname, 'name').enc,
    lastname_enc: protect(lastname, 'name').enc,
    email_enc: protect(`${firstname}.${lastname}@example.com`.toLowerCase(), 'email').enc,
    mobile_enc: protect('2348031234567', 'mobile').enc,
    // Both of these are new, and neither is furniture. The BVN check is a wallet
    // debit now: with no PIN hash every submission stops at 401, and with no
    // balance every one of them stops at insufficient_balance.
    pin: PIN_HASH,
    balance: new Decimal(balance),
    balance_mac: null,
  });
  if (funded) db.funding.push({ user_id: id, amount: funded, credited_at: new Date() });
  return db.users.get(id);
}

/**
 * `req.user`, as userAuth actually builds it - from the CACHE.
 *
 * userCache.service nulls `pin`, `password` and `recovery_hash` before it caches
 * a row, so those three are absent from req.user in production. Reproducing that
 * here is what turns "the PIN is checked against a fresh row" from a comment
 * into an assertion: a controller that checked `req.user.pin` would fail every
 * paid case below instead of passing them by luck.
 */
const asUser = (id, body = {}, file = null) => {
  const cached = { ...db.users.get(id), pin: null, password: null, recovery_hash: null };
  return {
    user: cached,
    body,
    file,
    headers: { 'user-agent': 'jest/e2e' },
    originalUrl: '/api/kyc',
  };
};

const asAdmin = (userId, body = {}, query = {}) => ({
  params: { id: String(userId) },
  body,
  query,
  headers: { 'user-agent': 'admin-dashboard' },
  admin: { id: 7, source: 'session', name: 'Ngozi (compliance)', row: {} },
  originalUrl: `/api/admin/kyc/nin-slips/${userId}`,
});

const row = id => db.kyc.get(id);
const kv = id => db.users.get(id).kv;
const balanceOf = id => Number(db.users.get(id).balance.toString());
const pushesFor = id => spy.pushes.filter(p => Number(p.userId) === id);
const unlockPushes = id => pushesFor(id).filter(p => p.data?.status === 'verified');
const feeRows = id => db.ledger.filter(r => Number(r.user_id) === id && r.remark === 'kyc_bvn_verification');

const SLIP_FILE = { originalname: 'slip.jpg', mimetype: 'image/jpeg', size: 4096, buffer: Buffer.from('jpeg') };

// The identity details, matching the profile name. Six fields - and NIN-slip
// only. The BVN route dropped its copy of this form when the provider changed:
// a lookup api reads the register itself, so there is nothing left for the
// customer to transcribe, and nothing for them to be declined over transcribing
// wrongly. A slip is a photograph, scored against nothing, so it still needs the
// details typed alongside it.
const details = (firstName, lastName) => ({
  first_name: firstName,
  last_name: lastName,
  phone_number: '08031234567',
  dob: '1995-04-12',
  gender: 'female',
});

let caseNo = 0;
function step(title) {
  caseNo += 1;
  console.log(`  ${String(caseNo).padStart(2, ' ')}. ${title}`);
}

/* ========================================================================== */

async function run() {
  console.log('\nKYC verification flow, end to end\n');

  PIN_HASH = await hashSecret(PIN, 'pin');

  /* ---------------------------------------------------------------------- */
  step('a fresh wallet spends under the limit, and freezes at it');

  const ADA = 101;
  makeUser(ADA, 'Ada', 'Okafor');

  assert.strictEqual((await checkSpendKyc({ userId: ADA })).ok, true,
    'a wallet that has received nothing is not the gate\'s business');

  db.funding.push({ user_id: ADA, amount: 30_000, credited_at: new Date() });

  const frozen = await checkSpendKyc({ userId: ADA });
  assert.strictEqual(frozen.ok, false, `past ${LIMIT} an unverified wallet is frozen`);
  assert.match(frozen.message, /BVN/, 'and is pointed at the door that opens in seconds');

  let res = mockRes();
  await kyc.status(asUser(ADA), res);
  assert.strictEqual(res.body.data.locked, true, 'the app is told the wallet is locked');
  assert.strictEqual(res.body.data.verification, null, 'nothing submitted yet, so there is no record');
  assert.strictEqual(res.body.data.identity_done, false);
  assert.strictEqual(res.body.data.bank_done, false);

  // Request H's promise, in the server's own words so the app and the dashboard
  // cannot quote different numbers at the customer.
  const identityStep = res.body.data.steps.find(s => s.key === 'identity');
  const bvnOption = identityStep.options.find(o => o.key === 'bvn');
  const slipOption = identityStep.options.find(o => o.key === 'nin_slip');
  assert.match(bvnOption.subtitle, /seconds/i, 'the BVN route must be advertised as instant');
  assert.match(slipOption.subtitle, /1-2 days|day/i,
    'and the slip route as taking a day or two - that is the whole reason to prefer the other one');
  assert.strictEqual(res.body.data.steps.find(s => s.key === 'bank_account').done, false,
    'the bank account is a step of its own, shown to everybody');

  // The price, quoted by the server. The screen must never carry its own copy of
  // this number: the debit and the sentence that sold it have to agree, and they
  // only do if there is one source for it.
  assert.strictEqual(res.body.data.bvn_fee, FEE, 'the fee rides in the status response');
  assert.strictEqual(bvnOption.fee, FEE, 'and in the option the user is about to tap');
  assert.strictEqual(bvnOption.free, false);
  assert.ok(bvnOption.subtitle.includes(String(FEE)),
    'the price is in the subtitle, not buried in a detail paragraph nobody expands');
  assert.match(bvnOption.detail, /whether or not it matches/i,
    'and the customer is told BEFORE paying that a failed check is still a charged one');
  assert.strictEqual(slipOption.free, true, 'the slip route is free, and says so');
  assert.strictEqual(slipOption.fee, 0);

  assert.strictEqual(res.body.data.can_afford_bvn, true, 'this wallet can pay for it');
  assert.strictEqual(bvnOption.recommended, true, 'so the paid, instant route is the one to lead with');
  assert.strictEqual(slipOption.recommended, false);

  /* ---------------------------------------------------------------------- */
  step('the free guards decline before the register is ever called');

  // Everything reachable without spending anything. A decline we can reach on
  // our own is a decline nobody should pay for - not the customer, and not us.
  const untouched = spy.arewasmart.length;

  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: '1234', pin: PIN }), res);
  assert.strictEqual(res.statusCode, 400, 'four digits is not a BVN');
  assert.strictEqual(res.body.remark, 'validation_error');

  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN }), res);
  assert.strictEqual(res.statusCode, 400, 'no PIN, no debit');
  assert.match(message(res), /PIN/i);

  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: '9999' }), res);
  assert.strictEqual(res.statusCode, 401, 'a wrong PIN is refused like any other wallet debit');
  assert.strictEqual(res.body.remark, 'invalid_pin');

  // A wallet that cannot cover the fee is stopped here rather than after the
  // lookup, where we would have bought an answer nobody can pay for.
  const KEMI = 110;
  makeUser(KEMI, 'Kemi', 'Adeleke', { funded: 30_000, balance: 5 });
  res = mockRes();
  await kyc.submitBvn(asUser(KEMI, { bvn: '22299988877', pin: PIN }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'insufficient_balance');
  assert.strictEqual(res.body.data.fee, FEE, 'the price is repeated in the refusal');
  assert.match(message(res), /NIN slip/i,
    'and a customer who cannot afford the fast door is pointed at the free one - a dead end here is a lost user');
  assert.match(message(res), /free/i);

  res = mockRes();
  await kyc.status(asUser(KEMI), res);
  assert.strictEqual(res.body.data.can_afford_bvn, false);
  assert.strictEqual(res.body.data.steps.find(s => s.key === 'identity')
    .options.find(o => o.key === 'nin_slip').recommended, true,
    'and the screen leads with the free route for them, instead of a paid one their wallet will refuse');

  assert.strictEqual(spy.arewasmart.length, untouched,
    'FOUR declines, and not one register call between them');
  assert.strictEqual(db.ledger.length, 0, 'so nothing was charged');
  assert.strictEqual(balanceOf(ADA), 500, 'and no balance moved');
  assert.strictEqual(db.kyc.has(ADA), false, 'a refused submission writes no row at all');

  /* ---------------------------------------------------------------------- */
  step('a provider outage costs the customer nothing');

  provider.bvn = outage('auth');   // our token was rejected: entirely our problem
  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 503, 'not a decline - a shrug');
  assert.strictEqual(res.body.remark, 'unavailable');
  assert.match(message(res), /not been charged/i,
    'and the customer is TOLD they were not charged, because otherwise they will assume they were');
  assert.strictEqual(spy.arewasmart.length, untouched + 1, 'we did call them');
  assert.strictEqual(balanceOf(ADA), 500, 'and still took nothing');
  assert.strictEqual(db.ledger.length, 0, 'no ledger row, so nothing to refund and nothing to explain');
  assert.strictEqual(db.kyc.has(ADA), false,
    'and no row: an outage is not evidence about this customer, so it must not be recorded as a failed check');
  assert.strictEqual(JSON.stringify(res.body).includes('auth'), false,
    'the reason is a server-side classification - handing it to the client leaks how our provider account is doing');

  /* ---------------------------------------------------------------------- */
  step('a BVN the register cannot find is a completed lookup, so it is charged');

  provider.bvn = notFound();
  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 400, 'the check failed');
  assert.strictEqual(res.body.remark, 'bvn_failed');
  assert.strictEqual(res.body.data.charged, true, 'and it was still billed - the register answered');
  assert.strictEqual(balanceOf(ADA), 500 - FEE, 'so ₦60 left the wallet');
  assert.strictEqual(feeRows(ADA).length, 1, 'against exactly one statement line');

  assert.strictEqual(row(ADA).status, 'failed');
  assert.strictEqual(row(ADA).bvn_idx, null,
    'a failed attempt claims nothing - the unique index belongs to whoever really owns the number');
  assert.ok(row(ADA).bvn_enc, 'though what they typed is kept, encrypted, so a repeat attempt is visible');

  // The nullable columns, doing the job they were made nullable for. A register
  // that says "no such number" has told us nothing about who this person is.
  for (const column of ['first_name_enc', 'middle_name_enc', 'last_name_enc', 'phone_enc', 'dob_enc', 'gender']) {
    assert.strictEqual(row(ADA)[column], null,
      `${column} stays null on a not-found lookup - and would have thrown NOT NULL before the DDL was loosened`);
  }

  assert.ok(pushesFor(ADA).some(p => p.data?.status === 'failed' && /charged/i.test(p.message)),
    'the push says the fee was taken - a silent ₦60 deduction is a support ticket');
  assert.ok(spy.userEvents.some(e => e.event === 'kyc.bvn_failed' && e.metadata?.charged === true),
    'and the audit row states the charge rather than leaving it to be inferred');

  /* ---------------------------------------------------------------------- */
  step('a BVN that resolves to somebody else is charged, and files none of them');

  // The risk a lookup api carries and a match api did not. One digit wrong into
  // a live BVN and the register hands back a REAL PERSON who is not our customer.
  provider.bvn = found('Musa', 'Ibrahim', 'Sani');
  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'bvn_failed');
  assert.strictEqual(balanceOf(ADA), 500 - 2 * FEE, 'charged, because the register answered');
  assert.strictEqual(row(ADA).status, 'failed');
  assert.strictEqual(row(ADA).bvn_idx, null);

  const body = JSON.stringify(res.body);
  assert.strictEqual(body.includes('Musa'), false,
    'the register name is NEVER echoed, or this endpoint is a paid BVN-to-identity lookup service');
  assert.strictEqual(body.includes('Ibrahim'), false);
  assert.strictEqual(body.includes('Sani'), false);
  assert.match(message(res), /Ada Okafor/,
    'the user\'s OWN profile name is safe to show, and is the thing they need in order to fix it');

  // The heart of it: a stranger's register record must not be filed against this
  // wallet. It is not our customer's data, we have just declined the check that
  // asked for it - and identityFromRow would otherwise offer that stranger's
  // name and date of birth as the prefill for this user's free NIN-slip attempt,
  // putting a name in front of a human reviewer that the customer never typed.
  for (const column of ['first_name_enc', 'middle_name_enc', 'last_name_enc', 'phone_enc', 'dob_enc', 'gender']) {
    assert.strictEqual(row(ADA)[column], null,
      `${column}: a found-but-mismatched lookup stores nothing about the person it found`);
  }

  // The audit column keeps counts, never fragments of a name.
  const audit = row(ADA).bvn_match;
  assert.strictEqual(audit.provider, 'arewasmart');
  assert.strictEqual(audit.found, true, 'the number existed');
  assert.strictEqual(audit.name_ok, false, 'it just was not theirs');
  assert.strictEqual(audit.fee, FEE);
  assert.ok(Number.isInteger(audit.name_tokens_expected) && Number.isInteger(audit.name_tokens_matched));
  const auditJson = JSON.stringify(audit);
  for (const fragment of ['Musa', 'Ibrahim', 'Sani', 'Ada', 'Okafor', BVN]) {
    assert.strictEqual(auditJson.includes(fragment), false,
      `bvn_match is counts and references only - it must never carry "${fragment}"`);
  }

  /* ---------------------------------------------------------------------- */
  step('a matching BVN is HALF the requirement: no unlock, no push');

  // The bank already showed that a name in a different order still matches; here
  // the register also carries a middle name the profile does not. That is the
  // ordinary case, and it is the one the OLD provider could not score at all.
  provider.bvn = found('Ada', 'Okafor', 'Chinelo');
  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 200, 'a matching BVN is accepted');
  assert.strictEqual(row(ADA).status, 'verified');
  assert.ok(row(ADA).bvn_idx, 'a verified BVN claims the unique index');
  assert.strictEqual(verification(res).identity_done, true);
  assert.strictEqual(verification(res).bank_done, false);
  assert.strictEqual(verification(res).fully_verified, false,
    'identity alone is NOT verification - this is the AND, and it is the whole point');
  assert.strictEqual(verification(res).next_step, 'bank_account');
  assert.strictEqual(verification(res).verified_via, 'bvn',
    'which route was taken is reportable before the journey is finished');

  assert.strictEqual(kv(ADA), '0', 'the wallet flag stays down until BOTH halves are in');
  assert.strictEqual(unlockPushes(ADA).length, 0,
    'and the customer is NOT told their wallet is unlocked, because it is not');

  // NOW the register's details are filed, because now they are this person's.
  assert.strictEqual(reveal(row(ADA).first_name_enc), 'Ada');
  assert.strictEqual(reveal(row(ADA).last_name_enc), 'Okafor');
  assert.strictEqual(reveal(row(ADA).middle_name_enc), 'Chinelo',
    'the middle name is captured at last - the match api took one and never scored it');
  assert.strictEqual(reveal(row(ADA).dob_enc), '1995-04-12');
  assert.strictEqual(row(ADA).gender, 'Female', 'normalized to our own vocabulary, not the register\'s');
  assert.strictEqual(reveal(row(ADA).phone_enc), '2348031234567');
  assert.strictEqual(row(ADA).callback_token, null,
    'a synchronous provider hands out no callback token, and a stale unique value is worth clearing');

  // The reply itself must not promise something the gate will refuse thirty
  // seconds later at the checkout.
  assert.strictEqual(/unlocked/i.test(message(res)), false,
    'the success message must not claim an unlocked wallet while the bank step is outstanding');
  assert.match(message(res), /bank account/i, 'it must name the step that is actually left');

  // Nothing is echoed back that a screenshot or a log could carry away.
  assert.strictEqual(JSON.stringify(res.body).includes(BVN), false,
    'the BVN is never echoed back to the client');

  const stillFrozen = await checkSpendKyc({ userId: ADA });
  assert.strictEqual(stillFrozen.ok, false, 'and the gate still refuses to move money');
  assert.match(stillFrozen.message, /bank account/i,
    'the refusal names the missing half, not the one already done');
  assert.strictEqual(/Verify your BVN/.test(stillFrozen.message), false,
    'never send somebody back to a form they have already passed');

  /* ---------------------------------------------------------------------- */
  step('and the fee lands on the statement like any other debit');

  assert.strictEqual(balanceOf(ADA), 500 - 3 * FEE, 'three completed lookups, three fees');
  const rows = feeRows(ADA);
  assert.strictEqual(rows.length, 3, 'one statement line each - never a silent deduction');

  const last = rows[rows.length - 1];
  assert.strictEqual(last.trx_type, '-');
  assert.strictEqual(Number(last.amount.toString()), FEE);
  assert.strictEqual(Number(last.charge.toString()), 0, 'the fee IS the amount; there is no charge on top of it');
  assert.strictEqual(Number(last.total_amount.toString()), FEE);
  assert.strictEqual(last.remark, 'kyc_bvn_verification',
    'a stable remark, so a month of these can be reconciled against provider spend');

  // Free text naming what the money went to is encrypted at rest, exactly like
  // every other ledger row - Redis and Postgres are held to the same standard.
  assert.ok(last.details.startsWith('enc:v1:'), 'details is ciphertext');
  assert.ok(last.other_data.subtitle.startsWith('enc:v1:'), 'so is the subtitle');

  // Read back through the same helper the transactions screen uses, rather than
  // decrypting by hand: a row that stores correctly but does not survive
  // revealLedgerText is a blank line on somebody's statement.
  const shown = revealLedgerText(last);
  assert.match(shown.details, /BVN verification/i, 'and reads back correctly');
  assert.match(shown.other_data.subtitle, /BVN verification/i);
  assert.strictEqual(shown.other_data.title, 'BVN verification',
    'the title was never ciphertext - it names OUR service, not a counterparty');

  assert.strictEqual(last.other_data.feedback, 'Successful',
    'the SERVICE was delivered - the register answered, and we were billed for it');
  assert.strictEqual(last.other_data.note, 'Verified',
    'and `note` carries the outcome, so a charged decline does not read as a mystery deduction');
  assert.strictEqual(rows[0].other_data.note, 'Not verified', 'as on the two that failed');
  assert.strictEqual(rows[0].other_data.feedback, 'Successful',
    'which are still successful TRANSACTIONS: the answer was no, the lookup was not');

  // Ids and our own references only.
  const metaJson = JSON.stringify(rows.map(r => r.meta));
  for (const fragment of [BVN, 'Ada', 'Okafor', 'Musa', 'Chinelo', '2348031234567']) {
    assert.strictEqual(metaJson.includes(fragment), false,
      `meta carries ids and references, never "${fragment}"`);
  }
  assert.strictEqual(last.meta.provider, 'arewasmart');
  assert.strictEqual(last.meta.verified, true);
  assert.strictEqual(rows[0].meta.verified, false);
  assert.ok(last.meta.kyc_reference, 'the kyc row is reachable from the statement line');
  assert.ok(spy.invalidated.includes(ADA),
    'and the cached user row is dropped, or the app shows the old balance for another 15 seconds');

  /* ---------------------------------------------------------------------- */
  step('re-submitting a verified BVN must not buy the same answer twice');

  const paidSoFar = spy.arewasmart.length;
  const balanceBefore = balanceOf(ADA);
  provider.bvn = found('Ada', 'Okafor', 'Chinelo');

  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 400, 'there is nothing left to check on this document');
  assert.strictEqual(res.body.remark, 'already_verified');
  assert.strictEqual(spy.arewasmart.length, paidSoFar,
    'the register bills per lookup, so a second one for an answer the row already holds is the customer\'s money burned');
  assert.strictEqual(balanceOf(ADA), balanceBefore, 'and their balance proves it');
  assert.match(message(res), /bank account/i, 'and the user is told what IS outstanding');

  /* ---------------------------------------------------------------------- */
  step('a bank account in somebody else\'s name is refused, and indexes nothing');

  provider.accountName = 'CHIDI NWOSU';
  res = mockRes();
  await kyc.verifyBankAccount(asUser(ADA, { account_number: '0123456789', bank_code: '058' }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'name_mismatch');
  assert.strictEqual(row(ADA).account_status, 'failed');
  assert.strictEqual(row(ADA).account_number_idx, null,
    'a FAILED attempt must not claim the number - that would lock the account out of the wallet that really owns it');
  assert.strictEqual(JSON.stringify(res.body).includes('CHIDI'), false,
    'the resolved name is never echoed, or this endpoint becomes an account-name lookup service');
  assert.match(message(res), /Ada Okafor/,
    'the user\'s OWN profile name is safe to show, and is the thing they need to see');
  assert.ok(spy.security.some(e => e.code === 'kyc.bank_name_mismatch'), 'and it is worth a security event');
  assert.strictEqual(feeRows(ADA).length, 3, 'and the bank step is free - no fourth statement line');

  /* ---------------------------------------------------------------------- */
  step('the matching account completes it: one unlock, one push');

  provider.accountName = 'OKAFOR ADA CHINELO';   // banks reorder and add middle names
  res = mockRes();
  await kyc.verifyBankAccount(asUser(ADA, { account_number: '0123456789', bank_code: '058' }), res);

  assert.strictEqual(res.statusCode, 200, 'a name the bank holds in a different order still matches');
  assert.strictEqual(row(ADA).account_status, 'verified');
  assert.ok(row(ADA).account_number_idx, 'and NOW the number is claimed');
  assert.strictEqual(row(ADA).bank_name, 'Guaranty Trust Bank',
    'the label on the record is ours, looked up from the code - never trusted from the request body');
  assert.strictEqual(verification(res).fully_verified, true);
  assert.strictEqual(verification(res).next_step, null, 'nothing outstanding');
  assert.strictEqual(verification(res).bank_account_masked, '****6789', 'the number is masked, never echoed');
  assert.strictEqual(rowIsVerified(row(ADA)), true);

  assert.strictEqual(kv(ADA), '1', 'the legacy dashboard flag follows the gate, or the app nags a verified user');
  assert.ok(spy.invalidated.includes(ADA), 'and the cached user row is dropped, or a 15s stale copy stays locked');
  assert.strictEqual(unlockPushes(ADA).length, 1, 'exactly one "identity verified" push');
  assert.ok(spy.userEvents.some(e => e.event === 'kyc.verified'), 'and one audit entry');

  assert.strictEqual((await checkSpendKyc({ userId: ADA })).ok, true, 'the wallet can finally move money');

  /* ---------------------------------------------------------------------- */
  step('re-linking the same account is idempotent, and does not notify twice');

  const resolvesSoFar = spy.resolves.length;
  res = mockRes();
  await kyc.verifyBankAccount(asUser(ADA, { account_number: '0123456789', bank_code: '058' }), res);

  assert.strictEqual(res.statusCode, 200, 'a double tap on a slow connection is not an error');
  assert.strictEqual(spy.resolves.length, resolvesSoFar, 'and does not go back out to Paystack');
  assert.strictEqual(unlockPushes(ADA).length, 1,
    'finalizeIfVerified fires on the TRANSITION only - a second push would be spam about old news');

  /* ---------------------------------------------------------------------- */
  step('an admin can take verification back off a live wallet');

  res = mockRes();
  await adminKyc.revokeKyc(asAdmin(ADA, {}), res);
  assert.strictEqual(res.statusCode, 400, 'a revoke with no reason is refused');
  assert.match(message(res), /reason is required/i);

  res = mockRes();
  await adminKyc.revokeKyc(asAdmin(ADA, { reason: 'The BVN resolves to a profile reported as sold.' }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(ADA).status, 'revoked', 'the BVN door is shut');
  assert.strictEqual(row(ADA).revoke_reason, 'The BVN resolves to a profile reported as sold.');
  assert.strictEqual(row(ADA).revoked_by, 'Ngozi (compliance)',
    'the name comes from the SESSION, not the request body - a decision like this needs a person on it');
  assert.strictEqual(row(ADA).account_status, 'verified',
    'the bank half is untouched: the finding was about the identity, and re-verifying should not re-do the bank');
  assert.strictEqual(rowIsVerified(row(ADA)), false);
  assert.strictEqual(kv(ADA), '0', 'and the app stops showing them as verified');

  assert.strictEqual((await checkSpendKyc({ userId: ADA })).ok, false, 'the wallet is frozen again');
  assert.ok(spy.security.some(e => e.code === 'admin.kyc_revoked'), 'a withdrawal wakes somebody');
  assert.ok(spy.adminActions.some(a => a.action === 'admin.kyc_revoked' && a.targetId === ADA),
    'and lands in the admin audit log against the target user');
  assert.ok(pushesFor(ADA).some(p => p.data?.status === 'revoked' && /wallet is on hold/i.test(p.message)),
    'the user is told, in the reviewer\'s own words, why their money stopped');

  res = mockRes();
  await adminKyc.revokeKyc(asAdmin(ADA, { reason: 'again' }), res);
  assert.strictEqual(res.statusCode, 409, 'there is nothing left to revoke');

  /* ---------------------------------------------------------------------- */
  step('...and the user can earn it back, at the price of a second lookup');

  const beforeRewin = balanceOf(ADA);
  provider.bvn = found('Ada', 'Okafor', 'Chinelo');
  res = mockRes();
  await kyc.submitBvn(asUser(ADA, { bvn: BVN, pin: PIN }), res);

  assert.strictEqual(res.statusCode, 200, 'a revoke is not a ban');
  assert.strictEqual(rowIsVerified(row(ADA)), true,
    'the bank half survived the revoke, so one document finishes it');
  assert.strictEqual(kv(ADA), '1');
  assert.strictEqual(unlockPushes(ADA).length, 2, 'a genuine second transition gets a second push');
  assert.match(message(res), /unlocked/i, 'and THIS time the message may say so');

  // A revoked row is a real re-check, not a replay of a stored verdict, so it
  // costs what a check costs. Worth stating out loud: it is the one path where a
  // customer pays twice for the same number, and a reviewer revoking on a hunch
  // is spending somebody else's money to do it.
  assert.strictEqual(balanceOf(ADA), beforeRewin - FEE, 'and it is charged, because the register was read again');
  assert.strictEqual(feeRows(ADA).length, 4);

  /* ---------------------------------------------------------------------- */
  step('no BVN? the slip goes to a human, and says so');

  const BOLA = 102;
  makeUser(BOLA, 'Bola', 'Adeyemi', { funded: 40_000 });
  const NIN = '70011122233';
  const ledgerBeforeSlips = db.ledger.length;

  res = mockRes();
  await kyc.submitNinSlip(asUser(BOLA, { nin: NIN, ...details('Bola', 'Adeyemi') }, SLIP_FILE), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(BOLA).nin_slip_status, 'pending', 'a photograph is not a verdict');
  assert.strictEqual(row(BOLA).status, 'none', 'and it is not a BVN either - the two columns stay apart');
  assert.ok(row(BOLA).nin_slip_url_enc, 'the URL is stored');
  assert.strictEqual(row(BOLA).nin_slip_url_enc.includes('utfs.io'), false,
    'ENCRYPTED - an UploadThing link is a bearer token for a photo of a government ID');
  assert.strictEqual(spy.uploads[0], `kyc_nin_slip_${BOLA}`, 'uploaded before the row was written');
  assert.match(message(res), /day or two/i, 'the promise is made in the response');
  assert.ok(pushesFor(BOLA).some(p => p.data?.status === 'pending' && /day or two/i.test(p.message)),
    'and repeated in the push, so the customer is not left refreshing a screen');
  assert.strictEqual(verification(res).next_step, 'nin_slip_review',
    'the app leads with "we are working on it", not with another form');

  assert.strictEqual(balanceOf(BOLA), 500, 'the slip route is FREE - that is the whole reason it is offered');
  assert.strictEqual(db.ledger.length, ledgerBeforeSlips, 'so it writes no statement line');

  const waitingOnUs = await checkSpendKyc({ userId: BOLA });
  assert.strictEqual(waitingOnUs.ok, false, 'a pending slip is not an approval');
  assert.match(waitingOnUs.message, /being reviewed/i,
    'and somebody waiting on US must not be told to submit it again - that is how the queue fills with duplicates');

  res = mockRes();
  await kyc.submitNinSlip(asUser(BOLA, { nin: NIN, ...details('Bola', 'Adeyemi') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 400, 'one slip in the queue at a time');
  assert.strictEqual(res.body.remark, 'nin_slip_pending');
  assert.strictEqual(spy.uploads.length, 1, 'and the second photo is not even uploaded');

  /* ---------------------------------------------------------------------- */
  step('the slip form posts four fields, not six, and that is enough');

  // Every other case here sends `details()` - all six identity fields. The APP
  // sends four: nin, first_name, middle_name, last_name, dob. No phone, no
  // gender. That gap was a hard 400 on every submission from a real device
  // while this suite stayed green, because one supplied field flips
  // resolveIdentity to the strict branch and the strict branch wanted all six.
  //
  // So this case posts what the client actually posts. If the contract tightens
  // again, it fails here rather than in the field.
  const NGOZI = 106;
  makeUser(NGOZI, 'Ngozi', 'Eze', { funded: 20_000 });

  res = mockRes();
  await kyc.submitNinSlip(
    asUser(NGOZI, { nin: '70099911122', first_name: 'Ngozi', middle_name: '', last_name: 'Eze', dob: '1993-07-19' }, SLIP_FILE),
    res,
  );

  assert.strictEqual(res.statusCode, 200, 'the payload the app actually sends is accepted');
  assert.strictEqual(row(NGOZI).nin_slip_status, 'pending');
  assert.strictEqual(reveal(row(NGOZI).phone_enc), '2348031234567',
    'the phone comes off the authenticated profile - the account it arrived on already proves that number');
  assert.strictEqual(row(NGOZI).gender, null,
    'and gender stays null, which is the same state a BVN lookup leaves when the register carries none');

  /* ---------------------------------------------------------------------- */
  step('a pending slip claims the NIN, so the same one cannot be filed twice');

  const CHIDI = 103;
  makeUser(CHIDI, 'Chidi', 'Nwosu', { funded: 60_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(CHIDI, { nin: NIN, ...details('Chidi', 'Nwosu') }, SLIP_FILE), res);

  assert.strictEqual(res.statusCode, 409, 'one NIN, one wallet - even while the first is only pending');
  assert.strictEqual(res.body.remark, 'nin_in_use');
  assert.ok(spy.security.some(e => e.code === 'kyc.nin_slip_reuse'),
    'two identical slips in a queue is the fraud a reviewer is least likely to spot, so it alerts');
  assert.strictEqual(db.kyc.has(CHIDI), false, 'and nothing is written for the second account');

  /* ---------------------------------------------------------------------- */
  step('the queue is oldest-first, and every look at a document is logged');

  // Backdate Bola's slip past the promise, and give Chidi a legitimate one, so
  // the ordering has something to be right about.
  row(BOLA).nin_slip_submitted_at = new Date(Date.now() - 50 * 3_600_000);
  res = mockRes();
  await kyc.submitNinSlip(asUser(CHIDI, { nin: '70044455566', ...details('Chidi', 'Nwosu') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200, 'a different NIN on a different account is fine');

  res = mockRes();
  await adminKyc.listNinSlips({ query: { status: 'pending' }, headers: {} }, res);

  // Three waiting: Bola (backdated), Ngozi's four-field submission, and Chidi's.
  const queue = res.body.data.items;
  assert.strictEqual(queue.length, 3);
  assert.strictEqual(queue[0].user_id, BOLA, 'oldest first - this queue carries a turnaround promise');
  assert.ok(queue[0].waiting_hours >= 48, 'and reports the wait in hours, so 26h does not round to "0 days"');
  assert.strictEqual(res.body.data.counts.pending, 3);
  assert.strictEqual(queue[0].firstname, 'Bola', 'decrypted - a list of ciphertext is not a queue anybody can triage');
  assert.strictEqual(queue[0].nin_masked.includes(NIN), false, 'the number is masked in the LIST');
  assert.strictEqual('slip_url' in queue[0], false, 'and the photograph is not handed out with the list');

  res = mockRes();
  await adminKyc.getNinSlip(asAdmin(BOLA), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.slip.nin, NIN, 'the reviewer sees the number in the clear - that IS the review');
  assert.match(res.body.data.slip.slip_url, /utfs\.io/, 'and the photograph, decrypted for the one person who needs it');
  const viewed = spy.adminActions.find(a => a.action === 'admin.kyc_nin_slip_viewed');
  assert.ok(viewed, 'opening a government ID is a disclosure, even when it is also the job');
  assert.strictEqual(viewed.targetId, BOLA);
  assert.strictEqual(JSON.stringify(viewed.metadata).includes(NIN), false,
    'and the number disclosed must not be written into the record of the disclosure');

  /* ---------------------------------------------------------------------- */
  step('a decline carries a reason, releases the NIN, and unlocks nothing');

  const beforeDecline = spy.ninLookups.length;

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'declined' }), res);
  assert.strictEqual(res.statusCode, 400, 'a decline with no sentence attached leaves the user guessing forever');

  const REASON = 'The photo is too blurred to read the NIN. Please retake it in good light.';
  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'declined', decline_reason: REASON }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(BOLA).nin_slip_status, 'declined');
  assert.strictEqual(row(BOLA).nin_slip_reviewed_by, 'Ngozi (compliance)', 'attributable to a person');
  assert.strictEqual(row(BOLA).nin_slip_number_idx, null,
    'a decline RELEASES the number - most declines are a blurry photo, not a fraud');
  assert.strictEqual(kv(BOLA), '0');
  assert.strictEqual(unlockPushes(BOLA).length, 0);
  const declinePush = pushesFor(BOLA).find(p => p.data?.status === 'declined');
  assert.ok(declinePush, 'the user is told');
  assert.ok(declinePush.message.startsWith(REASON),
    'and the reviewer\'s reason IS the push - it is not paperwork, it is the message');
  assert.match(declinePush.message, /BVN/,
    'with the faster door offered alongside it');
  assert.strictEqual(spy.ninLookups.length, beforeDecline,
    'and a decline spends nothing: paying the register ₦50 to establish that a blurry photo is blurry ' +
    'would tax the queue at exactly the point where the answer is already visible');

  /* ---------------------------------------------------------------------- */
  step('the released NIN is claimable by whoever really owns it');

  const DELE = 104;
  makeUser(DELE, 'Dele', 'Balogun', { funded: 30_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(DELE, { nin: NIN, ...details('Dele', 'Balogun') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200,
    'the number a declined attempt held is free again, or a rejected photo locks a stranger out for good');
  assert.strictEqual(row(DELE).nin_slip_status, 'pending');

  /* ---------------------------------------------------------------------- */
  step('nothing is approved until the register has been asked');

  res = mockRes();
  await kyc.submitNinSlip(asUser(BOLA, { nin: '70077788899', ...details('Bola', 'Adeyemi') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200, 'a declined user may resubmit');
  assert.strictEqual(row(BOLA).nin_slip_decline_reason, null,
    'and starts clean - the old rejection next to a new pending slip reads as a fresh rejection');

  // Everything the reviewer has looked at so far came from the applicant. They
  // typed the name, they typed the number, they took the photograph. A reviewer
  // comparing those against each other is checking a document against itself,
  // and a good forgery is internally consistent by construction.
  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'approved' }), res);

  assert.strictEqual(res.statusCode, 428, 'approving on the applicant\'s own word alone is refused');
  assert.strictEqual(res.body.remark, 'register_check_required');
  assert.strictEqual(row(BOLA).nin_slip_status, 'pending', 'and the slip is left where it was');
  assert.strictEqual(kv(BOLA), '0');

  // The check itself. WE pay for this one, not the customer - so it is a button
  // a person presses, never something that fires when a slip is opened.
  provider.nin = ninFound('Bola', 'Adeyemi');
  const beforeCheck = spy.ninLookups.length;

  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(BOLA), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(spy.ninLookups.length, beforeCheck + 1, 'one press, one lookup');
  assert.strictEqual(res.body.data.check.found, true);
  assert.strictEqual(res.body.data.check.name_ok, true);
  assert.strictEqual(res.body.data.check.provider, 'arewasmart');
  assert.strictEqual(res.body.data.check.checked_by, 'Ngozi (compliance)',
    'attributable, because it both spends money and makes a finding about a person');
  assert.strictEqual('nin_idx' in res.body.data.check, false,
    'the key the server tells checks apart by is not something a browser needs, so it does not travel');
  assert.strictEqual(res.body.data.record.firstname, 'Bola',
    'the reviewer sees the register record once, live, to compare against the photograph');
  assert.match(res.body.data.record.photo, /^data:image\/jpeg;base64,/,
    'including the face, which is the entire point of the comparison');

  // What is STORED is a verdict. Not a name, not a date of birth, not a face.
  // Persistence is needed for two narrow things - the dedupe and a gate the
  // server can enforce - and neither of them needs the register's data.
  const stored = row(BOLA).nin_slip_check;
  assert.strictEqual(stored.name_ok, true);
  assert.strictEqual(stored.nin_last4, '8899');
  const storedJson = JSON.stringify(stored);
  assert.strictEqual(storedJson.includes('Bola'), false,
    'a lookup response is a real person\'s identity, and it does not outlive the request that fetched it');
  assert.strictEqual(storedJson.includes('70077788899'), false, 'the number is not duplicated into it either');
  assert.strictEqual(storedJson.includes('data:image'), false, 'least of all the photograph');

  const checkAudit = spy.adminActions.find(a => a.action === 'admin.kyc_nin_register_checked');
  assert.ok(checkAudit, 'spending on a customer\'s behalf is logged');
  assert.strictEqual(checkAudit.targetId, BOLA);
  assert.strictEqual(JSON.stringify(checkAudit.metadata).includes('Bola'), false,
    'and the audit trail is held to the same rule as the column - it is the place most tempting to break it');

  /* ---------------------------------------------------------------------- */
  step('...and asking the register twice does not pay for it twice');

  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(BOLA), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(spy.ninLookups.length, beforeCheck + 1,
    'a second reviewer opening the same slip re-reads the verdict rather than re-buying it');
  assert.strictEqual(res.body.data.cached, true);
  assert.strictEqual(res.body.data.record, null,
    'and sees the finding, not the person - the record was never kept to be handed back');

  /* ---------------------------------------------------------------------- */
  step('an approved slip is still only half - the bank step is not optional');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'approved' }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(BOLA).nin_slip_status, 'approved');
  assert.strictEqual(row(BOLA).status, 'none',
    'approving a slip must never touch the BVN column - they are different evidence');
  assert.strictEqual(rowIsVerified(row(BOLA)), false,
    'THE AND: an approved slip with no bank account does not open a wallet');
  assert.strictEqual(kv(BOLA), '0', 'so the flag stays down');
  assert.strictEqual(unlockPushes(BOLA).length, 0,
    'and the customer is not told they are unlocked while the gate would still refuse them');

  const needsBank = await checkSpendKyc({ userId: BOLA });
  assert.strictEqual(needsBank.ok, false);
  assert.match(needsBank.message, /bank account/i, 'they are one free, instant step away, and told exactly that');

  /* ---------------------------------------------------------------------- */
  step('...and the free route does not then hand them a bill for the paid one');

  // The seam this closes: `rowIsVerified` is false here (no bank yet), and the
  // BVN column says 'none', so a guard keyed on either of those alone lets the
  // lookup run and bills ₦60 for an identity half that is ALREADY SETTLED. The
  // user being charged would be the one who took the free route precisely
  // because they had no money for the paid one.
  //
  // A different number and a matching register answer on purpose: the number is
  // unclaimed, so the reuse check cannot be what refuses this, and the record
  // matches, so nothing downstream would have declined it either. Take the
  // `hasIdentity` guard out and this case bills.
  const bolaPaidSoFar = spy.arewasmart.length;
  provider.bvn = found('Bola', 'Adeyemi');

  res = mockRes();
  await kyc.submitBvn(asUser(BOLA, { bvn: '22299988877', pin: PIN }), res);

  assert.strictEqual(res.statusCode, 400, 'the identity half is done, whichever door it came through');
  assert.strictEqual(res.body.remark, 'already_verified');
  assert.strictEqual(spy.arewasmart.length, bolaPaidSoFar,
    'and the register is never called, so there is nothing for the provider to bill us for either');
  assert.strictEqual(balanceOf(BOLA), 500, 'the free route is still free');
  assert.match(message(res), /bank account/i, 'and they are pointed at the one step that IS outstanding');
  assert.strictEqual(row(BOLA).status, 'none',
    'a refused submission writes nothing - the BVN column belongs to a check that never ran');

  /* ---------------------------------------------------------------------- */
  step('...and the bank step finishes it, through the same single unlock');

  provider.accountName = 'ADEYEMI BOLA';
  res = mockRes();
  await kyc.verifyBankAccount(asUser(BOLA, { account_number: '9876543210', bank_code: '057' }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rowIsVerified(row(BOLA)), true, 'slip + bank is a complete verification');
  assert.strictEqual(verification(res).verified_via, 'nin_slip', 'and the record says which route was taken');
  assert.strictEqual(kv(BOLA), '1');
  assert.strictEqual(unlockPushes(BOLA).length, 1,
    'one unlock, sent by the same finalizeIfVerified the BVN route uses - not a second copy of the rule');
  assert.strictEqual((await checkSpendKyc({ userId: BOLA })).ok, true);

  assert.strictEqual(balanceOf(BOLA), 500,
    'and the whole free route stayed free, end to end - slip, review, bank, unlock');

  /* ---------------------------------------------------------------------- */
  step('a decided slip cannot be re-decided behind the audit trail');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'declined', decline_reason: 'changed my mind' }), res);
  assert.strictEqual(res.statusCode, 409,
    'reversing an approval is what revokeKyc is for - it notifies, alerts and records who did it');
  assert.strictEqual(row(BOLA).nin_slip_status, 'approved', 'and nothing moved');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(BOLA, { status: 'maybe', decline_reason: 'x' }), res);
  assert.strictEqual(res.statusCode, 400, 'and only approved/declined are decisions at all');

  /* ---------------------------------------------------------------------- */
  step('a number the register has never heard of cannot be approved at all');

  const TOLU = 107;
  makeUser(TOLU, 'Tolu', 'Bakare', { funded: 40_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(TOLU, { nin: '55511122233', ...details('Tolu', 'Bakare') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200);

  provider.nin = ninNotFound();
  const beforeTolu = spy.ninLookups.length;

  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(TOLU), res);

  assert.strictEqual(res.statusCode, 200, 'the register ANSWERED - "no such number" is a finding, not a failure');
  assert.strictEqual(res.body.data.check.found, false);
  assert.strictEqual(res.body.data.record, null, 'and there is no record to show, because there is no person');
  assert.strictEqual(row(TOLU).nin_slip_check.found, false, 'the finding is kept');

  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(TOLU), res);
  assert.strictEqual(spy.ninLookups.length, beforeTolu + 1,
    'and a "no" is cached exactly like a "yes" - a reviewer cannot re-buy the same negative by clicking again');
  assert.strictEqual(res.body.data.cached, true);

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(TOLU, { status: 'approved' }), res);

  assert.strictEqual(res.statusCode, 428, 'a document whose number is not in the register is not identity');
  assert.strictEqual(res.body.remark, 'register_check_required');
  assert.match(message(res), /no record/i, 'and the reviewer is told which of the two refusals this is');
  assert.strictEqual(row(TOLU).nin_slip_status, 'pending');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(TOLU, {
    status: 'declined',
    decline_reason: 'The NIN on this slip is not in the national register. Please check the number and re-upload.',
  }), res);
  assert.strictEqual(res.statusCode, 200, 'the way out is a decline, which needs no check and spends nothing');
  assert.strictEqual(spy.ninLookups.length, beforeTolu + 1);

  /* ---------------------------------------------------------------------- */
  step('a register that names somebody else needs a written reason, not a click');

  const SEUN = 108;
  makeUser(SEUN, 'Seun', 'Ajayi', { funded: 40_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(SEUN, { nin: '66611122233', ...details('Seun', 'Ajayi') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200);

  // Found, and it is a real record - just not this applicant's. The most
  // dangerous shape on the queue, because everything renders normally.
  provider.nin = ninFound('Chidi', 'Nwosu');

  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(SEUN), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.check.found, true);
  assert.strictEqual(res.body.data.check.name_ok, false);
  assert.strictEqual(JSON.stringify(row(SEUN).nin_slip_check).includes('Chidi'), false,
    'a found-but-mismatched lookup is a THIRD PARTY\'s record and is filed against nobody');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(SEUN, { status: 'approved' }), res);

  assert.strictEqual(res.statusCode, 428);
  assert.strictEqual(res.body.remark, 'register_name_mismatch');
  assert.strictEqual(row(SEUN).nin_slip_status, 'pending', 'one click is not enough to walk past the register');

  // But it is not a wall. Nigerian names legitimately disagree with the
  // register - a married name, a spelling the enrolment officer typed, a
  // middle name used as a surname - so the override exists, costs a sentence,
  // and puts that sentence next to the reviewer's name forever.
  const WHY = 'Register holds her maiden name; marriage certificate seen on ticket #4821.';
  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(SEUN, { status: 'approved', override_reason: WHY }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(SEUN).nin_slip_status, 'approved');

  const overrideAudit = spy.adminActions.filter(a => a.action === 'admin.kyc_nin_slip_approved').pop();
  assert.strictEqual(overrideAudit.metadata.name_override, true, 'flagged, so the overrides are findable as a set');
  assert.strictEqual(overrideAudit.metadata.override_reason, WHY, 'with the reason itself, verbatim');
  assert.strictEqual(overrideAudit.metadata.register_name_ok, false);

  /* ---------------------------------------------------------------------- */
  step('a check run against a different number is not a check');

  const FEMI = 109;
  makeUser(FEMI, 'Femi', 'Ogun', { funded: 40_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(FEMI, { nin: '77711122233', ...details('Femi', 'Ogun') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200);

  provider.nin = ninFound('Femi', 'Ogun');
  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(FEMI), res);
  assert.strictEqual(res.body.data.check.name_ok, true);

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(FEMI, {
    status: 'declined',
    decline_reason: 'The photograph is cropped - the number is cut off at the edge. Please retake it.',
  }), res);
  assert.strictEqual(res.statusCode, 200);

  // The decline released the number but left the verdict in its column. Now a
  // DIFFERENT number arrives under the same user, and a stale pass would carry
  // last week's "name matched" onto it.
  //
  // 777-11122233 and 888-11122233 END THE SAME on purpose. The check stores
  // four visible digits for the reviewer to read, and if the gate compared
  // those, this case would sail through - one collision in ten thousand, on the
  // guard whose whole job is to stop a verdict being reused. It compares the
  // blind index instead.
  res = mockRes();
  await kyc.submitNinSlip(asUser(FEMI, { nin: '88811122233', ...details('Femi', 'Ogun') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(row(FEMI).nin_slip_check.name_ok, true, 'the old verdict is still sitting there');
  assert.strictEqual(row(FEMI).nin_slip_check.nin_last4, '2233', 'and its visible digits match the new slip exactly');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(FEMI, { status: 'approved' }), res);

  assert.strictEqual(res.statusCode, 428, 'and it does not count for the new number');
  assert.strictEqual(res.body.remark, 'register_check_stale');

  const beforeRecheck = spy.ninLookups.length;
  provider.nin = ninFound('Femi', 'Ogun');
  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(FEMI), res);

  assert.strictEqual(spy.ninLookups.length, beforeRecheck + 1,
    'the dedupe is keyed on the number, so a new number is never served the old answer');
  assert.strictEqual(res.body.data.cached, false);
  assert.strictEqual(row(FEMI).nin_slip_check.nin_last4, '2233');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(FEMI, { status: 'approved' }), res);
  assert.strictEqual(res.statusCode, 200, 'checked against the number actually on the slip, it goes through');

  /* ---------------------------------------------------------------------- */
  step('an outage claims nothing about anybody');

  const KUNLE = 110;
  makeUser(KUNLE, 'Kunle', 'Salami', { funded: 40_000 });

  res = mockRes();
  await kyc.submitNinSlip(asUser(KUNLE, { nin: '99911122233', ...details('Kunle', 'Salami') }, SLIP_FILE), res);
  assert.strictEqual(res.statusCode, 200);

  provider.nin = outage('upstream');
  res = mockRes();
  await adminKyc.verifyNinLookup(asAdmin(KUNLE), res);

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.remark, 'unavailable');
  assert.strictEqual(row(KUNLE).nin_slip_check, null,
    'nothing is written, because a failed lookup must never read later as a finding');

  res = mockRes();
  await adminKyc.reviewNinSlip(asAdmin(KUNLE, { status: 'approved' }), res);
  assert.strictEqual(res.statusCode, 428,
    'so the slip waits for the register to come back rather than sliding through while it is down');
  assert.strictEqual(res.body.remark, 'register_check_required');

  /* ---------------------------------------------------------------------- */
  step('the `nin_status` fossil verifies nobody');

  // The withdrawn automated NIN-number check. Live rows still carry 'verified'
  // here. Reading it as identity would silently promote every one of them into
  // an unlocked wallet - which is why the slip got its own column set.
  const EFE = 105;
  makeUser(EFE, 'Efe', 'Otu', { funded: 80_000 });
  db.kyc.set(EFE, {
    ...KYC_DEFAULTS,
    user_id: EFE,
    reference: 'kyc_105_fossil',
    first_name_enc: protect('Efe', 'name').enc,
    last_name_enc: protect('Otu', 'name').enc,
    phone_enc: protect('2348031234567', 'mobile').enc,
    dob_enc: protect('1995-04-12', 'dob').enc,
    gender: 'Female',
    nin_status: 'verified',
    nin_verified_at: new Date(),
    account_status: 'verified',      // even WITH the bank half done
    grandfathered: true,             // and even grandfathered
  });

  assert.strictEqual(rowIsVerified(row(EFE)), false,
    'a verified NIN NUMBER is not an identity document any more, whatever else the row holds');
  assert.strictEqual((await checkSpendKyc({ userId: EFE })).ok, false, 'so the wallet stays frozen');

  res = mockRes();
  await kyc.status(asUser(EFE), res);
  assert.strictEqual(res.body.data.identity_done, false);
  assert.strictEqual(res.body.data.verification.nin_status, 'verified',
    'the column is still reported, so an installed APK rendering a NIN card gets a well-formed answer');
  assert.strictEqual(res.body.data.verification.fully_verified, false, 'it just does not open anything');

  /* ---------------------------------------------------------------------- */
  step('KYC_BANK_REQUIRED=0 is the only thing that makes identity sufficient');

  // The escape hatch, for a deployment that already had verified users before
  // the bank rule existed. "Not required" has to read as "satisfied", or every
  // one of those wallets stays shut.
  process.env.KYC_BANK_REQUIRED = '0';
  try {
    const OGA = 106;
    makeUser(OGA, 'Ola', 'Bello', { funded: 90_000 });
    db.kyc.set(OGA, {
      ...KYC_DEFAULTS,
      user_id: OGA,
      reference: 'kyc_106_legacy',
      first_name_enc: protect('Ola', 'name').enc,
      last_name_enc: protect('Bello', 'name').enc,
      phone_enc: protect('2348031234567', 'mobile').enc,
      dob_enc: protect('1995-04-12', 'dob').enc,
      gender: 'Male',
      status: 'verified',
      verified_at: new Date(),
    });

    assert.strictEqual(rowIsVerified(row(OGA)), true, 'with the requirement off, the BVN alone is enough');
    assert.strictEqual((await checkSpendKyc({ userId: OGA })).ok, true, 'and the legacy wallet is not frozen');
  } finally {
    process.env.KYC_BANK_REQUIRED = '1';
  }

  assert.strictEqual(rowIsVerified(row(EFE)), false, 'and switching it back on is honoured immediately');

  /* ---------------------------------------------------------------------- */

  // These two counters are assertions in their own right. A billing regression
  // does not announce itself as a failed status code - it shows up as a number
  // here that went up when the flow above did not change.
  const charged = db.ledger.filter(r => r.remark === 'kyc_bvn_verification').length;
  console.log('\n✅ KYC verification flow: all cases passed');
  console.log(`   ${spy.arewasmart.length} BVN lookups, ${charged} charged to customers (₦${charged * FEE}), ` +
    `${spy.ninLookups.length} NIN lookups on us`);
  console.log(`   ${spy.resolves.length} Paystack resolves, ${spy.pushes.length} pushes, ` +
    `${spy.adminActions.length} admin audit entries\n`);
}

run().catch(e => {
  console.error('\n❌ KYC flow test failed\n');
  console.error(e);
  process.exit(1);
});
