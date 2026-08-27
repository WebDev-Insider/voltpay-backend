// Pending action store: the payload of a purchase or transfer that has been
// priced and is waiting for the user to confirm it with their PIN.
//
// This used to be an in-process Map, so a restart mid-confirmation - or a
// second instance answering the confirm call - lost the payload and the user
// got "nothing to confirm" after already entering their PIN. Redis holds it
// now, keyed by user id and remark, with the same TTL.
//
// The payload describes a transaction (amount, network, meter number), so it
// follows the ledger rule from CLAUDE.md: store counterparty ids, never a
// name, email or phone number.
//
// The Map stays as the fallback for when Redis is not configured, which keeps
// local development working with no extra setup.
const redis = require('./redis.service');

const store = new Map();

function keyOf(userId, remark) {
  return `${Number(userId) || 0}:${String(remark || '').trim()}`;
}

function redisKey(userId, remark) {
  return redis.key('pending', Number(userId) || 0, String(remark || '').trim());
}

async function setPending(userId, remark, payload, { ttlMs = 5 * 60_000 } = {}) {
  if (redis.isEnabled()) {
    const stored = await redis.set(redisKey(userId, remark), payload, Math.ceil(ttlMs / 1000));
    if (stored !== null) return;
  }
  store.set(keyOf(userId, remark), { payload, expireAt: Date.now() + ttlMs });
}

async function getPending(userId, remark) {
  if (redis.isEnabled()) {
    const hit = await redis.get(redisKey(userId, remark));
    if (hit !== null) return hit;
  }

  const k = keyOf(userId, remark);
  const record = store.get(k);
  if (!record) return null;
  if (record.expireAt && Date.now() > record.expireAt) {
    store.delete(k);
    return null;
  }
  return record.payload;
}

async function clearPending(userId, remark) {
  store.delete(keyOf(userId, remark));
  if (redis.isEnabled()) await redis.del(redisKey(userId, remark));
}

module.exports = { setPending, getPending, clearPending };
