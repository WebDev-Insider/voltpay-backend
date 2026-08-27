// First-transfer confirmation.
//
// Most transfer fraud in Nigeria is not a broken crypto primitive, it is a
// digit. Someone is talked into paying an "account officer", or a saved number
// is off by one, and every server-side check passes because the transfer is
// technically valid. The one moment worth interrupting is the FIRST time money
// goes to a given recipient - after that the user has seen the name land.
//
// "Known" is derived from the ledger rather than a beneficiaries table: if
// wallet_transactions already shows a completed transfer to this recipient, the
// user has met them. No new table, no sync problem, and it cannot drift from
// what actually happened.
//
// The acknowledgement itself is parked in pending.service (Redis, with the same
// in-process fallback), keyed by sender and recipient. Losing it costs one
// extra confirmation, never a silent bypass.

const prisma = require('../../database/prisma');
const { setPending, getPending, clearPending } = require('../services/pending.service');
const cache = require('../services/cache.service');

const ACK_TTL_MS = 10 * 60_000;

function ackRemark(receiverId) {
  return `beneficiary_ack:${Number(receiverId) || 0}`;
}

/**
 * Has this sender ever completed a transfer to this recipient?
 *
 * Fails CLOSED - if the lookup throws, the recipient is treated as new and the
 * user is asked to confirm. The cost of being wrong is one extra tap; the cost
 * of the opposite is a transfer to a stranger going out unchallenged.
 *
 * Cached, but only the "already known" answer, and that asymmetry is the whole
 * design:
 *
 * - The underlying query is a JSON-path count over the ledger
 *   (`meta -> receiver_id`), which no ordinary btree index covers, so it gets
 *   slower for exactly the users who transfer most. It runs on the quote call,
 *   in front of the confirmation sheet, where latency is visible.
 * - "Known" only ever travels one way. A completed transfer cannot un-complete,
 *   so a cached `known` can never become wrong and never needs invalidating -
 *   the TTL is only there to bound a Redis key, not to correct anything.
 * - "New" is never cached. That answer flips to `known` the moment the transfer
 *   lands, and caching it would re-prompt a user who has just been through the
 *   confirmation. A miss on the safe side costs one query.
 *
 * Note this is a *speed* cache, not a security decision: a cache miss or a
 * dead Redis simply runs the query, and the prompt is driven by the answer
 * either way.
 */
async function isNewBeneficiary(senderId, receiverId) {
  const sender = Number(senderId);
  const receiver = Number(receiverId);
  if (!Number.isFinite(sender) || !Number.isFinite(receiver)) return true;

  const knownKey = cache.keys.beneficiaryKnown(sender, receiver);
  if (await cache.getFlag(knownKey)) return false;

  try {
    const seen = await prisma.walletTransaction.count({
      where: {
        user_id: sender,
        remark: 'send_money',
        // meta is JSON; the receiver id is written there by verification.controller.
        meta: { path: ['receiver_id'], equals: receiver },
      },
    });
    if (seen > 0) cache.setFlag(knownKey, cache.TTL.beneficiaryKnown);
    return seen === 0;
  } catch (e) {
    console.warn('beneficiary: history lookup failed, asking for confirmation', {
      user_id: sender,
      reason: String(e?.message || e).slice(0, 120),
    });
    return true;
  }
}

/** True when this sender already acknowledged this recipient in the last 10 minutes. */
async function hasAcknowledged(senderId, receiverId) {
  const ack = await getPending(senderId, ackRemark(receiverId));
  return Boolean(ack);
}

async function recordAcknowledgementPrompt(senderId, receiverId) {
  await setPending(senderId, ackRemark(receiverId), { prompted_at: Date.now() }, { ttlMs: ACK_TTL_MS });
}

async function clearAcknowledgement(senderId, receiverId) {
  await clearPending(senderId, ackRemark(receiverId));
}

module.exports = {
  isNewBeneficiary,
  hasAcknowledged,
  recordAcknowledgementPrompt,
  clearAcknowledgement,
  ACK_TTL_MS,
  __test: { ackRemark },
};
