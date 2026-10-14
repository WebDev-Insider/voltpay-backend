// Payvessel reserved accounts (9PSB) - RETIRED BEFORE IT SHIPPED.
//
// Nothing imports this. It was built as a no-NIN funding route on 2026-10-05
// and dropped: Payvessel's dashboard only accepts a webhook URL on the business
// website's own domain, so credits could not be delivered to the Render
// backend - and a 9PSB account whose credits never arrive must not be handed
// to anyone. Fund Account now offers one account only: PalmPay through
// PaymentPoint.
//
// Kept on disk, as this codebase keeps working integrations, because the
// blocker is a dashboard setting and not the code: with the backend on a
// subdomain of the business website (api.<domain>, a Render custom domain),
// the webhook would be accepted. Reviving it means re-adding a `payvessel`
// rail to funding.controller.js (open, upgrade-with-NIN, and a webhook that
// verifies `verifyWebhookSignature` and reads `parseCredit`), the
// `pvacct_` / `pv_` prefixes in adminOps.controller.js, and the
// PAYVESSEL_BUSINESS_ID / PAYVESSEL_BASIC_DAILY_LIMIT env vars. The contract
// notes below are still accurate.
//
// A third Payvessel product on the same two credentials as the KYC check
// (payvessel.service.js) and the betting rail (payvesselBiller.service.js),
// under a third path family: /pms/api/external/request/customerReservedAccount/.
//
// What it is for: a 9PSB STATIC account opened with NO identity document at
// all. Payvessel caps such an account at a ₦30,000 daily receive limit and lifts
// the cap once the account is updated with the customer's NIN. That trade - a
// funding account in one tap, at a ceiling - is the whole product.
//
// Three properties of the API shape everything below:
//
//   1. The secret goes out as `api-secret: Bearer <secret>` on this path family.
//      The KYC and biller endpoints take the bare secret; the reserved-account
//      docs prefix it. Each service follows its own endpoint's docs.
//   2. Nothing that writes is retried. A repeated create is a second permanent
//      account number for one customer, and the timeout that would trigger the
//      retry says nothing about whether the first one landed.
//   3. A credit arrives by webhook, signed HMAC-SHA512 over the raw body with the
//      same secret. That signature is the only thing that authenticates it.

const crypto = require('crypto');

const { getCreds } = require('./payvessel.service');

const BASE_URL = String(process.env.PAYVESSEL_VAAS_BASE_URL || 'https://api.payvessel.com').replace(/\/+$/, '');
const ACCOUNT_PATH = '/pms/api/external/request/customerReservedAccount/';
const DEFAULT_TIMEOUT_MS = Number(process.env.PAYVESSEL_TIMEOUT_MS || 30_000);

// 9Payment Service Bank, in Payvessel's code list. PalmPay is also on offer
// here (999991), but every Payvessel PalmPay account needs a BVN or NIN up
// front - PalmPay stays on PaymentPoint, and this rail is 9PSB only.
const BANK_CODE_9PSB = '120001';

// Every spelling of "worked" a credit webhook has been documented with.
const CREDIT_EVENTS = new Set(['reserved_account.credit', 'transaction.success', 'transaction.successful']);
const OK_STATUSES = new Set(['success', 'successful', 'completed', 'paid', '00']);

function providerError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getBusinessId() {
  const v = String(process.env.PAYVESSEL_BUSINESS_ID || '').trim();
  if (!v) throw new Error('Missing required env: PAYVESSEL_BUSINESS_ID');
  return v;
}

/**
 * Can this rail open accounts at all? Lets the app hide the 9PSB card rather
 * than offer an option that can only fail.
 */
function isConfigured() {
  return ['PAYVESSEL_API_KEY', 'PAYVESSEL_API_SECRET', 'PAYVESSEL_BUSINESS_ID'].every(name =>
    Boolean(String(process.env[name] || '').trim()),
  );
}

/**
 * The ceiling on an account opened without KYC, in naira.
 *
 * Payvessel's number, not ours - it lives in the environment so the figure the
 * app quotes follows theirs without a release. `Number('')` is 0, and a ₦0
 * limit would tell every user the account is useless, so the empty string is
 * caught before parsing.
 */
function basicDailyLimit() {
  const raw = String(process.env.PAYVESSEL_BASIC_DAILY_LIMIT ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 30_000;
}

/**
 * The most useful line in a Payvessel refusal. A 400 often says only "Invalid
 * payload" and puts the actual reason in `errors` - as a field map on a create,
 * as a list on an update - so that is read too.
 */
function providerMessage(json) {
  const message = String(json?.message ?? '').trim();
  const errors = json?.errors;
  let detail = '';
  if (Array.isArray(errors)) {
    detail = String(errors.find(e => typeof e === 'string' && e.trim()) || '').trim();
  } else if (errors && typeof errors === 'object') {
    const first = Object.values(errors).flat().find(e => typeof e === 'string' && e.trim());
    detail = String(first || '').trim();
  }
  if (detail && (!message || /invalid payload/i.test(message))) return detail;
  return message || detail;
}

async function request(path, { method, body }) {
  const { apiKey, apiSecret } = getCreds();
  const secret = /^bearer\s/i.test(apiSecret) ? apiSecret : `Bearer ${apiSecret}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'api-key': apiKey,
        'api-secret': secret,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // Either way the outcome at Payvessel is unknown, which is why the caller
    // never repeats the request on its own.
    throw providerError(e?.name === 'AbortError' ? 'Payvessel did not answer in time' : 'Could not reach Payvessel', 504);
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

  // Our prepaid business wallet, not the customer's problem.
  if (response.status === 402) throw providerError('Account opening is temporarily unavailable', 503);

  if (!response.ok) {
    throw providerError(providerMessage(json) || `Payvessel request failed (${response.status})`, response.status);
  }

  // A 200 with `status: false` is still a refusal.
  if (!json || json.status === false) {
    throw providerError(providerMessage(json) || 'Payvessel declined the request', json ? 400 : 502);
  }

  return json;
}

/**
 * The accounts in a create response, as one shape.
 *
 * `banks` is documented both ways - an array in the schema, a single object in
 * the prose examples - and both have been seen, so both are accepted.
 */
function normalizeBanks(json) {
  const raw = json?.banks;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list
    .map(b => ({
      bankCode: String(b?.bankCode ?? b?.bank_code ?? '').trim(),
      bankName: String(b?.bankName ?? b?.bank_name ?? '').trim(),
      accountNumber: String(b?.accountNumber ?? b?.account_number ?? '').trim(),
      accountName: String(b?.accountName ?? b?.account_name ?? '').trim(),
      trackingReference: String(b?.trackingReference ?? b?.tracking_reference ?? '').trim(),
    }))
    .filter(b => /^\d{6,20}$/.test(b.accountNumber));
}

/**
 * POST customerReservedAccount/ - a 9PSB STATIC account with no BVN and no NIN.
 *
 * Exactly the fields Payvessel needs for that and nothing more. No identity
 * number goes out on this call: the account opens at the capped tier, and a NIN
 * is only ever attached later, by upgradeAccountWithNin, when the customer asks.
 *
 * @returns {Promise<{account: {bankCode, bankName, accountNumber, accountName, trackingReference}}>}
 */
async function createStaticAccount({ email, name, phoneNumber }) {
  if (!email) throw new Error('email is required');
  if (!name) throw new Error('name is required');
  if (!phoneNumber) throw new Error('phoneNumber is required');

  const json = await request(ACCOUNT_PATH, {
    method: 'POST',
    body: {
      email: String(email),
      name: String(name),
      phoneNumber: String(phoneNumber),
      bankcode: [BANK_CODE_9PSB],
      account_type: 'STATIC',
      businessid: getBusinessId(),
    },
  });

  const banks = normalizeBanks(json);
  const account =
    banks.find(b => b.bankCode === BANK_CODE_9PSB) ||
    banks.find(b => /9\s*payment|9psb/i.test(b.bankName)) ||
    banks[0];
  if (!account) throw providerError('Payvessel did not return an account number', 502);

  return { account };
}

/**
 * PUT customerReservedAccount/{account_number}/ - attach the customer's NIN to a
 * 9PSB account opened without KYC, which removes the daily receive cap.
 *
 * Same account number afterwards: nothing the customer has saved changes. An
 * `errors` list on a 200 is read as a refusal, because a cap we cannot confirm
 * is lifted must not be shown to the customer as lifted.
 */
async function upgradeAccountWithNin({ accountNumber, nin }) {
  const number = String(accountNumber ?? '').trim();
  // Interpolated into the path, so it is digits or nothing.
  if (!/^\d{6,20}$/.test(number)) throw new Error('accountNumber must be digits');
  if (!/^\d{11}$/.test(String(nin ?? ''))) throw new Error('nin must be 11 digits');

  const json = await request(`${ACCOUNT_PATH}${number}/`, { method: 'PUT', body: { nin: String(nin) } });

  if (Array.isArray(json?.errors) && json.errors.length) {
    throw providerError(providerMessage(json) || 'Payvessel could not upgrade the account', 400);
  }
  return { upgraded: true };
}

function webhookSecret() {
  const raw = String(process.env.PAYVESSEL_WEBHOOK_SECRET || process.env.PAYVESSEL_API_SECRET || '').trim();
  return raw.replace(/^bearer\s+/i, '');
}

/**
 * HMAC-SHA512 of the raw request body, hex, keyed with the Payvessel secret.
 * Constant-time compare - Payvessel's own samples use `==`, which leaks.
 */
function verifyWebhookSignature({ rawBody, signature }) {
  const secret = webhookSecret();
  if (!secret || !rawBody || !signature) return false;

  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const provided = String(signature).trim().replace(/^sha512=/i, '').toLowerCase();

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Payvessel publishes the addresses it calls from. Opt-in, because the address
 * the app sees depends on the proxies in front of it: checked against `req.ip`
 * (which honours `trust proxy`), never a raw X-Forwarded-For, whose left-most
 * entry the caller writes. Unset means the signature alone decides.
 */
function webhookIpAllowed(ip) {
  const raw = String(process.env.PAYVESSEL_WEBHOOK_IPS ?? '').trim();
  if (!raw) return true;
  const allowed = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  return allowed.has(String(ip || '').trim().replace(/^::ffff:/, ''));
}

function firstText(candidates) {
  for (const c of candidates) {
    const v = String(c ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** "1,500.5" -> "1500.50"; null for anything that is not money. */
function moneyText(value, { allowZero = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return null;
  return n.toFixed(2);
}

/**
 * Read a credit webhook into the handful of facts a wallet credit needs.
 *
 * Field paths are the documented ones (`order.*`, `transaction.reference`,
 * `virtualAccount.virtualAccountNumber`), with the spellings other Payvessel
 * payloads have used as fallbacks. Returns `{ ok: false, reason }` for anything
 * that is not a completed incoming transfer - a debit, a reversal, a pending
 * notice - so the caller acknowledges it and moves on.
 *
 * The credit is what actually settles to us after Payvessel's fee - the same
 * rule the PaymentPoint path follows - and every fallback leans the way that
 * cannot over-credit:
 *
 *   settlement given        credit it (or the gross, if that is somehow smaller)
 *   no settlement, a fee    credit gross - fee
 *   neither                 credit the gross
 *
 * The fee recorded is then gross - credit, so a ledger row always satisfies
 * amount + charge = total_amount, which is what the integrity screen assumes.
 */
function parseCredit(body) {
  const root = body && typeof body === 'object' ? body : {};
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;

  const event = String(root.event || data.event || '').trim().toLowerCase();
  if (event && !CREDIT_EVENTS.has(event)) return { ok: false, reason: 'not_a_credit_event' };

  for (const status of [data?.transaction?.status, data?.order?.status, data?.status]) {
    if (status === false) return { ok: false, reason: 'not_successful' };
    if (typeof status === 'string' && status.trim() && !OK_STATUSES.has(status.trim().toLowerCase())) {
      return { ok: false, reason: 'not_successful' };
    }
  }

  const accountNumber = firstText([
    data?.virtualAccount?.virtualAccountNumber,
    data?.virtualAccount?.accountNumber,
    data?.virtualAccount?.account_number,
    data?.virtual_account?.account_number,
    data?.virtualAccountNumber,
    data?.accountNumber,
  ]);
  const reference = firstText([
    data?.transaction?.reference,
    data?.transaction?.sessionid,
    data?.transaction?.session_id,
    data?.reference,
  ]);
  const gross = moneyText(data?.order?.amount ?? data?.transaction?.amount ?? data?.amount);
  const settlement = moneyText(data?.order?.settlement_amount ?? data?.settlement_amount);
  const fee = moneyText(data?.order?.fee ?? data?.fee, { allowZero: true });
  const currency = String(data?.order?.currency || data?.currency || 'NGN').trim().toUpperCase();

  if (!/^\d{6,20}$/.test(accountNumber) || !reference || !(gross || settlement)) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (currency !== 'NGN') return { ok: false, reason: 'not_ngn' };

  let credit;
  if (settlement) credit = gross && Number(gross) < Number(settlement) ? gross : settlement;
  else if (fee && Number(fee) > 0) credit = moneyText(Number(gross) - Number(fee));
  else credit = gross;
  // A fee at or above the whole transfer leaves nothing that could be credited.
  if (!credit) return { ok: false, reason: 'nothing_to_credit' };

  const total = gross || credit;

  return {
    ok: true,
    event: event || null,
    reference: reference.slice(0, 120),
    accountNumber,
    grossAmount: total,
    settlementAmount: settlement,
    creditAmount: credit,
    feeAmount: (Number(total) - Number(credit)).toFixed(2),
    senderBank: firstText([data?.sender?.senderBankName, data?.sender?.bankName, data?.sender?.bank_name]) || null,
    paidAt: firstText([data?.transaction?.date, data?.transaction?.paid_at]) || null,
  };
}

module.exports = {
  BANK_CODE_9PSB,
  isConfigured,
  basicDailyLimit,
  createStaticAccount,
  upgradeAccountWithNin,
  verifyWebhookSignature,
  webhookIpAllowed,
  parseCredit,
  __test: { normalizeBanks, providerMessage, moneyText },
};
