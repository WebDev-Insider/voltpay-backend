/**
 * RETIRED - DISABLED. Never sent. Do not re-enable without rewriting the message.
 *
 * This existed to warn the users whose wallet locked when verification tightened
 * to BVN *and* NIN. That rule was withdrawn before this ever ran, and the NIN has
 * since been withdrawn entirely: verification is a verified BVN, and nothing
 * else.
 *
 * So its message - "identity verification now takes both your BVN and your NIN"
 * - names a document that no longer verifies anybody, and would send whoever
 * read it to a form that answers 410. It is disabled rather than left as a
 * no-op, because the day someone reaches for it is the day the filter has
 * changed underneath the message.
 *
 * No correction campaign is owed for either change:
 *   - nobody was ever told they needed both. This never ran with --send, and
 *     `client_message_id = kyc_nin_required_v1` was never written.
 *   - the BVN-and-NIN withdrawal could not lock anyone. OR is strictly weaker
 *     than AND, so every row that passed that rule passed the next one.
 *   - the NIN withdrawal COULD have, since it is a tightening - but the exposed
 *     set was counted first and was empty. No account had ever been verified by
 *     NIN. The standing query is in kycGate.rowIsVerified; re-run it before
 *     shipping the rule to an environment with real users.
 *
 * Kept on disk as the record of a cutover that was planned and then reversed.
 */
require('dotenv').config();

const prisma = require('../database/prisma');
const { rowIsVerified } = require('../src/helpers/kycGate.helper');
const { notifyUser } = require('../src/services/notify.service');
const { logUserEvent } = require('../src/services/userAudit.service');

// Bump the suffix only if the message has to go out again on purpose.
const CLIENT_MESSAGE_ID = 'kyc_nin_required_v1';

async function main() {
  // Hard stop, before any query. The message below is false under the current
  // verification rule, so there is no argument - not even --send - that should
  // put it on somebody's phone.
  console.error(
    'notify-kyc-nin-required is RETIRED: verification is the BVN alone, and the NIN route answers 410.\n' +
    'This message would send every phone it reached to a form that no longer exists.',
  );
  process.exitCode = 1;
  return;

  // eslint-disable-next-line no-unreachable
  const send = process.argv.includes('--send');

  if (!prisma.kycVerification) {
    throw new Error('Missing Prisma model KycVerification. Run npx prisma generate first.');
  }

  // Everything that passed under any previous rule:
  //   - grandfathered rows, which passed on either single document
  //   - BVN plus a verified bank account, which was the rule until now
  //
  // Deliberately a wide net. The narrowing is done below by the real gate
  // predicate rather than by a second hand-written condition here - if this
  // query and `rowIsVerified` ever disagreed, the disagreement would show up as
  // a push telling somebody their wallet is locked when it is not.
  const candidates = await prisma.kycVerification.findMany({
    where: {
      OR: [
        { grandfathered: true, status: 'verified' },
        { grandfathered: true, nin_status: 'verified' },
        { status: 'verified', account_status: 'verified' },
      ],
    },
    select: { user_id: true, status: true, nin_status: true },
  });

  // ...and of those, the ones the current rule locks out.
  const locked = candidates.filter(row => !rowIsVerified(row));

  const needNin = locked.filter(row => row.status === 'verified');
  const needBvn = locked.filter(row => row.status !== 'verified');

  console.log(`${candidates.length} account(s) verified under a previous rule`);
  console.log(`${locked.length} of them are locked by the BVN+NIN rule`);
  console.log(`  ${needNin.length} need a NIN, ${needBvn.length} need a BVN`);

  if (!send) {
    console.log('dry run - nothing sent. Re-run with --send to notify them.');
    return;
  }

  let sent = 0;
  let skipped = 0;

  for (const row of locked) {
    // One document is missing, never both: these rows all passed an older rule,
    // so they hold at least one verified document already.
    const missing = row.status === 'verified' ? 'NIN' : 'BVN';

    const delivered = await notifyUser({
      userId: row.user_id,
      subject: 'One more step to unlock your wallet',
      message:
        'Identity verification now takes both your BVN and your NIN. ' +
        `Add your ${missing} in Settings to unlock your balance - it takes about a minute, ` +
        'and your money is safe in your wallet in the meantime.',
      type: 'kyc',
      data: { status: 'action_required', document: missing.toLowerCase() },
      clientMessageId: CLIENT_MESSAGE_ID,
    });

    if (delivered) {
      sent += 1;
      await logUserEvent({
        userId: row.user_id,
        event: 'kyc.nin_required_notified',
        metadata: { document: missing.toLowerCase() },
      });
    } else {
      // Already notified on an earlier run, or the notification row could not
      // be written. Either way this user is not messaged twice.
      skipped += 1;
    }
  }

  console.log(`notified ${sent}, skipped ${skipped}`);
}

main()
  .catch(e => {
    console.error('FAILED:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
