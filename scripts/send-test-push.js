#!/usr/bin/env node
/**
 * Fire one credit-alert banner without moving money.
 *
 *   node scripts/send-test-push.js            # first user that has a token
 *   node scripts/send-test-push.js 42         # a specific user id
 *   node scripts/send-test-push.js 42 "Ada Okoro" 5000
 *
 * Goes through the same fcm.service.sendToUser() the webhook uses, so the
 * payload, channel and priority are identical to a real credit. Writes no
 * wallet row and no notification row - purely the transport.
 *
 * Prints user ids only, never the token or a name from the database.
 */
require('dotenv').config();

const prisma = require('../database/prisma');
const { initFirebase } = require('../src/services/firebase.service');
const { sendToUser, messagingAvailable } = require('../src/services/fcm.service');

function formatNaira(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '₦0.00';
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

(async () => {
  const [idArg, senderArg, amountArg] = process.argv.slice(2);
  const sender = senderArg || 'John Doe';
  const amount = Number(amountArg || 5000);

  const source = initFirebase();
  if (!messagingAvailable()) {
    console.error('❌ Firebase Admin did not start. Run `npm run check:fcm` first.');
    process.exit(1);
  }
  console.log(`🔥 Firebase up (${source})`);

  let userId = idArg ? Number(idArg) : null;
  if (userId) {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fcm_token_enc: true },
    });
    if (!row) {
      console.error(`❌ No user with id ${userId}`);
      process.exit(1);
    }
    if (!row.fcm_token_enc) {
      console.error(`❌ User ${userId} has no FCM token stored.`);
      console.error('   The app must log in once on a device first - login POSTs /api/device-token.');
      process.exit(1);
    }
  } else {
    const row = await prisma.user.findFirst({
      where: { fcm_token_enc: { not: null } },
      orderBy: { fcm_token_updated_at: 'desc' },
      select: { id: true, fcm_platform: true, fcm_token_updated_at: true },
    });
    if (!row) {
      console.error('❌ No user in the database has an FCM token yet.');
      console.error('   Build the app, log in on a device, then re-run. See FCM_SETUP.md §6.');
      process.exit(1);
    }
    userId = row.id;
    console.log(`📱 Newest token: user ${row.id} (${row.fcm_platform || 'unknown'}, ${row.fcm_token_updated_at?.toISOString() || 'no timestamp'})`);
  }

  const body = `${sender} sent you ${formatNaira(amount)}`;
  const sent = await sendToUser(userId, {
    title: 'Money Received',
    body,
    data: {
      type: 'credit_alert',
      trx: `TEST-${Date.now()}`,
      amount: amount.toFixed(2),
      sender,
    },
  });

  if (sent) {
    console.log(`✅ Accepted by FCM - "${body}" to user ${userId}`);
    console.log('   Nothing on the device? Check FCM_SETUP.md §6 troubleshooting.');
  } else {
    console.error(`❌ FCM rejected the send for user ${userId}.`);
    console.error('   A dead token is auto-cleared; log in again to re-register.');
  }

  await prisma.$disconnect();
  process.exit(sent ? 0 : 1);
})();
