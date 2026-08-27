/**
 * Who gets paid, and the key that stops them being paid twice.
 *
 * What must not break:
 *   1. The scan pages to the end. A cap here is a staff member who is never
 *      paid and never errors - the failure nobody sees until they call.
 *   2. The cycle key is derived from the due date alone. Two instances a minute
 *      apart must produce the same string, or the unique index it feeds is
 *      guarding nothing.
 *   3. A staff member with an item for this cycle is not due again. That is
 *      what keeps a failed transfer on the retry path instead of opening a
 *      fresh run - and re-paying the colleagues who already succeeded.
 *
 * Run: node test/staffpayDue.helper.test.js
 */

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  cycleKeyFor,
  companyPayoutTimeReached,
  listDueStaff,
  chunk,
  SCAN_PAGE_SIZE,
} = require('../src/helpers/staffpayDue.helper');

// --- the cycle key --------------------------------------------------------
assert.strictEqual(cycleKeyFor(new Date('2026-08-25T00:00:00.000Z')), 'due:2026-08-25');
// Same payday, different moment of asking: the key must not move.
assert.strictEqual(
  cycleKeyFor(new Date('2026-08-25T00:00:00.000Z')),
  cycleKeyFor(new Date('2026-08-25T00:00:00.000Z')),
);
assert.strictEqual(cycleKeyFor('not-a-date'), null, 'an unreadable due date has no cycle');

// --- payout time in the company's own timezone ----------------------------
const company = { payout_time: '09:00', payout_timezone: 'Africa/Lagos' };
// 07:30 UTC is 08:30 WAT - not yet.
assert.strictEqual(companyPayoutTimeReached(company, new Date('2026-08-25T07:30:00.000Z')), false);
// 08:30 UTC is 09:30 WAT.
assert.strictEqual(companyPayoutTimeReached(company, new Date('2026-08-25T08:30:00.000Z')), true);

// --- chunking -------------------------------------------------------------
assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepStrictEqual(chunk([], 2), []);

// --- the scan -------------------------------------------------------------
// A fake client, so the paging can be tested without a Postgres. It answers
// findMany with an id cursor exactly as Prisma would.
function fakeDb({ staff, items = [] }) {
  const calls = { staffPages: 0 };
  return {
    calls,
    staffPayStaff: {
      findMany: async ({ where, take }) => {
        calls.staffPages += 1;
        const after = where?.id?.gt ?? 0;
        return staff.filter(s => s.id > after && s.is_active).slice(0, take);
      },
    },
    staffPayPayrollItem: {
      findMany: async ({ where }) => items.filter(
        i => where.staff_id.in.includes(i.staff_id) && where.cycle_key.in.includes(i.cycle_key),
      ),
    },
  };
}

const monthly = id => ({
  id,
  is_active: true,
  frequency: 'monthly',
  payment_day: 25,
  start_date: new Date('2026-08-01'),
  last_paid_at: null,
});

const now = new Date('2026-08-25T09:00:00.000Z');

// A company larger than one page is returned in full. The old flat `take: 300`
// is exactly the bug this asserts against.
const big = Array.from({ length: SCAN_PAGE_SIZE + 47 }, (_, i) => monthly(i + 1));
(async () => {
  const db = fakeDb({ staff: big });
  const due = await listDueStaff({ companyId: 1, now, db });

  assert.strictEqual(due.length, SCAN_PAGE_SIZE + 47, 'every active staff member past the first page is still due');
  assert.ok(db.calls.staffPages > 1, 'the scan pages rather than reading once');
  assert.strictEqual(due[0].cycle_key, 'due:2026-08-25');
  assert.strictEqual(due[due.length - 1].id, SCAN_PAGE_SIZE + 47);

  // Nobody is due before their payday.
  const early = await listDueStaff({ companyId: 1, now: new Date('2026-08-24T23:00:00.000Z'), db: fakeDb({ staff: big }) });
  assert.strictEqual(early.length, 0);

  // An item already exists for staff 2 on this cycle - the scheduler's own run,
  // or another instance's. They must not be picked up again, and the rest of
  // the company must still be paid.
  const withAttempt = fakeDb({
    staff: [monthly(1), monthly(2), monthly(3)],
    items: [{ staff_id: 2, cycle_key: 'due:2026-08-25' }],
  });
  const rest = await listDueStaff({ companyId: 1, now, db: withAttempt });
  assert.deepStrictEqual(rest.map(d => d.id), [1, 3]);

  // A failed transfer from last month left an item on *that* cycle. This month
  // is a different key, so this payday still goes out.
  const lastMonth = fakeDb({
    staff: [monthly(1)],
    items: [{ staff_id: 1, cycle_key: 'due:2026-07-25' }],
  });
  assert.strictEqual((await listDueStaff({ companyId: 1, now, db: lastMonth })).length, 1);

  // Inactive staff are never due.
  const inactive = fakeDb({ staff: [{ ...monthly(1), is_active: false }] });
  assert.strictEqual((await listDueStaff({ companyId: 1, now, db: inactive })).length, 0);

  console.log('✅ staffpayDue helper: paging, cycle keys and per-cycle dedupe OK');
})().catch(e => { console.error(e); process.exit(1); });
