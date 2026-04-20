const https = require('https');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');

// Initialize Resend client
let resendClient = null;
try {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    resendClient = new Resend(apiKey);
  }
} catch (_) {
  resendClient = null;
}

let smtpTransporter = null;
try {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const secure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true' || port === 465;

  if (host && user && pass) {
    smtpTransporter = nodemailer.createTransport({
      host: String(host),
      port,
      secure,
      auth: { user: String(user), pass: String(pass) },
    });
  }
} catch (_) {
  smtpTransporter = null;
}

async function sendResetEmail(toEmail, code, fromArg) {
  const from = fromArg || process.env.RESEND_FROM || process.env.SMTP_FROM || 'no-reply@voltpay.local';
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

  if (smtpTransporter) {
    try {
      const smtpFrom = process.env.SMTP_FROM || from;
      const info = await smtpTransporter.sendMail({
        from: smtpFrom,
        to: toEmail,
        subject,
        html,
        text,
      });
      return { queued: true, id: info && info.messageId ? info.messageId : undefined, provider: 'smtp' };
    } catch (smtpError) {
      console.error('❌ SMTP email error:', smtpError);
      if (!resendClient) {
        return { queued: false, error: smtpError, provider: 'smtp' };
      }
    }
  }

  if (!resendClient) {
    console.log(`✉️  [DEV MODE] Would send ${type} code to ${toEmail}: ${code}`);
    return { queued: true, dev: true };
  }

  const sendViaHttps = () => new Promise((resolve) => {
    try {
      const apiKey = process.env.RESEND_API_KEY;
      const payload = JSON.stringify({ from, to: toEmail, subject, html, text });

      const req = https.request({
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        family: 4,
        timeout: 8000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = body ? JSON.parse(body) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && json && json.id) {
              console.log('✅ Resend HTTPS fallback queued. id:', json.id);
              resolve({ queued: true, id: json.id });
            } else {
              console.error('❌ Resend HTTPS fallback error:', res.statusCode, json);
              resolve({ queued: false, error: json || { statusCode: res.statusCode } });
            }
          } catch (parseErr) {
            console.error('❌ Resend HTTPS fallback parse error:', parseErr, body);
            resolve({ queued: false, error: parseErr });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('request_timeout'));
      });
      req.on('error', (err) => {
        console.error('❌ Resend HTTPS fallback exception:', err);
        resolve({ queued: false, error: err });
      });
      req.write(payload);
      req.end();
    } catch (err) {
      console.error('❌ Resend HTTPS fallback setup error:', err);
      resolve({ queued: false, error: err });
    }
  });

  try {
    const result = await resendClient.emails.send({ from, to: toEmail, subject, html, text });
    if (result && result.error) {
      console.error('❌ Resend email error:', result.error);
      return await sendViaHttps();
    }
    const id = result && result.data ? result.data.id : undefined;
    console.log('✅ Resend email queued. id:', id);
    return { queued: true, id };
  } catch (e) {
    console.error('❌ Resend email exception:', e);
    const first = await sendViaHttps();
    if (first.queued) return first;
    await new Promise(r => setTimeout(r, 1200));
    return await sendViaHttps();
  }
}

async function sendSupportTicketEmail({ to, fromArg, replyTo, subject, html, text, attachments = [] }) {
  const from = fromArg || process.env.RESEND_FROM || process.env.SMTP_FROM || 'no-reply@voltpay.local';

  const normalizedAttachments = (attachments || []).map(f => ({
    filename: f.filename || 'attachment',
    // Omooooo The SDK accepts Buffer Godi; HTTPS fallback will re-map to base64.. omo this part is very important
    content: f.content
  }));

  if (smtpTransporter) {
    try {
      const smtpFrom = process.env.SMTP_FROM || from;
      const info = await smtpTransporter.sendMail({
        from: smtpFrom,
        to,
        subject,
        html,
        text,
        replyTo: replyTo || undefined,
        attachments: normalizedAttachments.map(a => ({
          filename: a.filename,
          content: a.content,
        })),
      });
      return { queued: true, id: info && info.messageId ? info.messageId : undefined, provider: 'smtp' };
    } catch (smtpError) {
      console.error('❌ SMTP support email error:', smtpError);
      if (!resendClient) {
        return { queued: false, error: smtpError, provider: 'smtp' };
      }
    }
  }

  if (!resendClient) {
    console.log(`✉️  [DEV MODE] Would send support ticket to ${to} with subject: ${subject}`);
    return { queued: false, dev: true };
  }

  const sendViaHttps = () => new Promise((resolve) => {
    try {
      const apiKey = process.env.RESEND_API_KEY;
      const payload = JSON.stringify({
        from,
        to,
        subject,
        html,
        text,
        reply_to: replyTo,
        attachments: normalizedAttachments.map(a => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content) }))
      });

      const req = https.request({
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        family: 4,
        timeout: 8000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = body ? JSON.parse(body) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && json && json.id) {
              console.log('✅ Resend HTTPS support email queued. id:', json.id);
              resolve({ queued: true, id: json.id });
            } else {
              console.error('❌ Resend HTTPS support email error:', res.statusCode, json);
              resolve({ queued: false, error: json || { statusCode: res.statusCode } });
            }
          } catch (parseErr) {
            console.error('❌ Resend HTTPS support email parse error:', parseErr, body);
            resolve({ queued: false, error: parseErr });
          }
        });
      });

      req.on('timeout', () => { req.destroy(new Error('request_timeout')); });
      req.on('error', (err) => { console.error('❌ Resend HTTPS support email exception:', err); resolve({ queued: false, error: err }); });
      req.write(payload);
      req.end();
    } catch (err) {
      console.error('❌ Resend HTTPS support email setup error:', err);
      resolve({ queued: false, error: err });
    }
  });

  try {
    const result = await resendClient.emails.send({
      from,
      to,
      subject,
      html,
      text,
      reply_to: replyTo,
      attachments: normalizedAttachments
    });
    if (result && result.error) {
      console.error('❌ Resend support email error:', result.error);
      return await sendViaHttps();
    }
    const id = result && result.data ? result.data.id : undefined;
    console.log('✅ Resend support email queued. id:', id);
    return { queued: true, id };
  } catch (e) {
    console.error('❌ Resend support email exception:', e);
    const first = await sendViaHttps();
    if (first.queued) return first;
    await new Promise(r => setTimeout(r, 1200));
    return await sendViaHttps();
  }
}

module.exports = { sendResetEmail, sendSupportTicketEmail };
