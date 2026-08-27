// A support ticket is found by whatever the admin types, and that lookup runs
// against a blind index - so if a phone number is normalized differently on the
// way in than on the way out, the ticket becomes unsearchable. The status and
// priority parsers decide what an admin action actually does, and both accept
// words from the dashboard and digits from the app.
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  STATUS,
  parseStatus,
  parsePriority,
  normalizeNgPhone,
  serializeMessage,
} = require('../src/controllers/support.controller');

// --- phone normalization --------------------------------------------------
// Every shape the form accepts has to index to the same 234 number.
for (const typed of ['08031234567', '8031234567', '+234 803 123 4567', '2348031234567']) {
  assert.strictEqual(normalizeNgPhone(typed), '2348031234567', `bad normalization for ${typed}`);
}
assert.strictEqual(normalizeNgPhone(''), '');
assert.strictEqual(normalizeNgPhone(null), '');

// --- status parsing -------------------------------------------------------
assert.strictEqual(parseStatus('0'), STATUS.OPEN);
assert.strictEqual(parseStatus('Open'), STATUS.OPEN);
assert.strictEqual(parseStatus('In Progress'), STATUS.IN_PROGRESS);
assert.strictEqual(parseStatus('in_progress'), STATUS.IN_PROGRESS);
assert.strictEqual(parseStatus('resolved'), STATUS.RESOLVED);
assert.strictEqual(parseStatus('3'), STATUS.CLOSED);
// Unknown must be null, not 0: a typo would otherwise reopen a closed ticket.
assert.strictEqual(parseStatus('finished'), null);
assert.strictEqual(parseStatus(''), null);

// --- priority parsing -----------------------------------------------------
assert.strictEqual(parsePriority('3'), 3);
assert.strictEqual(parsePriority('High'), 3);
assert.strictEqual(parsePriority('medium'), 2);
// Anything unrecognised is Low - the safe default for a queue sort.
assert.strictEqual(parsePriority('urgent'), 1);
assert.strictEqual(parsePriority(undefined), 1);

// --- message serialization ------------------------------------------------
// The app colours staff replies from admin_id === "1" and falls back to
// ticket.name for the user's own messages, so both halves must be present.
const ticket = { id: 7, ticket: 'VP-SUP-20260805-001', name_enc: null };
const adminMessage = serializeMessage(
  { id: 11, ticket_id: 7, is_admin: true, is_internal: false, admin_name: 'Ada', message: 'hello', attachments: [], created_at: new Date() },
  ticket
);
assert.strictEqual(adminMessage.admin_id, '1');
assert.strictEqual(adminMessage.admin.name, 'Ada');
assert.strictEqual(adminMessage.ticket, null);

const userMessage = serializeMessage(
  {
    id: 12,
    ticket_id: 7,
    is_admin: false,
    is_internal: false,
    admin_name: null,
    message: 'hi',
    attachments: [{ url: 'https://x.ufs.sh/f/abc', name: 'receipt.png', size: 10 }],
    created_at: new Date(),
  },
  ticket
);
assert.strictEqual(userMessage.admin_id, null);
assert.strictEqual(userMessage.ticket.ticket, 'VP-SUP-20260805-001');
assert.strictEqual(userMessage.attachments[0].attachment, 'https://x.ufs.sh/f/abc');
assert.strictEqual(userMessage.attachments[0].name, 'receipt.png');
// Attachment ids only have to be unique inside one thread - the app uses them
// to mark which thumbnail is downloading.
assert.notStrictEqual(userMessage.attachments[0].id, adminMessage.id);

console.log('✅ support.controller tests passed');
