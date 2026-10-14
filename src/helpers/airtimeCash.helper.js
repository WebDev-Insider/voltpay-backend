// Airtime to Cash: everything that needs no database and no provider - the
// prices, the limits, what a customer typed and whether it is acceptable, and
// how a conversion reads on screen. The flow that moves anything is
// services/airtimeCash.service.js.
//
// Prices are worked in integer kobo, in basis points, and only turned into
// naira at the edge. 75% of ₦1,001 is ₦750.75, which is exact in kobo and not
// reliably exact in a float - and this number is what we owe somebody.
const crypto = require('crypto');
const { normalizeNgPhone } = require('./phone.helper');
const { lagosLabel } = require('./topupSchedule.helper');

/* ------------------------------------------------------------------ config */

// `Number('')` is 0, so an unset variable has to be caught before the parse -
// the same trap as kycGate's envNumber().
function envNumber(name, fallback, { min = 0, max = Infinity } = {}) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function envFlag(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * A rate as a fraction (0.75) or a percentage (75), in basis points.
 * Anything outside (0, 100%] falls back rather than paying out more airtime
 * than was received.
 */
function envRateBps(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  let n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n <= 0) n = fallback;
  if (n > 1 && n <= 100) n /= 100;
  if (n > 1) n = fallback;
  return Math.round(n * 10_000);
}

/**
 * MTN and Airtel only - the only two networks MySubWallet converts.
 *
 * `payout` and `fee` are what the customer sees. `provider` is what MySubWallet
 * credits us, used for the margin column and nothing the app ever receives.
 *
 * Airtel's provider rate is not published anywhere (2026-10-07: not on their
 * site, docs or API), so it defaults to the payout rate - a margin of zero,
 * which understates rather than invents. Set A2C_AIRTEL_PROVIDER_RATE once the
 * real figure is known.
 *
 * `defaultPin` is the PIN every line ships with. It cannot transfer airtime,
 * so a customer typing it is told to change it before anything is sent.
 */
const NETWORKS = {
  MTN: {
    code: 'MTN',
    name: 'MTN',
    label: 'MTN Nigeria',
    payout: ['A2C_MTN_PAYOUT_RATE', 0.75],
    fee: ['A2C_MTN_FEE', 100],
    provider: ['A2C_MTN_PROVIDER_RATE', 0.75],
    defaultPin: '0000',
  },
  AIRTEL: {
    code: 'AIRTEL',
    name: 'Airtel',
    label: 'Airtel Nigeria',
    payout: ['A2C_AIRTEL_PAYOUT_RATE', 0.7],
    fee: ['A2C_AIRTEL_FEE', 0],
    provider: ['A2C_AIRTEL_PROVIDER_RATE', 0.7],
    defaultPin: '1234',
  },
};

const NETWORK_CODES = Object.keys(NETWORKS);

function networkConfig(code) {
  const def = NETWORKS[code];
  if (!def) return null;
  return {
    code: def.code,
    name: def.name,
    label: def.label,
    defaultPin: def.defaultPin,
    payoutBps: envRateBps(...def.payout),
    feeKobo: Math.round(envNumber(def.fee[0], def.fee[1], { min: 0, max: 100_000 }) * 100),
    providerBps: envRateBps(...def.provider),
  };
}

/**
 * When two settings disagree the tighter one wins: a daily limit lowered to
 * ₦6,000 with the per-conversion maximum left at ₦50,000 means ₦6,000, never
 * the other way round.
 */
function limits() {
  const min = envNumber('A2C_MIN_AMOUNT', 1_000, { min: 1 });
  const daily = Math.max(min, envNumber('A2C_DAILY_LIMIT', 100_000, { min: 1 }));
  const max = Math.min(daily, Math.max(min, envNumber('A2C_MAX_AMOUNT', 50_000, { min: 1 })));
  return { min, max, daily };
}

/** The OTP window the app counts down. The spec's minute, unless configured. */
function otpTtlSeconds() {
  return envNumber('A2C_OTP_TTL_SECONDS', 60, { min: 30, max: 900 });
}

function otpMaxSends() {
  return envNumber('A2C_OTP_MAX_SENDS', 5, { min: 1, max: 20 });
}

/**
 * Digits in the code the network texts at step 1. Four (the owner, from the
 * live flow, 2026-10-12) - MySubWallet's docs only show a six-digit example.
 * The app draws this many boxes from the draft's `otp.length`, so a network
 * that changes it is an env change, not an app release.
 */
function otpLength() {
  return Math.round(envNumber('A2C_OTP_LENGTH', 4, { min: 4, max: 8 }));
}

/**
 * KYC before either end of the flow. The wallet gate keys on money funded INTO
 * the wallet, which this feature never does - cash arrives as airtime - so
 * without this an unverified account could convert and cash out without limit.
 * Airtime is also how stolen value is laundered, and MySubWallet itself asks
 * Tier 2 KYC of us before it will convert anything.
 */
function requireKyc() {
  return envFlag('A2C_REQUIRE_KYC', true);
}

/**
 * Pay out only to accounts in the customer's own name. A line's airtime leaving
 * for a stranger's bank account is the shape a stolen-airtime cash-out takes.
 */
function ownNameOnly() {
  return envFlag('A2C_PAYOUT_OWN_NAME_ONLY', true);
}

/** Processing this long without an admin unlock pages ops, once per conversion. */
function settlementAlertHours() {
  return envNumber('A2C_SETTLEMENT_ALERT_HOURS', 24, { min: 1, max: 24 * 14 });
}

// Anti-abuse ceilings. Not business settings, so constants - same as the route
// limiters.
//
// A step-1 call texts a code to ANY number it is given, so without a cap per
// line an account could use us to flood somebody's phone. Counted in Postgres
// across every account, which no per-user limiter can do.
const LINE_SENDS_PER_HOUR = 5;
// Wrong codes on one draft before it is closed and must be started again.
const MAX_OTP_ATTEMPTS = 5;
// Step-3 refusals (wrong Share PIN, too little airtime) on one verified line.
const MAX_CONVERT_ATTEMPTS = 3;
// A draft nobody has touched for this long is closed and its token dropped.
const DRAFT_TTL_MS = 30 * 60_000;
// How long a submit may sit unanswered before the sweep asks the provider.
const STRANDED_SUBMIT_MS = 10 * 60_000;
// An unconfirmed conversion is asked about this long, then handed to ops.
const UNCONFIRMED_ALERT_MS = 2 * 60 * 60_000;
const UNCONFIRMED_GIVE_UP_MS = 72 * 60 * 60_000;

/* ------------------------------------------------------------------ prices */

/**
 * What a conversion pays, all in kobo.
 *
 *   MTN    ₦1,000 x 75% - ₦100 = ₦650
 *   Airtel ₦1,000 x 70%        = ₦700
 *
 * Floored: a fraction of a kobo is never owed.
 */
function quote(network, amountNaira) {
  const cfg = networkConfig(network);
  if (!cfg) throw new Error(`Unknown network ${network}`);
  const amountKobo = Math.round(Number(amountNaira) * 100);
  const grossKobo = Math.floor((amountKobo * cfg.payoutBps) / 10_000);
  const payoutKobo = grossKobo - cfg.feeKobo;
  const providerKobo = Math.floor((amountKobo * cfg.providerBps) / 10_000);
  return {
    network: cfg.code,
    amountKobo,
    payoutBps: cfg.payoutBps,
    grossKobo,
    feeKobo: cfg.feeKobo,
    payoutKobo,
    providerBps: cfg.providerBps,
    providerKobo,
    marginKobo: providerKobo - payoutKobo,
  };
}

function rateLabel(bps) {
  const pct = Number(bps) / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** What the app shows for a network: the customer's rate and fee, nothing else. */
function publicNetwork(code) {
  const cfg = networkConfig(code);
  if (!cfg) return null;
  return {
    code: cfg.code,
    name: cfg.name,
    label: cfg.label,
    rate: cfg.payoutBps / 10_000,
    rate_bps: cfg.payoutBps,
    rate_label: rateLabel(cfg.payoutBps),
    fee: moneyStr(cfg.feeKobo),
  };
}

/* ------------------------------------------------------------------ money */

function toKobo(value) {
  const n = Number(value?.toString?.() ?? value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** "650.00" - what every API field carries. */
function moneyStr(kobo) {
  return (Number(kobo || 0) / 100).toFixed(2);
}

function naira(amount) {
  return `₦${Number(amount).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function nairaKobo(kobo) {
  return naira(Number(kobo || 0) / 100);
}

/* ------------------------------------------------------------- the input */

function parseNetwork(value) {
  const key = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key === 'MTN' || key === 'MTNNIGERIA' || key === '1') return 'MTN';
  if (key === 'AIRTEL' || key === 'AIRTELNIGERIA' || key === '2') return 'AIRTEL';
  return '';
}

function parsePhone(value) {
  return normalizeNgPhone(value);
}

/**
 * Amount check, with the quote attached - a valid amount is one that also
 * leaves something to pay out after the fee.
 */
function validateAmount(network, value) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return { ok: false, message: 'Enter the amount of airtime to convert' };
  // Their validator, and every network's transfer menu, deal in whole naira.
  if (!Number.isInteger(n)) return { ok: false, message: 'Enter a whole naira amount' };
  const { min, max } = limits();
  if (n < min) return { ok: false, message: `The minimum you can convert is ${naira(min)}` };
  if (n > max) return { ok: false, message: `The most you can convert at once is ${naira(max)}` };
  const q = quote(network, n);
  if (q.payoutKobo <= 0) return { ok: false, message: 'That amount is too small to convert after the service fee' };
  return { ok: true, amount: n, quote: q };
}

/** Exactly [otpLength] digits, or '' - a wrong-length code is refused before step 2 spends an attempt on it. */
function validateOtp(value) {
  const otp = String(value ?? '').replace(/\s+/g, '');
  return new RegExp(`^\\d{${otpLength()}}$`).test(otp) ? otp : '';
}

/**
 * The network's Share & Sell PIN - never the VoltPay PIN, never the phone's
 * unlock code. Exactly four digits on MTN and Airtel, and MySubWallet's own
 * docs name it "your 4-digit network Share-and-Sell PIN", so anything else is
 * refused here rather than spent on a step-3 attempt.
 */
function validateSharePin(network, value) {
  const pin = String(value ?? '').trim();
  if (!/^\d{4}$/.test(pin)) {
    return { ok: false, remark: 'invalid_share_pin', message: 'Enter your 4-digit Share & Sell PIN' };
  }
  const cfg = networkConfig(network);
  if (cfg && pin === cfg.defaultPin) {
    return {
      ok: false,
      remark: 'default_share_pin',
      message: `${cfg.name}'s default PIN (${cfg.defaultPin}) cannot transfer airtime. Change it first - the guide under the PIN field shows how.`,
    };
  }
  return { ok: true, pin };
}

/* ------------------------------------------------------------------ status */

const STATUS = Object.freeze({
  AWAITING_OTP: 'awaiting_otp',
  OTP_VERIFIED: 'otp_verified',
  SUBMITTING: 'submitting',
  PROCESSING: 'processing',
  AVAILABLE: 'available',
  WITHDRAWING: 'withdrawing',
  WITHDRAWN: 'withdrawn',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
});

const DRAFT_STATUSES = [STATUS.AWAITING_OTP, STATUS.OTP_VERIFIED];

/** What the customer's list shows. Drafts and abandoned attempts moved nothing. */
const VISIBLE_STATUSES = [STATUS.PROCESSING, STATUS.AVAILABLE, STATUS.WITHDRAWING, STATUS.WITHDRAWN, STATUS.FAILED];

/** Counted against the daily limit: anything that moved airtime, or may have. */
const COUNTED_STATUSES = [STATUS.SUBMITTING, STATUS.PROCESSING, STATUS.AVAILABLE, STATUS.WITHDRAWING, STATUS.WITHDRAWN];

/**
 * What the customer's history and the admin queue list. `submitting` is in it:
 * step 3 has been sent, so the airtime may already be gone, and a request that
 * died mid-call must not leave a conversion nobody can see. It is shown as
 * "Confirming with network" until it settles.
 */
const LISTED_STATUSES = [STATUS.SUBMITTING, ...VISIBLE_STATUSES];

/** The customer is owed the payout: the conversion counts as recorded and credited. */
const CREDITED_STATUSES = [STATUS.PROCESSING, STATUS.AVAILABLE, STATUS.WITHDRAWING, STATUS.WITHDRAWN];

/**
 * States a provider success can be recorded from - by the reconcile pass or an
 * admin - provided step 3 was actually sent (`convert_attempts >= 1`).
 * `failed` is in it because an admin can mark one failed that MySubWallet in
 * fact credited, and that has to be undoable.
 */
const RECORDABLE_STATUSES = [STATUS.SUBMITTING, STATUS.OTP_VERIFIED, STATUS.ABANDONED, STATUS.FAILED];

const STATUS_LABELS = {
  awaiting_otp: 'Awaiting code',
  otp_verified: 'Line verified',
  submitting: 'Converting',
  processing: 'Processing settlement',
  available: 'Available',
  withdrawing: 'Withdrawing',
  withdrawn: 'Withdrawn',
  failed: 'Failed',
  abandoned: 'Not completed',
};

function isConfirmed(row) {
  return row?.provider_status === 'confirmed';
}

function statusLabel(row) {
  if (row?.status === STATUS.SUBMITTING) return 'Confirming with network';
  if (row?.status === STATUS.PROCESSING && !isConfirmed(row)) return 'Confirming with network';
  return STATUS_LABELS[row?.status] || String(row?.status || '');
}

const WITHDRAWAL_LABELS = {
  pending: 'Submitting',
  processing: 'Processing',
  success: 'Successful',
  failed: 'Failed',
  reversed: 'Reversed',
};

/**
 * The four steps the details screen draws:
 *   Airtime transferred -> Network settlement -> Available -> Withdrawn
 *
 * Each step is done | current | pending | failed, with the Lagos time it
 * happened when it has.
 */
function timeline(row, { withdrawal = null } = {}) {
  const status = row?.status;
  const network = networkConfig(row?.network)?.name || row?.network || '';
  const converted = Boolean(row?.converted_at) || [STATUS.PROCESSING, STATUS.AVAILABLE, STATUS.WITHDRAWING, STATUS.WITHDRAWN].includes(status);
  const reachedAvailable = [STATUS.AVAILABLE, STATUS.WITHDRAWING, STATUS.WITHDRAWN].includes(status);
  const failed = status === STATUS.FAILED;

  const step = (key, title, subtitle, state, at) => ({
    key,
    title,
    subtitle,
    state,
    at: at || null,
    at_label: at ? lagosLabel(at) : '',
  });

  const amountText = row?.amount != null ? `${nairaKobo(toKobo(row.amount))} ${network} airtime received` : `${network} airtime received`;

  const steps = [];
  if (failed && !converted) {
    steps.push(step('converted', 'Airtime transferred', row?.failure_reason || 'The transfer did not complete', 'failed', row?.failed_at));
  } else {
    steps.push(step('converted', 'Airtime transferred', amountText, converted ? 'done' : 'current', row?.converted_at || row?.submitted_at));
  }

  let settlingState = 'pending';
  let settlingText = `Your cash settles with ${network} before it can be withdrawn`;
  if (failed && converted) {
    settlingState = 'failed';
    settlingText = row?.failure_reason || 'Settlement did not complete';
  } else if (reachedAvailable) {
    settlingState = 'done';
    settlingText = 'Settlement complete';
  } else if (status === STATUS.PROCESSING) {
    settlingState = 'current';
    settlingText = isConfirmed(row)
      ? `Settling with ${network}. We will notify you the moment it is ready.`
      : `Confirming the transfer with ${network}. We will notify you as soon as it is confirmed.`;
  }
  steps.push(step('settling', 'Network settlement', settlingText, settlingState, reachedAvailable ? row?.available_at : null));

  steps.push(
    step(
      'available',
      'Available for withdrawal',
      reachedAvailable ? 'Ready to withdraw to your bank' : 'Unlocks once settlement completes',
      reachedAvailable ? (status === STATUS.AVAILABLE ? 'current' : 'done') : failed ? 'failed' : 'pending',
      row?.available_at,
    ),
  );

  const bankText = withdrawal?.bank_name
    ? `${withdrawal.bank_name}${withdrawal.account_last4 ? ` ****${withdrawal.account_last4}` : ''}`
    : 'your bank';
  let withdrawnState = 'pending';
  let withdrawnText = 'Withdraw to any bank account in your name';
  if (status === STATUS.WITHDRAWN) {
    withdrawnState = 'done';
    withdrawnText = `Sent to ${bankText}`;
  } else if (status === STATUS.WITHDRAWING) {
    withdrawnState = 'current';
    withdrawnText = `On its way to ${bankText}`;
  } else if (failed) {
    withdrawnState = 'failed';
    withdrawnText = 'Nothing to withdraw';
  }
  steps.push(step('withdrawn', 'Withdrawn to bank', withdrawnText, withdrawnState, row?.withdrawn_at));

  return steps;
}

/* ------------------------------------------------------------- references */

/** A2C-<time><random>: the customer's reference, and step 3's first request-id. */
function newReference() {
  return `A2C-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * The request-id for step-3 attempt `n`. A fresh one per attempt, because a
 * reused request-id is MySubWallet's idempotency key: retrying a wrong-PIN
 * attempt under the same id would be answered with the first refusal.
 */
function requestIdFor(reference, attempt) {
  return attempt <= 1 ? reference : `${reference}-${attempt}`;
}

/**
 * Paystack transfer references are lowercase alphanumerics, `-` and `_`, at
 * least 16 characters. The prefix is how the shared Paystack webhook knows the
 * event is ours.
 */
const WITHDRAWAL_PREFIX = 'a2cw-';

function newWithdrawalReference() {
  return `${WITHDRAWAL_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function isWithdrawalReference(reference) {
  return String(reference || '').toLowerCase().startsWith(WITHDRAWAL_PREFIX);
}

/* ---------------------------------------------------------------- display */

function maskAccount(last4) {
  const tail = String(last4 || '').replace(/\D/g, '').slice(-4);
  return tail ? `****${tail}` : '';
}

/** NUBAN is exactly 10 digits. */
function cleanAccountNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

module.exports = {
  NETWORK_CODES,
  networkConfig,
  publicNetwork,
  limits,
  otpTtlSeconds,
  otpMaxSends,
  otpLength,
  requireKyc,
  ownNameOnly,
  settlementAlertHours,
  LINE_SENDS_PER_HOUR,
  MAX_OTP_ATTEMPTS,
  MAX_CONVERT_ATTEMPTS,
  DRAFT_TTL_MS,
  STRANDED_SUBMIT_MS,
  UNCONFIRMED_ALERT_MS,
  UNCONFIRMED_GIVE_UP_MS,
  quote,
  rateLabel,
  toKobo,
  moneyStr,
  naira,
  nairaKobo,
  parseNetwork,
  parsePhone,
  validateAmount,
  validateOtp,
  validateSharePin,
  STATUS,
  DRAFT_STATUSES,
  VISIBLE_STATUSES,
  COUNTED_STATUSES,
  LISTED_STATUSES,
  CREDITED_STATUSES,
  RECORDABLE_STATUSES,
  STATUS_LABELS,
  WITHDRAWAL_LABELS,
  isConfirmed,
  statusLabel,
  timeline,
  newReference,
  requestIdFor,
  newWithdrawalReference,
  isWithdrawalReference,
  WITHDRAWAL_PREFIX,
  maskAccount,
  cleanAccountNumber,
};
