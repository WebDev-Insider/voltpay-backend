/**
 * Money trail filters.
 *
 * The thing that must not break: funding rows are only ever pulled with
 * `credited_at: null`. A credited funding writes a wallet_transactions row
 * under the SAME reference in the same transaction, so dropping that guard
 * shows every deposit twice and doubles the reported total - on the one page an
 * admin uses to decide whether a user was double debited.
 *
 * Also guards: the `to` date covering its whole calendar day (a range that
 * stops at midnight hides everything a user did that day), the ledger's
 * encrypted counterparty text being decrypted rather than shown as base64, and
 * a bare user id still resolving after deletion has erased the email and phone.
 */

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { protectText } = require('../src/helpers/pii.helper');
const { __test } = require('../src/controllers/adminTransactions.controller');

const { buildWheres, sortByNewest, dateRange, normalizeNgPhone, mapWallet, mapFunding } = __test;

// --- the double-count guard ------------------------------------------------

for (const query of [{}, { q: 'VP123' }, { status: 'failed' }, { from: '2026-01-01', to: '2026-01-31' }]) {
  const w = buildWheres(query, []);
  assert.strictEqual(
    w.funding.credited_at,
    null,
    `funding must stay uncredited-only, or deposits are counted twice: ${JSON.stringify(query)}`
  );
}

// A user filter must not overwrite it either - `common` is spread after.
assert.strictEqual(buildWheres({ userId: '7' }, []).funding.credited_at, null);
assert.strictEqual(buildWheres({ userId: '7' }, []).funding.user_id, 7);

// --- date range ------------------------------------------------------------

assert.strictEqual(dateRange('', ''), null);

const range = dateRange('2026-01-01', '2026-01-31');
assert.strictEqual(range.gte.getDate(), 1);
assert.strictEqual(range.lte.getDate(), 31);
assert.strictEqual(range.lte.getHours(), 23, 'the "to" day must be covered to its last second');
assert.strictEqual(dateRange('', '2026-01-31').gte, undefined);
// A typo in the box must not become a range that matches nothing silently.
assert.strictEqual(dateRange('not-a-date', ''), null);

// --- search resolution -----------------------------------------------------

assert.strictEqual(normalizeNgPhone('08012345678'), '2348012345678');
assert.strictEqual(normalizeNgPhone('+234 801 234 5678'), '2348012345678');
assert.strictEqual(normalizeNgPhone('8012345678'), '2348012345678');

// A reference search still matches on the reference when nothing resolved to a
// user, and widens to that user's rows when something did.
const refOnly = buildWheres({ q: 'VP-9' }, []);
assert.deepStrictEqual(refOnly.wallet.OR, [{ trx: { contains: 'VP-9', mode: 'insensitive' } }]);

const byUser = buildWheres({ q: 'jane@example.com' }, [41]);
assert.ok(byUser.wallet.OR.some(c => c.user_id && c.user_id.in.includes(41)));

// A deleted account has no email or phone left, so the id is the only handle on
// it. Payouts reach the owner two relations away, through the company - and
// still match on the reference, since a bare number can be either.
const byId = buildWheres({ q: '41' }, [41]);
assert.deepStrictEqual(byId.payout.OR, [
  { reference: { contains: '41', mode: 'insensitive' } },
  { payroll_run: { company: { owner_user_id: { in: [41] } } } },
]);
assert.deepStrictEqual(buildWheres({ userId: '41' }, []).payout.payroll_run.company.owner_user_id, 41);

// --- direction narrows the sources -----------------------------------------

const debits = buildWheres({ direction: '-' }, []);
assert.strictEqual(debits.creditOnly, true, 'a debit filter must drop the credit-only sources');
assert.strictEqual(debits.wallet.trx_type, '-');
assert.strictEqual(buildWheres({ direction: '+' }, []).debitOnly, true);
assert.strictEqual(buildWheres({}, []).wallet.trx_type, undefined);

// Ledger status lives in a JSON field, written capitalised.
assert.deepStrictEqual(buildWheres({ status: 'failed' }, []).wallet.other_data, {
  path: ['feedback'],
  equals: 'Failed',
});

// --- merge order -----------------------------------------------------------

const merged = sortByNewest([
  { ref: 'b', created_at: '2026-02-01T10:00:00.000Z' },
  { ref: 'a', created_at: '2026-03-01T10:00:00.000Z' },
  { ref: 'c', created_at: '2026-01-01T10:00:00.000Z' },
]);
assert.deepStrictEqual(merged.map(r => r.ref), ['a', 'b', 'c'], 'newest first across sources');

// --- mappers ---------------------------------------------------------------

const walletRow = {
  id: 9,
  user_id: 41,
  trx: 'VP-9',
  trx_type: '-',
  amount: '1000',
  charge: '10.5',
  total_amount: '1010.5',
  remark: 'request_money',
  details: protectText('Paid money request from Jane Doe'),
  other_data: { title: 'Request Money', subtitle: protectText('Jane Doe'), feedback: 'Successful' },
  meta: { receiver_trx: 'VP-10' },
  created_at: new Date('2026-02-01T10:00:00.000Z'),
};

const wallet = mapWallet(walletRow);
assert.strictEqual(wallet.description, 'Paid money request from Jane Doe', 'ledger text must be decrypted');
assert.strictEqual(wallet.counterparty, 'Jane Doe');
assert.ok(!wallet.description.startsWith('enc:'), 'an admin must never be shown ciphertext');
assert.strictEqual(wallet.status, 'successful');
assert.strictEqual(wallet.total_amount, '1010.50');
assert.strictEqual(wallet.created_at, '2026-02-01T10:00:00.000Z');

// A row written before other_data.feedback existed still reads as settled - it
// only exists because the money moved.
assert.strictEqual(mapWallet({ ...walletRow, other_data: {} }).status, 'successful');

const funding = mapFunding({
  id: 3,
  user_id: 41,
  tx_ref: 'FND-3',
  amount: '5000',
  status: 'failed',
  created_at: new Date('2026-02-02T10:00:00.000Z'),
});
assert.strictEqual(funding.direction, '+');
assert.strictEqual(funding.status, 'failed');
assert.match(funding.description, /never credited/);

console.log('✅ adminTransactions tests passed');
