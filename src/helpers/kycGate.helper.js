// KYC gate on the wallet.
//
// The trigger is money coming IN, not money going out. An account that has
// received KYC_FUNDING_LIMIT or more into its dedicated virtual account without
// a verified BVN has taken in more value than an unidentified wallet is allowed
// to hold, so the balance is frozen: no bills, no airtime, no data, no
// electricity, no transfers, until the identity behind the wallet is known.
//
// Freezing the whole balance rather than the excess is deliberate. There is one
// `balance` column, naira are fungible, and nothing in the ledger says which
// hundred naira came from which credit - "spend the pre-trigger part only"
// cannot be expressed against that schema without inventing a second balance.
//
// Counted from funding_transactions rather than a running column on the user:
// it is the record of what the rail actually credited, an attacker cannot edit
// it, and it stays correct if a cache is wiped. Rows with `credited_at = null`
// are the virtual-account placeholder (amount 0.00) and the abandoned top-ups,
// so `credited_at` not null is exactly "money that landed".
//
// Errors are not swallowed. This shares a database with the payment it guards,
// so a payment that cannot read this was not going to settle either - and a KYC
// gate that opens when the query fails is not a gate.

const prisma = require('../../database/prisma');

// `Number('')` is 0, and 0 would read as "no funding allowed without KYC" and
// freeze every unverified user's first hundred naira. Catch the empty string
// before parsing - same trap as velocity.helper's envNumber().
function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fundingLimit() {
  return envNumber('KYC_FUNDING_LIMIT', 25_000);
}

// `lifetime` totals every credit ever received; `single` only looks at the
// largest one. Lifetime is the default because `single` is trivially defeated
// by splitting a deposit into six smaller ones.
function limitMode() {
  return String(process.env.KYC_FUNDING_LIMIT_MODE ?? 'lifetime').trim().toLowerCase() === 'single'
    ? 'single'
    : 'lifetime';
}

function isEnabled() {
  return String(process.env.KYC_GATE_ENABLED ?? '1').trim().toLowerCase() !== '0';
}

/**
 * Is a verified bank account required on top of the identity document?
 *
 * ON. Every verified wallet must have one, whichever identity route it took.
 *
 * This is not belt-and-braces, it is the half the identity document cannot
 * supply. A BVN or a NIN slip answers "who is this person"; a resolved bank
 * account answers "and where do they bank" - which is the question that matters
 * when money has to be returned, a payout has to land, or a transaction has to
 * be traced. It is also the cheap half: Paystack resolves it in a second and
 * charges nothing for it.
 *
 * Note the direction of the AND. A bank account on its own is NOT a route in,
 * and never can be, because Paystack's /bank/resolve returns the registered
 * name for ANY account number - anyone can resolve anyone's. It proves the
 * account exists and who owns it, never that the person asking is that person.
 * As a second factor behind a BVN that is fine; as a first factor it would be
 * namesake fraud waiting to happen.
 *
 * The escape hatch exists for one situation only: a deployment that already has
 * verified users from before this rule, where turning it on would freeze live
 * wallets whose owners were never asked for an account. Check first -
 *
 *   SELECT count(*) FROM kyc_verifications
 *    WHERE (status = 'verified' OR nin_slip_status = 'approved')
 *      AND account_status <> 'verified';
 *
 * - and only set KYC_BANK_REQUIRED=0 if that number is not something you can
 * clear by asking those users for an account. It was 0 when the rule shipped.
 */
function bankRequired() {
  return String(process.env.KYC_BANK_REQUIRED ?? '1').trim().toLowerCase() !== '0';
}

function naira(n) {
  return `₦${Number(n).toLocaleString('en-NG')}`;
}

function toNumber(value) {
  return Number(value?.toString?.() ?? value ?? 0);
}

/**
 * Has this row cleared verification?
 *
 * TWO REQUIREMENTS, AND BOTH MUST HOLD. An identity document, AND a bank
 * account. It is an AND, not an OR, and reading it as an OR is the mistake this
 * whole comment exists to prevent.
 *
 * Requirement one - who is this person. Either route counts:
 *   a. `status === 'verified'`          - a BVN Payvessel matched against the
 *                                         NIBSS register. Seconds, automatic.
 *   b. `nin_slip_status === 'approved'` - a photograph of a NIN slip that a
 *                                         named admin opened, read and
 *                                         approved. A day or two, human.
 *
 * Requirement two - where do they bank:
 *      `account_status === 'verified'`  - an account Paystack resolved to a
 *                                         name that matches the profile.
 *                                         Required of everybody, whichever of
 *                                         (a) or (b) they used. See
 *                                         bankRequired() for why, and for the
 *                                         one situation that switches it off.
 *
 * Route (b) exists because a customer with no BVN at all had no way through at
 * all. Weaker evidence than (a) - a picture is forgeable in a way a NIBSS lookup
 * is not - which is exactly why it costs a human being's attention and records
 * who spent it (`nin_slip_reviewed_by`).
 *
 * `nin_status` is NOT `nin_slip_status`, and reading the wrong one is the most
 * expensive mistake available in this file. `nin_status` is the fossil of the
 * withdrawn automated NIN-number check: rows still carry `'verified'` there and
 * it verifies NOBODY. Merging the two columns would silently promote every one
 * of those fossils into an unlocked wallet. That is the whole reason the slip
 * got its own column set instead of reusing the old one.
 *
 * `grandfathered` is not part of the decision. The earlier grandfather clause is
 * withdrawn and that column survives for retention only - it marks a strictly
 * broader set than any rule here, so reading it would open wallets nobody chose
 * to open.
 *
 * Kept as a pure function so the gate's core decision can be tested without a
 * database - this is the predicate that decides whether money moves.
 */
function rowIsVerified(row) {
  return hasIdentity(row) && hasBank(row);
}

/** Requirement one: a BVN Payvessel matched, or a NIN slip an admin approved. */
function hasIdentity(row) {
  if (!row) return false;
  return row.status === 'verified' || row.nin_slip_status === 'approved';
}

/**
 * Requirement two: a bank account resolved to a matching name.
 *
 * Returns true when the requirement is switched off, because "not required" has
 * to read as "satisfied" here - anything else and every wallet on a deployment
 * with KYC_BANK_REQUIRED=0 stays shut.
 */
function hasBank(row) {
  if (!bankRequired()) return true;
  return row?.account_status === 'verified';
}

/**
 * Which identity route this row took: bvn | nin_slip | null.
 *
 * The strongest thing that is true, so a user who verified by BVN and later also
 * had a slip approved reports 'bvn' - a compliance screen naming the weaker of
 * two satisfied routes would be describing evidence we did not rely on.
 *
 * NOT a "which door opened" answer, because the bank account is not a door. It
 * is deliberately reported on its own key, so nothing downstream can mistake a
 * linked account for a way in.
 *
 * Returns null when no identity route passes - and note it can be non-null on a
 * row that rowIsVerified() still refuses, which is exactly the half-finished
 * state the app renders as "one step left".
 */
function verifiedVia(row) {
  if (!row) return null;
  if (row.status === 'verified') return 'bvn';
  if (row.nin_slip_status === 'approved') return 'nin_slip';
  return null;
}

/**
 * Has this user cleared verification?
 *
 * A missing Prisma model (client not regenerated yet) reads as "not verified".
 * That is the safe direction: an unverified wallet stays limited rather than
 * the gate opening for everyone.
 */
async function isKycVerified(userId) {
  return rowIsVerified(await kycStatuses(userId));
}

/**
 * The two status columns the gate reads, or null. One query, so a caller that
 * needs both the verdict and the reason does not make two.
 */
async function kycStatuses(userId) {
  if (!prisma.kycVerification) return null;
  return prisma.kycVerification.findUnique({
    where: { user_id: Number(userId) },
    // Every column rowIsVerified reads, or the door it belongs to never opens.
    // A `select` that omits `nin_slip_status` hands the predicate an undefined
    // and every approved slip reads as unverified - the failure is silent and
    // looks like the admin's approval simply did nothing. Add a column there,
    // add it here.
    select: { status: true, nin_slip_status: true, account_status: true },
  });
}

/**
 * How much has actually landed in this user's virtual account, in naira.
 * Lifetime total, or the largest single credit, per KYC_FUNDING_LIMIT_MODE.
 */
async function fundingReceived(userId) {
  const where = { user_id: Number(userId), credited_at: { not: null } };

  if (limitMode() === 'single') {
    const top = await prisma.fundingTransaction.findFirst({
      where,
      orderBy: { amount: 'desc' },
      select: { amount: true },
    });
    return toNumber(top?.amount);
  }

  const agg = await prisma.fundingTransaction.aggregate({ where, _sum: { amount: true } });
  return toNumber(agg?._sum?.amount);
}

/**
 * The decision on its own, so it can be tested without a database.
 *
 * At exactly the limit the wallet is frozen - the rule is "receives the limit
 * or more", so the boundary itself trips it.
 *
 * `identity`, `bank` and `slipStatus` change only the sentence, never the
 * verdict. Which one is missing is the single most useful thing this message can
 * carry: someone who has verified their BVN and is one bank account away from
 * spending should not be told to verify their BVN, and someone whose slip is
 * sitting in our queue should not be told to submit it - they will, and the
 * queue fills with duplicates.
 */
function decide({ verified, funded, identity, bank, slipStatus }, limit = fundingLimit()) {
  if (verified) return { ok: true };
  if (Number(funded) < limit) return { ok: true };

  const held = `Your wallet is on hold because it has received ${naira(limit)} or more. `;

  let next;
  if (identity && !bank) {
    // The good case: they are one instant, free step from done.
    next = 'Add and verify your bank account in Settings to unlock your balance.';
  } else if (slipStatus === 'pending') {
    next = 'Your NIN slip is being reviewed - this usually takes a day or two. You will also need to add your bank account.';
  } else {
    next = 'Verify your BVN and add your bank account in Settings to unlock your balance. BVN takes seconds.';
  }

  return { ok: false, reason: 'kyc_required', message: held + next };
}

/**
 * Gate one outgoing payment. Takes no amount - once the wallet is frozen the
 * whole balance is frozen, so ₦50 is refused for the same reason ₦50,000 is.
 *
 * @returns {Promise<{ok: boolean, reason?: string, message?: string}>}
 */
async function checkSpendKyc({ userId }) {
  if (!isEnabled()) return { ok: true };

  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { ok: true };

  const row = await kycStatuses(uid);
  if (rowIsVerified(row)) return { ok: true };

  return decide({
    verified: false,
    funded: await fundingReceived(uid),
    identity: hasIdentity(row),
    bank: hasBank(row),
    slipStatus: row?.nin_slip_status,
  });
}

/**
 * What the app shows on the verification screen: how much more the wallet can
 * receive before it locks, and whether it is locked already.
 */
async function kycAllowance(userId) {
  const limit = fundingLimit();
  const row = await kycStatuses(userId);
  const verified = rowIsVerified(row);
  const funded = verified ? 0 : await fundingReceived(userId);
  return {
    enabled: isEnabled(),
    mode: limitMode(),
    verified,
    // The two requirements, reported separately, because "not verified" on its
    // own tells the screen nothing about which of the two steps to show next.
    identity_done: hasIdentity(row),
    bank_done: hasBank(row),
    bank_required: bankRequired(),
    // Which identity route was taken, so the app can say "BVN verified" rather
    // than the vaguer "verified". Non-null on a row that is not yet verified -
    // that is the one-step-left state, not a bug.
    method: verifiedVia(row),
    nin_slip_status: row?.nin_slip_status ?? 'none',
    bank_status: row?.account_status ?? 'none',
    limit,
    funded,
    locked: !verified && isEnabled() && funded >= limit,
    remaining: verified ? null : Math.max(0, limit - funded),
  };
}

module.exports = {
  checkSpendKyc,
  kycAllowance,
  isKycVerified,
  kycStatuses,
  rowIsVerified,
  hasIdentity,
  hasBank,
  verifiedVia,
  bankRequired,
  fundingReceived,
  decide,
  fundingLimit,
  limitMode,
  isEnabled,
  __test: { envNumber },
};
