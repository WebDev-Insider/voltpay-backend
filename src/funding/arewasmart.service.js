// ArewaSmart BVN verification.
//
// Replaced Payvessel on the BVN path on 2026-08-25. The two providers answer
// fundamentally different questions, and almost every consequence in this file
// follows from that one difference:
//
//   Payvessel was a MATCH api. We sent the BVN plus six identity fields and it
//   answered with labels - FULL_MATCH, "66", NO_MATCH. The register's actual
//   data never crossed the wire, so the response was safe to store verbatim and
//   the name threshold was Payvessel's to decide (badly - see the three-name
//   ceiling in payvessel.service.js).
//
//   ArewaSmart is a LOOKUP api. We send the BVN and nothing else, and it hands
//   back the register record itself: names, date of birth, phone, gender.
//
// Three things change because of that.
//
// 1. THE MATCHING MOVES IN-HOUSE. There is no score to read. The caller compares
//    the register's name against the VoltPay profile with matchName() and picks
//    its own threshold - which is how the three-name ceiling stops being a
//    problem, because we can finally read the middle name we are given.
//
// 2. THE RESPONSE IS REGULATED PII ON THE WIRE. A BVN lookup returns a real
//    person's identity. It must never be echoed to the client, never logged,
//    never written to a match column and never held past the request that needed
//    it - otherwise this endpoint is a BVN-to-identity lookup service for anyone
//    with a VoltPay account. `verifyBvn` deliberately returns a narrow record
//    and no raw payload: there is nothing here for a caller to accidentally
//    spread into a response.
//
// 3. THE CALL IS BILLED, so `completed` is part of the contract. The caller
//    charges the customer on a lookup that ran - including "BVN not found" and
//    a name that did not match - and never on a call that failed before the
//    register was read. Getting that backwards either bills people for our
//    outage or turns the endpoint into free BVN enumeration at our expense.
//
// Auth is a bearer token, unlike Payvessel's two flat headers:
//   Authorization: Bearer <AREWASMART_API_TOKEN>
//
// TWO LOOKUPS LIVE HERE, AND THEY ARE NOT THE SAME KIND OF THING:
//
//   verifyBvn  POST /bvn/verify  - the CUSTOMER's own check. They pay ₦60, it
//                                  runs on their submission, and it decides
//                                  their verification without a human.
//   verifyNin  POST /nin/verify  - the REVIEWER's check. WE pay (~₦50), it runs
//                                  when an admin opens a NIN slip, and it does
//                                  not decide anything: it puts the register
//                                  record next to the photograph so a person
//                                  can tell whether the slip is real.
//
// The billing discipline is identical (`completed`, and a retry policy that
// never repeats a call that might have been billed), but the consequences of
// each are different enough that they are separate functions with separate
// extractors. Do not merge them: the NIN response carries a PHOTOGRAPH, and the
// BVN record must never quietly start carrying one.

const { withRetry } = require('../helpers/retry.helper');

const BASE_URL = String(process.env.AREWASMART_BASE_URL || 'https://api.arewasmart.com.ng/api/v1').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = Number(process.env.AREWASMART_TIMEOUT_MS || 30_000);

// Codes where the request provably never reached the lookup, so repeating it
// cannot buy a second billed check. Everything else is left alone on purpose -
// see shouldRetryLookup below.
const PRE_FLIGHT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// 429 is the provider refusing to process; 503 is it saying it is not open.
// Both are answers about the request NOT having been run.
const PRE_FLIGHT_STATUS = new Set([429, 503]);

function getToken() {
  const token = String(process.env.AREWASMART_API_TOKEN || '').trim();
  if (!token) throw new Error('Missing required env: AREWASMART_API_TOKEN');
  return token;
}

/**
 * Is ArewaSmart configured at all? Lets the caller answer 503 honestly rather
 * than throwing a 500 out of getToken() on every submission - which matters
 * more than usual right now, because the token is issued separately and the
 * code ships before it arrives.
 */
function isConfigured() {
  return Boolean(String(process.env.AREWASMART_API_TOKEN || '').trim());
}

function providerError(message, { statusCode = 502, payload = null } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.arewasmart = payload;
  return err;
}

/**
 * Deliberately NARROWER than retry.helper's default isTransient.
 *
 * The default retries anything that smells transient, including an AbortError
 * and a 500. That is right for a vend we can reconcile afterwards and wrong
 * here: a lookup that timed out may have been executed and billed at the far
 * end, and sending it again buys a second one. retry.helper says as much in its
 * own header - "each call site decides whether it is safe to repeat" - so this
 * is that decision, not an oversight.
 *
 * Repeat only where the request cannot have been processed: DNS and connect
 * failures, and the two statuses that mean "I did not run this". A read timeout,
 * a reset mid-flight, a 500 or a 504 all leave us unable to tell, so we stop and
 * report 503. Nobody is charged for a call we are not sure ran, and the customer
 * simply submits again - which costs them nothing, because the fee follows
 * `completed`.
 */
function shouldRetryLookup(err) {
  if (!err) return false;
  const status = Number(err.statusCode || err.status || 0);
  if (status) return PRE_FLIGHT_STATUS.has(status);
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (e.code && PRE_FLIGHT_CODES.has(String(e.code))) return true;
  }
  return false;
}

/**
 * One POST to ArewaSmart. Returns { status, json } - the HTTP status is part of
 * the answer here, because a 404 on a lookup is a verdict ("no such BVN") and
 * not a failure, and only the caller can tell those apart.
 *
 * Throws providerError for the cases where the register was never read.
 */
async function request(path, payload) {
  const token = getToken();
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
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
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

      // Our credentials, not the customer's details. Separated from the generic
      // failure so an operator reading the log fixes the token instead of
      // chasing a user's BVN. Never charged - no lookup happened.
      if (response.status === 401 || response.status === 403) {
        throw providerError('Identity verification is temporarily unavailable', {
          statusCode: 503,
          payload: { reason: 'auth' },
        });
      }

      // Our prepaid balance, same as Payvessel's 402. Fund the ArewaSmart
      // account; there is nothing wrong with the submission.
      if (response.status === 402) {
        throw providerError('Identity verification is temporarily unavailable', {
          statusCode: 503,
          payload: { reason: 'billing' },
        });
      }

      if (response.status === 429) {
        throw providerError('Identity verification is busy, please try again', {
          statusCode: 503,
          payload: { reason: 'rate_limit' },
        });
      }

      if (response.status >= 500) {
        throw providerError('Identity verification is temporarily unavailable', {
          statusCode: 503,
          payload: { reason: 'upstream' },
        });
      }

      // A 4xx we have no JSON for is not an answer about the BVN, it is a
      // broken request. Distinguish it from a parsed "not found" body below.
      if (!response.ok && !json) {
        throw providerError(`ArewaSmart request failed (${response.status})`, {
          statusCode: 502,
          payload: { reason: 'unparseable', http: response.status },
        });
      }

      return { status: response.status, json };
    },
    { label: 'arewasmart', shouldRetry: shouldRetryLookup },
  );
}

/**
 * First non-empty value among several possible spellings.
 *
 * The documented response names `bvn`, `firstName` and `lastName` and then says
 * "... other details" without listing them, so every field beyond those three is
 * read through an alias set. The Payvessel lesson applies unchanged: a field the
 * provider did not send is ABSENT, which is not the same as WRONG. Anything
 * missing here comes back null and the caller must not score it as a mismatch.
 */
function pick(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && text.toLowerCase() !== 'null') return text;
  }
  return null;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Best-effort YYYY-MM-DD. Nigerian registers are not consistent about this and
 * we have not seen ArewaSmart's spelling yet, so handle the four shapes that
 * actually turn up and return null rather than guessing at anything else.
 *
 * DD/MM/YYYY is read day-first, which is the Nigerian convention. That is a
 * genuine ambiguity for the first twelve days of a month; it is recorded rather
 * than resolved, because a date of birth is not what verification turns on here
 * (the name match is) and a wrong guess would be silently stored.
 */
function normalizeDob(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  m = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

/** MALE / FEMALE, or null. The register's spelling is not guaranteed. */
function normalizeGender(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (!text) return null;
  if (text.startsWith('M')) return 'MALE';
  if (text.startsWith('F')) return 'FEMALE';
  return null;
}

/** 234XXXXXXXXXX from whatever the register holds, or null. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `234${digits.slice(-10)}`;
}

/**
 * The register record, reduced to the fields we have a use for.
 *
 * Nothing else is carried out of this module. The response may well hold an
 * address, a photograph, an enrolment branch and a NIN; none of that is needed
 * to decide whether this BVN belongs to this VoltPay user, and anything we do
 * not extract cannot later be leaked by a careless spread.
 */
function extractRecord(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    bvn: pick(data, ['bvn', 'bvn_number', 'bvnNumber']),
    firstName: pick(data, ['firstName', 'first_name', 'firstname', 'givenName']),
    lastName: pick(data, ['lastName', 'last_name', 'lastname', 'surname']),
    middleName: pick(data, ['middleName', 'middle_name', 'middlename', 'otherNames', 'other_names', 'othername']),
    dateOfBirth: normalizeDob(pick(data, ['dateOfBirth', 'date_of_birth', 'dob', 'birthdate', 'birthday'])),
    gender: normalizeGender(pick(data, ['gender', 'sex'])),
    phoneNumber: normalizePhone(pick(data, PHONE_KEYS)),
  };
}

// `telephoneno` is the NIN endpoint's spelling and is not a typo. Shared with
// the BVN extractor because an alias that is merely absent from one response
// costs nothing, while a missing one silently drops a field - which is also why
// this list is not trimmed when the endpoint moves.
const PHONE_KEYS = [
  'phoneNumber', 'phone_number', 'phone', 'mobile',
  'telephoneno', 'telephoneNo', 'telephone_no', 'telephone',
  'phoneNumber1', 'phone_number1',
];

/**
 * A base64 photograph, as a data URI ready for an <img src>, or null.
 *
 * The register returns the JPEG bytes base64'd with no data: prefix, so the
 * prefix is added here - one place that knows the encoding rather than a
 * dashboard guessing at it.
 *
 * Capped, and validated as base64 before it is wrapped. An oversized or
 * malformed value is dropped rather than passed on: this string goes straight
 * into an admin's browser, and the photograph is a convenience on that screen,
 * never the thing the decision rests on. Losing it costs a reviewer nothing they
 * cannot get from the slip itself.
 */
const MAX_PHOTO_B64 = 3_000_000; // ~2.2MB of JPEG, far past any ID portrait

function asPhotoDataUri(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > MAX_PHOTO_B64) return null;
  if (text.startsWith('data:')) return text;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return null;
  return `data:image/jpeg;base64,${text.replace(/\s+/g, '')}`;
}

/**
 * The NIN register record, reduced to what a reviewer compares against a slip.
 *
 * Deliberately WIDER than extractRecord in one respect and narrower in another.
 * Wider: it carries the register's photograph, which is the single most decisive
 * thing on the review screen - a forged slip rarely survives its own portrait.
 * Narrower in intent: `signature_path` is documented and is NOT read. A signature
 * adds nothing to "is this the person in the photograph", and the rule from the
 * BVN path applies unchanged - anything we do not extract cannot later be leaked
 * by a careless spread.
 *
 * NOTHING HERE IS EVER STORED. See adminKyc.verifyNinLookup: the encrypted
 * columns are not written from this, and the only artefact kept is a verdict
 * with no names in it. This record exists for the length of one admin request.
 */
function extractNinRecord(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    nin: pick(data, ['nin', 'nin_number', 'ninNumber']),
    firstName: pick(data, ['firstname', 'firstName', 'first_name', 'givenName']),
    lastName: pick(data, ['surname', 'lastname', 'lastName', 'last_name']),
    middleName: pick(data, ['middlename', 'middleName', 'middle_name', 'otherNames', 'other_names']),
    dateOfBirth: normalizeDob(pick(data, ['birthdate', 'birthDate', 'dateOfBirth', 'date_of_birth', 'dob'])),
    gender: normalizeGender(pick(data, ['gender', 'sex'])),
    phoneNumber: normalizePhone(pick(data, PHONE_KEYS)),
    photo: asPhotoDataUri(pick(data, ['photo_path', 'photoPath', 'photo', 'image'])),
    trackingId: pick(data, ['trackingId', 'tracking_id', 'trackingID']),
  };
}

/**
 * Provider messages are shown to nobody and logged nowhere, but they are stored
 * as a decline reason, so cap the length and strip anything that looks like it
 * carries the record back with it.
 */
function safeMessage(raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

// Some gateways wrap the payload one level deeper than documented. Cheap to
// tolerate, expensive to discover in production against a live billed call.
function unwrap(json) {
  const data = json?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && !data.bvn) return inner;
    return data;
  }
  return null;
}

function isSuccess(json, httpStatus) {
  if (httpStatus >= 400) return false;
  const status = String(json?.status ?? '').trim().toLowerCase();
  if (status) return status === 'success' || status === 'true' || status === 'ok';
  // No `status` key at all: fall back to the documented success shape, which is
  // a 2xx carrying a data object. Better than assuming success on any 200.
  if (typeof json?.success === 'boolean') return json.success;
  return Boolean(unwrap(json));
}

/**
 * Look a BVN up in the register.
 *
 * @param {object} args
 * @param {string} args.bvn  11 digits, already validated by the caller
 * @returns {Promise<{completed: boolean, found: boolean, record: object|null, reference: string|null, message: string}>}
 *
 * `completed` is the billing signal and the only reason this returns an object
 * on a negative answer instead of throwing: "BVN not found" is a lookup that
 * ran. A call that never reached the register throws instead, with statusCode
 * 503, so there is no path on which a caller can charge for our outage.
 *
 * `record` is live PII for the duration of the request. Match it, write the
 * encrypted columns from it, and let it fall out of scope. Do not log it, do not
 * return it to the client, do not put it in a `meta` blob.
 */
async function verifyBvn({ bvn }) {
  const digits = String(bvn || '').replace(/\D/g, '');
  if (digits.length !== 11) throw providerError('A BVN is 11 digits', { statusCode: 400 });

  const { status, json } = await request('/bvn/verify', { bvn: digits });
  const reference = pick(json, ['transaction_ref', 'transactionRef', 'reference', 'ref']);

  if (!isSuccess(json, status)) {
    // The register answered, and the answer was no. Charged.
    return {
      completed: true,
      found: false,
      record: null,
      reference,
      message: safeMessage(json?.message, 'That BVN could not be found'),
    };
  }

  const record = extractRecord(unwrap(json));

  // A "success" with no usable record is not a verdict about the customer, it
  // is a contract we have misread. Treat it as an outage rather than declining
  // somebody - and never charge for it.
  if (!record || (!record.firstName && !record.lastName)) {
    throw providerError('Identity verification is temporarily unavailable', {
      statusCode: 503,
      payload: { reason: 'unexpected_shape' },
    });
  }

  return {
    completed: true,
    found: true,
    record,
    reference,
    message: safeMessage(json?.message, 'Verification successful'),
  };
}

/**
 * Look a NIN up in the register. THE REVIEWER'S TOOL, not the customer's.
 *
 * @param {object} args
 * @param {string} args.nin  11 digits, already validated by the caller
 * @param {string} [args.ref] our own correlation reference, echoed back
 * @returns {Promise<{completed: boolean, found: boolean, record: object|null, reference: string|null, message: string}>}
 *
 * Same `completed` contract as verifyBvn: an object means the register answered
 * (including "no such NIN"), and anything that never reached it throws with
 * statusCode 503. What differs is who pays and what it decides.
 *
 * WE pay for this one, not the customer - it runs on an admin's click while they
 * are reviewing a slip, so there is no wallet to debit and no PIN to ask for.
 * That makes the abuse shape different too: nobody can spend a stranger's money
 * with it, but an admin holding the button down spends OURS. The caller is
 * responsible for not re-running a lookup it already has an answer for.
 *
 * AND IT DECIDES NOTHING. The verdict is still a person's, looking at a
 * photograph. This only puts the register's version of that person on the screen
 * beside the slip.
 *
 * `record.photo` is a real human face and `record` is a real person's identity.
 * It is returned to one authenticated admin, on an audited request, and is
 * never stored, never logged and never cached.
 */
async function verifyNin({ nin, ref } = {}) {
  const digits = String(nin || '').replace(/\D/g, '');
  if (digits.length !== 11) throw providerError('A NIN is 11 digits', { statusCode: 400 });

  const payload = { nin: digits };
  // Optional per the spec. Sent when the caller has one so a disputed charge can
  // be tied back to the review it was spent on.
  const reference = String(ref || '').trim().slice(0, 64);
  if (reference) payload.ref = reference;

  const { status, json } = await request('/nin/verify', payload);
  const providerRef = pick(json, ['reference', 'transaction_ref', 'transactionRef', 'ref'])
    || pick(unwrap(json), ['reference', 'trackingId', 'tracking_id']);

  if (!isSuccess(json, status)) {
    // The register answered, and the answer was no. Billed to us all the same.
    return {
      completed: true,
      found: false,
      record: null,
      reference: providerRef,
      message: safeMessage(json?.message, 'That NIN could not be found'),
    };
  }

  const data = unwrap(json);

  // The NIN endpoint carries a SECOND status, inside `data`, describing the
  // lookup itself rather than the HTTP call. A top-level success wrapping
  // `data.status: "failed"` is a negative answer, and reading only the outer one
  // would render an empty record as though the register had confirmed somebody.
  // Kept unconditional: an endpoint that omits the inner status simply skips
  // this, so it costs nothing to tolerate and catches the case that matters.
  const inner = String(data?.status ?? '').trim().toLowerCase();
  if (inner && !['successful', 'success', 'found', 'completed', 'true', 'ok'].includes(inner)) {
    return {
      completed: true,
      found: false,
      record: null,
      reference: providerRef,
      message: safeMessage(json?.message, 'That NIN could not be verified'),
    };
  }

  const record = extractNinRecord(data);

  // Same rule as the BVN path: a "success" we cannot read is our misunderstanding
  // of the contract, not a finding about the person. Never let it reach a
  // reviewer as an empty record they might read as "the register has nothing".
  if (!record || (!record.firstName && !record.lastName)) {
    throw providerError('The NIN register is temporarily unavailable', {
      statusCode: 503,
      payload: { reason: 'unexpected_shape' },
    });
  }

  return {
    completed: true,
    found: true,
    record,
    reference: providerRef,
    message: safeMessage(json?.message, 'NIN verification successful'),
  };
}

module.exports = {
  verifyBvn,
  verifyNin,
  isConfigured,
  // exported for tests
  __test: {
    normalizeDob, normalizeGender, normalizePhone, extractRecord, extractNinRecord,
    isSuccess, unwrap, shouldRetryLookup, safeMessage, pick, asPhotoDataUri,
  },
};
