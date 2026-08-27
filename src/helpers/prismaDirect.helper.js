/**
 * Accelerate's proxy drops long-running connections with P6000. Every StaffPay
 * money path already retried those on `prisma.$direct`; this is that retry, in
 * one place instead of a copy per service.
 */
const prisma = require('../../database/prisma');

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'));
}

async function withDirectFallback(run) {
  try {
    return await run(prisma);
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) return await run(prisma.$direct);
    throw e;
  }
}

module.exports = { isAccelerateCommError, withDirectFallback };
