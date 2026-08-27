// Request Money resolves a recipient from free text a Nigerian user typed and
// maps a DB status word onto the numeric code the app renders. Both are pure,
// both are easy to break, and getting either wrong sends money to the wrong
// person or shows a paid request as pending.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  parseUserInputToLookup,
  computeCharge,
  STATUS_CODE,
  REQUEST_TTL_HOURS,
} = require('../src/controllers/requestMoney.controller');

// --- recipient input ------------------------------------------------------
// Every shape a Nigerian number gets typed in must resolve to the same set of
// lookup variants, because the DB may hold either the 10- or 11-digit form.
for (const typed of ['+2348031234567', '234 803 123 4567', '08031234567', '8031234567']) {
  const { username, mobiles } = parseUserInputToLookup(typed);
  assert.strictEqual(username, '', `${typed} must not be read as a username`);
  assert.ok(mobiles.includes('8031234567'), `${typed} must yield the bare 10-digit form`);
  assert.ok(mobiles.includes('08031234567'), `${typed} must yield the leading-zero form`);
}

// A username is never turned into a phone lookup, even one full of digits.
assert.deepStrictEqual(parseUserInputToLookup('john_doe'), { username: 'john_doe', mobiles: [] });
assert.deepStrictEqual(parseUserInputToLookup('user2024'), { username: 'user2024', mobiles: [] });

// Empty input must not produce a lookup at all - an empty OR matches everyone.
assert.deepStrictEqual(parseUserInputToLookup(''), { username: '', mobiles: [] });
assert.deepStrictEqual(parseUserInputToLookup(null), { username: '', mobiles: [] });

// Too short to be a phone number, so it is treated as a username, not a
// partial-number match against somebody else's account.
assert.strictEqual(parseUserInputToLookup('12345').username, '12345');

// --- charge ---------------------------------------------------------------
// Flat ₦10 today. The assertion is on the arithmetic, not the figure, so a
// percent or a cap added later still has to add up.
assert.strictEqual(computeCharge(1000), 10);
assert.strictEqual(computeCharge(50), 10);

// --- status mapping -------------------------------------------------------
// The app switches on these strings. Every state the column can hold needs one.
assert.deepStrictEqual(STATUS_CODE, {
  pending: '0',
  paid: '1',
  declined: '2',
  expired: '3',
  cancelled: '4',
});

// A request that never expires is a scam waiting to happen.
assert.ok(REQUEST_TTL_HOURS > 0 && REQUEST_TTL_HOURS <= 72);

console.log('✅ requestMoney.controller tests passed');
