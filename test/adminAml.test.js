// The AML report is what a CBN/NFIU filing gets built from, so the failure mode
// here is not a wrong number on a dashboard - it is a movement that should have
// been reported and was not. Everything asserted below is a pure decision: the
// thresholds, the three rules, and what the export is allowed to carry.
//
//   node test/adminAml.test.js

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { __test } = require('../src/controllers/adminRisk.controller');
const { thresholds, scanMovements, toCsv, csvEscape, EXPORT_COLUMNS } = __test;

const AML_ENV = [
  'AML_SINGLE_THRESHOLD',
  'AML_DAILY_THRESHOLD',
  'AML_STRUCTURING_COUNT',
  'AML_STRUCTURING_FLOOR',
  'AML_STRUCTURING_FLOOR_RATIO',
];

const clearEnv = () => AML_ENV.forEach(k => delete process.env[k]);

/** A normalised movement, the one shape every money source reduces to. */
const move = (subject, value, at, { direction = 'out', ref = `r${value}`, label = 'send_money' } = {}) => ({
  subject,
  ref,
  direction,
  value,
  at: new Date(at),
  label,
});

/* ----------------------------------------------------------- thresholds */

clearEnv();

{
  const t = thresholds();

  assert.strictEqual(t.single, 5_000_000, 'CTR line defaults to ₦5m');
  assert.strictEqual(t.daily, 10_000_000, 'daily line defaults to ₦10m');
  assert.strictEqual(t.structuring_count, 5);

  // The bug this defends: the floor used to be hardcoded at HALF the single
  // line. Five movements of ₦2.5m is ₦12.5m, which already clears the ₦10m
  // daily line - so every structuring row was a row the aggregate report had
  // already produced, and the section could never surface an account on its own.
  assert.strictEqual(t.structuring_floor, 1_000_000, 'floor defaults to a fifth of the single line');
  assert.ok(
    t.structuring_floor * t.structuring_count < t.daily,
    'the default band must be able to fire without tripping the daily rule'
  );
  assert.strictEqual(t.structuring_independent, true);
}

{
  // The old numbers, set deliberately. The report does not re-tune itself - an
  // operator may want a narrow band - but it has to SAY that the section is
  // dead, which is what the screen renders off this flag.
  process.env.AML_STRUCTURING_FLOOR = '2500000';

  const t = thresholds();

  assert.strictEqual(t.structuring_floor, 2_500_000, 'an absolute floor wins over the ratio');
  assert.strictEqual(t.structuring_independent, false, 'floor × count ≥ daily is self-reported, not silently fixed');
  clearEnv();
}

{
  // Moving the CTR line moves the band with it, so a regulator raising one
  // number does not leave the structuring rule calibrated to the old one.
  process.env.AML_SINGLE_THRESHOLD = '2000000';

  assert.strictEqual(thresholds().structuring_floor, 400_000, 'the ratio tracks the single line');

  process.env.AML_STRUCTURING_FLOOR_RATIO = '0.5';
  assert.strictEqual(thresholds().structuring_floor, 1_000_000, 'an explicit ratio is used');

  // A ratio of 1 or more is not a band, it is the CTR rule again; 0 or negative
  // is nonsense. Both fall back rather than producing a rule that cannot fire.
  process.env.AML_STRUCTURING_FLOOR_RATIO = '1.5';
  assert.strictEqual(thresholds().structuring_floor, 400_000, 'a ratio ≥ 1 falls back to the default');

  process.env.AML_STRUCTURING_FLOOR_RATIO = '0';
  assert.strictEqual(thresholds().structuring_floor, 400_000, 'a zero ratio falls back');

  process.env.AML_STRUCTURING_FLOOR_RATIO = 'wat';
  assert.strictEqual(thresholds().structuring_floor, 400_000, 'garbage falls back');
  clearEnv();
}

/* ----------------------------------------------------- the three rules */

const T = { single: 5_000_000, daily: 10_000_000, structuring_count: 5, structuring_floor: 1_000_000 };

{
  // Large: at the line, not just over it. A ₦5,000,000 transfer against a
  // ₦5,000,000 CTR threshold is reportable, and `>` instead of `>=` is how that
  // gets missed by exactly one naira.
  const r = scanMovements(
    [
      move(1, 5_000_000, '2026-08-10T09:00:00Z'),
      move(2, 4_999_999.99, '2026-08-10T09:00:00Z'),
      move(3, 9_000_000, '2026-08-10T10:00:00Z', { direction: 'in', label: 'receive_money' }),
    ],
    T,
    200
  );

  assert.strictEqual(r.large_count, 2, 'landing exactly on the line is reportable');
  assert.deepStrictEqual(
    r.large.map(x => x.user_id),
    [1, 3]
  );
  assert.strictEqual(r.large[0].amount, '5000000.00', 'amount is a fixed-2 string, not a float');
  assert.strictEqual(r.large[1].direction, 'in', 'a credit is reportable too - a CTR is not a debit rule');
}

{
  // The subject column is the caller's, because the two sources link to
  // different screens. Everything else about the rules is identical, which is
  // the entire reason there is one scanner and not two.
  const movements = [move(42, 6_000_000, '2026-08-10T09:00:00Z')];

  const wallet = scanMovements(movements, T, 200, 'user_id');
  const staffpay = scanMovements(movements, T, 200, 'company_id');

  assert.strictEqual(wallet.large[0].user_id, 42);
  assert.strictEqual(staffpay.large[0].company_id, 42);
  assert.strictEqual(staffpay.large[0].user_id, undefined, 'a StaffPay row must not carry a user_id key');
  assert.strictEqual(wallet.large_count, staffpay.large_count, 'same rules, whatever the subject is called');
}

{
  // Aggregate: many movements, one account, one day, past the daily line. None
  // of these is individually reportable.
  const day = '2026-08-10T';
  const r = scanMovements(
    [
      move(1, 4_000_000, `${day}08:00:00Z`),
      move(1, 4_000_000, `${day}12:00:00Z`),
      move(1, 2_000_000, `${day}18:00:00Z`),
      // Same account, next day. Must not be rolled into the day above - if the
      // bucket key dropped the date, ₦14.5m would report as one enormous day.
      move(1, 4_500_000, '2026-08-11T08:00:00Z'),
    ],
    T,
    200
  );

  assert.strictEqual(r.large_count, 0, 'no single movement crossed the CTR line');
  assert.strictEqual(r.aggregate_count, 1, 'a day is a day - the second one stays under on its own');
  assert.strictEqual(r.aggregate[0].date, '2026-08-10');
  assert.strictEqual(r.aggregate[0].count, 3);
  assert.strictEqual(r.aggregate[0].total, '10000000.00');
}

{
  // Structuring: five movements sitting in the band. `near_threshold` counts
  // only what is AT the floor and BELOW the single line - a movement over the
  // line is already a CTR, and counting it here would file the same money twice
  // under a rule about staying hidden.
  const day = '2026-08-12T';
  const r = scanMovements(
    [
      move(7, 1_000_000, `${day}08:00:00Z`),
      move(7, 1_200_000, `${day}09:00:00Z`),
      move(7, 1_400_000, `${day}10:00:00Z`),
      move(7, 1_100_000, `${day}11:00:00Z`),
      move(7, 1_300_000, `${day}12:00:00Z`),
      move(7, 900_000, `${day}13:00:00Z`), // under the floor: not part of the pattern
    ],
    T,
    200
  );

  assert.strictEqual(r.structuring_count, 1);
  assert.strictEqual(r.structuring[0].near_threshold_count, 5, 'only the in-band movements count');
  assert.strictEqual(r.structuring[0].total, '6900000.00', 'the total is the whole day, in-band or not');
  assert.strictEqual(r.aggregate_count, 0, 'and the day never reached the daily line');
}

{
  const r = scanMovements(
    [
      move(8, 6_000_000, '2026-08-12T08:00:00Z'),
      move(8, 1_000_000, '2026-08-12T09:00:00Z'),
      move(8, 1_000_000, '2026-08-12T10:00:00Z'),
      move(8, 1_000_000, '2026-08-12T11:00:00Z'),
      move(8, 1_000_000, '2026-08-12T12:00:00Z'),
    ],
    T,
    200
  );

  assert.strictEqual(r.large_count, 1);
  assert.strictEqual(r.structuring_count, 0, 'the ₦6m movement is a CTR, not a fifth near-threshold movement');
}

{
  // The headline count. One ₦12m transfer is a large row AND an aggregate day
  // for the same person - adding the three report lengths reported one
  // situation as two flagged accounts.
  const r = scanMovements([move(3, 12_000_000, '2026-08-10T09:00:00Z')], T, 200);

  assert.strictEqual(r.large_count, 1);
  assert.strictEqual(r.aggregate_count, 1);
  assert.strictEqual(r.subjects.size, 1, 'one account, however many rules it tripped');
}

{
  // Two accounts on the same day must not share a bucket, and two days for one
  // account must not merge. The key is subject+day, and a bug in either half is
  // invisible in a single-account fixture.
  const r = scanMovements(
    [
      move(1, 6_000_000, '2026-08-10T09:00:00Z'),
      move(2, 6_000_000, '2026-08-10T09:00:00Z'),
      move(1, 6_000_000, '2026-08-11T09:00:00Z'),
    ],
    T,
    200
  );

  assert.strictEqual(r.large_count, 3);
  assert.strictEqual(r.subjects.size, 2, 'two distinct accounts');
  assert.strictEqual(r.aggregate_count, 0, 'each account-day totalled ₦6m, under the ₦10m line');
}

{
  // The list is capped for the screen; the COUNT is not. A truncated list that
  // also reported a truncated count would understate the filing.
  const many = Array.from({ length: 12 }, (_, i) => move(100 + i, 6_000_000, '2026-08-10T09:00:00Z'));
  const r = scanMovements(many, T, 5);

  assert.strictEqual(r.large.length, 5, 'the page is capped');
  assert.strictEqual(r.large_count, 12, 'the count is the truth');
  assert.strictEqual(r.subjects.size, 12, 'and so is the distinct-account tally');
}

{
  // UTC, because the day boundary decides which report a movement lands in and
  // the ISO date is what the screen renders. WAT is UTC+1, so a 23:30Z movement
  // is "tomorrow" locally - the two must not disagree between a dev laptop and
  // the server.
  const r = scanMovements(
    [move(1, 5_000_000, '2026-08-10T23:30:00Z'), move(1, 5_000_000, '2026-08-11T00:30:00Z')],
    T,
    200
  );

  assert.strictEqual(r.aggregate_count, 0, 'the two movements are on different days in UTC');
}

/* ---------------------------------------------------------- the export */

{
  // The export is the easiest artefact in this codebase to email to the wrong
  // person, so what it CANNOT carry is the assertion that matters. No name, no
  // email, no phone, no account number, and none of the ledger free-text fields
  // that name a counterparty.
  const forbidden = [
    'details',
    'other_data',
    'subtitle',
    'name',
    'firstname',
    'lastname',
    'username',
    'email',
    'mobile',
    'phone',
    'account_number',
    'account_name',
    'bvn',
    'nin',
  ];

  for (const column of EXPORT_COLUMNS) {
    assert.ok(!forbidden.includes(column), `export column "${column}" carries identity`);
  }

  assert.ok(EXPORT_COLUMNS.includes('account_id'), 'a row has to be traceable to an account');
  // Without both, `account_id` 12 is ambiguous: user 12 and company 12 are
  // different subjects, and merging them in a spreadsheet is a misfiling.
  assert.ok(EXPORT_COLUMNS.includes('account_type'), 'user vs company must be on the row');
  assert.ok(EXPORT_COLUMNS.includes('source'), 'wallet vs staffpay must be on the row');
}

{
  assert.strictEqual(csvEscape('plain'), 'plain');
  assert.strictEqual(csvEscape(null), '', 'a null cell is empty, not the string "null"');
  assert.strictEqual(csvEscape(0), '0', 'zero is a value');
  assert.strictEqual(csvEscape('a,b'), '"a,b"');
  assert.strictEqual(csvEscape('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvEscape('two\nlines'), '"two\nlines"');

  const csv = toCsv([{ date: '2026-08-10', account_id: 4, category: 'send, money' }], ['date', 'account_id', 'category']);

  assert.strictEqual(csv, 'date,account_id,category\n2026-08-10,4,"send, money"\n');
}

clearEnv();

console.log('adminAml.test.js OK');
