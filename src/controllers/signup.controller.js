const prisma = require('../../database/prisma');
const { hashSecret, blindIndex, protectUserFields, revealUserFields, pinFlag } = require('../helpers/pii.helper');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const { generateNumericCode } = require('../helpers/code.helper');
const PasswordResetModel = require('../models/passwordReset.model');
const { sendResetEmail } = require('../services/email.service');
const { getCountryByCode } = require('../helpers/country.helper');
const { canonicalNigerianState, isNigerianState } = require('../helpers/nigeriaStates.helper');
const { generateRecoveryPhrase, hashRecoveryPhrase } = require('../helpers/recovery.helper');

// Field limits. The client enforces the same caps with input formatters, but a
// client is not a trust boundary - every one of these is re-checked here.
const NAME_MAX = 30;
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const ADDRESS_MAX = 100;
const ZIP_MAX = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function validatePasswordComplexity(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 16) return 'Password must be between 8 and 16 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least one symbol';
  return '';
}

function validateName(value, label) {
  const v = String(value || '').trim();
  if (!v) return `${label} is required`;
  if (v.length > NAME_MAX) return `${label} must be at most ${NAME_MAX} characters`;
  if (!/^[A-Za-z][A-Za-z '-]*$/.test(v)) return `${label} can only contain letters, spaces, hyphens and apostrophes`;
  return '';
}

function validateUsername(value) {
  const v = String(value || '').trim();
  if (!v) return 'Username is required';
  if (v.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters`;
  if (v.length > USERNAME_MAX) return `Username must be at most ${USERNAME_MAX} characters`;
  if (!/^[A-Za-z0-9._]+$/.test(v)) return 'Username can only contain letters, numbers, dots and underscores';
  return '';
}

function validateEmailFormat(value) {
  const v = String(value || '').trim();
  if (!v) return 'Email is required';
  if (v.length > 254 || !EMAIL_RE.test(v)) return 'Enter a valid email address';
  return '';
}

// Digits only. The client strips everything else as you type; this catches the
// request that skipped the client.
function validateMobileDigits(value) {
  const v = String(value || '').trim();
  if (!v) return 'Mobile number is required';
  if (!/^[0-9]+$/.test(v)) return 'Mobile number can only contain digits';
  if (v.length < 7 || v.length > 15) return 'Enter a valid mobile number';
  return '';
}

function validateAddressFields({ address, state, zip, country }) {
  const addressValue = String(address || '').trim();
  if (!addressValue) return 'Address is required';
  if (addressValue.length > ADDRESS_MAX) return `Address must be at most ${ADDRESS_MAX} characters`;

  const stateValue = String(state || '').trim();
  if (!stateValue) return 'State is required';
  if (String(country) === 'NG' && !isNigerianState(stateValue)) return 'Select a valid Nigerian state';

  // Zip is optional; when present it is digits only.
  const zipValue = String(zip || '').trim();
  if (zipValue) {
    if (!/^[0-9]+$/.test(zipValue)) return 'Zip code can only contain numbers';
    if (zipValue.length > ZIP_MAX) return `Zip code must be at most ${ZIP_MAX} digits`;
  }
  return '';
}

function validationError(res, message, remark = 'validation_error') {
  return res.status(200).json({
    remark,
    status: 'error',
    message: [message],
    data: null,
  });
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return secret;
}

function signAccessToken(userId, sessionId) {
  const secret = getJwtSecret();
  if (!secret) return null;
  const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
  return jwt.sign({ sub: String(userId), typ: 'access', sid: String(sessionId) }, secret, { expiresIn });
}

async function rotateUserSession(userId, deviceId) {
  const sid = randomUUID();
  await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      active_session_id: sid,
      active_device_id: deviceId ? String(deviceId) : null,
    },
  });
  return sid;
}

function normalizeNigeriaMobileVariants(mobileNumberRaw) {
  const digits = String(mobileNumberRaw || '').replace(/\D/g, '');
  if (!digits) return [];
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  const variants = new Set([
    digits,
    last10,
    last10.length === 10 ? `0${last10}` : '',
    last10.length === 10 ? `234${last10}` : '',
  ].filter(Boolean));
  return Array.from(variants);
}

function buildMobileWhereForCountry({ mobile_number, country }) {
  const cc = String(country || '').trim();
  const mobile = String(mobile_number || '').trim();
  // Lookup is by blind index only - the plain column is gone. Every Nigerian
  // spelling of the same number indexes separately, so match on any of them.
  const variants = cc === 'NG' ? normalizeNigeriaMobileVariants(mobile) : [mobile];
  const indexes = variants.map(v => blindIndex(v, 'mobile')).filter(Boolean);
  if (!indexes.length) return { mobile_idx: null };
  return { OR: indexes.map(idx => ({ mobile_idx: idx })) };
}

/**
 * GET /signup/availability?username=&email=
 *
 * Powers the as-you-type checks on the personal information step. Both lookups
 * go through the blind index - the plain columns are gone, and username
 * normalisation lowercases, so uniqueness is case-insensitive.
 *
 * This is an account-enumeration oracle by nature (any live availability check
 * is), which is why the route is rate limited in signup.routes.js.
 */
async function checkAvailability(req, res) {
  try {
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';

    if (!username && !email) {
      return validationError(res, 'Provide a username or an email to check');
    }

    const data = {};

    if (username) {
      const formatError = validateUsername(username);
      if (formatError) {
        data.username = { value: username, available: false, valid: false, message: formatError };
      } else {
        const taken = await prisma.user.findFirst({
          where: { username_idx: blindIndex(username, 'username') },
          select: { id: true },
        });
        data.username = {
          value: username,
          valid: true,
          available: !taken,
          message: taken ? 'This username is already taken' : 'Username is available',
        };
      }
    }

    if (email) {
      const formatError = validateEmailFormat(email);
      if (formatError) {
        data.email = { value: email, available: false, valid: false, message: formatError };
      } else {
        const taken = await prisma.user.findFirst({
          where: { email_idx: blindIndex(email, 'email') },
          select: { id: true },
        });
        data.email = {
          value: email,
          valid: true,
          available: !taken,
          message: taken ? 'An account with this email already exists' : 'Email is available',
        };
      }
    }

    return res.json({
      remark: 'availability',
      status: 'success',
      message: ['Availability checked'],
      data,
    });
  } catch (e) {
    console.error('checkAvailability error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to check availability'],
      data: null,
    });
  }
}

/**
 * POST /signup/verify-email
 *
 * Checks the signup OTP without consuming it. The wizard verifies the email on
 * step one but the account is only created two steps later, and it is
 * registerWithEmailOtp that marks the row used - burn it here and registration
 * would fail with "invalid or expired code".
 */
async function verifySignupEmailOtp(req, res) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const code = req.body?.code;

    if (!email || !code) {
      return validationError(res, 'Email and code are required');
    }

    const normalizedCode = String(code).trim().padStart(6, '0');
    const tokenRow = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedCode, 'signup');
    if (!tokenRow) {
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    return res.json({
      remark: 'email_verified',
      status: 'success',
      message: ['Email verified'],
      data: { verified: true, expires_at: tokenRow.expires_at },
    });
  } catch (e) {
    console.error('verifySignupEmailOtp error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to verify code'],
      data: null,
    });
  }
}

async function requestEmailOtp(req, res) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

    const emailError = validateEmailFormat(email);
    if (emailError) {
      return validationError(res, emailError);
    }

    // If email already has an account, block signup OTP to avoid leaking reset route.
    const existingByEmail = await prisma.user.findFirst({
      where: { email_idx: blindIndex(email, 'email') },
      select: { id: true },
    });
    if (existingByEmail) {
      return res.status(200).json({
        remark: 'email_exists',
        status: 'error',
        message: ['An account with this email address already exists. Please try logging in instead.'],
        data: null,
      });
    }

    const code = generateNumericCode(6);
    const inserted = await PasswordResetModel.insertToken(null, email, code, 'signup');
    console.log('🔐 Signup OTP created', { id: inserted.id, expires_at: inserted.expires_at });

    const sendResult = await sendResetEmail(email, code, process.env.RESEND_FROM, { type: 'email_verification' });
    if (!sendResult || !sendResult.queued) {
      console.error('❌ Signup OTP email not queued:', sendResult && sendResult.error ? sendResult.error : 'unknown reason');
      return res.status(200).json({
        remark: 'email_send_failed',
        status: 'error',
        message: ['Unable to send verification code email. Please try again later.'],
        data: null,
      });
    }

    return res.json({
      remark: 'signup_otp_sent',
      status: 'success',
      message: ['Verification code sent to your email'],
      data: null,
    });
  } catch (e) {
    console.error('requestEmailOtp error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to send verification code'],
      data: null,
    });
  }
}

async function registerWithEmailOtp(req, res) {
  try {
    const {
      code,
      email,
      mobile_number,
      country,
      firstname,
      lastname,
      username,
      address,
      state,
      zip,
      password,
      password_confirmation,
      device_id,
    } = req.body || {};

    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    const cleanedEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedUsername = typeof username === 'string' ? username.trim() : '';

    if (!cleanedEmail || !code) {
      return validationError(res, 'Email and code are required');
    }

    if (!country) {
      return validationError(res, 'Country is required');
    }

    if (!password || !password_confirmation) {
      return validationError(res, 'Password and confirmation are required');
    }

    // Same order as the wizard: personal information, then address, then password.
    const fieldError =
      validateName(firstname, 'First name') ||
      validateName(lastname, 'Last name') ||
      validateUsername(username) ||
      validateEmailFormat(cleanedEmail) ||
      validateMobileDigits(mobile_number) ||
      validateAddressFields({ address, state, zip, country });
    if (fieldError) {
      return validationError(res, fieldError);
    }

    if (String(password) !== String(password_confirmation)) {
      return res.status(200).json({
        remark: 'password_mismatch',
        status: 'error',
        message: ["Password and confirmation password don't match"],
        data: null,
      });
    }

    const pwdErr = validatePasswordComplexity(password);
    if (pwdErr) {
      return res.status(200).json({
        remark: 'weak_password',
        status: 'error',
        message: [pwdErr],
        data: null,
      });
    }

    const normalizedCode = String(code).trim().padStart(6, '0');
    const tokenRow = await PasswordResetModel.findLatestByEmailAndToken(cleanedEmail, normalizedCode, 'signup');
    if (!tokenRow) {
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    // Uniqueness checks
    const existingByEmail = await prisma.user.findFirst({
      where: { email_idx: blindIndex(cleanedEmail, 'email') },
      select: { id: true },
    });
    if (existingByEmail) {
      return res.status(200).json({
        remark: 'email_exists',
        status: 'error',
        message: ['An account with this email address already exists. Please use a different email or try logging in.'],
        data: null,
      });
    }

    if (cleanedUsername) {
      const existingByUsername = await prisma.user.findFirst({
        where: { username_idx: blindIndex(cleanedUsername, 'username') },
        select: { id: true },
      });
      if (existingByUsername) {
        return res.status(200).json({
          remark: 'username_exists',
          status: 'error',
          message: ['This username is already taken. Please choose a different username.'],
          data: null,
        });
      }
    }

    const existingByMobile = await prisma.user.findFirst({
      where: {
        country_code: String(country),
        ...buildMobileWhereForCountry({ mobile_number, country }),
      },
      select: { id: true },
    });
    if (existingByMobile) {
      return res.status(200).json({
        remark: 'user_exists',
        status: 'error',
        message: ['An account with this phone number already exists. Please try logging in instead.'],
        data: null,
      });
    }

    const hashedPassword = await hashSecret(String(password), 'password');

    // Generated here, not on the client: the server must not accept a phrase it
    // did not mint, or an attacker could register an account whose "recovery
    // phrase" they chose to be guessable. Returned once in this response and
    // never again - only the hash is stored.
    const recoveryPhrase = generateRecoveryPhrase();
    const recoveryHash = await hashRecoveryPhrase(recoveryPhrase);

    const canonicalState = String(country) === 'NG'
      ? canonicalNigerianState(state)
      : String(state || '').trim();

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          ...protectUserFields({
            firstname: String(firstname).trim(),
            lastname: String(lastname).trim(),
            username: cleanedUsername,
            email: cleanedEmail,
            mobile: String(mobile_number).trim(),
            address: address ? String(address).trim() : '',
            state: canonicalState,
            // City was removed from the signup form - the state picker covers it.
            city: '',
            zip: zip ? String(zip).trim() : '',
          }),
          recovery_hash: recoveryHash,
          recovery_set_at: new Date(),
          country_code: String(country),
          balance: '0.00',
          currency_symbol: '₦',
          profile_complete: '1',
          status: 1,
          ev: '1',
          sv: '1',
          tv: '1',
          kv: '0',
          image: null,
          pin: null,
          password: hashedPassword,
        },
      });

      await tx.passwordReset.update({
        where: { id: Number(tokenRow.id) },
        data: { used: true },
      });

      return user;
    });

    let sessionId;
    try {
      sessionId = await rotateUserSession(created.id, effectiveDeviceId);
    } catch (e) {
      console.error('❌ Failed to persist active session during signup/register:', e);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to create login session'],
        data: null,
      });
    }

    const accessToken = signAccessToken(created.id, sessionId);
    if (!accessToken) {
      return res.status(500).json({
        remark: 'config_error',
        status: 'error',
        message: ['JWT_SECRET not configured'],
        data: null,
      });
    }

    const countryDetails = getCountryByCode(created.country_code);
    const createdPii = revealUserFields(created);

    return res.json({
      remark: 'registration_success',
      status: 'success',
      message: ['Registration successful'],
      data: {
        access_token: accessToken,
        token_type: 'Bearer',
        // The only time this leaves the server. There is no endpoint that can
        // read it back - the column holds a scrypt hash, not the words.
        recovery_phrase: recoveryPhrase,
        recovery_word_count: recoveryPhrase.split(' ').length,
        user: {
          id: created.id,
          firstname: createdPii.firstname,
          lastname: createdPii.lastname,
          username: createdPii.username,
          email: createdPii.email,
          mobile: createdPii.mobile,
          country_code: created.country_code,
          country_name: countryDetails.name,
          country_flag: countryDetails.image_src,
          dial_code: countryDetails.dial_code,
          balance: created.balance,
          currency_symbol: created.currency_symbol || '₦',
          profile_complete: created.profile_complete,
          status: created.status,
          ev: created.ev,
          sv: created.sv,
          tv: created.tv,
          kv: created.kv,
          pn: pinFlag(created),
          image: created.image,
          created_at: created.created_at,
          updated_at: created.updated_at,
        },
      },
    });
  } catch (e) {
    console.error('registerWithEmailOtp error:', e);
    if (e && e.code === 'P2002') {
      const target = Array.isArray(e.meta?.target) ? e.meta.target.join(',') : (e.meta?.target || '').toString();
      if (target.toLowerCase().includes('email')) {
        return res.status(200).json({
          remark: 'email_exists',
          status: 'error',
          message: ['An account with this email address already exists. Please use a different email or try logging in.'],
          data: null,
        });
      }
      if (target.toLowerCase().includes('username')) {
        return res.status(200).json({
          remark: 'username_exists',
          status: 'error',
          message: ['This username is already taken. Please choose a different username.'],
          data: null,
        });
      }
      return res.status(200).json({
        remark: 'unique_constraint',
        status: 'error',
        message: ['A unique field already exists. Please use different values and try again.'],
        data: null,
      });
    }

    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to create account'],
      data: null,
    });
  }
}

module.exports = {
  checkAvailability,
  requestEmailOtp,
  verifySignupEmailOtp,
  registerWithEmailOtp,
  // The field rules this form is validated against, exported so the admin
  // profile editor (adminUserProfile.controller) holds a support edit to the
  // same standard. Two copies of "what is a valid name" is how a support fix
  // ends up storing something the app itself would have refused, and then
  // failing on the user's next save.
  validators: {
    validateName,
    validateUsername,
    validateEmailFormat,
    validateMobileDigits,
    validateAddressFields,
    normalizeNigeriaMobileVariants,
    NAME_MAX,
    USERNAME_MIN,
    USERNAME_MAX,
    ADDRESS_MAX,
    ZIP_MAX,
  },
};
