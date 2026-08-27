/**
 * Paying the StaffPay yearly fee out of the VoltPay wallet.
 *
 * Four things must not break:
 *   1. A correct PIN and enough balance = exactly one debit, one ledger row and
 *      one year of access.
 *   2. A short balance moves no money and grants nothing.
 *   3. A wrong PIN never reaches the wallet.
 *   4. A double tap does not buy two years.
 *
 * Prisma is faked in front of the controller - the point of the test is the
 * order and the arithmetic of the money path, not Postgres.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { Prisma } = require('@prisma/client');

// --- fake prisma, installed before the controller is loaded ----------------
const state = {};

function resetState() {
  state.balance = new Prisma.Decimal('200000.00');
  state.pinHash = null;
  state.company = { id: 7, owner_user_id: 1, name_enc: null, name: 'Test Ltd' };
  state.verification = { status: 'approved' };
  state.subscriptions = [];
  state.ledger = [];
  state.balanceWrites = 0;
}

const noop = async () => null;

const models = {
  user: {
    findUnique: async () => ({ id: 1, balance: state.balance, pin: state.pinHash }),
    update: async ({ data }) => {
      if (data?.balance?.increment !== undefined) {
        state.balance = new Prisma.Decimal(state.balance).add(data.balance.increment);
        state.balanceWrites += 1;
      }
      return { id: 1, balance: state.balance };
    },
  },
  staffPayCompany: {
    findFirst: async ({ where }) => (where.id === state.company.id ? state.company : null),
  },
  staffPayVerification: {
    findUnique: async () => state.verification,
  },
  appSetting: { findUnique: noop },
  staffPaySubscription: {
    findFirst: async ({ where }) => {
      // The duplicate-tap probe asks by created_at; the renewal probe by expiry.
      if (where?.created_at?.gt) {
        return state.subscriptions.find(s => s.created_at > where.created_at.gt) || null;
      }
      const after = where?.expires_at?.gt || new Date();
      return state.subscriptions.filter(s => s.status === 'active' && s.expires_at > after).pop() || null;
    },
    create: async ({ data }) => {
      const row = { id: state.subscriptions.length + 1, created_at: new Date(), ...data };
      state.subscriptions.push(row);
      return row;
    },
  },
  walletTransaction: {
    create: async ({ data }) => {
      state.ledger.push(data);
      return data;
    },
  },
};

const fakePrisma = new Proxy(
  {
    $transaction: async fn => fn(fakePrisma),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in models) return models[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
      // Anything else the controller chain touches (audit log, notifications)
      // answers "nothing there" rather than exploding.
      return new Proxy({}, { get: () => noop });
    },
  }
);

const prismaPath = require.resolve('../database/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };

const { hashSecret } = require('../src/helpers/pii.helper');
const { payWithWallet } = require('../src/controllers/staffpaySubscription.controller');

// --- harness ---------------------------------------------------------------
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    return res;
  };
  return res;
}

async function pay(pin) {
  const res = mockRes();
  await payWithWallet({ user: { id: 1 }, params: { companyId: '7' }, body: { pin } }, res);
  return res;
}

const PIN = '1234';
const PRICE = 150000; // DEFAULT_PRICE, since the fake AppSetting has no row.

(async () => {
  // 1. Happy path.
  resetState();
  state.pinHash = await hashSecret(PIN, 'pin');

  let res = await pay(PIN);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.remark, 'staffpay_subscription_active');
  assert.strictEqual(state.balance.toString(), '50000', 'exactly the price leaves the wallet');
  assert.strictEqual(state.subscriptions.length, 1);
  assert.strictEqual(state.subscriptions[0].status, 'active');
  assert.strictEqual(state.ledger.length, 1, 'one debit, one ledger row');
  assert.strictEqual(state.ledger[0].trx_type, '-');
  assert.strictEqual(Number(state.ledger[0].total_amount), PRICE);

  // The company name is PII and meta is not encrypted.
  const meta = JSON.stringify(state.ledger[0].meta);
  assert.ok(!meta.includes('Test Ltd'), 'no company name in meta');
  assert.ok(!JSON.stringify(state.ledger[0].details).includes('Test Ltd'), 'details are protected text');

  const walletPaidRow = state.subscriptions[0];
  const year = state.subscriptions[0];
  assert.strictEqual(year.expires_at.getFullYear(), year.starts_at.getFullYear() + 1);

  // 2. Double tap inside the window: no second debit, no second year.
  const balanceAfterFirst = state.balance.toString();
  res = await pay(PIN);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.balance.toString(), balanceAfterFirst, 'a second tap must not charge again');
  assert.strictEqual(state.subscriptions.length, 1);
  assert.strictEqual(state.ledger.length, 1);

  // 3. Short balance: nothing moves.
  resetState();
  state.pinHash = await hashSecret(PIN, 'pin');
  state.balance = new Prisma.Decimal('100.00');

  res = await pay(PIN);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.remark, 'insufficient_balance');
  assert.strictEqual(state.balance.toString(), '100', 'a failed payment leaves the wallet alone');
  assert.strictEqual(state.subscriptions.length, 0);
  assert.strictEqual(state.ledger.length, 0);

  // 4. Wrong PIN never reaches the wallet.
  resetState();
  state.pinHash = await hashSecret(PIN, 'pin');

  res = await pay('9999');
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.remark, 'invalid_pin');
  assert.strictEqual(state.balanceWrites, 0);
  assert.strictEqual(state.subscriptions.length, 0);

  // 5. The admin dashboard can tell the two rails apart. Support goes looking
  // for a Paystack transaction off this label, and a wallet payment has none.
  const { subscriptionSource } = require('../src/controllers/adminStaffPay.controller');

  assert.strictEqual(subscriptionSource(walletPaidRow), 'wallet');
  assert.strictEqual(subscriptionSource({ reference: 'SPSUBW-7-1-ab', raw_payload: null }), 'wallet');
  assert.strictEqual(subscriptionSource({ reference: 'SPSUB-7-1-ab', raw_payload: { status: 'success' } }), 'paystack');
  assert.strictEqual(subscriptionSource(null), 'paystack');

  // 6. Unverified business cannot subscribe at all.
  resetState();
  state.pinHash = await hashSecret(PIN, 'pin');
  state.verification = { status: 'pending' };

  res = await pay(PIN);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.remark, 'staffpay_not_verified');
  assert.strictEqual(state.balanceWrites, 0);

  console.log('✅ staffpay wallet subscription tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
