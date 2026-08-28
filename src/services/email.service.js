const https = require('https');
const { renderEmail, toPlainText, esc, brandName, blocks } = require('./emailTemplate.service');

const BREVO_API_HOST = 'api.brevo.com';
const BREVO_API_PATH = '/v3/smtp/email';

function getBrevoApiKey() {
  return process.env.BREVO_API_KEY || null;
}

const FALLBACK_SENDER = 'no-reply@voltpay.local';
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

// Render stores a dashboard value byte for byte; dotenv strips the surrounding
// quotes off a .env line. So a value copied out of .env into Render arrives as
// `"VoltPay <x@y.com>"` - quotes included - and anything that anchors on a
// trailing `>` stops matching. That mismatch is what Brevo reports as
// `400 invalid_parameter: valid sender email required`, and it did. Shared with
// upload.helper, which lost every support attachment to the same stray quote.
const { unquote } = require('../helpers/env.helper');

/**
 * One configured value -> { email, name } or null when it carries no usable
 * address. Returning null rather than a best guess is the point: a malformed
 * sender is rejected by Brevo with the whole message attached, so guessing
 * turns a config typo into a silently undelivered OTP.
 *
 * Accepts a plain address, a "Name <address>" string, or { email, name }.
 */
function readSender(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    const email = unquote(value.email || '');
    return EMAIL_RE.test(email) ? { email, name: value.name || undefined } : null;
  }

  const str = unquote(value);
  if (!str) return null;

  // Match the last <...> and tolerate trailing junk after it, so a stray quote
  // or a name containing an angle bracket cannot capture the address.
  const angled = str.match(/<([^<>]+)>[^<>]*$/);
  if (angled) {
    const email = angled[1].trim();
    if (!EMAIL_RE.test(email)) return null;
    const name = unquote(str.slice(0, angled.index));
    return { email, name: name || undefined };
  }

  return EMAIL_RE.test(str) ? { email: str, name: undefined } : null;
}

let warnedNoSender = false;

/**
 * Resolves the From address, first usable candidate wins.
 *
 * RESEND_FROM is a leftover from the provider before this one and sits last on
 * purpose: it used to be read at every call site and passed in as `fromArg`,
 * which put a dead provider's variable ahead of BREVO_FROM. A stale value there
 * silently overrode the correct one.
 */
function parseSender(fromArg) {
  const candidates = [
    [fromArg, 'the from argument'],
    [process.env.BREVO_FROM, 'BREVO_FROM'],
    [process.env.EMAIL_FROM, 'EMAIL_FROM'],
    [process.env.RESEND_FROM, 'RESEND_FROM'],
  ];

  const rejected = [];
  for (const [value, source] of candidates) {
    if (!value) continue;
    const sender = readSender(value);
    if (sender) {
      return { email: sender.email, name: sender.name || process.env.EMAIL_BRAND_NAME || undefined };
    }
    rejected.push(source);
  }

  // The variable name, never its value - the log is the one place a misconfigured
  // address would otherwise get written down.
  if (rejected.length) {
    console.error(
      `❌ Email sender misconfigured: ${rejected.join(', ')} carries no valid address. ` +
        'Set BREVO_FROM to `Name <address@domain>` with NO surrounding quotes.'
    );
  } else if (!warnedNoSender) {
    warnedNoSender = true;
    console.warn(
      `⚠️  No sender configured (BREVO_FROM / EMAIL_FROM unset). Using ${FALLBACK_SENDER}, which is not a deliverable address.`
    );
  }
  return { email: FALLBACK_SENDER, name: process.env.EMAIL_BRAND_NAME || undefined };
}

function parseRecipients(to) {
  // Accepts a single email string, comma-separated string, or array of strings/objects
  if (Array.isArray(to)) {
    return to.map(t => (typeof t === 'string' ? { email: t.trim() } : { email: t.email, name: t.name }));
  }
  if (typeof to === 'string') {
    return to.split(',').map(t => ({ email: t.trim() })).filter(t => t.email);
  }
  if (to && typeof to === 'object' && to.email) {
    return [{ email: to.email, name: to.name }];
  }
  return [];
}

/**
 * Sends an email via Brevo's transactional email HTTPS API.
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 */
function sendViaBrevo({ from, to, subject, html, text, replyTo, attachments = [] }) {
  return new Promise((resolve) => {
    try {
      const apiKey = getBrevoApiKey();
      if (!apiKey) {
        console.log(`✉️  [DEV MODE] BREVO_API_KEY not set. Would send "${subject}"`);
        resolve({ queued: true, dev: true });
        return;
      }

      const sender = parseSender(from);
      const recipients = parseRecipients(to);

      const body = {
        sender,
        to: recipients,
        subject,
        htmlContent: html,
      };

      if (text) body.textContent = text;

      // readSender, not parseSender: a reply-to is typed by the person who
      // opened the support ticket, so a malformed one must drop the field, not
      // fall back to our own From address and not reach Brevo as junk - one bad
      // address in the form would otherwise 400 the entire ticket email.
      if (replyTo) {
        const rt = readSender(replyTo);
        if (rt) body.replyTo = rt;
      }

      if (attachments && attachments.length > 0) {
        body.attachment = attachments.map(a => ({
          name: a.filename || 'attachment',
          content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content),
        }));
      }

      const payload = JSON.stringify(body);

      const req = https.request({
        hostname: BREVO_API_HOST,
        port: 443,
        path: BREVO_API_PATH,
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        family: 4,
        timeout: 8000,
      }, (res) => {
        let resBody = '';
        res.on('data', (chunk) => resBody += chunk);
        res.on('end', () => {
          try {
            const json = resBody ? JSON.parse(resBody) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              console.log('✅ Brevo email queued. messageId:', json.messageId);
              resolve({ queued: true, id: json.messageId, provider: 'brevo' });
            } else {
              console.error('❌ Brevo API error:', res.statusCode, json);
              resolve({ queued: false, error: json || { statusCode: res.statusCode }, provider: 'brevo' });
            }
          } catch (parseErr) {
            console.error('❌ Brevo API parse error:', parseErr, resBody);
            resolve({ queued: false, error: parseErr, provider: 'brevo' });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('request_timeout'));
      });
      req.on('error', (err) => {
        console.error('❌ Brevo API request exception:', err);
        resolve({ queued: false, error: err, provider: 'brevo' });
      });
      req.write(payload);
      req.end();
    } catch (err) {
      console.error('❌ Brevo API setup error:', err);
      resolve({ queued: false, error: err, provider: 'brevo' });
    }
  });
}

/**
 * The one-time code email - signup verification, password reset, PIN reset.
 *
 * This is the most-sent and most-phished email in the product, so the copy does
 * three jobs beyond carrying the digits: it names the action the code performs
 * (a code with no context is what makes an OTP relay attack work), it states
 * that VoltPay will never ask for the code, and it tells the reader what to do
 * if they did not request it. There is deliberately no link and no button -
 * nothing to click means nothing to spoof.
 */
async function sendResetEmail(toEmail, code, fromArg) {
  const metaArg = arguments.length >= 4 ? arguments[3] : null;
  const meta = typeof metaArg === 'string' ? { type: metaArg } : (metaArg || {});

  const type = String(meta.type || 'pin_reset').trim().toLowerCase();
  const isPasswordReset = type === 'password_reset' || type === 'password';
  const isEmailVerification = type === 'email_verification' || type === 'verify_email' || type === 'verification';

  const brand = brandName();
  const digits = String(code).trim();

  const variant = isEmailVerification
    ? {
        subject: `${digits} is your ${brand} verification code`,
        eyebrow: 'Verify your email',
        heading: 'Confirm your email address',
        lead: `Enter this code in the ${brand} app to finish setting up your account.`,
        caption: 'Verification code',
        unexpected: `If you did not create a ${brand} account, ignore this email - the address will not be used.`,
        tone: 'info',
      }
    : isPasswordReset
      ? {
          subject: `${digits} is your ${brand} password reset code`,
          eyebrow: 'Password reset',
          heading: 'Reset your password',
          lead: `Enter this code in the ${brand} app to set a new password.`,
          caption: 'Password reset code',
          unexpected: `<b>If you did not ask to reset your password</b>, someone may have your email address. Do not share this code, and contact ${brand} support.`,
          tone: 'warning',
        }
      : {
          subject: `${digits} is your ${brand} PIN reset code`,
          eyebrow: 'Transaction PIN',
          heading: 'Reset your transaction PIN',
          lead: `Enter this code in the ${brand} app to set a new transaction PIN.`,
          caption: 'PIN reset code',
          unexpected: `<b>If you did not ask to reset your PIN</b>, your account may be at risk. Do not share this code, and contact ${brand} support immediately.`,
          tone: 'danger',
        };

  // The subject already carries the code so a phone can show it on the lock
  // screen without the mail being opened; the preheader carries the expiry,
  // which is the other thing worth knowing from the inbox list.
  const preheader = `Expires in 5 minutes. ${brand} will never ask you for this code.`;

  const html = renderEmail({
    subject: variant.subject,
    preheader,
    eyebrow: variant.eyebrow,
    heading: variant.heading,
    blocks: [
      blocks.paragraph(`${variant.lead} It expires in <b>5 minutes</b>.`),
      blocks.codePanel(digits, { caption: variant.caption }),
      blocks.notice({
        tone: variant.tone,
        title: `${brand} will never ask you for this code`,
        body: `Not by phone, not by SMS, not in a support chat. Anyone who does is trying to take your account. ${variant.unexpected}`,
      }),
    ],
    footnote: `Sent to the email address on your ${brand} account. Codes are single-use and stop working once entered.`,
  });

  const text = toPlainText([
    variant.lead,
    `Code: ${digits}`,
    'It expires in 5 minutes and can only be used once.',
    `${brand} will never ask you for this code - not by phone, not by SMS, not in a support chat.`,
    variant.unexpected,
  ]);

  return await sendViaBrevo({ from: fromArg, to: toEmail, subject: variant.subject, html, text });
}

async function sendSupportTicketEmail({ to, fromArg, replyTo, subject, html, text, attachments = [] }) {
  return await sendViaBrevo({ from: fromArg, to, subject, html, text, replyTo, attachments });
}

/**
 * The plain announcement layout: logo, card, heading, paragraphs, footer.
 *
 * Kept as a thin wrapper over `renderEmail()` so the callers that already speak
 * in `paragraphs` keep working unchanged. `paragraphs` is trusted HTML - the
 * existing callers pass `<b>` for emphasis - so anything user-supplied has to
 * be escaped before it is handed in. Pass `extraBlocks` to mix in a code panel,
 * a detail list or a button without dropping to raw markup.
 */
function renderEmailHtml({ subject, heading, paragraphs = [], footnote, preheader, eyebrow, extraBlocks = [] }) {
  return renderEmail({
    subject,
    // The preview line is escaped by the shell, so a paragraph used as the
    // fallback has to have its tags stripped or the inbox shows "<b>".
    preheader: preheader || toPlainText([paragraphs[0]]),
    eyebrow,
    heading,
    blocks: [...paragraphs.map(p => blocks.paragraph(p)), ...extraBlocks],
    footnote,
  });
}

/**
 * The three StaffPay KYB emails, keyed by status:
 *   submitted -> "we have your application"
 *   approved  -> "you can now use StaffPay"
 *   declined  -> "here is why, and how to re-apply"
 *
 * Goes to the support email the business gave on the form, not to the account
 * email - that is the address the spec tells them to watch.
 */
async function sendStaffPayVerificationEmail({ to, status, companyName, reason, fromArg }) {
  // The company name is typed by the business and the reason by an admin, so
  // both are escaped: neither is ours to trust with raw HTML.
  const name = esc(String(companyName || 'your business').trim());
  const state = String(status || '').toLowerCase();
  const brand = brandName();

  let subject;
  let eyebrow;
  let heading;
  let preheader;
  let body;
  let plain;

  if (state === 'approved') {
    subject = `StaffPay is now active for ${String(companyName || 'your business').trim()}`;
    eyebrow = 'StaffPay';
    heading = 'Your verification was approved';
    preheader = 'Bulk salary payments, automated payroll and staff management are now unlocked.';
    body = [
      blocks.paragraph(`Congratulations - the StaffPay verification for <b>${name}</b> has been approved.`),
      blocks.notice({
        tone: 'success',
        title: 'What is unlocked',
        body: 'Bulk salary payments &middot; Automated monthly payroll &middot; Staff management &middot; Payroll reports',
      }),
      blocks.paragraph(
        `Open the ${brand} app, activate your StaffPay subscription, then add your staff and set a payday between the <b>25th and the 29th</b> of the month.`
      ),
    ];
    plain = [
      `The StaffPay verification for ${companyName || 'your business'} has been approved.`,
      'Unlocked: bulk salary payments, automated monthly payroll, staff management and payroll reports.',
      `Open the ${brand} app, activate your StaffPay subscription, then add your staff and set a payday between the 25th and the 29th of the month.`,
    ];
  } else if (state === 'declined') {
    subject = 'Your StaffPay verification was not approved';
    eyebrow = 'StaffPay';
    heading = 'We could not verify your business';
    preheader = 'You can update your documents and re-apply from the app.';
    body = [
      blocks.paragraph(`The StaffPay verification application for <b>${name}</b> was not approved.`),
      blocks.notice({
        tone: 'warning',
        title: 'Reason',
        body: esc(String(reason || 'The documents provided could not be verified.')),
      }),
      blocks.paragraph(
        `This is not final. Update the documents named above in the StaffPay section of the ${brand} app and submit again - re-applications are reviewed the same way.`
      ),
    ];
    plain = [
      `The StaffPay verification application for ${companyName || 'your business'} was not approved.`,
      `Reason: ${String(reason || 'The documents provided could not be verified.')}`,
      `Update the documents in the StaffPay section of the ${brand} app and submit again.`,
    ];
  } else {
    subject = 'We received your StaffPay verification application';
    eyebrow = 'StaffPay';
    heading = 'Application received';
    preheader = 'Under review. A decision takes 5-7 working days.';
    body = [
      blocks.paragraph(`The StaffPay verification application for <b>${name}</b> is in.`),
      blocks.detailList([
        ['Status', 'Under review'],
        ['Decision within', '5-7 working days'],
        ['You will hear from us', 'At this email address'],
      ]),
      blocks.paragraph(
        'Nothing is needed from you while we review. If a document is unclear we will write to you here before deciding.'
      ),
    ];
    plain = [
      `The StaffPay verification application for ${companyName || 'your business'} has been received.`,
      'Status: under review. A decision takes 5-7 working days and will be sent to this email address.',
      'Nothing is needed from you while we review.',
    ];
  }

  const html = renderEmail({
    subject,
    preheader,
    eyebrow,
    heading,
    blocks: body,
    footnote: `StaffPay is the payroll module inside the ${brand} app. This notice was sent to the business email on your application.`,
  });

  return await sendViaBrevo({ from: fromArg, to, subject, html, text: toPlainText(plain) });
}

/**
 * The two account-closure notices.
 *
 * Sent to the address on file, never to whoever typed the request: a session
 * that has been taken over must not be able to close an account silently, and
 * the notice is the only thing that tells the real owner there is a window in
 * which to cancel. It is also how the NDPA duty to inform a data subject of the
 * action taken on their erasure request is discharged - an in-app message they
 * see once, on the screen that signs them out, is not that.
 *
 *   scheduled - closed today, erased on this date, cancel by reactivating.
 *   completed - erased, and what is kept afterwards and for how long.
 */
async function sendAccountClosureEmail({ to, kind, scheduledFor, graceDays, retentionYears, fromArg }) {
  const brand = brandName();
  const years = Number(retentionYears) || 5;
  const scheduled = String(kind || '').toLowerCase() !== 'completed';

  const subject = scheduled
    ? `Your ${brand} account is scheduled for deletion`
    : `Your ${brand} account has been deleted`;

  const dueDate = scheduledFor
    ? new Date(scheduledFor).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' })
    : null;

  const html = scheduled
    ? renderEmail({
        subject,
        preheader: dueDate
          ? `Permanent deletion on ${dueDate}. Reactivate in the app to cancel.`
          : `Permanent deletion in ${graceDays || 30} days. Reactivate in the app to cancel.`,
        eyebrow: 'Account',
        heading: 'Your account has been closed',
        blocks: [
          blocks.paragraph(
            `Your ${brand} account was closed today and is scheduled for permanent deletion${dueDate ? ` on <b>${dueDate}</b>` : ` in <b>${graceDays || 30} days</b>`}. You are signed out on every device until then.`
          ),
          blocks.detailList([
            ['Status', 'Closed'],
            ['Permanent deletion', dueDate || `In ${graceDays || 30} days`],
            ['Can be cancelled', 'Yes, until that date'],
          ]),
          // The whole point of this email is that a stolen session cannot close
          // an account quietly. That line gets the loudest block on the page.
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
      })
    : renderEmail({
        subject,
        preheader: `Your profile is erased. Transaction records are retained for ${years} years, as the law requires.`,
        eyebrow: 'Account',
        heading: 'Your account has been deleted',
        blocks: [
          blocks.paragraph(
            `Your ${brand} account has now been permanently deleted. Your profile, contact details, PIN, password and recovery phrase are gone, and this account can no longer be signed into or restored.`
          ),
          blocks.detailList([
            ['Profile and contact details', 'Erased'],
            ['PIN, password, recovery phrase', 'Erased'],
            ['Transaction and ID records', `Retained ${years} years`],
          ]),
          blocks.paragraph(
            `The Money Laundering (Prevention and Prohibition) Act 2022 and the CBN AML/CFT Regulations require every licensed payment business to keep those records for that period. They are stored encrypted and are only ever released to answer a regulator, a court or a dispute about a payment you made. After ${years} years they are erased too.`
          ),
          blocks.paragraph(
            'Nothing further is required from you. This is the last email you will receive from us.',
            { muted: true, small: true }
          ),
        ],
        footnote: `Questions about your data? Contact ${brand} support.`,
      });

  const text = toPlainText(
    scheduled
      ? [
          `Your ${brand} account was closed today and is scheduled for permanent deletion${dueDate ? ` on ${dueDate}` : ` in ${graceDays || 30} days`}. You are signed out on every device until then.`,
          `If you did not ask for this, reactivate your account in the ${brand} app right away - your password, the code we email you and your recovery phrase will cancel the deletion.`,
          `After that date your name, contact details and profile photo are removed from ${brand}. Your transaction records are kept, because Nigerian law requires a licensed payment business to retain them.`,
        ]
      : [
          `Your ${brand} account has now been permanently deleted. Your profile, contact details, PIN, password and recovery phrase are gone, and this account can no longer be signed into or restored.`,
          `Your transaction history and the identification details collected when you signed up are retained for ${years} years from today and then erased. The Money Laundering (Prevention and Prohibition) Act 2022 and the CBN AML/CFT Regulations require every licensed payment business to keep them for that period; they are stored encrypted and are only ever released to answer a regulator, a court or a dispute about a payment you made.`,
          'Nothing further is required from you. This is the last email you will receive from us.',
        ]
  );

  return await sendViaBrevo({ from: fromArg, to, subject, html, text });
}

/**
 * The replacement recovery phrase, after a support reset.
 *
 * This is the only email in the system that carries a live secret, so it is
 * written to be acted on and then destroyed: the words are in the body - there
 * is no link to click and therefore nothing to phish - the copy says to write
 * them down and delete the message, and it says plainly what to do if the
 * reader did not ask for this.
 *
 * It only ever goes to the address already on the account. See
 * adminRecovery.controller.js for why that is not negotiable.
 */
async function sendRecoveryPhraseEmail({ to, phrase, firstName, fromArg }) {
  const brand = brandName();
  const words = String(phrase || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const rawName = String(firstName || '').trim();
  const name = esc(rawName);
  const subject = `Your new ${brand} recovery phrase`;

  const html = renderEmail({
    subject,
    preheader: 'Write these 12 words down on paper, then delete this email.',
    eyebrow: 'Recovery phrase',
    heading: 'Your new recovery phrase',
    blocks: [
      blocks.paragraph(
        `${name ? `Hi ${name},` : 'Hi,'} your ${brand} recovery phrase has been reset by our support team at your request. <b>Your old 12 words no longer work.</b> These are the ones to keep:`
      ),
      blocks.wordGrid(words),
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
  });

  const text = toPlainText([
    `${rawName ? `Hi ${rawName},` : 'Hi,'} your ${brand} recovery phrase has been reset at your request. Your old 12 words no longer work. These are the ones to keep:`,
    words.map((word, i) => `${i + 1}. ${word}`).join('\n'),
    'Write them down in order, on paper, and keep them somewhere only you can reach.',
    `Anyone who has these words, your password and access to this inbox can sign in to your account on a new device. ${brand} staff will never ask you for them.`,
    'Once you have written them down, delete this email.',
    `If you did not ask for this, change your password in the app now and contact ${brand} support straight away.`,
  ]);

  return await sendViaBrevo({ from: fromArg, to, subject, html, text });
}

module.exports = {
  // Exported for test/emailTemplate.test.js. The shapes an env var can arrive
  // in are what broke this, so they get asserted rather than assumed.
  parseSender,
  readSender,
  sendResetEmail,
  sendSupportTicketEmail,
  sendStaffPayVerificationEmail,
  sendAccountClosureEmail,
  sendRecoveryPhraseEmail,
  renderEmailHtml,
  // Re-exported so a controller that builds its own email body does not have to
  // reach past this module for the shell. There is one design system; nothing
  // should be writing `<table>` by hand.
  renderEmail,
  toPlainText,
  blocks,
};