/**
 * Single entry point for moving a balance - user wallets and StaffPay company
 * wallets alike.
 *
 * Balance stays a plain Decimal column - see the note in pii.helper.js. It has
 * to support `{ increment }` so Postgres does the arithmetic atomically; the
 * moment you encrypt it you are forced into read-modify-write and concurrent
 * credits start overwriting each other. What we get instead is tamper
 * evidence: every legitimate movement re-stamps balance_mac, so a row edited
 * directly in the database no longer verifies.
 *
 * Always call these inside the same prisma.$transaction as the ledger write.
 */

const { balanceMac, verifyBalanceMac } = require('./pii.helper');
const { invalidateUserAfterCommit } = require('../services/userCache.service');
const { broadcastToUserIds } = require('../services/notificationWs.service');
const cache = require('../services/cache.service');

/**
 * Tell the owner's open app that its balance moved.
 *
 * A signal, not a number: the socket says "refetch", the app reads the balance
 * back off /dashboard the usual way. Sending the figure would mean sending a
 * balance that a rollback can still take back, and putting money on the wire
 * for no gain.
 *
 * Twice, for the same reason invalidateUserAfterCommit drops the cache twice -
 * this runs inside the transaction, so the first ping can be answered before
 * COMMIT lands and read the old row. The second one is the one that is always
 * right; the first is what makes a credit feel instant.
 */
function pingBalance(ownerId) {
  const payload = { event: 'wallet.balance' };
  const send = () => {
    try {
      broadcastToUserIds([Number(ownerId)], payload);
    } catch (_) {}
  };
  send();
  setTimeout(send, Number(process.env.USER_CACHE_RECHECK_MS || 1500)).unref();
}

// The user wallet is the row userCache.service hands to `req.user`, so every
// movement has to drop it - otherwise a funded account shows the old balance
// until the TTL runs out. StaffPay wallets are not cached.
//
// The transaction lists go with it. This is the one place worth hooking them:
// every ledger writer in the codebase - transfers, bills, betting, funding
// webhooks, request-money, StaffPay subscriptions, admin adjustments - pairs its
// walletTransaction.create with a call through here, so a new writer gets
// correct invalidation for free instead of having to remember a second call.
//
// Dropped twice for the same reason invalidateUserAfterCommit drops twice: this
// runs inside the transaction, so a concurrent reader can still load and cache
// the pre-COMMIT list. The delayed drop is the one that is always right.
function dropUserCache(wallet, ownerId) {
  if (wallet !== 'user') return;
  invalidateUserAfterCommit(ownerId);
  cache.dropUserActivity(ownerId);
  setTimeout(
    () => cache.dropUserActivity(ownerId),
    Number(process.env.USER_CACHE_RECHECK_MS || 1500)
  ).unref();
  pingBalance(ownerId);
}

// The MAC is bound to an owner id so a row cannot be copied onto another
// account. Each wallet type names the column that identifies its owner.
const WALLETS = {
  user: { model: 'user', owner: 'id' },
  staffPayWallet: { model: 'staffPayWallet', owner: 'company_id' },
};

function macFor(wallet, ownerId, balance) {
  return balanceMac(`${wallet}:${ownerId}`, String(balance));
}

/**
 * Apply a signed delta and re-stamp the integrity MAC.
 * `tx` is a prisma transaction client. Returns the updated row.
 */
async function applyBalanceDelta(tx, wallet, ownerId, delta) {
  const spec = WALLETS[wallet];
  if (!spec) throw new Error(`applyBalanceDelta: unknown wallet '${wallet}'`);
  const where = { [spec.owner]: Number(ownerId) };

  const updated = await tx[spec.model].update({
    where,
    data: { balance: { increment: delta } },
  });

  // Second write: the new balance is only known after Postgres applies the
  // increment, and re-reading it here is what keeps the MAC honest.
  await tx[spec.model].update({
    where,
    data: { balance_mac: macFor(wallet, ownerId, updated.balance.toString()) },
  });

  dropUserCache(wallet, ownerId);
  return updated;
}

/**
 * upsert equivalent: credit an existing wallet or create it at `delta`.
 * Used by the StaffPay funding paths, where the wallet row may not exist yet.
 */
async function upsertBalanceDelta(tx, wallet, ownerId, delta) {
  const spec = WALLETS[wallet];
  if (!spec) throw new Error(`upsertBalanceDelta: unknown wallet '${wallet}'`);
  const where = { [spec.owner]: Number(ownerId) };

  const row = await tx[spec.model].upsert({
    where,
    update: { balance: { increment: delta } },
    create: { [spec.owner]: Number(ownerId), balance: delta },
  });

  await tx[spec.model].update({
    where,
    data: { balance_mac: macFor(wallet, ownerId, row.balance.toString()) },
  });

  dropUserCache(wallet, ownerId);
  return row;
}

/**
 * Re-stamp the MAC from whatever the balance currently is. For the conditional
 * reserve paths (`updateMany` with `balance: { gte: total }`), where the guard
 * has to stay in the SQL and cannot be expressed as a plain delta.
 */
async function restampBalance(tx, wallet, ownerId) {
  const spec = WALLETS[wallet];
  if (!spec) throw new Error(`restampBalance: unknown wallet '${wallet}'`);
  const where = { [spec.owner]: Number(ownerId) };

  const row = await tx[spec.model].findUnique({ where });
  if (!row) return null;

  dropUserCache(wallet, ownerId);
  return tx[spec.model].update({
    where,
    data: { balance_mac: macFor(wallet, ownerId, row.balance.toString()) },
  });
}

/**
 * Check a row's balance against its MAC. Returns true for rows that predate
 * the backfill (no MAC yet) so this can be rolled out before every row is
 * stamped - tighten to `return false` once scripts/backfill-pii.js reports
 * clean everywhere.
 */
function isBalanceIntact(wallet, row) {
  if (!row) return false;
  if (!row.balance_mac) return true;
  const spec = WALLETS[wallet];
  if (!spec) return false;
  const ownerId = row[spec.owner];
  const balance = row.balance?.toString?.() ?? String(row.balance ?? '0');
  return verifyBalanceMac(`${wallet}:${ownerId}`, balance, row.balance_mac);
}

module.exports = {
  applyBalanceDelta,
  upsertBalanceDelta,
  restampBalance,
  isBalanceIntact,
  WALLETS,
};
