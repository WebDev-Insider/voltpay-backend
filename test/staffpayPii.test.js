/**
 * StaffPay company + staff PII columns.
 *
 * What must not break:
 *   1. A write never produces a plain-text column, and a read gets the exact
 *      value back. Payroll pays the account name the bank holds - a lossy
 *      round-trip sends someone's salary to a rejected transfer.
 *   2. A response never carries `*_enc` or `*_idx`. Shipping the ciphertext is
 *      most of the way to shipping the plaintext, and `publicCompany` /
 *      `publicStaff` are the only thing standing between a row and the client.
 *   3. Lookups are by blind index, and the index is stable across the ways a
 *      human types the same value.
 *
 * Run with: node test/staffpayPii.test.js
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  protectCompanyFields,
  protectStaffFields,
  publicCompany,
  publicStaff,
  publicPayrollRun,
} = require('../src/helpers/staffpayPii.helper');
const { blindIndex } = require('../src/helpers/pii.helper');

// --- company --------------------------------------------------------------
const companyInput = {
  name: 'Jade Edge Technology Ltd',
  address: '12 Admiralty Way, Lekki, Lagos',
  phone: '2348012345678',
  email: 'Support@JadeEdge.ng',
};
const companyCols = protectCompanyFields(companyInput);

for (const [field, value] of Object.entries(companyInput)) {
  assert.ok(companyCols[`${field}_enc`], `${field}_enc must be written`);
  assert.ok(!companyCols[`${field}_enc`].includes(value), `${field} must not survive as plain text`);
  assert.strictEqual(companyCols[field], undefined, `there is no plain ${field} column any more`);
}

// Only what we look up by gets an index; a name or an address never does.
assert.ok(companyCols.email_idx);
assert.ok(companyCols.phone_idx);
assert.strictEqual(companyCols.address_idx, undefined);

const company = publicCompany({ id: 7, owner_user_id: 3, cac_number: 'RC123', ...companyCols });
assert.deepStrictEqual(
  { name: company.name, address: company.address, phone: company.phone, email: company.email },
  companyInput,
  'every company field round-trips exactly',
);
assert.strictEqual(company.cac_number, 'RC123', 'non-PII columns pass through');
for (const key of Object.keys(company)) {
  assert.ok(!key.endsWith('_enc') && !key.endsWith('_idx'), `${key} must not reach the client`);
}

// --- staff ----------------------------------------------------------------
const staffInput = { full_name: 'Ada Obi', phone: '2348098765432', account_name: 'OBI ADA GRACE' };
const staffCols = protectStaffFields(staffInput);

assert.ok(!staffCols.full_name_enc.includes('Ada'));
assert.ok(staffCols.phone_idx, 'staff are deduplicated by phone, so it is indexed');
assert.strictEqual(staffCols.full_name_idx, undefined);

const staff = publicStaff({
  id: 11,
  account_number_enc: 'ciphertext',
  account_number_last4: '4321',
  bank_name: 'GTBank',
  ...staffCols,
});
assert.strictEqual(staff.full_name, 'Ada Obi');
assert.strictEqual(staff.account_name, 'OBI ADA GRACE', 'the resolved account name must come back verbatim');
assert.strictEqual(staff.account_number_last4, '4321');
assert.strictEqual(staff.account_number_enc, undefined, 'the full account number is never returned');

// --- payroll run responses ------------------------------------------------
// The run is returned with its items, and each item carries the staff row it
// pays - that is the easiest place to leak ciphertext back to the app.
const run = publicPayrollRun({
  id: 4,
  status: 'successful',
  company: { id: 7, ...companyCols },
  items: [{ id: 1, amount: '150000', staff: { id: 11, ...staffCols } }],
});
assert.strictEqual(run.company.name, 'Jade Edge Technology Ltd');
assert.strictEqual(run.items[0].staff.full_name, 'Ada Obi');
assert.strictEqual(run.items[0].amount, '150000', 'the item itself is untouched');
assert.strictEqual(run.items[0].staff.full_name_enc, undefined);
assert.strictEqual(publicPayrollRun({ id: 5, status: 'queued' }).id, 5, 'a run with no items still maps');

// --- partial updates ------------------------------------------------------
// A patch that only touches the phone must not blank the other columns.
const patch = protectStaffFields({ phone: '2348011112222' });
assert.deepStrictEqual(Object.keys(patch).sort(), ['phone_enc', 'phone_idx']);

// An empty value clears the column rather than storing the empty string.
assert.strictEqual(protectStaffFields({ account_name: '' }).account_name_enc, null);

// --- blind index stability ------------------------------------------------
assert.strictEqual(
  companyCols.email_idx,
  blindIndex('support@jadeedge.ng', 'email'),
  'email lookups must survive the caller capitalising it',
);
assert.strictEqual(
  staffCols.phone_idx,
  blindIndex('+234 809 876 5432', 'mobile'),
  'phone lookups must survive spacing and a leading +',
);
assert.notStrictEqual(
  companyCols.email_idx,
  blindIndex('support@jadeedge.ng', 'mobile'),
  'the domain is part of the index, so the same string in two fields does not collide',
);

// --- nothing in, nothing out ----------------------------------------------
assert.deepStrictEqual(protectCompanyFields({}), {});
assert.strictEqual(publicCompany(null), null);
assert.strictEqual(publicStaff(null), null);

console.log('✅ staffpayPii tests passed');
