/**
 * RETIRED - DISABLED. Do not re-enable without rewriting the query.
 *
 * This told users who had verified one document that they were already done,
 * back when verification took BVN *or* NIN. The rule has since gone to
 * BVN-plus-bank-account, then to BVN-and-NIN, back to BVN *or* NIN, and is now
 * the BVN alone.
 *
 * Under that last rule its message - "your NIN is all we need" - is FALSE for
 * precisely the users it selects. A NIN-only row no longer passes the gate, and
 * this would tell somebody their wallet has no limit while the gate holds it.
 *
 * Two further reasons it stays disabled, which outlive the wording:
 *
 *   - the query is keyed on `grandfathered`, which does not mean what it did.
 *     That column was set where `status = 'verified' OR nin_status = 'verified'`,
 *     which is now a strictly BROADER set than the gate. It selects rows that
 *     fail verification.
 *   - there is nobody to tell either way. No account was ever verified by NIN,
 *     so the group this looks for is empty (see the count query in
 *     kycGate.rowIsVerified), and no user was notified of any earlier tightening
 *     (see notify-kyc-nin-required.js).
 *
 * If a "your BVN is all we need" announcement is ever wanted, write a fresh
 * script off `rowIsVerified` with a new `client_message_id`. Do not revive this
 * one - `kyc_one_document_v1` is already spent for everyone it reached.
 *
 * Kept on disk rather than deleted only as the record of what was sent to whom
 * under `client_message_id = kyc_one_document_v1`.
 */
require('dotenv').config();

const prisma = require('../database/prisma');
const { notifyUser } = require('../src/services/notify.service');
const { logUserEvent } = require('../src/services/userAudit.service');

// Bump the suffix only if the message has to go out again on purpose.
const CLIENT_MESSAGE_ID = 'kyc_one_document_v1';

async function main() {
  // Hard stop, before any query. The message below is false under the current
  // verification rule, so there is no argument - not even --send - that should
  // put it on somebody's phone.
  console.error(
    'notify-kyc-one-document is RETIRED: verification is the BVN alone, so "your NIN is all we need" is false.\n' +
    'If an announcement is genuinely wanted, write a fresh script off rowIsVerified with a new client_message_id.',
  );
  process.exitCode = 1;
  return;

  // eslint-disable-next-line no-unreachable
  const send = process.argv.includes('--send');

  if (!prisma.kycVerification) {
    throw new Error('Missing Prisma model KycVerification. Run npx prisma generate first.');
  }

  // Exactly one document verified, AND grandfathered - meaning the row was
  // already verified when the BVN-plus-account rule came in, so it keeps its
  // wallet on that one document permanently. A row with both is not affected by
  // the change, a row with neither is still unverified, and a row that is not
  // grandfathered owes a bank account and must not be told otherwise.
  const rows = await prisma.kycVerification.findMany({
    where: {
      grandfathered: true,
      OR: [
        { status: 'verified', nin_status: { not: 'verified' } },
        { nin_status: 'verified', status: { not: 'verified' } },
      ],
    },
    select: { user_id: true, status: true },
  });

  console.log(`${rows.length} grandfathered account(s) verified by one document only`);
  if (!send) {
    console.log('dry run - nothing sent. Re-run with --send to notify them.');
    return;
  }

  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const label = row.status === 'verified' ? 'BVN' : 'NIN';
    const delivered = await notifyUser({
      userId: row.user_id,
      subject: 'You are already verified',
      message:
        `Good news: your ${label} is all we need. Verification now takes one document, so there is ` +
        'nothing left for you to submit and your wallet has no receiving limit.',
      type: 'kyc',
      data: { status: 'verified', document: label.toLowerCase() },
      clientMessageId: CLIENT_MESSAGE_ID,
    });

    if (delivered) {
      sent += 1;
      await logUserEvent({
        userId: row.user_id,
        event: 'kyc.one_document_notified',
        metadata: { document: label.toLowerCase() },
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
