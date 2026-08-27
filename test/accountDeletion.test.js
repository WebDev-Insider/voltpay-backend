/**
 * Account deletion.
 *
 * The thing that must not break: between the two stages, every column on User
 * that can name a person has to be nulled. A stage that misses one leaves that
 * column in the database forever, because the row is only ever picked up while
 * it still matches, and after that nothing looks at it again. So the field list
 * is checked against the schema itself, not against a copy of it: add a new
 * *_enc / *_idx column to User and this test fails until one of the two stages
 * is told about it.
 *
 * The second thing that must not break is the split itself. Stage one runs
 * thirty days after closure and stage two five years after it, because s.19 of
 * the Money Laundering (Prevention and Prohibition) Act 2022 makes the customer
 * identification record something VoltPay must keep for five years after the
 * relationship ends. Move an identity column into stage one and the record is
 * destroyed 4 years 11 months early; move a credential into stage two and a
 * closed account keeps a live password for five years. Both are pinned here.
 *
 * Also pins the grace window (30 days, and never 0 from an empty env var), the
 * retention floor, and the terminal status response.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { __test } = require('../src/controllers/account.controller');
const { DELETED, isDeleted, inactiveResponse } = require('../src/helpers/accountStatus.helper');

const {
  CREDENTIAL_FIELDS,
  IDENTITY_FIELDS,
  RETAINED_PII_FIELDS,
  preserveLegacyIdentity,
  deletionDueAt,
  deletionGraceDays,
  retentionYears,
  retentionCutoff,
} = __test;

// --- field coverage -------------------------------------------------------

const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const userModel = schema.slice(schema.indexOf('model User {'));
const userBody = userModel.slice(0, userModel.indexOf('\n}'));

const protectedColumns = userBody
  .split('\n')
  .map(line => line.trim().split(/\s+/)[0])
  .filter(name => /_enc$|_idx$/.test(name));

const wiped = { ...CREDENTIAL_FIELDS, ...IDENTITY_FIELDS };

assert.ok(protectedColumns.length > 8, 'schema parse failed - no protected columns found');
for (const column of protectedColumns) {
  assert.ok(column in wiped, `${column} is not cleared by either deletion stage`);
}

// Credentials and the columns that predate the *_enc pair. Listed by hand
// because nothing in their names marks them as personal. All stage one: none of
// them is the identification record, and a closed account must not keep a live
// credential or a reachable contact detail for a day longer than the grace
// period.
for (const column of [
  'firstname', 'lastname', 'username', 'email', 'mobile',
  'address', 'state', 'city', 'zip', 'image',
  'username_idx', 'email_idx', 'mobile_idx',
  'pin', 'password', 'recovery_hash', 'biometric_hash', 'fcm_device_id', 'fcm_token_enc',
  'active_session_id', 'active_device_id', 'deletion_reason',
]) {
  assert.ok(column in CREDENTIAL_FIELDS, `${column} is not cleared when the grace period expires`);
}

// The identification record. Kept through stage one - erasing it there would
// destroy what MLPPA 2022 s.19 requires be preserved for five years - and gone
// in stage two.
for (const field of RETAINED_PII_FIELDS) {
  assert.ok(`${field}_enc` in IDENTITY_FIELDS, `${field}_enc is never erased`);
  assert.ok(!(`${field}_enc` in CREDENTIAL_FIELDS), `${field}_enc is erased before the retention period is over`);
}
// No blind index survives stage one: they are what a login and a lookup resolve
// through, so the retained record must be reachable by user id only.
for (const column of protectedColumns.filter(c => c.endsWith('_idx'))) {
  assert.ok(column in CREDENTIAL_FIELDS, `${column} still resolves an account that has been closed`);
}

// Every one of them must be nulled, not blanked: a '' still occupies a unique
// index, so a second purged account would collide on username_idx.
for (const [column, value] of Object.entries(wiped)) {
  assert.strictEqual(value, null, `${column} must be set to null, not ${JSON.stringify(value)}`);
}

// The ledger is what the account is reconciled from and what a CBN audit is
// answered from. It is not either stage's to touch.
for (const column of ['balance', 'balance_mac', 'created_at', 'country_code', 'id']) {
  assert.ok(!(column in wiped), `${column} must survive a purge`);
}

// --- legacy rows ----------------------------------------------------------
// A row that never went through the encryption backfill holds its identity in
// the plain columns alone. Stage one nulls those, so it has to carry them into
// the ciphertext columns on the way past or there is nothing left to retain.

const legacy = preserveLegacyIdentity({ firstname: 'Ada', email: 'ada@example.com', mobile: '2348012345678' });
assert.ok(legacy.firstname_enc && legacy.email_enc && legacy.mobile_enc, 'legacy identity is not preserved');
assert.ok(!('firstname_idx' in legacy), 'a closed account must not stay findable by contact details');
assert.notStrictEqual(legacy.email_enc, 'ada@example.com', 'identity must be retained as ciphertext, never plain');

// An already-encrypted row is left alone - re-encrypting would overwrite the
// stored ciphertext with whatever the stale plain column still held.
assert.deepStrictEqual(
  preserveLegacyIdentity({ email: 'stale@example.com', email_enc: 'existing-ciphertext' }),
  {},
  'an encrypted row must not be re-encrypted from its plain column',
);

// --- admin close ----------------------------------------------------------
// The admin endpoint used to walk every foreign key back to users and DELETE,
// which took the ledger with it. It routes through the same anonymiser now, and
// nothing in that file may go back to destroying financial rows.

const adminController = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'controllers', 'admin.controller.js'),
  'utf8',
);

for (const forbidden of [
  'walletTransaction.deleteMany',
  'fundingTransaction.deleteMany',
  'user.delete(',
  '$executeRawUnsafe',
]) {
  assert.ok(
    !adminController.includes(forbidden),
    `admin.controller must not ${forbidden} - it destroys records the ledger is reconciled from`,
  );
}
// An admin close is the same act as a self-service one, so it runs the same
// teardown: column wipe, profile image, live StaffPay virtual accounts, cache,
// and the notice to the address on file.
assert.ok(adminController.includes('purgeUser'), 'admin close must reuse the account lifecycle teardown');
assert.strictEqual(typeof require('../src/controllers/account.controller').anonymizeUserData, 'function');
assert.strictEqual(typeof require('../src/controllers/account.controller').purgeUser, 'function');

// --- grace window ---------------------------------------------------------

delete process.env.ACCOUNT_DELETION_GRACE_DAYS;
assert.strictEqual(deletionGraceDays(), 30);

// An empty or junk value must not read as "wipe immediately".
process.env.ACCOUNT_DELETION_GRACE_DAYS = '';
assert.strictEqual(deletionGraceDays(), 30);
process.env.ACCOUNT_DELETION_GRACE_DAYS = 'soon';
assert.strictEqual(deletionGraceDays(), 30);

process.env.ACCOUNT_DELETION_GRACE_DAYS = '30';
const from = new Date('2026-08-11T10:00:00.000Z');
assert.strictEqual(deletionDueAt(from).toISOString(), '2026-09-10T10:00:00.000Z');
// The caller's date must not be mutated - it is also the requested_at stamp.
assert.strictEqual(from.toISOString(), '2026-08-11T10:00:00.000Z');
delete process.env.ACCOUNT_DELETION_GRACE_DAYS;

// --- retention floor ------------------------------------------------------
// Five years is the statutory minimum, so the env var may only lengthen it.
// Shortening it would destroy records that cannot be recovered.

delete process.env.KYC_RETENTION_YEARS;
assert.strictEqual(retentionYears(), 5);
process.env.KYC_RETENTION_YEARS = '1';
assert.strictEqual(retentionYears(), 5, 'the retention period must not be shortened below the statutory five years');
process.env.KYC_RETENTION_YEARS = 'forever';
assert.strictEqual(retentionYears(), 5);
process.env.KYC_RETENTION_YEARS = '7';
assert.strictEqual(retentionYears(), 7);
assert.strictEqual(
  retentionCutoff(new Date('2026-08-12T10:00:00.000Z')).toISOString(),
  '2019-08-12T10:00:00.000Z',
);
delete process.env.KYC_RETENTION_YEARS;

const now = new Date('2026-08-12T10:00:00.000Z');
assert.strictEqual(retentionCutoff(now).toISOString(), '2021-08-12T10:00:00.000Z');
assert.strictEqual(now.toISOString(), '2026-08-12T10:00:00.000Z', 'retentionCutoff must not mutate its argument');

// --- terminal status ------------------------------------------------------

assert.strictEqual(isDeleted({ status: DELETED }), true);
assert.strictEqual(isDeleted({ status: '3' }), true, 'status survives a JSON cache round-trip as a string');
assert.strictEqual(isDeleted({ status: 2 }), false);

const deleted = inactiveResponse({ status: DELETED });
assert.strictEqual(deleted.code, 403);
assert.strictEqual(deleted.body.remark, 'account_deleted');
assert.strictEqual(deleted.body.data.can_reactivate, false);

console.log('✅ accountDeletion tests passed');
