// Simple in-memory pending action store (ephemeral). Suitable for dev/demo.
// Keys are `${userId}:${remark}` and values are arbitrary JSON payloads.

const store = new Map();

function keyOf(userId, remark) {
  return `${Number(userId) || 0}:${String(remark || '').trim()}`;
}

function setPending(userId, remark, payload, { ttlMs = 5 * 60_000 } = {}) {
  const k = keyOf(userId, remark);
  const record = { payload, expireAt: Date.now() + ttlMs };
  store.set(k, record);
}

function getPending(userId, remark) {
  const k = keyOf(userId, remark);
  const record = store.get(k);
  if (!record) return null;
  if (record.expireAt && Date.now() > record.expireAt) {
    store.delete(k);
    return null;
  }
  return record.payload;
}

function clearPending(userId, remark) {
  const k = keyOf(userId, remark);
  store.delete(k);
}

module.exports = { setPending, getPending, clearPending };
