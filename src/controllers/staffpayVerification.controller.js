/**
 * StaffPay business verification (KYB).
 *
 * A company must clear this before it can add staff, fund its StaffPay wallet
 * or run payroll - the gate itself lives in helpers/staffpayAccess.helper.js so
 * the payroll routes can reuse it.
 *
 * Storage rules, same as everywhere else in the codebase:
 *   - contact PII (trading name, support email, phone, office address) is
 *     AES-GCM ciphertext with a blind index where we need lookup
 *   - document URLs go through protectText(). An UploadThing URL is effectively
 *     a bearer token: whoever reads the column can pull the NIN slip. Storing
 *     it plain would make a read-only DB leak a KYC document leak.
 *   - nothing here is ever logged beyond ids and status
 */
const prisma = require('../../database/prisma');
const { uploadFile } = require('../helpers/upload.helper');
const { protect, reveal, protectText, revealText } = require('../helpers/pii.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { getAccessState } = require('../helpers/staffpayAccess.helper');
const { logStaffPayEvent } = require('../services/staffpayAudit.service');
const { notifyUser } = require('../services/notify.service');
const { sendStaffPayVerificationEmail } = require('../services/email.service');

const GOV_ID_TYPES = new Set(['national_id', 'nin_slip', 'voters_card']);

// fieldname -> { column, required }. Anything else the app sends is ignored.
const DOCUMENT_FIELDS = {
  gov_id: { column: 'gov_id_url_enc', required: true },
  cac_certificate: { column: 'cac_certificate_url_enc', required: true },
  cac_status_report: { column: 'cac_status_report_url_enc', required: true },
  proof_of_address: { column: 'proof_of_address_url_enc', required: true },
};

function fail(res, status, message, remark = 'validation_error') {
  return res.status(status).json({ remark, status: 'error', message: [message], data: null });
}

async function ownedCompany(userId, companyId) {
  const id = Number(companyId);
  if (!id) return null;
  return prisma.staffPayCompany.findFirst({ where: { id, owner_user_id: Number(userId) } });
}

function requireModel(res) {
  if (prisma.staffPayVerification) return true;
  res.status(500).json({
    remark: 'server_error',
    status: 'error',
    message: ['Missing Prisma model StaffPayVerification. Run prisma generate + db push and restart.'],
    data: null,
  });
  return false;
}

/**
 * Decrypted view of an application. `forAdmin` also returns the document URLs -
 * the owner already has their own files and does not need the raw links echoed
 * back, so the default response leaves them out.
 */
function publicVerification(row, { forAdmin = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    company_id: row.company_id,
    trading_name: reveal(row.trading_name_enc),
    description: row.description,
    support_email: reveal(row.support_email_enc),
    support_phone: reveal(row.support_phone_enc),
    office_address: row.office_address_enc ? reveal(row.office_address_enc) : '',
    website_url: row.website_url || '',
    industry: row.industry,
    business_category: row.business_category,
    staff_size: row.staff_size,
    gov_id_type: row.gov_id_type,
    status: row.status,
    decline_reason: row.decline_reason || null,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
  };

  if (!forAdmin) return out;

  return {
    ...out,
    admin_notes: row.admin_notes || null,
    reviewed_by: row.reviewed_by || null,
    documents: {
      gov_id: revealText(row.gov_id_url_enc || ''),
      cac_certificate: revealText(row.cac_certificate_url_enc || ''),
      cac_status_report: revealText(row.cac_status_report_url_enc || ''),
      proof_of_address: revealText(row.proof_of_address_url_enc || ''),
    },
  };
}

/**
 * POST /staffpay/companies/:companyId/verification
 * multipart/form-data - text fields plus the document files.
 *
 * Re-application is an update of the same row, so a company never accumulates
 * competing applications. Only a declined (or never finished) application may
 * be replaced: pending is already in the queue and approved is done.
 */
async function submitVerification(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const existing = await prisma.staffPayVerification.findUnique({ where: { company_id: company.id } });
    if (existing && existing.status === 'pending') {
      return fail(res, 400, 'An application for this business is already under review', 'already_submitted');
    }
    if (existing && existing.status === 'approved') {
      return fail(res, 400, 'This business is already verified', 'already_verified');
    }

    const body = req.body || {};
    const tradingName = String(body.trading_name || '').trim();
    const description = String(body.description || '').trim();
    const supportEmail = String(body.support_email || '').trim().toLowerCase();
    const officeAddress = String(body.office_address || '').trim();
    const websiteUrl = String(body.website_url || '').trim();
    const industry = String(body.industry || '').trim();
    const businessCategory = String(body.business_category || '').trim();
    const staffSize = Number(body.staff_size);
    const govIdType = String(body.gov_id_type || '').trim().toLowerCase();

    if (!tradingName) return fail(res, 400, 'Trading name is required');
    if (description.length < 20) return fail(res, 400, 'Describe your products or services in at least 20 characters');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(supportEmail)) return fail(res, 400, 'A valid support email is required');

    const phone = normalizeNgPhone(body.support_phone);
    if (!phone) return fail(res, 400, 'A valid Nigerian phone number is required');

    if (!officeAddress && !websiteUrl) {
      return fail(res, 400, 'Provide either a physical office address or a website URL');
    }
    if (!industry) return fail(res, 400, 'Industry is required');
    if (!businessCategory) return fail(res, 400, 'Business category is required');
    if (!Number.isInteger(staffSize) || staffSize < 1) return fail(res, 400, 'Number of employees must be at least 1');
    if (!GOV_ID_TYPES.has(govIdType)) {
      return fail(res, 400, `gov_id_type must be one of: ${[...GOV_ID_TYPES].join(', ')}`);
    }

    const files = Array.isArray(req.files) ? req.files : [];
    const byField = new Map();
    for (const file of files) {
      if (DOCUMENT_FIELDS[file.fieldname] && !byField.has(file.fieldname)) byField.set(file.fieldname, file);
    }

    for (const [field, spec] of Object.entries(DOCUMENT_FIELDS)) {
      if (spec.required && !byField.has(field)) {
        return fail(res, 400, `Document "${field}" is required`);
      }
    }

    // Upload before the write so a storage failure leaves no half-built row.
    const documents = {};
    for (const [field, file] of byField.entries()) {
      const uploaded = await uploadFile(file, { prefix: `staffpay_kyb_${company.id}_${field}` });
      documents[DOCUMENT_FIELDS[field].column] = protectText(uploaded.url);
    }

    const tradingNamePii = protect(tradingName, 'name');
    const emailPii = protect(supportEmail, 'email');
    const phonePii = protect(phone.msisdn, 'mobile');

    const data = {
      trading_name_enc: tradingNamePii.enc,
      trading_name_idx: tradingNamePii.idx,
      description,
      support_email_enc: emailPii.enc,
      support_email_idx: emailPii.idx,
      support_phone_enc: phonePii.enc,
      support_phone_idx: phonePii.idx,
      office_address_enc: officeAddress ? protect(officeAddress, 'address').enc : null,
      website_url: websiteUrl || null,
      industry,
      business_category: businessCategory,
      staff_size: staffSize,
      gov_id_type: govIdType,
      status: 'pending',
      decline_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      submitted_at: new Date(),
      ...documents,
    };

    const saved = existing
      ? await prisma.staffPayVerification.update({ where: { company_id: company.id }, data })
      : await prisma.staffPayVerification.create({ data: { ...data, company_id: company.id } });

    await logStaffPayEvent({
      userId: user.id,
      event: existing ? 'staffpay_verification_resubmitted' : 'staffpay_verification_submitted',
      metadata: { company_id: company.id, verification_id: saved.id },
    });

    // Neither channel may fail the submission - the application is saved.
    sendStaffPayVerificationEmail({ to: supportEmail, status: 'submitted', companyName: tradingName }).catch(e =>
      console.error('staffpay verification email failed', { company_id: company.id, error: e?.message || e }),
    );

    notifyUser({
      userId: user.id,
      subject: 'StaffPay application received',
      message: 'Your StaffPay verification is under review. Approval usually takes 5-7 working days.',
      type: 'staffpay',
      data: { company_id: company.id, verification_id: saved.id, status: 'pending' },
    }).catch(() => {});

    return res.json({
      remark: 'staffpay_verification_submitted',
      status: 'success',
      message: [
        'Your application is under review. Approval usually takes 5-7 working days. Please check your active support email for updates.',
      ],
      data: { verification: publicVerification(saved) },
    });
  } catch (e) {
    console.error('staffpay submitVerification error:', e?.message || e);
    return fail(res, 500, e?.message || 'Failed to submit verification', 'error');
  }
}

/**
 * GET /staffpay/companies/:companyId/verification
 * Drives which StaffPay screen the app shows, so it answers for a company that
 * has never applied too.
 */
async function getVerification(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const row = await prisma.staffPayVerification.findUnique({ where: { company_id: company.id } });
    const access = await getAccessState(company.id);

    return res.json({
      remark: 'staffpay_verification',
      status: 'success',
      message: ['OK'],
      data: { verification: publicVerification(row), access },
    });
  } catch (e) {
    console.error('staffpay getVerification error:', e?.message || e);
    return fail(res, 500, e?.message || 'Failed to load verification', 'error');
  }
}

module.exports = {
  submitVerification,
  getVerification,
  publicVerification,
  ownedCompany,
};
