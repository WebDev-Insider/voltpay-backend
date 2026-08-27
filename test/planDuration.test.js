/**
 * node test/planDuration.test.js
 *
 * No network. This is the file that decides what a customer is told a bundle
 * costs them in time, so the checks split into two halves that fail in opposite
 * directions:
 *
 *   - a validity read wrongly promises an expiry the provider never agreed to;
 *   - a validity not read at all sends every plan to one unnavigable tab, which
 *     is the exact failure the first version of the data picker shipped with.
 */
const assert = require('assert');

const {
  readDuration,
  durationLabel,
  durationBucket,
  stripDuration,
  toDays,
} = require('../src/funding/planDuration');

/* ------------------------------------------------- reading a stated validity */

// PairGate's own format, before they split the field out. Still live on cached
// rows and on anything they have not migrated.
assert.deepStrictEqual(readDuration('1GB (AWOOF Special) - 30 Days'), { days: 30, label: '30 days' });
assert.deepStrictEqual(readDuration('1GB (CG) - 7 Days'), { days: 7, label: '7 days' });
assert.deepStrictEqual(readDuration('500MB - 1 Day'), { days: 1, label: '1 day' });

// ClubKonnect states the tier instead of the count, and keeps its own wording:
// "Monthly" is not rewritten as "30 days". The 30 is ours, for bucketing, and
// printing it back as though the provider had said it is the thing this module
// exists to prevent.
assert.deepStrictEqual(readDuration('500 MB - Monthly (SME)'), { days: 30, label: 'Monthly' });
assert.deepStrictEqual(readDuration('1 GB - Weekly (SME)'), { days: 7, label: 'Weekly' });
assert.deepStrictEqual(readDuration('750MB Daily Plan'), { days: 1, label: 'Daily' });
assert.deepStrictEqual(readDuration('120GB - Yearly'), { days: 365, label: 'Yearly' });

// Spellings both rails actually produce.
assert.strictEqual(readDuration('2GB - 30days').days, 30);
assert.strictEqual(readDuration('2GB - 7-day plan').days, 7);
assert.strictEqual(readDuration('1GB - 24 hrs').days, 1, 'an hours bundle rounds up to a day');
assert.strictEqual(readDuration('1GB - 48 Hours').days, 2);
assert.strictEqual(readDuration('6GB - 2 Weeks').days, 14);
assert.strictEqual(readDuration('20GB - 3 Months').days, 90);
assert.strictEqual(readDuration('200GB - 1 Year').days, 365);

// The count wins over the tier when a name carries both - it is the more
// precise of the two, and it is the provider's own number.
assert.strictEqual(readDuration('1GB Monthly - 45 Days').days, 45);

/* ---------------------------------------------------- refusing to make one up */

// The rule: no duration stated, no duration claimed. Every one of these has to
// come back null so the plan ships with no expiry badge and lands in "All"
// rather than under a shelf somebody chose for it.
assert.strictEqual(readDuration('1GB (AWOOF Special)'), null, 'the post-change PairGate name');
assert.strictEqual(readDuration('230MB'), null);
assert.strictEqual(readDuration('1.5GB'), null, 'a decimal size is not a duration');
assert.strictEqual(readDuration('100 MB (GIFTING)'), null);
assert.strictEqual(readDuration('2GB + 100 Mins'), null, 'call minutes are not a validity');
assert.strictEqual(readDuration('1GB Weekend Special'), null, 'a weekend is a guess, not a statement');
assert.strictEqual(readDuration('2GB Night Plan'), null);
assert.strictEqual(readDuration(''), null);
assert.strictEqual(readDuration(null), null);
assert.strictEqual(readDuration(undefined), null);

/* ------------------------------------------- the number the provider hands us */

assert.strictEqual(toDays(30), 30);
assert.strictEqual(toDays('30'), 30, 'JSON can hand back either');
assert.strictEqual(toDays(0), 0);
assert.strictEqual(toDays(-1), 0, 'a negative duration is not a shorter plan, it is a bad row');
assert.strictEqual(toDays(null), 0);
assert.strictEqual(toDays('unlimited'), 0);

assert.strictEqual(durationLabel(1), '1 day');
assert.strictEqual(durationLabel(30), '30 days');
assert.strictEqual(durationLabel(90), '90 days');
assert.strictEqual(durationLabel(365), '1 year', '"365 days" reads like a typo');
assert.strictEqual(durationLabel(730), '2 years');
assert.strictEqual(durationLabel(0), '', 'no number, no claim');

/* ------------------------------------------------------------------ shelving */

assert.strictEqual(durationBucket(1), 'daily');
assert.strictEqual(durationBucket(2), 'daily');
assert.strictEqual(durationBucket(3), 'daily');
assert.strictEqual(durationBucket(7), 'weekly');
assert.strictEqual(durationBucket(14), 'weekly');
assert.strictEqual(durationBucket(30), 'monthly');
assert.strictEqual(durationBucket(60), 'monthly');
// Errs upward on purpose: a 90-day plan under "Monthly" reads "90 days" on its
// own tile and undersells itself, where the same plan under "Yearly" is a lie.
assert.strictEqual(durationBucket(90), 'monthly');
assert.strictEqual(durationBucket(365), 'yearly');
assert.strictEqual(durationBucket(0), '', 'unknown is its own answer, not "daily"');
assert.strictEqual(durationBucket(null), '');

/* --------------------------------------------------------- name for the tile */

// The duration comes out because the tile prints it on its own line. Left in,
// a ClubKonnect plan would say "Monthly" twice while a PairGate one said it once
// - the same product reading differently depending on which switch is flipped.
assert.strictEqual(stripDuration('1GB (AWOOF Special) - 30 Days'), '1GB (AWOOF Special)');
assert.strictEqual(stripDuration('500 MB - Monthly (SME)'), '500 MB (SME)');
assert.strictEqual(stripDuration('1 GB - Weekly (SME)'), '1 GB (SME)');
assert.strictEqual(stripDuration('2GB (30 Days)'), '2GB');
assert.strictEqual(stripDuration('N100 100MB - 1 day'), 'N100 100MB');

// Only a *delimited* duration comes out. The guard is the dash or the bracket,
// not the words - so a name that reads as a phrase is left exactly as written.
assert.strictEqual(stripDuration('1GB (AWOOF Special)'), '1GB (AWOOF Special)');
assert.strictEqual(stripDuration('230MB'), '230MB');
assert.strictEqual(stripDuration('1GB - Awoof'), '1GB - Awoof', 'a family is not a duration');
assert.strictEqual(stripDuration('Daily Data 500MB'), 'Daily Data 500MB', 'undelimited stays put');

// Never empty. A nameless tile in the grid is worse than a repeated word.
assert.strictEqual(stripDuration('30 Days'), '30 Days');
assert.strictEqual(stripDuration('Monthly'), 'Monthly');
assert.strictEqual(stripDuration(''), '');
assert.strictEqual(stripDuration(null), '');

console.log('✅ planDuration tests passed');
