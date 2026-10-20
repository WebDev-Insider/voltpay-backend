// CashBuddy bills provider: airtime only.
//
// CashBuddy's partner API (v3.0) sells airtime, data, cable TV and electricity
// through one call, POST /bills - but it publishes no data-plan list, no bouquet
// list, no smartcard lookup and no meter lookup. That was checked against the
// live API on 2026-10-19: every such path answers "Endpoint not found", and
// anything under /bills/<x> is read as a transaction lookup. Without a list a
// bundle cannot be priced on our side, and without a lookup the confirm sheet
// cannot show whose meter or decoder is being paid. So this adapter sells
// AIRTIME ONLY - the owner's call - and billsProvider routes nothing else here.
// When CashBuddy publishes those endpoints, another rail is an adapter function
// here plus one line in billsProvider's ALLOWED.
//
// Same contract as mysubwallet.service.js: this file owns the transport, the
// provider identifiers and the error shape, and nothing else.
//
// Auth is one header, `X-API-Key: cb_live_...` (their docs also accept it as a
// Bearer token).
//
// Five things about this API shape everything below:
//
//   1. **Every purchase names the CashBuddy account that pays.** Their bills
//      endpoint debits a CashBuddy user's NGN wallet, named by user_id, email or
//      phone in the body. For us that is VoltPay's own CashBuddy account - the
//      float - from CASHBUDDY_USER_ID (or _EMAIL / _PHONE). Never a VoltPay
//      customer: they have no CashBuddy wallet, and their details are not
//      CashBuddy's to hold.
//   2. **No reference of ours goes on the wire.** The purchase has no
//      request-id or idempotency field, and the status lookup takes only their
//      reference. So a purchase whose answer never reached us cannot be asked
//      about by our trx - and it is not refunded on the spot either, because it
//      may have been delivered. It comes back `unconfirmed`, and
//      billReconcile looks for it in the account's own bill history
//      (listRecentOrders) by what it was: amount, recipient, time. Found, it
//      settles like any other; still absent after repeated complete looks and
//      half an hour, it is refunded.
//   3. **The HTTP status is not the outcome.** On the live API a missing field
//      answered HTTP 500 ("User identifier (user_id, email, or phone) is
//      required"), and a bad key answers `{"error":"Unauthorized. Missing API
//      key."}` - not the `{ success, error: CODE, message }` envelope their docs
//      describe. Everything is read by its words, with the status as a hint.
//   4. **Bills are fulfilled by VTPass behind them**, and the reference a
//      purchase returns is VTPass's - which is also what their lookup takes.
//   5. **There is no balance endpoint for the wallet bills are paid from.**
//      /settlement/balance is a different pot (virtual-account collections and
//      KYC fees), so the float screen says the number is not published rather
//      than showing the wrong one.
const { withRetry, causeCode } = require('../helpers/retry.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');

const BASE_URL = String(
  process.env.CASHBUDDY_BASE_URL || 'https://kfxncgvpzwpucjaqlief.supabase.co/functions/v1/partner-api'
).replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CASHBUDDY_TIMEOUT_MS || 30_000);

// The rails this adapter implements. billsProvider routes nothing else here.
const SERVICES = ['airtime'];

// CashBuddy's own app refuses airtime under ₦50. VoltPay's floor is higher, and
// bills.controller takes the stricter of the two.
const MIN_AMOUNTS = { airtime: 50 };

// How far the history lookup reads: pages of this size, at most this many.
const HISTORY_PAGE_SIZE = Number(process.env.CASHBUDDY_HISTORY_PAGE_SIZE || 50);
const HISTORY_MAX_PAGES = Number(process.env.CASHBUDDY_HISTORY_MAX_PAGES || 4);

/* --------------------------------------------------------------- credentials */

function apiKey() {
  return String(process.env.CASHBUDDY_API_KEY || '').trim();
}

// VoltPay's own CashBuddy account - the one whose wallet pays for every bill.
function payer() {
  const userId = String(process.env.CASHBUDDY_USER_ID || '').trim();
  if (userId) return { user_id: userId };
  const email = String(process.env.CASHBUDDY_USER_EMAIL || '').trim();
  if (email) return { email };
  const phone = String(process.env.CASHBUDDY_USER_PHONE || '').trim();
  if (phone) return { phone };
  return null;
}

// Env var names only - never a value.
function configStatus() {
  const missing = [];
  if (!apiKey()) missing.push('CASHBUDDY_API_KEY');
  if (!payer()) missing.push('CASHBUDDY_USER_ID');
  return { configured: missing.length === 0, missing, problems: [] };
}

function isConfigured() {
  return configStatus().configured;
}

/* -------------------------------------------------------------------- errors */

const UNAVAILABLE = 'This service is briefly unavailable. Please try again shortly.';
const GENERIC = 'We could not complete this request. Please try again.';
const PHONE_MESSAGE = 'That phone number was not accepted for this network. Check the number and the network.';

/**
 * An error a controller can hand straight to a customer - the same shape as the
 * other adapters'. `message` is always ours, their text rides on
 * `providerMessage`, the flags say what kind of failure it was, and the trimmed
 * body is on `cashbuddy`, named for the provider so a log line says who spoke.
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
  err.cashbuddy = payload;
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

// Our float - the paying account's wallet - never the customer's.
function isFloatError(text) {
  return /insufficient[\s_]+(wallet[\s_]+|settlement[\s_]+)?(balance|fund)|low[\s_]+balance/i.test(String(text || ''));
}

// Our key.
function isCredentialError(text) {
  return /unauthori[sz]ed|api\s*key|forbidden|lacks\s+permission|not\s+permitted/i.test(String(text || ''));
}

// Our paying account: missing from the request, or unknown to them.
function isPayerError(text) {
  return /user\s+identifier|user\s+profile|profile\s+not\s+found|user\s+not\s+found/i.test(String(text || ''));
}

// Wording that says the request was refused as written - nothing was bought.
// Kept narrow on purpose: "invalid response from provider" is NOT in it, since
// that is a purchase whose answer was lost, not one that was refused.
const VALIDATION = /is\s+required|are\s+required|must\s+be|invalid\s+(phone|number|amount|provider|network|service|request|parameter|field|recipient)|not\s+supported|unsupported/i;

const AMOUNT_LIMIT = /minimum|maximum|at\s+least|not\s+be\s+greater|greater\s+than|less\s+than|exceed/i;

/** Turn their refusal into an error with a customer-safe message. */
function declined(rawMessage, { statusCode = 400, payload = null } = {}) {
  const raw = String(rawMessage || '').trim();
  const base = { payload, providerMessage: raw };

  if (isFloatError(raw)) return outage(raw, { floatExhausted: true, payload });
  if (isCredentialError(raw) || isPayerError(raw)) return outage(raw, { misconfigured: true, payload });
  // One of OUR identifiers - a network slug or service type from this file.
  if (/provider|network|service[\s_]*type/i.test(raw) && /invalid|unknown|unsupported|not\s+supported/i.test(raw)) {
    return outage(raw, { misconfigured: true, payload });
  }
  if (/amount|₦|naira|ngn/i.test(raw) && AMOUNT_LIMIT.test(raw)) {
    return providerError(raw.slice(0, 160), { ...base, statusCode, kind: 'limit' });
  }
  if (/phone|number|recipient|msisdn/i.test(raw)) return providerError(PHONE_MESSAGE, { ...base, statusCode, kind: 'input' });
  if (/unavailable|maintenance|try\s+again\s+later|temporarily|disabled/i.test(raw)) {
    return providerError('This service is temporarily unavailable. Please try again later.', { ...base, statusCode, kind: 'unavailable' });
  }
  return providerError(GENERIC, { ...base, statusCode, kind: 'unknown' });
}

function reworded(e, { fallback } = {}) {
  if (e?.kind === 'unknown' && fallback) e.message = fallback;
  return e;
}

/* ------------------------------------------------------------ status reading */

const SUCCESS_WORDS = new Set(['success', 'successful', 'delivered', 'completed']);
const PENDING_WORDS = new Set(['pending', 'processing', 'initiated', 'queued', 'in_progress']);
const FAILURE_WORDS = new Set(['fail', 'failed', 'failure', 'error', 'declined', 'reversed', 'refunded', 'cancelled', 'canceled']);

/**
 * 'success' | 'pending' | 'fail' | '' for any status they send. A purchase
 * answers "delivered", their records say "completed".
 *
 * Strict on purpose: an unrecognised word is '' and never defaults to success.
 */
function outcomeOf(status) {
  const word = String(status ?? '').trim().toLowerCase();
  if (SUCCESS_WORDS.has(word)) return 'success';
  if (PENDING_WORDS.has(word)) return 'pending';
  if (FAILURE_WORDS.has(word)) return 'fail';
  return '';
}

// The same, in the words billSettlement understands.
function settlementStatus(status) {
  const outcome = outcomeOf(status);
  return outcome === 'success' ? 'successful' : outcome === 'fail' ? 'failed' : outcome === 'pending' ? 'processing' : '';
}

// What their body says, whichever key it said it under.
function wordsOf(json) {
  if (!json || typeof json !== 'object') return '';
  return [json.error, json.message]
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .join(' - ');
}

// Status and message only. A transaction body names the recipient's number,
// and an error payload can travel as far as the app.
function trimmedPayload(json) {
  if (!json || typeof json !== 'object') return null;
  return { status: json.status ?? (json.success === false ? 'fail' : null), message: wordsOf(json) || null };
}

function toAmount(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function retryAfterFrom(res) {
  const header = Number(res?.headers?.get?.('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.round(header * 1000) + 250 : null;
}

/* ----------------------------------------------------------------- transport */

/**
 * One request. `retry` defaults to false and only reads ask for it - a
 * purchase is never repeated: with no reference of ours on it, a second POST is
 * simply a second purchase.
 */
async function cbRequest(method, path, { query, body, retry = false } = {}) {
  const once = () => cbRequestOnce(method, path, { query, body });
  if (!retry) return once();
  return withRetry(once, { label: `cashbuddy ${path}` });
}

async function cbRequestOnce(method, path, { query, body } = {}) {
  const key = apiKey();
  if (!key) throw outage('Missing required env: CASHBUDDY_API_KEY', { misconfigured: true });

  let url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v) !== '') qs.append(k, String(v));
    }
    const encoded = qs.toString();
    if (encoded) url += `?${encoded}`;
  }

  const headers = { 'X-API-Key': key, Accept: 'application/json', 'Cache-Control': 'no-cache' };
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
    // Ambiguous by definition: a purchase cut off mid-flight may have been
    // processed at the far end.
    const code = causeCode(e);
    const reason =
      e?.name === 'AbortError'
        ? `CashBuddy request timed out after ${TIMEOUT_MS}ms`
        : `CashBuddy request failed: ${e?.message || e}${code ? ` (${code})` : ''}`;
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
  const status = res.status;

  // Not JSON: a gateway in front of them, or a function that crashed. Never a
  // purchase result - and not proof that nothing happened either.
  if (!json || typeof json !== 'object') {
    throw providerError(UNAVAILABLE, {
      statusCode: 502,
      ambiguous: true,
      kind: 'outage',
      providerMessage: `CashBuddy returned a non-JSON response (HTTP ${status})`,
      httpStatus: status,
    });
  }

  const said = wordsOf(json);
  const trimmed = trimmedPayload(json);

  // Refused before anything ran: our key, or their limiter.
  if (status === 401 || status === 403) {
    throw outage(said || `HTTP ${status}`, { misconfigured: true, payload: trimmed, httpStatus: status });
  }
  if (status === 429) {
    throw providerError(UNAVAILABLE, {
      statusCode: 429,
      kind: 'outage',
      payload: trimmed,
      providerMessage: said || 'Too many requests',
      retryAfterMs: retryAfterFrom(res),
      httpStatus: status,
    });
  }

  if (status === 404) {
    // "Bill transaction not found." is an answer about a reference, not an
    // outage. Anything else at 404 - a route, or our paying account - is ours.
    if (/transaction\s+not\s+found/i.test(said)) {
      throw providerError('Transaction not found', { statusCode: 404, notFound: true, payload: trimmed, providerMessage: said, httpStatus: status });
    }
    throw outage(said || 'HTTP 404', { misconfigured: true, payload: trimmed, httpStatus: status });
  }

  if (status >= 500) {
    // Their server failed. A refusal of the request as written - a missing
    // field came back 500 on the live API - bought nothing; anything else may
    // have reached VTPass and is unknown.
    if (VALIDATION.test(said) || isPayerError(said) || isFloatError(said)) {
      throw declined(said, { statusCode: 400, payload: trimmed });
    }
    throw providerError(UNAVAILABLE, {
      statusCode: 502,
      ambiguous: true,
      kind: 'outage',
      payload: trimmed,
      providerMessage: said || `HTTP ${status}`,
      httpStatus: status,
    });
  }

  if (status >= 400 || json.success === false) {
    const err = declined(said || String(json.status || ''), { statusCode: status >= 400 ? status : 400, payload: trimmed });
    err.httpStatus = status;
    throw err;
  }

  return json;
}

/* ------------------------------------------------- provider identity mapping */

function normKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Their provider keys for the four networks, in the order MySubWallet lists
// them so a switch does not reshuffle the app's picker.
const NETWORKS = [
  { slug: 'mtn', name: 'MTN' },
  { slug: 'airtel', name: 'AIRTEL' },
  { slug: 'glo', name: 'GLO' },
  { slug: '9mobile', name: '9MOBILE' },
];

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

function networkSlug(value) {
  const name = NETWORK_ALIASES[normKey(value)] || '';
  return NETWORKS.find(n => n.name === name)?.slug || '';
}

// Their records name the service in their own words.
function serviceOf(serviceType) {
  const word = String(serviceType || '').trim().toLowerCase();
  if (word === 'cable') return 'tv';
  return ['airtime', 'data', 'tv', 'electricity'].includes(word) ? word : '';
}

// The 11-digit local form (0803...), which is what their own app asks for.
function providerPhone(number) {
  const phone = normalizeNgPhone(number);
  if (!phone) throw providerError('Enter a valid Nigerian phone number', { statusCode: 400, kind: 'input' });
  return phone.local;
}

/* ----------------------------------------------------------------- vending */

/**
 * Send one purchase.
 *
 * A clear refusal throws and the caller refunds. A clear acceptance returns.
 * An answer that does not say what happened returns `unconfirmed` instead of
 * throwing: refunding it could pay for a bill that was delivered, and there is
 * no reference of ours to ask about it with. billReconcile finishes it.
 */
async function vend(body, wording = {}, { reference = '' } = {}) {
  let json;
  try {
    json = await cbRequest('POST', '/bills', { body });
  } catch (e) {
    if (!e?.ambiguous) throw reworded(e, wording);
    // Ids only - the request body names the recipient's number.
    console.warn('cashbuddy: purchase outcome unknown, recorded as unconfirmed', {
      reference,
      reason: String(e?.providerMessage || e?.message || '').slice(0, 120),
    });
    return { unconfirmed: true, status: 'pending' };
  }

  const outcome = outcomeOf(json.status);
  if (outcome === 'fail') {
    throw reworded(declined(wordsOf(json) || String(json.status), { payload: trimmedPayload(json) }), wording);
  }
  if (outcome === 'success' || outcome === 'pending') return json;

  // Accepted, in a word we do not know. With their reference the order exists
  // and can be asked about like any other; without one it is the same unknown
  // as a lost answer.
  if (theirReference(json)) return { ...json, status: 'pending' };
  console.warn('cashbuddy: purchase answered without a reference, recorded as unconfirmed', { reference });
  return { unconfirmed: true, status: 'pending' };
}

function theirReference(json) {
  return String(json?.reference || json?.vtpass_reference || json?.id || '').trim();
}

/**
 * One shape for every purchase response, matching the other adapters'.
 *
 * `unconfirmed` is the one field only this adapter sets: the purchase may or
 * may not exist, and there is no reference to ask about it by.
 */
function parseVendResult(json) {
  const data = json && typeof json === 'object' ? json : {};
  return {
    reference: theirReference(data),
    order_no: String(data.id || '').trim(),
    status: outcomeOf(data.status) === 'success' ? 'successful' : 'processing',
    unconfirmed: data.unconfirmed === true,
    token: '',
    units: '',
    message: String(data.message || '').trim(),
    amount: toAmount(data.amount),
    plan: '',
    test_mode: false,
  };
}

/* ------------------------------------------------------------------ airtime */

async function listAirtimeProvidersCached() {
  return NETWORKS.map(n => ({ name: n.name, code: n.slug, full_name: n.name, id: n.slug }));
}

async function buyAirtime({ provider, number, amount, reference }) {
  const network = networkSlug(provider);
  if (!network) throw providerError('Unknown network', { statusCode: 400, kind: 'input' });

  const naira = Number(amount);
  if (!Number.isInteger(naira) || naira <= 0) throw providerError('Enter a whole naira amount', { statusCode: 400, kind: 'input' });

  const who = payer();
  if (!who) throw outage('Missing required env: CASHBUDDY_USER_ID', { misconfigured: true });

  return vend(
    { service_type: 'airtime', provider: network, amount: naira, phone_number: providerPhone(number), ...who },
    { fallback: 'Airtime purchase failed. Please try again.' },
    { reference }
  );
}

/* ------------------------------------------------------------ reconciliation */

/**
 * The reconciliation read, by THEIR reference - the only key it takes.
 *
 * `status` is one of billSettlement's words, or 'not_found', which nothing
 * settles on: their lookup is scoped to the key that asks, so a rotated key
 * reads every live order as missing.
 */
async function getTransactionStatus(reference) {
  const ref = String(reference || '').trim();
  if (!ref) throw providerError('reference is required', { statusCode: 400 });

  let json;
  try {
    json = await cbRequest('GET', `/bills/${encodeURIComponent(ref)}`, { retry: true });
  } catch (e) {
    if (e?.notFound) {
      return { reference_code: ref, request_id: '', type: '', status: 'not_found', amount: 0, token: '', units: '', remark: '', created_at: '' };
    }
    throw e;
  }

  const t = json?.transaction && typeof json.transaction === 'object' ? json.transaction : {};
  return {
    reference_code: String(t.vtpass_reference || ref).trim(),
    request_id: '',
    type: serviceOf(t.service_type),
    status: settlementStatus(t.status),
    amount: toAmount(t.amount),
    token: String(t.token || '').trim(),
    units: '',
    remark: '',
    created_at: String(t.created_at || ''),
  };
}

/** One history row, in the words billReconcile matches on. */
function normalizeOrder(row) {
  if (!row || typeof row !== 'object') return null;
  const created = Date.parse(row.created_at);
  return {
    reference: String(row.vtpass_reference || row.reference || row.id || '').trim(),
    service: serviceOf(row.service_type),
    amount: toAmount(row.amount),
    // A phone, a meter or a smartcard - personal data, held for the match and
    // never logged. billReconcile compares it through a blind index.
    recipient: String(row.phone_number || row.meter_number || row.smart_card_number || '').trim(),
    status: settlementStatus(row.status),
    token: String(row.token || '').trim(),
    created_ms: Number.isFinite(created) ? created : NaN,
  };
}

function rowsOf(json) {
  return Array.isArray(json?.transactions) ? json.transactions : [];
}

/**
 * The paying account's bills since `since`, for finding a purchase whose answer
 * was lost.
 *
 * `complete` says whether every bill created since then was read. Only a
 * complete read that finds nothing counts as evidence of absence; a partial one
 * - too much traffic to page through - proves nothing, and billReconcile does
 * not count it towards a refund.
 *
 * Their docs do not say which way the history is sorted, so both are handled:
 * newest-first is paged forward until it passes `since`; oldest-first is read
 * from the last page backwards.
 */
async function listRecentOrders({ since, pageSize = HISTORY_PAGE_SIZE, maxPages = HISTORY_MAX_PAGES } = {}) {
  const who = payer();
  if (!who) throw outage('Missing required env: CASHBUDDY_USER_ID', { misconfigured: true });

  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) throw providerError('since is required', { statusCode: 400 });

  const fetchPage = page => cbRequest('GET', '/bills', { query: { ...who, page, limit: pageSize }, retry: true });
  const reachedSince = list => list.some(o => Number.isFinite(o.created_ms) && o.created_ms <= sinceMs);

  const first = await fetchPage(1);
  const firstRows = rowsOf(first);
  let orders = firstRows.map(normalizeOrder).filter(Boolean);

  const total = Number(first?.pagination?.total);
  const lastPage = Number.isFinite(total) && total > 0 ? Math.ceil(total / pageSize) : null;
  if (firstRows.length < pageSize || lastPage === 1) return { orders, complete: true };

  const times = orders.map(o => o.created_ms).filter(Number.isFinite);
  const newestFirst = times.length < 2 || times[0] >= times[times.length - 1];

  if (newestFirst) {
    let page = 1;
    let rows = firstRows;
    let done = reachedSince(orders);
    while (!done && rows.length === pageSize && page < maxPages) {
      page += 1;
      rows = rowsOf(await fetchPage(page));
      const more = rows.map(normalizeOrder).filter(Boolean);
      orders = orders.concat(more);
      done = reachedSince(more) || rows.length < pageSize;
    }
    return { orders, complete: done };
  }

  // Oldest first: the recent bills are on the last pages.
  if (!lastPage) return { orders, complete: false };
  let page = lastPage;
  let read = 1;
  let done = false;
  while (!done && page > 1 && read < maxPages) {
    const more = rowsOf(await fetchPage(page)).map(normalizeOrder).filter(Boolean);
    orders = orders.concat(more);
    read += 1;
    done = reachedSince(more);
    page -= 1;
  }
  // Walked all the way back to page 1, which was read first.
  return { orders, complete: done || page <= 1 };
}

/* ------------------------------------------------------------------- account */

/**
 * Do they accept our key AND know the paying account? One authenticated read.
 *
 * billsProvider asks before letting an admin switch a rail here. The bill
 * history is read because it checks both at once: a bad key answers 401, an
 * unknown CASHBUDDY_USER_ID is refused as a missing profile - either of which
 * would fail every purchase. The single row it may return names a recipient,
 * so it is dropped unread.
 */
async function verifyCredentials() {
  const who = payer();
  if (!who) throw outage('Missing required env: CASHBUDDY_USER_ID', { misconfigured: true });
  await cbRequest('GET', '/bills', { query: { ...who, page: 1, limit: 1 } });
  return { ok: true };
}

// What a superadmin checks when the read above is refused.
const CREDENTIAL_HINT = 'Check CASHBUDDY_API_KEY, and that CASHBUDDY_USER_ID names VoltPay’s own CashBuddy account.';

// There is no balance for the wallet bills draw on - see the header. Never
// called by the float screen, which reads FLOAT_READABLE first; it exists so
// the adapter surface is complete and an accidental call says why.
async function getWalletBalance() {
  throw providerError('CashBuddy does not publish the balance of the wallet bills are paid from', {
    statusCode: 501,
    kind: 'unavailable',
  });
}

function getFundingAccount() {
  return {
    bank_name: String(process.env.CASHBUDDY_FUNDING_BANK || '').trim(),
    account_number: String(process.env.CASHBUDDY_FUNDING_ACCOUNT_NUMBER || '').trim(),
    account_name: String(process.env.CASHBUDDY_FUNDING_ACCOUNT_NAME || '').trim(),
  };
}

function floatThresholds() {
  const critical = Number(process.env.CASHBUDDY_FLOAT_CRITICAL_NGN || 5_000);
  const low = Number(process.env.CASHBUDDY_FLOAT_LOW_NGN || 25_000);
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

// No catalogues to warm: airtime networks are a fixed table.
async function warmCatalogues() {
  return { loaded: 0, failed: 0, calls: 0, skipped: 'no_catalogue' };
}

module.exports = {
  SERVICES,
  MIN_AMOUNTS,
  // Their lookup takes only their own reference. A purchase whose answer was
  // lost is found through listRecentOrders instead - see billReconcile.helper.
  SUPPORTS_REQUEST_ID_LOOKUP: false,
  // See the header: no balance endpoint for the bills wallet.
  FLOAT_READABLE: false,
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
  listRecentOrders,
  // airtime
  listAirtimeProvidersCached,
  buyAirtime,
  // shared
  parseVendResult,
  isFloatError,
  warmCatalogues,
  // exported for tests
  __test: { outcomeOf, declined, networkSlug, normalizeOrder, serviceOf, UNAVAILABLE },
};
