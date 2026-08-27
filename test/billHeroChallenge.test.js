// Run: node test/billHeroChallenge.test.js
//
// The challenge rules engine, without a database. Everything imported here is
// pure - `listChallenges` is the only function in the helper that talks to
// Prisma and it is deliberately not exercised.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  isRunning,
  lifecycle,
  rewardLabel,
  formatData,
  progressFor,
  isCompleted,
  publicChallenge,
  validateChallengeInput,
} = require('../src/helpers/billHeroChallenge.helper');

const base = {
  id: 1,
  title: 'Airtime Hero',
  description: 'Buy airtime 10 times',
  action_type: 'airtime',
  target: 10,
  reward_type: 'airtime',
  reward_value: 200,
  active: true,
  starts_at: null,
  ends_at: null,
  sort_order: 1,
};

const at = iso => new Date(iso);

// --- running window ---------------------------------------------------------

assert.strictEqual(isRunning(base, at('2026-08-12T10:00:00Z')), true, 'no dates = always running');
assert.strictEqual(isRunning({ ...base, active: false }, at('2026-08-12T10:00:00Z')), false, 'inactive never runs');

const dated = { ...base, starts_at: at('2026-08-10T00:00:00Z'), ends_at: at('2026-08-17T00:00:00Z') };

assert.strictEqual(isRunning(dated, at('2026-08-09T23:59:59Z')), false, 'before start');
assert.strictEqual(isRunning(dated, at('2026-08-10T00:00:00Z')), true, 'starts_at is inclusive');
assert.strictEqual(isRunning(dated, at('2026-08-16T23:59:59Z')), true, 'inside');
assert.strictEqual(isRunning(dated, at('2026-08-17T00:00:00Z')), false, 'ends_at is exclusive');

// The reason ends_at is exclusive: a handover pair must never both be live, or
// one week's progress pays out twice.
const first = { ...base, id: 1, ends_at: at('2026-08-17T00:00:00Z') };
const second = { ...base, id: 2, starts_at: at('2026-08-17T00:00:00Z') };
const handover = at('2026-08-17T00:00:00Z');

assert.strictEqual(
  [first, second].filter(c => isRunning(c, handover)).length,
  1,
  'exactly one challenge is live at the handover instant',
);

// Dates arriving as ISO strings (a Redis hit) behave the same as Date objects.
assert.strictEqual(
  isRunning({ ...base, starts_at: '2026-08-10T00:00:00.000Z' }, at('2026-08-09T12:00:00Z')),
  false,
  'string dates are parsed, not truthy-tested',
);

// --- lifecycle --------------------------------------------------------------

assert.strictEqual(lifecycle(base, at('2026-08-12T10:00:00Z')), 'active');
assert.strictEqual(lifecycle({ ...base, active: false }, at('2026-08-12T10:00:00Z')), 'inactive');
assert.strictEqual(lifecycle(dated, at('2026-08-01T10:00:00Z')), 'scheduled');
assert.strictEqual(lifecycle(dated, at('2026-08-20T10:00:00Z')), 'ended');

// --- progress ---------------------------------------------------------------

const counts = { airtime: 7, data: 2 };

assert.strictEqual(progressFor(base, counts), 7, 'airtime challenge reads the airtime count');
assert.strictEqual(progressFor({ ...base, action_type: 'data' }, counts), 2, 'data challenge reads the data count');
assert.strictEqual(progressFor(base, {}), 0, 'missing counts are zero, not NaN');

assert.strictEqual(isCompleted(base, counts), false, '7 of 10 is not done');
assert.strictEqual(isCompleted({ ...base, target: 7 }, counts), true, 'exactly on target counts');
assert.strictEqual(isCompleted({ ...base, target: 0 }, counts), false, 'a zero target pays nobody');

// A challenge that rewards a different rail from the one it counts - the whole
// point of splitting action_type from reward_type.
const crossed = { ...base, action_type: 'airtime', reward_type: 'data', reward_value: 1024, target: 5 };

assert.strictEqual(isCompleted(crossed, counts), true, 'progress follows action_type');
assert.strictEqual(rewardLabel(crossed), '1GB data', 'the label follows reward_type');

// --- labels -----------------------------------------------------------------

assert.strictEqual(formatData(500), '500MB');
assert.strictEqual(formatData(1024), '1GB');
assert.strictEqual(formatData(1536), '1.5GB');
assert.strictEqual(rewardLabel(base), '₦200 airtime');

// --- public shape -----------------------------------------------------------

const view = publicChallenge(dated, at('2026-08-12T10:00:00Z'));

assert.strictEqual(view.status, 'active');
assert.strictEqual(view.running, true);
assert.strictEqual(view.reward_label, '₦200 airtime');
assert.strictEqual(view.starts_at, '2026-08-10T00:00:00.000Z', 'dates go out as ISO strings');
assert.strictEqual(typeof view.id, 'number');

// --- validation -------------------------------------------------------------

const good = validateChallengeInput({
  title: 'Weekend Warrior',
  description: 'Buy data 3 times',
  action_type: 'data',
  target: 3,
  reward_type: 'airtime',
  reward_value: 500,
});

assert.ok(!good.error, `expected a clean parse, got ${good.error}`);
assert.strictEqual(good.data.target, 3);
assert.strictEqual(good.data.action_type, 'data');

assert.ok(validateChallengeInput({ ...base, title: '' }).error, 'empty title is refused');
assert.ok(validateChallengeInput({ ...base, action_type: 'electricity' }).error, 'unknown action type is refused');
assert.ok(validateChallengeInput({ ...base, target: 0 }).error, 'zero target is refused');
assert.ok(validateChallengeInput({ ...base, target: 2.5 }).error, 'fractional target is refused');
assert.ok(validateChallengeInput({ ...base, reward_value: -100 }).error, 'negative reward is refused');
assert.ok(validateChallengeInput({ ...base, reward_value: 9_999_999 }).error, 'absurd reward is refused');

assert.ok(
  validateChallengeInput({
    ...base,
    starts_at: '2026-08-17T00:00:00Z',
    ends_at: '2026-08-10T00:00:00Z',
  }).error,
  'an end before its start is refused',
);

// A partial patch may send one date and rely on the row for the other. Moving
// the end date behind the stored start is still a backwards window.
assert.ok(
  validateChallengeInput(
    { ends_at: '2026-08-01T00:00:00Z', _current_starts_at: at('2026-08-10T00:00:00Z') },
    { partial: true },
  ).error,
  'a patch is checked against the stored start date',
);

const patch = validateChallengeInput({ target: 12 }, { partial: true });

assert.ok(!patch.error, 'a partial patch does not demand every field');
assert.deepStrictEqual(Object.keys(patch.data), ['target'], 'a patch only carries what it was sent');

// Clearing a date is a real instruction, not a missing field.
const cleared = validateChallengeInput({ ends_at: null }, { partial: true });

assert.strictEqual(cleared.data.ends_at, null, 'null clears the end date');

console.log('billHeroChallenge: all assertions passed');
