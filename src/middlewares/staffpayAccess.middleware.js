/**
 * Route guard: this company is KYB-approved and its subscription is live.
 *
 * Applied to the StaffPay write routes only. Reads stay open so the app can
 * render "you are not verified yet" - a screen that has to call the API to
 * learn it is locked out cannot be locked out of that call.
 *
 * Ownership is re-checked here rather than left to the controller. Without it,
 * the guard would answer "is company 41 verified?" for any logged-in user, and
 * the response body carries that company's status.
 */
const prisma = require('../../database/prisma');
const { requireStaffPayAccess } = require('../helpers/staffpayAccess.helper');

async function resolveCompanyId(req) {
  const direct = Number(req.params?.companyId || req.body?.company_id || req.query?.company_id);
  if (direct) return direct;

  const staffId = Number(req.params?.staffId);
  if (staffId) {
    const staff = await prisma.staffPayStaff.findUnique({
      where: { id: staffId },
      select: { company_id: true },
    });
    return staff?.company_id || 0;
  }

  return 0;
}

module.exports = async function staffPayAccess(req, res, next) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    const companyId = await resolveCompanyId(req);
    // No company id in the request: let the controller produce its own
    // validation error rather than invent one here.
    if (!companyId) return next();

    const owned = await prisma.staffPayCompany.findFirst({
      where: { id: companyId, owner_user_id: Number(user.id) },
      select: { id: true },
    });
    if (!owned) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Company not found'], data: null });
    }

    const allowed = await requireStaffPayAccess(companyId, res);
    if (allowed) return next();
  } catch (e) {
    console.error('staffPayAccess middleware error:', e?.message || e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Access check failed'], data: null });
  }
};
