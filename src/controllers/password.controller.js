const prisma = require('../../database/prisma');
const { generateNumericCode } = require('../helpers/code.helper');
const { sendResetEmail } = require('../services/email.service');
const PasswordResetModel = require('../models/passwordReset.model');
const UserModel = require('../models/user.model');

async function requestResetEmail(req, res) {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : req.body.email;
    console.log('📥 Password reset email request (controller):', req.body);

    if (!email) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email is required'],
        data: null,
      });
    }

    const user = await UserModel.findBasicByEmail(email);
    if (!user) {
      return res.status(200).json({
        remark: 'user_not_found',
        status: 'error',
        message: ['No account found with this email address'],
        data: null,
      });
    }

    const code = generateNumericCode(6);

    const inserted = await PasswordResetModel.insertToken(user.id, user.email, code);
    console.log('🔐 PasswordReset created', { id: inserted.id, email: inserted.email, token: inserted.token, expires_at: inserted.expires_at });

    const sendResult = await sendResetEmail(user.email, code);
    if (!sendResult || !sendResult.queued) {
      console.error('❌ Password reset email not queued (controller):', sendResult && sendResult.error ? sendResult.error : 'unknown reason');
      return res.status(200).json({
        remark: 'email_send_failed',
        status: 'error',
        message: ['Unable to send reset code email. Please try again later.'],
        data: null,
      });
    }

    return res.json({
      remark: 'password_reset_email',
      status: 'success',
      message: ['We have emailed your PIN reset code'],
      data: null,
    });
  } catch (error) {
    console.error('Error in password/email (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process request'],
      data: null,
    });
  }
}

async function verifyCode(req, res) {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : req.body.email;
    const code = req.body.code ?? req.body.token ?? req.body.otp;
    console.log('📥 Password reset code verify request (controller):', req.body);

    if (!email || !code) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email and code are required'],
        data: null,
      });
    }

    // Normalize code to string, trim, and pad to 6 to handle leading-zero inputs
    const normalizedCode = String(code).trim().padStart(6, '0');

    const reset = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedCode);
    if (!reset) {
      // Debug: inspect latest tokens for this email to diagnose mismatch
      try {
        const dbg = await prisma.passwordReset.findMany({
          where: { email: { equals: String(email).trim(), mode: 'insensitive' } },
          select: { id: true, email: true, token: true, used: true, expires_at: true, created_at: true },
          orderBy: { created_at: 'desc' },
          take: 5,
        });
        const dbgByToken = await prisma.passwordReset.findMany({
          where: { token: String(normalizedCode) },
          select: { id: true, email: true, token: true, used: true, expires_at: true, created_at: true },
          orderBy: { created_at: 'desc' },
          take: 5,
        });
        console.log('🔎 PasswordReset debug (verify)', { email, normalizedCode, latestByEmail: dbg, latestByToken: dbgByToken });
      } catch (e) {
        console.log('🔎 PasswordReset debug failed (verify):', e.message);
      }
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    return res.json({
      remark: 'verification_success',
      status: 'success',
      message: ['Code verified successfully'],
      data: null,
    });
  } catch (error) {
    console.error('Error in password/verify-code (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process request'],
      data: null,
    });
  }
}

async function resetPin(req, res) {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : req.body.email;
    const token = req.body.token ?? req.body.code ?? req.body.otp;
    const { pin, pin_confirmation } = req.body;
    console.log('📥 Password reset request (controller):', req.body);

    if (!email || !token || !pin || !pin_confirmation) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email, token, and PIN fields are required'],
        data: null,
      });
    }
    if (pin !== pin_confirmation) {
      return res.status(200).json({
        remark: 'pin_mismatch',
        status: 'error',
        message: ["PIN and confirmation PIN don't match"],
        data: null,
      });
    }

    // Normalize token to string, trim, and pad to 6 to handle leading-zero inputs
    const normalizedToken = String(token).trim().padStart(6, '0');

    const reset = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedToken);
    if (!reset) {
      // Debug: inspect latest tokens for this email to diagnose mismatch
      try {
        const dbg = await prisma.passwordReset.findMany({
          where: { email: { equals: String(email).trim(), mode: 'insensitive' } },
          select: { id: true, email: true, token: true, used: true, expires_at: true, created_at: true },
          orderBy: { created_at: 'desc' },
          take: 5,
        });
        const dbgByToken = await prisma.passwordReset.findMany({
          where: { token: String(normalizedToken) },
          select: { id: true, email: true, token: true, used: true, expires_at: true, created_at: true },
          orderBy: { created_at: 'desc' },
          take: 5,
        });
        console.log('🔎 PasswordReset debug (reset)', { email, normalizedToken, latestByEmail: dbg, latestByToken: dbgByToken });
      } catch (e) {
        console.log('🔎 PasswordReset debug failed (reset):', e.message);
      }
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    const user = await UserModel.findByEmail(email);
    if (!user) {
      return res.status(200).json({
        remark: 'user_not_found',
        status: 'error',
        message: ['No account found with this email address'],
        data: null,
      });
    }

    await UserModel.updatePinById(user.id, pin);
    await PasswordResetModel.markUsed(reset.id);

    return res.json({
      remark: 'password_reset_success',
      status: 'success',
      message: ['PIN changed successfully'],
      data: null,
    });
  } catch (error) {
    console.error('Error in password/reset (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process request'],
      data: null,
    });
  }
}

module.exports = { requestResetEmail, verifyCode, resetPin };
