const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const paymentpoint = require('./paymentpoint.service');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { revealUserFields, reveal, blindIndex, protectText, revealText } = require('../helpers/pii.helper');
const { notifyUser } = require('../services/notify.service');
const { securityEvent } = require('../services/alerts.service');
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

const REGISTRATION_STATUS = 'virtual_account';
const PROVIDER = 'paymentpoint';

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
function accountView(row) {
  const p = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};

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

/** The user's account - the newest registration with a usable one - and its row, or null. */
async function loadAccount(userId) {
  const rows = await prisma.fundingTransaction.findMany({
    where: { user_id: Number(userId), status: REGISTRATION_STATUS },
    orderBy: { id: 'desc' },
  });
  for (const row of rows) {
    const view = accountView(row);
    if (view) return { row, view };
  }
  return null;
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

async function openPaymentPointAccount(identity, nin) {
  const bankCodes = parsePaymentPointBankCodes();
  const { raw } = await paymentpoint.createVirtualAccount({
    ...identity,
    bankCode: bankCodes,
    businessId: getPaymentPointBusinessId(),
    idType: 'nin',
    idNumber: nin.nin,
  });

  const customerId = String(raw?.customer?.customer_id ?? '').trim();
  const bank = onlyOneAccount(raw?.bankAccounts)[0];
  const accountNumber = String(bank?.accountNumber ?? bank?.account_number ?? '').trim();
  if (!customerId || !accountNumber) {
    throw Object.assign(new Error('PaymentPoint did not return an account number'), { statusCode: 502 });
  }

  return {
    tx_ref: `ppcust_${customerId}`,
    // Normalised rather than the raw response, which carries the customer's
    // name, email and phone in plain text.
    payload: {
      provider: PROVIDER,
      customer_id: customerId,
      bank_code: String(bank.bankCode ?? bank.bank_code ?? bankCodes[0] ?? ''),
      bank_name: String(bank.bankName ?? bank.bank_name ?? 'PalmPay'),
      account_number: accountNumber,
      account_name_enc: protectText(String(bank.accountName ?? bank.account_name ?? '')),
      nin_idx: nin.idx,
      opened_at: new Date().toISOString(),
    },
  };
}

async function saveRegistration(userId, { tx_ref, payload }) {
  try {
    await prisma.fundingTransaction.create({
      data: {
        user_id: Number(userId),
        tx_ref,
        amount: new Prisma.Decimal('0.00'),
        currency: 'NGN',
        status: REGISTRATION_STATUS,
        raw_payload: payload,
      },
    });
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    // PaymentPoint handed back a customer we already hold. Theirs to dedupe,
    // and fine - unless it is recorded against somebody else.
    const existing = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
    if (existing && Number(existing.user_id) === Number(userId)) return;
    securityEvent('funding.va_conflict', 'Provider returned an account already registered to another user', {
      user_id: Number(userId),
      existing_user_id: existing?.user_id ?? null,
    });
    throw httpError(409, 'conflict', 'We could not finish setting up your account. Please contact support.');
  }
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
  const [account, slip] = await Promise.all([loadAccount(user.id), approvedSlip(user.id)]);
  return {
    // The shape every build of the app reads: one card per entry in
    // `bankAccounts`, and `nin_required` to decide whether to ask for a NIN.
    provider: PROVIDER,
    customer: null,
    bankAccounts: account ? [account.view] : [],
    nin_required: !slip,
    nin_on_file: Boolean(slip),
    // False when the server has no PaymentPoint keys, so the screen can say
    // so instead of offering a button that can only fail.
    available: paymentPointConfigured(),
  };
}

function sendState(res, state, message) {
  return res.json({ remark: 'virtual_account', status: 'success', message: [message], data: state });
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
    // A provider can quote a NIN, a phone or an email back in its error text.
    // None of those reach a log line.
    reason: String(e?.message || e)
      .replace(/[^\s@]+@[^\s@]+/g, '[email]')
      .replace(/\d{6,}/g, '[digits]')
      .slice(0, 200),
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
      return sendState(res, state, state.bankAccounts.length ? 'Virtual account is ready' : 'No virtual account yet');
    }

    // One user, one account: a second tap returns the first.
    if (await loadAccount(user.id)) {
      return sendState(res, await accountState(user), 'Your funding account is ready');
    }

    if (!paymentPointConfigured()) {
      throw httpError(503, 'provider_unavailable', 'PalmPay accounts are not available right now. Please try again later.');
    }

    const identity = customerIdentity(user);
    const nin = await resolveNin(user, req.body?.nin);

    await withAccountLock(user.id, async () => {
      // Re-read under the lock: a request that looked before another one
      // committed must find that account, not open a second.
      if (await loadAccount(user.id)) return;
      await saveRegistration(user.id, await openPaymentPointAccount(identity, nin));
    });

    // The one ledger-visible write that does not move money, so it is the one
    // that balance.helper's choke point never sees. Neither the dashboard nor
    // the transaction list filters on status, so this ₦0.00 row does show up in
    // both - and without this drop it would be missing from a cached list for
    // up to the TTL, on the screen the user is staring at right after asking
    // for the account.
    cache.dropUserActivity(user.id);

    return sendState(res, await accountState(user), 'Virtual account created successfully');
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

    const grossAmountDec = normalizeAmountToDecimal(
      payload?.amount_paid ??
        payload?.amountPaid ??
        payload?.amount ??
        payload?.transaction_amount ??
        payload?.transactionAmount ??
        payload?.transaction?.amount ??
        payload?.transaction?.transaction_amount
    );

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

    const virtualRef = `ppcust_${String(customerId)}`;
    const vaRecord = await prisma.fundingTransaction.findUnique({ where: { tx_ref: virtualRef } });
    if (!vaRecord) {
      console.log('PaymentPoint webhook ignored (virtual account not found)', {
        virtualRef,
      });
      return res.status(200).json({ received: true });
    }

    const tx_ref = `pp_${String(transactionId)}`;
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
  // exported for test/fundingAccounts.test.js
  __test: { accountView, providerFailure, readableProviderText },
};
