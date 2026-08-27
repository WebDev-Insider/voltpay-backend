// Payvessel identity verification: basic BVN and basic NIN.
//
// Both compare the details a user typed against the register (the BVN registry,
// then NIMC) and answer with a field-by-field match result. Same request shape,
// same response shape, same grading - only the path and the id field differ.
//
// Synchronous: the verdict is in the HTTP response, so there is no callback, no
// reference and no webhook anywhere on this path.
//
// Auth is two flat headers, not a bearer token:
//   api-key:    <public key>
//   api-secret: <secret key>
// Both are secrets. The "public" one is only public in the sense that Payvessel
// calls it that; it authenticates requests and must never reach a client.
//
// Billing note that shapes the error handling: a "NIN not found" answer is
// HTTP 200 with `success: false` AND it is charged. So is a failed match. Only
// send a request whose inputs have already been validated.

const { withRetry } = require('../helpers/retry.helper');

const BASE_URL = String(process.env.PAYVESSEL_BASE_URL || 'https://api.payvessel.com/kyc').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = Number(process.env.PAYVESSEL_TIMEOUT_MS || 30_000);

// Payvessel's own threshold guidance is to accept on a high name score rather
// than demand a byte-identical string: NIMC records carry middle names the
// customer omits, and vice versa. Below this the check is a decline.
//
// 65, NOT 70, AND THE FOUR POINTS MATTER. Measured against a live three-name
// BVN on 2026-08-25, four paid checks against one real record:
//
//   Victory /  --    / Kalunta  -> 66   (middle name omitted)
//   Victory / Henry  / Kalunta  -> 66   (middle name correct, register verbatim)
//   Victory / Henry  / Kalunta  -> 66   (as above, gender corrected too)
//   Victory / Henry  / Okonkwo  -> 33   (surname deliberately wrong)
//
// Adding the *correct* middle name did not move the score, so Payvessel's BVN
// endpoint does not score `middle_name` at all; and the score fell by exactly a
// third when one of the two names it does read was wrong. The percentage is
// therefore `(names matched) / (names on the register)`, over first and last
// only - which puts a hard ceiling of 66 on every three-name BVN. At 70 that
// ceiling is unreachable: no customer with three names could ever verify, and
// each learned it at N30 a go. It stayed hidden because a two-name record scores
// 100 and passes fine.
//
// 65 sits in the gap between a full match and any half match we can construct:
// it takes 66 (three names, both scored ones correct) and 100 (two names, both
// correct), and still declines 33 and 50 (either register size, one name wrong).
// A wrong surname remains a decline, which is the case this threshold exists for.
//
// KNOWN GAP: a FOUR-name register would cap at 50 and still fail. Untested - we
// have no such record to hand - and it cannot be fixed by lowering further, since
// 50 is also a two-name half match. Fixing it properly means Payvessel scoring
// the middle name we already send them.
const NAME_MATCH_MIN = Number(process.env.PAYVESSEL_NAME_MATCH_MIN || 65);

// Every spelling Payvessel has been observed to use for "this field agrees".
// The BVN and NIN endpoints do not share a vocabulary: the NIN check returns
// `MATCH`, the BVN check returns `FULL_MATCH`. Anything affirmative belongs in
// this set - a spelling we do not recognise is read as a mismatch, which
// declines a customer whose details were right.
const AFFIRMATIVE = new Set(['MATCH', 'FULL_MATCH', 'EXACT_MATCH', 'COMPLETE_MATCH', 'TRUE', 'YES']);

function getCreds() {
  const apiKey = String(process.env.PAYVESSEL_API_KEY || '').trim();
  const apiSecret = String(process.env.PAYVESSEL_API_SECRET || '').trim();
  if (!apiKey) throw new Error('Missing required env: PAYVESSEL_API_KEY');
  if (!apiSecret) throw new Error('Missing required env: PAYVESSEL_API_SECRET');
  return { apiKey, apiSecret };
}

/**
 * Is Payvessel configured at all? Lets a caller answer 503 honestly instead of
 * throwing a 500 out of getCreds() on every submission.
 */
function isConfigured() {
  return Boolean(
    String(process.env.PAYVESSEL_API_KEY || '').trim() &&
    String(process.env.PAYVESSEL_API_SECRET || '').trim(),
  );
}

function providerError(message, { statusCode = 502, payload = null } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.payvessel = payload;
  return err;
}

async function request(path, payload) {
  const { apiKey, apiSecret } = getCreds();
  const url = `${BASE_URL}${path}`;

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'api-secret': apiSecret,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
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

      // 402 is our wallet, not the customer's problem: Payvessel is prepaid and
      // the balance ran out. Surfaced as its own message so an operator reading
      // the log knows to fund the account rather than chase the user's details.
      if (response.status === 402) {
        throw providerError('Identity verification is temporarily unavailable', {
          statusCode: 503,
          payload: json,
        });
      }

      if (!response.ok) {
        const message = String(json?.message || '').trim() || `Payvessel request failed (${response.status})`;
        throw providerError(message, { statusCode: response.status, payload: json });
      }

      return json;
    },
    { label: 'payvessel' },
  );
}

/**
 * Payvessel's answer for one field: true (matched), false (explicitly did not
 * match), or null (the provider did not answer).
 *
 * The three-way return is the point. Payvessel does not speak one vocabulary
 * across its endpoints - the NIN check answers `MATCH` / `NO_MATCH` while the
 * BVN check answers `FULL_MATCH` / `PARTIAL_MATCH` - and it omits fields it has
 * no opinion on rather than returning `NO_MATCH` for them. A two-way "is it the
 * string MATCH" collapses both of those into "failed", which scored a
 * `FULL_MATCH` date of birth and an unanswered phone number as mismatches.
 */
function verdict(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  // Absent, or a null that survived JSON as text. No evidence either way -
  // which is not the same as evidence against.
  if (!raw || raw === 'NULL' || raw === 'UNDEFINED' || raw === 'N/A') return null;
  if (AFFIRMATIVE.has(raw)) return true;
  return false;
}

function isMatch(value) {
  return verdict(value) === true;
}

/**
 * Turn Payvessel's match object into a verdict.
 *
 * Two tiers, because the four fields are not equally probative:
 *
 * - **Name and date of birth are the identity.** Both must be present and both
 *   must pass. A record whose name matches but whose date of birth does not is
 *   somebody else's record, which is exactly the case this exists to catch, so
 *   a partial match is a decline. An *unanswered* name or date of birth is also
 *   a decline - otherwise an empty `data` object would verify everybody.
 * - **Gender and phone corroborate; they do not identify.** They are scored
 *   when Payvessel answers and skipped when it does not. Phone never declines
 *   at all: the number on a BVN record is whatever the customer gave their bank
 *   at enrolment, so a stale SIM is overwhelmingly the likelier explanation than
 *   fraud, and the customer cannot fix it from our form. It is still recorded.
 *
 * The returned `match` object is safe to store: it holds match labels and a
 * percentage, never a value from the register.
 */
function gradeMatchResult(json, label = 'NIN') {
  const data = json?.data || null;

  if (json?.success !== true || !data) {
    return {
      verified: false,
      // Payvessel's line ("NIN not found") is more useful than anything we
      // could invent, and it describes the record, not the person.
      reason: String(json?.message || '').trim() || `We could not verify that ${label}`,
      match: null,
    };
  }

  const match = {
    name_match_rlt: data.name_match_rlt ?? null,
    names_match_percentage: data.names_match_percentage ?? null,
    birthday_match_rlt: data.birthday_match_rlt ?? null,
    gender_match_rlt: data.gender_match_rlt ?? null,
    phone_number_match_rlt: data.phone_number_match_rlt ?? null,
  };

  // The BVN endpoint reports `PARTIAL_MATCH` with a percentage instead of a
  // straight verdict, so the score is a second route to a pass, not a fallback.
  const percentage = Number(String(data.names_match_percentage ?? '').trim());
  const scoredOk = Number.isFinite(percentage) && percentage >= NAME_MATCH_MIN;
  const nameOk = verdict(data.name_match_rlt) === true || scoredOk;

  const failed = [];
  if (!nameOk) failed.push('name');
  if (verdict(data.birthday_match_rlt) !== true) failed.push('birthday');
  // Only an explicit disagreement counts. Silence does not.
  if (verdict(data.gender_match_rlt) === false) failed.push('gender');

  if (failed.length) {
    // Names the field, never the expected value - telling a stranger which
    // digit of a date of birth to change turns this into an oracle.
    const labels = { name: 'name', birthday: 'date of birth', gender: 'gender' };
    let reason = `Your ${failed.map(f => labels[f]).join(' and ')} did not match the ${label} record`;
    // This used to say "check your middle name". It must not: the four live
    // checks recorded against NAME_MATCH_MIN above prove Payvessel's BVN
    // endpoint never scores `middle_name`, so that sent the customer to edit the
    // one field on the form that cannot change the answer - at N30 an attempt.
    // A name score that fails now means a first name or a surname disagrees, and
    // that is what to say. Offered only on partial agreement: below half, this is
    // a different person and there is no spelling to fix. Generic either way, so
    // it still gives away nothing about what the register holds.
    const nearMiss = String(data.name_match_rlt ?? '').toUpperCase().includes('PARTIAL')
      || (Number.isFinite(percentage) && percentage >= NAME_MATCH_MIN / 2);
    if (failed.includes('name') && nearMiss) {
      reason += '. Check your first name and surname against your bank records';
    }
    return { verified: false, reason, match };
  }

  return { verified: true, reason: null, match };
}

// The personal details half of the body, identical for both documents.
function detailsPayload({ firstName, middleName, lastName, phone, dob, gender }) {
  return {
    first_name: String(firstName),
    last_name: String(lastName),
    // Required by the spec. Payvessel scores the name set as a whole, so an
    // empty string is the honest answer for a record with no middle name.
    middle_name: String(middleName || ''),
    gender: String(gender || '').trim().toUpperCase() === 'FEMALE' ? 'FEMALE' : 'MALE',
    birthday: String(dob),
    phone_number: String(phone),
  };
}

/**
 * POST /api/v1/merchant/bvn/basic
 *
 * @returns {Promise<{verified: boolean, reason: string|null, match: object|null, charged: boolean}>}
 */
async function verifyBvn({ bvn, ...details }) {
  const json = await request('/api/v1/merchant/bvn/basic', { bvn: String(bvn), ...detailsPayload(details) });
  return { ...gradeMatchResult(json, 'BVN'), charged: json?.charges?.charged === true };
}

/**
 * POST /api/v1/merchant/nin/basic. Same contract as verifyBvn.
 *
 * RETIRED - nothing calls this. NIN verification was withdrawn; the only route
 * that reached it now answers 410 (see kyc.controller.submitNin).
 *
 * Left on disk rather than deleted: it is a working, tested implementation of a
 * live Payvessel endpoint, this repo has no git history to restore it from, and
 * the rule it serves has already reversed three times. Wiring it back up is
 * re-adding an entry to DOCUMENTS in kyc.controller.js - nothing here needs to
 * change. Do NOT call it without also changing kycGate.rowIsVerified, or a
 * verified NIN will be stored that opens no wallet and bills ₦30 for nothing.
 */
async function verifyNin({ nin, ...details }) {
  const json = await request('/api/v1/merchant/nin/basic', { nin: String(nin), ...detailsPayload(details) });
  return { ...gradeMatchResult(json, 'NIN'), charged: json?.charges?.charged === true };
}

module.exports = {
  verifyBvn,
  verifyNin,
  isConfigured,
  // Same two headers authenticate the biller-reseller rail
  // (funding/payvesselBiller.service.js), so the lookup lives in one place.
  getCreds,
  __test: { gradeMatchResult, isMatch, verdict, NAME_MATCH_MIN },
};
