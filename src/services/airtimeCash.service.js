/**
 * Airtime to Cash - the engine. One copy, called by the customer's routes, the
 * admin routes, the Paystack webhook and the sweep.
 *
 *   convert   OTP to the line -> code checked -> airtime moved (MySubWallet)
 *             -> `processing`: the customer is owed `payout`, withdraw locked
 *   unlock    an admin moves the money from MySubWallet to Paystack and marks
 *             it `available` - never automatic, because until that transfer
 *             has happened Paystack may not hold it
 *   withdraw  one Paystack transfer pays out one or more available
 *             conversions to a bank account in the customer's name
 *
 * Rules that must not be relaxed:
 *   - Every status change is a guarded updateMany - `where: { id, status }` -
 *     so of two callers racing on one row (two taps, two instances, the poll
 *     and the webhook) exactly one moves it, and only that one tells anybody.
 *   - An outcome nobody could read is never a failure. Step 3 that times out
 *     may have taken the airtime; a transfer that times out may have paid. Both
 *     stay in flight and are asked about again until the provider answers.
 *   - Owed money is always somewhere: a conversion is processing, available,
 *     in exactly one live withdrawal, or withdrawn. A failed or reversed
 *     transfer hands its conversions back to `available` in the same
 *     transaction that marks it failed.
 *   - None of this touches users.balance or wallet_transactions. See the model
 *     comment in schema.prisma.
 *   - The Share & Sell PIN goes to MySubWallet and nowhere else: not a column,
 *     not a log line, not an idempotency fingerprint.
 */
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const msw = require('../funding/mysubwallet.service');
const paystack = require('../funding/paystack.service');
const A2C = require('../helpers/airtimeCash.helper');
const { encryptValue, reveal, blindIndex, protectText, revealText, verifySecret, revealUserFields } = require('../helpers/pii.helper');
const { matchName, profileName } = require('../helpers/nameMatch.helper');
const { isKycVerified } = require('../helpers/kycGate.helper');
const { withDirectFallback } = require('../helpers/prismaDirect.helper');
const { lagosLabel, displayPhone, maskPhone } = require('../helpers/topupSchedule.helper');
const { notifyUser } = require('./notify.service');
const { paymentFailure, captureError, securityEvent } = require('./alerts.service');
const { logUserEvent } = require('./userAudit.service');

const { STATUS } = A2C;

// A withdrawal row with no answer from Paystack for this long is presumed
// never to have reached it - same window and same reasoning as StaffPay's
// stranded payroll items.
const STRANDED_TRANSFER_MS = Math.max(60_000, Number(process.env.A2C_STRANDED_TRANSFER_MS) || 10 * 60_000);

function fail(statusCode, remark, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, remark, ...extra });
}

const dec = kobo => new Prisma.Decimal((Number(kobo || 0) / 100).toFixed(2));

function safeReveal(enc) {
  try {
    return reveal(enc) || '';
  } catch {
    return '';
  }
}

const revealPhone = row => safeReveal(row?.phone_enc);

/** Their wording, kept for operators. Trimmed, and never shown as-is. */
function trimmed(text) {
  const t = String(text || '').trim();
  return t ? t.slice(0, 240) : null;
}

function notify(userId, key, subject, message, data = {}) {
  return notifyUser({
    userId,
    subject,
    message,
    type: 'airtime_cash',
    data,
    clientMessageId: key,
  }).catch(() => false);
}

/* ------------------------------------------------------------------ events */

/**
 * One line of a conversion's trail. Outside a transaction it fails open - the
 * status change it describes has already happened - and inside one the caller
 * uses createMany directly, because a caught failure there would abort every
 * statement after it.
 */
async function recordEvent(conversionId, event, { from = null, to = null, actor = 'system', note = null, meta = null } = {}) {
  try {
    await prisma.airtimeCashEvent.create({
      data: {
        conversion_id: Number(conversionId),
        event,
        from_status: from,
        to_status: to,
        actor,
        note: note ? protectText(note) : null,
        meta,
      },
    });
  } catch (e) {
    console.error('airtimeCash: event write failed', { conversion_id: conversionId, event, message: e?.message });
  }
}

/**
 * Move one conversion from one of `from` to `to`. The guarded updateMany is
 * the claim: false means somebody else got there first, and the caller must
 * not notify or record anything.
 */
async function transition(row, from, to, data = {}, { event = 'status', actor = 'system', note = null, meta = null } = {}) {
  const fromList = Array.isArray(from) ? from : [from];
  const claimed = await prisma.airtimeCashConversion.updateMany({
    where: { id: row.id, status: { in: fromList } },
    data: { ...data, status: to },
  });
  if (!claimed?.count) return false;
  await recordEvent(row.id, event, { from: row.status, to, actor, note, meta });
  return true;
}

/* ------------------------------------------------------------------ shapes */

function publicWithdrawal(w) {
  if (!w) return null;
  return {
    id: w.id,
    reference: w.reference,
    amount: A2C.moneyStr(A2C.toKobo(w.amount)),
    fee: A2C.moneyStr(A2C.toKobo(w.fee)),
    status: w.status,
    status_label: A2C.WITHDRAWAL_LABELS[w.status] || w.status,
    bank_name: w.bank_name || '',
    account_masked: A2C.maskAccount(w.account_last4),
    // The customer's own name, matched to their profile before we paid it.
    account_name: safeReveal(w.account_name_enc),
    conversion_count: w.conversion_count,
    failure_reason: ['failed', 'reversed'].includes(w.status) ? w.failure_reason || null : null,
    created_at: w.created_at,
    created_label: lagosLabel(w.created_at),
    completed_at: w.completed_at,
    completed_label: w.completed_at ? lagosLabel(w.completed_at) : '',
  };
}

/**
 * A conversion as the customer sees it. The line comes back in full because it
 * is their own; margin, provider rate and the token never leave the server.
 */
function publicConversion(row, { withdrawal = null, timeline = false } = {}) {
  const cfg = A2C.networkConfig(row.network);
  const phone = revealPhone(row);
  const priced = row.payout != null;
  const out = {
    id: row.id,
    reference: row.reference,
    network: row.network,
    network_name: cfg?.name || row.network,
    network_label: cfg?.label || row.network,
    phone_display: displayPhone(phone),
    phone_masked: maskPhone(phone),
    amount: priced ? A2C.moneyStr(A2C.toKobo(row.amount)) : null,
    rate_label: A2C.rateLabel(row.payout_rate_bps || cfg?.payoutBps || 0),
    fee: priced ? A2C.moneyStr(A2C.toKobo(row.fee)) : null,
    payout: priced ? A2C.moneyStr(A2C.toKobo(row.payout)) : null,
    // A step 3 still in flight reads to the customer as what it most likely
    // is: a conversion being confirmed. Installed apps know `processing`.
    status: row.status === STATUS.SUBMITTING ? STATUS.PROCESSING : row.status,
    status_label: A2C.statusLabel(row),
    confirmed: row.status !== STATUS.SUBMITTING && A2C.isConfirmed(row),
    withdrawable: row.status === STATUS.AVAILABLE,
    failure_reason: row.status === STATUS.FAILED ? row.failure_reason || null : null,
    created_at: row.created_at,
    created_label: lagosLabel(row.created_at),
    converted_at: row.converted_at,
    converted_label: row.converted_at ? lagosLabel(row.converted_at) : '',
    available_at: row.available_at,
    available_label: row.available_at ? lagosLabel(row.available_at) : '',
    withdrawn_at: row.withdrawn_at,
    withdrawn_label: row.withdrawn_at ? lagosLabel(row.withdrawn_at) : '',
    withdrawal: publicWithdrawal(withdrawal),
  };
  if (timeline) out.timeline = A2C.timeline(row, { withdrawal });
  return out;
}

/**
 * The OTP window, in seconds rather than as a timestamp: the app counts down
 * from what the server says, so a phone with the wrong clock still shows the
 * right minute.
 */
function otpState(row, now = Date.now()) {
  const expiresAt = row?.otp_expires_at ? new Date(row.otp_expires_at).getTime() : 0;
  const expiresIn = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const sendsLeft = Math.max(0, A2C.otpMaxSends() - Number(row?.otp_sends || 0));
  return {
    expires_in: expiresIn,
    ttl_seconds: A2C.otpTtlSeconds(),
    // How many boxes the app draws - the network's code length.
    length: A2C.otpLength(),
    // Resend opens when the code expires, not before: one live code at a time.
    can_resend: expiresIn === 0 && sendsLeft > 0,
    sends_left: sendsLeft,
    attempts_left: Math.max(0, A2C.MAX_OTP_ATTEMPTS - Number(row?.otp_attempts || 0)),
  };
}

function publicDraft(row) {
  const cfg = A2C.networkConfig(row.network);
  return {
    id: row.id,
    reference: row.reference,
    network: row.network,
    network_name: cfg?.name || row.network,
    phone_display: displayPhone(revealPhone(row)),
    status: row.status,
    verified: row.status === STATUS.OTP_VERIFIED,
    otp: otpState(row),
    convert_attempts_left: Math.max(0, A2C.MAX_CONVERT_ATTEMPTS - Number(row.convert_attempts || 0)),
  };
}

/* ---------------------------------------------------------------- policy */

async function assertKyc(userId) {
  if (!A2C.requireKyc()) return;
  if (await isKycVerified(userId)) return;
  // `kyc_required` is the remark the app's interceptor turns into the
  // verification prompt, on any route.
  throw fail(
    403,
    'kyc_required',
    'Verify your identity and your bank account to use Airtime to Cash. It only takes a few minutes in Settings.',
    { data: { reason: 'kyc_required' } },
  );
}

/** Texts sent to one line in the last hour, across every account. */
async function assertLineBudget(phoneIdx) {
  const since = new Date(Date.now() - 60 * 60_000);
  const sent = await prisma.airtimeCashConversion.aggregate({
    where: { phone_idx: phoneIdx, created_at: { gte: since } },
    _sum: { otp_sends: true },
  });
  if (Number(sent?._sum?.otp_sends || 0) >= A2C.LINE_SENDS_PER_HOUR) {
    throw fail(429, 'otp_limit', 'Too many codes have been sent to this line. Please try again in an hour.');
  }
}

/**
 * A line converting for a second account is worth a look - one person
 * operating several wallets, or somebody else's SIM. Visibility only: the OTP
 * proves whoever is converting holds the SIM right now.
 */
async function flagSharedLine(userId, phoneIdx) {
  try {
    const other = await prisma.airtimeCashConversion.findFirst({
      where: { phone_idx: phoneIdx, user_id: { not: userId }, status: { in: A2C.COUNTED_STATUSES } },
      select: { user_id: true },
    });
    if (other) {
      securityEvent('airtime_cash.shared_line', 'One line is converting airtime for more than one account', {
        user_id: userId,
        other_user_id: other.user_id,
      });
    }
  } catch {
    /* a fraud signal never blocks the conversion it describes */
  }
}

async function assertDailyLimit(userId, amount) {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const agg = await prisma.airtimeCashConversion.aggregate({
    where: { user_id: Number(userId), status: { in: A2C.COUNTED_STATUSES }, submitted_at: { gte: since } },
    _sum: { amount: true },
  });
  const used = Number(agg?._sum?.amount?.toString?.() ?? agg?._sum?.amount ?? 0);
  const { daily } = A2C.limits();
  if (used + amount > daily) {
    const left = Math.max(0, daily - used);
    throw fail(
      400,
      'daily_limit',
      left > 0
        ? `You can convert up to ${A2C.naira(left)} more today.`
        : `You have reached today's limit of ${A2C.naira(daily)}. Please try again tomorrow.`,
    );
  }
}

/** Our float or our key - an incident, not a decline. Ops hear about it. */
function alertProvider(e, { reference, userId, action, amount = null }) {
  if (!(e?.misconfigured || e?.floatExhausted)) return;
  paymentFailure({
    provider: 'mysubwallet',
    action,
    reference,
    userId,
    amount,
    message: e.providerMessage || e.message,
    context: { feature: 'airtime_cash' },
  });
}

/** A provider error in this module's shape. Its message is already customer-safe. */
function providerFail(e, remark) {
  if (e?.remark) return e;
  const status = Number(e?.statusCode) || 502;
  const outage = e?.kind === 'outage' || e?.misconfigured || e?.ambiguous || status >= 500 || status === 429;
  return fail(outage ? 503 : 400, outage ? 'service_unavailable' : remark, e?.message || 'Please try again shortly.');
}

async function findOwned(userId, id) {
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  return prisma.airtimeCashConversion.findFirst({ where: { id: cid, user_id: Number(userId) } });
}

function tokenOf(row) {
  const token = safeReveal(row?.provider_token_enc);
  if (!token) throw fail(410, 'session_expired', 'Your verification has expired. Request a new code to continue.');
  return token;
}

/* ----------------------------------------------------------------- the OTP */

async function sendOtp(row, phoneLocal) {
  let started;
  try {
    started = await msw.startAirtimeCash({ network: row.network, phone: phoneLocal, format: row.phone_format || undefined });
  } catch (e) {
    alertProvider(e, { reference: row.reference, userId: row.user_id, action: 'airtime_cash_otp' });
    await recordEvent(row.id, 'otp_failed', { from: row.status, to: row.status, meta: { kind: e?.kind || null } });
    throw providerFail(e, 'otp_not_sent');
  }

  const now = new Date();
  const updated = await prisma.airtimeCashConversion.update({
    where: { id: row.id },
    data: {
      status: STATUS.AWAITING_OTP,
      provider_token_enc: encryptValue(started.token),
      phone_format: started.phoneFormat,
      otp_sent_at: now,
      otp_expires_at: new Date(now.getTime() + A2C.otpTtlSeconds() * 1000),
      otp_sends: { increment: 1 },
      otp_attempts: 0,
    },
  });
  await recordEvent(row.id, 'otp_sent', { from: row.status, to: STATUS.AWAITING_OTP, actor: 'user', meta: { send: updated.otp_sends } });
  return updated;
}

/**
 * Step 1: a new draft and a code to the line. Any earlier draft of this
 * customer's is closed first - one live code per person, so a stuck screen
 * cannot be used to keep texting a number.
 */
async function startConversion({ userId, network, phone }) {
  const uid = Number(userId);
  const code = A2C.parseNetwork(network);
  if (!code) throw fail(400, 'validation_error', 'Choose MTN or Airtel');
  const line = A2C.parsePhone(phone);
  if (!line) throw fail(400, 'validation_error', 'Enter a valid Nigerian phone number');

  await assertKyc(uid);

  const phoneIdx = blindIndex(line.local, 'mobile');
  await assertLineBudget(phoneIdx);
  await flagSharedLine(uid, phoneIdx);

  await prisma.airtimeCashConversion.updateMany({
    where: { user_id: uid, status: { in: A2C.DRAFT_STATUSES } },
    data: { status: STATUS.ABANDONED, provider_token_enc: null },
  });

  const draft = await prisma.airtimeCashConversion.create({
    data: {
      user_id: uid,
      reference: A2C.newReference(),
      network: code,
      phone_enc: encryptValue(line.local),
      phone_idx: phoneIdx,
      status: STATUS.AWAITING_OTP,
    },
  });

  try {
    return await sendOtp(draft, line.local);
  } catch (e) {
    // Nothing was sent, so there is nothing to resend to. The next tap starts
    // a fresh draft - usually with the number corrected.
    await prisma.airtimeCashConversion.updateMany({
      where: { id: draft.id, status: STATUS.AWAITING_OTP, otp_sends: 0 },
      data: { status: STATUS.ABANDONED },
    });
    throw e;
  }
}

/** Another code, once the last one has expired. */
async function resendOtp({ userId, id }) {
  const row = await findOwned(userId, id);
  if (!row || row.status !== STATUS.AWAITING_OTP) throw fail(404, 'not_found', 'Start again to get a new code');
  await assertKyc(row.user_id);

  const state = otpState(row);
  if (state.expires_in > 0) {
    throw fail(429, 'otp_not_expired', `You can request a new code in ${state.expires_in} seconds`, { data: { otp: state } });
  }
  if (state.sends_left <= 0) {
    await transition(row, STATUS.AWAITING_OTP, STATUS.ABANDONED, { provider_token_enc: null }, { meta: { reason: 'otp_sends_exhausted' } });
    throw fail(429, 'otp_limit', 'Too many codes requested for this conversion. Please start again in a few minutes.');
  }
  await assertLineBudget(row.phone_idx);

  // Claim the resend: two taps at once would otherwise text two codes. The
  // guard has to read a column the claim itself changes - "the last code has
  // expired" - or the second tap matches the same row and sends too. The brief
  // expiry it writes is a soft lock that a failed send simply lets lapse.
  const now = new Date();
  const claimed = await prisma.airtimeCashConversion.updateMany({
    where: {
      id: row.id,
      status: STATUS.AWAITING_OTP,
      otp_sends: row.otp_sends,
      OR: [{ otp_expires_at: null }, { otp_expires_at: { lte: now } }],
    },
    data: { otp_expires_at: new Date(now.getTime() + 15_000) },
  });
  if (!claimed?.count) throw fail(409, 'busy', 'A new code is already on its way');

  return sendOtp(row, revealPhone(row));
}

/** Step 2. A wrong code keeps the draft open until the attempts run out. */
async function verifyOtp({ userId, id, otp }) {
  const code = A2C.validateOtp(otp);
  if (!code) throw fail(400, 'validation_error', `Enter the ${A2C.otpLength()}-digit code sent to the line`);

  const row = await findOwned(userId, id);
  if (!row) throw fail(404, 'not_found', 'Start again to get a new code');
  if (row.status === STATUS.OTP_VERIFIED) return row;
  if (row.status !== STATUS.AWAITING_OTP) throw fail(409, 'invalid_state', 'Start again to get a new code');

  if (!row.otp_expires_at || new Date(row.otp_expires_at).getTime() <= Date.now()) {
    throw fail(410, 'otp_expired', 'This code has expired. Request a new one.', { data: { otp: otpState(row) } });
  }
  if (Number(row.otp_attempts || 0) >= A2C.MAX_OTP_ATTEMPTS) {
    await transition(row, STATUS.AWAITING_OTP, STATUS.ABANDONED, { provider_token_enc: null }, { meta: { reason: 'otp_attempts_exhausted' } });
    throw fail(429, 'otp_attempts', 'Too many wrong codes. Please start again.');
  }

  const token = tokenOf(row);

  // The attempt is counted before the provider is asked, and the count is the
  // claim: two submits of one code cannot both reach step 2.
  const claimed = await prisma.airtimeCashConversion.updateMany({
    where: { id: row.id, status: STATUS.AWAITING_OTP, otp_attempts: row.otp_attempts },
    data: { otp_attempts: { increment: 1 } },
  });
  if (!claimed?.count) throw fail(409, 'busy', 'That code is already being checked');

  let verified;
  try {
    verified = await msw.verifyAirtimeCashOtp({
      network: row.network,
      phone: revealPhone(row),
      format: row.phone_format,
      otp: code,
      token,
    });
  } catch (e) {
    alertProvider(e, { reference: row.reference, userId: row.user_id, action: 'airtime_cash_verify' });
    await recordEvent(row.id, 'otp_failed', { from: row.status, to: row.status, actor: 'user', meta: { attempt: row.otp_attempts + 1, kind: e?.kind || null } });
    if (e?.sessionExpired) {
      await transition(row, STATUS.AWAITING_OTP, STATUS.ABANDONED, { provider_token_enc: null }, { meta: { reason: 'session_expired' } });
      throw fail(410, 'session_expired', e.message);
    }
    const err = providerFail(e, 'otp_invalid');
    err.data = { otp: otpState({ ...row, otp_attempts: Number(row.otp_attempts || 0) + 1 }) };
    throw err;
  }

  const moved = await transition(
    row,
    STATUS.AWAITING_OTP,
    STATUS.OTP_VERIFIED,
    { provider_token_enc: encryptValue(verified.token), otp_verified_at: new Date() },
    { event: 'otp_verified', actor: 'user' },
  );
  if (!moved) throw fail(409, 'invalid_state', 'Start again to get a new code');
  return prisma.airtimeCashConversion.findUnique({ where: { id: row.id } });
}

/* -------------------------------------------------------------- converting */

function notifyConverted(row, providerStatus) {
  const cfg = A2C.networkConfig(row.network);
  const amount = A2C.nairaKobo(A2C.toKobo(row.amount));
  const payout = A2C.nairaKobo(A2C.toKobo(row.payout));
  if (providerStatus === 'confirmed') {
    return notify(
      row.user_id,
      `a2c:${row.id}:processing`,
      'Airtime converted',
      `Your ${amount} ${cfg?.name || row.network} airtime was converted. ${payout} is pending and will be ready to withdraw once settlement completes.`,
      { conversion_id: row.id, status: STATUS.PROCESSING },
    );
  }
  return notify(
    row.user_id,
    `a2c:${row.id}:confirming`,
    'Confirming your conversion',
    `We are confirming your ${amount} ${cfg?.name || row.network} airtime transfer with the network. We will update you as soon as it is confirmed.`,
    { conversion_id: row.id, status: STATUS.PROCESSING },
  );
}

/**
 * submitting -> processing. `providerStatus` says how sure we are: confirmed
 * (their answer said credited), pending (accepted, still going) or unknown (no
 * readable answer). Only confirmed rows can be unlocked without an admin
 * explicitly vouching for them.
 */
async function markConverted(row, { providerStatus, credited = null, via, message = null }) {
  const data = {
    provider_status: providerStatus,
    converted_at: new Date(),
    provider_checked_at: new Date(),
    provider_token_enc: null,
    // Their words, for whoever confirms it on MySubWallet's side.
    ...(message ? { provider_message: trimmed(message) } : {}),
  };
  if (credited != null && Number.isFinite(Number(credited))) {
    const creditKobo = Math.round(Number(credited) * 100);
    data.provider_credit = dec(creditKobo);
    data.margin = dec(creditKobo - A2C.toKobo(row.payout));
  }
  const moved = await transition(row, STATUS.SUBMITTING, STATUS.PROCESSING, data, { meta: { provider_status: providerStatus, via } });
  if (moved) await notifyConverted(row, providerStatus);
  return moved;
}

// In-request tries at the write that records a conversion MySubWallet has
// already answered for, then later tries on a timer. Past both, the row is
// still `submitting` with its request-id, and the sweep records it.
const RECORD_TRIES = 3;
const RECORD_RETRY_MS = Math.max(0, Number(process.env.A2C_RECORD_RETRY_MS ?? 400));
const LATE_RECORD_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Record a conversion MySubWallet has answered for. The one write in this file
 * that must not be lost: by now the customer's airtime may have left the line,
 * and a row left in `submitting` is a conversion nobody can see.
 *
 * Retried in the request (a blip on the database), then on a timer (a longer
 * outage, if this process lives), and past both the stranded-submit sweep
 * finds the row by its `submitting` status and records it - with the weaker
 * "unknown" it can prove by then. Every path ends in a visible row; the guarded
 * transition makes each of them a no-op once one has landed.
 *
 * Returns true once recorded, false when it is left to the timer and the sweep.
 */
async function recordConversion(row, outcome) {
  for (let attempt = 1; attempt <= RECORD_TRIES; attempt += 1) {
    try {
      await markConverted(row, outcome);
      return true;
    } catch (e) {
      if (attempt === RECORD_TRIES) {
        captureError('airtime_cash.record_failed', e, {
          conversion_id: row.id,
          reference: row.reference,
          provider_status: outcome.providerStatus,
        });
        scheduleLateRecord(row, outcome, 0);
        return false;
      }
      await pause(RECORD_RETRY_MS * attempt);
    }
  }
  return false;
}

function scheduleLateRecord(row, outcome, index) {
  const delay = LATE_RECORD_DELAYS_MS[index];
  if (delay == null) return;
  const timer = setTimeout(() => {
    markConverted(row, outcome).catch(() => scheduleLateRecord(row, outcome, index + 1));
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/** The row as it now stands - or, with the database unreachable, as we know it to be. */
async function reloadOr(row, fallback) {
  try {
    return (await prisma.airtimeCashConversion.findUnique({ where: { id: row.id } })) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Step 3, and the only step that moves anything.
 *
 * A retried request after a lost answer gets the conversion as it now stands
 * rather than a second transfer: the status is the guard, and the
 * idempotency key on the route is the belt over it.
 */
async function convert({ userId, id, amount, sharePin, req = null }) {
  const row = await findOwned(userId, id);
  if (!row) throw fail(404, 'not_found', 'Conversion not found');

  if (A2C.VISIBLE_STATUSES.includes(row.status)) return { row, replay: true };
  if (row.status === STATUS.SUBMITTING) throw fail(409, 'in_progress', 'This conversion is already being processed');
  if (row.status !== STATUS.OTP_VERIFIED) throw fail(409, 'invalid_state', 'Verify the line with a code first');

  const checked = A2C.validateAmount(row.network, amount);
  if (!checked.ok) throw fail(400, 'validation_error', checked.message);
  const pin = A2C.validateSharePin(row.network, sharePin);
  if (!pin.ok) throw fail(400, pin.remark, pin.message);

  await assertKyc(row.user_id);
  await assertDailyLimit(row.user_id, checked.amount);
  const token = tokenOf(row);

  const q = checked.quote;
  const attempt = Number(row.convert_attempts || 0) + 1;
  const requestId = A2C.requestIdFor(row.reference, attempt);

  // The claim, and the price, in one statement: written before the provider is
  // called, so a process that dies mid-call leaves the request-id the sweep
  // needs to ask what happened.
  const claimed = await prisma.airtimeCashConversion.updateMany({
    where: { id: row.id, status: STATUS.OTP_VERIFIED, convert_attempts: row.convert_attempts },
    data: {
      status: STATUS.SUBMITTING,
      convert_attempts: attempt,
      submitted_at: new Date(),
      provider_request_id: requestId,
      amount: dec(q.amountKobo),
      payout_rate_bps: q.payoutBps,
      fee: dec(q.feeKobo),
      payout: dec(q.payoutKobo),
      provider_rate_bps: q.providerBps,
      provider_credit: dec(q.providerKobo),
      margin: dec(q.marginKobo),
    },
  });
  if (!claimed?.count) {
    const fresh = await findOwned(userId, id);
    if (fresh && A2C.VISIBLE_STATUSES.includes(fresh.status)) return { row: fresh, replay: true };
    throw fail(409, 'in_progress', 'This conversion is already being processed');
  }

  const submitted = {
    ...row,
    status: STATUS.SUBMITTING,
    convert_attempts: attempt,
    provider_request_id: requestId,
    amount: q.amountKobo / 100,
    fee: q.feeKobo / 100,
    payout: q.payoutKobo / 100,
  };
  await recordEvent(row.id, 'status', {
    from: STATUS.OTP_VERIFIED,
    to: STATUS.SUBMITTING,
    actor: 'user',
    meta: { attempt, amount: checked.amount },
  });

  let result;
  try {
    result = await msw.completeAirtimeCash({
      network: row.network,
      phone: revealPhone(row),
      format: row.phone_format,
      token,
      sharePin: pin.pin,
      amount: checked.amount,
      reference: requestId,
    });
  } catch (e) {
    return submitFailed({ row: submitted, error: e, attempt, req });
  }

  const providerStatus = result.status === 'successful' ? 'confirmed' : 'pending';
  const via = result.accepted ? 'accepted' : result.recovered ? 'requery' : 'submit';
  const recorded = await recordConversion(submitted, { providerStatus, credited: result.credited, via, message: result.message });

  await logUserEvent({
    req,
    userId: row.user_id,
    event: 'airtime_cash.converted',
    metadata: { conversion_id: row.id, reference: row.reference, network: row.network, amount: checked.amount, payout: q.payoutKobo / 100, provider_status: providerStatus },
  });

  const shown = { ...submitted, status: STATUS.PROCESSING, provider_status: providerStatus, converted_at: new Date() };
  return {
    row: recorded ? await reloadOr(row, shown) : shown,
    replay: false,
    unconfirmed: providerStatus !== 'confirmed',
    // MySubWallet took it, our write did not land yet: the customer is told
    // it was received rather than shown an error they would retry from.
    deferred: !recorded,
  };
}

/**
 * Step 3 did not come back with a yes.
 *
 * Unreadable - or a refusal whose words do not prove nothing moved: the airtime
 * may be gone, so it is kept - processing, unconfirmed, visible to the customer
 * and to ops - and settled by somebody who can see MySubWallet's side.
 *
 * Only a refusal the adapter can prove moved nothing (the PIN, the line's
 * airtime, their validator, a lapsed session) rolls back: the line stays
 * verified for another try, until the attempts run out or the verification
 * itself has lapsed.
 */
async function submitFailed({ row, error: e, attempt, req }) {
  // Never logged with the message: their words can quote the customer's line.
  const diagnosis = { http: e?.httpStatus ?? null, provider_status: e?.mysubwallet?.status ?? null };

  if (e?.ambiguous) {
    const via = e.unclassified ? 'unclassified_refusal' : 'ambiguous';
    console.warn('airtimeCash: step 3 outcome unknown, kept as unconfirmed', { conversion_id: row.id, reference: row.reference, via, ...diagnosis });
    const recorded = await recordConversion(row, { providerStatus: 'unknown', via, message: e.providerMessage });
    await logUserEvent({
      req,
      userId: row.user_id,
      event: 'airtime_cash.converted',
      metadata: { conversion_id: row.id, reference: row.reference, network: row.network, amount: A2C.toKobo(row.amount) / 100, provider_status: 'unknown' },
    });
    const shown = { ...row, status: STATUS.PROCESSING, provider_status: 'unknown', converted_at: new Date() };
    return { row: recorded ? await reloadOr(row, shown) : shown, replay: false, unconfirmed: true, deferred: !recorded };
  }

  alertProvider(e, { reference: row.reference, userId: row.user_id, action: 'airtime_cash_convert', amount: A2C.toKobo(row.amount) / 100 });

  const err = providerFail(e, 'convert_declined');
  if (e?.sessionExpired) err.remark = 'session_expired';
  else if (e?.dailyLimit) err.remark = 'line_daily_limit';
  else if (e?.lineBalance) err.remark = 'insufficient_airtime';
  else if (e?.wrongPin) err.remark = 'wrong_share_pin';

  // A line that has used today's transfer cannot use this draft today either:
  // closed, so the next tap is not another refusal.
  const closing = Boolean(e?.sessionExpired) || Boolean(e?.dailyLimit) || attempt >= A2C.MAX_CONVERT_ATTEMPTS;
  await transition(
    row,
    STATUS.SUBMITTING,
    closing ? STATUS.ABANDONED : STATUS.OTP_VERIFIED,
    {
      provider_message: trimmed(e?.providerMessage),
      // The verdict is stamped now, while the flags that proved it are in hand:
      // an expired session, their rate limit or our own key read as a refusal
      // by flag, not by wording, and only the wording is stored. Without this
      // reviewState() would list them as "sent, never recorded".
      provider_status: 'declined',
      ...(closing ? { provider_token_enc: null } : {}),
    },
    { event: 'submit_declined', actor: 'user', meta: { attempt, remark: err.remark, ...diagnosis } },
  );

  if (closing && !e?.sessionExpired && !e?.dailyLimit) err.message = `${err.message} Please start again with a new code.`;
  err.data = { closed: closing, attempts_left: closing ? 0 : Math.max(0, A2C.MAX_CONVERT_ATTEMPTS - attempt) };
  throw err;
}

/* --------------------------------------------------------- customer reads */

async function summaryFor(userId) {
  const grouped = await prisma.airtimeCashConversion.groupBy({
    by: ['status'],
    where: { user_id: Number(userId), status: { in: A2C.LISTED_STATUSES } },
    _count: { _all: true },
    _sum: { payout: true },
  });
  const pick = status => grouped.find(g => g.status === status);
  const kobo = status => A2C.toKobo(pick(status)?._sum?.payout ?? 0);
  const total = status => A2C.moneyStr(kobo(status));
  const count = status => pick(status)?._count?._all || 0;
  return {
    // Pending is what the list shows as pending: processing, plus a step 3
    // still in flight.
    pending_total: A2C.moneyStr(kobo(STATUS.PROCESSING) + kobo(STATUS.SUBMITTING)),
    pending_count: count(STATUS.PROCESSING) + count(STATUS.SUBMITTING),
    available_total: total(STATUS.AVAILABLE),
    available_count: count(STATUS.AVAILABLE),
    withdrawing_total: total(STATUS.WITHDRAWING),
    withdrawn_total: total(STATUS.WITHDRAWN),
    withdrawn_count: count(STATUS.WITHDRAWN),
    failed_count: count(STATUS.FAILED),
  };
}

/** Withdrawals keyed by id, for a page of conversions. One query, not one per row. */
async function withdrawalsFor(rows) {
  const ids = [...new Set(rows.map(r => r.withdrawal_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const list = await prisma.airtimeCashWithdrawal.findMany({ where: { id: { in: ids } } });
  return new Map(list.map(w => [w.id, w]));
}

async function listConversions({ userId, status = '', page = 1, perPage = 20 }) {
  // Asking for "processing" includes a step 3 still in flight - it is shown as
  // processing, so it has to be found as processing too. "Withdrawn" includes
  // money on its way to the bank: the app's tab groups the two, and its full
  // history pages through them here.
  const wanted = status === STATUS.PROCESSING
    ? [STATUS.PROCESSING, STATUS.SUBMITTING]
    : status === STATUS.WITHDRAWN
      ? [STATUS.WITHDRAWING, STATUS.WITHDRAWN]
      : A2C.VISIBLE_STATUSES.includes(status) ? [status] : A2C.LISTED_STATUSES;
  const take = Math.min(Math.max(Number(perPage) || 20, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const rows = await prisma.airtimeCashConversion.findMany({
    where: { user_id: Number(userId), status: { in: wanted } },
    orderBy: { created_at: 'desc' },
    skip: (current - 1) * take,
    // One extra says whether there is another page without a count.
    take: take + 1,
  });
  const pageRows = rows.slice(0, take);
  const withdrawals = await withdrawalsFor(pageRows);
  return {
    conversions: pageRows.map(r => publicConversion(r, { withdrawal: withdrawals.get(r.withdrawal_id) || null })),
    page: current,
    has_more: rows.length > take,
  };
}

async function conversionDetails({ userId, id }) {
  const row = await findOwned(userId, id);
  if (!row || !A2C.LISTED_STATUSES.includes(row.status)) throw fail(404, 'not_found', 'Conversion not found');
  const withdrawal = row.withdrawal_id
    ? await prisma.airtimeCashWithdrawal.findUnique({ where: { id: row.withdrawal_id } })
    : null;
  return publicConversion(row, { withdrawal, timeline: true });
}

/* ----------------------------------------------------------- bank account */

function paystackConfigured() {
  return Boolean(String(process.env.PAYSTACK_SECRET_KEY || '').trim());
}

async function bankNameFor(code) {
  try {
    const banks = await paystack.listBanks({ currency: 'NGN' });
    return banks.find(b => String(b.code) === String(code))?.name || null;
  } catch {
    return null; // a label, never a reason to refuse
  }
}

/**
 * Name enquiry. Paystack says whose account it is; when payouts are own-name
 * only, that name has to be the customer's.
 *
 * A mismatch never echoes the name the bank returned - the same rule as the
 * KYC bank step - or this would be a lookup service: type any number, learn
 * whose it is. The customer's own profile name is safe to show them.
 */
async function resolveAccountName({ user, bankCode, accountNumber }) {
  if (!paystackConfigured()) throw fail(503, 'unavailable', 'Bank payouts are temporarily unavailable');
  const number = A2C.cleanAccountNumber(accountNumber);
  if (!number) throw fail(400, 'validation_error', 'Enter the 10-digit account number');
  const code = String(bankCode ?? '').trim();
  if (!code) throw fail(400, 'validation_error', 'Select the bank');

  let resolvedName = '';
  try {
    const { data } = await paystack.resolveAccount({ account_number: number, bank_code: code });
    resolvedName = String(data?.account_name || '').trim();
  } catch (e) {
    const status = Number(e?.statusCode);
    if (status >= 400 && status < 500) {
      throw fail(400, 'account_not_found', 'We could not find that account. Check the number and the bank and try again.');
    }
    throw fail(503, 'unavailable', 'We could not reach the bank to confirm that account. Please try again shortly.');
  }
  if (!resolvedName) throw fail(400, 'account_not_found', 'We could not find that account. Check the number and the bank and try again.');

  if (A2C.ownNameOnly()) {
    const expected = profileName(revealUserFields(user));
    const check = matchName(expected, resolvedName);
    if (!check.ok) {
      securityEvent('airtime_cash.payout_name_mismatch', 'Airtime to Cash payout account is not in the customer name', { user_id: Number(user.id) });
      throw fail(
        400,
        'name_mismatch',
        check.reason === 'incomplete_profile'
          ? 'Add your first and last name to your profile before withdrawing.'
          : `That account is not in your name. Your VoltPay profile says "${expected}" - withdraw to an account in your own name.`,
      );
    }
  }

  return { account_name: resolvedName, bank_code: code, bank_name: await bankNameFor(code), number };
}

async function kycAccount(userId) {
  if (!prisma.kycVerification) return null;
  const row = await prisma.kycVerification.findUnique({
    where: { user_id: Number(userId) },
    select: { account_status: true, account_number_enc: true, account_number_idx: true, account_name_enc: true, bank_code: true, bank_name: true },
  });
  if (row?.account_status !== 'verified' || !row.account_number_enc || !row.bank_code) return null;
  const number = safeReveal(row.account_number_enc);
  return number ? { ...row, number } : null;
}

async function savedAccount(userId) {
  const row = await prisma.airtimeCashWithdrawal.findFirst({
    where: { user_id: Number(userId), save_account: true, status: { in: ['pending', 'processing', 'success'] } },
    orderBy: { created_at: 'desc' },
  });
  if (!row) return null;
  const number = safeReveal(row.account_number_enc);
  return number ? { ...row, number } : null;
}

/** The accounts the withdraw screen offers. Masked: the number never leaves the server. */
async function payoutAccounts(userId) {
  const accounts = [];
  const kyc = await kycAccount(userId);
  if (kyc) {
    accounts.push({
      source: 'kyc',
      label: 'Verified bank account',
      bank_code: kyc.bank_code,
      bank_name: kyc.bank_name || '',
      account_masked: A2C.maskAccount(kyc.number.slice(-4)),
      account_name: safeReveal(kyc.account_name_enc),
    });
  }
  const saved = await savedAccount(userId);
  if (saved && saved.account_number_idx !== kyc?.account_number_idx) {
    accounts.push({
      source: 'saved',
      label: 'Saved account',
      bank_code: saved.bank_code,
      bank_name: saved.bank_name || '',
      account_masked: A2C.maskAccount(saved.account_last4),
      account_name: safeReveal(saved.account_name_enc),
    });
  }
  return accounts;
}

/** `{ source: 'kyc' | 'saved' }` or `{ bank_code, account_number }`, resolved and name-checked. */
async function resolveDestination(user, account) {
  const source = String(account?.source || '').trim().toLowerCase();
  if (source === 'kyc' || source === 'saved') {
    const stored = source === 'kyc' ? await kycAccount(user.id) : await savedAccount(user.id);
    if (!stored) throw fail(400, 'account_unavailable', 'That account is no longer available. Choose another account.');
    // Re-resolved even though it was checked before: accounts close, and the
    // spec is a name check before every transfer.
    return { ...(await resolveAccountName({ user, bankCode: stored.bank_code, accountNumber: stored.number })), source };
  }
  return { ...(await resolveAccountName({ user, bankCode: account?.bank_code, accountNumber: account?.account_number })), source: 'new' };
}

/* ------------------------------------------------------------- withdrawing */

// About VoltPay's own Paystack account, never the customer's bank - copied from
// StaffPay, whose payroll hits exactly these.
const MERCHANT_SIDE_FAILURE = [
  /balance is not enough/i,
  /insufficient (balance|funds)/i,
  /transfer(s)? (is |are )?(not enabled|disabled|unavailable)/i,
  /cannot (initiate|start) transfer/i,
  /starter business/i,
  /\botp\b/i,
];
const MERCHANT_SIDE_MESSAGE = 'Withdrawals are briefly unavailable. Your cash is safe and available again - please try again shortly.';

function isMerchantSide(message) {
  return MERCHANT_SIDE_FAILURE.some(re => re.test(String(message || '')));
}

function customerReason(raw) {
  const message = String(raw || '').trim();
  if (!message) return 'The transfer did not go through.';
  if (isMerchantSide(message)) return MERCHANT_SIDE_MESSAGE;
  return message.slice(0, 160);
}

/** A timeout or a 5xx leaves it unknown whether the transfer exists - only a 4xx is a no. */
function isDefiniteRejection(err) {
  const status = Number(err?.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 500;
}

function normaliseIds(value, max) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  return ids.slice(0, max);
}

function bankLine(w) {
  return `${w.bank_name || 'your bank'}${w.account_last4 ? ` ****${w.account_last4}` : ''}`;
}

/**
 * Pay out available conversions. `conversionIds` is a list, or 'all'.
 *
 * Order matters. The account is resolved and the Paystack recipient created
 * before anything is claimed, so a wrong account number costs nothing. Then one
 * transaction writes the withdrawal and claims every conversion it pays - all
 * of them or none - and only then is Paystack asked to move money.
 */
async function withdraw({ userId, conversionIds, account, pin, saveAccount = false, req = null }) {
  const uid = Number(userId);
  if (!paystackConfigured()) throw fail(503, 'unavailable', 'Bank payouts are temporarily unavailable');

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) throw fail(404, 'not_found', 'Account not found');
  if (!pin) throw fail(400, 'validation_error', 'PIN is required');
  if (!(await verifySecret(String(pin), user.pin, 'pin')).ok) throw fail(401, 'invalid_pin', 'Invalid PIN');
  await assertKyc(uid);

  const ids = conversionIds === 'all' ? [] : normaliseIds(conversionIds, 50);
  if (ids === null || (conversionIds !== 'all' && !ids.length)) {
    throw fail(400, 'validation_error', 'Choose what to withdraw');
  }

  const rows = await prisma.airtimeCashConversion.findMany({
    where: { user_id: uid, status: STATUS.AVAILABLE, withdrawal_id: null, ...(ids.length ? { id: { in: ids } } : {}) },
    orderBy: { id: 'asc' },
    take: 50,
  });
  if (!rows.length) throw fail(409, 'nothing_to_withdraw', 'There is nothing available to withdraw yet');
  if (ids.length && rows.length !== ids.length) {
    throw fail(409, 'not_available', 'Some of these conversions are not available to withdraw. Refresh and try again.');
  }

  const totalKobo = rows.reduce((n, r) => n + A2C.toKobo(r.payout), 0);
  const destination = await resolveDestination(user, account);

  let recipient;
  try {
    ({ recipient_code: recipient } = await paystack.createTransferRecipient({
      name: destination.account_name,
      account_number: destination.number,
      bank_code: destination.bank_code,
    }));
  } catch (e) {
    if (isDefiniteRejection(e)) {
      throw fail(400, 'account_not_found', 'We could not set up a transfer to that account. Check the details and try again.');
    }
    throw fail(503, 'unavailable', 'We could not reach our bank partner. Please try again shortly.');
  }

  const providerFeeKobo = Math.round(Number(paystack.transferFeeNaira(totalKobo / 100) || 0) * 100);
  const reference = A2C.newWithdrawalReference();

  const withdrawal = await withDirectFallback(p => p.$transaction(async tx => {
    const w = await tx.airtimeCashWithdrawal.create({
      data: {
        user_id: uid,
        reference,
        amount: dec(totalKobo),
        fee: dec(0),
        provider_fee: dec(providerFeeKobo),
        conversion_count: rows.length,
        bank_code: destination.bank_code,
        bank_name: destination.bank_name,
        account_number_enc: encryptValue(destination.number),
        account_number_idx: blindIndex(destination.number, 'account_number'),
        account_last4: destination.number.slice(-4),
        account_name_enc: encryptValue(destination.account_name),
        account_source: destination.source,
        save_account: Boolean(saveAccount) || destination.source === 'saved',
        recipient_code: recipient,
        status: 'pending',
      },
    });

    const claimed = await tx.airtimeCashConversion.updateMany({
      where: { id: { in: rows.map(r => r.id) }, user_id: uid, status: STATUS.AVAILABLE, withdrawal_id: null },
      data: { status: STATUS.WITHDRAWING, withdrawal_id: w.id },
    });
    // Lost a race with another withdrawal for one of these rows. Throwing
    // rolls the withdrawal row back with it.
    if (claimed.count !== rows.length) {
      throw fail(409, 'not_available', 'Some of these conversions were just withdrawn. Refresh and try again.');
    }

    await tx.airtimeCashEvent.createMany({
      data: rows.map(r => ({
        conversion_id: r.id,
        event: 'status',
        from_status: STATUS.AVAILABLE,
        to_status: STATUS.WITHDRAWING,
        actor: 'user',
        meta: { withdrawal_id: w.id },
      })),
    });
    return w;
  }, { timeout: 15000, maxWait: 15000 }));

  // Ids, amounts and the bank only - never the account number.
  await logUserEvent({
    req,
    userId: uid,
    event: 'airtime_cash.withdraw',
    metadata: { withdrawal_id: withdrawal.id, reference, amount: totalKobo / 100, conversions: rows.length, bank_code: destination.bank_code },
  });

  return submitTransfer(withdrawal);
}

async function reloadWithdrawal(id) {
  return prisma.airtimeCashWithdrawal.findUnique({ where: { id } });
}

/** Ask Paystack to move it. Never throws: every outcome is written on the row. */
async function submitTransfer(withdrawal) {
  let data;
  try {
    ({ data } = await paystack.initiateTransfer({
      amountKobo: A2C.toKobo(withdrawal.amount),
      recipient: withdrawal.recipient_code,
      reference: withdrawal.reference,
      reason: 'VoltPay Airtime to Cash',
    }));
  } catch (e) {
    if (isDefiniteRejection(e)) {
      await settleFailure(withdrawal, { providerMessage: e?.message });
    } else {
      // Paystack may have it. Processing, with the reference written before the
      // call, and the poll lets Paystack's own record decide.
      await prisma.airtimeCashWithdrawal.updateMany({
        where: { id: withdrawal.id, status: 'pending' },
        data: { status: 'processing', submitted_at: new Date(), provider_message: trimmed(e?.message) },
      });
      captureError('airtime_cash.transfer_indeterminate', e, { withdrawal_id: withdrawal.id, reference: withdrawal.reference });
    }
    return reloadWithdrawal(withdrawal.id);
  }

  const status = String(data?.status || '').toLowerCase();
  await prisma.airtimeCashWithdrawal.updateMany({
    where: { id: withdrawal.id, status: 'pending' },
    data: { status: 'processing', submitted_at: new Date(), transfer_code: data?.transfer_code ? String(data.transfer_code) : null },
  });
  const current = { ...withdrawal, status: 'processing' };

  if (status === 'success') await settleSuccess(current, data);
  // `otp` is transfer OTP still switched on for our account: nothing moves
  // without a person approving it, so it is a failure here and an incident.
  else if (status === 'otp') await settleFailure(current, { providerMessage: 'Paystack transfer OTP is enabled on this account' });
  else if (['failed', 'reversed', 'abandoned', 'rejected'].includes(status)) {
    await settleFailure(current, { providerMessage: data?.reason || data?.message || `Transfer ${status}` });
  }
  return reloadWithdrawal(withdrawal.id);
}

/** processing -> success, and every conversion it carried -> withdrawn. Once. */
async function settleSuccess(w, data = {}) {
  const now = new Date();
  const moved = await withDirectFallback(p => p.$transaction(async tx => {
    const claimed = await tx.airtimeCashWithdrawal.updateMany({
      where: { id: w.id, status: { in: ['pending', 'processing'] } },
      data: {
        status: 'success',
        completed_at: now,
        failure_reason: null,
        ...(data?.transfer_code ? { transfer_code: String(data.transfer_code) } : {}),
      },
    });
    if (!claimed?.count) return null;
    const rows = await tx.airtimeCashConversion.findMany({ where: { withdrawal_id: w.id, status: STATUS.WITHDRAWING } });
    await tx.airtimeCashConversion.updateMany({
      where: { withdrawal_id: w.id, status: STATUS.WITHDRAWING },
      data: { status: STATUS.WITHDRAWN, withdrawn_at: now },
    });
    if (rows.length) {
      await tx.airtimeCashEvent.createMany({
        data: rows.map(r => ({ conversion_id: r.id, event: 'status', from_status: STATUS.WITHDRAWING, to_status: STATUS.WITHDRAWN, meta: { withdrawal_id: w.id } })),
      });
    }
    return rows;
  }, { timeout: 15000, maxWait: 15000 }));
  if (!moved) return false;

  await notify(
    w.user_id,
    `a2cw:${w.id}:success`,
    'Withdrawal successful',
    `${A2C.nairaKobo(A2C.toKobo(w.amount))} from Airtime to Cash has been sent to ${bankLine(w)}.`,
    { withdrawal_id: w.id, status: 'success' },
  );
  return true;
}

/**
 * pending/processing -> failed, and every conversion it carried back to
 * available in the same transaction. The money is owed again, so the customer
 * can withdraw it again; merchant-side failures (our Paystack balance, our
 * account settings) page ops, because no customer can fix those.
 */
async function settleFailure(w, { providerMessage = '', reason = '' } = {}) {
  const merchantSide = isMerchantSide(providerMessage);
  const friendly = reason || customerReason(providerMessage);
  const moved = await withDirectFallback(p => p.$transaction(async tx => {
    const claimed = await tx.airtimeCashWithdrawal.updateMany({
      where: { id: w.id, status: { in: ['pending', 'processing'] } },
      data: { status: 'failed', completed_at: new Date(), failure_reason: friendly, provider_message: trimmed(providerMessage) },
    });
    if (!claimed?.count) return null;
    return releaseConversions(tx, w, STATUS.WITHDRAWING, 'withdrawal_failed');
  }, { timeout: 15000, maxWait: 15000 }));
  if (!moved) return false;

  if (merchantSide) {
    paymentFailure({
      provider: 'paystack',
      action: 'transfer',
      reference: w.reference,
      userId: w.user_id,
      amount: A2C.moneyStr(A2C.toKobo(w.amount)),
      message: providerMessage || 'Airtime to Cash payout refused on our side',
      context: { feature: 'airtime_cash', withdrawal_id: w.id },
    });
  }

  await notify(
    w.user_id,
    `a2cw:${w.id}:failed`,
    'Withdrawal failed',
    `We could not send ${A2C.nairaKobo(A2C.toKobo(w.amount))} to ${bankLine(w)}. ${friendly} Your cash is available to withdraw again.`,
    { withdrawal_id: w.id, status: 'failed' },
  );
  return true;
}

/** success -> reversed: the bank sent it back. Owed again, so available again. */
async function settleReversed(w, { providerMessage = '' } = {}) {
  const moved = await withDirectFallback(p => p.$transaction(async tx => {
    const claimed = await tx.airtimeCashWithdrawal.updateMany({
      where: { id: w.id, status: 'success' },
      data: { status: 'reversed', failure_reason: 'The bank returned this transfer.', provider_message: trimmed(providerMessage) },
    });
    if (!claimed?.count) return null;
    return releaseConversions(tx, w, STATUS.WITHDRAWN, 'withdrawal_reversed');
  }, { timeout: 15000, maxWait: 15000 }));
  if (!moved) return false;

  await notify(
    w.user_id,
    `a2cw:${w.id}:reversed`,
    'Withdrawal returned',
    `Your bank returned ${A2C.nairaKobo(A2C.toKobo(w.amount))} sent to ${bankLine(w)}. It is available to withdraw again.`,
    { withdrawal_id: w.id, status: 'reversed' },
  );
  return true;
}

async function releaseConversions(tx, w, fromStatus, reason) {
  const rows = await tx.airtimeCashConversion.findMany({ where: { withdrawal_id: w.id, status: fromStatus } });
  await tx.airtimeCashConversion.updateMany({
    where: { withdrawal_id: w.id, status: fromStatus },
    data: { status: STATUS.AVAILABLE, withdrawal_id: null, withdrawn_at: null },
  });
  if (rows.length) {
    await tx.airtimeCashEvent.createMany({
      data: rows.map(r => ({ conversion_id: r.id, event: 'status', from_status: fromStatus, to_status: STATUS.AVAILABLE, meta: { withdrawal_id: w.id, reason } })),
    });
  }
  return rows;
}

/** Ask Paystack about one withdrawal. The poll, and the webhook's backstop. */
async function syncWithdrawal(w, now = Date.now()) {
  let data;
  try {
    ({ data } = await paystack.verifyTransfer(w.reference));
  } catch (e) {
    // A 404 straight after submit is Paystack catching up. A 404 on a row
    // nobody has touched for the whole stranded window means the transfer
    // never reached it, so the conversions are released to be withdrawn again.
    const age = now - new Date(w.updated_at).getTime();
    if (Number(e?.statusCode) === 404 && age > STRANDED_TRANSFER_MS) {
      return settleFailure(w, { reason: 'The transfer never reached our bank partner.' });
    }
    return false;
  }

  const status = String(data?.status || '').toLowerCase();
  if (status === 'success') return settleSuccess(w, data);
  if (status === 'reversed') {
    return w.status === 'success' ? settleReversed(w, { providerMessage: data?.reason }) : settleFailure(w, { providerMessage: data?.reason || 'Transfer reversed' });
  }
  if (['failed', 'abandoned', 'rejected'].includes(status)) {
    return settleFailure(w, { providerMessage: data?.reason || data?.message || `Transfer ${status}` });
  }
  if (status === 'otp') return settleFailure(w, { providerMessage: 'Paystack transfer OTP is enabled on this account' });
  return false;
}

/**
 * Paystack transfer.* webhook, routed here by the reference prefix. The event
 * is signed, so it is acted on directly - the same state machine as the poll,
 * and the same guards, so whichever lands first settles it and the other is a
 * no-op.
 */
async function handleTransferEvent({ event, data }) {
  const reference = String(data?.reference || '').trim();
  if (!A2C.isWithdrawalReference(reference)) return false;
  const w = await prisma.airtimeCashWithdrawal.findUnique({ where: { reference } });
  if (!w) return false;

  if (event === 'transfer.success') await settleSuccess(w, data);
  else if (event === 'transfer.failed') await settleFailure(w, { providerMessage: data?.reason || 'Transfer failed' });
  else if (event === 'transfer.reversed') {
    if (w.status === 'success') await settleReversed(w, { providerMessage: data?.reason });
    else await settleFailure(w, { providerMessage: data?.reason || 'Transfer reversed' });
  }
  return true;
}

/* ------------------------------------------------------------- admin acts */

function cleanNote(note) {
  return String(note ?? '').trim().slice(0, 1000);
}

/**
 * processing -> available, one or many. The unlock that lets a customer pull
 * money out of Paystack, so it is never automatic, and a conversion MySubWallet
 * never confirmed needs the admin to say so explicitly, with a note.
 *
 * Returns per-id results rather than failing the batch: one row that moved on
 * since the page loaded must not stop the other forty.
 */
async function markAvailable({ ids, actor, note = '', confirmUnconfirmed = false }) {
  const list = normaliseIds(ids, 200);
  if (!list || !list.length) throw fail(400, 'validation_error', 'Select at least one conversion');
  const text = cleanNote(note);

  const rows = await prisma.airtimeCashConversion.findMany({ where: { id: { in: list } } });
  const byId = new Map(rows.map(r => [r.id, r]));

  const vouching = confirmUnconfirmed && rows.some(r => r.status === STATUS.PROCESSING && !A2C.isConfirmed(r));
  if (vouching && text.length < 8) {
    throw fail(400, 'note_required', 'Write a note (at least 8 characters) saying how you confirmed the unconfirmed conversions.');
  }

  const updated = [];
  const skipped = [];
  let payoutKobo = 0;
  for (const id of list) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (row.status !== STATUS.PROCESSING) {
      skipped.push({ id, reason: `status_${row.status}` });
      continue;
    }
    const unconfirmed = !A2C.isConfirmed(row);
    if (unconfirmed && !confirmUnconfirmed) {
      skipped.push({ id, reason: 'unconfirmed' });
      continue;
    }
    const moved = await transition(
      row,
      STATUS.PROCESSING,
      STATUS.AVAILABLE,
      { available_at: new Date(), settled_by: String(actor || 'admin').slice(0, 64), ...(unconfirmed ? { provider_status: 'confirmed' } : {}) },
      { actor: `admin:${actor || 'admin'}`, note: text || null, meta: unconfirmed ? { confirmed_by_admin: true } : null },
    );
    if (!moved) {
      skipped.push({ id, reason: 'changed' });
      continue;
    }
    updated.push(id);
    payoutKobo += A2C.toKobo(row.payout);
    await notify(
      row.user_id,
      `a2c:${row.id}:available`,
      'Cash ready to withdraw',
      `${A2C.nairaKobo(A2C.toKobo(row.payout))} from your ${A2C.networkConfig(row.network)?.name || row.network} airtime conversion is ready. Withdraw it to your bank any time.`,
      { conversion_id: row.id, status: STATUS.AVAILABLE },
    );
  }

  return { updated, skipped, payout_total: A2C.moneyStr(payoutKobo) };
}

const ADMIN_FAILED_REASON = 'This conversion could not be completed. If airtime left your line, contact support with the reference.';

async function markFailed({ id, actor, note }) {
  const text = cleanNote(note);
  if (text.length < 8) throw fail(400, 'note_required', 'Write a note (at least 8 characters) explaining why');
  const row = await prisma.airtimeCashConversion.findUnique({ where: { id: Number(id) } });
  if (!row) throw fail(404, 'not_found', 'Conversion not found');
  // Withdrawing and withdrawn rows carry money that is already in flight or
  // gone. Failing them here would not bring it back.
  if (![STATUS.PROCESSING, STATUS.AVAILABLE].includes(row.status)) {
    throw fail(409, 'invalid_state', `A ${row.status} conversion cannot be marked failed`);
  }
  const moved = await transition(
    row,
    [STATUS.PROCESSING, STATUS.AVAILABLE],
    STATUS.FAILED,
    { failed_at: new Date(), failure_reason: ADMIN_FAILED_REASON, provider_token_enc: null },
    { actor: `admin:${actor || 'admin'}`, note: text },
  );
  if (!moved) throw fail(409, 'changed', 'This conversion changed since the page loaded. Refresh and try again.');

  await notify(
    row.user_id,
    `a2c:${row.id}:failed`,
    'Conversion not completed',
    `Your airtime conversion ${row.reference} could not be completed. If airtime left your line, contact support with this reference.`,
    { conversion_id: row.id, status: STATUS.FAILED },
  );
  return prisma.airtimeCashConversion.findUnique({ where: { id: row.id } });
}

/* ------------------------------------------------------------- recovery */

/**
 * Record a conversion that happened at MySubWallet but was never recorded here
 * - the hole conversion #8 fell into on 2026-10-12, when an accepted step 3 was
 * read as a refusal and its row went back to a hidden draft.
 *
 * Straight to processing - the customer's pending cash - dated when it was
 * actually sent, with the customer told it is now reflected. Only for a row
 * whose step 3 was sent and priced; the guarded transition makes a second call
 * a no-op, so no conversion is ever credited twice.
 */
async function recoverConversion(row, { providerStatus, via, actor = 'system', note = null }) {
  if (!(Number(row.convert_attempts || 0) >= 1) || row.payout == null) return false;
  const moved = await transition(
    row,
    A2C.RECORDABLE_STATUSES,
    STATUS.PROCESSING,
    {
      provider_status: providerStatus,
      converted_at: row.submitted_at || new Date(),
      provider_checked_at: new Date(),
      provider_token_enc: null,
      failed_at: null,
      failure_reason: null,
    },
    { event: 'recovered', actor, note, meta: { via, provider_status: providerStatus, from: row.status } },
  );
  if (!moved) return false;

  console.warn('airtimeCash: conversion recovered', { conversion_id: row.id, reference: row.reference, via, from: row.status, actor });
  const cfg = A2C.networkConfig(row.network);
  await notify(
    row.user_id,
    `a2c:${row.id}:recovered`,
    'Airtime conversion now reflected',
    `Your ${A2C.nairaKobo(A2C.toKobo(row.amount))} ${cfg?.name || row.network} airtime conversion is now in Airtime to Cash: ${A2C.nairaKobo(A2C.toKobo(row.payout))} pending. It will be ready to withdraw once settlement completes.`,
    { conversion_id: row.id, status: STATUS.PROCESSING },
  );
  return true;
}

/**
 * The automatic half of recovery. A row whose step 3 was sent, that sits in a
 * draft state, and whose last words from MySubWallet were an acceptance
 * ("Checking transaction... We will notify you once it is successful.") is a
 * conversion the old classifier filed as a refusal. It is recovered as
 * *pending*: the customer's cash is reflected, and an admin still confirms it
 * on MySubWallet before it can be unlocked - their requery cannot.
 *
 * Nothing else is recovered automatically, because nothing else is evidence:
 * their requery answers "Transaction not found" for every Airtime to Cash
 * request-id. `apply: false` reports and writes nothing.
 */
async function reconcileMisfiled({ limit = 50, apply = true } = {}) {
  const rows = await prisma.airtimeCashConversion.findMany({
    where: {
      status: { in: [STATUS.OTP_VERIFIED, STATUS.ABANDONED] },
      convert_attempts: { gte: 1 },
      payout: { not: null },
      provider_message: { not: null },
    },
    orderBy: { id: 'asc' },
    take: limit,
  });

  const recovered = [];
  for (const row of rows.filter(r => r.provider_status !== 'declined' && msw.isCashPendingWording(r.provider_message))) {
    if (!apply || (await recoverConversion(row, { providerStatus: 'pending', via: 'reclassified' }))) {
      recovered.push({ id: row.id, reference: row.reference, user_id: row.user_id, payout: A2C.moneyStr(A2C.toKobo(row.payout)), from: row.status });
    }
  }
  return { checked: rows.length, recovered, applied: apply };
}

/**
 * The admin half: MySubWallet's dashboard shows the conversion, VoltPay does
 * not. Recorded as confirmed - the admin has seen their side - with a note
 * naming where (their transaction or reference), kept in the trail. Then the
 * normal settlement applies: fund Paystack, mark available.
 */
async function recordProviderSuccess({ id, actor, note }) {
  const text = cleanNote(note);
  if (text.length < 8) {
    throw fail(400, 'note_required', 'Write a note (at least 8 characters) saying where you confirmed it - the MySubWallet transaction or reference.');
  }
  const row = await prisma.airtimeCashConversion.findUnique({ where: { id: Number(id) } });
  if (!row) throw fail(404, 'not_found', 'Conversion not found');
  if (A2C.CREDITED_STATUSES.includes(row.status)) {
    throw fail(409, 'already_recorded', 'This conversion is already recorded and the customer credited.');
  }
  if (!A2C.RECORDABLE_STATUSES.includes(row.status) || !(Number(row.convert_attempts || 0) >= 1) || row.payout == null) {
    throw fail(409, 'not_recordable', 'Only a conversion whose transfer was actually sent can be recorded.');
  }
  const moved = await recoverConversion(row, { providerStatus: 'confirmed', via: 'admin', actor: `admin:${actor || 'admin'}`, note: text });
  if (!moved) throw fail(409, 'changed', 'This conversion changed since the page loaded. Refresh and try again.');
  return prisma.airtimeCashConversion.findUnique({ where: { id: row.id } });
}

/**
 * What support needs to answer "my airtime left and the app shows nothing":
 * was step 3 sent, what did MySubWallet say, is the customer credited - and
 * whether the row needs somebody to look.
 *
 *   in_flight    step 3 sent, no answer recorded yet
 *   unconfirmed  credited as pending; MySubWallet's side not yet confirmed
 *   unrecorded   step 3 sent, not credited, and nothing proved that nothing
 *                moved - no 'declined' stamp (rows from before 2026-10-12
 *                carry none) and no refusal in their stored words
 */
function reviewState(row) {
  const stepThreeSent = Number(row?.convert_attempts || 0) >= 1;
  const credited = A2C.CREDITED_STATUSES.includes(row?.status);
  let needsReview = null;
  if (row?.status === STATUS.SUBMITTING) needsReview = 'in_flight';
  else if (row?.status === STATUS.PROCESSING && !A2C.isConfirmed(row)) needsReview = 'unconfirmed';
  else if (
    !credited &&
    stepThreeSent &&
    [STATUS.OTP_VERIFIED, STATUS.ABANDONED].includes(row?.status) &&
    row?.provider_status !== 'declined' &&
    !msw.isClearCashDecline({ providerMessage: row?.provider_message })
  ) {
    needsReview = 'unrecorded';
  }
  return {
    step3_sent: stepThreeSent,
    provider_recorded: row?.provider_status || null,
    user_credited: credited,
    needs_review: needsReview,
    recordable: !credited && stepThreeSent && row?.payout != null && A2C.RECORDABLE_STATUSES.includes(row?.status),
  };
}

async function addNote({ id, actor, note }) {
  const text = cleanNote(note);
  if (text.length < 3) throw fail(400, 'validation_error', 'Write a note');
  const row = await prisma.airtimeCashConversion.findUnique({ where: { id: Number(id) }, select: { id: true, status: true } });
  if (!row) throw fail(404, 'not_found', 'Conversion not found');
  await recordEvent(row.id, 'note', { from: row.status, to: row.status, actor: `admin:${actor || 'admin'}`, note: text });
  return true;
}

/* ------------------------------------------------------------------ sweep */

// Prisma's "table does not exist", or the driver's own code for it.
function isMissingTable(e) {
  return e?.code === 'P2021' || e?.meta?.code === '42P01' || /(relation|table)\s+\S+\s+does not exist/i.test(String(e?.message || ''));
}

let warnedMissingTables = false;

async function requeryConversion(row) {
  const ref = row.provider_request_id || row.reference;
  try {
    return await msw.getTransactionStatus(ref);
  } catch {
    return null;
  }
}

/**
 * Everything that finishes itself, every few minutes, on any instance:
 *
 *   1. withdrawals in flight      Paystack asked; settled, failed or released
 *   2. submits nobody answered    the process died mid-call: recorded, never
 *                                 dropped - a sent step 3 always ends visible
 *   3. unconfirmed conversions    asked again; confirmed, failed, or handed
 *                                 to ops once they have waited too long
 *   3b. misfiled conversions      accepted at MySubWallet, filed here as a
 *                                 refusal: recovered as pending, customer told
 *   4. stale drafts               closed, their tokens dropped
 *   5. waiting on settlement      ops paged once per conversion
 *
 * Every write is a guarded transition, so two instances sweeping at once
 * settle each row once.
 */
async function sweep({ limit = 20 } = {}) {
  if (!prisma.airtimeCashConversion || !prisma.airtimeCashWithdrawal) return { skipped: 'no_models' };
  const now = Date.now();
  const out = { withdrawals: 0, stranded: 0, confirmed: 0, failed: 0, recovered: 0, abandoned: 0, alerted: 0 };

  // 1.
  let inflight;
  try {
    inflight = await prisma.airtimeCashWithdrawal.findMany({
      where: {
        OR: [
          { status: 'processing', updated_at: { lt: new Date(now - 60_000) } },
          { status: 'pending', updated_at: { lt: new Date(now - STRANDED_TRANSFER_MS) } },
        ],
      },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
  } catch (e) {
    // Deployed ahead of `npm run ddl:airtime-cash`: there is nothing to sweep
    // yet, and nothing worth paging anybody about every five minutes. Said
    // once per process, so the boot log still shows it.
    if (!isMissingTable(e)) throw e;
    if (!warnedMissingTables) {
      warnedMissingTables = true;
      console.warn('⚠️  Airtime to Cash tables are missing - run `npm run ddl:airtime-cash`. The sweep is idle until then.');
    }
    return { skipped: 'no_tables' };
  }
  for (const w of inflight) {
    try {
      if (await syncWithdrawal(w, now)) out.withdrawals += 1;
    } catch (e) {
      captureError('airtime_cash.sync_withdrawal', e, { withdrawal_id: w.id });
    }
  }

  // 2. Not found is kept as unconfirmed rather than dropped: their requery may
  // simply not know request-ids on this path, and dropping it would lose a
  // conversion that took the customer's airtime.
  const stranded = await prisma.airtimeCashConversion.findMany({
    where: { status: STATUS.SUBMITTING, updated_at: { lt: new Date(now - A2C.STRANDED_SUBMIT_MS) } },
    orderBy: { updated_at: 'asc' },
    take: limit,
  });
  for (const row of stranded) {
    try {
      const remote = await requeryConversion(row);
      if (remote?.status === 'failed') {
        // Failed, not abandoned: a sent step 3 never goes back to a state
        // nobody can see. If MySubWallet is wrong about this one, an admin can
        // still record it from here.
        const moved = await transition(
          row,
          STATUS.SUBMITTING,
          STATUS.FAILED,
          { failed_at: new Date(), failure_reason: 'The network reported this transfer as failed.', provider_token_enc: null },
          { meta: { reason: 'stranded_failed' } },
        );
        if (moved) {
          out.stranded += 1;
          await notify(
            row.user_id,
            `a2c:${row.id}:failed`,
            'Conversion not completed',
            `The network reported your airtime conversion ${row.reference} as failed. If airtime left your line, contact support with this reference.`,
            { conversion_id: row.id, status: STATUS.FAILED },
          );
        }
      } else {
        const providerStatus = remote?.status === 'successful' ? 'confirmed' : remote?.status === 'processing' ? 'pending' : 'unknown';
        if (await markConverted(row, { providerStatus, via: 'stranded' })) out.stranded += 1;
      }
    } catch (e) {
      captureError('airtime_cash.stranded_submit', e, { conversion_id: row.id });
    }
  }

  // 3.
  const unconfirmed = await prisma.airtimeCashConversion.findMany({
    where: {
      status: STATUS.PROCESSING,
      provider_status: { in: ['pending', 'unknown'] },
      converted_at: { gte: new Date(now - A2C.UNCONFIRMED_GIVE_UP_MS) },
      OR: [{ provider_checked_at: null }, { provider_checked_at: { lt: new Date(now - 5 * 60_000) } }],
    },
    orderBy: { converted_at: 'asc' },
    take: limit,
  });
  for (const row of unconfirmed) {
    try {
      const remote = await requeryConversion(row);
      if (remote?.status === 'successful') {
        const confirmed = await prisma.airtimeCashConversion.updateMany({
          where: { id: row.id, status: STATUS.PROCESSING, provider_status: { in: ['pending', 'unknown'] } },
          data: { provider_status: 'confirmed', provider_checked_at: new Date() },
        });
        if (confirmed?.count) {
          out.confirmed += 1;
          await recordEvent(row.id, 'provider_confirmed', { from: row.status, to: row.status });
          await notifyConverted(row, 'confirmed');
        }
        continue;
      }
      if (remote?.status === 'failed') {
        const moved = await transition(
          row,
          STATUS.PROCESSING,
          STATUS.FAILED,
          { failed_at: new Date(), failure_reason: 'The network reported this transfer as failed.', provider_checked_at: new Date() },
          { meta: { via: 'requery' } },
        );
        if (moved) {
          out.failed += 1;
          await notify(
            row.user_id,
            `a2c:${row.id}:failed`,
            'Conversion not completed',
            `The network reported your airtime conversion ${row.reference} as failed. If airtime left your line, contact support with this reference.`,
            { conversion_id: row.id, status: STATUS.FAILED },
          );
        }
        continue;
      }

      await prisma.airtimeCashConversion.updateMany({ where: { id: row.id }, data: { provider_checked_at: new Date() } });
      const age = now - new Date(row.converted_at).getTime();
      if (age > A2C.UNCONFIRMED_ALERT_MS && !row.unconfirmed_alerted_at) {
        const stamped = await prisma.airtimeCashConversion.updateMany({
          where: { id: row.id, unconfirmed_alerted_at: null },
          data: { unconfirmed_alerted_at: new Date() },
        });
        if (stamped?.count) {
          out.alerted += 1;
          paymentFailure({
            provider: 'mysubwallet',
            action: 'airtime_cash_unconfirmed',
            reference: row.reference,
            userId: row.user_id,
            amount: A2C.moneyStr(A2C.toKobo(row.amount)),
            message: 'Airtime to Cash conversion still unconfirmed - check the MySubWallet dashboard before marking it available or failed',
            context: { conversion_id: row.id, request_id: row.provider_request_id },
          });
        }
      }
    } catch (e) {
      captureError('airtime_cash.requery', e, { conversion_id: row.id });
    }
  }

  // 3b. Before stale drafts are closed, so a misfiled conversion is recovered
  // from whichever draft state it is in.
  try {
    out.recovered = (await reconcileMisfiled({ limit })).recovered.length;
  } catch (e) {
    captureError('airtime_cash.reconcile', e);
  }

  // 4.
  const abandoned = await prisma.airtimeCashConversion.updateMany({
    where: { status: { in: A2C.DRAFT_STATUSES }, updated_at: { lt: new Date(now - A2C.DRAFT_TTL_MS) } },
    data: { status: STATUS.ABANDONED, provider_token_enc: null },
  });
  out.abandoned = abandoned?.count || 0;

  // 5. One alert per pass, listing everything newly overdue, and each row
  // stamped so the next pass does not say it again.
  const overdue = await prisma.airtimeCashConversion.findMany({
    where: {
      status: STATUS.PROCESSING,
      provider_status: 'confirmed',
      settlement_alerted_at: null,
      converted_at: { lt: new Date(now - A2C.settlementAlertHours() * 60 * 60_000) },
    },
    select: { id: true, payout: true },
    take: 200,
  });
  if (overdue.length) {
    const stamped = await prisma.airtimeCashConversion.updateMany({
      where: { id: { in: overdue.map(r => r.id) }, settlement_alerted_at: null },
      data: { settlement_alerted_at: new Date() },
    });
    if (stamped?.count) {
      out.alerted += 1;
      paymentFailure({
        provider: 'mysubwallet',
        action: 'airtime_cash_settlement',
        reference: `a2c:${overdue.length}`,
        amount: A2C.moneyStr(overdue.reduce((n, r) => n + A2C.toKobo(r.payout), 0)),
        message: `${overdue.length} Airtime to Cash conversion(s) waiting more than ${A2C.settlementAlertHours()}h for settlement - fund Paystack from MySubWallet and mark them available`,
        context: { feature: 'airtime_cash' },
      });
    }
  }

  return out;
}

module.exports = {
  startConversion,
  resendOtp,
  verifyOtp,
  convert,
  summaryFor,
  listConversions,
  conversionDetails,
  payoutAccounts,
  resolveAccountName,
  withdraw,
  submitTransfer,
  syncWithdrawal,
  settleSuccess,
  settleFailure,
  settleReversed,
  handleTransferEvent,
  markAvailable,
  markFailed,
  addNote,
  recoverConversion,
  reconcileMisfiled,
  recordProviderSuccess,
  reviewState,
  sweep,
  publicConversion,
  publicWithdrawal,
  publicDraft,
  otpState,
  STRANDED_TRANSFER_MS,
};
