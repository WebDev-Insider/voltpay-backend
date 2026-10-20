// ClubKonnect (Nellobyte Systems) bills provider: airtime, data and cable TV.
//
// **Never electricity.** The owner barred it (October 2026). This module has no
// DISCO list, no meter lookup and no electricity purchase, and billsProvider
// refuses to route the rail here on top of that - so an electricity order that
// somehow reached this file would find nothing to call. Do not add one.
//
// Same contract as mysubwallet.service.js: this file owns the transport, the
// provider identifiers and the error shape, and nothing else. Pricing, wallet
// movement and the ledger stay in the controllers. It was a registered provider
// once before (removed October 2026); this is that adapter brought up to the
// current contract - above all, an answer we could not read is asked about by
// our own reference before anyone refunds it.
//
// Auth is two query parameters on every call, `UserID` and `APIKey`. Their API
// also checks the caller's IP: the server's outbound address must be
// whitelisted on the ClubKonnect dashboard, or every call answers
// INVALID_CREDENTIALS whatever the key says.
//
// Five things about this API shape everything below:
//
//   1. **Every call is a GET, purchases included.** So retry cannot be decided
//      by HTTP method - a vend and a catalogue read are the same verb. Retry is
//      opt-in per call and defaults to OFF; a vend is never retried. What
//      recovers one is its RequestID - see vend().
//   2. **`statuscode` is the outcome, and HTTP 200 carries refusals too.** Their
//      dispute-resolution table (APIParaGetDisputeResolutionV1): 100 received,
//      200 delivered, 201 "network unresponsive" (retried for an hour, then
//      cancelled), 3xx processing, 4xx refused at the door, 5xx cancelled, 6xx
//      on hold (602: credited back), 899 refunded. The status word is not
//      enough on its own - ORDER_COMPLETED covers 200, 201 and 299 alike.
//   3. **RequestID is ours, and the query endpoint takes it.** Every purchase
//      carries our trx as its RequestID, so a vend whose answer never reached
//      us can still be asked about.
//   4. **Identifiers are zero-padded strings.** Networks are 01 MTN, 02 Glo,
//      03 9mobile, 04 Airtel - nobody else's order. The app speaks network
//      names, so both directions are mapped here.
//   5. **No callback is requested.** Theirs is unsigned, and the receipt poll
//      and the bills sweep settle every order without one.
//
// Like every bills rail, this is a prepaid float: a purchase debits our
// ClubKonnect wallet, not the customer's. "Insufficient balance" from this API
// is an operational incident and never something to show a funded customer.
const { withRetry, causeCode } = require('../helpers/retry.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { createCatalogueCache, REFRESH_HELD, REFRESH_NO_LOCK } = require('./catalogueCache');
const { splitDuration } = require('./planDuration');

const BASE_URL = String(process.env.CLUBKONNECT_BASE_URL || 'https://www.nellobytesystems.com').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CLUBKONNECT_TIMEOUT_MS || 30_000);
const CATALOGUE_TTL_MS = Number(process.env.CLUBKONNECT_CATALOGUE_TTL_MS || 30 * 60_000);

// A vend whose outcome we could not read is asked about once by its RequestID
// before anyone refunds it. Longer than MySubWallet's pause: their origin is a
// single box in Lagos, and an order cut off mid-write needs a moment to appear.
const RECOVERY_DELAY_MS = Number(process.env.CLUBKONNECT_RECOVERY_DELAY_MS || 3_000);

// The rails this adapter implements. billsProvider routes nothing else here.
const SERVICES = ['airtime', 'data', 'tv'];

// Their airtime floor: status 407, MINIMUM_100. VoltPay's own is the same, and
// bills.controller takes the stricter of the two.
const MIN_AMOUNTS = { airtime: 100 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------- caching */

// The mechanics are shared - see catalogueCache.js. A full warm pass here is
// two calls: every network's data plans arrive in one, every bouquet in the
// other.
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

/* --------------------------------------------------------------- credentials */

function credentials() {
  return {
    userId: String(process.env.CLUBKONNECT_USER_ID || '').trim(),
    apiKey: String(process.env.CLUBKONNECT_API_KEY || '').trim(),
  };
}

// Env var names only - never a value.
function configStatus() {
  const { userId, apiKey } = credentials();
  const missing = [];
  if (!userId) missing.push('CLUBKONNECT_USER_ID');
  if (!apiKey) missing.push('CLUBKONNECT_API_KEY');
  return { configured: missing.length === 0, missing, problems: [] };
}

function isConfigured() {
  return configStatus().configured;
}

/* -------------------------------------------------------------------- errors */

const UNAVAILABLE = 'This service is briefly unavailable. Please try again shortly.';
const GENERIC = 'We could not complete this request. Please try again.';
const PHONE_MESSAGE = 'That phone number was not accepted for this network. Check the number and the network.';
const PLAN_MESSAGE = 'That plan is no longer available. Please pick another one.';
const SMARTCARD_MESSAGE = 'We could not verify that smartcard / IUC number. Check it and try again.';

/**
 * An error a controller can hand straight to a customer.
 *
 * Same shape as mysubwallet.service.js's: `message` is always ours and safe to
 * show, their raw text rides on `providerMessage`, and the flags say what kind
 * of failure it was - `ambiguous` (may have landed: ask before refunding),
 * `floatExhausted` (our float), `misconfigured` (our key, our IP, our ids).
 * The trimmed body is on `clubkonnect`, named for the provider so a log line
 * says who spoke.
 */
function providerError(message, opts = {}) {
  const {
    statusCode = 502,
    payload = null,
    providerMessage = '',
    retryAfterMs = null,
    cause = null,
    ambiguous = false,
    floatExhausted = false,
    misconfigured = false,
    notFound = false,
    kind = '',
    httpStatus = null,
  } = opts;

  const err = cause ? new Error(message, { cause }) : new Error(message);
  err.statusCode = statusCode;
  err.clubkonnect = payload;
  err.providerMessage = providerMessage;
  if (httpStatus != null) err.httpStatus = httpStatus;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  if (ambiguous) err.ambiguous = true;
  if (floatExhausted) err.floatExhausted = true;
  if (misconfigured) err.misconfigured = true;
  if (notFound) err.notFound = true;
  if (kind) err.kind = kind;
  return err;
}

function outage(providerMessage, opts = {}) {
  return providerError(UNAVAILABLE, { statusCode: 503, kind: 'outage', providerMessage, ...opts });
}

// Our float, not the customer's wallet. INSUFFICIENT_BALANCE,
// INSUFFICIENT_APISTOREAMOUNT and INSUFFICIENT_APISTOREDEALERAMOUNT all have
// the same fix. (INSUFFICIENT_APIAMOUNT, 412, is not a refusal: the order is put
// on hold and retried - see classifyStatus.)
function isFloatError(text) {
  return /INSUFFICIENT_(BALANCE|APISTORE\w*)|insufficient\s+(wallet\s+)?(balance|fund)|low\s+balance/i.test(String(text || ''));
}

// Our credentials, our IP or our account set-up - never the customer's.
const CREDENTIAL_WORDS = /^(INVALID_CREDENTIALS|MISSING_CREDENTIALS|MISSING_USERID|MISSING_APIKEY|INVALID_API(_ERROR\d*)?|INVALID_PAYMENT_OPTION)$/;

// One of OUR identifiers refused - a network or cable code read from our own
// tables. Nothing the customer types can fix it.
const OUR_ID_WORDS = /^(MISSING|INVALID)_(MOBILENETWORK|CABLETV)$/;

// A not-found answer from the query endpoint. Their docs do not say what an
// unknown id returns, so only wording that plainly says so counts.
const NOT_FOUND_WORDS = /NOT_?FOUND|NO_?(RECORD|ORDER|TRANSACTION)|INVALID_?(ORDER|REQUEST)_?ID|DOES_?NOT_?EXIST/i;

function wordKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

// Status words that are themselves a refusal rather than an order state.
function isErrorWord(word) {
  const key = wordKey(word);
  return /^(INVALID_|MISSING_|MINIMUM_|MAXIMUM_|INSUFFICIENT_)|_NOT_AVAILABLE$/.test(key);
}

/**
 * Turn a refusal into an error with a customer-safe message.
 *
 * The enum (`INVALID_RECIPIENT`) can arrive as the status word or - under the
 * generic ORDER_ERROR status - as the remark, so both are read as one. A
 * cancelled order's remark is a sentence instead ("Not a valid subscriber").
 * Never shown verbatim: all of it is written for a reseller.
 */
function declined({ word = '', remark = '', code = '' } = {}, { statusCode = 400, payload = null } = {}) {
  const keys = [wordKey(word), wordKey(remark)].filter(Boolean);
  const has = re => keys.some(k => re.test(k));
  const matchOf = re => keys.map(k => re.exec(k)).find(Boolean) || null;
  const raw = [word, remark].filter(Boolean).join(' - ');
  const base = { payload, providerMessage: raw || (code ? `status ${code}` : '') };

  if (keys.some(isFloatError) || isFloatError(remark)) {
    return providerError(UNAVAILABLE, { ...base, statusCode: 503, floatExhausted: true, kind: 'outage' });
  }
  if (has(CREDENTIAL_WORDS) || has(OUR_ID_WORDS)) {
    return providerError(UNAVAILABLE, { ...base, statusCode: 503, misconfigured: true, kind: 'outage' });
  }

  const minimum = matchOf(/^MINIMUM_(\d+)$/);
  if (minimum) {
    return providerError(`The minimum amount is NGN ${Number(minimum[1]).toLocaleString('en-NG')}.`, { ...base, statusCode, kind: 'limit' });
  }
  const maximum = matchOf(/^MAXIMUM_(\d+)$/);
  if (maximum) {
    return providerError(`The maximum amount is NGN ${Number(maximum[1]).toLocaleString('en-NG')}.`, { ...base, statusCode, kind: 'limit' });
  }
  if (has(/^(INVALID|MISSING)_AMOUNT$/)) {
    return providerError('Enter a valid amount.', { ...base, statusCode, kind: 'limit' });
  }

  if (has(/RECIPIENT|MOBILENUMBER|PHONENO/)) return providerError(PHONE_MESSAGE, { ...base, statusCode, kind: 'input' });
  if (has(/DATAPLAN|PACKAGE/)) return providerError(PLAN_MESSAGE, { ...base, statusCode, kind: 'input' });
  if (has(/SMARTCARD/)) return providerError(SMARTCARD_MESSAGE, { ...base, statusCode, kind: 'input' });

  // A cancelled order says why in a sentence (codes 515-520).
  if (/subscriber|network\s+user|not\s+eligible|pending\s+activation|wrong\s+state/i.test(remark)) {
    return providerError('That number cannot receive this purchase on this network. Check the number and the network.', {
      ...base,
      statusCode,
      kind: 'input',
    });
  }
  if (/busy|network\s+error|cannot\s+be\s+processed/i.test(remark) || has(/_NOT_AVAILABLE$/)) {
    return providerError('This service is temporarily unavailable. Please try again later.', { ...base, statusCode, kind: 'unavailable' });
  }

  return providerError(GENERIC, { ...base, statusCode, kind: 'unknown' });
}

/**
 * Say a refusal in the caller's words. Only an 'input' or an 'unknown' refusal
 * is reworded; an outage or a limit already says the right thing anywhere.
 */
function inCallerTerms(e, message, { kinds = ['input', 'unknown'] } = {}) {
  if (e && message && kinds.includes(e.kind)) e.message = message;
  return e;
}

function reworded(e, { fallback } = {}) {
  if (e?.kind === 'unknown' && fallback) e.message = fallback;
  return e;
}

/* ------------------------------------------------------------ status reading */

/**
 * 'successful' | 'processing' | 'failed' | '' for an order.
 *
 * Code first, from their dispute table; the word only when there is no code.
 * Strict on purpose: an unrecognised answer is '' - "we do not know" - and
 * never defaults to success, because guessing success marks an undelivered bill
 * as done and nobody ever refunds it.
 */
function classifyStatus(statuscode, statusText = '') {
  const code = String(statuscode ?? '').trim();

  if (/^\d{3}$/.test(code)) {
    if (code === '200') return 'successful';
    // A float shortfall put on hold and retried, not a refusal.
    if (code === '412') return 'processing';
    // Refused at the door (ORDER_ERROR) or cancelled (ORDER_CANCELLED).
    if (code.startsWith('4') || code.startsWith('5')) return 'failed';
    // On hold - except the one that says the account was credited back.
    if (code === '602') return 'failed';
    // ORDER_REFUNDED.
    if (code.startsWith('8')) return 'failed';
    // Received, completed-but-unconfirmed (201, 299), processing, on hold,
    // processed: in flight or unknown, so it stays open and is asked about.
    return 'processing';
  }

  const word = wordKey(statusText);
  if (!word) return '';
  // Without a code, ORDER_COMPLETED is any of 200, 201 or 299 - not proof of
  // delivery. The query endpoint carries the code, so the sweep settles it.
  if (word === 'ORDER_COMPLETED') return 'processing';
  if (['ORDER_RECEIVED', 'ORDER_PROCESSING', 'ORDER_PROCESSED', 'ORDER_ONHOLD', 'INSUFFICIENT_APIAMOUNT'].includes(word)) {
    return 'processing';
  }
  if (['ORDER_CANCELLED', 'ORDER_ERROR', 'ORDER_REFUNDED'].includes(word)) return 'failed';
  if (isErrorWord(word)) return 'failed';
  return '';
}

/** The fields every answer is read through. */
function answerOf(json) {
  const data = json && typeof json === 'object' ? json : {};
  const code = String(data.statuscode ?? data.StatusCode ?? '').trim();
  const word = String(data.status ?? data.orderstatus ?? '').trim();
  return {
    code,
    word,
    remark: String(data.remark ?? data.orderremark ?? '').trim(),
    orderid: String(data.orderid ?? data.OrderID ?? '').trim(),
    state: classifyStatus(code, word),
  };
}

// Only the fields worth keeping. A wallet-balance answer names our account's
// phone and email, and an error payload can travel as far as the app.
function trimmedPayload(json) {
  if (!json || typeof json !== 'object') return null;
  const answer = answerOf(json);
  return { status: answer.word || null, statuscode: answer.code || null };
}

/**
 * The catalogue a list endpoint answered with, or the error its answer
 * amounts to.
 *
 * Their list endpoints refuse on HTTP 200 too: with a key they do not accept -
 * or from a server IP they have not whitelisted, which they report the same way
 * - the plan list answers `{"status":"INVALID_CREDENTIALS"}` instead of the
 * catalogue. Read as a catalogue, that was every network with nothing in it:
 * cached for half an hour and shown to customers as "no data", with nobody
 * told why. An answer without the catalogue's root is a refusal, never an
 * empty catalogue.
 */
function catalogueRoot(json, root) {
  const groups = json?.[root];
  if (groups && typeof groups === 'object') return groups;

  const answer = answerOf(json);
  if (answer.word && isErrorWord(answer.word)) {
    throw declined(answer, { statusCode: 503, payload: trimmedPayload(json) });
  }
  throw outage(`ClubKonnect answered without a ${root} catalogue`, { payload: trimmedPayload(json) });
}

// A catalogue that parsed to nothing is not one to cache and sell from: no
// network ever has zero plans, so it is a format we did not understand.
function nonEmpty(byKey, what) {
  const count = Object.values(byKey).reduce((n, list) => n + list.length, 0);
  if (!count) throw outage(`ClubKonnect ${what} catalogue had nothing we could sell`);
  return byKey;
}

// Amounts arrive as strings, not always tidy ones - an Airtel plan once cost
// "484.912717854786". Rounded to kobo.
function toAmount(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/* ----------------------------------------------------------------- transport */

/**
 * One request.
 *
 * `retry` defaults to **false** and every read that wants it says so. Here a
 * purchase is a GET like everything else, so a method-derived default would
 * silently retry purchases: one that timed out may already have been
 * delivered, and repeating it buys a second.
 */
async function ckRequest(path, { query, retry = false, pace = false } = {}) {
  const attempt = () => ckRequestOnce(path, query);
  const once = pace ? () => paceCatalogue(attempt) : attempt;
  if (!retry) return once();
  return withRetry(once, { label: `clubkonnect ${path}` });
}

/** A catalogue read: safe to retry, and paced against its neighbours. */
function ckCatalogue(path) {
  return ckRequest(path, { retry: true, pace: true });
}

async function ckRequestOnce(path, query) {
  const { userId, apiKey } = credentials();
  if (!userId || !apiKey) {
    throw outage('Missing required env: CLUBKONNECT_USER_ID / CLUBKONNECT_API_KEY', { misconfigured: true });
  }

  const qs = new URLSearchParams();
  qs.append('UserID', userId);
  qs.append('APIKey', apiKey);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && String(v) !== '') qs.append(k, String(v));
  }
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Their balance and catalogue answers sit behind an edge cache
        // otherwise, which is how a topped-up float keeps reading as empty.
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    // `fetch` says only "fetch failed" and hides the reason in `cause`.
    // ENOTFOUND is our DNS, ECONNREFUSED their box, ECONNRESET the path
    // between. Ambiguous by definition: a request cut off mid-flight may have
    // been processed at the far end.
    const code = causeCode(e);
    const reason =
      e?.name === 'AbortError'
        ? `ClubKonnect request timed out after ${TIMEOUT_MS}ms`
        : `ClubKonnect request failed: ${e?.message || e}${code ? ` (${code})` : ''}`;
    throw providerError(UNAVAILABLE, { statusCode: 504, cause: e, ambiguous: true, kind: 'outage', providerMessage: reason });
  } finally {
    clearTimeout(timer);
  }

  // Refused before their application ran: a firewall, a wrong path. Nothing was
  // processed, so these are not ambiguous - and none is the customer's doing.
  if (res.status === 429) {
    throw providerError(UNAVAILABLE, { statusCode: 429, kind: 'outage', providerMessage: 'Too many requests', httpStatus: 429 });
  }
  if (res.status >= 400 && res.status < 500) {
    throw outage(`HTTP ${res.status}`, { misconfigured: true, httpStatus: res.status });
  }
  // Their server failed partway. Whether a purchase went through is unknown.
  if (res.status >= 500) {
    throw providerError(UNAVAILABLE, { statusCode: 502, ambiguous: true, kind: 'outage', providerMessage: `HTTP ${res.status}`, httpStatus: res.status });
  }

  const body = String(text || '').trim();
  try {
    const json = body ? JSON.parse(body) : null;
    if (json && typeof json === 'object') return json;
  } catch {
    /* read below */
  }

  // A bare status word is a documented answer ("INVALID_CREDENTIALS" on its
  // own), so a short one is read as `{ status }`. Anything longer is an error
  // page from something in front of their API: not an answer at all.
  if (body && body.length <= 64 && /^[A-Z0-9_ ]+$/i.test(body)) return { status: body };

  throw providerError(UNAVAILABLE, {
    statusCode: 502,
    ambiguous: true,
    kind: 'outage',
    providerMessage: `ClubKonnect returned a non-JSON response (HTTP ${res.status})`,
    httpStatus: res.status,
  });
}

/* ------------------------------------------------- provider identity mapping */

function normKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// In the order MySubWallet lists them, so a switch does not reshuffle the app's
// network picker. Names are the spellings the app ships logos for.
const NETWORKS = [
  { code: '01', name: 'MTN' },
  { code: '04', name: 'AIRTEL' },
  { code: '02', name: 'GLO' },
  { code: '03', name: '9MOBILE' },
];

// Every spelling the app, a stale client or their own JSON keys produce.
const NETWORK_ALIASES = {
  MTN: 'MTN',
  AIRTEL: 'AIRTEL',
  GLO: 'GLO',
  GLOBACOM: 'GLO',
  '9MOBILE': '9MOBILE',
  '9MOBILENG': '9MOBILE',
  M9MOBILE: '9MOBILE',
  ETISALAT: '9MOBILE',
  T2: '9MOBILE',
  T2MOBILE: '9MOBILE',
};

/** The app's network name, or '' when it is not one we can vend to. */
function networkName(value) {
  const raw = String(value || '').trim();
  const byCode = NETWORKS.find(n => n.code === raw);
  if (byCode) return byCode.name;
  return NETWORK_ALIASES[normKey(raw)] || '';
}

function networkCode(value) {
  const name = networkName(value);
  return NETWORKS.find(n => n.name === name)?.code || '';
}

// The three TV brands the app has a flow for. Their catalogue also sells
// Showmax, which has no smartcard - it is left out rather than offered on a
// screen built around one.
const TV = [
  { code: 'dstv', name: 'DSTV', aliases: ['DSTV'] },
  { code: 'gotv', name: 'GOTV', aliases: ['GOTV'] },
  { code: 'startimes', name: 'STARTIMES', aliases: ['STARTIMES', 'STARTIME'] },
];

function tvEntry(value) {
  const key = normKey(value);
  return TV.find(t => t.aliases.includes(key)) || null;
}

// Their purchase calls take the 11-digit local form (0803...).
function providerPhone(number) {
  const phone = normalizeNgPhone(number);
  if (!phone) throw providerError('Enter a valid Nigerian phone number', { statusCode: 400, kind: 'input' });
  return phone.local;
}

/* ------------------------------------------------------ response normalising */

/**
 * Unwrap their `{ Provider: [ { ID, PRODUCT: [...] } ] }` lists.
 *
 * A root key, then one key per provider, then a **single-element array**
 * wrapping the object that holds the products. The array is the part that
 * catches people out: it looks like a list of providers and is not.
 */
function unwrapGroups(root) {
  if (!root || typeof root !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(root)) {
    const holder = Array.isArray(value) ? value[0] : value;
    if (!holder || typeof holder !== 'object') continue;
    out.push({
      key,
      id: String(holder.ID ?? '').trim(),
      products: Array.isArray(holder.PRODUCT) ? holder.PRODUCT : [],
    });
  }
  return out;
}

// Plan families as their names spell them onto the keys bills.controller groups
// and labels on - the same keys MySubWallet's plans use.
const FAMILY_ALIASES = {
  COOPERATEGIFTING: 'CG',
  CORPORATEGIFTING: 'CG',
  CORPORATE: 'CG',
  CG: 'CG',
};

function planFamily(words) {
  const key = normKey(words);
  return FAMILY_ALIASES[key] || key;
}

/**
 * A plan name a customer can read, and the validity stated in it.
 *
 *   "500 MB - 30 days (SME)"        -> "500 MB (SME)", 30 days
 *   "1 GB - Monthly (Corporate Gifting)" -> "1 GB (CG)", Monthly
 *   "100 MB (GIFTING)"              -> "100 MB (GIFTING)", no validity
 *
 * The family comes off the trailing brackets and goes back on in the form the
 * picker uses everywhere. The validity is only ever *read*: a name that does
 * not state one gets none, and the plan is listed under "All".
 */
function shapePlanName(rawName) {
  const name = String(rawName || '').trim();
  const bracket = /\(([^)]+)\)\s*$/.exec(name);
  const family = bracket ? planFamily(bracket[1].replace(/\s*data\s*$/i, '')) : '';
  const head = bracket ? name.slice(0, bracket.index).trim() : name;

  const { duration, rest } = splitDuration(head);
  const label = rest.replace(/^[\s–—,-]+|[\s–—,-]+$/g, '').replace(/\s{2,}/g, ' ').trim() || head || name;

  return { name: family ? `${label} (${family})` : label, family, duration };
}

// Their bouquet names quote a price ("DStv Padi N3,600"). The tile prints our
// price beside the name, so a second, possibly different, number comes out.
function shapeTvName(rawName) {
  const name = String(rawName || '').trim();
  const cleaned = name
    .replace(/\s*[-–—=:]?\s*(?<![A-Za-z])(?:₦|NGN|N)\s?\d[\d,]*(?:\.\d+)?/g, '')
    .replace(/\s*[-–—]\s*\d[\d,]*(?:\.\d+)?\s*naira\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s–—,-]+$/, '')
    .trim();
  return cleaned || name;
}

/**
 * Is this one of THEIR order ids? All digits ("6716176945"). Ours always carry
 * letters, so the two can never be mistaken for each other.
 */
function isOrderId(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

// A float shortfall they park rather than refuse: status 412 /
// INSUFFICIENT_APIAMOUNT, "put on hold, retried before cancellation".
function isFloatHold(answer) {
  return answer.code === '412' || wordKey(answer.word) === 'INSUFFICIENT_APIAMOUNT' || wordKey(answer.remark) === 'INSUFFICIENT_APIAMOUNT';
}

/**
 * One shape for every purchase response, matching the other adapters', so the
 * controller reads the same fields whichever upstream answered.
 *
 * A declined vend never reaches here - vend() throws it - so this only has to
 * tell "delivered" from "accepted, still going".
 *
 * `unconfirmed`: accepted, but with no order id of theirs. Every order they
 * actually hold has one, so this is not proof that one exists - a word with no
 * order behind it (INSUFFICIENT_APIAMOUNT on its own), or a lost answer our
 * RequestID could not place. The bill stays open and billReconcile settles it
 * on evidence: the order turns up under our RequestID, or never does.
 */
function parseVendResult(json) {
  const data = json && typeof json === 'object' ? json : {};
  const answer = answerOf(data);
  const delivered = answer.state === 'successful';
  return {
    // Their order id when they gave one: the query endpoint is keyed on it, and
    // it is what their dashboard shows. Our RequestID otherwise.
    reference: answer.orderid || String(data.requestid || '').trim(),
    order_no: answer.orderid,
    status: delivered ? 'successful' : 'processing',
    unconfirmed: !delivered && !isOrderId(answer.orderid),
    // Parked for want of float: the bill waits, and whoever tops it up is paged.
    float_hold: !delivered && isFloatHold(answer),
    token: '',
    units: '',
    message: answer.remark || answer.word,
    amount: toAmount(data.amountcharged ?? data.amount),
    plan: String(data.plan || '').trim(),
    test_mode: false,
  };
}

/* ------------------------------------------------------------------- account */

async function getWalletBalance() {
  const json = await ckRequest('/APIWalletBalanceV1.asp', { retry: true });
  const answer = answerOf(json);
  if (answer.word && isErrorWord(answer.word)) throw declined(answer, { payload: trimmedPayload(json) });
  return {
    // Absent is null, never 0: an unreadable float is not an empty one.
    balance: json?.balance == null || json.balance === '' ? null : toAmount(json.balance),
    currency: 'NGN',
    retrieved_at: new Date().toISOString(),
  };
}

/**
 * Do they accept our credentials from this server? One authenticated read.
 *
 * billsProvider asks before letting an admin switch a rail here. Present
 * credentials are not accepted ones: a wrong key and an IP missing from their
 * whitelist both answer INVALID_CREDENTIALS, and a rail switched anyway would
 * fail every catalogue and every purchase until somebody noticed. Throws the
 * error the read produced - `misconfigured` when they refused us.
 */
async function verifyCredentials() {
  await getWalletBalance();
  return { ok: true };
}

// What a superadmin checks when the read above is refused.
const CREDENTIAL_HINT =
  "Check CLUBKONNECT_USER_ID and CLUBKONNECT_API_KEY, and that this server's IP address is whitelisted on ClubKonnect (Developer's API).";

// Where the float is topped up from - deployment config, read from the
// environment so it is on the screen even while their API is down.
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
 * Their order id when we hold it; our own RequestID otherwise - asked for
 * explicitly, or whenever the reference is not one of their all-digit order
 * ids. Ours always carry letters (`air_...`, `bh_airtime_...`), so a caller
 * holding only our reference - a reward cut off mid-send - is asked about by
 * the key it was actually sent under, never misread as an unknown order id.
 *
 * `status` is one of the words billSettlement understands, or 'not_found' when
 * they plainly say they have no such order - which nothing settles on, except
 * vend() moments after it sent the order itself.
 */
async function getTransactionStatus(reference, { byRequestId = false } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw providerError('reference is required', { statusCode: 400 });

  const useRequestId = byRequestId || !/^\d+$/.test(ref);
  const json = await ckRequest('/APIQueryV1.asp', {
    query: useRequestId ? { RequestID: ref } : { OrderID: ref },
    retry: true,
  });

  const answer = answerOf(json);
  const notFound = { reference_code: ref, request_id: useRequestId ? ref : '', type: '', status: 'not_found', status_code: '', amount: 0, token: '', units: '', remark: '', created_at: '' };

  if (!answer.orderid && !answer.code) {
    if (NOT_FOUND_WORDS.test(`${answer.word} ${answer.remark}`)) return notFound;
    // A refusal of the query itself - our key, our IP - is an outage, never an
    // answer about the order.
    if (answer.word && isErrorWord(answer.word)) throw declined(answer, { statusCode: 503, payload: trimmedPayload(json) });
  }

  return {
    reference_code: answer.orderid || ref,
    request_id: String(json?.requestid || (useRequestId ? ref : '')).trim(),
    type: String(json?.ordertype || '').trim().toLowerCase(),
    status: answer.state,
    status_code: answer.code,
    amount: toAmount(json?.amountcharged ?? json?.amount),
    token: '',
    units: '',
    // Their wording, for the operator. It can quote the customer's number, so
    // it goes on a receipt or nowhere - never into a log line.
    remark: answer.remark,
    created_at: String(json?.date || json?.orderdate || ''),
  };
}

/* ----------------------------------------------------------------- vending */

/** An answer to a purchase, or the error it amounts to. */
function acceptedOrThrow(json) {
  const answer = answerOf(json);
  if (answer.state === 'failed') throw declined(answer, { payload: trimmedPayload(json) });
  if (answer.state === 'successful' || answer.state === 'processing') {
    if (answer.code === '412') {
      // Accepted and parked on their side until our float is topped up. Ids
      // only - the order id is enough to find it on their dashboard.
      console.warn('clubkonnect: order on hold for float (412)', { orderid: answer.orderid || null });
    }
    return json;
  }
  // Nothing we recognise. For a vend that is an unknown, not a refusal - and a
  // repeated RequestID would land here too, which is exactly when asking by it
  // finds the original.
  throw providerError(UNAVAILABLE, {
    statusCode: 502,
    ambiguous: true,
    kind: 'outage',
    payload: trimmedPayload(json),
    providerMessage: `Unrecognised answer (status "${answer.word}", code "${answer.code}")`,
  });
}

/**
 * Send one purchase, and settle what an unreadable answer meant.
 *
 * A clear refusal throws and the caller refunds. A clear acceptance returns.
 * Anything else - a timeout, a reset, a 5xx, an error page, an answer we do not
 * recognise - may have been delivered, so it is asked about by our RequestID
 * before anyone decides: found delivered or pending, it is reported exactly as
 * if the original answer had arrived; found failed, it is a refusal; not found,
 * or not answerable, and the original error goes up and the caller refunds -
 * the same rule as every other rail.
 */
async function vend(path, query, wording = {}) {
  const reference = String(query?.RequestID || '').trim();
  if (!reference) throw providerError('A RequestID is required for every purchase', { statusCode: 500 });

  let json;
  try {
    json = acceptedOrThrow(await ckRequest(path, { query }));
  } catch (e) {
    json = e?.ambiguous ? await recover(e, reference, wording) : null;
    if (!json) throw reworded(e, wording);
  }

  return { ...json, requestid: String(json?.requestid || reference) };
}

async function recover(original, reference, wording) {
  // Ids only - nothing about the customer belongs in this line.
  console.warn('clubkonnect: purchase outcome unknown, requerying', {
    reference,
    reason: String(original?.providerMessage || original?.message || '').slice(0, 120),
  });

  await sleep(RECOVERY_DELAY_MS);

  let remote;
  try {
    remote = await getTransactionStatus(reference, { byRequestId: true });
  } catch {
    throw original;
  }

  if (remote.status === 'not_found') throw original;
  if (remote.status === 'failed') {
    throw reworded(declined({ word: '', remark: remote.remark, code: remote.status_code }), wording);
  }

  // Delivered, pending, or a state we do not recognise. The last is read as
  // pending deliberately: the order exists, so refunding it now could pay for a
  // bill that then delivers, and leaving it processing lets the sweep settle it.
  const delivered = remote.status === 'successful';
  return {
    orderid: remote.reference_code !== reference ? remote.reference_code : '',
    statuscode: delivered ? '200' : remote.status_code && remote.status === 'processing' ? remote.status_code : '100',
    status: delivered ? 'ORDER_COMPLETED' : 'ORDER_RECEIVED',
    remark: remote.remark,
    amountcharged: remote.amount,
    recovered: true,
  };
}

/* ------------------------------------------------------------------ airtime */

// Fixed and documented, so no provider call at all. Shaped like every other
// catalogue so the app cannot tell where it came from.
async function listAirtimeProvidersCached() {
  return NETWORKS.map(n => ({ name: n.name, code: n.code, full_name: n.name, id: n.code }));
}

async function buyAirtime({ provider, number, amount, reference }) {
  const network = networkCode(provider);
  if (!network) throw providerError('Unknown network', { statusCode: 400, kind: 'input' });

  // Whole naira: bills.controller refuses anything else at quote time, so a
  // fraction here is a caller bug, refused before it costs a refund.
  const naira = Number(amount);
  if (!Number.isInteger(naira) || naira <= 0) throw providerError('Enter a whole naira amount', { statusCode: 400, kind: 'input' });

  return vend(
    '/APIAirtimeV1.asp',
    {
      MobileNetwork: network,
      Amount: naira,
      MobileNumber: providerPhone(number),
      RequestID: String(reference || '').trim(),
    },
    { fallback: 'Airtime purchase failed. Please try again.' }
  );
}

/* --------------------------------------------------------------- data plans */

async function listDataProvidersCached() {
  return listAirtimeProvidersCached();
}

/**
 * Every network's plans, in one call, cached whole and keyed by network name -
 * asking for MTN and asking for Glo is the same request.
 */
async function loadAllDataPlans({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    // Not the first build's 'clubkonnect:data:all': that key can hold the empty
    // catalogue a refused read was cached as (see catalogueRoot), for up to an
    // hour in Redis. A new name is never served it.
    'clubkonnect:data:plans',
    async () => {
      const json = await ckCatalogue('/APIDatabundlePlansV2.asp');
      const groups = unwrapGroups(catalogueRoot(json, 'MOBILE_NETWORK'));

      const byNetwork = {};
      for (const group of groups) {
        // Their group ID is authoritative; the JSON key ("m_9mobile") is the
        // fallback.
        const network = networkName(group.id) || networkName(group.key);
        if (!network) continue;

        for (const row of group.products) {
          // PRODUCT_ID is what the purchase call takes as DataPlan. A plan we
          // could not send back is not one to put on sale.
          const id = String(row?.PRODUCT_ID ?? '').trim();
          const amount = toAmount(row?.PRODUCT_AMOUNT);
          if (!id || amount <= 0) continue;

          const shaped = shapePlanName(row?.PRODUCT_NAME || `${amount} bundle`);
          (byNetwork[network] ||= []).push({
            id,
            name: shaped.name,
            amount,
            plan_type: shaped.family,
            duration_days: shaped.duration?.days || 0,
            validity: shaped.duration?.label || '',
          });
        }
      }

      for (const plans of Object.values(byNetwork)) plans.sort((a, b) => a.amount - b.amount);
      return nonEmpty(byNetwork, 'data');
    },
    ttlMs,
    { force }
  );
}

async function listDataPlansCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const network = networkName(provider);
  if (!network) throw providerError('Provider is required', { statusCode: 400, kind: 'input' });

  const all = await loadAllDataPlans({ ttlMs, force });
  return all[network] || [];
}

async function buyData({ provider, planId, number, reference }) {
  const network = networkCode(provider);
  if (!network) throw providerError('Unknown network', { statusCode: 400, kind: 'input' });

  const plan = String(planId || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(plan)) throw providerError(PLAN_MESSAGE, { statusCode: 400, kind: 'input' });

  return vend(
    '/APIDatabundleV1.asp',
    {
      MobileNetwork: network,
      DataPlan: plan,
      MobileNumber: providerPhone(number),
      RequestID: String(reference || '').trim(),
    },
    { fallback: 'Data purchase failed. Please try again.' }
  );
}

/* ---------------------------------------------------------------------- tv */

/**
 * Every bouquet, in one call, grouped by the brand it belongs to.
 *
 * Grouped rather than flat because PACKAGE_ID is not unique across brands - a
 * flat lookup is how a DStv purchase ends up addressing another brand's
 * bouquet.
 */
async function loadAllTvPackages({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    // Renamed from the first build's key for the same reason as the data plans.
    'clubkonnect:tv:bouquets',
    async () => {
      const json = await ckCatalogue('/APICableTVPackagesV2.asp');
      const groups = unwrapGroups(catalogueRoot(json, 'TV_ID'));

      const byCode = {};
      for (const group of groups) {
        const entry = tvEntry(group.id) || tvEntry(group.key);
        if (!entry) continue;

        for (const row of group.products) {
          const id = String(row?.PACKAGE_ID ?? '').trim();
          const amount = toAmount(row?.PACKAGE_AMOUNT);
          if (!id || amount <= 0) continue;
          // `code` and `id` are the same value: the purchase addresses a
          // bouquet by Package, and the app has always sent back `code`.
          (byCode[entry.code] ||= []).push({ id, code: id, name: shapeTvName(row?.PACKAGE_NAME) || id, amount });
        }
      }

      for (const packages of Object.values(byCode)) packages.sort((a, b) => a.amount - b.amount);
      return nonEmpty(byCode, 'cable TV');
    },
    ttlMs,
    { force }
  );
}

async function listTvProvidersCached(opts = {}) {
  const all = await loadAllTvPackages(opts);
  return TV.filter(t => (all[t.code] || []).length).map(t => ({ name: t.name, code: t.code, full_name: t.name, id: t.code }));
}

async function listTvPackagesCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const entry = tvEntry(provider);
  if (!entry) throw providerError('Provider is required', { statusCode: 400, kind: 'input' });

  const all = await loadAllTvPackages({ ttlMs, force });
  return all[entry.code] || [];
}

// Smartcard / IUC lookup. The name it returns is PII: shown to the customer who
// asked, never logged. A refusal arrives in the name field itself -
// `{ "customer_name": "INVALID_SMARTCARDNO" }` - and must never reach a
// confirmation sheet as somebody's name.
async function validateTvSmartcard({ provider, number }) {
  const entry = tvEntry(provider);
  if (!entry) throw providerError('Unknown TV provider', { statusCode: 400, kind: 'input' });

  let json;
  try {
    json = await ckRequest('/APIVerifyCableTVV1.asp', {
      query: { CableTV: entry.code, SmartCardNo: String(number || '').trim() },
      retry: true,
    });
  } catch (e) {
    throw inCallerTerms(e, SMARTCARD_MESSAGE);
  }

  const name = String(json?.customer_name ?? '').trim();
  const word = name && isErrorWord(name) ? name : !name ? String(json?.status || '').trim() : '';
  if (word && isErrorWord(word)) throw inCallerTerms(declined({ word }, { payload: trimmedPayload(json) }), SMARTCARD_MESSAGE);

  return { customer_name: name, address: '' };
}

async function payTv({ provider, number, code, reference, phone, customerName }) {
  const entry = tvEntry(provider);
  if (!entry) throw providerError('Unknown TV provider', { statusCode: 400, kind: 'input' });

  const plan = String(code || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(plan)) throw providerError('That package is no longer available', { statusCode: 400, kind: 'input' });

  // This API has no field for the decoder holder's name. The receipt still
  // carries it, from our own ledger.
  void customerName;

  // Their documented purchase carries the subscriber's phone. Sent when the
  // caller has a valid one; never invented.
  const phoneNo = normalizeNgPhone(phone)?.local;

  return vend(
    '/APICableTVV1.asp',
    {
      CableTV: entry.code,
      Package: plan,
      SmartCardNo: String(number || '').trim(),
      PhoneNo: phoneNo || undefined,
      RequestID: String(reference || '').trim(),
    },
    { fallback: 'TV subscription failed. Please try again.' }
  );
}

/* ------------------------------------------------------------------ warming */

/**
 * Load every catalogue into both cache tiers - two calls, data plans and
 * bouquets. Same contract as the other adapters: `{ loaded, failed, calls,
 * skipped }`, refusing to run without credentials, and refusing a forced pass
 * without the shared cache that is its whole product.
 */
async function warmCatalogues({ force = false, lockMs = REFRESH_LOCK_MS } = {}) {
  if (!isConfigured()) return { loaded: 0, failed: 0, calls: 0, skipped: 'not_configured' };

  if (force) {
    const claim = await claimRefresh('clubkonnect:warm', lockMs);
    if (claim === REFRESH_HELD) return { loaded: 0, failed: 0, calls: 0, skipped: 'locked' };
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
      console.warn(`⚠️  clubkonnect catalogue warm failed ${label}:`, String(e?.providerMessage || e?.message || e).slice(0, 120));
    }
  };

  await step('data plans', () => loadAllDataPlans(opts));
  await step('tv packages', () => loadAllTvPackages(opts));

  return { loaded, failed, calls: catalogue.callCount() - callsBefore, skipped: null };
}

module.exports = {
  SERVICES,
  MIN_AMOUNTS,
  // The query endpoint takes our own RequestID - see billReconcile.helper.
  SUPPORTS_REQUEST_ID_LOOKUP: true,
  isConfigured,
  configStatus,
  verifyCredentials,
  CREDENTIAL_HINT,
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
  listDataPlansCached,
  buyData,
  // tv
  listTvProvidersCached,
  listTvPackagesCached,
  validateTvSmartcard,
  payTv,
  // shared
  parseVendResult,
  // Their order ids, told apart from ours - billReconcile treats a bill
  // without one as unconfirmed.
  isOrderId,
  isFloatError,
  dropCatalogue,
  warmCatalogues,
  // exported for tests
  __test: {
    classifyStatus,
    answerOf,
    declined,
    isErrorWord,
    shapePlanName,
    shapeTvName,
    planFamily,
    networkName,
    networkCode,
    tvEntry,
    unwrapGroups,
    toAmount,
    UNAVAILABLE,
  },
};
