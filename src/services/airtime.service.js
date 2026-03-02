const { Prisma } = require('@prisma/client');

const historyStore = new Map(); // key: userId -> array of records (latest first)

function listHistory(userId) {
  const k = Number(userId) || 0;
  const arr = historyStore.get(k) || [];
  return Array.isArray(arr) ? arr : [];
}

function addHistory(userId, record) {
  const k = Number(userId) || 0;
  const arr = historyStore.get(k) || [];
  arr.unshift(record);
  historyStore.set(k, arr);
}

function clearHistory(userId) {
  const k = Number(userId) || 0;
  historyStore.delete(k);
}

function generateTrx(prefix = 'air') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

function toDecimal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return new Prisma.Decimal(0);
  return new Prisma.Decimal(num.toFixed(2));
}

module.exports = { listHistory, addHistory, clearHistory, generateTrx, toDecimal };
