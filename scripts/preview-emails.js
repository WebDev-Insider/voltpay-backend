#!/usr/bin/env node
/**
 * Renders every email the backend can send to ./email-preview/*.html so the
 * layout can be checked in a browser without sending anything.
 *
 *   node scripts/preview-emails.js
 *   node scripts/preview-emails.js --open      (also opens the index)
 *
 * BREVO_API_KEY is never read here - nothing is sent. The sample data is
 * obviously fake on purpose: this script must never be pointed at a real
 * recovery phrase or a real OTP, because it writes them to disk in plaintext.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { renderEmail, blocks, brandName, logoUrl } = require('../src/services/emailTemplate.service');

const OUT_DIR = path.join(__dirname, '..', 'email-preview');

/* Each entry mirrors one production email. They call the same renderEmail()
   and the same blocks the senders do, so a change to the shell shows up here
   immediately; only the copy is duplicated, and only because the senders build
   theirs inside a function that ends in a network call. */

const brand = brandName();

const SAMPLES = [
  {
    file: 'otp-verify-email.html',
    label: 'OTP — email verification',
    html: () =>
      renderEmail({
        subject: `483920 is your ${brand} verification code`,
        preheader: `Expires in 5 minutes. ${brand} will never ask you for this code.`,
        eyebrow: 'Verify your email',
        heading: 'Confirm your email address',
        blocks: [
          blocks.paragraph(
            `Enter this code in the ${brand} app to finish setting up your account. It expires in <b>5 minutes</b>.`
          ),
          blocks.codePanel('483920', { caption: 'Verification code' }),
          blocks.notice({
            tone: 'info',
            title: `${brand} will never ask you for this code`,
            body: `Not by phone, not by SMS, not in a support chat. Anyone who does is trying to take your account. If you did not create a ${brand} account, ignore this email - the address will not be used.`,
          }),
        ],
        footnote: `Sent to the email address on your ${brand} account. Codes are single-use and stop working once entered.`,
      }),
  },
  {
    file: 'otp-password-reset.html',
    label: 'OTP — password reset',
    html: () =>
      renderEmail({
        subject: `729104 is your ${brand} password reset code`,
        preheader: `Expires in 5 minutes. ${brand} will never ask you for this code.`,
        eyebrow: 'Password reset',
        heading: 'Reset your password',
        blocks: [
          blocks.paragraph(
            `Enter this code in the ${brand} app to set a new password. It expires in <b>5 minutes</b>.`
          ),
          blocks.codePanel('729104', { caption: 'Password reset code' }),
          blocks.notice({
            tone: 'warning',
            title: `${brand} will never ask you for this code`,
            body: `Not by phone, not by SMS, not in a support chat. <b>If you did not ask to reset your password</b>, someone may have your email address. Do not share this code, and contact ${brand} support.`,
          }),
        ],
        footnote: `Sent to the email address on your ${brand} account. Codes are single-use and stop working once entered.`,
      }),
  },
  {
    file: 'otp-pin-reset.html',
    label: 'OTP — transaction PIN reset',
    html: () =>
      renderEmail({
        subject: `550183 is your ${brand} PIN reset code`,
        preheader: `Expires in 5 minutes. ${brand} will never ask you for this code.`,
        eyebrow: 'Transaction PIN',
        heading: 'Reset your transaction PIN',
        blocks: [
          blocks.paragraph(
            `Enter this code in the ${brand} app to set a new transaction PIN. It expires in <b>5 minutes</b>.`
          ),
          blocks.codePanel('550183', { caption: 'PIN reset code' }),
          blocks.notice({
            tone: 'danger',
            title: `${brand} will never ask you for this code`,
            body: `Not by phone, not by SMS, not in a support chat. <b>If you did not ask to reset your PIN</b>, your account may be at risk. Do not share this code, and contact ${brand} support immediately.`,
          }),
        ],
        footnote: `Sent to the email address on your ${brand} account. Codes are single-use and stop working once entered.`,
      }),
  },
  {
    file: 'staffpay-approved.html',
    label: 'StaffPay — approved',
    html: () =>
      renderEmail({
        subject: 'StaffPay is now active for Bright Star Academy',
        preheader: 'Bulk salary payments, automated payroll and staff management are now unlocked.',
        eyebrow: 'StaffPay',
        heading: 'Your verification was approved',
        blocks: [
          blocks.paragraph(
            'Congratulations - the StaffPay verification for <b>Bright Star Academy</b> has been approved.'
          ),
          blocks.notice({
            tone: 'success',
            title: 'What is unlocked',
            body: 'Bulk salary payments &middot; Automated monthly payroll &middot; Staff management &middot; Payroll reports',
          }),
          blocks.paragraph(
            `Open the ${brand} app, activate your StaffPay subscription, then add your staff and set a payday between the <b>25th and the 29th</b> of the month.`
          ),
        ],
        footnote: `StaffPay is the payroll module inside the ${brand} app. This notice was sent to the business email on your application.`,
      }),
  },
  {
    file: 'staffpay-submitted.html',
    label: 'StaffPay — application received',
    html: () =>
      renderEmail({
        subject: 'We received your StaffPay verification application',
        preheader: 'Under review. A decision takes 5-7 working days.',
        eyebrow: 'StaffPay',
        heading: 'Application received',
        blocks: [
          blocks.paragraph('The StaffPay verification application for <b>Bright Star Academy</b> is in.'),
          blocks.detailList([
            ['Status', 'Under review'],
            ['Decision within', '5-7 working days'],
            ['You will hear from us', 'At this email address'],
          ]),
          blocks.paragraph(
            'Nothing is needed from you while we review. If a document is unclear we will write to you here before deciding.'
          ),
        ],
        footnote: `StaffPay is the payroll module inside the ${brand} app. This notice was sent to the business email on your application.`,
      }),
  },
  {
    file: 'staffpay-declined.html',
    label: 'StaffPay — declined',
    html: () =>
      renderEmail({
        subject: 'Your StaffPay verification was not approved',
        preheader: 'You can update your documents and re-apply from the app.',
        eyebrow: 'StaffPay',
        heading: 'We could not verify your business',
        blocks: [
          blocks.paragraph(
            'The StaffPay verification application for <b>Bright Star Academy</b> was not approved.'
          ),
          blocks.notice({
            tone: 'warning',
            title: 'Reason',
            body: 'The CAC certificate uploaded was expired. Please upload a current one.',
          }),
          blocks.paragraph(
            `This is not final. Update the documents named above in the StaffPay section of the ${brand} app and submit again - re-applications are reviewed the same way.`
          ),
        ],
        footnote: `StaffPay is the payroll module inside the ${brand} app. This notice was sent to the business email on your application.`,
      }),
  },
  {
    file: 'account-scheduled.html',
    label: 'Account — scheduled for deletion',
    html: () =>
      renderEmail({
        subject: `Your ${brand} account is scheduled for deletion`,
        preheader: 'Permanent deletion on 20 September 2026. Reactivate in the app to cancel.',
        eyebrow: 'Account',
        heading: 'Your account has been closed',
        blocks: [
          blocks.paragraph(
            `Your ${brand} account was closed today and is scheduled for permanent deletion on <b>20 September 2026</b>. You are signed out on every device until then.`
          ),
          blocks.detailList([
            ['Status', 'Closed'],
            ['Permanent deletion', '20 September 2026'],
            ['Can be cancelled', 'Yes, until that date'],
          ]),
          blocks.notice({
            tone: 'danger',
            title: 'If you did not ask for this',
            body: `Reactivate your account in the ${brand} app right away. Your password, the code we email you and your recovery phrase will cancel the deletion.`,
          }),
          blocks.paragraph(
            `After that date your name, contact details and profile photo are removed from ${brand}. Your transaction records are kept, because Nigerian law requires a licensed payment business to retain them.`
          ),
        ],
        footnote: `Did not request this? Contact ${brand} support immediately.`,
      }),
  },
  {
    file: 'account-deleted.html',
    label: 'Account — deleted',
    html: () =>
      renderEmail({
        subject: `Your ${brand} account has been deleted`,
        preheader: 'Your profile is erased. Transaction records are retained for 5 years, as the law requires.',
        eyebrow: 'Account',
        heading: 'Your account has been deleted',
        blocks: [
          blocks.paragraph(
            `Your ${brand} account has now been permanently deleted. Your profile, contact details, PIN, password and recovery phrase are gone, and this account can no longer be signed into or restored.`
          ),
          blocks.detailList([
            ['Profile and contact details', 'Erased'],
            ['PIN, password, recovery phrase', 'Erased'],
            ['Transaction and ID records', 'Retained 5 years'],
          ]),
          blocks.paragraph(
            'The Money Laundering (Prevention and Prohibition) Act 2022 and the CBN AML/CFT Regulations require every licensed payment business to keep those records for that period. They are stored encrypted and are only ever released to answer a regulator, a court or a dispute about a payment you made. After 5 years they are erased too.'
          ),
          blocks.paragraph('Nothing further is required from you. This is the last email you will receive from us.', {
            muted: true,
            small: true,
          }),
        ],
        footnote: `Questions about your data? Contact ${brand} support.`,
      }),
  },
  {
    file: 'recovery-phrase.html',
    label: 'Recovery phrase reset',
    html: () =>
      renderEmail({
        subject: `Your new ${brand} recovery phrase`,
        preheader: 'Write these 12 words down on paper, then delete this email.',
        eyebrow: 'Recovery phrase',
        heading: 'Your new recovery phrase',
        blocks: [
          blocks.paragraph(
            `Hi Ada, your ${brand} recovery phrase has been reset by our support team at your request. <b>Your old 12 words no longer work.</b> These are the ones to keep:`
          ),
          // Deliberately not a valid BIP-39 phrase - this file gets committed.
          blocks.wordGrid([
            'sample', 'preview', 'never', 'valid', 'example', 'placeholder',
            'demo', 'notreal', 'fake', 'testing', 'ignore', 'dummy',
          ]),
          blocks.paragraph(
            'Write them down in order, on paper, and keep them somewhere only you can reach. Do not save them in a screenshot, a notes app or a chat.'
          ),
          blocks.notice({
            tone: 'danger',
            title: 'These 12 words are your account',
            body: `Anyone who has them, your password and access to this inbox can sign in on a new device. <b>${brand} staff will never ask you for them</b> - not by phone, not by email, not in a support chat.`,
          }),
          blocks.paragraph('<b>Once you have written them down, delete this email.</b>'),
          blocks.notice({
            tone: 'warning',
            title: 'If you did not ask for this',
            body: `Your account may be at risk. Change your password in the app now and contact ${brand} support straight away.`,
          }),
        ],
        footnote: `Sent to the email address on your ${brand} account. This message contains a live secret - it is the only one ${brand} will ever send you that does.`,
      }),
  },
  {
    file: 'support-reply.html',
    label: 'Support — agent reply to user',
    html: () =>
      renderEmail({
        subject: '[VP-SUP-4821] Re: Airtime purchase not delivered',
        preheader: 'We have refunded the ₦1,000 to your wallet. It should show immediately.',
        eyebrow: 'Support',
        tag: 'VP-SUP-4821',
        heading: 'Re: Airtime purchase not delivered',
        blocks: [
          blocks.quote(
            'Thanks for your patience. We checked with the network and the recharge did not go through on their side.<br/><br/>We have refunded the ₦1,000 to your wallet - it should show immediately. Let us know if it does not.'
          ),
          blocks.paragraph(
            'Reply from the <b>Support</b> section of the VoltPay app to keep everything on ticket VP-SUP-4821. Replying to this email will not reach us.',
            { small: true }
          ),
        ],
        footnote: 'You are receiving this because you opened a support ticket with VoltPay.',
      }),
  },
  {
    file: 'support-admin-new-ticket.html',
    label: 'Support — new ticket to admin inbox',
    html: () =>
      renderEmail({
        subject: 'New ticket VP-SUP-4821',
        preheader: 'High priority - Airtime purchase not delivered',
        eyebrow: 'New support ticket',
        tag: 'VP-SUP-4821',
        heading: 'Airtime purchase not delivered',
        blocks: [
          blocks.detailList([
            ['Priority', 'High'],
            ['Name', 'Ada Obi'],
            ['Email', 'ada@example.com'],
            ['Phone', '2348030000000'],
            ['Attachments', '<a href="#" style="color:#2B5BEE;text-decoration:underline;">receipt.png</a>'],
          ]),
          blocks.quote(
            'I bought ₦1,000 MTN airtime at 11:04 this morning and it was deducted from my wallet but never arrived.'
          ),
        ],
        footnote: 'Reply from the admin dashboard so the response is recorded on ticket VP-SUP-4821.',
      }),
  },
  {
    file: 'kitchen-sink.html',
    label: 'All blocks (design reference)',
    html: () =>
      renderEmail({
        subject: 'Every block in the VoltPay email system',
        preheader: 'A design reference, not a real email.',
        eyebrow: 'Design reference',
        tag: 'REF-001',
        heading: 'Every block in the system',
        blocks: [
          blocks.paragraph('A standard body paragraph at 15px on a 24px line, in body slate.'),
          blocks.paragraph('A small, muted paragraph for legal or secondary copy.', { small: true, muted: true }),
          blocks.codePanel('142857', { caption: 'One-time code' }),
          blocks.button({ label: 'Primary action', url: 'https://example.com' }),
          blocks.detailList([
            ['Amount', '₦25,000.00'],
            ['Recipient', 'Bright Star Academy'],
            ['Reference', 'VP-TRX-99201'],
          ]),
          blocks.divider(),
          blocks.notice({ tone: 'info', title: 'Info', body: 'Neutral, informational.' }),
          blocks.notice({ tone: 'success', title: 'Success', body: 'Something completed.' }),
          blocks.notice({ tone: 'warning', title: 'Warning', body: 'Something needs attention.' }),
          blocks.notice({ tone: 'danger', title: 'Danger', body: 'Something is wrong or risky.' }),
          blocks.quote('A message written by a person, quoted back to the reader.'),
          blocks.wordGrid(['one', 'two', 'three', 'four', 'five', 'six']),
        ],
        footnote: 'Footnote copy sits below a hairline, in muted 12px.',
      }),
  },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  for (const sample of SAMPLES) {
    const html = sample.html();
    fs.writeFileSync(path.join(OUT_DIR, sample.file), html, 'utf8');
    written.push(sample);
  }

  const index = `<!doctype html>
<html><head><meta charset="utf-8"><title>VoltPay email previews</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F1F5F9;margin:0;padding:40px 20px;color:#0F172A}
  .wrap{max-width:640px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  p.sub{color:#64748B;font-size:14px;margin:0 0 28px}
  a.card{display:block;background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px 18px;margin-bottom:10px;text-decoration:none;color:#0F172A;font-size:15px}
  a.card:hover{border-color:#2B5BEE}
  code{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:2px 6px;font-size:13px}
</style></head>
<body><div class="wrap">
  <h1>VoltPay email previews</h1>
  <p class="sub">Logo source: <code>${logoUrl() || 'not configured — text wordmark fallback in use'}</code></p>
  ${written.map(s => `<a class="card" href="./${s.file}">${s.label}</a>`).join('\n  ')}
</div></body></html>`;

  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), index, 'utf8');

  console.log(`Wrote ${written.length} previews + index to ${OUT_DIR}`);
  console.log(`Logo: ${logoUrl() || 'not configured (text wordmark fallback)'}`);

  if (process.argv.includes('--open')) {
    const target = path.join(OUT_DIR, 'index.html');
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [target], () => {});
  }
}

main();
