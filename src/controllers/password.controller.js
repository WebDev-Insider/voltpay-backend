const prisma = require('../../database/prisma');
const { generateNumericCode } = require('../helpers/code.helper');
const { sendResetEmail } = require('../services/email.service');
const PasswordResetModel = require('../models/passwordReset.model');
const UserModel = require('../models/user.model');

function validatePasswordComplexity(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 16) return 'Password must be between 8 and 16 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least one symbol';
  return '';
}

async function requestResetEmail(req, res) {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : req.body.email;
    const requestedType = req.body?.type || req.body?.reset_type;
    const resetType = PasswordResetModel.normalizeResetType(requestedType);
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

    const inserted = await PasswordResetModel.insertToken(user.id, user.email, code, resetType);
    console.log('🔐 PasswordReset created', { id: inserted.id, email: inserted.email, token: inserted.token, expires_at: inserted.expires_at });

    const emailType = resetType === 'password' ? 'password_reset' : 'pin_reset';
    const sendResult = await sendResetEmail(user.email, code, process.env.RESEND_FROM, { type: emailType });
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
      message: [resetType === 'password' ? 'We have emailed your password reset code' : 'We have emailed your PIN reset code'],
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
    const requestedType = req.body?.type || req.body?.reset_type;
    const resetType = PasswordResetModel.normalizeResetType(requestedType);
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

    const reset = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedCode, resetType);
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
    const password = req.body?.password ?? req.body?.new_password;
    const password_confirmation = req.body?.password_confirmation ?? req.body?.confirm_password;
    const requestedType = req.body?.type || req.body?.reset_type;
    const inferredType = password || password_confirmation ? 'password' : (requestedType || 'pin');
    const resetType = PasswordResetModel.normalizeResetType(inferredType);
    console.log('📥 Password reset request (controller):', req.body);

    if (!email || !token) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Email and token are required'],
        data: null,
      });
    }

    if (resetType === 'password') {
      if (!password || !password_confirmation) {
        return res.status(200).json({
          remark: 'validation_error',
          status: 'error',
          message: ['Email, token, and password fields are required'],
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
    } else {
      if (!pin || !pin_confirmation) {
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
    }

    // Normalize token to string, trim, and pad to 6 to handle leading-zero inputs
    const normalizedToken = String(token).trim().padStart(6, '0');

    const reset = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedToken, resetType);
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

    if (resetType === 'password') {
      if (!UserModel.updatePasswordById) {
        return res.status(500).json({
          remark: 'server_error',
          status: 'error',
          message: ['Password reset not supported on server'],
          data: null,
        });
      }
      await UserModel.updatePasswordById(user.id, password);
    } else {
      await UserModel.updatePinById(user.id, pin);
    }
    await PasswordResetModel.markUsed(reset.id);

    return res.json({
      remark: 'password_reset_success',
      status: 'success',
      message: [resetType === 'password' ? 'Password changed successfully' : 'PIN changed successfully'],
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
