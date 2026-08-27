// Support-desk edits to a user's own profile.
//
// The app deliberately locks the fields a person cannot be trusted to rewrite
// on their own: firstname and lastname are read-only in profile_edit_screen and
// are not even read from the body by user.controller.profileSetting, because the
// legal name is what KYC and every CBN report is filed against. Email and mobile
// are read-only there too - mobile is the login identifier (auth.controller
// matches on country + mobile_idx) and email is what a password reset is sent
// to, so letting the account holder swap either one from inside the app is a
// self-service account takeover.
//
// That leaves exactly one correct way to fix a misspelled name: the person asks
// support. This file is that path.
//
// The rules it works under:
//
//   - Email and mobile are credentials, not profile text. Changing one moves
//     where a password reset lands and which number can sign in, so those two
//     are superadmin-only (SENSITIVE_FIELDS below) while a support agent can
//     still fix a name, a username or an address. A rogue support login must not
//     be one step away from a wallet.
//   - A changed email is an unverified email, so `ev` drops back to '0'; same
//     for `sv` and mobile. Carrying the old verified flag across would mean the
//     record says an address was confirmed that nobody ever confirmed.
//   - `kv` is left alone on purpose. A support name change is almost always a
//     correction TOWARDS the identity document ("Chinoso" -> "Chinonso"), so
//     tearing down a good KYC verification would punish the fix. The identity
//     record itself is untouched and still shows the name the register matched.
//   - Values are written through protectUserFields like everywhere else, and are
//     never logged, never put in the audit row and never put in the notification
//     text. adminAudit.middleware records WHICH fields changed plus the admin's
//     `reason`; the values stay in the database.
//   - The account holder is told, on their own channels, every time. That notice
//     is the only thing that catches an edit they did not ask for.
//
// A caveat this endpoint cannot fix: a virtual account already opened at
// PaymentPoint carries the name it was created with (funding.controller
// buildCustomerName), and historical ledger rows keep the counterparty text they
// were written with. Both are correct - they are records of what happened.

const prisma = require('../../database/prisma');

const { blindIndex, protectUserFields, revealUserFields, publicUser } = require('../helpers/pii.helper');
const { isDeleted } = require('../helpers/accountStatus.helper');
const { canonicalNigerianState, isNigerianState } = require('../helpers/nigeriaStates.helper');
const { invalidateUser } = require('../services/userCache.service');
const { logUserEvent } = require('../services/userAudit.service');
const { notifyUser } = require('../services/notify.service');
const { captureError } = require('../services/alerts.service');

// The sign-up form's own rules, reused rather than re-stated. Two copies of
// "what is a valid name" is how a support edit ends up storing something the app
// itself would have refused, and then failing validation on the user's next save.
const { validators } = require('./signup.controller');

const {
  validateName,
  validateUsername,
  validateEmailFormat,
  validateMobileDigits,
  normalizeNigeriaMobileVariants,
  ADDRESS_MAX,
  ZIP_MAX,
} = validators;

const CITY_MAX = 60;

// Everything an admin may write here, in the order the dashboard renders them.
const EDITABLE_FIELDS = ['firstname', 'lastname', 'username', 'email', 'mobile', 'address', 'state', 'city', 'zip'];

// The two that are credentials. Superadmin only - see the header.
const SENSITIVE_FIELDS = new Set(['email', 'mobile']);

// What the account holder is told changed. Field labels only, never values: the
// notification row lives in the database as plain text.
const FIELD_LABELS = {
  firstname: 'first name',
  lastname: 'last name',
  username: 'username',
  email: 'email address',
  mobile: 'phone number',
  address: 'address',
  state: 'state',
  city: 'city',
  zip: 'zip code',
};

const REASON_MIN = 5;
const REASON_MAX = 200;

const fail = (res, code, remark, message) =>
  res.status(code).json({ remark, status: 'error', message: [message], data: null });

/**
 * Pull the editable fields the caller actually sent.
 *
 * Absence and blank are different things. A key that is not in the body is left
 * untouched; a key sent as '' is a request to clear it, which is only allowed
 * for the optional address block - a user with no last name cannot be paid out.
 */
function collectPatch(body) {
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    patch[field] = String(body[field] ?? '').trim();
  }
  return patch;
}

/**
 * Validate one field. Returns an error string, or '' when the value is fine.
 * `countryCode` decides whether `state` has to be a real Nigerian state.
 */
function validateField(field, value, countryCode) {
  switch (field) {
    case 'firstname':
      return validateName(value, 'First name');
    case 'lastname':
      return validateName(value, 'Last name');
    case 'username':
      return validateUsername(value);
    case 'email':
      return validateEmailFormat(value);
    case 'mobile':
      return validateMobileDigits(value);
    case 'address':
      if (value.length > ADDRESS_MAX) return `Address must be at most ${ADDRESS_MAX} characters`;
      return '';
    case 'state':
      // Blank clears it. A value on a Nigerian account has to be one of the 36
      // plus the FCT, or the statements and KYC screens show a state that is not
      // a state.
      if (!value) return '';
      if (String(countryCode) === 'NG' && !isNigerianState(value)) return 'Select a valid Nigerian state';
      return '';
    case 'city':
      if (value.length > CITY_MAX) return `City must be at most ${CITY_MAX} characters`;
      return '';
    case 'zip':
      if (!value) return '';
      if (!/^[0-9]+$/.test(value)) return 'Zip code can only contain numbers';
      if (value.length > ZIP_MAX) return `Zip code must be at most ${ZIP_MAX} digits`;
      return '';
    default:
      return 'Unknown field';
  }
}

/**
 * Is this value already somebody else's?
 *
 * Looked up by blind index, never by value - the plain columns are gone. Mobile
 * checks every Nigerian spelling of the same number, because 08031234567 and
 * 2348031234567 index separately but are one phone.
 */
async function takenByAnotherUser(field, value, userId, countryCode) {
  if (field === 'mobile') {
    const variants = String(countryCode) === 'NG' ? normalizeNigeriaMobileVariants(value) : [value];
    const indexes = variants.map(v => blindIndex(v, 'mobile')).filter(Boolean);
    if (!indexes.length) return false;

    const clash = await prisma.user.findFirst({
      where: { id: { not: userId }, OR: indexes.map(idx => ({ mobile_idx: idx })) },
      select: { id: true },
    });
    return Boolean(clash);
  }

  const domain = field === 'email' ? 'email' : 'username';
  const clash = await prisma.user.findFirst({
    where: { id: { not: userId }, [`${field}_idx`]: blindIndex(value, domain) },
    select: { id: true },
  });
  return Boolean(clash);
}

/**
 * PATCH /admin/users/:id/profile
 *
 * Body: any of firstname, lastname, username, email, mobile, address, state,
 * city, zip - plus a required `reason`, which is what makes the audit row worth
 * reading six months later. Fields that are absent are not touched.
 */
async function updateUserProfile(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'bad_request', 'Invalid user id');

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const reason = String(body.reason || '').trim();
    if (reason.length < REASON_MIN) {
      return fail(
        res,
        400,
        'reason_required',
        'Say why this is being changed - a ticket number or a one-line note. It is written to the audit log.',
      );
    }
    if (reason.length > REASON_MAX) {
      return fail(res, 400, 'reason_too_long', `The reason must be at most ${REASON_MAX} characters`);
    }

    const patch = collectPatch(body);
    const requested = Object.keys(patch);
    if (!requested.length) {
      return fail(res, 400, 'nothing_to_update', 'No editable field was sent');
    }

    // Role gate before anything is read, so a support agent probing this
    // endpoint learns nothing about the account.
    const sensitive = requested.filter(field => SENSITIVE_FIELDS.has(field));
    if (sensitive.length && req.admin?.role !== 'superadmin') {
      return fail(
        res,
        403,
        'forbidden',
        'Changing an email address or phone number moves where a password reset is sent and which number can sign in. That needs a superadmin.',
      );
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        country_code: true,
        firstname_enc: true,
        lastname_enc: true,
        username_enc: true,
        email_enc: true,
        mobile_enc: true,
        address_enc: true,
        state_enc: true,
        city_enc: true,
        zip_enc: true,
        // The plain columns revealUserFields falls back to. A row that predates
        // the encryption backfill still has its address here and nothing in
        // address_enc; without these the "did anything change" diff below reads
        // every one of those fields as empty and reports an untouched form as an
        // edit.
        address: true,
        state: true,
        city: true,
        zip: true,
      },
    });

    if (!user) return fail(res, 404, 'not_found', 'User not found');

    if (isDeleted(user)) {
      return fail(
        res,
        409,
        'account_deleted',
        'This account has been deleted. Its details are kept for the retention period and cannot be edited.',
      );
    }

    // Names are required, so an empty string is a mistake rather than a clear.
    for (const field of ['firstname', 'lastname', 'username']) {
      if (field in patch && !patch[field]) {
        return fail(res, 400, 'validation_error', `${FIELD_LABELS[field]} cannot be empty`);
      }
    }
    for (const field of SENSITIVE_FIELDS) {
      if (field in patch && !patch[field]) {
        return fail(res, 400, 'validation_error', `${FIELD_LABELS[field]} cannot be empty`);
      }
    }

    for (const field of requested) {
      const error = validateField(field, patch[field], user.country_code);
      if (error) return fail(res, 400, 'validation_error', error);
    }

    // 'lagos' and 'Lagos ' are the same state; store the canonical spelling so
    // the statements filter and the KYC screens agree with each other.
    if (patch.state && String(user.country_code) === 'NG') {
      patch.state = canonicalNigerianState(patch.state) || patch.state;
    }

    // Only write what actually moved. An admin who opens the form, changes one
    // letter and saves should not produce a notification listing nine fields.
    const current = revealUserFields(user);
    const changed = requested.filter(field => String(current[field] ?? '') !== patch[field]);

    if (!changed.length) {
      return res.json({
        remark: 'user_profile_unchanged',
        status: 'success',
        message: ['Nothing changed - the values submitted match what is already on file'],
        data: { id, changed: [] },
      });
    }

    for (const field of changed) {
      if (field !== 'username' && !SENSITIVE_FIELDS.has(field)) continue;
      if (await takenByAnotherUser(field, patch[field], id, user.country_code)) {
        return fail(res, 409, `${field}_exists`, `Another account already uses that ${FIELD_LABELS[field]}`);
      }
    }

    const data = protectUserFields(Object.fromEntries(changed.map(field => [field, patch[field]])));

    // A new address or number has been confirmed by nobody. Say so.
    if (changed.includes('email')) data.ev = '0';
    if (changed.includes('mobile')) data.sv = '0';

    const updated = await prisma.user.update({ where: { id }, data });

    // The next request has to see the new values - a stale cached row here means
    // the user's own profile screen still shows the old name for 15 seconds, and
    // the login path reads mobile_idx.
    await invalidateUser(id);

    const labels = changed.map(field => FIELD_LABELS[field] || field);

    // Field names only. The notification row is stored as plain text, so the new
    // email address must not be in it - the user can see the value in the app.
    notifyUser({
      userId: id,
      subject: 'Your profile was updated by support',
      message: `Support updated your ${labels.join(', ')} on your request. If you did not ask for this, contact us immediately.`,
      type: 'security',
      data: { event: 'profile_updated_by_admin', fields: changed },
    }).catch(e => captureError('admin.user_profile_notify', e, { user_id: id }));

    logUserEvent({
      req,
      userId: id,
      event: 'profile.admin_updated',
      metadata: { actor: String(req.admin?.name || 'admin').slice(0, 64), fields: changed },
    }).catch(() => null);

    // Field names, never values. Same rule as adminAudit.middleware.
    console.log('📝 Profile edited by admin', { user_id: id, actor: req.admin?.name || 'admin', fields: changed });

    return res.json({
      remark: 'user_profile_updated',
      status: 'success',
      message: [`Updated ${labels.join(', ')}`],
      data: { user: publicUser(updated), changed },
    });
  } catch (e) {
    // P2002 is the database saying what the pre-check missed - two admins saving
    // the same email in the same second.
    if (e?.code === 'P2002') {
      return fail(res, 409, 'conflict', 'Another account already uses one of those values');
    }
    captureError('admin.user_profile_update', e, { user_id: id });
    return fail(res, 500, 'error', 'Failed to update this profile. Nothing was changed.');
  }
}

module.exports = {
  updateUserProfile,
  __test: { collectPatch, validateField, EDITABLE_FIELDS, SENSITIVE_FIELDS },
};
