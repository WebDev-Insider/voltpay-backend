/**
 * node test/bills.controller.test.js
 *
 * No network: covers the two pure decisions in the bills flow - which phone
 * numbers are allowed to reach the provider, and which tab a data plan lands
 * under. A wrong answer on the first one sends airtime to the wrong person; a
 * wrong answer on the second hides a bundle behind a tab the UI does not draw.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.MYSUBWALLET_API_KEY = process.env.MYSUBWALLET_API_KEY || 'msw_test';

const { normalizeNgPhone, buildPlanTabs } = require('../src/controllers/bills.controller');

/* phone normalization */

// Every shape a Nigerian keyboard produces collapses to the same two forms.
for (const input of ['08031234567', '2348031234567', '+2348031234567', '8031234567', '0803 123 4567']) {
  const out = normalizeNgPhone(input);
  assert.ok(out, `expected ${input} to parse`);
  assert.strictEqual(out.local, '08031234567', `local form for ${input}`);
  assert.strictEqual(out.msisdn, '2348031234567', `msisdn form for ${input}`);
}

// All four networks' prefix ranges.
assert.ok(normalizeNgPhone('07011234567'), '070 is a valid prefix');
assert.ok(normalizeNgPhone('08101234567'), '081 is a valid prefix');
assert.ok(normalizeNgPhone('09011234567'), '090 is a valid prefix');
assert.ok(normalizeNgPhone('09111234567'), '091 is a valid prefix');

// Rejects. Sending any of these to the provider debits a wallet against a
// number that cannot receive the value.
assert.strictEqual(normalizeNgPhone('0603123456'), null, 'unknown prefix');
assert.strictEqual(normalizeNgPhone('080312345'), null, 'too short');
assert.strictEqual(normalizeNgPhone('080312345678'), null, 'too long');
assert.strictEqual(normalizeNgPhone('0803123456a'), null, 'letters are not digits');
assert.strictEqual(normalizeNgPhone(''), null);
assert.strictEqual(normalizeNgPhone(null), null);
assert.strictEqual(normalizeNgPhone(undefined), null);

/* plan tabs - by validity, with the family split as the fallback */

// Shaped plans, as the provider module hands them over: the validity already
// read out of the name into `duration_days`.
const mtn = [
  { id: '19', name: '500MB (SME)', amount: '500.00', plan_type: 'SME', duration_days: 30 },
  { id: '20', name: '1GB (SME)', amount: '840.00', plan_type: 'SME', duration_days: 30 },
  { id: '31', name: '1GB (CG)', amount: '790.00', plan_type: 'CG', duration_days: 7 },
  { id: '44', name: '230MB', amount: '250.00', plan_type: 'GIFTING', duration_days: 1 },
  { id: '52', name: '1GB (AWOOF)', amount: '700.00', plan_type: 'AWOOF', duration_days: 365 },
];
const built = buildPlanTabs(mtn);

assert.strictEqual(built.axis, 'validity');
assert.deepStrictEqual(built.tab_order, ['hot', 'daily', 'weekly', 'monthly', 'yearly', 'all']);
assert.strictEqual(built.tab_labels.daily, 'Daily');
assert.strictEqual(built.tab_labels.monthly, 'Monthly');

// The regression guard, and the reason the first version of this screen was
// wrong: no tab may be empty. An empty tab is invisible in the UI, so a plan
// that lands in one is a product nobody can buy.
for (const key of built.tab_order) {
  assert.ok(built.tabs[key].length > 0, `${key} tab must not be empty`);
}

assert.deepStrictEqual(built.tabs.monthly.map(p => p.id), ['19', '20']);
assert.deepStrictEqual(built.tabs.weekly.map(p => p.id), ['31']);
assert.strictEqual(built.tabs.all.length, 5, 'every plan stays reachable under all');

// `category` and the tab a plan sits in are the same string. They are assigned
// in one place precisely so they cannot drift - a plan labelled for a tab it is
// not in is a filter that quietly lies.
for (const key of built.tab_order) {
  if (key === 'hot' || key === 'all') continue;
  for (const plan of built.tabs[key]) {
    assert.strictEqual(plan.category, key, `${plan.id} is filed under ${key}`);
  }
}

// The returned `plans` carry the category too - it is the same array the tabs
// are cut from, so the client can filter locally and get the same answer.
assert.strictEqual(built.plans.length, 5);
assert.strictEqual(built.plans.find(p => p.id === '52').category, 'yearly');

// The family is not lost, it is just no longer the axis. It has to survive on
// the plan or the picker can no longer tell a 1GB SME from a 1GB CG.
assert.strictEqual(built.plans.find(p => p.id === '31').plan_type, 'CG');

// Hot is the cheap end by price, and is a view over the plans rather than a
// relabel - the category has to survive so the tab it belongs to still matches.
assert.strictEqual(built.tabs.hot[0].id, '44', 'cheapest plan leads Hot');
assert.strictEqual(built.tabs.hot[0].category, 'daily', 'hot must not overwrite the real tab');

// A network that only sells monthly bundles gets one validity tab, not four.
const smaller = buildPlanTabs([
  { id: '1', name: '1GB', amount: '300.00', plan_type: 'GIFTING', duration_days: 30 },
]);
assert.deepStrictEqual(smaller.tab_order, ['hot', 'monthly', 'all']);

// A plan whose validity nobody stated must still be buyable. It lands in `all`,
// carries no shelf, and - critically - is never guessed into one.
const mixed = buildPlanTabs([
  { id: '1', name: '1GB', amount: '300.00', plan_type: 'SME', duration_days: 30 },
  { id: '2', name: '2GB', amount: '600.00', plan_type: 'SME', duration_days: 30 },
  { id: '3', name: '5GB Night', amount: '900.00', plan_type: 'SME', duration_days: 0 },
]);
assert.deepStrictEqual(mixed.tab_order, ['hot', 'monthly', 'all']);
assert.strictEqual(mixed.plans.find(p => p.id === '3').category, 'other');
assert.strictEqual(mixed.tabs.all.length, 3, 'the unshelved plan is still on sale');

/* the fallback - what happens when the duration is not there */

// A catalogue with no readable validity must not produce four empty tabs and an
// unnavigable "All". It falls back to the family split, which is what this
// screen shipped with and what a 30-minute-old cached catalogue still looks like
// for the first half hour after a deploy.
const noDuration = [
  { id: '19', name: '500MB (SME)', amount: '500.00', plan_type: 'SME' },
  { id: '20', name: '1GB (SME)', amount: '840.00', plan_type: 'SME' },
  { id: '31', name: '1GB (CG)', amount: '790.00', plan_type: 'CG' },
  { id: '44', name: '230MB', amount: '250.00', plan_type: 'GIFTING' },
  { id: '52', name: '1GB (AWOOF)', amount: '700.00', plan_type: 'AWOOF' },
];
const legacy = buildPlanTabs(noDuration);

assert.strictEqual(legacy.axis, 'family');
assert.deepStrictEqual(legacy.tab_order, ['hot', 'sme', 'cg', 'gifting', 'awoof', 'all']);
assert.strictEqual(legacy.tab_labels.sme, 'SME');
assert.strictEqual(legacy.tab_labels.gifting, 'Gifting');
assert.deepStrictEqual(legacy.tabs.sme.map(p => p.id), ['19', '20']);
for (const key of legacy.tab_order) {
  assert.ok(legacy.tabs[key].length > 0, `${key} tab must not be empty`);
}

// Half a catalogue with a duration is not enough to shelve the other half by
// validity: below the coverage floor the family split wins outright.
const patchy = buildPlanTabs([
  { id: '1', name: '1GB (SME)', amount: '300.00', plan_type: 'SME', duration_days: 30 },
  { id: '2', name: '2GB (SME)', amount: '600.00', plan_type: 'SME' },
  { id: '3', name: '1GB (CG)', amount: '280.00', plan_type: 'CG' },
]);
assert.strictEqual(patchy.axis, 'family', 'one plan in three is not a validity catalogue');
assert.deepStrictEqual(patchy.tab_order, ['hot', 'sme', 'cg', 'all']);

// A family the provider adds later is appended, not dropped: a new tier has to
// be on sale the day it appears, not the day we notice it.
const future = buildPlanTabs([
  { id: '1', name: '1GB (SME)', amount: '840.00', plan_type: 'SME' },
  { id: '2', name: '1GB (NEWTIER)', amount: '500.00', plan_type: 'NEWTIER' },
]);
assert.deepStrictEqual(future.tab_order, ['hot', 'sme', 'newtier', 'all']);
assert.strictEqual(future.tab_labels.newtier, 'Newtier', 'unknown family still gets a readable label');

// Neither a family nor a validity: still buyable, under `all`.
const orphan = buildPlanTabs([{ id: '9', name: '150GB', amount: '90000.00', plan_type: '' }]);
assert.deepStrictEqual(orphan.tab_order, ['hot', 'all']);
assert.strictEqual(orphan.tabs.all.length, 1);

// An empty catalogue must not throw on the way to an empty screen.
const none = buildPlanTabs([]);
assert.deepStrictEqual(none.tab_order, ['hot', 'all']);
assert.strictEqual(none.axis, 'family');

/* the family filter - what the validity axis gave back */

// Losing the family tabs made the longest tab longer, so the family returns as a
// filter inside a tab. The labels are the server's job: the app must never have
// to decide that "CG" is shown as "CG" and "GIFTING" as "Gifting".
assert.deepStrictEqual(built.family_labels, {
  SME: 'SME',
  CG: 'CG',
  GIFTING: 'Gifting',
  AWOOF: 'Awoof',
});

// Sent only on the validity axis. On the family fallback the tab bar already is
// this control, and shipping both would put the same list on screen twice.
assert.deepStrictEqual(legacy.family_labels, {}, 'no family filter under family tabs');
assert.deepStrictEqual(patchy.family_labels, {});

// The filter narrows a tab, so what it offers has to be derivable from that
// tab's plans alone - the app reads it off them rather than off this map, which
// is why every family named here must be matchable against a plan's plan_type.
for (const key of Object.keys(built.family_labels)) {
  assert.ok(
    built.plans.some(p => p.plan_type === key),
    `${key} is offered as a filter and must match a plan`,
  );
}

// An unknown family is labelled, not dropped - same rule as the tabs.
const newTier = buildPlanTabs([
  { id: '1', name: '1GB (SME)', amount: '840.00', plan_type: 'SME', duration_days: 30 },
  { id: '2', name: '1GB (NEWTIER)', amount: '500.00', plan_type: 'NEWTIER', duration_days: 30 },
]);
assert.strictEqual(newTier.axis, 'validity');
assert.deepStrictEqual(newTier.family_labels, { SME: 'SME', NEWTIER: 'Newtier' });

// A plan with no family contributes no filter entry, and is not filed under a
// blank one. It stays visible whenever the filter is off, which is the default.
const unfamilied = buildPlanTabs([
  { id: '1', name: '1GB (SME)', amount: '840.00', plan_type: 'SME', duration_days: 30 },
  { id: '2', name: '100MB', amount: '100.00', plan_type: '', duration_days: 30 },
]);
assert.deepStrictEqual(unfamilied.family_labels, { SME: 'SME' });
assert.strictEqual(unfamilied.tabs.monthly.length, 2, 'a family-less plan is still in its tab');

// One family is not a choice. The app hides the control on this, and it must be
// able to tell from the payload alone.
const single = buildPlanTabs([
  { id: '1', name: '1GB (SME)', amount: '840.00', plan_type: 'SME', duration_days: 30 },
  { id: '2', name: '2GB (SME)', amount: '1500.00', plan_type: 'SME', duration_days: 7 },
]);
assert.deepStrictEqual(single.family_labels, { SME: 'SME' });

console.log('✅ bills.controller tests passed');
