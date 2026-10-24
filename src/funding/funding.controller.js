const crypto = require('crypto');

const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const paymentpoint = require('./paymentpoint.service');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { revealUserFields, reveal, blindIndex, protectText, revealText } = require('../helpers/pii.helper');
const { isDeleted } = require('../helpers/accountStatus.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { notifyUser } = require('../services/notify.service');
const { securityEvent, paymentFailure } = require('../services/alerts.service');
const cache = require('../services/cache.service');
const redis = require('../services/redis.service');

const reconcileLocks = new Map();

function toMoneyString(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL;
  if (configured) return String(configured).trim().replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function txRefFor(userId) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `fund_${userId}_${Date.now()}_${rand}`;
}

function computeFundingFee(amountNaira) {
  const amt = Number(amountNaira);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (amt >= 100 && amt <= 1000) return 10;
  if (amt > 1000 && amt <= 20000) return 30;
  if (amt > 20000) return 50;
  return 0;
}

// One user, one account. Only the first configured bank code is used - asking
// PaymentPoint for more than one code returns one virtual account per bank.
function parsePaymentPointBankCodes() {
  const raw = (process.env.PAYMENTPOINT_BANK_CODES || '').trim();
  if (!raw) return ['20946'];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 1);
}

/** Older rows can hold two accounts. The user is only ever shown one. */
function onlyOneAccount(bankAccounts) {
  return Array.isArray(bankAccounts) ? bankAccounts.slice(0, 1) : [];
}

function getPaymentPointBusinessId() {
  const v = (process.env.PAYMENTPOINT_BUSINESS_ID || '').trim();
  if (!v) throw new Error('Missing required env: PAYMENTPOINT_BUSINESS_ID');
  return v;
}

function buildCustomerName(user) {
  const pii = revealUserFields(user);
  const first = String(pii.firstname || '').trim();
  const last = String(pii.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || `User ${user?.id || ''}`.trim();
}

// 0XXXXXXXXXX - the local form PaymentPoint takes.
function localPhoneNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11) return digits;
  if (digits.length === 10) return `0${digits}`;
  if (digits.startsWith('234') && digits.length === 13) return `0${digits.slice(3)}`;
  if (digits.startsWith('2340') && digits.length === 14) return digits.slice(3);
  const last11 = digits.slice(-11);
  if (last11.length === 11 && last11.startsWith('0')) return last11;
  return null;
}

function normalizeAmountToDecimal(amount) {
  const cleaned = String(amount ?? '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Prisma.Decimal(n.toFixed(2));
}

// Any of these makes a webhook a payment, whatever its amount. An account
// event is read only from a body with none of them: a payment's envelope can
// carry the SENDER's account number, and showing that as the customer's own
// would send their transfers to a stranger.
const PAYMENT_KEYS = [
  'amount',
  'amount_paid',
  'amountPaid',
  'settlement_amount',
  'settlementAmount',
  'transaction_amount',
  'transactionAmount',
  'transaction_id',
  'transactionId',
  'transaction',
  'transaction_status',
  'sender',
];

function looksLikePayment(body) {
  return Boolean(body) && typeof body === 'object' && PAYMENT_KEYS.some(k => body[k] != null);
}

/** What the sender paid, or null. */
function grossAmountOf(payload) {
  return normalizeAmountToDecimal(
    payload?.amount_paid ??
      payload?.amountPaid ??
      payload?.amount ??
      payload?.transaction_amount ??
      payload?.transactionAmount ??
      payload?.transaction?.amount ??
      payload?.transaction?.transaction_amount
  );
}

/**
 * Who sent the money. PaymentPoint has moved this field around between
 * payload versions, so try the shapes we have actually seen before falling
 * back to something that still reads like a sentence.
 */
function extractSenderName(payload) {
  const candidates = [
    payload?.sender?.name,
    payload?.sender?.account_name,
    payload?.sender_name,
    payload?.senderName,
    payload?.payer_name,
    payload?.payerName,
    payload?.originator_name,
    payload?.account_name,
    payload?.transaction?.sender?.name,
  ];
  for (const c of candidates) {
    const v = String(c ?? '').trim();
    if (v) return v.replace(/\s+/g, ' ').slice(0, 80);
  }
  return 'Someone';
}

/** ₦5,000.00 - what the banner shows. */
function formatNaira(amount) {
  const n = Number(String(amount ?? '0'));
  if (!Number.isFinite(n)) return '₦0.00';
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isSuccessfulPaymentPointPayload(payload) {
  const txStatus = String(payload?.transaction_status || payload?.transactionStatus || payload?.status || '').toLowerCase();
  const notif = String(payload?.notification_status || payload?.notificationStatus || '').toLowerCase();
  const event = String(payload?.event || payload?.event_type || payload?.type || payload?.notificationType || '').toLowerCase();
  return (
    txStatus === 'success' ||
    txStatus === 'successful' ||
    notif === 'payment_successful' ||
    event === 'payment_successful' ||
    event === 'transfer_successful'
  );
}

async function initiate(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    return virtualAccount(req, res);
  } catch (e) {
    console.error('Funding initiate error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to initiate funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

function cleanNin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

// ---------------------------------------------------------------------------
// Virtual accounts - PalmPay through PaymentPoint
// ---------------------------------------------------------------------------
//
// One funding account per user: a PalmPay account through PaymentPoint, opened
// with the user's own NIN. (No-NIN providers were tried and dropped in October
// 2026. The 9PSB/Payvessel client is still on disk, marked RETIRED, because
// its only blocker was a webhook-domain rule on Payvessel's dashboard.)
//
// The registration is one funding_transactions row: status 'virtual_account',
// amount 0, credited_at null forever, tx_ref `ppcust_<customer_id>` - the id
// PaymentPoint's webhook names, so a credit finds its owner in one lookup.
// Rows written now are normalised (`provider`, `account_number`,
// `account_name_enc`, `nin_idx`); rows written before that hold PaymentPoint's
// raw response, and are read as they are, never rewritten.
//
// The row is written BEFORE PaymentPoint is asked, as a pending attempt
// (`raw_payload.state: 'pending'`, tx_ref `ppreq_...` until PaymentPoint names
// a customer). Until 2026-10-24 it was written after, and only if the answer
// parsed: an 8s timeout, a restart mid-call or an unfamiliar response shape
// left PaymentPoint holding a permanent account that nothing here knew about.
// Now every outcome lands on a row:
//
//   account in the answer      -> the same row becomes the registration
//   accepted, no account yet   -> pending, keyed ppcust_<id> for the webhook
//   timeout / 5xx / unreadable -> pending: it may exist; ask again after a hold
//   "already exists"           -> pending, ops paged: it exists, we lack it
//   a refusal of the request   -> a first attempt's row is deleted, the
//                                 customer reads why; a repeat keeps the row
//
// A pending row is finished by PaymentPoint's webhook (an account event, or a
// payment that names the customer), by the customer's next tap after the hold,
// or by `npm run funding:reconcile` from PaymentPoint's own export. It keeps
// the NIN claimed, and blind indexes of the email and phone that were sent -
// what PaymentPoint echoes back - so a late event can be matched to it.
// Every write to one of these rows is guarded on its updated_at: the request,
// the webhook and the sweep can all reach the same row.

const REGISTRATION_STATUS = 'virtual_account';
const PROVIDER = 'paymentpoint';
const PENDING = 'pending';
const ATTEMPT_PREFIX = 'ppreq_';

function paymentPointConfigured() {
  return ['PAYMENTPOINT_API_KEY', 'PAYMENTPOINT_SECRET_KEY', 'PAYMENTPOINT_BUSINESS_ID'].every(name =>
    Boolean(String(process.env[name] || '').trim()),
  );
}

/** An error whose message is written for the customer and safe to send as-is. */
function httpError(statusCode, remark, message) {
  return Object.assign(new Error(message), { statusCode, remark, expose: true });
}

/**
 * One registration row, as the app renders it - or null for a row with no
 * usable PalmPay account on it.
 *
 * `bankName` / `accountNumber` / `accountName` are the names every build of the
 * app already reads, so they keep their camelCase.
 */
function payloadOf(row) {
  const p = row?.raw_payload;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

function accountView(row) {
  const p = payloadOf(row);

  if (p.provider === PROVIDER) {
    const accountNumber = String(p.account_number ?? '').trim();
    if (!accountNumber) return null;
    return {
      provider: PROVIDER,
      bankName: String(p.bank_name || 'PalmPay'),
      accountNumber,
      accountName: revealText(p.account_name_enc || ''),
    };
  }

  // A row from a rail that was tried and dropped is not an account here.
  if (p.provider) return null;

  const first = onlyOneAccount(p.bankAccounts)[0];
  const accountNumber = String(first?.accountNumber ?? first?.account_number ?? '').trim();
  if (!accountNumber) return null;
  return {
    provider: PROVIDER,
    bankName: String(first.bankName ?? first.bank_name ?? 'PalmPay'),
    accountNumber,
    accountName: String(first.accountName ?? first.account_name ?? ''),
  };
}

function isPendingRow(row) {
  const p = payloadOf(row);
  return p.provider === PROVIDER && p.state === PENDING && !accountView(row);
}

/**
 * The user's registration: `account` - the newest row with a usable account,
 * and its view - or else the newest `pending` attempt. Never both.
 */
async function loadRegistration(userId) {
  const rows = await prisma.fundingTransaction.findMany({
    where: { user_id: Number(userId), status: REGISTRATION_STATUS },
    orderBy: { id: 'desc' },
  });
  let pending = null;
  for (const row of rows) {
    const view = accountView(row);
    if (view) return { account: { row, view }, pending: null };
    if (!pending && isPendingRow(row)) pending = row;
  }
  return { account: null, pending };
}

// ---- writing a registration row ---------------------------------------------

/**
 * Apply a write to the row as it is now. `plan(row)` returns the data, or
 * null when the row no longer needs it (somebody else finished it). A lost
 * race re-reads and re-plans; a write is never applied over one it did not
 * see. Returns the row as stored afterwards, and whether this call wrote it.
 */
async function transition(row, plan) {
  let current = row;
  for (let i = 0; i < 4 && current; i += 1) {
    const data = plan(current);
    if (!data) return { row: current, changed: false };
    const won = await prisma.fundingTransaction.updateMany({
      where: { id: current.id, updated_at: current.updated_at },
      data,
    });
    const fresh = await prisma.fundingTransaction.findUnique({ where: { id: current.id } });
    if (won.count === 1) return { row: fresh, changed: true };
    current = fresh;
  }
  return { row: current, changed: false };
}

/**
 * transition(), moving the row onto `ppcust_<customerId>` - the key the
 * webhook looks up - in the same write.
 *
 * When that key is taken: by the same user's account, this row is redundant
 * and goes; by the same user's row with no account on it (a legacy
 * placeholder), that row carries nothing this one lacks and makes way; by
 * anyone else, it is a conflict for a human, and nothing is written.
 */
async function keyAndWrite(row, customerId, plan) {
  const ref = customerId ? `ppcust_${customerId}` : '';
  const keyed = r => {
    const data = plan(r);
    return data && ref && r.tx_ref !== ref ? { ...data, tx_ref: ref } : data;
  };

  for (let tries = 0; tries < 2; tries += 1) {
    try {
      return await transition(row, keyed);
    } catch (e) {
      if (e?.code !== 'P2002' || !ref) throw e;
    }

    const holder = await prisma.fundingTransaction.findUnique({ where: { tx_ref: ref } });
    const sameUser = holder && Number(holder.user_id) === Number(row.user_id) && holder.status === REGISTRATION_STATUS;
    if (sameUser && accountView(holder)) {
      await dropAttempt(row);
      return { row: holder, changed: false };
    }
    if (!sameUser || tries > 0) {
      securityEvent('funding.va_conflict', 'Provider returned an account already registered to another user', {
        user_id: Number(row.user_id),
        existing_user_id: holder?.user_id ?? null,
      });
      return { row, changed: false, conflict: true };
    }
    await prisma.fundingTransaction.deleteMany({ where: { id: holder.id, updated_at: holder.updated_at } });
  }
  return { row, changed: false };
}

/** A pending attempt PaymentPoint provably did nothing with. Never a finished row. */
function dropAttempt(row) {
  return prisma.fundingTransaction.deleteMany({
    where: { id: row.id, status: REGISTRATION_STATUS, raw_payload: { path: ['state'], equals: PENDING } },
  });
}

function createAttempt(userId, fields) {
  return prisma.fundingTransaction.create({
    data: {
      user_id: Number(userId),
      tx_ref: `${ATTEMPT_PREFIX}${Number(userId)}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      amount: new Prisma.Decimal('0.00'),
      currency: 'NGN',
      status: REGISTRATION_STATUS,
      raw_payload: { provider: PROVIDER, state: PENDING, customer_id: null, last_outcome: 'sending', ...fields },
    },
  });
}

/**
 * Make `row` the user's registration for `account`. A row that already shows
 * an account is left as it is. Returns keyAndWrite's { row, changed, conflict }.
 */
function attachAccount(row, { customerId, account }) {
  const cid = customerId || payloadOf(row).customer_id || '';
  return keyAndWrite(row, cid, r => {
    if (accountView(r)) return null;
    const p = payloadOf(r);
    return {
      status: REGISTRATION_STATUS,
      // Normalised, never the raw response: PaymentPoint's answer carries the
      // customer's name, email and phone in plain text.
      raw_payload: {
        provider: PROVIDER,
        customer_id: cid || null,
        bank_code: account.bankCode || parsePaymentPointBankCodes()[0] || '',
        bank_name: account.bankName || 'PalmPay',
        account_number: account.accountNumber,
        account_name_enc: protectText(account.accountName || ''),
        nin_idx: p.nin_idx ?? null,
        email_idx: p.email_idx ?? null,
        phone_idx: p.phone_idx ?? null,
        requested_at: p.requested_at ?? null,
        opened_at: new Date().toISOString(),
      },
    };
  });
}

/**
 * Record what a send (or an event) left a pending attempt in. `restore` puts
 * back the binding a refused send overwrote: a send that opened nothing must
 * not move the NIN claim off the one that might have.
 */
async function markPending(row, { outcome, customerId = '', shape = null, restore = null }) {
  const plan = r => {
    if (!isPendingRow(r)) return null;
    const p = payloadOf(r);
    return {
      raw_payload: {
        ...p,
        ...(restore || {}),
        customer_id: customerId || p.customer_id || null,
        last_outcome: outcome,
        ...(shape ? { shape } : {}),
      },
    };
  };
  const keyed = await keyAndWrite(row, customerId, plan);
  // Somebody else's row holds that customer id - raised by keyAndWrite. The
  // outcome is still this attempt's to record, under its own key.
  return keyed.conflict ? transition(row, plan) : keyed;
}

/** Set a timestamp on a pending row, once. */
function stampOnce(row, field) {
  return transition(row, r => {
    const p = payloadOf(r);
    return isPendingRow(r) && !p[field] ? { raw_payload: { ...p, [field]: new Date().toISOString() } } : null;
  });
}

// ---- what a pending attempt shows ------------------------------------------

// How long after a send asking again is held back. Long enough for an account
// PalmPay is still making to arrive, short enough that a customer whose send
// truly failed is not left staring at a spinner.
const retryAfterMs = () => Math.max(30_000, Number(process.env.FUNDING_VA_RETRY_AFTER_MS) || 2 * 60_000);
// PaymentPoint said it is working on it, or that the account exists: a repeat
// is unlikely to help, so it waits longer.
const slowRetryAfterMs = () => Math.max(60_000, Number(process.env.FUNDING_VA_SLOW_RETRY_AFTER_MS) || 15 * 60_000);

const WAITING_ON_PROVIDER = new Set(['provider_pending', 'exists_at_provider']);

function msOf(value, fallback) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(t) ? t : fallback;
}

function outcomeOf(row, now = Date.now()) {
  const p = payloadOf(row);
  const outcome = String(p.last_outcome || 'sending');
  // A send nobody finished - the process restarted mid-call - is a timeout.
  if (outcome === 'sending' && now - msOf(p.last_sent_at, msOf(row.created_at, now)) > ACCOUNT_LOCK_SECONDS * 1000) {
    return 'timeout';
  }
  return outcome;
}

function holdMsFor(outcome) {
  if (outcome === 'sending') return ACCOUNT_LOCK_SECONDS * 1000;
  if (outcome === 'refused' || outcome === 'unavailable') return 0;
  return WAITING_ON_PROVIDER.has(outcome) ? slowRetryAfterMs() : retryAfterMs();
}

function pendingMessage(outcome) {
  switch (outcome) {
    case 'sending':
      return 'We are opening your PalmPay account. This usually takes under a minute.';
    case 'provider_pending':
      return 'PalmPay is still verifying your details. We will notify you as soon as your account number is ready.';
    case 'exists_at_provider':
      return 'Your PalmPay account has been opened and we are linking it to your wallet. We will notify you as soon as it is ready.';
    case 'refused':
    case 'unavailable':
      return 'We could not confirm your PalmPay account yet. Please try again.';
    default:
      return 'PalmPay is still confirming your account. This can take a few minutes - we will notify you.';
  }
}

/** What the screen draws for a pending attempt, and whether asking again is allowed yet. */
function pendingView(row, now = Date.now()) {
  const p = payloadOf(row);
  const outcome = outcomeOf(row, now);
  const created = msOf(row.created_at, now);
  const remaining = Math.max(0, msOf(p.last_sent_at, created) + holdMsFor(outcome) - now);
  return {
    since: new Date(msOf(p.requested_at, created)).toISOString(),
    message: pendingMessage(outcome),
    can_retry: remaining === 0,
    retry_in_seconds: Math.ceil(remaining / 1000),
  };
}

/**
 * The user's approved NIN slip, or null.
 *
 * nin_slip_status === 'approved' is the only "verified NIN" signal in this
 * codebase - the withdrawn nin_status/nin_enc columns verify nobody (see
 * kycGate.helper.js) - so it is the only one reused. Selected without
 * decrypting: the state endpoint only needs to know one exists.
 */
async function approvedSlip(userId) {
  const kyc = await prisma.kycVerification.findUnique({
    where: { user_id: Number(userId) },
    select: { nin_slip_status: true, nin_slip_number_enc: true },
  });
  return kyc?.nin_slip_status === 'approved' && kyc.nin_slip_number_enc ? kyc : null;
}

/**
 * The NIN the account is opened with, and a check that it is this user's.
 *
 * Never an admin/shared value - there is no fallback number anywhere on this
 * path. If the user already has an approved NIN slip, that number is used and
 * nothing typed is read: they are never asked twice, and an admin has already
 * checked it against the register. Otherwise it is the number they typed now.
 *
 * One NIN, one VoltPay account. A typed number is refused if it is claimed by
 * another user's NIN slip (pending claims too, as in kyc.controller), by the
 * withdrawn NIN column's index, or by another user's funding account. All on
 * blind indexes - the comparison never needs the number in plain text.
 *
 * An approved slip is never refused on those grounds: it is the register-
 * checked owner, and the account that collides with it is the suspicious one,
 * so that collision is raised for a human instead of locking the owner out.
 *
 * Only the blind index outlives the request. The number itself goes to
 * PaymentPoint and is never written here, and a typed NIN is never copied into
 * the KYC columns, which stay behind the admin register check.
 */
async function resolveNin(user, typed) {
  const uid = Number(user.id);
  const slip = await approvedSlip(uid);
  const nin = slip ? cleanNin(reveal(slip.nin_slip_number_enc)) : cleanNin(typed);

  if (!nin) {
    const wasTyped = String(typed ?? '').trim() !== '';
    throw httpError(
      400,
      wasTyped ? 'invalid_nin' : 'nin_required',
      wasTyped ? 'Your NIN must be exactly 11 digits.' : 'Enter your 11-digit NIN to continue.',
    );
  }

  const idx = blindIndex(nin, 'nin_slip');
  const [kycClaim, fundingClaim] = await Promise.all([
    prisma.kycVerification.findFirst({
      where: {
        user_id: { not: uid },
        OR: [{ nin_slip_number_idx: idx }, { nin_idx: blindIndex(nin, 'nin') }],
      },
      select: { user_id: true },
    }),
    prisma.fundingTransaction.findFirst({
      where: { status: REGISTRATION_STATUS, user_id: { not: uid }, raw_payload: { path: ['nin_idx'], equals: idx } },
      select: { user_id: true },
    }),
  ]);

  const claim = slip ? fundingClaim : kycClaim || fundingClaim;
  if (claim) {
    securityEvent('funding.nin_reuse', 'NIN already linked to another VoltPay account', {
      user_id: uid,
      existing_user_id: claim.user_id,
      source: slip ? 'approved_slip' : 'typed',
    });
    if (!slip) throw httpError(409, 'nin_in_use', 'This NIN is already linked to another VoltPay account.');
  }

  return { nin, idx };
}

/** What PaymentPoint needs to open an account in the user's name. */
function customerIdentity(user) {
  const pii = revealUserFields(user);
  const phoneNumber = localPhoneNumber(pii.mobile);
  if (!phoneNumber) {
    throw httpError(
      400,
      'validation_error',
      'Invalid phone number. Please update your phone number to an 11-digit Nigerian number (e.g., 08012345678).',
    );
  }
  return {
    email: String(pii.email || '').trim() || `user${user.id}@voltpay.local`,
    name: buildCustomerName(user),
    phoneNumber,
  };
}

function createRequest(identity, nin) {
  return {
    ...identity,
    bankCode: parsePaymentPointBankCodes(),
    businessId: getPaymentPointBusinessId(),
    idType: 'nin',
    idNumber: nin.nin,
  };
}

/**
 * Blind indexes of what this send told PaymentPoint. They are what binds a
 * late event to this user: PaymentPoint echoes back the email and phone it was
 * given, and those can since have changed on the account or changed hands.
 */
function bindingOf(identity, nin) {
  return {
    nin_idx: nin.idx,
    email_idx: blindIndex(identity.email, 'email'),
    phone_idx: blindIndex(identity.phoneNumber, 'mobile'),
  };
}

/**
 * What one create call means, as { kind, outcome, customerId, account }:
 *
 *   created  an account number came back - in the answer, or even in an
 *            error body that quotes the existing one
 *   pending  it may exist, or does: a timeout, a 5xx, an unreadable 2xx, a
 *            success with no account, or "already exists"
 *   refused  provably opened nothing: their refusal of the request, our keys,
 *            their throttle, or a request that never left
 */
function classifyCreate({ raw, error, preferBankCode }) {
  const body = raw || error?.paymentpoint || null;
  const found = body ? paymentpoint.extractVirtualAccount(body, { preferBankCode }) : { customerId: '', account: null, accounts: 0 };
  const base = {
    customerId: found.customerId,
    account: found.account,
    accounts: found.accounts,
    shape: body ? paymentpoint.describeShape(body) : null,
  };

  if (found.account) return { ...base, kind: 'created', outcome: 'created' };
  if (!error) return { ...base, kind: 'pending', outcome: found.customerId ? 'provider_pending' : 'no_account' };

  const status = Number(error.statusCode) || 0;
  if (['timeout', 'network', 'unreadable'].includes(error.kind)) return { ...base, kind: 'pending', outcome: error.kind };
  if (['config', 'unreachable'].includes(error.kind)) return { ...base, kind: 'refused', outcome: 'unavailable' };
  // A 5xx or 408 can be their upstream failing after the account was made. An
  // error without a kind is one we cannot read, so it is assumed the same.
  if (status >= 500 || status === 408 || (!error.kind && !status)) return { ...base, kind: 'pending', outcome: 'server_error' };
  if (status === 409 || paymentpoint.isDuplicateWording(error.message, ...(error.providerErrors || []))) {
    return { ...base, kind: 'pending', outcome: 'exists_at_provider' };
  }
  return { ...base, kind: 'refused', outcome: [401, 402, 403, 404, 429].includes(status) ? 'unavailable' : 'refused' };
}

// A provider can quote a NIN, a phone or an email back in its error text.
function redactReason(text) {
  return String(text || '')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\d{6,}/g, '[digits]')
    .slice(0, 200);
}

/**
 * The trace of one create call: how long it took, what it was taken to mean,
 * and the shape of the body - key names and counts, never a value. One live
 * attempt with this line is what shows where PaymentPoint put the account.
 */
function logProviderAnswer({ userId, attempt, raw, error, verdict, elapsedMs }) {
  const line = {
    user_id: Number(userId),
    attempt_id: attempt?.id ?? null,
    elapsed_ms: elapsedMs,
    verdict: verdict.kind,
    outcome: verdict.outcome,
    has_customer_id: Boolean(verdict.customerId),
    accounts_found: verdict.accounts ?? 0,
    shape: verdict.shape,
    ...(error ? { error_kind: error.kind || null, http_status: Number(error.statusCode) || null, reason: redactReason(error.message) } : {}),
  };
  (verdict.kind === 'created' ? console.log : console.warn)('funding.virtual_account.provider_answer', line);
}

/** Ops, once per attempt. Ids only - the provider's words can quote a name. */
async function pageOpsOnce(row, message, reason) {
  const stamped = await stampOnce(row, 'alerted_at');
  if (!stamped.changed) return false;
  paymentFailure({
    provider: 'paymentpoint',
    action: 'virtual_account',
    reference: stamped.row?.tx_ref || row.tx_ref,
    userId: row.user_id,
    message,
    context: { reason, row_id: row.id },
  });
  return true;
}

const UNRECORDED_ACCOUNT =
  'PaymentPoint already holds a PalmPay account for this customer that VoltPay never recorded. ' +
  "Export PaymentPoint's customer list and run: npm run funding:reconcile -- --file <export> --apply";

/**
 * One send to PaymentPoint for this user - the first, or a repeat on their
 * pending attempt. Record first, then ask: the row exists before the call, so
 * an answer lost to a timeout, a restart or a deploy still leaves the attempt
 * to match a late account to. Returns { refusal } when PaymentPoint refused
 * the request outright, for the customer to read.
 */
async function openAccount({ user, pending, identity, nin }) {
  const request = createRequest(identity, nin);
  const binding = bindingOf(identity, nin);
  const sentAt = new Date().toISOString();
  const before = payloadOf(pending);
  const previous = pending ? { nin_idx: before.nin_idx ?? null, email_idx: before.email_idx ?? null, phone_idx: before.phone_idx ?? null } : null;

  let attempt;
  if (pending) {
    const touched = await transition(pending, r =>
      isPendingRow(r)
        ? {
            raw_payload: {
              ...payloadOf(r),
              ...binding,
              last_sent_at: sentAt,
              last_outcome: 'sending',
              sends: Number(payloadOf(r).sends || 0) + 1,
              nudged_at: null,
            },
          }
        : null,
    );
    // Finished meanwhile - a webhook brought the account - so nothing to ask.
    if (!touched.changed) return {};
    attempt = touched.row;
  } else {
    attempt = await createAttempt(user.id, { ...binding, requested_at: sentAt, last_sent_at: sentAt, sends: 1 });
  }

  const started = Date.now();
  let raw = null;
  let error = null;
  try {
    ({ raw } = await paymentpoint.createVirtualAccount(request));
  } catch (e) {
    error = e;
  }
  const verdict = classifyCreate({ raw, error, preferBankCode: request.bankCode[0] });
  logProviderAnswer({ userId: user.id, attempt, raw, error, verdict, elapsedMs: Date.now() - started });

  if (verdict.kind === 'created') {
    const out = await attachAccount(attempt, { customerId: verdict.customerId, account: verdict.account });
    if (out.conflict) {
      await dropAttempt(attempt);
      throw httpError(409, 'conflict', 'We could not finish setting up your account. Please contact support.');
    }
    return {};
  }

  if (verdict.kind === 'refused') {
    // This send opened nothing. A first attempt leaves nothing behind; a
    // repeat keeps the row, because the earlier send's outcome is still open.
    if (pending) await markPending(attempt, { outcome: verdict.outcome, restore: previous });
    else await dropAttempt(attempt);
    return { refusal: error };
  }

  const marked = await markPending(attempt, {
    outcome: verdict.outcome,
    customerId: verdict.customerId,
    shape: verdict.shape,
  });
  if (verdict.outcome === 'exists_at_provider') {
    await pageOpsOnce(marked.row || attempt, UNRECORDED_ACCOUNT, verdict.outcome);
  }
  return {};
}

// Opening an account calls PaymentPoint once and cannot be undone, so two
// requests for one user must never overlap: a double tap would otherwise mint
// two permanent account numbers. In-process first, then Redis across instances.
const ACCOUNT_LOCK_SECONDS = 90;
const accountLocks = new Set();

async function withAccountLock(userId, fn) {
  const id = String(userId);
  const busy = () => httpError(409, 'account_in_progress', 'Your account is already being set up. Please wait a moment.');
  if (accountLocks.has(id)) throw busy();
  accountLocks.add(id);

  let sharedKey = null;
  try {
    if (redis.isEnabled() && redis.isHealthy()) {
      const k = redis.key('lock', 'funding-va', id);
      // SET NX alone cannot tell a lost race from a transport error - both are
      // null - and refusing a customer because Redis blinked would be a lie
      // ("already being set up"). The GET beside it can: a value there means
      // a holder exists. No answer at all is an outage, which falls back to
      // the in-process lock above rather than to a refusal.
      const results = await redis.pipeline([
        ['SET', k, '1', 'NX', 'EX', ACCOUNT_LOCK_SECONDS],
        ['GET', k],
      ]);
      if (results?.[0] === 'OK') sharedKey = k;
      else if (results && results[1] != null) throw busy();
    }
    return await fn();
  } finally {
    accountLocks.delete(id);
    if (sharedKey) redis.del(sharedKey).catch(() => null);
  }
}

/** Everything the Fund Account screen draws, in one payload. */
async function accountState(user) {
  const [reg, slip] = await Promise.all([loadRegistration(user.id), approvedSlip(user.id)]);
  const pending = !reg.account && reg.pending ? pendingView(reg.pending) : null;
  return {
    // The shape every build of the app reads: one card per entry in
    // `bankAccounts`, and `nin_required` to decide whether to ask for a NIN.
    provider: PROVIDER,
    customer: null,
    bankAccounts: reg.account ? [reg.account.view] : [],
    nin_required: !slip,
    nin_on_file: Boolean(slip),
    // False when the server has no PaymentPoint keys, so the screen can say
    // so instead of offering a button that can only fail.
    available: paymentPointConfigured(),
    // 'ready' | 'pending' | 'none'. An older app ignores both and sees an
    // empty `bankAccounts` while pending; its tap is answered account_pending.
    account_status: reg.account ? 'ready' : pending ? 'pending' : 'none',
    pending,
  };
}

function sendState(res, state, message) {
  return res.json({ remark: 'virtual_account', status: 'success', message: [message], data: state });
}

/**
 * "Still being set up" - for a tap the hold refuses, or a send whose answer
 * left it pending. A 4xx on purpose: every installed build shows a 4xx's
 * message, while a 2xx other than 200 printed the raw map. The state rides
 * along in `data` for the builds that draw it.
 */
function sendPending(res, state) {
  return res.status(409).json({
    remark: 'account_pending',
    status: 'error',
    message: [state.pending?.message || pendingMessage('timeout')],
    data: state,
  });
}

function stateMessage(state) {
  if (state.bankAccounts.length) return 'Virtual account is ready';
  return state.pending ? 'Virtual account is being set up' : 'No virtual account yet';
}

// A provider's own refusal is often the most useful thing to show ("Invalid
// NIN"), as long as it reads like a sentence and not like a stack trace or an
// HTML error page.
function readableProviderText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 200 || /[<>{}]/.test(t) || /missing required env/i.test(t)) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Turn a PaymentPoint failure into something the customer can act on.
 *
 * Our credentials, their throttle, their outage, our own misconfiguration:
 * none of it is fixed by retyping, so all of it reads as "try again later" -
 * and never as the raw provider text, which for these is either an HTML page
 * or a line about our API keys. A refusal of the request itself - usually the
 * NIN - is the customer's to fix, so PaymentPoint's words go through.
 */
function providerFailure(e) {
  const status = Number(e?.statusCode) || 500;

  if (status >= 500 || [401, 402, 403, 404, 408, 429].includes(status)) {
    return {
      status: 503,
      remark: 'provider_unavailable',
      message: 'PalmPay accounts are not available right now. Please try again in a few minutes.',
    };
  }

  const said = readableProviderText(e?.message);
  return {
    status: 400,
    remark: 'provider_declined',
    message: said
      ? `PalmPay could not open your account: ${said}`
      : 'PalmPay could not open your account. Please check your details and try again.',
  };
}

function sendFailure(res, e, { userId }) {
  if (e?.expose) {
    return res.status(e.statusCode).json({ remark: e.remark, status: 'error', message: [e.message], data: null });
  }
  console.error('funding.virtual_account.open failed', {
    user_id: Number(userId),
    status: Number(e?.statusCode) || null,
    kind: e?.kind || null,
    reason: redactReason(e?.message || e),
  });
  const out = providerFailure(e);
  return res.status(out.status).json({ remark: out.remark, status: 'error', message: [out.message], data: null });
}

/**
 * GET  /funding/virtual-account  the Fund Account screen's state. Read-only:
 *                                opening the screen never provisions anything.
 * POST /funding/virtual-account  { nin? } open the user's PalmPay account. The
 *                                NIN is required unless an approved NIN slip
 *                                already covers it. Any `provider` a client
 *                                sends is ignored - there is only one.
 *                                200 with the account, 409 account_pending
 *                                while PalmPay finishes, or the refusal.
 */
async function virtualAccount(req, res) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
  }

  if (!prisma.fundingTransaction) {
    return res.status(500).json({
      remark: 'server_error',
      status: 'error',
      message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
      data: null,
    });
  }

  try {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      const state = await accountState(user);
      return sendState(res, state, stateMessage(state));
    }

    // One user, one account: a second tap returns the first.
    const reg = await loadRegistration(user.id);
    if (reg.account) {
      return sendState(res, await accountState(user), 'Your funding account is ready');
    }

    if (!paymentPointConfigured()) {
      throw httpError(503, 'provider_unavailable', 'PalmPay accounts are not available right now. Please try again later.');
    }

    // An earlier send may still be opening the account at PaymentPoint, and
    // asking again inside the hold would only race it. Answered before the
    // NIN is read, so a tap from an older build is told to wait, not to type.
    if (reg.pending && !pendingView(reg.pending).can_retry) {
      return sendPending(res, await accountState(user));
    }

    const identity = customerIdentity(user);
    const nin = await resolveNin(user, req.body?.nin);

    let refusal = null;
    await withAccountLock(user.id, async () => {
      // Re-read under the lock: a request that looked before another one
      // committed must find that account or attempt, not open a second.
      const fresh = await loadRegistration(user.id);
      if (fresh.account) return;
      if (fresh.pending && !pendingView(fresh.pending).can_retry) return;
      ({ refusal } = await openAccount({ user, pending: fresh.pending, identity, nin }));
    });

    // The one ledger-visible write that does not move money, so it is the one
    // that balance.helper's choke point never sees. Neither the dashboard nor
    // the transaction list filters on status, so this ₦0.00 row does show up in
    // both - and without this drop it would be missing from a cached list for
    // up to the TTL, on the screen the user is staring at right after asking
    // for the account.
    cache.dropUserActivity(user.id);

    if (refusal) throw refusal;

    const state = await accountState(user);
    if (state.bankAccounts.length) return sendState(res, state, 'Virtual account created successfully');
    if (state.pending) return sendPending(res, state);
    return sendState(res, state, stateMessage(state));
  } catch (e) {
    return sendFailure(res, e, { userId: user.id });
  }
}

async function verify(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const tx_ref = String(req.body?.tx_ref || '').trim();
    if (!tx_ref) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['tx_ref is required'], data: null });
    }

    const funding = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
    if (funding && Number(funding.user_id) === Number(user.id) && funding.status === REGISTRATION_STATUS) {
      const view = accountView(funding);
      return res.json({
        remark: 'virtual_account',
        status: 'success',
        message: ['Virtual account is ready'],
        data: {
          provider: view?.provider || 'paymentpoint',
          customer: null,
          bankAccounts: view ? [view] : [],
        },
      });
    }

    return res.status(400).json({
      remark: 'not_supported',
      status: 'error',
      message: ['Transfers to your account number are credited automatically once they are confirmed.'],
      data: null,
    });
  } catch (e) {
    console.error('Funding verify error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to verify funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function reconcileWorker({ userId, pending }) {
  return;
}

async function reconcile(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    return res.json({ remark: 'reconcile_disabled', status: 'success', message: ['Reconcile is not required for PaymentPoint funding'], data: { results: [] } });
  } catch (e) {
    console.error('Funding reconcile error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to reconcile funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

/**
 * Land one confirmed incoming transfer in a wallet: the five writes a credit
 * is, in one transaction. The webhook below is the caller.
 *
 * Idempotent by the claim: the funding row is flipped to credited with
 * `credited_at: null` in the where clause, so of any number of deliveries of
 * one transfer exactly one moves the balance. Returns whether this call did.
 *
 * Both inserts are ON CONFLICT DO NOTHING (`skipDuplicates`), never a create
 * wrapped in a P2002 catch. In Postgres a failed statement aborts the whole
 * transaction: catching the error in JS does not un-abort it, so every
 * statement after it fails with "current transaction is aborted" - and a
 * transfer whose row already existed uncredited could never reach the claim.
 */
async function creditWallet({ userId, txRef, creditAmount, grossAmount, feeAmount, rawPayload, note, meta }) {
  return prisma.$transaction(
    async tx => {
      await tx.fundingTransaction.createMany({
        data: [
          {
            user_id: Number(userId),
            tx_ref: txRef,
            amount: creditAmount,
            currency: 'NGN',
            status: 'pending',
            raw_payload: rawPayload,
          },
        ],
        skipDuplicates: true,
      });

      const claimed = await tx.fundingTransaction.updateMany({
        where: { tx_ref: txRef, credited_at: null },
        data: {
          status: 'successful',
          credited_at: new Date(),
          amount: creditAmount,
          currency: 'NGN',
          raw_payload: rawPayload,
        },
      });

      // Zero means another delivery of this same transfer already credited it.
      if (!claimed?.count) return false;

      await applyBalanceDelta(tx, 'user', userId, creditAmount);
      await tx.user.update({
        where: { id: Number(userId) },
        data: { currency_symbol: '₦' },
      });

      if (tx.walletTransaction) {
        await tx.walletTransaction.createMany({
          data: [
            {
              user_id: Number(userId),
              trx: String(txRef),
              trx_type: '+',
              amount: creditAmount,
              charge: feeAmount,
              total_amount: grossAmount,
              remark: 'fund_account',
              // Names nobody, so no protectText.
              details: 'Wallet funding',
              other_data: {
                title: 'Transfer to Wallet',
                subtitle: 'Wallet Funding',
                feedback: 'Successful',
                note,
                image_src: '',
              },
              // Ids and amounts only - never a name, email or phone.
              meta,
            },
          ],
          skipDuplicates: true,
        });
      }

      return true;
    },
    {
      maxWait: 10_000,
      timeout: 15_000,
    }
  );
}

/**
 * The "Money Received" alert. Outside the transaction on purpose: a slow FCM
 * round trip must not hold a money transaction open, and a failed push must
 * not roll a credit back.
 */
async function notifyCredit({ userId, txRef, amount, senderName }) {
  await notifyUser({
    userId: Number(userId),
    subject: 'Money Received',
    message: `${senderName} sent you ${formatNaira(amount.toString())}`,
    type: 'credit_alert',
    // Persisted: no counterparty name here, same rule as ledger meta.
    data: { type: 'credit_alert', trx: txRef, amount: Number(amount.toString()) },
    // Transient, device-only: the name is what makes the banner useful.
    pushData: {
      type: 'credit_alert',
      trx: txRef,
      amount: Number(amount.toString()).toFixed(2),
      sender: senderName,
    },
    clientMessageId: `credit:${txRef}`,
  });
}

// ---------------------------------------------------------------------------
// Accounts PaymentPoint holds that we did not record
// ---------------------------------------------------------------------------

/** Blind indexes of every stored form of a Nigerian number. */
function mobileIndexes(phone) {
  const ng = normalizeNgPhone(phone);
  if (!ng) return [];
  return [...new Set([ng.local, ng.msisdn, ng.local.slice(1)])].map(v => blindIndex(v, 'mobile')).filter(Boolean);
}

/**
 * The one VoltPay user a PaymentPoint customer's email and phone lead to.
 *
 * Both, or nobody: the email and the phone must each lead to exactly one user
 * - through an attempt that sent them, or the account as it is today - and it
 * must be the same one. One identifier alone can have changed hands since it
 * was sent, and money credited to the wrong person is worse than money that
 * waits for one. The email we mint for an account without one
 * (`user<id>@voltpay.local`) names its user outright. Never a name.
 * Returns { userId, via }, { conflict: true } or null.
 */
async function userForContact({ email, phone } = {}) {
  const minted = /^user(\d+)@voltpay\.local$/i.exec(String(email || '').trim());
  if (minted) {
    const user = await prisma.user.findUnique({ where: { id: Number(minted[1]) }, select: { id: true, status: true } });
    return user && !isDeleted(user) ? { userId: Number(user.id), via: 'minted_email' } : null;
  }

  const emailIdx = email ? blindIndex(email, 'email') : null;
  const phoneIdxs = phone ? mobileIndexes(phone) : [];
  if (!emailIdx || !phoneIdxs.length) return null;

  const [sentEmail, sentPhone, byEmail, byPhone] = await Promise.all([
    prisma.fundingTransaction.findMany({
      where: { status: REGISTRATION_STATUS, raw_payload: { path: ['email_idx'], equals: emailIdx } },
      select: { user_id: true },
      take: 10,
    }),
    prisma.fundingTransaction.findMany({
      where: { status: REGISTRATION_STATUS, OR: phoneIdxs.map(idx => ({ raw_payload: { path: ['phone_idx'], equals: idx } })) },
      select: { user_id: true },
      take: 10,
    }),
    prisma.user.findMany({ where: { email_idx: emailIdx }, select: { id: true, status: true }, take: 2 }),
    prisma.user.findMany({ where: { OR: phoneIdxs.map(idx => ({ mobile_idx: idx })) }, select: { id: true, status: true }, take: 5 }),
  ]);

  const live = users => users.filter(u => !isDeleted(u)).map(u => Number(u.id));
  const viaEmail = new Set([...sentEmail.map(r => Number(r.user_id)), ...live(byEmail)]);
  const viaPhone = new Set([...sentPhone.map(r => Number(r.user_id)), ...live(byPhone)]);
  const everyone = new Set([...viaEmail, ...viaPhone]);
  if (everyone.size > 1) return { conflict: true };
  if (viaEmail.size !== 1 || viaPhone.size !== 1) return null;

  const [userId] = everyone;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  return user && !isDeleted(user) ? { userId, via: 'email_and_phone' } : null;
}

/**
 * Whose a PaymentPoint customer is: by the key we hold (`ppcust_`), by the
 * account number on a registration, then by userForContact. Returns
 * { userId, row, via } - `row` the user's registration or pending attempt,
 * when there is one - or { conflict: true }, or null.
 */
async function placeCustomer({ customerId, accountNumber, contact = {} }) {
  if (customerId) {
    const row = await prisma.fundingTransaction.findUnique({ where: { tx_ref: `ppcust_${customerId}` } });
    if (row?.status === REGISTRATION_STATUS) return { userId: Number(row.user_id), row, via: 'customer_id' };
  }
  if (accountNumber) {
    const row = await prisma.fundingTransaction.findFirst({
      where: { status: REGISTRATION_STATUS, raw_payload: { path: ['account_number'], equals: accountNumber } },
    });
    if (row) return { userId: Number(row.user_id), row, via: 'account_number' };
  }
  const who = await userForContact(contact);
  if (!who?.userId) return who;
  const reg = await loadRegistration(who.userId);
  return { userId: who.userId, row: reg.account?.row || reg.pending || null, via: who.via };
}

/**
 * Write down that `customerId` (and `account`, when known) is this user's,
 * on `row` or a new one. A user whose account is already showing keeps it -
 * one account on screen - and only learns a customer id it never had.
 * Returns { attached } - true when the user's account just became ready.
 */
async function recordCustomer({ userId, row, customerId, account }) {
  if (row && accountView(row)) {
    if (customerId && !payloadOf(row).customer_id && String(row.tx_ref).startsWith(ATTEMPT_PREFIX)) {
      await keyAndWrite(row, customerId, r =>
        accountView(r) && !payloadOf(r).customer_id ? { raw_payload: { ...payloadOf(r), customer_id: customerId } } : null,
      );
    }
    return { attached: false };
  }

  const target = row || (await createAttempt(userId, { requested_at: new Date().toISOString(), sends: 0, last_outcome: 'provider_pending' }));
  if (!account) {
    await markPending(target, { outcome: 'provider_pending', customerId });
    return { attached: false };
  }
  const out = await attachAccount(target, { customerId, account });
  if (out.conflict && !row) await dropAttempt(target);
  return { attached: Boolean(out.changed), conflict: Boolean(out.conflict) };
}

function notifyAccountReady(userId) {
  return notifyUser({
    userId: Number(userId),
    subject: 'Your account number is ready',
    message: 'Your PalmPay account number is ready. Open Fund Account to see it and fund your wallet.',
    type: 'funding_account',
    data: { type: 'funding_account' },
    pushData: { type: 'funding_account' },
    // One account per user, so once per user ever - a redelivered event or a
    // second reconcile run cannot announce it twice.
    clientMessageId: `va_ready:${Number(userId)}`,
  }).catch(() => false);
}

/**
 * Link an account PaymentPoint holds to the VoltPay user it belongs to - from
 * an account event, or a row of PaymentPoint's export (`--apply` only).
 * Outcomes: linked, would_link, already_linked, has_other_account,
 * unmatched, conflict, invalid.
 */
async function linkProviderAccount({ customerId = '', account, contact = {} }, { apply = false } = {}) {
  if (!account?.accountNumber) return { outcome: 'invalid' };
  const placed = await placeCustomer({ customerId, accountNumber: account.accountNumber, contact });
  if (!placed) return { outcome: 'unmatched' };
  if (placed.conflict) return { outcome: 'conflict' };

  const { userId, via } = placed;
  const showing = placed.row && accountView(placed.row) ? placed.row : (await loadRegistration(userId)).account?.row;
  if (showing) {
    const same = accountView(showing).accountNumber === account.accountNumber;
    if (same && apply) await recordCustomer({ userId, row: showing, customerId, account });
    return { outcome: same ? 'already_linked' : 'has_other_account', userId, via };
  }
  if (!apply) return { outcome: 'would_link', userId, via };

  const recorded = await recordCustomer({ userId, row: placed.row, customerId, account });
  if (recorded.conflict) return { outcome: 'conflict', userId };
  if (recorded.attached) {
    await notifyAccountReady(userId);
    cache.dropUserActivity(userId);
  }
  return { outcome: recorded.attached ? 'linked' : 'already_linked', userId, via };
}

/**
 * A webhook that carries an account and no money: PaymentPoint finishing an
 * account after its create call answered - or after that answer was lost.
 * True when it was one, whether or not it could be placed.
 */
async function accountEvent(body) {
  const found = paymentpoint.extractVirtualAccount(body, { preferBankCode: parsePaymentPointBankCodes()[0] });
  if (!found.account) return false;

  const envelope = body?.data && typeof body.data === 'object' ? body.data : body;
  const result = await linkProviderAccount(
    { customerId: found.customerId, account: found.account, contact: paymentpoint.customerContact(envelope) },
    { apply: true },
  );
  console.log('PaymentPoint webhook: account event', {
    outcome: result.outcome,
    user_id: result.userId ?? null,
    has_customer_id: Boolean(found.customerId),
  });
  if (result.outcome === 'unmatched' || result.outcome === 'conflict') {
    paymentFailure({
      provider: 'paymentpoint',
      action: 'virtual_account',
      reference: found.customerId ? `ppcust_${found.customerId}` : null,
      message: `PaymentPoint sent an account we could not place (${result.outcome}). Check PaymentPoint's dashboard, then npm run funding:reconcile.`,
      context: { outcome: result.outcome },
    });
  }
  return true;
}

/** Best effort: the credit never waits on this, and the next payment retries it. */
async function recordFromPayment({ userId, row, customerId, receiver }) {
  try {
    const recorded = await recordCustomer({ userId, row, customerId, account: receiver });
    if (recorded.attached) {
      notifyAccountReady(userId);
      cache.dropUserActivity(userId);
    }
  } catch (e) {
    console.error('PaymentPoint webhook: could not record customer', { user_id: Number(userId), reason: redactReason(e?.message) });
  }
}

/**
 * Whose wallet a payment for `customerId` credits, as a row with `user_id`,
 * or null.
 *
 * Usually the `ppcust_` registration. A pending one learns its account from
 * the payment, which names the account it landed in. A customer id we hold
 * nothing for is an account PaymentPoint opened after its create call
 * stopped waiting: placed by that account number, or by the email AND phone
 * PaymentPoint was sent, and recorded so the next payment is one lookup.
 * Nobody is credited on a guess - ops are paged with ids and the amount, and
 * the money waits at PaymentPoint for a person.
 */
async function ownerOfPayment(payload, customerId, { reference, amount }) {
  const receiver = paymentpoint.receiverAccount(payload);
  const known = await prisma.fundingTransaction.findUnique({ where: { tx_ref: `ppcust_${customerId}` } });
  if (known) {
    if (isPendingRow(known) && receiver) await recordFromPayment({ userId: known.user_id, row: known, customerId, receiver });
    return known;
  }

  const placed = await placeCustomer({
    customerId: '',
    accountNumber: receiver?.accountNumber || '',
    contact: paymentpoint.customerContact(payload),
  });

  if (!placed?.userId) {
    console.log('PaymentPoint webhook: payment for a customer we cannot place', {
      customer_id: String(customerId),
      conflict: Boolean(placed?.conflict),
    });
    paymentFailure({
      provider: 'paymentpoint',
      action: 'funding',
      reference,
      amount: amount.toString(),
      message: placed?.conflict
        ? 'Payment for a PaymentPoint customer whose details lead to more than one VoltPay user - not credited'
        : 'Payment for a PaymentPoint customer with no VoltPay registration - not credited',
      context: { customer_id: String(customerId) },
    });
    return null;
  }

  await recordFromPayment({ userId: placed.userId, row: placed.row, customerId, receiver });
  console.log('PaymentPoint webhook: payment placed', { user_id: placed.userId, via: placed.via });
  return { user_id: placed.userId };
}

// ---- the sweep ----------------------------------------------------------------

const nudgeAfterMs = () => Math.max(60_000, Number(process.env.FUNDING_VA_NUDGE_AFTER_MS) || 10 * 60_000);
const alertAfterMs = () => Math.max(60_000, Number(process.env.FUNDING_VA_ALERT_AFTER_MS) || 30 * 60_000);

// Outcomes a customer's own retry can finish. Not the two where PaymentPoint
// has the account or is making it: tapping again cannot help there.
const RETRYABLE = new Set(['timeout', 'network', 'server_error', 'unreadable', 'no_account', 'refused', 'unavailable']);

function notifyRetry(userId, rowId, sends) {
  return notifyUser({
    userId: Number(userId),
    subject: 'Finish getting your account number',
    message: 'PalmPay has not confirmed your account number yet. Open Fund Account and tap Try Again to finish.',
    type: 'funding_account',
    data: { type: 'funding_account' },
    pushData: { type: 'funding_account' },
    clientMessageId: `va_retry:${rowId}:${Number(sends) || 0}`,
  }).catch(() => false);
}

/**
 * The part of finishing a pending account that needs neither PaymentPoint's
 * webhook nor the customer: tell a customer whose retry would finish it (the
 * NIN is theirs to send again - it is never stored), and page ops about any
 * attempt nothing has resolved, once each. The webhook and the customer's tap
 * are what actually finish them. A 5-minute timer in server.js.
 */
async function sweepPendingAccounts({ now = Date.now(), limit = 200 } = {}) {
  // Newest first. A row stays pending after it has been nudged and paged, so
  // oldest-first would let finished-with rows fill the window for good.
  const rows = await prisma.fundingTransaction.findMany({
    where: { status: REGISTRATION_STATUS, raw_payload: { path: ['state'], equals: PENDING } },
    orderBy: { id: 'desc' },
    take: limit,
  });

  const out = { pending: 0, nudged: 0, alerted: 0 };
  const overdue = [];
  for (const row of rows) {
    if (!isPendingRow(row)) continue;
    out.pending += 1;
    const p = payloadOf(row);
    const age = now - msOf(p.requested_at, msOf(row.created_at, now));
    let current = row;

    if (age >= nudgeAfterMs() && !p.nudged_at && RETRYABLE.has(outcomeOf(row, now)) && pendingView(row, now).can_retry) {
      const stamped = await stampOnce(current, 'nudged_at');
      if (stamped.changed) {
        out.nudged += 1;
        current = stamped.row;
        await notifyRetry(row.user_id, row.id, p.sends);
      }
    }

    if (current && age >= alertAfterMs() && !payloadOf(current).alerted_at) {
      const stamped = await stampOnce(current, 'alerted_at');
      if (stamped.changed) overdue.push(current);
    }
  }

  if (overdue.length) {
    out.alerted = overdue.length;
    paymentFailure({
      provider: 'paymentpoint',
      action: 'virtual_account',
      reference: `va:${overdue.length}`,
      message:
        `${overdue.length} PalmPay account request(s) unresolved after ${Math.round(alertAfterMs() / 60_000)} min. ` +
        "PaymentPoint may hold accounts we never recorded: export PaymentPoint's customers and run npm run funding:reconcile -- --file <export>",
      context: { row_ids: overdue.slice(0, 20).map(r => r.id) },
    });
  }
  return out;
}

async function webhook(req, res) {
  try {
    if (!prisma.fundingTransaction) {
      return res.status(200).json({ received: true });
    }

    const signature =
      req.headers['paymentpoint-signature'] ||
      req.headers['x-paymentpoint-signature'] ||
      req.headers['x-webhook-signature'] ||
      req.headers['x-signature'];
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!paymentpoint.verifyWebhookSignature({ rawBody, signature })) {
      console.warn('PaymentPoint webhook signature verification failed', {
        hasRawBody: Boolean(rawBody),
        hasSignature: Boolean(signature),
        headerKeys: Object.keys(req.headers || {}),
      });
      // Either the provider rotated a secret or somebody is posting fake credit
      // events at us. Both need a human, neither can be told apart from here.
      securityEvent('webhook.bad_signature', 'PaymentPoint webhook rejected: signature did not verify', {
        has_signature: Boolean(signature),
        has_raw_body: Boolean(rawBody),
      });
      return res.status(401).send('Unauthorized');
    }

    console.log('PaymentPoint webhook received', {
      headerKeys: Object.keys(req.headers || {}),
    });

    const root = req.body || {};
    const payload = root?.data && typeof root.data === 'object' ? root.data : root;

    // An account and nothing payment-shaped: PaymentPoint finishing an account
    // opened with a NIN. Checked before the payment test, which an event
    // saying `status: success` would otherwise pass and then be dropped for
    // having no amount.
    if (!looksLikePayment(root) && !looksLikePayment(payload) && (await accountEvent(root))) {
      return res.status(200).json({ received: true });
    }

    if (!isSuccessfulPaymentPointPayload(root) && !isSuccessfulPaymentPointPayload(payload)) {
      console.log('PaymentPoint webhook ignored (not successful)', {
        keys: Object.keys(payload || {}),
      });
      return res.status(200).json({ received: true });
    }

    const customerId =
      payload?.customer_id ||
      payload?.customerId ||
      payload?.customer?.customer_id ||
      payload?.customer?.id ||
      payload?.customer?.customerId;

    const transactionId =
      payload?.transaction_id ||
      payload?.transactionId ||
      payload?.transaction?.transaction_id ||
      payload?.transaction?.id ||
      payload?.transaction?.transactionId ||
      payload?.id ||
      payload?.reference;

    const grossAmountDec = grossAmountOf(payload);

    const settlementAmountDec = normalizeAmountToDecimal(
      payload?.settlement_amount ?? payload?.settlementAmount ?? payload?.settled_amount ?? payload?.settledAmount
    );

    const settlementFeeDec = normalizeAmountToDecimal(payload?.settlement_fee ?? payload?.settlementFee ?? payload?.fee);

    const creditAmountDec = settlementAmountDec || grossAmountDec;
    const currency = (payload?.currency || 'NGN').toString().toUpperCase();

    if (!customerId || !transactionId || !creditAmountDec) {
      console.log('PaymentPoint webhook ignored (missing required fields)', {
        hasCustomerId: Boolean(customerId),
        hasTransactionId: Boolean(transactionId),
        hasAmount: Boolean(creditAmountDec),
        keys: Object.keys(payload || {}),
      });
      return res.status(200).json({ received: true });
    }

    if (currency !== 'NGN') {
      return res.status(200).json({ received: true });
    }

    const tx_ref = `pp_${String(transactionId)}`;
    const vaRecord = await ownerOfPayment(payload, String(customerId), { reference: tx_ref, amount: creditAmountDec });
    if (!vaRecord) {
      return res.status(200).json({ received: true });
    }

    const creditAmount = creditAmountDec;
    const grossAmount = grossAmountDec || creditAmount;
    const feeAmount = settlementFeeDec || new Prisma.Decimal('0.00');
    const fee = Number(feeAmount.toString());

    const credited = await creditWallet({
      userId: vaRecord.user_id,
      txRef: tx_ref,
      creditAmount,
      grossAmount,
      feeAmount,
      rawPayload: payload,
      note: 'PaymentPoint',
      meta: {
        gross_amount: Number(grossAmount.toString()),
        fee,
        credited_amount: Number(creditAmount.toString()),
        settlement_amount: Number(creditAmount.toString()),
        paymentpoint_transaction_id: String(transactionId),
        customer_id: String(customerId),
      },
    });

    console.log('PaymentPoint wallet credited', {
      tx_ref: `pp_${String(transactionId)}`,
      user_id: Number(vaRecord.user_id),
      amount: Number(creditAmount.toString()),
      credited: Boolean(credited),
    });

    // Only on a fresh credit - a redelivered webhook must not re-alert.
    if (credited) {
      await notifyCredit({ userId: vaRecord.user_id, txRef: tx_ref, amount: creditAmount, senderName: extractSenderName(payload) });
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Funding webhook error:', e);
    return res.status(200).json({ received: true });
  }
}

async function callback(req, res) {
  try {
    const status = String(req.query?.status || '').toLowerCase();
    const tx_ref = String(req.query?.tx_ref || '');
    const transaction_id = String(req.query?.transaction_id || req.query?.reference || req.query?.trxref || '');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VoltPay Payment</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Arial; padding:24px;} .box{max-width:520px;margin:0 auto;} .muted{color:#666;}</style>
  </head>
  <body>
    <div class="box">
      <h2>Payment ${status || 'completed'}</h2>
      <p class="muted">You can return to the app.</p>
      <p class="muted">tx_ref: ${tx_ref || '-'}<br/>transaction_id: ${transaction_id || '-'}</p>
    </div>
  </body>
</html>`);
  } catch (e) {
    return res.status(200).send('OK');
  }
}

module.exports = {
  initiate,
  virtualAccount,
  verify,
  reconcile,
  webhook,
  callback,
  // exported for test/creditAlert.test.js
  extractSenderName,
  formatNaira,
  // exported for test/fundingNin.test.js
  cleanNin,
  // the 5-minute timer in server.js
  sweepPendingAccounts,
  // scripts/reconcile-paymentpoint-accounts.js
  linkProviderAccount,
  pendingView,
  isPendingRow,
  REGISTRATION_STATUS,
  // exported for test/fundingAccounts.test.js
  __test: { accountView, providerFailure, readableProviderText, classifyCreate, userForContact },
};
