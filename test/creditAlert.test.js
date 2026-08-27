// The credit-alert banner is built from a webhook payload whose sender field
// has moved between PaymentPoint payload versions. If the extraction drifts,
// every user gets "Someone sent you ..." and nobody notices until support does.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.PAYMENTPOINT_BUSINESS_ID = process.env.PAYMENTPOINT_BUSINESS_ID || 'biz_test';

const { extractSenderName, formatNaira } = require('../src/funding/funding.controller');

// --- sender name ---------------------------------------------------------
assert.strictEqual(extractSenderName({ sender: { name: 'John Doe' } }), 'John Doe');
assert.strictEqual(extractSenderName({ sender_name: 'Jane Doe' }), 'Jane Doe');
assert.strictEqual(extractSenderName({ payer_name: 'Ada Okoro' }), 'Ada Okoro');
assert.strictEqual(extractSenderName({ transaction: { sender: { name: 'Musa Bello' } } }), 'Musa Bello');
// Priority: the nested object wins over the flat alias.
assert.strictEqual(extractSenderName({ sender: { name: 'First' }, sender_name: 'Second' }), 'First');
// Whitespace collapsed, empty strings skipped, unknown sender still readable.
assert.strictEqual(extractSenderName({ sender: { name: '  John   Doe ' } }), 'John Doe');
assert.strictEqual(extractSenderName({ sender: { name: '' }, payer_name: 'Fallback' }), 'Fallback');
assert.strictEqual(extractSenderName({}), 'Someone');
assert.strictEqual(extractSenderName(null), 'Someone');
// Long names are truncated so the banner body stays one line.
assert.strictEqual(extractSenderName({ sender_name: 'x'.repeat(200) }).length, 80);

// --- amount --------------------------------------------------------------
assert.strictEqual(formatNaira('5000'), '₦5,000.00');
assert.strictEqual(formatNaira('5000.5'), '₦5,000.50');
assert.strictEqual(formatNaira('1234567.89'), '₦1,234,567.89');
assert.strictEqual(formatNaira('0.01'), '₦0.01');
assert.strictEqual(formatNaira('abc'), '₦0.00');
assert.strictEqual(formatNaira(null), '₦0.00');

// --- fails open ----------------------------------------------------------
// No Firebase credential configured here. A push must degrade to "false", not
// throw - the caller is a webhook that has already credited a wallet.
const { sendToUser, messagingAvailable } = require('../src/services/fcm.service');

assert.strictEqual(messagingAvailable(), false);

(async () => {
  assert.strictEqual(await sendToUser(1, { title: 'Money Received', body: 'x sent you ₦1.00' }), false);
  // Missing title/body is a caller bug, still must not throw.
  assert.strictEqual(await sendToUser(1, {}), false);
  console.log('✅ credit alert formatting + FCM fail-open tests passed');
})();
