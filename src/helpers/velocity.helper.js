// Velocity limits: a ceiling on how much can leave one wallet per hour and per
// day, independent of whether each individual payment is valid on its own.
//
// This is the control that catches a stolen phone with a known PIN. Every
// single transfer it makes is legitimate by every other check in the codebase -
// correct PIN, sufficient balance, real recipient. Only the rate gives it away.
//
// Counted from wallet_transactions rather than from Redis, on purpose. Two
// reasons: the ledger is the one record an attacker cannot clear by knocking
// the cache over, and rateLimit.middleware already fails open to a weaker local
// counter - acceptable for login attempts, not for money. The query is covered
// by @@index([user_id, created_at]).
//
// Errors are NOT swallowed. This shares a database with the payment it guards,
// so if the count cannot be read the payment was not going to settle anyway;
// letting it through would be the one failure mode worth avoiding.

const prisma = require('../../database/prisma');
const { securityEvent } = require('../services/alerts.service');

// Debits only. `+` rows are funding, and rate-limiting incoming money would be
// an odd kind of fraud control.
const DEBIT = '-';

// `Number('')` is 0 and 0 passes a `>= 0` check, so an unset variable would
// read as "zero naira allowed per hour" and block every payment on the
// platform. Catch the empty string before parsing - same trap as vatRate().
function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limits() {
  return {
    hourlyMaxCount: envNumber('VELOCITY_HOURLY_MAX_COUNT', 12),
    hourlyMaxAmount: envNumber('VELOCITY_HOURLY_MAX_AMOUNT', 500_000),
    dailyMaxAmount: envNumber('VELOCITY_DAILY_MAX_AMOUNT', 2_000_000),
  };
}

function isEnabled() {
  return String(process.env.VELOCITY_ENABLED ?? '1').trim().toLowerCase() !== '0';
}

function windowSince(minutes, now = Date.now()) {
  return new Date(now - minutes * 60_000);
}

/**
 * The decision itself, split out from the query so it can be tested without a
 * database. `amount` is counted IN, not compared against what already settled:
 * the limit is on money leaving the wallet, and this one is on its way out.
 */
function decide({ hourCount, hourSpent, daySpent, amount }, caps = limits()) {
  const { hourlyMaxCount, hourlyMaxAmount, dailyMaxAmount } = caps;

  if (hourCount + 1 > hourlyMaxCount) {
    return {
      ok: false,
      reason: 'hourly_count',
      message: `For your security, payments are limited to ${hourlyMaxCount} per hour. Please try again later.`,
      retryAfterMinutes: 60,
    };
  }
  if (hourSpent + amount > hourlyMaxAmount) {
    return {
      ok: false,
      reason: 'hourly_amount',
      message: `For your security, you can spend up to ₦${hourlyMaxAmount.toLocaleString('en-NG')} per hour. Please try again later.`,
      retryAfterMinutes: 60,
    };
  }
  if (daySpent + amount > dailyMaxAmount) {
    return {
      ok: false,
      reason: 'daily_amount',
      message: `For your security, you can spend up to ₦${dailyMaxAmount.toLocaleString('en-NG')} per day. Please try again tomorrow.`,
      retryAfterMinutes: 60 * 24,
    };
  }
  return { ok: true };
}

/**
 * Decide whether one more debit of `amount` is allowed right now.
 *
 * @returns {Promise<{ok: boolean, reason?: string, message?: string, retryAfterMinutes?: number}>}
 */
async function checkVelocity({ userId, amount, now = Date.now() }) {
  if (!isEnabled()) return { ok: true };

  const uid = Number(userId);
  const value = Number(amount);
  if (!Number.isFinite(uid) || uid <= 0) return { ok: true };
  if (!Number.isFinite(value) || value <= 0) return { ok: true };

  const [hour, day] = await Promise.all([
    prisma.walletTransaction.aggregate({
      where: { user_id: uid, trx_type: DEBIT, created_at: { gte: windowSince(60, now) } },
      _count: { _all: true },
      _sum: { total_amount: true },
    }),
    prisma.walletTransaction.aggregate({
      where: { user_id: uid, trx_type: DEBIT, created_at: { gte: windowSince(60 * 24, now) } },
      _sum: { total_amount: true },
    }),
  ]);

  const hourCount = Number(hour?._count?._all || 0);
  const hourSpent = Number(hour?._sum?.total_amount?.toString?.() ?? hour?._sum?.total_amount ?? 0);
  const daySpent = Number(day?._sum?.total_amount?.toString?.() ?? day?._sum?.total_amount ?? 0);

  const verdict = decide({ hourCount, hourSpent, daySpent, amount: value });

  // A tripped limit is the "unusual activity" line of the checklist, so it
  // raises an alert as well as blocking. Throttled by alerts.service, and the
  // user id is the only identifier that goes with it.
  if (!verdict.ok) {
    securityEvent('velocity.limit', `Wallet velocity limit hit (${verdict.reason})`, {
      user_id: uid,
      hour_count: hourCount,
      reason: verdict.reason,
    });
  }

  return verdict;
}

module.exports = { checkVelocity, decide, isEnabled, limits, __test: { envNumber, windowSince } };
