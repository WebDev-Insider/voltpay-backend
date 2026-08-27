// BudPay identity verification: BVN, and bank account name resolution.
//
// RETIRED - nothing imports this. Identity verification moved to Payvessel
// (funding/payvessel.service.js), which checks a BVN *and* a NIN synchronously,
// and the bank-account requirement was withdrawn with it. Kept on disk rather
// than deleted because it is a complete, working integration and the bank
// name-resolution half has no replacement anywhere in the codebase - if an
// account check is ever wanted again, this is it. `BUDPAY_*` env vars and the
// callback route in kyc.routes.js are gone; restoring this means restoring
// those too.
//
// Two calls with opposite shapes, and the difference drove the whole KYC flow:
//
//   POST /bvn/verify           ASYNCHRONOUS. Answers "Request Submitted
//                              Successfully" and nothing else. The verdict is
//                              POSTed to `callback_url` some time later.
//   POST /account_name_verify  SYNCHRONOUS. Answers with the account holder's
//                              name as a plain string in `data`.
//
// So a BVN submission has to park in a `pending` state and be settled by
// kyc.controller's callback handler, while an account check is settled inside
// the request that made it. Do not "await" a BVN verdict here - there isn't one.
//
// Auth is a bearer token:
//   Authorization: Bearer <BUDPAY_SECRET_KEY>
// It is a secret key, server-side only. BudPay's own guidance is explicit that
// a BVN must never appear in client code, a log, or an error string, which is
// also this codebase's rule - so nothing here logs a request body.
//
// Bank codes are NOT interchangeable with Paystack's. BudPay uses NIBSS-style
// institution codes ("000013"), Paystack uses NIP codes ("058"). The account
// check must be fed a code from `listBanks()` below, never from
// /staffpay/banks, which is a Paystack list.

const { withRetry } = require('../helpers/retry.helper');

const BASE_URL = String(process.env.BUDPAY_BASE_URL || 'https://api.budpay.com/api/v2').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = Number(process.env.BUDPAY_TIMEOUT_MS || 30_000);

function getSecretKey() {
  const key = String(process.env.BUDPAY_SECRET_KEY || '').trim();
  if (!key) throw new Error('Missing required env: BUDPAY_SECRET_KEY');
  return key;
}

/** Is BudPay configured at all? Lets a caller answer honestly instead of 500. */
function isConfigured() {
  return Boolean(String(process.env.BUDPAY_SECRET_KEY || '').trim());
}

function providerError(message, { statusCode = 502, payload = null } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.budpay = payload;
  return err;
}

async function request(path, { method = 'POST', body = null } = {}) {
  const key = getSecretKey();
  const url = `${BASE_URL}${path}`;

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      // 401 is our credentials, not the customer's details. Surfaced as its own
      // message so an operator reading the log knows to check the key rather
      // than chase the user's BVN.
      if (response.status === 401) {
        throw providerError('Identity verification is temporarily unavailable', {
          statusCode: 503,
          payload: null,
        });
      }

      // 422 carries a per-field validation map. Flattened to one line, because
      // the fields are ours to get right, not the user's.
      if (response.status === 422) {
        const errors = json?.errors && typeof json.errors === 'object' ? Object.values(json.errors).flat() : [];
        throw providerError(errors.join('; ') || 'Validation error', { statusCode: 422, payload: json });
      }

      if (!response.ok) {
        const message = String(json?.message || '').trim() || `BudPay request failed (${response.status})`;
        throw providerError(message, { statusCode: response.status, payload: json });
      }

      return json;
    },
    { label: 'budpay' },
  );
}

/* ------------------------------------------------------------ account name */

/**
 * POST /account_name_verify - resolve who owns a NUBAN.
 *
 * BudPay returns the name as a bare string in `data`, not an object:
 *   { "success": true, "message": "Account name retrieved", "data": "SAMUEL OWOLABI BLESSING" }
 *
 * @returns {Promise<{account_name: string}>}
 * @throws  on an unresolvable account - a wrong bank/number pair is a 400 and a
 *          closed or non-existent account is a 404, both of which mean "we
 *          cannot tell you who owns this", not "it did not match".
 */
async function verifyAccountName({ bank_code, account_number }) {
  const code = String(bank_code || '').trim();
  const number = String(account_number || '').replace(/\D/g, '');
  if (!code || !number) throw new Error('bank_code and account_number are required');

  const json = await request('/account_name_verify', { body: { bank_code: code, account_number: number } });

  // `data` is the name itself. Guarded anyway: an object here would stringify
  // to "[object Object]" and then fail every name comparison for a reason no
  // log would explain.
  const name = typeof json?.data === 'string' ? json.data.trim() : String(json?.data?.account_name || '').trim();
  if (json?.success !== true || !name) {
    throw providerError(String(json?.message || '').trim() || 'We could not confirm that account number', {
      statusCode: 400,
      payload: json,
    });
  }
  return { account_name: name };
}

/* -------------------------------------------------------------- bank list */

// Cached in process. The list changes when a bank is licensed or merges - a few
// times a year - so a day is a conservative TTL, and it is only ever a picker.
let bankCache = null;

/**
 * GET /bank_list/NGN
 *
 * @returns {Promise<Array<{bank_code: string, bank_name: string}>>}
 */
async function listBanks({ currency = 'NGN', force = false } = {}) {
  const key = String(currency).toUpperCase();
  const ttlMs = Math.max(60_000, Number(process.env.BUDPAY_BANK_CACHE_MS) || 24 * 60 * 60 * 1000);

  if (!force && bankCache && bankCache.key === key && bankCache.expiresAt > Date.now()) {
    return bankCache.rows;
  }

  const json = await request(`/bank_list/${encodeURIComponent(key)}`, { method: 'GET' });
  const rows = (Array.isArray(json?.data) ? json.data : [])
    .map(row => ({
      bank_code: String(row?.bank_code ?? row?.code ?? '').trim(),
      bank_name: String(row?.bank_name ?? row?.name ?? '').trim(),
    }))
    .filter(row => row.bank_code && row.bank_name)
    .sort((a, b) => a.bank_name.localeCompare(b.bank_name));

  // An empty list is not cached: it means the call shape changed or BudPay had
  // a bad minute, and caching it would hide an empty bank picker for a day.
  if (rows.length) bankCache = { key, rows, expiresAt: Date.now() + ttlMs };
  return rows;
}

/* -------------------------------------------------------------------- BVN */

/**
 * POST /bvn/verify - submit a BVN for checking against NIBSS.
 *
 * There is no verdict in the return value, only an acknowledgement. Whatever
 * `reference` goes in comes back on the callback, and it is what ties the
 * callback to a row.
 *
 * @returns {Promise<{submitted: boolean, reference: string}>}
 */
async function submitBvn({ bvn, firstName, middleName, lastName, phone, dob, gender, reference, callbackUrl }) {
  if (!callbackUrl) throw new Error('callbackUrl is required - BudPay has nowhere to send the verdict without it');

  const json = await request('/bvn/verify', {
    body: {
      bvn: String(bvn),
      first_name: String(firstName),
      last_name: String(lastName),
      // Sent even when empty: the field is part of the documented body, and an
      // empty string is the honest answer for a record with no middle name.
      middle_name: String(middleName || ''),
      phone_number: String(phone),
      dob: String(dob),
      // BudPay's sample is title case ("Male"), unlike Payvessel's upper case.
      gender: String(gender || '').trim().toLowerCase() === 'female' ? 'Female' : 'Male',
      reference: String(reference),
      callback_url: String(callbackUrl),
    },
  });

  if (json?.success !== true) {
    throw providerError(String(json?.message || '').trim() || 'We could not start your BVN check', {
      statusCode: 502,
      payload: json,
    });
  }
  return { submitted: true, reference: String(json?.reference || reference) };
}

/* --------------------------------------------------- grading the callback */

// What BudPay puts in each match field. "Not Provided" and "Not Applicable"
// mean the register holds nothing to compare, which is not the same as a
// failure - see gradeBvnCallback.
const PASS = new Set(['EXACT MATCH', 'VERIFIED', 'MATCH', 'TRUE', 'YES']);
const PARTIAL = new Set(['PARTIAL MATCH']);
const ABSENT = new Set(['NOT PROVIDED', 'NOT APPLICABLE', 'N/A', '']);

function verdict(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (ABSENT.has(v)) return 'absent';
  if (PASS.has(v)) return 'pass';
  if (PARTIAL.has(v)) return 'partial';
  return 'fail';
}

// A partial name is accepted by default, and only for the name.
//
// It reproduces what users already live with: the Payvessel grader this
// replaces passed a name on a similarity score of 70 or better, so a rule of
// "exact only" would fail people who verified fine last week. The name is also
// the one field checked twice - our own matchName() has already compared it
// against the VoltPay profile before this request was ever sent - so a partial
// here is a middle-name discrepancy inside a name we already trust, not an
// unguarded field. Set BUDPAY_STRICT_NAME=1 to demand an exact match instead.
function acceptsPartialName() {
  return String(process.env.BUDPAY_STRICT_NAME ?? '').trim() !== '1';
}

/**
 * Turn a BVN callback payload into a verdict.
 *
 * Two tiers, because a register that holds no phone number for a fifteen-year-
 * old BVN must not fail an honest customer:
 *
 *   required   Names and DOB. These pin the identity, and if the register
 *              cannot answer on them there is nothing to verify against.
 *   optional   Gender and Phone_Number. Checked when present, ignored when the
 *              register says it has nothing - but a genuine "No Match" on
 *              either is still a decline, because a matching name with the
 *              wrong gender is somebody else's BVN.
 *
 * The returned `match` object is safe to store: verdict labels only, never a
 * value read back out of the register.
 *
 * @returns {{verified: boolean, reason: string|null, match: object}}
 */
function gradeBvnCallback(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};

  const match = {
    Names: data.Names ?? null,
    DOB: data.DOB ?? null,
    Gender: data.Gender ?? null,
    Phone_Number: data.Phone_Number ?? null,
    ID_Verification: data.ID_Verification ?? null,
    ResultCode: data.ResultCode ?? payload?.ResultCode ?? null,
    ResultText: data.ResultText ?? payload?.ResultText ?? null,
  };

  // The delivery itself failing - BudPay could not reach NIBSS, the BVN does
  // not exist - arrives as a notifyType/status that is not a success. There is
  // no field-by-field result to read in that case.
  const outcome = String(payload?.notifyType ?? payload?.status ?? '').trim().toLowerCase();
  if (outcome && !['successful', 'success', 'completed', 'true'].includes(outcome)) {
    return {
      verified: false,
      reason: String(match.ResultText || payload?.message || '').trim() || 'We could not verify that BVN',
      match,
    };
  }

  const nameVerdict = verdict(match.Names);
  const nameOk = nameVerdict === 'pass' || (nameVerdict === 'partial' && acceptsPartialName());

  const checks = {
    name: nameOk,
    // Absent is a failure here on purpose: a BVN record with no name and no
    // date of birth has told us nothing about who this is.
    birthday: verdict(match.DOB) === 'pass' || verdict(match.DOB) === 'partial',
    gender: verdict(match.Gender) !== 'fail',
    phone_number: verdict(match.Phone_Number) !== 'fail',
  };

  const failed = Object.keys(checks).filter(key => !checks[key]);
  if (failed.length) {
    // Names the field, never the expected value - telling a stranger which
    // digit of a date of birth to change turns this into an oracle.
    const labels = { name: 'name', birthday: 'date of birth', gender: 'gender', phone_number: 'phone number' };
    return {
      verified: false,
      reason: `Your ${failed.map(f => labels[f]).join(', ')} did not match the BVN record`,
      match,
    };
  }

  return { verified: true, reason: null, match };
}

module.exports = {
  submitBvn,
  verifyAccountName,
  listBanks,
  gradeBvnCallback,
  isConfigured,
  __test: { verdict, gradeBvnCallback, acceptsPartialName },
};
