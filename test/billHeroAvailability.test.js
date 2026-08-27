// The Bill Hero lock decides two different things with one predicate: whether
// the screen opens now, and whether a recharge made at some past instant earned
// anything. Getting the second wrong is the expensive one - it either hands out
// rewards for activity during a shutdown, or silently voids a week of a user's
// progress - and it is invisible until somebody complains, so it gets a check.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  openAt,
  evaluate,
  DEFAULT_CONFIG,
  __test: { lagosClock, toMinutes, withinSchedule, inWindow, normalizeConfig },
} = require('../src/helpers/billHeroAvailability.helper');

const { tallyRows } = require('../src/controllers/billHero.controller');

/** Lagos is UTC+1, so 09:00 WAT is 08:00Z. */
const wat = (iso) => new Date(`${iso}+01:00`);

// --- clock ---------------------------------------------------------------
// 2026-08-14 is a Friday. ISO weekday 5.
assert.strictEqual(lagosClock(wat('2026-08-14T09:30:00')).day, 5);
assert.strictEqual(lagosClock(wat('2026-08-14T09:30:00')).minutes, 9 * 60 + 30);

// Sunday must be 7, not 0 - the whole day list is ISO.
assert.strictEqual(lagosClock(wat('2026-08-16T12:00:00')).day, 7);

// A minute past midnight WAT is still the previous UTC day. Reading the UTC
// clock here would put Friday-night activity on Thursday's schedule.
assert.strictEqual(lagosClock(wat('2026-08-15T00:30:00')).day, 6);

assert.strictEqual(toMinutes('09:05'), 545);
assert.strictEqual(toMinutes('24:00'), null);
assert.strictEqual(toMinutes('9:5'), null);
assert.strictEqual(toMinutes(''), null);

// --- default is open -----------------------------------------------------
assert.strictEqual(openAt(DEFAULT_CONFIG, wat('2026-08-11T03:00:00')), true);
assert.strictEqual(evaluate(DEFAULT_CONFIG, wat('2026-08-11T03:00:00')).open, true);

// --- scheduled days ------------------------------------------------------
const weekendOnly = normalizeConfig({
  mode: 'scheduled_days',
  days: [5, 6, 7], // Fri, Sat, Sun
  start_time: '09:00',
  end_time: '21:00',
});

assert.strictEqual(withinSchedule(weekendOnly, wat('2026-08-14T09:00:00')), true, 'Friday 09:00 is the first open minute');
assert.strictEqual(withinSchedule(weekendOnly, wat('2026-08-14T21:00:00')), true, 'end time is inclusive');
assert.strictEqual(withinSchedule(weekendOnly, wat('2026-08-14T21:01:00')), false);
assert.strictEqual(withinSchedule(weekendOnly, wat('2026-08-14T08:59:00')), false);
assert.strictEqual(withinSchedule(weekendOnly, wat('2026-08-13T12:00:00')), false, 'Thursday is not in the day list');
assert.strictEqual(openAt(weekendOnly, wat('2026-08-13T12:00:00')), false);

// Shut on a Thursday reads as "scheduled", not "locked" - it reopens on its
// own, and an admin must not go hunting for a lock nobody threw.
assert.strictEqual(evaluate(weekendOnly, wat('2026-08-13T12:00:00')).reason, 'outside_schedule');

// A window that wraps midnight is a real promotion shape (Friday night into
// Saturday), and must not collapse to "never open".
const lateNight = normalizeConfig({
  mode: 'scheduled_days',
  days: [5],
  start_time: '20:00',
  end_time: '02:00',
});

assert.strictEqual(withinSchedule(lateNight, wat('2026-08-14T23:00:00')), true, 'Friday night');
assert.strictEqual(withinSchedule(lateNight, wat('2026-08-15T01:00:00')), true, 'spills into Saturday');
assert.strictEqual(withinSchedule(lateNight, wat('2026-08-15T03:00:00')), false);
assert.strictEqual(withinSchedule(lateNight, wat('2026-08-15T23:00:00')), false, 'Saturday night is not Friday night');

// --- windows -------------------------------------------------------------
// No bounds is "no window set", never "all of time".
assert.strictEqual(inWindow(null, null, new Date()), false);
assert.strictEqual(inWindow('2026-08-14T00:00:00Z', null, wat('2026-08-15T00:00:00')), true);
assert.strictEqual(inWindow(null, '2026-08-14T00:00:00Z', wat('2026-08-13T00:00:00')), true);

// Half-open, so a lock ending at 09:00 and one starting at 09:00 do not both
// own that instant.
assert.strictEqual(inWindow('2026-08-14T09:00:00Z', '2026-08-14T10:00:00Z', new Date('2026-08-14T10:00:00Z')), false);

// --- manual lock ---------------------------------------------------------
const manual = normalizeConfig({
  mode: 'manual_lock',
  locked_at: '2026-08-14T10:00:00Z',
});

assert.strictEqual(openAt(manual, new Date('2026-08-14T09:59:00Z')), true, 'before the lock was thrown');
assert.strictEqual(openAt(manual, new Date('2026-08-14T10:00:00Z')), false);
assert.strictEqual(openAt(manual, new Date('2027-01-01T00:00:00Z')), false, 'a manual lock does not expire');
assert.strictEqual(evaluate(manual, new Date('2026-08-14T11:00:00Z')).reason, 'manual_lock');

// A lifted lock must stay lifted going forward and stay shut behind - this is
// the bit that stops an unlock retroactively paying out the whole shutdown.
const lifted = normalizeConfig({
  mode: 'always_on',
  lock_periods: [{ from: '2026-08-14T10:00:00Z', to: '2026-08-14T14:00:00Z' }],
});

assert.strictEqual(openAt(lifted, new Date('2026-08-14T12:00:00Z')), false, 'during the spell');
assert.strictEqual(openAt(lifted, new Date('2026-08-14T15:00:00Z')), true, 'after the unlock');
assert.strictEqual(openAt(lifted, new Date('2026-08-14T09:00:00Z')), true, 'before the lock');

// --- scheduled lock window ----------------------------------------------
const holiday = normalizeConfig({
  mode: 'always_on',
  locked_from: '2026-12-24T00:00:00Z',
  locked_until: '2026-12-27T00:00:00Z',
});

assert.strictEqual(openAt(holiday, new Date('2026-12-25T12:00:00Z')), false);
assert.strictEqual(openAt(holiday, new Date('2026-12-27T00:00:00Z')), true, 'reopens the instant it expires');
assert.strictEqual(evaluate(holiday, new Date('2026-12-25T12:00:00Z')).reason, 'scheduled_lock');

// --- normalize is forgiving ---------------------------------------------
// A hand-edited settings row must not take the promotion down.
const junk = normalizeConfig({ mode: 'nonsense', days: 'everyday', start_time: '99:99' });
assert.strictEqual(junk.mode, 'always_on');
assert.deepStrictEqual(junk.days, [1, 2, 3, 4, 5, 6, 7]);
assert.strictEqual(junk.start_time, '00:00');
assert.strictEqual(openAt(junk, new Date()), true);

// Out-of-range days are dropped rather than believed.
assert.deepStrictEqual(normalizeConfig({ days: [0, 3, 9, 3] }).days, [3]);

// --- progress is not counted while locked -------------------------------
// The whole point of the historic predicate: the same rows tally differently
// depending on whether Bill Hero was open when they happened.
const rows = [
  { user_id: 1, trx: 'A', meta: { type: 'airtime' }, created_at: wat('2026-08-14T12:00:00') }, // Friday, open
  { user_id: 1, trx: 'B', meta: { type: 'airtime' }, created_at: wat('2026-08-13T12:00:00') }, // Thursday, shut
  { user_id: 1, trx: 'C', meta: { type: 'data' }, created_at: wat('2026-08-15T10:00:00') },    // Saturday, open
];

const unrestricted = tallyRows(rows, []).get(1);
assert.strictEqual(unrestricted.airtime_count, 2, 'with no config every recharge counts');
assert.strictEqual(unrestricted.data_count, 1);

const gated = tallyRows(rows, [], weekendOnly).get(1);
assert.strictEqual(gated.airtime_count, 1, 'the Thursday recharge earned nothing');
assert.strictEqual(gated.data_count, 1);
assert.strictEqual(gated.points, 20);

// A refund still wins over an open window - the lock narrows the count, it
// never widens it.
const refunded = tallyRows(rows, [{ meta: { reversal_of: 'A' } }], weekendOnly).get(1);
assert.strictEqual(refunded.airtime_count, 0);

console.log('billHeroAvailability: all assertions passed');
