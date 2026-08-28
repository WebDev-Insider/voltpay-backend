// PairGate bills provider.
//
// Covers the four bill rails: airtime, data, cable TV and electricity. Same
// contract as the provider module it replaced - this file owns the transport,
// the provider identifiers and the error shape, and nothing else. Pricing,
// wallet movement and the ledger stay in the controllers.
//
// Auth is one header:
//   Authorization: Bearer <api key>
//
// Four things about this API shape everything below:
//
//   1. The body's `code` is not the HTTP status. A rate-limited call answers
//      HTTP 429 with `code: 201`. Success is therefore read off
//      `status === "success"` and never off `code` - reading `code` would let a
//      throttled request pass for a completed vend.
//   2. Purchases are addressed by a lowercase *slug* (`mtn`, `ikedc`, `eko`),
//      but the catalogue only returns a slug for electricity. Networks and TV
//      providers come back as `{ id, name }`, so their slug has to be derived.
//      See resolveSlug.
//   3. The electricity slugs are not the DISCO codes this app has always used:
//      EKEDC is `eko`, PHED is `ph`, BEDC is `benin`, KAEDCO is `kaduna`. A
//      lowercase of the app's own name would silently address the wrong DISCO,
//      so the mapping is explicit and checked against the live catalogue.
//   4. An electricity token never comes back on the purchase call, and
//      `transaction/status` does not carry it either. It arrives only on the
//      webhook, which makes the webhook load-bearing rather than an optimisation
//      - see pairgateWebhook.controller.js.
//
// The account is a prepaid float: a purchase debits PairGate's own wallet, not
// the customer's. "Insufficient balance" from this API therefore means *our*
// float is empty, which is an operational incident and never something to show
// a customer whose own wallet is funded. isFloatError marks it.
const crypto = require('crypto');

const { withRetry, causeCode } = require('../helpers/retry.helper');
const { createCatalogueCache, REFRESH_HELD, REFRESH_NO_LOCK } = require('./catalogueCache');
const { readDuration, durationLabel, toDays } = require('./planDuration');

const BASE_URL = String(process.env.PAIRGATE_BASE_URL || 'https://pairgate.com/api/v1').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.PAIRGATE_TIMEOUT_MS || 30_000);
const CATALOGUE_TTL_MS = Number(process.env.PAIRGATE_CATALOGUE_TTL_MS || 30 * 60_000);

// Every purchase endpoint has a `/test` twin that validates the request and
// answers without debiting. Staging can point at it; production must not, so
// this is opt-in rather than derived from NODE_ENV.
const TEST_MODE = String(process.env.PAIRGATE_TEST_MODE || '').trim() === '1';

// Provider floors, enforced on their side. Quoting under them wastes a round
// trip and shows the customer a provider error instead of our own wording.
//
// Electricity is 100, read from their validator rather than their docs:
// POST /test/electricity/purchase with amount 70 answers
// `{"amount":["The amount field must be at least 100."]}`, and 100 is accepted.
// These are the PROVIDER floors only - VoltPay's own, higher, floors live in
// SERVICES in bills.controller.js and are what a customer actually hits.
const MIN_AMOUNTS = { airtime: 50, electricity: 100 };

/* ------------------------------------------------------------------- caching */

// The mechanics - two tiers, single-flight, stale-while-revalidate, a fleet-wide
// refresh lock - live in catalogueCache.js, shared with the other bills
// provider. What stays here is the four numbers, because each one is a fact
// about PairGate rather than about caching.
//
// The rate limit is 60 requests a minute for the whole key - catalogue reads,
// lookups and purchases share it - and there is a per-second limit underneath
// it. Cache misses are therefore coalesced as well as cached: four users opening
// the data screen at once on a cold cache must produce one upstream call, not
// four.
//
//   L1  in-process Map   no network at all, short TTL
//   L2  Redis            shared by every instance, survives a restart
//   L3  PairGate         the rate-limited origin
//
// **L1's TTL is deliberately much shorter than L2's.** With both at 30 minutes,
// an instance that read L2 at minute 29 would hold that value until minute 59 -
// stacking the two tiers into an hour of possible staleness. That matters here
// specifically because a data or TV price out of this catalogue is what the
// customer is charged: quote a stale price and we collect the old amount while
// the provider bills us the new one. A 60-second L1 means every instance
// re-checks Redis constantly, so the real staleness bound stays L2's freshness
// window - the same window as before this change - while the upstream call
// count collapses.
const LOCAL_TTL_MS = Number(process.env.PAIRGATE_LOCAL_TTL_MS || 60_000);

// How long a catalogue stays *servable* after it stops being fresh.
//
// Without a grace window, the request that arrives one millisecond after the TTL
// pays for the whole cold load - for data plans that is a categories call plus
// one call per plan family, paced a second apart, so the customer who happened
// to open the screen at minute 30 waits five seconds for the list four other
// customers just got instantly. With it, that request is answered from the stale
// copy and the refresh runs behind it.
//
// It does not widen normal staleness: the first stale read kicks the refresh, so
// with any traffic at all the value is replaced within seconds of going stale,
// and warmCatalogues() usually replaces it before it ever gets there. The grace
// is only really consumed when the refresh keeps failing - which is PairGate
// being down, and the choice there is a slightly old price or no bills screen at
// all.
const STALE_GRACE_MS = Number(process.env.PAIRGATE_STALE_GRACE_MS || 30 * 60_000);

// PairGate throttles per second as well as per minute, and the catalogue path is
// the one that naturally bursts: `/data-plans` is called once per plan family,
// so loading MTN alone is five back-to-back calls, and the app asks for
// providers and plans in parallel on top of that.
//
// Firing them with no gap does not make them arrive sooner. It makes the second
// one answer 429 "Please wait 1 seconds before retrying", which costs the round
// trip *and* the 1.25s retry.helper then sleeps - so the collision is strictly
// slower than the gap that avoids it. Worse, PROVIDER_MAX_RETRIES is 2 and
// listDataPlansCached swallows a per-family failure, so a family that trips the
// limiter twice is dropped and the customer gets a plan list with a whole tier
// silently missing.
//
// So catalogue reads queue behind a minimum gap instead. Deliberately only the
// catalogue path: a vend is one call per customer action and must never sit in a
// queue behind somebody else's plan list.
const CATALOGUE_GAP_MS = Number(process.env.PAIRGATE_CATALOGUE_GAP_MS || 1_100);

// Long enough to cover a refresh, short enough that a crashed holder does not
// pin a stale catalogue for the rest of its grace window.
const REFRESH_LOCK_MS = 60_000;

const catalogue = createCatalogueCache({
  label: 'pairgate',
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
  err.pairgate = payload;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  if (isFloatError(message)) err.floatExhausted = true;
  return err;
}

// PairGate throttles per second, not only per minute, and it says how long to
// wait - in a `Retry-After` header on some responses and in the message body on
// others ("Please wait 2 seconds before retrying."). Backing off on our own
// schedule ignores an instruction the provider gave us in plain text, and 300ms
// against a one-second floor is a retry that cannot succeed.
//
// The extra 250ms is because their boundary is inclusive: replying exactly on
// the second still reads as too early.
function retryAfterFrom(res, message) {
  const header = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.round(header * 1000) + 250;

  const stated = /wait\s+(\d+)\s*second/i.exec(String(message || ''));
  if (stated) {
    const seconds = Number(stated[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000 + 250;
  }

  // "Too Many Attempts." carries no number. It is their generic throttle reply,
  // so assume the shortest window they ever quote rather than hammering.
  if (/too many attempts/i.test(String(message || ''))) return 1_250;

  return null;
}

// Our float, not the customer's wallet. The controller has to translate this
// into a neutral message and page whoever tops the float up.
function isFloatError(message) {
  return /insufficient\s+(wallet\s+)?balance|low\s+balance/i.test(String(message || ''));
}

// The envelope carries a single `message` string on failure. `data.message`
// covers the vend-level rejections, which are more specific than the envelope.
function firstErrorMessage(json) {
  if (!json) return 'PairGate request failed';

  const vendLine = json.data && typeof json.data.message === 'string' ? json.data.message.trim() : '';
  if (vendLine) return vendLine;

  if (typeof json.message === 'string' && json.message.trim()) return json.message.trim();
  if (typeof json.error === 'string' && json.error.trim()) return json.error.trim();
  return 'PairGate request failed';
}

// `status: "success"` only says the request was accepted. A declined vend still
// answers 200, with `data.status: false`. Without this the wallet is debited,
// the row is stamped Successful and nothing is ever delivered.
//
// Checked strictly against `false`: a test-mode purchase has no `data.status`
// at all, and `undefined` must not read as a decline.
function vendFailure(json) {
  const data = json?.data;
  if (!data || typeof data !== 'object') return null;
  if (data.status !== false) return null;
  return String(data.message || '').trim() || firstErrorMessage(json);
}

/* ----------------------------------------------------------------- transport */

function getApiKey() {
  const key = String(process.env.PAIRGATE_API_KEY || '').trim();
  if (!key) throw new Error('Missing required env: PAIRGATE_API_KEY');
  return key;
}

// Can this rail be pointed at us at all? Credentials only - it calls nobody.
// billsProvider asks before letting an admin switch a service onto this
// provider, so "no key" is refused at the switch rather than discovered one
// refunded purchase at a time.
function isConfigured() {
  return Boolean(String(process.env.PAIRGATE_API_KEY || '').trim());
}

// Catalogue and lookup calls are reads, so a timeout, a 5xx or a 429 is retried
// with backoff - the rate limiter here is tight enough that an un-retried
// catalogue read shows the customer an empty bills screen.
//
// A vend is never retried. A purchase that timed out may already have been
// delivered, and repeating it buys a second one. What recovers those is the
// `reference` on the row plus the webhook, not another POST. The two verify
// endpoints are POSTs that only look something up, so they opt in explicitly.
//
// `pace` puts the call in the catalogue queue - see paceCatalogue. It wraps the
// single attempt rather than the retry loop, so a retried catalogue read is
// spaced from its neighbours too.
async function pgRequest(method, path, { query, body, retry, pace } = {}) {
  const attempt = () => pgRequestOnce(method, path, { query, body });
  const once = pace ? () => paceCatalogue(attempt) : attempt;
  const shouldRetry = retry != null ? Boolean(retry) : String(method).toUpperCase() === 'GET';
  if (!shouldRetry) return once();
  return withRetry(once, { label: `pairgate ${path}` });
}

/** A catalogue GET: retried like any read, and paced against the per-second limit. */
function pgCatalogue(path, query) {
  return pgRequest('GET', path, { query, pace: true });
}

async function pgRequestOnce(method, path, { query, body } = {}) {
  const apiKey = getApiKey();

  // The sandbox switch is a path segment directly after the version prefix:
  // /api/v1/test/airtime/purchase.
  const suffix = path.startsWith('/') ? path : `/${path}`;
  let url = `${BASE_URL}${TEST_MODE ? '/test' : ''}${suffix}`;

  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v) !== '') qs.append(k, String(v));
    }
    const encoded = qs.toString();
    if (encoded) url += `?${encoded}`;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    // Balances and catalogues are read through an edge cache otherwise, which
    // is how a topped-up float keeps reading as empty.
    'Cache-Control': 'no-cache',
  };

  let payload;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    text = await res.text();
  } catch (e) {
    // See the same block in clubkonnect.service.js: `fetch` collapses DNS
    // failure, connection refused, a mid-flight reset and a rejected
    // certificate into the one message "fetch failed", so the code is lifted
    // out of `cause` or the log names none of them.
    const code = causeCode(e);
    const reason =
      e?.name === 'AbortError'
        ? `PairGate request timed out after ${TIMEOUT_MS}ms`
        : `PairGate request failed: ${e?.message || e}${code ? ` (${code})` : ''}`;

    throw providerError(reason, { statusCode: 504, cause: e });
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means we reached an error page rather than the API - a
    // wrong path, or a gateway in front of it. Keep a slice for the logs, never
    // the whole page.
    throw providerError('PairGate returned an invalid response', {
      payload: { raw: String(text || '').slice(0, 500) },
    });
  }

  // Deliberately not `json.code`: the API answers a throttled request with
  // HTTP 429 and `code: 201`, so the body's code says nothing reliable.
  if (String(json?.status || '').toLowerCase() !== 'success') {
    // 4xx is a bad request from us or from the customer (unknown meter, wrong
    // plan). 429 is the rate limiter, which retry.helper treats as transient.
    // 5xx is PairGate being down. All surface with the provider's own wording so
    // support can match it against their dashboard.
    const statusCode = res.status >= 400 ? res.status : 502;
    const message = firstErrorMessage(json);
    throw providerError(message, {
      statusCode,
      payload: json,
      retryAfterMs: retryAfterFrom(res, message),
    });
  }

  const declined = vendFailure(json);
  if (declined) throw providerError(declined, { statusCode: 400, payload: json });

  return json;
}

/* ------------------------------------------------- provider identity mapping */

function normKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Networks and TV providers come back without a slug, but their display names
// are already the short codes the purchase endpoints want in lowercase. Only the
// 9mobile aliases need spelling out.
const NETWORK_SLUGS = {
  MTN: 'mtn',
  GLO: 'glo',
  GLOBACOM: 'glo',
  AIRTEL: 'airtel',
  '9MOBILE': '9mobile',
  '9MOBILENG': '9mobile',
  ETISALAT: '9mobile',
};

const TV_SLUGS = {
  DSTV: 'dstv',
  GOTV: 'gotv',
  STARTIMES: 'startimes',
  STARTIME: 'startimes',
};

// The app's DISCO codes - and the asset filenames that go with them - predate
// this provider and do not match its slugs. Both directions are needed: the app
// sends `IKEDC` and the API wants `ikedc`, but the app sends `PHED` and the API
// wants `ph`. Every legacy spelling the app or a stale client list can produce
// is listed, because an unmapped DISCO is a payment addressed to nobody.
const DISCO_SLUGS = {
  IKEDC: 'ikedc', IKEJA: 'ikedc',
  EKEDC: 'eko', EKO: 'eko',
  AEDC: 'aedc', ABUJA: 'aedc',
  PHED: 'ph', PHEDC: 'ph', PH: 'ph', PORTHARCOURT: 'ph',
  BEDC: 'benin', BENIN: 'benin',
  KAEDCO: 'kaduna', KAEDC: 'kaduna', KADUNA: 'kaduna',
  KEDCO: 'kedco', KANO: 'kedco',
  JED: 'jedc', JEDC: 'jedc', JOS: 'jedc',
  IBEDC: 'ibedc', IBADAN: 'ibedc',
  EEDC: 'enugu', ENUGU: 'enugu',
  YEDC: 'yola', YOLA: 'yola',
  ABA: 'aba', APL: 'aba', APLE: 'aba',
};

// The reverse: what the app should *display* and send back. PairGate's own name
// is a sentence ("Ikeja Electricity - IKEDC (PHCN)"), which is too long for the
// picker and, worse, defeats the app's logo resolver on Kaduna - "KAEDC" alone
// contains "aedc", so it would render Abuja's mark. Pinning the display name to
// the code the app already ships assets for keeps both correct.
const DISCO_DISPLAY = {
  ikedc: 'IKEDC',
  eko: 'EKEDC',
  aedc: 'AEDC',
  ph: 'PHED',
  benin: 'BEDC',
  kaduna: 'KAEDCO',
  kedco: 'KEDCO',
  jedc: 'JED',
  ibedc: 'IBEDC',
  enugu: 'EEDC',
  yola: 'YEDC',
  aba: 'ABA',
};

function networkSlug(provider) {
  const key = normKey(provider);
  if (!key) return '';
  if (NETWORK_SLUGS[key]) return NETWORK_SLUGS[key];
  // A network added after this table was written still works if its name is
  // already the slug.
  return /^[A-Z0-9]+$/.test(key) ? key.toLowerCase() : '';
}

function tvSlug(provider) {
  const key = normKey(provider);
  if (!key) return '';
  if (TV_SLUGS[key]) return TV_SLUGS[key];
  return /^[A-Z0-9]+$/.test(key) ? key.toLowerCase() : '';
}

// Electricity is the one rail where guessing is unsafe, so the live catalogue is
// the authority and the table above is only a bridge from the app's spelling.
// Falls back to the table alone when the catalogue cannot be read - a rate-limit
// blip must not take electricity down.
async function discoSlug(provider) {
  const raw = String(provider || '').trim();
  if (!raw) return '';

  const key = normKey(raw);
  const mapped = DISCO_SLUGS[key] || '';

  let discos = [];
  try {
    discos = await listElectricityDiscosCached();
  } catch {
    return mapped;
  }

  const lower = raw.toLowerCase();

  // Already a slug, from a client that reads `code`.
  const bySlug = discos.find(d => String(d.code || '').toLowerCase() === lower);
  if (bySlug) return String(bySlug.code).toLowerCase();

  // The app's own code, via the bridge - but only if the catalogue still carries
  // it, so a DISCO that was withdrawn fails loudly instead of vending into a
  // dead slug.
  if (mapped && discos.some(d => String(d.code || '').toLowerCase() === mapped)) return mapped;

  // Display name, or the provider's full sentence from a stale client list.
  const byName = discos.find(d => {
    const name = normKey(d.name);
    const full = normKey(d.full_name);
    return name === key || full === key || (key.length >= 3 && full.includes(key));
  });
  if (byName) return String(byName.code || '').toLowerCase();

  return mapped;
}

/* ------------------------------------------------------ response normalising */

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The catalogue answers `{ id, name }` for networks and TV, and adds `slug` for
// electricity. One shape goes out: `name` is what the picker shows and what the
// app sends back, `code` is the slug the purchase endpoints need.
function shapeProviders(rows, kind) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const name = String(row?.name || '').trim();
    const apiSlug = String(row?.slug || '').trim().toLowerCase();

    if (kind === 'electricity') {
      const code = apiSlug || DISCO_SLUGS[normKey(name)] || '';
      return {
        // The app renders `name` and sends it back, so it has to be the code
        // this app has always used, not the provider's sentence.
        name: DISCO_DISPLAY[code] || name,
        code,
        full_name: name,
        id: String(row?.id || ''),
      };
    }

    const code = kind === 'tv' ? tvSlug(name) : networkSlug(name);
    return { name, code, full_name: name, id: String(row?.id || '') };
  });
}

// Plans arrive grouped under the provider's display name - `{ MTN: [...] }` -
// rather than as a flat array, so the group is flattened without depending on
// what the key is spelled as.
function flattenPlans(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const out = [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) out.push(...value);
  }
  return out;
}

// One shape for every purchase response, so the controller reads the same fields
// whether it just bought airtime or electricity.
//
// `token` is always empty here. This provider delivers the electricity token on
// the webhook and nowhere else, so a token in a purchase response would be a
// field that never arrives.
function parseVendResult(json) {
  const data = json && typeof json.data === 'object' && json.data ? json.data : {};
  return {
    reference: String(data.reference_code || '').trim(),
    order_no: '',
    // `data.status` is a boolean here. A false one has already been thrown as a
    // decline, so anything reaching this point was accepted.
    status: data.status === true ? 'successful' : 'processing',
    token: '',
    units: '',
    message: String(data.message || json?.message || '').trim(),
    amount: toAmount(data.amount),
    plan: String(data.plan || data.item || '').trim(),
    test_mode: data.test_mode === true,
  };
}

// A lookup answered, but a biller that cannot place the number sometimes says so
// with an empty name rather than an error. The caller treats a blank name as a
// failed lookup - letting it through means the confirmation sheet shows a meter
// with no owner.
//
// There is no address on this rail. The field is kept so the controller and the
// app model do not have to special-case its absence.
function parseCustomer(json) {
  const data = json?.data ?? json;
  const name = data && typeof data === 'object' ? data.customer_name : '';
  return {
    customer_name: typeof name === 'string' ? name.trim() : '',
    address: '',
  };
}

/* ------------------------------------------------------------------- account */

// Read before a vend is not worth the rate-limit budget - the purchase call
// reports the float itself. This exists for the ops alert and the health check.
async function getWalletBalance() {
  const json = await pgRequest('GET', '/wallet/balance');
  const data = json?.data || {};
  return {
    balance: toAmount(data.balance),
    currency: String(data.currency || 'NGN'),
    retrieved_at: String(data.retrieved_at || ''),
  };
}

// Where the float is topped up from. Not a secret - it is an account money is
// sent TO - but it is deployment config, so it is read from the environment and
// only documented in .env.example. Hardcoding it would mean a code deploy the
// day PairGate reassigns the account, which is the one day you cannot wait.
function getFundingAccount() {
  return {
    bank_name: String(process.env.PAIRGATE_FUNDING_BANK || '').trim(),
    account_number: String(process.env.PAIRGATE_FUNDING_ACCOUNT_NUMBER || '').trim(),
    account_name: String(process.env.PAIRGATE_FUNDING_ACCOUNT_NAME || '').trim(),
  };
}

// Two thresholds rather than one, because they mean different things to the
// person reading the screen: `low` is "raise a transfer today", `critical` is
// "vends are about to start failing". Defaults are deliberately generous - a
// float that runs dry is a total bills outage, not a degraded one.
function floatThresholds() {
  const critical = Number(process.env.PAIRGATE_FLOAT_CRITICAL_NGN || 5_000);
  const low = Number(process.env.PAIRGATE_FLOAT_LOW_NGN || 25_000);
  return {
    critical: Number.isFinite(critical) && critical >= 0 ? critical : 5_000,
    low: Number.isFinite(low) && low >= 0 ? low : 25_000,
  };
}

function floatVerdict(balance) {
  const { critical, low } = floatThresholds();
  // Absent is not zero. `Number(null)` and `Number('')` are both 0, which would
  // report a float we could not read as one that is empty - the loudest verdict
  // on the screen, raised on a missing field. The dashboard has `unknown` for
  // exactly this and says "treat the last known figure as stale" instead. A
  // genuine numeric 0 still means critical.
  if (balance == null || balance === '') return 'unknown';
  const amount = Number(balance);
  if (!Number.isFinite(amount)) return 'unknown';
  if (amount <= critical) return 'critical';
  if (amount <= low) return 'low';
  return 'healthy';
}

// The reconciliation read. A webhook that never arrived leaves a row stuck on
// "processing"; this is how it gets settled. It does not carry the electricity
// token, so it can close a transaction's status but cannot recover its token.
async function getTransactionStatus(referenceCode) {
  const ref = String(referenceCode || '').trim();
  if (!ref) throw providerError('reference_code is required', { statusCode: 400 });

  const json = await pgRequest('GET', '/transaction/status', { query: { reference_code: ref } });
  const data = json?.data || {};
  return {
    reference_code: String(data.reference_code || ref),
    type: String(data.type || '').trim().toLowerCase(),
    status: String(data.status || '').trim().toLowerCase(),
    amount: toAmount(data.amount),
    item: String(data.plan || data.item || '').trim(),
    recipient: String(data.recipient || '').trim(),
    created_at: String(data.created_at || ''),
  };
}

async function listProvidersByType(type) {
  const json = await pgCatalogue(`/providers/${encodeURIComponent(type)}`);
  return Array.isArray(json?.data) ? json.data : [];
}

/* ------------------------------------------------------------------ airtime */

async function listAirtimeProvidersCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached('pairgate:providers:airtime', async () => shapeProviders(await listProvidersByType('airtime'), 'airtime'), ttlMs, { force });
}

async function buyAirtime({ provider, number, amount, reference }) {
  const slug = networkSlug(provider);
  if (!slug) throw providerError('Unknown network', { statusCode: 400 });

  return await pgRequest('POST', '/airtime/purchase', {
    body: {
      provider_id: slug,
      amount: Number(amount),
      recipient: String(number || '').trim(),
      reference: String(reference || '').trim(),
    },
  });
}

/* --------------------------------------------------------------- data plans */

async function listDataProvidersCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached('pairgate:providers:data', async () => shapeProviders(await listProvidersByType('data'), 'data'), ttlMs, { force });
}

// Which plan families a network actually sells. It is not uniform - MTN has all
// four, GLO has no SME, 9mobile has no CG - so asking for a family a network
// does not carry is a 422 rather than an empty list.
async function listDataPlanTypesCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached('pairgate:data:categories', async () => {
    const json = await pgCatalogue('/data-plans/categories');
    const rows = Array.isArray(json?.data) ? json.data : [];

    const byProvider = new Map();
    for (const row of rows) {
      const slug = networkSlug(row?.provider_name);
      const planType = String(row?.plan_type || '').trim();
      if (!slug || !planType) continue;
      if (!byProvider.has(slug)) byProvider.set(slug, []);
      byProvider.get(slug).push(planType);
    }
    return Object.fromEntries(byProvider);
  }, ttlMs, { force });
}

async function listDataPlansForType(slug, planType) {
  const json = await pgCatalogue('/data-plans', { provider_id: slug, plan_type: planType });
  return flattenPlans(json?.data);
}

// Every family a network carries, merged into one list.
//
// The families are priced very differently for the same bundle - 1GB/7 days is
// cheaper on CG than on SME - so they are not deduplicated. The plan names carry
// the family ("1GB (CG)"), which is what lets the customer tell two same-size
// bundles apart in the picker.
//
// One family failing does not empty the screen: what loaded is returned, and
// only a total failure throws.
async function listDataPlansCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const slug = networkSlug(provider);
  if (!slug) throw providerError('Provider is required', { statusCode: 400 });

  return cached(`pairgate:data:plans:${slug}`, async () => {
    const types = (await listDataPlanTypesCached())[slug] || [];
    if (!types.length) return [];

    // Sequential on purpose. Four parallel reads per network, times four
    // networks on a cold cache, is most of a minute's rate-limit budget spent
    // at once - and this path is already behind the single-flight guard.
    // paceCatalogue spaces them, so the loop no longer walks into the
    // per-second limiter on its own second call.
    const plans = [];
    const failures = [];
    for (const planType of types) {
      try {
        for (const row of await listDataPlansForType(slug, planType)) {
          const id = String(row?.plan_id ?? '').trim();
          const amount = toAmount(row?.price);
          if (!id || amount <= 0) continue;

          const name = String(row?.name || '').trim() || `${planType} bundle`;

          // `duration` is the field they split out of the description: an
          // integer of days, on every data endpoint. Reading the name is the
          // fallback, not the plan - it covers a row that predates the change
          // and a cached catalogue written by an older build, both of which are
          // live on the same account during a rollout. When they stated the
          // number we say the number; when we read it off the name we say it
          // back in their own words. See planDuration.js.
          const stated = toDays(row?.duration);
          const parsed = stated ? null : readDuration(name);

          plans.push({
            id,
            name,
            amount,
            plan_type: planType,
            duration_days: stated || parsed?.days || 0,
            validity: stated ? durationLabel(stated) : parsed?.label || '',
          });
        }
      } catch (e) {
        failures.push(e);
      }
    }

    if (!plans.length && failures.length) throw failures[0];

    plans.sort((a, b) => a.amount - b.amount);
    return plans;
  }, ttlMs, { force });
}

async function buyData({ provider, planId, number, reference }) {
  const slug = networkSlug(provider);
  if (!slug) throw providerError('Unknown network', { statusCode: 400 });

  return await pgRequest('POST', '/data/purchase', {
    body: {
      provider_id: slug,
      plan_id: String(planId || '').trim(),
      recipient: String(number || '').trim(),
      reference: String(reference || '').trim(),
    },
  });
}

/* ---------------------------------------------------------------------- tv */

async function listTvProvidersCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached('pairgate:providers:tv', async () => shapeProviders(await listProvidersByType('tv'), 'tv'), ttlMs, { force });
}

// `code` and `id` are deliberately the same value. The purchase call addresses a
// bouquet by `plan_id`, and the app has always sent back the package's `code`.
async function listTvPackagesCached(provider, { ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  const slug = tvSlug(provider);
  if (!slug) throw providerError('Provider is required', { statusCode: 400 });

  return cached(`pairgate:tv:packages:${slug}`, async () => {
    const json = await pgCatalogue('/cable-plans', { provider_id: slug });
    return flattenPlans(json?.data)
      .map(row => {
        const id = String(row?.plan_id ?? '').trim();
        return {
          id,
          code: id,
          name: String(row?.name || '').trim(),
          amount: toAmount(row?.price),
        };
      })
      .filter(p => p.id && p.amount > 0)
      .sort((a, b) => a.amount - b.amount);
  }, ttlMs, { force });
}

// Smartcard / IUC lookup. The response carries the account holder's name, so the
// caller must treat it as PII: show it to the customer who asked, never log it.
async function validateTvSmartcard({ provider, number }) {
  const slug = tvSlug(provider);
  if (!slug) throw providerError('Unknown TV provider', { statusCode: 400 });

  const json = await pgRequest('POST', '/cable/verify', {
    body: { provider_id: slug, smartcard: String(number || '').trim() },
    retry: true,
  });
  return parseCustomer(json);
}

async function payTv({ provider, number, code, reference, customerName }) {
  const slug = tvSlug(provider);
  if (!slug) throw providerError('Unknown TV provider', { statusCode: 400 });

  const body = {
    provider_id: slug,
    plan_id: String(code || '').trim(),
    smartcard: String(number || '').trim(),
    reference: String(reference || '').trim(),
  };
  // Optional on their side, and it is the decoder holder's name - sent because
  // it is what appears on their reconciliation, never logged on ours.
  const named = String(customerName || '').trim();
  if (named) body.recipient_name = named;

  return await pgRequest('POST', '/cable/purchase', { body });
}

/* ------------------------------------------------------------- electricity */

// The app and the ledger speak "prepaid" / "postpaid"; the API wants 1 / 2. The
// string form stays the canonical one so nothing downstream has to learn a
// magic number.
function normalizeMeterType(meterType) {
  const t = String(meterType || '').trim().toLowerCase();
  if (t === '2' || t.startsWith('post')) return 'postpaid';
  return 'prepaid';
}

function meterTypeCode(meterType) {
  return normalizeMeterType(meterType) === 'postpaid' ? 2 : 1;
}

async function listElectricityDiscosCached({ ttlMs = CATALOGUE_TTL_MS, force = false } = {}) {
  return cached('pairgate:providers:electricity', async () => shapeProviders(await listProvidersByType('electricity'), 'electricity'), ttlMs, { force });
}

// Meter lookup. Same PII rule as the smartcard lookup - the customer name in the
// response is display-only. No address is returned on this rail.
async function validateElectricityMeter({ provider, number, meterType }) {
  const slug = await discoSlug(provider);
  if (!slug) throw providerError('Unknown electricity provider', { statusCode: 400 });

  const json = await pgRequest('POST', '/electricity/verify', {
    body: {
      provider_id: slug,
      meter_number: String(number || '').trim(),
      meter_type: meterTypeCode(meterType),
    },
    retry: true,
  });
  return parseCustomer(json);
}

async function payElectricity({ provider, number, meterType, amount, reference, customerName }) {
  const slug = await discoSlug(provider);
  if (!slug) throw providerError('Unknown electricity provider', { statusCode: 400 });

  const body = {
    provider_id: slug,
    amount: Number(amount),
    meter_number: String(number || '').trim(),
    meter_type: meterTypeCode(meterType),
    reference: String(reference || '').trim(),
  };
  const named = String(customerName || '').trim();
  if (named) body.recipient_name = named;

  return await pgRequest('POST', '/electricity/purchase', { body });
}

/* ------------------------------------------------------------------ warming */

/**
 * Load every catalogue into both cache tiers.
 *
 * Called at boot and on an interval from server.js, so the cost of a refresh is
 * paid by this process on a timer rather than by whichever customer happened to
 * open the bills screen first.
 *
 * Returns `{ loaded, failed, calls, skipped }`. `loaded` counts steps and
 * `calls` counts provider requests, which are not the same number and it is the
 * second one that matters: `data plans MTN` is one step but one call per family
 * the network carries. Measured against the live catalogue that is 20 calls -
 * five fixed lists, twelve plan families across four networks, three TV
 * providers - paced ~1.1s apart, so about 22 seconds. Against a 60-a-minute key
 * shared by every process, that is a third of one minute's budget with roughly
 * 40 calls left for vends, and none of it on a request path. The count is
 * returned rather than assumed because the family split belongs to PairGate's
 * data, not to this code: a network gaining a tier changes it silently.
 *
 * `force` re-reads even a catalogue that is still fresh, which is what the
 * interval wants: warming at minute 25 of a 30-minute window is a no-op
 * otherwise, and the whole point is to replace the value *before* anyone can be
 * quoted a stale price. It is also the only mode that takes the fleet lock, and
 * the only one that declines to run without Redis - see the guards below.
 *
 * Every step is independent - one network's plans failing must not stop the rest
 * from warming - so failures are counted and logged, never thrown. A pass with
 * no API key configured is skipped rather than logging a dozen identical
 * failures at every boot of a local checkout.
 */
async function warmCatalogues({ force = false, lockMs = REFRESH_LOCK_MS } = {}) {
  if (!String(process.env.PAIRGATE_API_KEY || '').trim()) {
    return { loaded: 0, failed: 0, calls: 0, skipped: 'no_api_key' };
  }

  if (force) {
    const claim = await claimRefresh('warm', lockMs);

    // One instance warms per cycle. N instances all forcing the same refresh in
    // the same minute is N times the upstream calls for one identical answer.
    if (claim === REFRESH_HELD) return { loaded: 0, failed: 0, calls: 0, skipped: 'locked' };

    // No working Redis, so no L2 to write into - and L2 is the entire product of
    // a forced pass. loadInto caps L1 at LOCAL_TTL_MS, so what this pass leaves
    // behind is gone 60 seconds later while the next tick is 25 minutes away:
    // twenty-odd provider calls to cover four percent of the cycle, spent
    // against a 60-a-minute budget that live vends are also drawing on. On-demand
    // loading behind the single-flight guard is the better trade until the cache
    // is back, so the pass is skipped - loudly, at the caller.
    if (claim === REFRESH_NO_LOCK) return { loaded: 0, failed: 0, calls: 0, skipped: 'no_shared_cache' };
  }

  const opts = { force };
  const callsBefore = catalogue.callCount();
  let loaded = 0;
  let failed = 0;

  const step = async (label, fn) => {
    try {
      const out = await fn();
      loaded += 1;
      return out;
    } catch (e) {
      failed += 1;
      console.warn(`⚠️  catalogue warm failed ${label}:`, String(e?.message || e).slice(0, 120));
      return null;
    }
  };

  await step('airtime providers', () => listAirtimeProvidersCached(opts));
  await step('electricity discos', () => listElectricityDiscosCached(opts));
  // Before the plan loop, not inside it: listDataPlansCached reads the families
  // back without `force`, so warming them first is what stops each network from
  // re-forcing the same categories call.
  await step('data categories', () => listDataPlanTypesCached(opts));

  const networks = await step('data providers', () => listDataProvidersCached(opts));
  for (const row of networks || []) {
    const code = String(row?.code || '').trim();
    if (code) await step(`data plans ${code}`, () => listDataPlansCached(code, opts));
  }

  const tv = await step('tv providers', () => listTvProvidersCached(opts));
  for (const row of tv || []) {
    const code = String(row?.code || '').trim();
    if (code) await step(`tv packages ${code}`, () => listTvPackagesCached(code, opts));
  }

  // `calls` is what PairGate's limiter counted, which is always more than
  // `loaded`: one data-plans step is one call per family the network carries.
  return { loaded, failed, calls: catalogue.callCount() - callsBefore, skipped: null };
}

/* ------------------------------------------------------------------ webhook */

// Signature verification is optional on their dashboard and off by default. It
// is not optional here once a secret is configured: the webhook is what delivers
// electricity tokens and what settles a failed vend into a refund, so an
// unauthenticated POST to it is a way to hand out tokens or fake a refund.
//
// The signed string is `timestamp + "." + raw body`, keyed with the webhook
// secret. It must be the *raw* bytes - re-serialising the parsed body reorders
// keys and reformats numbers, and the signature stops matching.
function verifyWebhookSignature({ rawBody, signature, timestamp, maxAgeSeconds = 300 }) {
  const secret = String(process.env.PAIRGATE_WEBHOOK_SECRET || '').trim();
  // No secret configured means verification is not enabled on their side either.
  // The caller decides whether to accept unverified deliveries.
  if (!secret) return { verified: false, configured: false, reason: 'no_secret' };

  const given = String(signature || '').trim();
  const ts = String(timestamp || '').trim();
  if (!rawBody || !given || !ts) return { verified: false, configured: true, reason: 'missing_headers' };

  // Replay guard. Without it a captured delivery can be posted back for as long
  // as the secret lives.
  const sent = Number(ts);
  if (!Number.isFinite(sent)) return { verified: false, configured: true, reason: 'bad_timestamp' };
  const ageSeconds = Math.abs(Date.now() / 1000 - sent);
  if (ageSeconds > maxAgeSeconds) return { verified: false, configured: true, reason: 'stale' };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const computed = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first - that comparison leaks nothing a hex digest does not already fix.
  if (computed.length !== given.length) return { verified: false, configured: true, reason: 'mismatch' };
  const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(given));
  return { verified: ok, configured: true, reason: ok ? 'ok' : 'mismatch' };
}

module.exports = {
  MIN_AMOUNTS,
  TEST_MODE,
  // `transaction/status` can only be asked about PairGate's own reference. A
  // vend whose response never reached us therefore cannot be looked up, which is
  // what the flag tells the reconciler - see billReconcile.helper.
  SUPPORTS_REQUEST_ID_LOOKUP: false,
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
  parseCustomer,
  vendFailure,
  firstErrorMessage,
  shapeProviders,
  flattenPlans,
  networkSlug,
  tvSlug,
  discoSlug,
  DISCO_SLUGS,
  DISCO_DISPLAY,
};
