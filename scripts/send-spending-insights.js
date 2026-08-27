#!/usr/bin/env node
/**
 * Run a spending summary by hand, instead of waiting for Monday 09:00 WAT.
 *
 *   node scripts/send-spending-insights.js --dry               # print, send nothing
 *   node scripts/send-spending-insights.js --dry --period=month
 *   node scripts/send-spending-insights.js --user=42           # send to one user
 *   node scripts/send-spending-insights.js --dry --now=2026-08-03
 *   node scripts/send-spending-insights.js                     # send to everyone
 *
 * --dry reads the same rows the real send reads and prints the sentence without
 * writing a notification row or touching FCM. Run it once before the first live
 * Monday: the wording is the whole feature and it is unrecallable once pushed.
 *
 * --now takes a date so a summary can be checked against a period that has
 * already closed. It is interpreted as 09:00 WAT on that day.
 *
 * A real (non-dry) run is idempotent: the notification is keyed on the period,
 * so running it twice for the same week sends once.
 *
 * Prints user ids and amounts only, never a name, email or phone.
 */
require('dotenv').config();

const prisma = require('../database/prisma');
const { initFirebase } = require('../src/services/firebase.service');
const {
  sendSpendingInsights,
  insightForUser,
  spendingUserIds,
  windowsFor,
} = require('../src/services/spendingInsights.service');

function flag(name) {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
}

(async () => {
  const dry = Boolean(flag('dry'));
  const period = String(flag('period') || 'week').toLowerCase() === 'month' ? 'month' : 'week';
  const userArg = flag('user');

  const nowArg = flag('now');
  const now = typeof nowArg === 'string' ? new Date(`${nowArg}T08:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`❌ --now=${nowArg} is not a date. Use --now=2026-08-03.`);
    process.exit(1);
  }

  const { current, previous, key } = windowsFor(period, now);
  console.log(`📅 ${period} summary ${key}`);
  console.log(`   reporting ${current.start.toISOString()} .. ${current.end.toISOString()}`);
  console.log(`   against   ${previous.start.toISOString()} .. ${previous.end.toISOString()}`);

  const userIds = userArg && userArg !== true
    ? [Number(userArg)]
    : await spendingUserIds({ window: current, limit: 5000 });

  if (!userIds.length) {
    console.log('ℹ️  Nobody spent anything in that period. Nothing to send.');
    await prisma.$disconnect();
    process.exit(0);
  }

  if (dry) {
    let withInsight = 0;
    for (const userId of userIds) {
      const insight = await insightForUser({ userId, period, now });
      if (!insight) continue;
      withInsight += 1;
      console.log(`\n   user ${userId}`);
      console.log(`   ${insight.subject}`);
      console.log(`   ${insight.message}`);
    }
    console.log(`\n🔍 Dry run: ${withInsight}/${userIds.length} users would be notified. Nothing was sent.`);
    await prisma.$disconnect();
    process.exit(0);
  }

  // Only a real send needs FCM. A missing service account is not fatal - the
  // in-app notification row is still written, same as in production.
  const source = initFirebase();
  console.log(`🔥 Firebase ${source ? `up (${source})` : 'unavailable - in-app rows only, no banners'}`);

  const sent = await sendSpendingInsights({ period, now, userIds });
  console.log(`✅ ${sent}/${userIds.length} users notified.`);
  console.log('   A user counted as 0 either spent nothing or already has this period\'s summary.');

  await prisma.$disconnect();
  process.exit(0);
})();
