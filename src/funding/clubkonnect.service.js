// ClubKonnect bills provider.
//
// The second implementation of the bills contract - same four rails as
// pairgate.service.js (airtime, data, cable TV, electricity), same exported
// function names, same error shape. bills.controller.js resolves one of the two
// per service and cannot tell them apart. Anything that differs between them
// belongs in here, not in the controller.
//
// Auth is two query parameters, not a header:
//   ?UserID=<user id>&APIKey=<api key>
//
// Five things about this API shape everything below:
//
//   1. **Every call is a GET, purchases included.** That breaks the heuristic
//      the other provider relies on. There, "retry GETs, never retry POSTs" was
//      a safe reading of "retry reads, never retry writes", because a vend was
//      the only POST. Here a vend and a catalogue read are the same HTTP verb,
//      so retrying by method would repeat purchases and deliver twice. Retry is
//      therefore opt-in per call site and defaults to OFF - see ckRequest.
//   2. **`statuscode` is the outcome, and only "200" is success.** A vend
//      answers "100" ORDER_RECEIVED, which means accepted, not delivered.
//      "201" is filed under ORDER_COMPLETED but actually means the network
//      never answered and the order will be retried for an hour before being
//      cancelled - reading it as success marks a bill delivered that may still
//      reverse. See classifyStatus.
//   3. **Identifiers are numeric, zero-padded strings.** Networks are 01-04,
//      discos 01-12, meter types 01/02. `"01" !== 1`, and the app has always
//      sent names like `MTN` and `IKEDC`, so both directions are mapped here.
//   4. **The electricity token comes back on the purchase call** as
//      `metertoken` - the one place this provider is easier than the other,
//      where the token only ever arrives on a webhook.
//   5. **The callback carries no signature.** It is a per-request `CallBackURL`
//      with no HMAC of any kind, so a delivery can never be trusted on its own
//      and is always re-read over the authenticated API. See
//      clubkonnectWebhook.controller.js.
//
// Like the other provider this is a prepaid float: a purchase debits our
// ClubKonnect wallet, not the customer's. "Insufficient balance" from this API
// is an operational incident, never something to show a funded customer.
// isFloatError marks it.
//
// Operational note: ClubKonnect authenticates partly by source IP. The
// deployment's outbound address must be whitelisted on their dashboard or every
// call answers INVALID_CREDENTIALS regardless of the key.
const { withRetry, causeCode } = require('../helpers/retry.helper');
const { createCatalogueCache, REFRESH_HELD, REFRESH_NO_LOCK } = require('./catalogueCache');
const { readDuration } = require('./planDuration');

const BASE_URL = String(process.env.CLUBKONNECT_BASE_URL || 'https://www.nellobytesystems.com').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CLUBKONNECT_TIMEOUT_MS || 30_000);
const CATALOGUE_TTL_MS = Number(process.env.CLUBKONNECT_CATALOGUE_TTL_MS || 30 * 60_000);

// Where this provider posts delivery notifications. Unlike the other rail's
// single dashboard-configured webhook, this is sent per request, so it has to be
// an absolute URL this deployment can be reached on. Left blank in development,
// where the callback would never arrive anyway and the sweep settles instead.
const CALLBACK_URL = String(process.env.CLUBKONNECT_CALLBACK_URL || '').trim();

// Provider floors, enforced on their side and read from the live catalogue
// rather than the docs: every disco's product carries MINAMOUNT 1000.
//
// **This is ten times the other provider's electricity floor**, and it is the
// one number that must reach the controller: VoltPay's own floor is 500, so a
// customer switched onto this rail and quoted 500 would have their wallet
// reserved for a vend rejected on arrival. bills.controller takes
// max(ours, the resolved provider's) for exactly this reason.
const MIN_AMOUNTS = { airtime: 50, electricity: 1_000 };

// Their documented ceiling, identical on every rail and every network.
const MAX_AMOUNT = 200_000;

/* ------------------------------------------------------------------- caching */

// The mechanics are shared - see catalogueCache.js. The numbers are this
// provider's own, and they differ from the other rail's in one useful way:
// ClubKonnect serves *every* network's data plans in a single call and every
// TV provider's packages in another, where PairGate needs one call per plan
// family per network. A whole warm pass is about five calls rather than twenty,
// so the pacing gap can be far smaller without crowding anything.
const LOCAL_TTL_MS = Number(process.env.CLUBKONNECT_LOCAL_TTL_MS || 60_000);
const STALE_GRACE_MS = Number(process.env.CLUBKONNECT_STALE_GRACE_MS || 30 * 60_000);
const CATALOGUE_GAP_MS = Number(process.env.CLUBKONNECT_CATALOGUE_GAP_MS || 400);
const REFRESH_LOCK_MS = 60_000;

const catalogue = createCatalogueCache({
  label: 'clubkonnect',
  ttlMs: CATALOGUE_TTL_MS,
  localTtlMs: LOCAL_TTL_MS,
  staleGraceMs: STALE_GRACE_MS,
  gapMs: CATALOGUE_GAP_MS,
  lockMs: REFRESH_LOCK_MS,
});

const { cached, pace: paceCatalogue, drop: dropCatalogue, claimRefresh } = catalogue;

/* -------------------------------------------------------------------- errors */

function providerError(message, { statusCode = 502, payload = null, retryAfterMs = null, cause = null } = {}) {
  // `cause` is carried so retry.helper can walk the original socket error
  // instead of falling back to matching the words "fetch failed" in a string we
  // built ourselves.
  const err = cause ? new Error(message, { cause }) : new Error(message);
  err.statusCode = statusCode;
  // Named for the provider so a caller can tell the two apart in a log without
  // guessing. bills.controller reads `err.pairgate || err.clubkonnect`.
  err.clubkonnect = payload;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  if (isFloatError(message)) err.floatExhausted = true;
  return err;
}

// Our float, not the customer's wallet. Four separate codes mean this - the
// account balance, the API store balance, the dealer balance and the on-hold
// "insufficient API amount" - and they all have the same operational fix.
function isFloatError(message) {
  return /insufficient_(api)?(store)?(dealer)?(amount|balance)|insufficient\s+balance|low\s+balance/i.test(
    String(message || '')
  );
}

/* --------------------------------------------------------- status classifying */

// The full code table, from their dispute-resolution page. Grouped by what we
// have to *do* about each one, which is not the same as how they group them.
//
// The distinction that matters is terminal vs non-terminal. A terminal failure
// refunds the customer immediately. A non-terminal one must stay in
// `processing` and be requeried, because the order may still complete - and
// refunding it early means paying for a bill that then delivers, with no way to
// take the money back.
const STATUS = {
  SUCCESS: 'successful',
  PROCESSING: 'processing',
  FAILED: 'failed',
};

// Still in flight. `201` sits under ORDER_COMPLETED on their side but means the
// network never answered and the order is retried every five minutes for an
// hour before cancellation; `412` is an on-hold float shortage that is also
// retried. Both would be catastrophic to read as final in either direction.
const NON_TERMINAL = new Set(['100', '199', '201', '300', '399', '412']);

// Cancelled or credited back. Terminal, refund the customer.
const TERMINAL_FAILURE_PREFIXES = ['4', '5'];

/**
 * Turn a `statuscode` into one of three words the settlement layer understands.
 *
 * Deliberately code-first rather than status-string-first: the strings repeat
 * across very different outcomes (`ORDER_COMPLETED` covers both a real success
 * and a network timeout) while the numeric code is unambiguous.
 */
function classifyStatus(statuscode, statusText = '') {
  const code = String(statuscode ?? '').trim();

  if (code === '200') return STATUS.SUCCESS;
  if (NON_TERMINAL.has(code)) return STATUS.PROCESSING;

  if (code) {
    // 600-699 is ORDER_ONHOLD: non-terminal by default, because the retry
    // window may still land it. The two exceptions are the codes that say the
    // account was credited back, which is a completed reversal.
    if (code === '602' || code === '509') return STATUS.FAILED;
    if (code.startsWith('6')) return STATUS.PROCESSING;
    if (TERMINAL_FAILURE_PREFIXES.some(p => code.startsWith(p))) return STATUS.FAILED;
  }

  // No usable code. Fall back to the word, which the callback sometimes carries
  // instead (`orderstatus=ORDER_COMPLETED`).
  const text = String(statusText || '').trim().toUpperCase();
  if (text === 'ORDER_COMPLETED') return STATUS.SUCCESS;
  if (text === 'ORDER_CANCELLED' || text.startsWith('INVALID') || text.startsWith('MISSING')) return STATUS.FAILED;
  if (text === 'ORDER_RECEIVED' || text === 'ORDER_PROCESSED' || text === 'ORDER_ONHOLD') return STATUS.PROCESSING;

  return '';
}

/** True when a response describes a request we should never have sent. */
function isRejection(statusText) {
  const text = String(statusText || '').trim().toUpperCase();
  return text.startsWith('INVALID') || text.startsWith('MISSING') || text.includes('NOT_AVAILABLE');
}

// Their error vocabulary is a bare enum - `INVALID_DATAPLAN`, `MINIMUM_50`.
// Shown to a customer as-is that reads like a crash, so the ones a customer can
// actually hit get real wording. Anything unmapped falls through to the raw
// token, which is still better than a blank alert.
const MESSAGES = {
  INVALID_CREDENTIALS: 'Bills provider rejected our credentials',
  MISSING_CREDENTIALS: 'Bills provider rejected our credentials',
  INVALID_API: 'Bills provider rejected our credentials',
  INVALID_RECIPIENT: 'That phone number was not accepted',
  INVALID_MOBILENETWORK: 'Unknown network',
  INVALID_DATAPLAN: 'That data plan is no longer available',
  INVALID_SMARTCARDNO: 'Could not verify that smartcard number',
  INVALID_METERNO: 'Could not verify that meter number',
  PACKAGE_NOT_AVAILABLE: 'That package is no longer available',
  METERTYPE_NOT_AVAILABLE: 'That meter type is not available on this disco',
  INVALID_AMOUNT: 'Enter a valid amount',
  MINIMUM_50: 'Minimum amount is NGN 50',
  MINIMUM_100: 'Minimum amount is NGN 100',
  INSUFFICIENT_BALANCE: 'Insufficient balance',
};

function messageFor(statusText, fallback = 'ClubKonnect request failed') {
  const key = String(statusText || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!key) return fallback;
  return MESSAGES[key] || String(statusText).trim() || fallback;
}

/* ----------------------------------------------------------------- transport */

function getCredentials() {
  const userId = String(process.env.CLUBKONNECT_USER_ID || '').trim();
  const apiKey = String(process.env.CLUBKONNECT_API_KEY || '').trim();
  if (!userId || !apiKey) throw new Error('Missing required env: CLUBKONNECT_USER_ID / CLUBKONNECT_API_KEY');
  return { userId, apiKey };
}

/** Whether this provider is usable at all. Read by the admin switch and the warm pass. */
function isConfigured() {
  return Boolean(
    String(process.env.CLUBKONNECT_USER_ID || '').trim() && String(process.env.CLUBKONNECT_API_KEY || '').trim()
  );
}

/**
 * One request.
 *
 * `retry` defaults to **false** and every caller that wants it says so. This is
 * the opposite default to the other provider and it is the single most
 * important line in this file: there, retry keyed off the HTTP method, which
 * worked because only a vend was a POST. Here a vend is a GET like everything
 * else, so a method-derived default would silently retry purchases. A purchase
 * that timed out may already have been delivered; repeating it buys a second
 * one, bills the float twice and delivers data the customer paid once for.
 * What recovers a timed-out vend is the RequestID plus the query endpoint, not
 * another call.
 */
async function ckRequest(path, { query, retry = false, pace = false } = {}) {
  const attempt = () => ckRequestOnce(path, query);
  const once = pace ? () => paceCatalogue(attempt) : attempt;
  if (!retry) return once();
  return withRetry(once, { label: `clubkonnect ${path}` });
}

/** A catalogue read: safe to retry, and paced against its neighbours. */
function ckCatalogue(path, query) {
  return ckRequest(path, { query, retry: true, pace: true });
}

async function ckRequestOnce(path, query) {
  const { userId, apiKey } = getCredentials();

  const qs = new URLSearchParams();
  qs.append('UserID', userId);
  qs.append('APIKey', apiKey);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && String(v) !== '') qs.append(k, String(v));
  }

  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = `${BASE_URL}${suffix}?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Their catalogue and balance endpoints sit behind an edge cache
        // otherwise, which is how a topped-up float keeps reading as empty.
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    // `fetch` says only "fetch failed" for every connection-level problem and
    // hides the reason in `cause`, so the code is lifted out here. ENOTFOUND is
    // our DNS, ECONNREFUSED is their box, ECONNRESET is the path between us -
    // and their origin is in Lagos, so a rail vending from a datacentre on
    // another continent is exactly where the path is the suspect. Without the
    // code the line names none of them and the next occurrence is diagnosed
    // from scratch.
    const code = causeCode(e);
    const reason =
      e?.name === 'AbortError'
        ? `ClubKonnect request timed out after ${TIMEOUT_MS}ms`
        : `ClubKonnect request failed: ${e?.message || e}${code ? ` (${code})` : ''}`;

    throw providerError(reason, { statusCode: 504, cause: e });
  } finally {
    clearTimeout(timer);
  }

  const body = String(text || '').trim();

  let json;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // Not every error comes back as JSON. A bare `INVALID_CREDENTIALS` on the
    // wire is a documented answer, so a short non-JSON body is read as a status
    // word rather than thrown away as a parse failure. Anything longer is an
    // error page, which means we reached a gateway rather than the API.
    if (body && body.length <= 64 && /^[A-Z0-9_ ]+$/i.test(body)) {
      throw providerError(messageFor(body), { statusCode: 400, payload: { status: body } });
    }
    throw providerError('ClubKonnect returned an invalid response', {
      payload: { raw: body.slice(0, 500) },
    });
  }

  // The transport itself failed. Their API answers 200 for business errors, so
  // a non-2xx here is infrastructure rather than a declined order.
  if (!res.ok) {
    throw providerError(`ClubKonnect responded ${res.status}`, {
      statusCode: res.status >= 500 ? 502 : res.status,
      payload: json,
    });
  }

  return json;
}

/* ------------------------------------------------- provider identity mapping */

function normKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The app sends a network *name* and this API wants a zero-padded number. Every
// spelling the app or a stale client list can produce is listed - an unmapped
// network is a purchase addressed to nobody.
const NETWORK_CODES = {
  MTN: '01',
  GLO: '02',
  GLOBACOM: '02',
  '9MOBILE': '03',
  '9MOBILENG': '03',
  ETISALAT: '03',
  M9MOBILE: '03',
  T2MOBILE: '03',
  AIRTEL: '04',
};

// The reverse, for rendering the picker. The app ships logo assets keyed on
// these exact spellings, so they must match what the other provider emits or a
// switch changes the icons.
const NETWORK_DISPLAY = { '01': 'MTN', '02': 'GLO', '03': '9MOBILE', '04': 'AIRTEL' };

// Their JSON keys for the four networks, which are not the display names.
const NETWORK_KEY_ALIASES = { MTN: '01', GLO: '02', M9MOBILE: '03', T2MOBILE: '03', AIRTEL: '04' };

const TV_CODES = {
  DSTV: 'dstv',
  GOTV: 'gotv',
  STARTIMES: 'startimes',
  STARTIME: 'startimes',
  SHOWMAX: 'showmax',
};

const TV_DISPLAY = { dstv: 'DSTV', gotv: 'GOTV', startimes: 'STARTIMES', showmax: 'SHOWMAX' };

// The app's DISCO codes - and the asset filenames that go with them - map onto
// this provider's numbers, which are a completely different namespace from the
// other provider's slugs. `EKEDC` is `eko` there and `01` here.
//
// Every legacy spelling is listed for the same reason as on the other rail: an
// unmapped DISCO is a payment addressed to nobody.
const DISCO_CODES = {
  EKEDC: '01', EKO: '01',
  IKEDC: '02', IKEJA: '02',
  AEDC: '03', ABUJA: '03',
  KEDCO: '04', KANO: '04', KEDC: '04',
  PHED: '05', PHEDC: '05', PH: '05', PORTHARCOURT: '05',
  JED: '06', JEDC: '06', JOS: '06',
  IBEDC: '07', IBADAN: '07',
  KAEDCO: '08', KAEDC: '08', KADUNA: '08',
  EEDC: '09', ENUGU: '09',
  BEDC: '10', BENIN: '10',
  YEDC: '11', YOLA: '11',
  ABA: '12', APL: '12', APLE: '12',
};

// What the app should display and send back. Pinned to the code the app already
// ships assets for, exactly as on the other rail: their own name is a sentence
// ("Eko Electric - EKEDC (PHCN)") which is too long for the picker, and
// "Kaduna Electric - KAEDC" contains "aedc", which would make the app's logo
// resolver render Abuja's mark.
const DISCO_DISPLAY = {
  '01': 'EKEDC',
  '02': 'IKEDC',
  '03': 'AEDC',
  '04': 'KEDCO',
  '05': 'PHED',
  '06': 'JED',
  '07': 'IBEDC',
  '08': 'KAEDCO',
  '09': 'EEDC',
  '10': 'BEDC',
  '11': 'YEDC',
  '12': 'ABA',
};

function networkCode(provider) {
  const key = normKey(provider);
  if (!key) return '';
  if (NETWORK_CODES[key]) return NETWORK_CODES[key];
  // Already a code, from a client reading `code` rather than `name`.
  if (/^0[1-4]$/.test(String(provider || '').trim())) return String(provider).trim();
  return '';
}

function tvCode(provider) {
  const key = normKey(provider);
  if (!key) return '';
  if (TV_CODES[key]) return TV_CODES[key];
  return /^[A-Z0-9]+$/.test(key) ? key.toLowerCase() : '';
}

function discoCode(provider) {
  const raw = String(provider || '').trim();
  if (!raw) return '';
  // Already a code.
  if (/^(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return DISCO_CODES[normKey(raw)] || '';
}

// The app and the ledger speak "prepaid" / "postpaid"; this API wants 01 / 02.
// The string form stays canonical so nothing downstream learns a magic number.
function normalizeMeterType(meterType) {
  const t = String(meterType || '').trim().toLowerCase();
  if (t === '2' || t === '02' || t.startsWith('post')) return 'postpaid';
  return 'prepaid';
}

function meterTypeCode(meterType) {
  return normalizeMeterType(meterType) === 'postpaid' ? '02' : '01';
}

/* ------------------------------------------------------ response normalising */

// Their amounts are strings, and not always tidy ones - Airtel's plan list
// carries "484.912717854786". Rounded to kobo so a price never renders with
// twelve decimal places or drifts a fraction against what is charged.
function toAmount(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Unwrap the `{ Provider: [ { ID, PRODUCT: [...] } ] }` shape.
 *
 * Every list endpoint nests the same way: a root key, then one key per
 * provider, then a **single-element array** wrapping the object that actually
 * holds the products. The array is the part that catches people out - it looks
 * like a list of providers and is not.
 */
function unwrapGroups(root) {
  if (!root || typeof root !== 'object') return [];

  const out = [];
  for (const [name, value] of Object.entries(root)) {
    const holder = Array.isArray(value) ? value[0] : value;
    if (!holder || typeof holder !== 'object') continue;
    out.push({
      key: name,
      id: String(holder.ID ?? '').trim(),
      name: String(holder.NAME ?? name).trim(),
      products: Array.isArray(holder.PRODUCT) ? holder.PRODUCT : [],
    });
  }
  return out;
}

// The family a plan belongs to, pulled out of the trailing parenthetical:
// "1 GB - Weekly (SME)" -> SME. bills.controller groups the picker's tabs on
// this, and the same bundle is priced differently across families, so losing it
// would merge two different products into one indistinguishable list.
function planFamily(name) {
  const match = /\(([^)]+)\)\s*$/.exec(String(name || ''));
  if (!match) return '';
  // "Awoof Data" and "Direct Data" are the family plus a noun; the noun adds
  // nothing to a tab label.
  return match[1].trim().replace(/\s*data\s*$/i, '').toUpperCase();
}

/**
 * One shape for every purchase response, matching the other provider's exactly
 * so the controller reads the same fields either way.
 *
 * Unlike the other rail, `token` can be populated here: electricity returns
 * `metertoken` on the purchase call. It is still not guaranteed - the order is
 * only acknowledged at that point - so an absent token is normal and the
 * callback fills it in.
 */
function parseVendResult(json) {
  const data = json && typeof json === 'object' ? json : {};
  const statusText = String(data.status || data.orderstatus || '').trim();
  const state = classifyStatus(data.statuscode, statusText);

  return {
    reference: String(data.orderid || '').trim(),
    order_no: String(data.orderid || '').trim(),
    // Deliberately not defaulting to 'successful'. An unknown code on this rail
    // means "we do not know yet", and the sweep will settle it - guessing
    // success marks an undelivered bill as done and nobody ever refunds it.
    status: state === STATUS.SUCCESS ? 'successful' : state === STATUS.FAILED ? 'failed' : 'processing',
    token: String(data.metertoken || data.pin || '').trim(),
    units: String(data.units || data.unit || '').trim(),
    message: String(data.remark || data.orderremark || statusText || '').trim(),
    amount: toAmount(data.amountcharged ?? data.amount),
    plan: String(data.plan || '').trim(),
    test_mode: false,
    status_code: String(data.statuscode ?? '').trim(),
  };
}

/**
 * Throw if a vend response describes a rejection.
 *
 * Their API answers HTTP 200 for a refused order, so without this the wallet is
 * debited, the row is stamped and nothing is ever delivered. Only *terminal*
 * rejections throw - an order sitting at ORDER_RECEIVED is the normal happy
 * path on this rail and must be allowed through as `processing`.
 */
function assertAccepted(json) {
  const statusText = String(json?.status || json?.orderstatus || '').trim();
  const code = String(json?.statuscode ?? '').trim();
  const state = classifyStatus(code, statusText);

  if (state === STATUS.FAILED || (!state && isRejection(statusText))) {
    const message = messageFor(statusText, 'ClubKonnect declined this purchase');
    throw providerError(message, { statusCode: 400, payload: json });
  }

  // No order id and no recognisable state is not an acceptance either.
  if (!state && !String(json?.orderid || '').trim()) {
    throw providerError(messageFor(statusText, 'ClubKonnect returned an unrecognised response'), {
      statusCode: 502,
      payload: json,
    });
  }

  return json;
}

// A lookup answered, but a biller that cannot place the number says so with the
// error token *in the name field* rather than as an error. Letting that through
// means the confirmation sheet shows a meter owned by "INVALID_METERNO".
function parseCustomer(json) {
  const raw = String(json?.customer_name ?? '').trim();
  if (!raw || isRejection(raw)) return { customer_name: '', address: '' };
  return { customer_name: raw, address: '' };
}

/** The per-request callback, omitted when this deployment has no public URL. */
function callbackParam() {
  return CALLBACK_URL ? { CallBackURL: CALLBACK_URL } : {};
}

/* ------------------------------------------------------------------- account */

async function getWalletBalance() {
  const json = await ckRequest('/APIWalletBalanceV1.asp', { retry: true });
  return {
    balance: toAmount(json?.balance),
    currency: 'NGN',
    retrieved_at: String(json?.date || ''),
  };
}

// Where the float is topped up from. Not a secret - it is an account money is
// sent TO - but it is deployment config, so it is read from the environment.
function getFundingAccount() {
  return {
    bank_name: String(process.env.CLUBKONNECT_FUNDING_BANK || '').trim(),
    account_number: String(process.env.CLUBKONNECT_FUNDING_ACCOUNT_NUMBER || '').trim(),
    account_name: String(process.env.CLUBKONNECT_FUNDING_ACCOUNT_NAME || '').trim(),
  };
}

function floatThresholds() {
  const critical = Number(process.env.CLUBKONNECT_FLOAT_CRITICAL_NGN || 5_000);
  const low = Number(process.env.CLUBKONNECT_FLOAT_LOW_NGN || 25_000);
  return {
    critical: Number.isFinite(critical) && critical >= 0 ? critical : 5_000,
    low: Number.isFinite(low) && low >= 0 ? low : 25_000,
  };
}

function floatVerdict(balance) {
  const { critical, low } = floatThresholds();
  // Absent is not zero - see the same guard on the other rail. `Number(null)`
  // is 0, which would report an unreadable float as an empty one and raise the
  // loudest verdict on the screen off a missing field.
  if (balance == null || balance === '') return 'unknown';
  const amount = Number(balance);
  if (!Number.isFinite(amount)) return 'unknown';
  if (amount <= critical) return 'critical';
  if (amount <= low) return 'low';
  return 'healthy';
}

/**
 * The reconciliation read.
 *
 * Better than the other rail's in one respect: it can be queried by *our* own
 * RequestID as well as their order id, so a vend whose response was lost in
 * flight is still recoverable. Callers pass whichever they hold - a value that
 * looks like one of our trx strings goes in as RequestID.
 */
async function getTransactionStatus(reference, { byRequestId = false } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw providerError('reference is required', { statusCode: 400 });

  const json = await ckRequest('/APIQueryV1.asp', {
    query: byRequestId ? { RequestID: ref } : { OrderID: ref },
    retry: true,
  });

  const statusText = String(json?.status || json?.orderstatus || '').trim();
  return {
    reference_code: String(json?.orderid || ref),
    request_id: String(json?.requestid || '').trim(),
    type: String(json?.ordertype || '').trim().toLowerCase(),
    status: classifyStatus(json?.statuscode, statusText) || '',
    status_code: String(json?.statuscode ?? '').trim(),
    amount: toAmount(json?.amountcharged),
    item: String(json?.plan || '').trim(),
    recipient: String(json?.mobilenumber || '').trim(),
    // Query can carry the token where the purchase response did not.
    token: String(json?.metertoken || json?.pin || '').trim(),
    units: String(json?.units || '').trim(),
    remark: String(json?.remark || json?.orderremark || '').trim(),
    created_at: String(json?.date || json?.orderdate || ''),
  };
}

/* ------------------------------------------------------------------- airtime */

// The four networks are fixed and the codes are documented, so this does not
// need a provider call at all. Shaped identically to the other rail's output so
// the app cannot tell which provider answered.
async function listAirtimeProvidersCached() {
  return Object.entries(NETWORK_DISPLAY).map(([code, name]) => ({
    name,
    code,
    full_name: name,
    id: code,
  }));
}

async function buyAirtime({ provider, number, amount, reference }) {
  const code = networkCode(provider);
  if (!code) throw providerError('Unknown network', { statusCode: 400 });

  const json = await ckRequest('/APIAirtimeV1.asp', {
    query: {
      MobileNetwork: code,
      Amount: Number(amount),
      MobileNumber: String(number || '').trim(),
      RequestID: String(reference || '').trim(),
      ...callbackParam(),
    },
  });
  return assertAccepted(json);
}

/* --------------------------------------------------------------- data plans */

async function listDataProvidersCached() {
  return listAirtimeProvidersCached();
}

/**
 * Every network's plans, in one call.
 *
 * Cached whole rather than per network because that is how it arrives - asking
 * for MTN and asking for Glo is the same request. The per-network readers below
 * filter this, so opening four network tabs costs one provider call rather than
 * four.
 */
async function loadAllDataPlans({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'clubkonnect:data:all',
    async () => {
      const json = await ckCatalogue('/APIDatabundlePlansV2.asp');
      const groups = unwrapGroups(json?.MOBILE_NETWORK);

      const byCode = {};
      for (const group of groups) {
        // Their JSON key is the network name in their own spelling
        // ("m_9mobile"); the group's own ID is authoritative when present.
        const code = group.id || NETWORK_KEY_ALIASES[normKey(group.key)] || '';
        if (!code) continue;

        const plans = [];
        for (const row of group.products) {
          const id = String(row?.PRODUCT_ID ?? '').trim();
          const amount = toAmount(row?.PRODUCT_AMOUNT);
          if (!id || amount <= 0) continue;

          const name = String(row?.PRODUCT_NAME || '').trim() || `${amount} bundle`;

          // This rail has no duration field, so the plan name is the only place
          // the validity is ever stated ("500 MB - Monthly (SME)"). Read rather
          // than inferred: a name that does not say how long the bundle lasts
          // produces no validity at all, and the plan shows a price with no
          // expiry claim instead of a guessed one. See planDuration.js.
          const stated = readDuration(name);

          plans.push({
            id,
            name,
            amount,
            plan_type: planFamily(name),
            duration_days: stated?.days || 0,
            validity: stated?.label || '',
          });
        }
        plans.sort((a, b) => a.amount - b.amount);
        byCode[code] = plans;
      }
      return byCode;
    },
    ttlMs,
    { force }
  );
}

async function listDataPlansCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const code = networkCode(provider);
  if (!code) throw providerError('Provider is required', { statusCode: 400 });

  const all = await loadAllDataPlans({ ttlMs, force });
  return all[code] || [];
}

// Which families each network carries, derived from the plan list rather than
// fetched - this provider has no categories endpoint, and the family is already
// in every plan name.
async function listDataPlanTypesCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const all = await loadAllDataPlans({ ttlMs, force });
  const out = {};
  for (const [code, plans] of Object.entries(all)) {
    out[code] = [...new Set(plans.map(p => p.plan_type).filter(Boolean))];
  }
  return out;
}

async function buyData({ provider, planId, number, reference }) {
  const code = networkCode(provider);
  if (!code) throw providerError('Unknown network', { statusCode: 400 });

  const json = await ckRequest('/APIDatabundleV1.asp', {
    query: {
      MobileNetwork: code,
      DataPlan: String(planId || '').trim(),
      MobileNumber: String(number || '').trim(),
      RequestID: String(reference || '').trim(),
      ...callbackParam(),
    },
  });
  return assertAccepted(json);
}

/* ---------------------------------------------------------------------- tv */

/**
 * Providers and packages come from the same call, so both are served off one
 * cached read.
 *
 * Keyed by provider inside that structure rather than flattened, because
 * PACKAGE_ID is **not unique across providers** - Showmax republishes
 * Startimes' package ids verbatim. A flat lookup would let a Showmax purchase
 * address a Startimes bouquet.
 */
async function loadAllTvPackages({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'clubkonnect:tv:all',
    async () => {
      const json = await ckCatalogue('/APICableTVPackagesV2.asp');
      const groups = unwrapGroups(json?.TV_ID);

      const byCode = {};
      for (const group of groups) {
        const code = String(group.id || tvCode(group.key) || '').toLowerCase();
        if (!code) continue;

        const packages = [];
        for (const row of group.products) {
          const id = String(row?.PACKAGE_ID ?? '').trim();
          const amount = toAmount(row?.PACKAGE_AMOUNT);
          if (!id || amount <= 0) continue;
          // `code` and `id` are the same value - the purchase call addresses a
          // bouquet by Package, and the app has always sent back `code`.
          packages.push({ id, code: id, name: String(row?.PACKAGE_NAME || '').trim(), amount });
        }
        packages.sort((a, b) => a.amount - b.amount);
        byCode[code] = packages;
      }
      return byCode;
    },
    ttlMs,
    { force }
  );
}

async function listTvProvidersCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const all = await loadAllTvPackages({ ttlMs, force });
  return Object.keys(all).map(code => ({
    name: TV_DISPLAY[code] || code.toUpperCase(),
    code,
    full_name: TV_DISPLAY[code] || code.toUpperCase(),
    id: code,
  }));
}

async function listTvPackagesCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const code = tvCode(provider);
  if (!code) throw providerError('Provider is required', { statusCode: 400 });

  const all = await loadAllTvPackages({ ttlMs, force });
  return all[code] || [];
}

// Smartcard / IUC lookup. The response carries the account holder's name, so the
// caller must treat it as PII: show it to the customer who asked, never log it.
async function validateTvSmartcard({ provider, number }) {
  const code = tvCode(provider);
  if (!code) throw providerError('Unknown TV provider', { statusCode: 400 });

  const json = await ckRequest('/APIVerifyCableTVV1.asp', {
    query: { CableTV: code, SmartCardNo: String(number || '').trim() },
    retry: true,
  });
  return parseCustomer(json);
}

async function payTv({ provider, number, code, reference, customerName }) {
  const slug = tvCode(provider);
  if (!slug) throw providerError('Unknown TV provider', { statusCode: 400 });

  // `customerName` is accepted for contract parity with the other provider,
  // which sends it as `recipient_name`. This API has no field for it, and
  // appending an unrecognised query parameter to a purchase is a good way to
  // have the order rejected - so it is accepted and dropped rather than guessed
  // at. The name still reaches the customer's receipt from our own ledger.
  void customerName;

  const json = await ckRequest('/APICableTVV1.asp', {
    query: {
      CableTV: slug,
      Package: String(code || '').trim(),
      SmartCardNo: String(number || '').trim(),
      RequestID: String(reference || '').trim(),
      ...callbackParam(),
    },
  });
  return assertAccepted(json);
}

/* ------------------------------------------------------------- electricity */

async function listElectricityDiscosCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'clubkonnect:providers:electricity',
    async () => {
      const json = await ckCatalogue('/APIElectricityDiscosV1.asp');
      const groups = unwrapGroups(json?.ELECTRIC_COMPANY);

      return groups
        .map(group => {
          const code = String(group.id || '').trim();
          if (!code) return null;
          return {
            // The app renders `name` and sends it back, so it has to be the
            // code this app has always used, not their sentence.
            name: DISCO_DISPLAY[code] || group.name,
            code,
            full_name: group.name,
            id: code,
          };
        })
        .filter(Boolean);
    },
    ttlMs,
    { force }
  );
}

// Meter lookup. Same PII rule as the smartcard lookup - the customer name in the
// response is display-only. No address is returned on this rail.
async function validateElectricityMeter({ provider, number, meterType }) {
  const code = discoCode(provider);
  if (!code) throw providerError('Unknown electricity provider', { statusCode: 400 });

  const json = await ckRequest('/APIVerifyElectricityV1.asp', {
    query: {
      ElectricCompany: code,
      MeterNo: String(number || '').trim(),
      MeterType: meterTypeCode(meterType),
    },
    retry: true,
  });
  return parseCustomer(json);
}

async function payElectricity({ provider, number, meterType, amount, reference, customerName }) {
  const code = discoCode(provider);
  if (!code) throw providerError('Unknown electricity provider', { statusCode: 400 });

  void customerName;

  const json = await ckRequest('/APIElectricityV1.asp', {
    query: {
      ElectricCompany: code,
      MeterType: meterTypeCode(meterType),
      MeterNo: String(number || '').trim(),
      Amount: Number(amount),
      RequestID: String(reference || '').trim(),
      ...callbackParam(),
    },
  });
  return assertAccepted(json);
}

/* ------------------------------------------------------------------ warming */

/**
 * Load every catalogue into both cache tiers.
 *
 * Far cheaper than the other rail's warm: data plans and TV packages each
 * arrive whole in a single call, so a full pass is three provider calls rather
 * than twenty. Airtime and data network lists are static tables and cost none.
 *
 * Same contract as the other provider - `{ loaded, failed, calls, skipped }` -
 * and the same two refusals: no credentials, and no shared cache on a forced
 * pass. Every step is independent so one failure never stops the rest.
 */
async function warmCatalogues({ force = false, lockMs = REFRESH_LOCK_MS } = {}) {
  if (!isConfigured()) return { loaded: 0, failed: 0, calls: 0, skipped: 'no_api_key' };

  if (force) {
    const claim = await claimRefresh('clubkonnect:warm', lockMs);
    // One instance warms per cycle. N instances forcing the same refresh in the
    // same minute is N times the calls for one identical answer.
    if (claim === REFRESH_HELD) return { loaded: 0, failed: 0, calls: 0, skipped: 'locked' };
    // No working Redis means no L2, and L2 is the entire product of a forced
    // pass - L1 is capped at a minute while the next tick is 25 away.
    if (claim === REFRESH_NO_LOCK) return { loaded: 0, failed: 0, calls: 0, skipped: 'no_shared_cache' };
  }

  const opts = { force };
  const callsBefore = catalogue.callCount();
  let loaded = 0;
  let failed = 0;

  const step = async (label, fn) => {
    try {
      await fn();
      loaded += 1;
    } catch (e) {
      failed += 1;
      console.warn(`⚠️  clubkonnect catalogue warm failed ${label}:`, String(e?.message || e).slice(0, 120));
    }
  };

  await step('data plans', () => loadAllDataPlans(opts));
  await step('tv packages', () => loadAllTvPackages(opts));
  await step('electricity discos', () => listElectricityDiscosCached(opts));

  return { loaded, failed, calls: catalogue.callCount() - callsBefore, skipped: null };
}

/* ------------------------------------------------------------------ webhook */

/**
 * There is no signature to verify.
 *
 * ClubKonnect's callback is a plain POST (or GET) to whatever `CallBackURL` was
 * sent with the order, with no HMAC, no shared secret and no timestamp. The
 * contract still requires this function so both providers look the same to the
 * webhook layer, and it answers honestly: never verified, never configurable.
 *
 * That is not a gap to be closed here - it is a property of their API, and the
 * controller handles it by treating every delivery as an unauthenticated hint
 * and re-reading the outcome over the authenticated query endpoint.
 */
function verifyWebhookSignature() {
  return { verified: false, configured: false, reason: 'no_signature_scheme' };
}

module.exports = {
  MIN_AMOUNTS,
  MAX_AMOUNT,
  TEST_MODE: false,
  // Their query endpoint accepts our own RequestID as well as their order id,
  // so a vend whose response was lost in flight is still recoverable. The
  // reconciler checks this before trying it - see billReconcile.helper.
  SUPPORTS_REQUEST_ID_LOOKUP: true,
  isConfigured,
  // account
  getWalletBalance,
  getFundingAccount,
  floatThresholds,
  floatVerdict,
  getTransactionStatus,
  // airtime
  listAirtimeProvidersCached,
  buyAirtime,
  // data
  listDataProvidersCached,
  listDataPlanTypesCached,
  listDataPlansCached,
  buyData,
  // tv
  listTvProvidersCached,
  listTvPackagesCached,
  validateTvSmartcard,
  payTv,
  // electricity
  listElectricityDiscosCached,
  validateElectricityMeter,
  payElectricity,
  normalizeMeterType,
  meterTypeCode,
  // shared
  parseVendResult,
  verifyWebhookSignature,
  isFloatError,
  dropCatalogue,
  warmCatalogues,
  // exported for tests
  classifyStatus,
  assertAccepted,
  parseCustomer,
  messageFor,
  unwrapGroups,
  planFamily,
  toAmount,
  networkCode,
  tvCode,
  discoCode,
  DISCO_CODES,
  DISCO_DISPLAY,
  NETWORK_DISPLAY,
};
