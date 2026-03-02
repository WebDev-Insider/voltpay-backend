const https = require('https');
const { Resend } = require('resend');

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

async function sendResetEmail(toEmail, code, fromArg) {
  const from = fromArg || process.env.RESEND_FROM || process.env.SMTP_FROM || 'no-reply@voltpay.local';
  const subject = 'Your VoltPay PIN Reset Code';
  const text = `Use this code to reset your PIN: ${code}. This code will expire in 10 minutes.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6">
      <h2>VoltPay PIN Reset</h2>
      <p>Use the code below to reset your PIN. It expires in <b>10 minutes</b>.</p>
      <div style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</div>
      <p>If you did not initiate this request, you can safely ignore this email.</p>
    </div>
  `;

  if (!resendClient) {
    console.log(`✉️  [DEV MODE] Would send PIN reset code to ${toEmail}: ${code}`);
    return { queued: false, dev: true };
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
    // The SDK accepts Buffer; HTTPS fallback will re-map to base64
    content: f.content
  }));

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
