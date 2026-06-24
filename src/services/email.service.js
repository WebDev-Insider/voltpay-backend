const https = require('https');

const BREVO_API_HOST = 'api.brevo.com';
const BREVO_API_PATH = '/v3/smtp/email';

function getBrevoApiKey() {
  return process.env.BREVO_API_KEY || null;
}

function parseSender(fromArg) {
  // Brevo expects sender as { email, name? }. fromArg may be:
  // - a plain email string: "no-reply@voltpay.local"
  // - a "Name <email>" string
  // - already an object: { email, name }
  const raw = fromArg || process.env.BREVO_FROM || process.env.EMAIL_FROM || 'no-reply@voltpay.local';

  if (raw && typeof raw === 'object' && raw.email) {
    return { email: raw.email, name: raw.name || process.env.EMAIL_BRAND_NAME || undefined };
  }

  const str = String(raw).trim();
  const match = str.match(/^(.*)<(.+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, '');
    const email = match[2].trim();
    return { email, name: name || undefined };
  }
  return { email: str, name: process.env.EMAIL_BRAND_NAME || undefined };
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
        console.log(`✉️  [DEV MODE] BREVO_API_KEY not set. Would send "${subject}" to ${JSON.stringify(to)}`);
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

      if (replyTo) {
        const rt = parseSender(replyTo);
        body.replyTo = rt;
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

async function sendResetEmail(toEmail, code, fromArg) {
  const metaArg = arguments.length >= 4 ? arguments[3] : null;
  const meta = typeof metaArg === 'string' ? { type: metaArg } : (metaArg || {});

  const type = String(meta.type || 'pin_reset').trim().toLowerCase();
  const isPasswordReset = type === 'password_reset' || type === 'password';
  const isEmailVerification = type === 'email_verification' || type === 'verify_email' || type === 'verification';

  const subject = isEmailVerification
    ? 'Your VoltPay Verification Code'
    : (isPasswordReset ? 'Your VoltPay Password Reset Code' : 'Your VoltPay PIN Reset Code');

  const headerTitle = isEmailVerification
    ? 'VoltPay Verification'
    : (isPasswordReset ? 'VoltPay Password Reset' : 'VoltPay PIN Reset');

  const actionText = isEmailVerification
    ? 'verify your email'
    : (isPasswordReset ? 'reset your password' : 'reset your PIN');

  const text = `Use this code to ${actionText}: ${code}. This code will expire in 5 minutes.`;
  const brandName = process.env.EMAIL_BRAND_NAME || 'VoltPay';
  const brandColor = process.env.EMAIL_BRAND_COLOR || '#000000';
  const previewText = `Your verification code is ${code}. Expires in 5 minutes.`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F6F7FB;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${previewText}
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#F6F7FB;">
      <tr>
        <td align="center" style="padding:32px 12px;">

          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;">
            <tr>
              <td align="center" style="padding:8px 0 18px 0;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.3px;color:${brandColor};">
                  ${brandName}
                </div>
              </td>
            </tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;border:1px solid #E2E8F0;">
            <tr>
              <td style="padding:26px 24px 8px 24px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#0F172A;">
                  ${headerTitle}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#475569;">
                  Use the code below to ${actionText}. It expires in <b>5 minutes</b>.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 8px 24px;">
                <div style="border-radius:14px;border:1px solid #E2E8F0;background:#F8FAFC;padding:18px 16px;text-align:center;">
                  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",\"Courier New\",monospace;font-size:34px;letter-spacing:10px;font-weight:700;color:#0F172A;">
                    ${String(code).trim()}
                  </div>
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:10px 24px 18px 24px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748B;">
                  If you did not initiate this request, you can safely ignore this email.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 22px 24px;">
                <div style="height:1px;background:#E2E8F0;"></div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 24px 24px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94A3B8;">
                  Need help? Contact support.
                </div>
              </td>
            </tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;">
            <tr>
              <td align="center" style="padding:18px 8px 0 8px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#94A3B8;">
                  © ${new Date().getFullYear()} ${brandName}. All rights reserved.
                </div>
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
</html>`;

  return await sendViaBrevo({ from: fromArg, to: toEmail, subject, html, text });
}

async function sendSupportTicketEmail({ to, fromArg, replyTo, subject, html, text, attachments = [] }) {
  return await sendViaBrevo({ from: fromArg, to, subject, html, text, replyTo, attachments });
}

module.exports = { sendResetEmail, sendSupportTicketEmail };