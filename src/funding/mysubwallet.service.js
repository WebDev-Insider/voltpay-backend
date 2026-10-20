// MySubWallet bills provider.
//
// Serves every bill rail - airtime, data, cable TV and electricity - and Bill
// Hero rewards, out of one prepaid float at mysubwallet.ng. Same contract as
// the provider modules before it: this file owns the transport, the provider
// identifiers and the error shape, and nothing else. Pricing, wallet movement
// and the ledger stay in the controllers.
//
// Also Airtime to Cash, the one call that runs the other way: the customer's
// airtime comes to us and our float is CREDITED. See "airtime to cash" below.
//
// Not betting. Their betting purchase is addressed by a bookmaker id that
// exists only on their dashboard, and the dashboard did not show it - so
// betting stays on Payvessel (payvesselBiller.service.js), which lists its
// billers over the API.
//
// Auth is one header:
//   Authorization: Token <api key>
// The key is the `AccessToken` their POST /api/user exchange hands out, also
// shown on their dashboard. A sandbox key starts `sk_test_`.
//
// Six things about this API shape everything below. Several were read off the
// live API rather than the docs, which disagree with it in places:
//
//   1. **`request-id` is ours, and it is the reference for everything.** Every
//      purchase carries our `trx` as its `request-id`; their requery is keyed on
//      it and their webhook names it. So a vend whose response never reached us
//      can still be asked about - see vend(). It is also their idempotency key:
//      a reused request-id returns the original transaction instead of charging
//      again.
//   2. **The HTTP status is not the outcome.** An unknown route answers 200 with
//      an HTML "Page Not Found" page, and every refusal - a bad token (the docs
//      say 401) and a validation error alike - answers 403 with a JSON
//      `status: "fail"`. Success is read off a JSON body whose `status` says
//      so, and off nothing else; what kind of refusal it was, off its message.
//   3. **Three outcomes, several spellings.** A purchase answers `success`,
//      `pending` or `fail`; the requery answers `transaction_status` `success`,
//      `pending` or `failed`; some lookups answer a boolean. outcomeOf is the
//      one place they are read.
//   4. **Identifiers are their own numbers.** Networks are 1 MTN, 2 Airtel,
//      3 Glo, 4 9mobile - nobody else's order. DISCOs and cable providers are
//      numeric ids read from the live catalogue, and the app speaks in short
//      codes (IKEDC, DSTV), so both directions are mapped here.
//   5. **The electricity token comes back on the purchase call**, as `token`.
//   6. **The webhook carries no signature, and is optional.** One callback URL
//      for every transaction type, with no HMAC and no secret, so a delivery is
//      a hint re-read over the authenticated requery - see
//      mysubwalletWebhook.controller.js. Their docs place the setting on the
//      dashboard, which did not offer it as of 2026-10-06; the receipt poll and
//      the sweep settle everything without it.
//
// The float is prepaid: a purchase debits our MySubWallet wallet, not the
// customer's. "Insufficient wallet balance" from this API is an operational
// incident and never something to show a funded customer - isFloatError marks
// it so the controller can say "briefly unavailable" and page whoever tops up.
const { withRetry, causeCode } = require('../helpers/retry.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { createCatalogueCache, REFRESH_HELD, REFRESH_NO_LOCK } = require('./catalogueCache');
const { splitDuration } = require('./planDuration');

const BASE_URL = String(process.env.MYSUBWALLET_BASE_URL || 'https://api.mysubwallet.ng').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.MYSUBWALLET_TIMEOUT_MS || 30_000);
const CATALOGUE_TTL_MS = Number(process.env.MYSUBWALLET_CATALOGUE_TTL_MS || 30 * 60_000);

// Provider floors. Not published anywhere - not in the docs, the OpenAPI spec
// or the FAQ - so these are the floors the rest of the market enforces. VoltPay's
// own floors in bills.controller sit at or above both, and the controller takes
// the stricter of the two. If MySubWallet turns out to be stricter still, the
// decline carries their own "at least ..." wording and the customer is refunded
// on the spot: a worse experience, but never a lost naira.
const MIN_AMOUNTS = { airtime: 50, electricity: 500 };

// A vend whose outcome we could not read is asked about once by its
// request-id before anyone refunds it. The pause lets their side finish
// writing the transaction row a reset connection may have left mid-insert.
const RECOVERY_DELAY_MS = Number(process.env.MYSUBWALLET_RECOVERY_DELAY_MS || 2_000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------- caching */

// The mechanics - two tiers, single-flight, stale-while-revalidate, a fleet-wide
// refresh lock - live in catalogueCache.js. What stays here are the numbers,
// because each is a fact about this provider.
//
// Every catalogue arrives whole: one call for every network's data plans, one
// for every cable plan, one each for the DISCO and cable-provider lists. A full
// warm pass is four calls, so the pacing gap can be small without crowding the
// vends that share the key.
//
// L1's TTL stays far under L2's for the reason it always has: a catalogue price
// is what the customer is charged, and equal TTLs would let one instance hold a
// value read at minute 29 until minute 59.
const LOCAL_TTL_MS = Number(process.env.MYSUBWALLET_LOCAL_TTL_MS || 60_000);
const STALE_GRACE_MS = Number(process.env.MYSUBWALLET_STALE_GRACE_MS || 30 * 60_000);
const CATALOGUE_GAP_MS = Number(process.env.MYSUBWALLET_CATALOGUE_GAP_MS || 400);
const REFRESH_LOCK_MS = 60_000;

const catalogue = createCatalogueCache({
  label: 'mysubwallet',
  ttlMs: CATALOGUE_TTL_MS,
  localTtlMs: LOCAL_TTL_MS,
  staleGraceMs: STALE_GRACE_MS,
  gapMs: CATALOGUE_GAP_MS,
  lockMs: REFRESH_LOCK_MS,
});

const { cached, pace: paceCatalogue, drop: dropCatalogue, claimRefresh } = catalogue;

/* ---------------------------------------------------------------- the key */

function apiKey() {
  return String(process.env.MYSUBWALLET_API_KEY || '').trim();
}

// Both of their sandbox switches: the sandbox host with any key, or a test key
// against the live host. Either way nothing is vended and every purchase
// answers success.
function isSandbox() {
  return /sandbox\./i.test(BASE_URL) || /^sk_test_/i.test(apiKey());
}

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

// **A sandbox answer in production is a customer charged for nothing.** Every
// simulated purchase comes back `success`, so a deployment pointed at the
// sandbox would debit wallets, stamp receipts Successful and deliver nothing at
// all. Same rule as ALLOW_MOCK_OTP: test mode does not exist when NODE_ENV is
// production, whatever the environment says.
function sandboxForbidden() {
  return isProduction() && isSandbox();
}

// Can a rail be pointed at us at all? Credentials only - it calls nobody.
// billsProvider asks before letting an admin switch a service here, so "no
// key" is refused at the switch rather than discovered one refund at a time.
function isConfigured() {
  return Boolean(apiKey()) && !sandboxForbidden();
}

/* -------------------------------------------------------------------- errors */

const UNAVAILABLE = 'This service is briefly unavailable. Please try again shortly.';
const GENERIC = 'We could not complete this request. Please try again.';

/**
 * An error a controller can hand straight to a customer.
 *
 * `message` is always safe to show: it is our wording, never the raw provider
 * text, which is written for a reseller reading a dashboard and can name our
 * float, our credentials or the customer's own number. The raw text rides on
 * `providerMessage` for the operator, and a trimmed copy of their body on
 * `mysubwallet`, named for the provider so a log line says who spoke.
 *
 * Three flags tell a caller what kind of failure this is, because each is
 * handled differently:
 *   - `ambiguous`      the request may or may not have landed. A vend must be
 *                      requeried before it is refunded - see vend();
 *   - `floatExhausted` our prepaid balance is empty - an incident, not a decline;
 *   - `misconfigured`  our key, our sandbox setting or one of our ids is wrong.
 *
 * `kind` says what the message is about, so a call site can say it in its own
 * words without overwriting an outage: 'outage', 'limit' (a min/max the
 * customer can act on), 'unavailable' (they switched something off), 'input'
 * (something the customer typed) or 'unknown'.
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

  // `cause` lets retry.helper walk the original socket error instead of matching
  // the words "fetch failed" in a string we built ourselves.
  const err = cause ? new Error(message, { cause }) : new Error(message);
  err.statusCode = statusCode;
  err.mysubwallet = payload;
  err.providerMessage = providerMessage;
  // Their HTTP status as sent - `statusCode` is ours. Kept for the diagnosis of
  // an answer we misread, which is how Airtime to Cash lost conversion #8.
  if (httpStatus != null) err.httpStatus = httpStatus;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  if (ambiguous) err.ambiguous = true;
  if (floatExhausted) err.floatExhausted = true;
  if (misconfigured) err.misconfigured = true;
  if (notFound) err.notFound = true;
  if (kind) err.kind = kind;
  return err;
}

// Our float, not the customer's wallet.
function isFloatError(message) {
  return /insufficient\s+(wallet\s+)?(balance|fund)|low\s+(wallet\s+)?balance/i.test(String(message || ''));
}

// Our key or our account - never the customer's. "user account" is the API
// user, which is us: their bad-key answer is "Invalid API KEY or user account
// not active", and a deactivated account may say only the second half.
function isCredentialError(message) {
  return /unauthori[sz]ed|token\s+not\s+found|invalid\s+(api\s*)?(token|key)|unauthenticated|user\s+account\s+(is\s+)?not\s+active/i.test(
    String(message || '')
  );
}

// Their failure text is matched on meaning rather than exact wording, because
// the wording is theirs to change. Order matters: "invalid meter number"
// mentions a number, and "invalid smartcard number" does too, so the specific
// object is tested before the generic one.
const CUSTOMER_MESSAGES = [
  { kind: 'input', test: /meter/i, message: 'We could not verify that meter number. Check it and try again.' },
  {
    kind: 'input',
    test: /\biuc\b|smart\s*card/i,
    message: 'We could not verify that smartcard / IUC number. Check it and try again.',
  },
  {
    kind: 'input',
    test: /\bplan\b|bundle|package|bouquet/i,
    message: 'That plan is no longer available. Please pick another one.',
  },
  {
    kind: 'input',
    test: /phone|mobile\s*number|recipient|\bnumber\b|does\s+not\s+belong|not\s+an?\s+\w+\s+(line|number)/i,
    message: 'That phone number was not accepted for this network. Check the number and the network.',
  },
  {
    kind: 'unavailable',
    test: /disabled|unavailable|not\s+available|maintenance|suspended|try\s+again\s+later|network/i,
    message: 'This service is temporarily unavailable. Please try again later.',
  },
];

// Their validator states a limit in a sentence a customer can act on ("The
// amount field must be at least 100."), so that one is passed through - capped,
// because it is still their text.
const AMOUNT_LIMIT = /minimum|maximum|at\s+least|not\s+be\s+greater|greater\s+than|less\s+than|exceed/i;

// "The selected disco is invalid." is their validator rejecting one of *our*
// identifiers - a network, DISCO or cable id we read from their own catalogue.
// Nothing the customer types can fix it. A plan is the one exception: a plan
// that vanished between quote and confirm is the customer's to fix by picking
// again.
const OUR_IDENTIFIER = /selected\s+[\w\s]{1,40}?\s+is\s+invalid/i;

/** Turn a provider's refusal into an error with a customer-safe message. */
function declined(rawMessage, { statusCode = 400, payload = null } = {}) {
  const raw = String(rawMessage || '').trim();
  const base = { payload, providerMessage: raw };

  if (isFloatError(raw)) {
    return providerError(UNAVAILABLE, { ...base, statusCode: 503, floatExhausted: true, kind: 'outage' });
  }
  if (isCredentialError(raw)) {
    return providerError(UNAVAILABLE, { ...base, statusCode: 503, misconfigured: true, kind: 'outage' });
  }
  if (raw && AMOUNT_LIMIT.test(raw)) return providerError(raw.slice(0, 160), { ...base, statusCode, kind: 'limit' });
  if (OUR_IDENTIFIER.test(raw) && !/\bplan\b/i.test(raw)) {
    return providerError(UNAVAILABLE, { ...base, statusCode: 503, misconfigured: true, kind: 'outage' });
  }

  const known = CUSTOMER_MESSAGES.find(m => m.test.test(raw));
  if (known) return providerError(known.message, { ...base, statusCode, kind: known.kind });
  return providerError(GENERIC, { ...base, statusCode, kind: 'unknown' });
}

/**
 * Say a refusal in the caller's words.
 *
 * The transport cannot know what the caller was doing, so it maps on the
 * provider's text alone - and "invalid number" on a meter lookup reads to it
 * like a bad phone number. The caller knows. Only an 'input' or an 'unknown'
 * refusal is reworded; an outage, a limit or a switched-off service already
 * says the right thing in any context.
 */
function inCallerTerms(e, message, { kinds = ['input', 'unknown'] } = {}) {
  if (e && message && kinds.includes(e.kind)) e.message = message;
  return e;
}

/* ------------------------------------------------------------ status reading */

const SUCCESS_WORDS = new Set(['success', 'successful', 'delivered', 'completed']);
const PENDING_WORDS = new Set(['pending', 'process', 'processing', 'initiated', 'queued']);
const FAILURE_WORDS = new Set(['fail', 'failed', 'failure', 'error', 'declined', 'reversed', 'refunded', 'cancelled']);

/**
 * 'success' | 'pending' | 'fail' | '' for any status they send.
 *
 * Strict on purpose. An unrecognised word is '' - "we do not know" - and never
 * defaults to success: guessing success marks an undelivered bill as done and
 * nobody ever refunds it.
 */
function outcomeOf(status) {
  if (status === true) return 'success';
  if (status === false) return 'fail';
  const word = String(status ?? '').trim().toLowerCase();
  if (SUCCESS_WORDS.has(word)) return 'success';
  if (PENDING_WORDS.has(word)) return 'pending';
  if (FAILURE_WORDS.has(word)) return 'fail';
  return '';
}

// Laravel puts field errors in `errors: { field: [message] }` and a summary in
// `message`; the field error is the more specific of the two.
function firstErrorMessage(json) {
  if (!json || typeof json !== 'object') return '';
  if (json.errors && typeof json.errors === 'object') {
    for (const value of Object.values(json.errors)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
  }
  for (const key of ['message', 'response', 'error']) {
    if (typeof json[key] === 'string' && json[key].trim()) return json[key].trim();
  }
  return '';
}

// Only the two fields worth keeping. Their body can carry `newbal` - our float -
// and an error payload can travel as far as the app, which has no business
// learning what our wallet holds.
function trimmedPayload(json) {
  if (!json || typeof json !== 'object') return null;
  return { status: json.status ?? null, message: firstErrorMessage(json) || null };
}

function retryAfterFrom(res) {
  const header = Number(res?.headers?.get?.('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.round(header * 1000) + 250 : null;
}

/* ----------------------------------------------------------------- transport */

/**
 * One request.
 *
 * `retry` defaults to **false** and every read that wants it says so. Deciding
 * by HTTP method is how a purchase gets retried by accident the day a lookup
 * turns out to be a POST. A vend is never retried; what recovers one is its
 * request-id and the requery.
 */
async function mswRequest(method, path, { query, body, retry = false, pace = false, timeoutMs = null } = {}) {
  const attempt = () => mswRequestOnce(method, path, { query, body, timeoutMs });
  const once = pace ? () => paceCatalogue(attempt) : attempt;
  if (!retry) return once();
  return withRetry(once, { label: `mysubwallet ${path}` });
}

/** A catalogue read: safe to retry, and paced against its neighbours. */
function mswCatalogue(path) {
  return mswRequest('GET', path, { retry: true, pace: true });
}

async function mswRequestOnce(method, path, { query, body, timeoutMs = null } = {}) {
  const limitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : TIMEOUT_MS;
  const key = apiKey();
  if (!key) {
    throw providerError(UNAVAILABLE, {
      statusCode: 503,
      misconfigured: true,
      kind: 'outage',
      providerMessage: 'Missing required env: MYSUBWALLET_API_KEY',
    });
  }

  let url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v) !== '') qs.append(k, String(v));
    }
    const encoded = qs.toString();
    if (encoded) url += `?${encoded}`;
  }

  const headers = {
    Authorization: `Token ${key}`,
    Accept: 'application/json',
    // Balances and catalogues sit behind an edge cache otherwise, which is how
    // a topped-up float keeps reading as empty.
    'Cache-Control': 'no-cache',
  };

  let payload;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);

  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    text = await res.text();
  } catch (e) {
    // `fetch` says only "fetch failed" for every connection problem and hides
    // the reason in `cause`. ENOTFOUND is our DNS, ECONNREFUSED is their box,
    // ECONNRESET is the path between - different owners, different fixes.
    //
    // Ambiguous by definition: a request that timed out or was cut mid-flight
    // may have been processed at the far end.
    const code = causeCode(e);
    const reason =
      e?.name === 'AbortError'
        ? `MySubWallet request timed out after ${limitMs}ms`
        : `MySubWallet request failed: ${e?.message || e}${code ? ` (${code})` : ''}`;
    throw providerError(UNAVAILABLE, { statusCode: 504, cause: e, ambiguous: true, kind: 'outage', providerMessage: reason });
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // Not JSON: their "Page Not Found" page (answered with HTTP 200), or a
  // gateway in front of them. Never a purchase result - and for a vend, not
  // proof that nothing happened either, since a proxy can fail after the app
  // behind it already acted.
  if (!json || typeof json !== 'object') {
    throw providerError(UNAVAILABLE, {
      statusCode: 502,
      ambiguous: true,
      kind: 'outage',
      providerMessage: `MySubWallet returned a non-JSON response (HTTP ${res.status})`,
      httpStatus: res.status,
    });
  }

  const raw = firstErrorMessage(json);
  const outcome = outcomeOf(json.status);

  const payloadOut = trimmedPayload(json);

  // A bad key is an outage, never a decline the customer could retry - so it is
  // checked before the outcome. It is read off the words, not the status: they
  // answer *every* refusal 403 `status: "fail"`, a validation error included
  // ("The phone must be 11 digits."), and calling all of those a bad key showed
  // the customer "briefly unavailable" for a typo and paged us for it. A key
  // problem says so ("Unauthorized/Token Not Found", "Invalid API KEY or user
  // account not active"); a 403 that says nothing at all is still read as one.
  if (res.status === 401 || (res.status === 403 && !raw) || (outcome !== 'success' && isCredentialError(raw))) {
    throw providerError(UNAVAILABLE, {
      statusCode: 503,
      misconfigured: true,
      kind: 'outage',
      payload: payloadOut,
      providerMessage: raw || `HTTP ${res.status}`,
      httpStatus: res.status,
    });
  }

  // Their limiter refuses before anything is processed, so this one is safe
  // to read as "did not happen" - and retry.helper treats it as transient.
  if (res.status === 429) {
    throw providerError(UNAVAILABLE, {
      statusCode: 429,
      kind: 'outage',
      payload: payloadOut,
      providerMessage: raw || 'Too many requests',
      retryAfterMs: retryAfterFrom(res),
      httpStatus: res.status,
    });
  }

  // Their server failed partway. Whether the purchase went through is unknown.
  if (res.status >= 500) {
    throw providerError(UNAVAILABLE, {
      statusCode: 502,
      ambiguous: true,
      kind: 'outage',
      payload: payloadOut,
      providerMessage: raw || `HTTP ${res.status}`,
      httpStatus: res.status,
    });
  }

  // Any other 4xx is a refusal, whether or not the body says `fail` - a Laravel
  // validation error is `{ message, errors }` with no status at all. The one
  // contradiction, a 4xx that claims success, is read as unknown rather than
  // trusted either way.
  const refused = outcome === 'fail' || (res.status >= 400 && outcome === '');
  if (refused) {
    const err = declined(raw, { statusCode: res.status === 404 ? 404 : 400, payload: payloadOut });
    // The requery's 404 is an answer, not an outage: "this reference is not on
    // your account". getTransactionStatus turns it into a status.
    if (res.status === 404 && /not\s+found/i.test(raw)) err.notFound = true;
    err.httpStatus = res.status;
    throw err;
  }

  if (res.status < 400 && (outcome === 'success' || outcome === 'pending')) return json;

  // A body with no outcome we recognise, or one that contradicts its own HTTP
  // status. For a read that is a broken answer; for a vend it is an unknown
  // one, and vend() requeries it.
  throw providerError(UNAVAILABLE, {
    statusCode: 502,
    ambiguous: true,
    kind: 'outage',
    payload: payloadOut,
    providerMessage: raw || `Unrecognised status "${String(json.status ?? '')}" (HTTP ${res.status})`,
    httpStatus: res.status,
  });
}

/* ------------------------------------------------- provider identity mapping */

function normKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Documented, and identical in their /api/networks catalogue. Names are the
// spellings the app ships logo assets for, so a provider change never changes
// the icons.
const NETWORKS = [
  { id: 1, name: 'MTN' },
  { id: 2, name: 'AIRTEL' },
  { id: 3, name: 'GLO' },
  { id: 4, name: '9MOBILE' },
];

// Every spelling the app or a stale client list can produce. 9mobile has been
// renamed T2, and both names are in circulation.
const NETWORK_ALIASES = {
  MTN: 'MTN',
  AIRTEL: 'AIRTEL',
  GLO: 'GLO',
  GLOBACOM: 'GLO',
  '9MOBILE': '9MOBILE',
  '9MOBILENG': '9MOBILE',
  ETISALAT: '9MOBILE',
  T2: '9MOBILE',
  T2MOBILE: '9MOBILE',
};

/** The app's network name, or '' when it is not one we can vend to. */
function networkName(provider) {
  const raw = String(provider || '').trim();
  const byId = NETWORKS.find(n => String(n.id) === raw);
  if (byId) return byId.name;
  return NETWORK_ALIASES[normKey(raw)] || '';
}

function networkId(provider) {
  const name = networkName(provider);
  const found = NETWORKS.find(n => n.name === name);
  return found ? found.id : 0;
}

// The app renders and sends back these short codes, and its logo resolver is
// keyed on them. Their catalogue names the companies in sentences ("Port
// Harcourt Electricity", "Joss Electricity" - sic), so each code is matched to
// a catalogue row by the place name in it. The *id* always comes from the live
// catalogue: no id is hardcoded here, because an id that moved would pay a
// customer's money to someone else's DISCO.
const DISCOS = [
  { code: 'IKEDC', place: /\bikeja\b/i, aliases: ['IKEDC', 'IKEJA'] },
  { code: 'EKEDC', place: /\beko\b/i, aliases: ['EKEDC', 'EKO'] },
  { code: 'AEDC', place: /\babuja\b/i, aliases: ['AEDC', 'ABUJA'] },
  { code: 'KEDCO', place: /\bkano\b/i, aliases: ['KEDCO', 'KEDC', 'KANO'] },
  { code: 'PHED', place: /port\s*harcourt/i, aliases: ['PHED', 'PHEDC', 'PH', 'PORTHARCOURT'] },
  { code: 'JED', place: /\bjoss?\b/i, aliases: ['JED', 'JEDC', 'JOS', 'JOSS'] },
  { code: 'IBEDC', place: /\bibadan\b/i, aliases: ['IBEDC', 'IBADAN'] },
  { code: 'KAEDCO', place: /\bkaduna\b/i, aliases: ['KAEDCO', 'KAEDC', 'KADUNA'] },
  { code: 'EEDC', place: /\benugu\b/i, aliases: ['EEDC', 'ENUGU'] },
  { code: 'BEDC', place: /\bbenin\b/i, aliases: ['BEDC', 'BENIN'] },
  { code: 'YEDC', place: /\byola\b/i, aliases: ['YEDC', 'YOLA'] },
  { code: 'ABA', place: /\baba\b/i, aliases: ['ABA', 'APL', 'APLE'] },
];

function discoCodeForName(catalogueName) {
  const found = DISCOS.find(d => d.place.test(String(catalogueName || '')));
  return found ? found.code : '';
}

function discoCodeForAlias(provider) {
  const key = normKey(provider);
  const found = DISCOS.find(d => d.aliases.includes(key));
  return found ? found.code : '';
}

// Same idea for cable. Their catalogue spells StarTimes "STARTIME"; the app's
// assets and every earlier provider say STARTIMES.
const TV = [
  { code: 'dstv', name: 'DSTV', aliases: ['DSTV'] },
  { code: 'gotv', name: 'GOTV', aliases: ['GOTV'] },
  { code: 'startimes', name: 'STARTIMES', aliases: ['STARTIMES', 'STARTIME'] },
];

function tvEntry(value) {
  const key = normKey(value);
  return TV.find(t => t.aliases.includes(key)) || null;
}

// The app and the ledger speak "prepaid" / "postpaid", and so does this API.
function normalizeMeterType(meterType) {
  const t = String(meterType || '').trim().toLowerCase();
  if (t === '2' || t === '02' || t.startsWith('post')) return 'postpaid';
  return 'prepaid';
}

// The phone in the form their documentation uses throughout: 234xxxxxxxxxx.
// Callers pass whatever they hold - the bills rail and Bill Hero both carry the
// local 0803... form - so it is normalised here, once.
// The 11-digit local form (0803...). Their docs show 234..., but the live API
// refuses that: "The phone must be 11 digits." (first live purchase,
// 2026-10-06). The docs are not the authority here; the validator is.
function providerPhone(number) {
  const phone = normalizeNgPhone(number);
  if (!phone) throw providerError('Enter a valid Nigerian phone number', { statusCode: 400 });
  return phone.local;
}

/* ------------------------------------------------------ response normalising */

// Amounts arrive as strings, not always tidy ones ("339.5", "727.50"). Rounded
// to kobo so a price never renders with stray decimals or drifts against what
// is charged.
function toAmount(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** A figure they may not send: null when absent or unreadable, never 0. */
function optionalAmount(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Plan families as their catalogue spells them ("COOPERATE GIFTING", sic) onto
// the keys bills.controller groups and labels on. Anything else passes through
// normalised, so a family they add later is still on sale - it just gets a
// title-cased label until it is named here.
const FAMILY_ALIASES = {
  COOPERATEGIFTING: 'CG',
  CORPORATEGIFTING: 'CG',
  CORPORATE: 'CG',
  CG: 'CG',
};

function planFamily(networkType) {
  const key = normKey(networkType);
  return FAMILY_ALIASES[key] || key;
}

// "750MB GIFTING = ₦194.00 1 Day Special" splits at the price into the bundle
// ("750MB GIFTING") and the terms ("1 Day Special").
const PRICE_SEGMENT = /\s*=\s*(?:₦|N|NGN)?\s*[\d,]+(?:\.\d+)?\s*/i;

/**
 * A plan name a customer can read, and the validity stated in it.
 *
 *   "750MB GIFTING = ₦194.00 1 Day Special"
 *       -> "750MB Special (GIFTING)", 1 day
 *   "5GB SME = ₦1,480.00 incl. 3GB Night Data 30 Days"
 *       -> "5GB incl. 3GB Night Data (SME)", 30 days
 *
 * Three things come out of their name. The price, because the tile prints our
 * price beside it and a name quoting theirs is a second number that can
 * disagree with what is charged. The family word, which goes back on the end in
 * brackets - the convention the picker has always used, and what tells two
 * same-size bundles apart. And the validity, which the app shows on its own
 * line: left in the name, it would print twice.
 *
 * The validity is only ever *read* - from the terms after the price, where they
 * put it. A name it cannot be read from keeps its terms verbatim and gets no
 * validity at all, so the plan is listed under "All" rather than under a shelf
 * we guessed. Everything else they wrote stays, caveats included: "(Sims Owing
 * airtime should not purchase ...)" is a warning the customer is owed.
 */
function shapePlanName(rawName, networkType, family) {
  const name = String(rawName || '').trim();
  const parts = name.split(PRICE_SEGMENT);
  const bundle = parts[0] || name;
  const terms = parts.length > 1 ? parts.slice(1).join(' ') : '';

  // The family as they spelled it, wherever it sits in the bundle half.
  const typeWords = String(networkType || '').trim();
  const head = typeWords
    ? bundle.replace(new RegExp(`\\b${typeWords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ' ')
    : bundle;

  const { duration, rest } = splitDuration(terms);
  const label = [head, rest].map(s => s.replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join(' ');

  return {
    name: family ? `${label || name} (${family})` : label || name,
    duration,
  };
}

// TV plan names quote a price too ("Nova (Dish) - 2100 Naira - 1 Month"). Same
// reason to take it out; the validity stays, since the TV picker has no line of
// its own for it.
function shapeTvName(rawName) {
  const name = String(rawName || '').trim();
  const cleaned = name
    .replace(/\s*[-–—]\s*(?:₦|N|NGN)?\s*[\d,]+(?:\.\d+)?\s*naira\b/gi, '')
    .replace(PRICE_SEGMENT, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || name;
}

// A prepaid token is 20 digits under the STS standard, usually printed in
// groups of four. Taken from a `token` field when there is one; otherwise only
// from text that says "token", because a bare 20-digit run elsewhere in a
// message is not something to hand a customer to type into a meter.
const TOKEN_IN_TEXT = /token\D{0,24}?(\d{4}(?:[\s-]?\d{4}){4})(?!\d)/i;

function extractToken(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of ['token', 'Token', 'meter_token', 'metertoken', 'purchased_code']) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  const text = [obj.message, obj.response].filter(v => typeof v === 'string').join(' ');
  const match = TOKEN_IN_TEXT.exec(text);
  return match ? match[1].trim() : '';
}

/**
 * One shape for every purchase response, so the controller reads the same
 * fields whether it just bought airtime or electricity.
 *
 * A declined vend never reaches here - vend() throws it - so this only has to
 * tell "delivered" from "accepted, still going".
 */
function parseVendResult(json) {
  const data = json && typeof json === 'object' ? json : {};
  return {
    reference: String(data['request-id'] || data.request_id || data.reference || '').trim(),
    order_no: '',
    status: outcomeOf(data.status) === 'success' ? 'successful' : 'processing',
    token: extractToken(data),
    units: String(data.units || data.unit || '').trim(),
    message: String(data.message || data.response || '').trim(),
    amount: toAmount(data.amount),
    plan: String(data.dataplan || data.plan || '').trim(),
    test_mode: data.sandbox === true,
  };
}

/* ------------------------------------------------------------------- account */

// Read on demand by the ops screen - the purchase calls report the float
// themselves, so it is not worth a call before every vend.
async function getWalletBalance() {
  const json = await mswRequest('GET', '/api/balance', { retry: true });
  return {
    balance: json.balance == null || json.balance === '' ? null : toAmount(json.balance),
    // Where Airtime to Cash conversions are credited - its own balance, apart
    // from the bills float above, and what a Paystack top-up for withdrawals is
    // moved out of. Absent or unreadable is null: 0 would say nothing arrived.
    airtime_to_cash_balance: optionalAmount(json.airtime_to_cash_balance),
    currency: String(json.currency || 'NGN'),
    // They do not timestamp it, so the time we read it is the honest answer.
    retrieved_at: new Date().toISOString(),
  };
}

// Where the float is topped up from. Not a secret - it is an account money is
// sent TO - but it is deployment config, so it is read from the environment.
// The moment you most need it is the moment their API is down.
function getFundingAccount() {
  return {
    bank_name: String(process.env.MYSUBWALLET_FUNDING_BANK || '').trim(),
    account_number: String(process.env.MYSUBWALLET_FUNDING_ACCOUNT_NUMBER || '').trim(),
    account_name: String(process.env.MYSUBWALLET_FUNDING_ACCOUNT_NAME || '').trim(),
  };
}

// `low` is "raise a transfer today", `critical` is "vends are about to fail".
// Generous defaults: a dry float is a total bills outage, not a degraded one -
// and with one provider on every rail, it is now every rail at once.
function floatThresholds() {
  const critical = Number(process.env.MYSUBWALLET_FLOAT_CRITICAL_NGN || 5_000);
  const low = Number(process.env.MYSUBWALLET_FLOAT_LOW_NGN || 25_000);
  return {
    critical: Number.isFinite(critical) && critical >= 0 ? critical : 5_000,
    low: Number.isFinite(low) && low >= 0 ? low : 25_000,
  };
}

function floatVerdict(balance) {
  const { critical, low } = floatThresholds();
  // Absent is not zero. `Number(null)` is 0, which would report a float we
  // could not read as one that is empty - the loudest verdict on the screen,
  // raised on a missing field.
  if (balance == null || balance === '') return 'unknown';
  const amount = Number(balance);
  if (!Number.isFinite(amount)) return 'unknown';
  if (amount <= critical) return 'critical';
  if (amount <= low) return 'low';
  return 'healthy';
}

/**
 * The reconciliation read, keyed on our own request-id.
 *
 * `status` is one of the words billSettlement understands - 'successful',
 * 'failed', 'processing' - or 'not_found', which nothing settles on. A
 * reference their requery has never heard of is not proof of a failure: it is
 * scoped to whichever key asked, so a rotated key or a sandbox key reads every
 * live order as missing, and refunding on that would refund delivered bills.
 * It stays processing and the sweep's hour-old alert hands it to a person.
 */
async function getTransactionStatus(reference) {
  const ref = String(reference || '').trim();
  if (!ref) throw providerError('reference is required', { statusCode: 400 });

  let json;
  try {
    json = await mswRequest('GET', `/api/requery/${encodeURIComponent(ref)}`, { retry: true });
  } catch (e) {
    if (e?.notFound) {
      return { reference_code: ref, request_id: ref, type: '', status: 'not_found', amount: 0, token: '', units: '', remark: '', created_at: '' };
    }
    throw e;
  }

  const data = json?.data && typeof json.data === 'object' ? json.data : {};
  const outcome = outcomeOf(data.transaction_status ?? data.status);

  return {
    reference_code: String(data['request-id'] || data.reference || ref).trim(),
    request_id: String(data['request-id'] || ref).trim(),
    type: String(data.type || '').trim().toLowerCase(),
    status: outcome === 'success' ? 'successful' : outcome === 'fail' ? 'failed' : outcome === 'pending' ? 'processing' : '',
    amount: toAmount(data.amount),
    token: extractToken(data),
    units: String(data.units || '').trim(),
    // Their wording, for the operator. It can quote the customer's number, so
    // it goes on a receipt or nowhere - never into a log line.
    remark: String(data.message || '').trim(),
    created_at: String(data.date || ''),
  };
}

/* ----------------------------------------------------------------- vending */

/**
 * Send one purchase, and settle what an unreadable answer meant.
 *
 * A clear decline throws, and the caller refunds. A clear acceptance returns.
 * The third case is the one that loses money if it is handled like either of
 * the others: a timeout, a dropped connection, a 5xx, an HTML page - any
 * answer that does not say what happened. The purchase may have been
 * delivered. Refunding it pays for the bill twice; keeping the money without
 * knowing charges for a bill that may never come.
 *
 * So it is asked about, by the request-id we sent, before anyone decides. Found
 * delivered or pending, it is reported exactly as if the original answer had
 * arrived. Found failed, it is a decline. Not found - or not answerable - and it
 * never landed as far as anyone can tell, so the original error goes back up
 * and the caller refunds, which is what every failed dispatch has always done.
 *
 * The request-id is stamped onto whatever comes back, because most of their
 * purchase responses do not echo it, and it is the key every later lookup -
 * webhook, receipt poll, sweep - joins on.
 *
 * `wording.fallback` replaces a refusal that gave no reason we recognise.
 */
async function vend(path, body, wording = {}, { timeoutMs = null } = {}) {
  const reference = String(body?.['request-id'] || '').trim();
  if (!reference) throw providerError('A request-id is required for every purchase', { statusCode: 500 });

  if (sandboxForbidden()) {
    throw providerError(UNAVAILABLE, {
      statusCode: 503,
      misconfigured: true,
      kind: 'outage',
      providerMessage: 'MySubWallet sandbox is configured on a production deployment',
    });
  }

  let json;
  try {
    json = await mswRequest('POST', path, { body, timeoutMs });
  } catch (e) {
    json = e?.ambiguous ? await recover(e, reference, wording) : null;
    if (!json) throw reworded(e, wording);
  }

  // Belt and braces for the sandbox rule above, and deliberately not the same
  // test: a simulated answer reaching a production deployment means nothing
  // was delivered, whatever it says - even when our own key and URL looked
  // live, which is exactly when the check above would not have fired.
  if (json?.sandbox === true && isProduction()) {
    throw providerError(UNAVAILABLE, {
      statusCode: 503,
      misconfigured: true,
      kind: 'outage',
      providerMessage: 'Sandbox response in production',
    });
  }

  return { ...json, 'request-id': String(json?.['request-id'] || reference) };
}

function reworded(e, { fallback } = {}) {
  if (e?.kind === 'unknown' && fallback) e.message = fallback;
  return e;
}

async function recover(original, reference, wording) {
  // Ids only - the original message is ours, but nothing about the customer
  // belongs in this line.
  console.warn('mysubwallet: purchase outcome unknown, requerying', {
    reference,
    reason: String(original?.providerMessage || original?.message || '').slice(0, 120),
  });

  await sleep(RECOVERY_DELAY_MS);

  let remote;
  try {
    remote = await getTransactionStatus(reference);
  } catch {
    throw original;
  }

  if (remote.status === 'not_found') throw original;
  if (remote.status === 'failed') throw reworded(declined(remote.remark), wording);

  // Delivered, pending, or a state we do not recognise. The last is read as
  // pending deliberately: the order exists, so refunding it now could pay for
  // a bill that then delivers, and leaving it processing lets the sweep settle
  // it - or raise it to a person after an hour.
  return {
    status: remote.status === 'successful' ? 'success' : 'pending',
    message: remote.remark,
    'request-id': reference,
    amount: remote.amount,
    token: remote.token,
    recovered: true,
  };
}

/* ------------------------------------------------------------------ airtime */

// Fixed and documented, so no provider call at all. Shaped like every other
// catalogue so the app cannot tell where it came from.
async function listAirtimeProvidersCached() {
  return NETWORKS.map(n => ({ name: n.name, code: String(n.id), full_name: n.name, id: String(n.id) }));
}

async function buyAirtime({ provider, number, amount, reference }) {
  const network = networkId(provider);
  if (!network) throw providerError('Unknown network', { statusCode: 400 });

  // Their validator takes whole naira only; bills.controller refuses anything
  // else at quote time, so a fraction here is a caller bug, refused before it
  // costs a refund.
  const naira = Number(amount);
  if (!Number.isInteger(naira) || naira <= 0) throw providerError('Enter a whole naira amount', { statusCode: 400 });

  return vend(
    '/api/topup',
    {
      network,
      phone: providerPhone(number),
      // VTU, not SNS: share-and-sell is for transferring airtime between lines.
      plan_type: 'VTU',
      amount: naira,
      // Their default, and the safe one: the number is checked against the
      // network before anything is sent, so a wrong pick is a refund rather
      // than airtime fired at a line that cannot take it.
      bypass: false,
      'request-id': String(reference || '').trim(),
    },
    { fallback: 'Airtime purchase failed. Please try again.' }
  );
}

/* --------------------------------------------------------------- data plans */

async function listDataProvidersCached() {
  return listAirtimeProvidersCached();
}

/**
 * Every network's plans, in one call, cached whole - asking for MTN and asking
 * for Glo is the same request. The per-network reader filters it, so opening
 * four network tabs costs one provider call, not four.
 */
async function loadAllDataPlans({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'mysubwallet:data:all',
    async () => {
      const json = await mswCatalogue('/api/data-plan');
      const rows = Array.isArray(json?.plan) ? json.plan : [];

      const byNetwork = {};
      for (const row of rows) {
        const network = networkName(row?.network);
        const id = String(row?.plan_id ?? '').trim();
        const amount = toAmount(row?.amount);
        // The purchase call takes an integer plan id. A plan we could not send
        // back is not one to put on sale.
        if (!network || !/^\d+$/.test(id) || amount <= 0) continue;

        const family = planFamily(row?.network_type);
        const shaped = shapePlanName(row?.name, row?.network_type, family);

        (byNetwork[network] ||= []).push({
          id,
          name: shaped.name,
          amount,
          plan_type: family,
          duration_days: shaped.duration?.days || 0,
          validity: shaped.duration?.label || '',
        });
      }

      for (const plans of Object.values(byNetwork)) plans.sort((a, b) => a.amount - b.amount);
      return byNetwork;
    },
    ttlMs,
    { force }
  );
}

async function listDataPlansCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const network = networkName(provider);
  if (!network) throw providerError('Provider is required', { statusCode: 400 });

  const all = await loadAllDataPlans({ ttlMs, force });
  return all[network] || [];
}

async function buyData({ provider, planId, number, reference }) {
  const network = networkId(provider);
  if (!network) throw providerError('Unknown network', { statusCode: 400 });

  const plan = String(planId || '').trim();
  if (!/^\d+$/.test(plan)) throw providerError('That data plan is no longer available', { statusCode: 400 });

  return vend(
    '/api/data',
    {
      network,
      phone: providerPhone(number),
      data_plan: Number(plan),
      bypass: false,
      'request-id': String(reference || '').trim(),
    },
    { fallback: 'Data purchase failed. Please try again.' }
  );
}

/* ---------------------------------------------------------------------- tv */

async function loadCableProviders({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'mysubwallet:tv:providers',
    async () => {
      const json = await mswCatalogue('/api/cable-providers');
      const rows = Array.isArray(json?.provider) ? json.provider : [];
      return rows
        .map(row => {
          const id = String(row?.id ?? row?.plan_id ?? '').trim();
          const entry = tvEntry(row?.cable_name);
          if (!/^\d+$/.test(id) || !entry) return null;
          return { id, code: entry.code, name: entry.name, full_name: String(row?.cable_name || entry.name).trim() };
        })
        .filter(Boolean);
    },
    ttlMs,
    { force }
  );
}

/**
 * Every bouquet, in one call, grouped by the provider it belongs to.
 *
 * Grouped rather than flat even though their ids are unique today, because a
 * flat lookup is how a DStv purchase ends up addressing a GOtv bouquet the day
 * two providers share an id.
 */
async function loadAllTvPackages({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'mysubwallet:tv:packages',
    async () => {
      const json = await mswCatalogue('/api/cable-plans');
      const rows = Array.isArray(json?.plan) ? json.plan : [];

      const byCode = {};
      for (const row of rows) {
        const entry = tvEntry(row?.cable_name);
        const id = String(row?.plan_id ?? '').trim();
        const amount = toAmount(row?.plan_price);
        if (!entry || !/^\d+$/.test(id) || amount <= 0) continue;
        // `code` and `id` are the same value: the purchase addresses a bouquet
        // by its plan id, and the app has always sent back `code`.
        (byCode[entry.code] ||= []).push({ id, code: id, name: shapeTvName(row?.plan_name), amount });
      }

      for (const packages of Object.values(byCode)) packages.sort((a, b) => a.amount - b.amount);
      return byCode;
    },
    ttlMs,
    { force }
  );
}

async function listTvProvidersCached(opts = {}) {
  const providers = await loadCableProviders(opts);
  return providers.map(p => ({ name: p.name, code: p.code, full_name: p.name, id: p.id }));
}

async function listTvPackagesCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const entry = tvEntry(provider);
  if (!entry) throw providerError('Provider is required', { statusCode: 400 });

  const all = await loadAllTvPackages({ ttlMs, force });
  return all[entry.code] || [];
}

// Their numeric id for a cable provider, from the live catalogue only.
async function cableId(provider) {
  const entry = tvEntry(provider);
  if (!entry) return '';
  const providers = await loadCableProviders();
  const found = providers.find(p => p.code === entry.code);
  return found ? found.id : '';
}

// Smartcard / IUC lookup. The name it returns is PII: shown to the customer
// who asked, never logged.
async function validateTvSmartcard({ provider, number }) {
  const cable = await cableId(provider);
  if (!cable) throw providerError('Unknown TV provider', { statusCode: 400 });

  let json;
  try {
    json = await mswRequest('GET', '/api/cable/cable-validation', {
      query: { cable, iuc: String(number || '').trim() },
      retry: true,
    });
  } catch (e) {
    throw inCallerTerms(e, 'We could not verify that smartcard / IUC number. Check it and try again.');
  }

  const name = String(json?.name ?? json?.customer_name ?? '').trim();
  return { customer_name: name, address: '' };
}

async function payTv({ provider, number, code, reference, customerName }) {
  const cable = await cableId(provider);
  if (!cable) throw providerError('Unknown TV provider', { statusCode: 400 });

  const plan = String(code || '').trim();
  if (!/^\d+$/.test(plan)) throw providerError('That package is no longer available', { statusCode: 400 });

  // Accepted for parity with the contract and dropped: this API has no field
  // for the decoder holder's name. The receipt still carries it, from our own
  // ledger.
  void customerName;

  return vend(
    '/api/cable',
    {
      cable: Number(cable),
      cable_plan: Number(plan),
      iuc: String(number || '').trim(),
      // 1 skips their inline IUC check. Safe here, and only here, because
      // bills.controller verifies the smartcard at quote time and cannot reach
      // confirm without that verify having succeeded - which is the condition
      // their docs attach to bypassing.
      bypass: 1,
      'request-id': String(reference || '').trim(),
    },
    { fallback: 'TV subscription failed. Please try again.' }
  );
}

/* ------------------------------------------------------------- electricity */

async function listElectricityDiscosCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached(
    'mysubwallet:providers:electricity',
    async () => {
      const json = await mswCatalogue('/api/discos');
      const rows = Array.isArray(json?.bill) ? json.bill : [];
      return rows
        .map(row => {
          const id = String(row?.plan_id ?? '').trim();
          const fullName = String(row?.disco_name || '').trim();
          if (!/^\d+$/.test(id) || !fullName) return null;
          // `name` is what the picker renders and sends back, so it is the code
          // the app already ships a logo for. A DISCO this table has never
          // heard of still sells, under its own name.
          return { name: discoCodeForName(fullName) || fullName, code: id, full_name: fullName, id };
        })
        .filter(Boolean);
    },
    ttlMs,
    { force }
  );
}

/**
 * Their DISCO id for whatever the app sent - its short code, a legacy alias,
 * the catalogue's own sentence, or an id from a client that reads `code`.
 *
 * Only ever out of the live catalogue. When that cannot be read the answer is
 * '' and the caller refuses the request: electricity briefly down is a far
 * better outcome than a token bought from the wrong DISCO.
 */
async function discoId(provider) {
  const raw = String(provider || '').trim();
  if (!raw) return '';

  const discos = await listElectricityDiscosCached();

  if (/^\d+$/.test(raw)) return discos.some(d => d.code === raw) ? raw : '';

  const wanted = discoCodeForAlias(raw);
  if (wanted) {
    const byCode = discos.find(d => d.name === wanted);
    if (byCode) return byCode.code;
  }

  const key = normKey(raw);
  const byName = discos.find(d => normKey(d.full_name) === key || normKey(d.name) === key);
  return byName ? byName.code : '';
}

// Meter lookup. Same PII rule as the smartcard: the name, and the address a
// postpaid lookup adds, go back to the customer who asked and nowhere else.
async function validateElectricityMeter({ provider, number, meterType }) {
  // A catalogue that cannot be read surfaces as the outage it is.
  const disco = await discoId(provider);
  if (!disco) throw providerError('Unknown electricity provider', { statusCode: 400 });

  let json;
  try {
    json = await mswRequest('GET', '/api/bill/bill-validation', {
      query: {
        disco,
        meter_number: String(number || '').trim(),
        meter_type: normalizeMeterType(meterType),
      },
      retry: true,
    });
  } catch (e) {
    throw inCallerTerms(e, 'We could not verify that meter number. Check it and try again.');
  }

  return {
    customer_name: String(json?.customer_name ?? json?.name ?? '').trim(),
    address: String(json?.customer_address ?? json?.address ?? '').trim(),
  };
}

async function payElectricity({ provider, number, meterType, amount, reference, customerName }) {
  const disco = await discoId(provider);
  if (!disco) throw providerError('Unknown electricity provider', { statusCode: 400 });

  const naira = Number(amount);
  if (!Number.isInteger(naira) || naira <= 0) throw providerError('Enter a whole naira amount', { statusCode: 400 });

  void customerName;

  return vend(
    '/api/bill',
    {
      disco: Number(disco),
      meter_type: normalizeMeterType(meterType),
      meter_number: String(number || '').trim(),
      amount: naira,
      'request-id': String(reference || '').trim(),
    },
    { fallback: 'Electricity purchase failed. Please try again.' }
  );
}

/* ---------------------------------------------------------- airtime to cash */

// POST /api/cash, three steps on one path (Tier 2+ KYC on OUR account):
//
//   1 { step, network, phone }                        -> an OTP to the line, a `data` token
//   2 { step, network, phone, otp, data }             -> the OTP checked, a fresh `data` token
//   3 { step, network, phone, data, share_pin, amount } -> airtime moved, our float credited
//
// What is different from a vend, and why each function below looks the way it
// does:
//
//   - **"Insufficient balance" is the customer's line here, not our float.**
//     declined() reads that wording as our prepaid float running dry and pages
//     ops. Nothing on this path spends the float - it is credited - so the
//     refusal is put back into the customer's hands. See cashRefusal().
//   - **Steps 1 and 2 move nothing.** Neither is retried: a repeated step 1 is
//     a second text message, and the customer has a resend button.
//   - **Step 3 carries our request-id, which their docs do not list for this
//     path.** Sent anyway, through vend(), so an unreadable answer is asked
//     about before anyone decides; a requery that has never heard of it leaves
//     the conversion unconfirmed rather than failed - the airtime may be gone.
//   - **Their docs show the phone as 234..., their validator wanted 0803... on
//     every other path.** Step 1 tries the form that last worked, and when the
//     refusal names a digit count it tries the other form once. A step-1
//     validation refusal has sent nothing, so the second try is free.

const CASH_NETWORKS = new Set(['MTN', 'AIRTEL']);

// The phone form step 1 last succeeded with. Per process, and only a starting
// guess: every conversion records the form it used, and steps 2 and 3 reuse
// that rather than this.
let cashPhoneFormat = 'local';

function cashNetworkId(network) {
  const name = networkName(network);
  if (!CASH_NETWORKS.has(name)) {
    throw providerError('Airtime to Cash supports MTN and Airtel lines only', { statusCode: 400, kind: 'input' });
  }
  return networkId(name);
}

function cashPhone(number, format) {
  const phone = normalizeNgPhone(number);
  if (!phone) throw providerError('Enter a valid Nigerian phone number', { statusCode: 400, kind: 'input' });
  return format === 'international' ? phone.msisdn : phone.local;
}

// "The phone must be 13 digits." -> international; "... 11 digits." -> local.
function formatNamedBy(e) {
  if (!e || e.ambiguous || e.misconfigured) return '';
  const m = /\b(1[13])\s*digits\b/i.exec(String(e.providerMessage || ''));
  if (!m) return '';
  return m[1] === '13' ? 'international' : 'local';
}

/**
 * The verification token a step hands to the next one. Their docs call it
 * `data` and say no more, so the likely shapes are all read: a string, or an
 * object carrying one.
 */
function cashToken(json) {
  if (!json || typeof json !== 'object') return '';
  const d = json.data;
  if (typeof d === 'string' && d.trim()) return d.trim();
  if (d && typeof d === 'object') {
    for (const key of ['data', 'token', 'verification', 'verification_token', 'reference', 'ref', 'session']) {
      const v = d[key];
      if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim();
    }
  }
  for (const key of ['token', 'verification', 'verification_token']) {
    const v = json[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// Only fields that unambiguously name the cash credited. `amount` is not one of
// them: it may echo the airtime sent, and reading it as the credit would
// overstate our margin by a third.
function cashCredited(json) {
  if (!json || typeof json !== 'object') return null;
  const sources = [json, json.data && typeof json.data === 'object' ? json.data : {}];
  for (const src of sources) {
    for (const key of ['credited', 'amount_credited', 'credit', 'cash', 'payout', 'converted_amount', 'amount_paid']) {
      const n = toAmount(src[key]);
      if (n > 0) return n;
    }
  }
  return null;
}

// Our reseller account, not the customer: MySubWallet converts only for
// accounts at KYC Tier 2 or above.
const OUR_ACCOUNT_TIER = /\btier\b|\bkyc\b|upgrade\s+(your\s+)?account|not\s+eligible/i;
// A verification token that has lapsed. The customer has to start again.
const SESSION_EXPIRED =
  /(expired|invalid)\W+(?:\w+\W+){0,3}?(token|session|verification|request|data)\b|\b(token|session|verification)\W+(?:\w+\W+){0,3}?(expired|invalid)/i;
// A line that has used its transfer for the day. MySubWallet refuses the next
// one before anything moves - "This Airtel line has already converted airtime
// today. Airtel allows only one transfer per line per day - please try again
// tomorrow, or use another line." (conversions #9 and #10, 2026-10-12).
const CASH_DAILY_LIMIT =
  /already\s+converted\b.*\btoday\b|\b(one|1|single)\s+(transfer|conversion)s?\s+per\s+(line|number|day)\b|\bper\s+(line|number)\s+per\s+day\b|try\s+again\s+tomorrow|daily\s+(transfer\s+|conversion\s+)?limit/i;

const CASH_WORDING = {
  start: 'We could not send a code to that line. Check the number and the network, then try again.',
  verify: 'That code was not accepted. Check it and try again, or request a new one.',
  complete: 'The network did not complete the transfer. Check your Share & Sell PIN and that the line has enough airtime.',
};

// Step 3 waits longer than a vend. A live conversion (2026-10-12) took more
// than the 30s every other call gets, and a timeout is an answer we then
// cannot read; theirs, late, is better than ours, early.
const CASH_TIMEOUT_MS = Number(process.env.MYSUBWALLET_CASH_TIMEOUT_MS || 90_000);

// **Step 3 can be accepted and still working when it answers.** Live, on
// 2026-10-12: "Checking transaction... We will notify you once it is
// successful." - under a status that is not a success word. Read as a refusal,
// it filed an accepted conversion as "nothing moved": the customer's airtime
// was gone and VoltPay held no record of it. This wording is an acceptance,
// whatever status carries it.
const CASH_PENDING =
  /checking\s+(the\s+)?transaction|being\s+processed|in\s+progress|\bprocessing\b|\bpending\b|\bqueued\b|please\s+wait|will\s+(be\s+)?notif|once\s+(it\s+is\s+)?(successful|complete|confirmed)|awaiting\s+(confirmation|approval)/i;

function isCashPendingWording(text) {
  return CASH_PENDING.test(String(text || ''));
}

// The refusals that prove step 3 never ran: their validator, the PIN, the
// line's airtime, a lapsed session, a limit, a service switched off, our own
// key or account, their limiter. Only these may be read as "nothing moved". On
// this path a wrong "no" keeps a customer's airtime without a record, so every
// other refusal is an unknown - kept, shown, and settled by somebody who can
// see MySubWallet's side - never a decline. Each word here must name a check
// that runs before the transfer: a bare "wrong" once let "Something went
// wrong" pass as proof. The PIN is named on its own so a stored message alone
// - all the support screen has - still reads as the refusal it was.
const CASH_CLEAR_DECLINE =
  /\bpin\b|\bfield\b|\brequired\b|\bmust\s+be\b|\binvalid\b|\bincorrect\b|not\s+(allowed|supported|eligible|enough)|does\s+not\s+belong|insufficient|\bdisabled\b|\bsuspended\b|maintenance|not\s+available|\bunavailable\b/i;

function isClearCashDecline(e) {
  if (!e) return false;
  if (e.misconfigured || e.statusCode === 429) return true;
  if (e.wrongPin || e.lineBalance || e.sessionExpired || e.dailyLimit || e.kind === 'limit') return true;
  const said = String(e.providerMessage || '');
  return CASH_CLEAR_DECLINE.test(said) || CASH_DAILY_LIMIT.test(said);
}

/**
 * A refusal on the cash path, in the customer's terms.
 *
 * Outages stay outages - a bad key, a timeout, their limiter - because those
 * are ours to fix and the customer can only wait. Everything else is about the
 * line, the code or the PIN, and is worded for the step it happened on.
 */
function cashRefusal(e, step) {
  if (!e || e.ambiguous || e.statusCode === 429) return e;
  const raw = String(e.providerMessage || '');

  if (OUR_ACCOUNT_TIER.test(raw)) {
    e.message = UNAVAILABLE;
    e.statusCode = 503;
    e.misconfigured = true;
    e.kind = 'outage';
    return e;
  }
  if (e.misconfigured) return e;

  // declined() took this for our float. On this path it is the line's airtime.
  if (e.floatExhausted) {
    e.floatExhausted = false;
    e.lineBalance = true;
    e.statusCode = 400;
    e.kind = 'input';
    e.message = 'This line does not have enough airtime for that amount.';
    return e;
  }

  // Worded by us: theirs names Airtel's rule, and the same limit on another
  // network would read wrongly.
  if (CASH_DAILY_LIMIT.test(raw)) {
    e.dailyLimit = true;
    e.statusCode = 400;
    e.kind = 'limit';
    e.message = 'This line has reached its airtime transfer limit for today. Try again tomorrow, or convert from another line.';
    return e;
  }

  if (step !== 'start' && SESSION_EXPIRED.test(raw)) {
    e.sessionExpired = true;
    e.statusCode = 400;
    e.kind = 'input';
    e.message = 'Your verification has expired. Request a new code to continue.';
    return e;
  }

  if (step === 'verify' && (e.kind === 'input' || e.kind === 'unknown' || /\botp\b|\bcode\b/i.test(raw))) {
    e.kind = 'input';
    e.message = CASH_WORDING.verify;
    return e;
  }

  if (step === 'complete' && /\bpin\b/i.test(raw)) {
    e.wrongPin = true;
    e.kind = 'input';
    e.message = 'The network did not accept that Share & Sell PIN. Check it and try again.';
    return e;
  }

  // A limit carries their own "at least ..." wording, and a switched-off
  // service already says so; the phone wording from declined() suits step 1.
  if (e.kind === 'limit' || e.kind === 'unavailable' || (step === 'start' && e.kind === 'input')) return e;

  e.message = CASH_WORDING[step] || GENERIC;
  return e;
}

function cashRequest(body) {
  return mswRequest('POST', '/api/cash', { body });
}

/**
 * Step 1: text a code to the line. Returns the token step 2 needs and the phone
 * form that worked, which the caller stores for steps 2 and 3.
 */
async function startAirtimeCash({ network, phone, format } = {}) {
  const net = cashNetworkId(network);
  let wire = format === 'international' || format === 'local' ? format : cashPhoneFormat;

  let json;
  try {
    json = await cashRequest({ step: 1, network: net, phone: cashPhone(phone, wire) });
  } catch (e) {
    const other = formatNamedBy(e);
    if (!other || other === wire) throw cashRefusal(e, 'start');
    wire = other;
    try {
      json = await cashRequest({ step: 1, network: net, phone: cashPhone(phone, wire) });
    } catch (e2) {
      throw cashRefusal(e2, 'start');
    }
  }

  const token = cashToken(json);
  if (!token) {
    // Accepted, but nothing to verify against: a contract change on their side,
    // which no customer can fix.
    throw providerError(UNAVAILABLE, {
      statusCode: 502,
      misconfigured: true,
      kind: 'outage',
      payload: trimmedPayload(json),
      providerMessage: 'MySubWallet /api/cash step 1 answered without a verification token',
    });
  }

  cashPhoneFormat = wire;
  return { token, phoneFormat: wire, test_mode: json?.sandbox === true };
}

/** Step 2: check the code. Returns the token for step 3 (the old one if no new one came back). */
async function verifyAirtimeCashOtp({ network, phone, format, otp, token } = {}) {
  const net = cashNetworkId(network);
  let json;
  try {
    json = await cashRequest({
      step: 2,
      network: net,
      phone: cashPhone(phone, format),
      otp: String(otp || '').trim(),
      data: String(token || ''),
    });
  } catch (e) {
    throw cashRefusal(e, 'verify');
  }
  return { token: cashToken(json) || String(token || '') };
}

/**
 * Step 3: move the airtime. Through vend(), so an unreadable answer is
 * requeried by our request-id before it is called anything - though their
 * requery answers "Transaction not found" for every Airtime to Cash
 * request-id (checked live 2026-10-12), so for this path it never confirms.
 *
 * Returns `status` 'successful' (credited) or 'processing' (accepted, still
 * going - `accepted: true` when their words said so). Throws only two shapes:
 * a refusal that provably moved nothing (worded for the customer), or one with
 * `ambiguous` set - which the caller must keep as a conversion, never treat as
 * a failure: the airtime may have left the line.
 */
async function completeAirtimeCash({ network, phone, format, token, sharePin, amount, reference } = {}) {
  const net = cashNetworkId(network);
  const naira = Number(amount);
  if (!Number.isInteger(naira) || naira <= 0) {
    throw providerError('Enter a whole naira amount', { statusCode: 400, kind: 'input' });
  }

  let json;
  try {
    json = await vend(
      '/api/cash',
      {
        step: 3,
        network: net,
        phone: cashPhone(phone, format),
        data: String(token || ''),
        share_pin: String(sharePin || ''),
        amount: naira,
        'request-id': String(reference || '').trim(),
      },
      {},
      { timeoutMs: CASH_TIMEOUT_MS },
    );
  } catch (e) {
    // Accepted and still working, in their words, whatever status carried them.
    if (!e?.ambiguous && isCashPendingWording(e?.providerMessage)) {
      return {
        status: 'processing',
        reference: String(reference || ''),
        credited: null,
        recovered: false,
        accepted: true,
        message: String(e.providerMessage || ''),
        http_status: e.httpStatus ?? null,
        provider_status: e.mysubwallet?.status ?? null,
        test_mode: false,
      };
    }
    const refusal = cashRefusal(e, 'complete');
    // Not provably "nothing moved": an unknown for the caller to keep, show and
    // settle - never a decline it would quietly roll back.
    if (!refusal.ambiguous && !isClearCashDecline(refusal)) {
      refusal.ambiguous = true;
      refusal.unclassified = true;
    }
    throw refusal;
  }

  return {
    status: outcomeOf(json?.status) === 'success' ? 'successful' : 'processing',
    reference: String(json?.['request-id'] || reference || ''),
    credited: cashCredited(json),
    recovered: json?.recovered === true,
    message: firstErrorMessage(json),
    test_mode: json?.sandbox === true,
  };
}

/* ------------------------------------------------------------------ warming */

/**
 * Load every catalogue into both cache tiers.
 *
 * Four calls - data plans, cable providers, cable plans, DISCOs - each arriving
 * whole. Airtime networks are a static table and cost none.
 *
 * Contract shared with server.js: `{ loaded, failed, calls, skipped }`, and the
 * same two refusals as always - no key, and no shared cache on a forced pass,
 * where the L2 entry is the whole point and L1 alone lasts a minute of a
 * 25-minute cycle. Every step is independent so one failure never stops the
 * rest.
 */
async function warmCatalogues({ force = false, lockMs = REFRESH_LOCK_MS } = {}) {
  if (!isConfigured()) return { loaded: 0, failed: 0, calls: 0, skipped: 'not_configured' };

  if (force) {
    const claim = await claimRefresh('mysubwallet:warm', lockMs);
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
      console.warn(`⚠️  mysubwallet catalogue warm failed ${label}:`, String(e?.providerMessage || e?.message || e).slice(0, 120));
    }
  };

  await step('data plans', () => loadAllDataPlans(opts));
  await step('cable providers', () => loadCableProviders(opts));
  await step('cable plans', () => loadAllTvPackages(opts));
  await step('electricity discos', () => listElectricityDiscosCached(opts));

  return { loaded, failed, calls: catalogue.callCount() - callsBefore, skipped: null };
}

module.exports = {
  MIN_AMOUNTS,
  // The requery is keyed on our own request-id, so a vend whose response was
  // lost in flight can still be asked about - see billReconcile.helper.
  SUPPORTS_REQUEST_ID_LOOKUP: true,
  isConfigured,
  isSandbox,
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
  // electricity
  listElectricityDiscosCached,
  validateElectricityMeter,
  payElectricity,
  normalizeMeterType,
  // airtime to cash
  startAirtimeCash,
  verifyAirtimeCashOtp,
  completeAirtimeCash,
  isCashPendingWording,
  isClearCashDecline,
  // shared
  parseVendResult,
  extractToken,
  isFloatError,
  dropCatalogue,
  warmCatalogues,
  // exported for tests
  __test: {
    outcomeOf,
    declined,
    firstErrorMessage,
    trimmedPayload,
    shapePlanName,
    shapeTvName,
    planFamily,
    networkName,
    networkId,
    discoId,
    discoCodeForName,
    discoCodeForAlias,
    tvEntry,
    providerPhone,
    toAmount,
    sandboxForbidden,
    UNAVAILABLE,
    cashRefusal,
    cashToken,
    cashCredited,
    formatNamedBy,
  },
};
