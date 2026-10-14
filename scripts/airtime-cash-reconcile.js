// Airtime to Cash reconciliation, on demand.
//
//   npm run a2c:reconcile            dry run: reports, writes nothing
//   npm run a2c:reconcile -- --apply recovers what it reported, and notifies
//
// Two lists:
//
//   1. Misfiled conversions - step 3 sent, MySubWallet's own words were an
//      acceptance ("Checking transaction... We will notify you once it is
//      successful."), and the row still sits in a draft state. --apply
//      recovers each as the customer's pending cash, once, and tells them.
//      The 5-minute sweep in server.js does exactly this on its own; this is
//      the same pass, run now and shown.
//   2. Everything else that needs a person (in flight, unconfirmed, or sent
//      and never recorded), plus conversions failed in the last 14 days after
//      their transfer was sent - a failure decided without MySubWallet's side
//      (conversion #5, 2026-10-12) can still be wrong. Reported only: their
//      requery cannot see Airtime to Cash, so only MySubWallet's dashboard can
//      settle these - then "Record provider success" or "Mark failed" on the
//      admin screen.
//
// Ids, references and amounts only. Never a phone number or a name.
require('dotenv').config();
const prisma = require('../database/prisma');
const service = require('../src/services/airtimeCash.service');
const A2C = require('../src/helpers/airtimeCash.helper');

const apply = process.argv.includes('--apply');
// Older failures are settled history; listing them forever would bury the
// cases that are still answerable.
const FAILED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

(async () => {
  if (apply) {
    // Pushes go out on recovery; without Firebase they are stored but not sent.
    try {
      require('../src/services/firebase.service').initFirebase();
    } catch (e) {
      console.warn('note  Firebase not initialised - notifications are stored, not pushed:', e?.message);
    }
  }

  const misfiled = await service.reconcileMisfiled({ limit: 500, apply });
  console.log(`\n${apply ? 'RECOVERED' : 'WOULD RECOVER'} (accepted at MySubWallet, never recorded): ${misfiled.recovered.length}`);
  for (const r of misfiled.recovered) {
    console.log(`  #${r.id}  ${r.reference}  user ${r.user_id}  payout NGN ${r.payout}  was ${r.from}`);
  }

  const rows = await prisma.airtimeCashConversion.findMany({
    where: {
      OR: [
        { status: A2C.STATUS.SUBMITTING },
        { status: A2C.STATUS.PROCESSING, provider_status: { in: ['pending', 'unknown'] } },
        { status: { in: [A2C.STATUS.OTP_VERIFIED, A2C.STATUS.ABANDONED] }, convert_attempts: { gte: 1 } },
        { status: A2C.STATUS.FAILED, convert_attempts: { gte: 1 }, failed_at: { gte: new Date(Date.now() - FAILED_LOOKBACK_MS) } },
      ],
    },
    orderBy: { id: 'asc' },
    take: 500,
  });
  const open = rows
    .map(r => ({ row: r, state: service.reviewState(r) }))
    .filter(({ row, state }) => state.needs_review || (row.status === A2C.STATUS.FAILED && state.recordable));

  console.log(`\nNEEDS A PERSON (check MySubWallet's dashboard): ${open.length}`);
  for (const { row, state } of open) {
    console.log(
      `  #${row.id}  ${row.reference}  user ${row.user_id}  ${row.network}  ${row.amount == null ? '-' : `NGN ${row.amount} -> ${row.payout}`}` +
        `  status ${row.status}  ${state.needs_review || 'failed after sending'}  request-id ${row.provider_request_id || '-'}` +
        `${row.provider_message ? `  said: "${String(row.provider_message).slice(0, 80)}"` : ''}`,
    );
  }

  if (!apply && misfiled.recovered.length) console.log('\nRun again with --apply to recover the first list (the server sweep will also do it within 5 minutes).');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
