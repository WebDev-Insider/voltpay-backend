const prisma = require('../../database/prisma');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const { generateNumericCode } = require('../helpers/code.helper');
const PasswordResetModel = require('../models/passwordReset.model');
const { sendResetEmail } = require('../services/email.service');
const { getCountryByCode } = require('../helpers/country.helper');

function validatePasswordComplexity(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 16) return 'Password must be between 8 and 16 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least one symbol';
  return '';
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
  if (cc === 'NG') {
    const vars = normalizeNigeriaMobileVariants(mobile);
    if (vars.length) return { OR: vars.map(v => ({ mobile: String(v) })) };
  }
  return { mobile: String(mobile) };
}

async function requestEmailOtp(req, res) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

    if (!email) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email is required'],
        data: null,
      });
    }

    // If email already has an account, block signup OTP to avoid leaking reset route.
    const existingByEmail = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
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
    console.log('🔐 Signup OTP created', { id: inserted.id, email: inserted.email, expires_at: inserted.expires_at });

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
      city,
      zip,
      password,
      password_confirmation,
      device_id,
    } = req.body || {};

    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    const cleanedEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedUsername = typeof username === 'string' ? username.trim() : '';

    if (!cleanedEmail || !code) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email and code are required'],
        data: null,
      });
    }

    if (!mobile_number || !country) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number and country are required'],
        data: null,
      });
    }

    if (!firstname || !lastname || !password || !password_confirmation) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Firstname, lastname, email, password and confirmation are required'],
        data: null,
      });
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
      where: { email: { equals: cleanedEmail, mode: 'insensitive' } },
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
        where: { username: { equals: cleanedUsername, mode: 'insensitive' } },
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

    const hashedPassword = await bcrypt.hash(String(password), 10);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstname: String(firstname),
          lastname: String(lastname),
          username: cleanedUsername || null,
          email: cleanedEmail,
          mobile: String(mobile_number),
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
          address: address ? String(address) : null,
          state: state ? String(state) : null,
          city: city ? String(city) : null,
          zip: zip ? String(zip) : null,
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

    return res.json({
      remark: 'registration_success',
      status: 'success',
      message: ['Registration successful'],
      data: {
        access_token: accessToken,
        token_type: 'Bearer',
        user: {
          id: created.id,
          firstname: created.firstname,
          lastname: created.lastname,
          username: created.username,
          email: created.email,
          mobile: created.mobile,
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
          pn: created.pin ? '1' : '0',
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
  requestEmailOtp,
  registerWithEmailOtp,
};
