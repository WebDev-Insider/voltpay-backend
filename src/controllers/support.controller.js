const { sendSupportTicketEmail } = require('../services/email.service');

function sanitize(str) {
  return String(str || '').trim();
}

async function createTicket(req, res) {
  try {
    const name = sanitize(req.body.name);
    const email = sanitize(req.body.email);
    const phone = sanitize(req.body.phone);
    const subject = sanitize(req.body.subject);
    const priority = sanitize(req.body.priority);
    const message = sanitize(req.body.message);

    if (!subject || !message) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Subject and message are required'],
        data: null
      });
    }

    const toEmail = process.env.SUPPORT_EMAIL_TO || 'henrydustin95@gmail.com';

    // Build email body
    const title = 'New Support Ticket';
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>${title}</h2>
        <p><b>Subject:</b> ${subject}</p>
        <p><b>Priority:</b> ${priority || 'N/A'}</p>
        <p><b>Name:</b> ${name || 'N/A'}</p>
        <p><b>Email:</b> ${email || 'N/A'}</p>
        <p><b>Phone:</b> ${phone || 'N/A'}</p>
        <h3>Message</h3>
        <p>${message.replace(/\n/g, '<br/>')}</p>
      </div>
    `;
    const text = `${title}\nSubject: ${subject}\nPriority: ${priority}\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\n\nMessage:\n${message}`;

    // attachments via multer.any()
    const attachments = (req.files || []).map((f, idx) => ({
      filename: f.originalname || `attachment_${idx + 1}`,
      content: f.buffer
    }));

    const emailResult = await sendSupportTicketEmail({
      to: toEmail,
      fromArg: process.env.RESEND_FROM || 'no-reply@voltpay.local',
      replyTo: email || undefined,
      subject: `[Support] ${subject}`,
      html,
      text,
      attachments
    });

    return res.json({
      remark: 'ticket_created',
      status: 'success',
      message: ['Your complaint has been submitted. We will reach out to you via email.'],
      data: { emailed: !!(emailResult && emailResult.queued) }
    });
  } catch (error) {
    console.error('Error creating support ticket:', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to submit your complaint. Please try again later.'],
      data: null
    });
  }
}

module.exports = { createTicket };
