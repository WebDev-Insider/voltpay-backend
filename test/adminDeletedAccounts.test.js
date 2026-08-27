/**
 * The Deleted Accounts screen.
 *
 * What must not break: the stage an account is shown at. "Anonymised" and
 * "fully purged" look the same to a careless read - both have status DELETED -
 * but they are five years apart, and an admin who reads one as the other either
 * tells a regulator the record is gone when it is not, or goes looking for a
 * record that no longer exists.
 *
 * Also pins that the purge date is closure + the retention period, and that
 * search still finds a row whose blind indexes were dropped at stage one.
 */

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { __test } = require('../src/controllers/adminDeletedAccounts.controller');
const { protect, protectText } = require('../src/helpers/pii.helper');
const { DELETED, DEACTIVATED } = require('../src/helpers/accountStatus.helper');

const { stageOf, purgeDueAt, buildWhere, matches, serialize } = __test;

// --- stages ---------------------------------------------------------------

assert.strictEqual(stageOf({ status: DEACTIVATED }), 'pending');
assert.strictEqual(stageOf({ status: DELETED, email_enc: 'ciphertext' }), 'anonymised');
assert.strictEqual(stageOf({ status: DELETED }), 'purged');
// One surviving column is still a retained identity - a row is only purged when
// there is nothing left of the person at all.
assert.strictEqual(stageOf({ status: DELETED, mobile_enc: 'ciphertext' }), 'anonymised');

// --- purge date -----------------------------------------------------------

delete process.env.KYC_RETENTION_YEARS;
assert.strictEqual(
  purgeDueAt({ deleted_at: new Date('2026-08-12T09:00:00.000Z') }).toISOString(),
  '2031-08-12T09:00:00.000Z',
  'the identification record is due five years after closure',
);
// Still counting down: an account that has not reached stage one has no date.
assert.strictEqual(purgeDueAt({ deleted_at: null }), null);

// --- filters --------------------------------------------------------------
// Every clause is an AND entry rather than a second `OR` key: Prisma keeps one
// OR per object, so a stage filter written that way would silently replace the
// base "is this account closing at all" clause and list live accounts.

const base = buildWhere({});
assert.ok(Array.isArray(base.AND) && base.AND.length === 1, 'unfiltered view is the base clause alone');
assert.ok(base.AND[0].OR.some(clause => clause.status === DELETED));

const pending = buildWhere({ stage: 'pending' });
assert.ok(pending.AND.some(clause => clause.deletion_scheduled_at?.not === null));

const ranged = buildWhere({ stage: '', from: new Date('2026-01-01'), to: new Date('2026-02-01') });
const rangeClause = ranged.AND.find(clause => clause.OR?.[0]?.deletion_requested_at);
assert.ok(rangeClause, 'a date range must match either the request date or the closure date');
assert.ok(rangeClause.OR.some(clause => clause.deleted_at));

// --- retained identity ----------------------------------------------------
// The row an admin has to be able to find and read: no blind index survives
// stage one, so this is the only way back to it apart from the user id.

const row = {
  id: 42,
  status: DELETED,
  country_code: 'NG',
  balance: 0,
  created_at: new Date('2024-03-01T00:00:00.000Z'),
  deletion_requested_at: new Date('2026-07-01T00:00:00.000Z'),
  deletion_scheduled_at: null,
  deleted_at: new Date('2026-07-31T00:00:00.000Z'),
  deletion_reason: protectText('Moving to another bank'),
  firstname_enc: protect('Ada', 'name').enc,
  email_enc: protect('ada@example.com', 'email').enc,
  mobile_enc: protect('2348012345678', 'mobile').enc,
};

const serialized = serialize(row);

assert.strictEqual(serialized.stage, 'anonymised');
assert.strictEqual(serialized.email, 'ada@example.com', 'the retained record has to be readable or the screen is pointless');
assert.strictEqual(serialized.mobile, '2348012345678');
assert.strictEqual(serialized.reason, 'Moving to another bank');
assert.strictEqual(serialized.purge_due_at, '2031-07-31T00:00:00.000Z');

assert.ok(matches(serialized, 'ada@example.com'));
assert.ok(matches(serialized, '80123'), 'a partial phone number is what an admin actually has');
assert.ok(matches(serialized, 'ada'));
assert.ok(!matches(serialized, 'someone-else@example.com'));

// A purged row has nothing left to match, and must not render as blank strings
// that read like a loading bug.
const purged = serialize({ id: 43, status: DELETED, deleted_at: new Date('2020-01-01T00:00:00.000Z') });

assert.strictEqual(purged.stage, 'purged');
assert.strictEqual(purged.email, null);
assert.strictEqual(purged.firstname, null);
assert.ok(!matches(purged, 'ada'));

console.log('✅ adminDeletedAccounts tests passed');
