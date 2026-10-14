// The Fund Account flow sends whatever cleanNin() lets through straight to
// PaymentPoint as idNumber. If this drifts loose, a malformed or partial NIN
// reaches a provider that will happily mint a permanent account number on it.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYMENTPOINT_BUSINESS_ID = process.env.PAYMENTPOINT_BUSINESS_ID || 'biz_test';

const { cleanNin } = require('../src/funding/funding.controller');

// --- accepted --------------------------------------------------------------
assert.strictEqual(cleanNin('12345678901'), '12345678901');
// Punctuation/whitespace a user might paste in is stripped before counting.
assert.strictEqual(cleanNin('123 4567 8901'), '12345678901');
assert.strictEqual(cleanNin('123-456-78901'), '12345678901');

// --- rejected ----------------------------------------------------------------
assert.strictEqual(cleanNin('1234567890'), null); // 10 digits
assert.strictEqual(cleanNin('123456789012'), null); // 12 digits
assert.strictEqual(cleanNin(''), null);
assert.strictEqual(cleanNin(null), null);
assert.strictEqual(cleanNin(undefined), null);
assert.strictEqual(cleanNin('abcdefghijk'), null); // letters, no digits at all

console.log('fundingNin.test.js passed');
