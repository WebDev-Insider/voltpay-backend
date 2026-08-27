/**
 * StaffPay company and staff PII.
 *
 * Same rule as the User table: nothing identifying is stored in plain text.
 * These values must stay readable - a payout needs the account name, a support
 * email needs an address to send to - so they are AES-GCM ciphertext in `*_enc`
 * with a keyed blind index in `*_idx` where we look a row up by value, not
 * one-way hashes.
 *
 * Staff bank account numbers were already encrypted (`account_number_enc`);
 * what this covers is the names, phones, addresses and the resolved account
 * name that sat beside them in the clear.
 */
const { protect, reveal } = require('./pii.helper');

// field -> blind-index domain. Add a field here and both helpers pick it up.
const COMPANY_PII_FIELDS = {
  name: 'name',
  email: 'email',
  phone: 'mobile',
  address: 'address',
};

// Only these are ever looked up by value.
const COMPANY_INDEXED_FIELDS = new Set(['email', 'phone']);

const STAFF_PII_FIELDS = {
  full_name: 'name',
  phone: 'mobile',
  account_name: 'name',
};

// A company's staff list is deduplicated by phone, so that one needs an index.
const STAFF_INDEXED_FIELDS = new Set(['phone']);

function protectFields(input, fields, indexed) {
  const data = {};
  for (const [field, domain] of Object.entries(fields)) {
    if (!(field in input)) continue;
    const { enc, idx } = protect(input[field], domain);
    data[`${field}_enc`] = enc;
    if (indexed.has(field)) data[`${field}_idx`] = idx;
  }
  return data;
}

function revealFields(row, fields) {
  const out = {};
  for (const field of Object.keys(fields)) {
    const enc = row[`${field}_enc`];
    if (!enc) { out[field] = ''; continue; }
    try {
      out[field] = reveal(enc);
    } catch (e) {
      // A single unreadable column must not take down a payroll listing. Log
      // the row id only - the whole point of this file is that the value never
      // reaches a log.
      console.error(`❌ Failed to decrypt ${field}:`, e?.message || e);
      out[field] = '';
    }
  }
  return out;
}

/** Strip the storage columns so a response never ships ciphertext. */
function stripped(row, fields) {
  const out = { ...row };
  for (const field of Object.keys(fields)) {
    delete out[`${field}_enc`];
    delete out[`${field}_idx`];
  }
  return out;
}

const protectCompanyFields = input => protectFields(input || {}, COMPANY_PII_FIELDS, COMPANY_INDEXED_FIELDS);
const revealCompanyFields = row => (row ? revealFields(row, COMPANY_PII_FIELDS) : {});

const protectStaffFields = input => protectFields(input || {}, STAFF_PII_FIELDS, STAFF_INDEXED_FIELDS);
const revealStaffFields = row => (row ? revealFields(row, STAFF_PII_FIELDS) : {});

/**
 * Response shape: the plain values put back on the row, the ciphertext taken
 * off. Use these instead of spreading a company or staff row into a response.
 */
function publicCompany(row) {
  if (!row) return null;
  const out = { ...stripped(row, COMPANY_PII_FIELDS), ...revealCompanyFields(row) };
  if (row.staff) out.staff = row.staff.map(publicStaff);
  return out;
}

function publicStaff(row) {
  if (!row) return null;
  const out = { ...stripped(row, STAFF_PII_FIELDS), ...revealStaffFields(row) };
  // The full number is never sent back; the app shows the last four.
  delete out.account_number_enc;
  if (row.company) out.company = publicCompany(row.company);
  return out;
}

/**
 * A payroll run is returned with its items, and every item carries the staff
 * row it pays. Without this the response ships `full_name_enc` and the app
 * finds no name at all.
 */
function publicPayrollRun(run) {
  if (!run) return null;
  return {
    ...run,
    ...(run.company ? { company: publicCompany(run.company) } : {}),
    ...(run.items ? { items: run.items.map(publicPayrollItem) } : {}),
  };
}

/**
 * `raw_payload` is the provider's own transfer object - it carries the raw
 * failure string and the recipient's bank details. Support reads it in the
 * database; the app gets `complete_message`, which is the wording we chose.
 */
function publicPayrollItem(item) {
  if (!item) return null;
  const out = { ...item };
  delete out.raw_payload;
  if (item.staff) out.staff = publicStaff(item.staff);
  return out;
}

module.exports = {
  COMPANY_PII_FIELDS,
  STAFF_PII_FIELDS,
  protectCompanyFields,
  revealCompanyFields,
  protectStaffFields,
  revealStaffFields,
  publicCompany,
  publicStaff,
  publicPayrollRun,
  publicPayrollItem,
};
