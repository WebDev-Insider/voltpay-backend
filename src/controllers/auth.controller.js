const prisma = require('../../database/prisma');
const admin = require('firebase-admin');
const { getCountryByCode } = require('../helpers/country.helper');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const {
  blindIndex,
  canonicalMobile,
  hashSecret,
  verifySecret,
  protectUserFields,
  revealUserFields,
  pinFlag,
} = require('../helpers/pii.helper');
const { generateNumericCode } = require('../helpers/code.helper');
const PasswordResetModel = require('../models/passwordReset.model');
const { sendResetEmail } = require('../services/email.service');
const { isValidRecoveryPhrase, verifyRecoveryPhrase } = require('../helpers/recovery.helper');
const LoginLockout = require('../helpers/loginLockout.helper');
const { issueBiometricToken, verifyBiometricToken, revokeBiometric } = require('../helpers/biometric.helper');
const redis = require('../services/redis.service');
const cache = require('../services/cache.service');
const { invalidateUser } = require('../services/userCache.service');
const { isActive, DEACTIVATED, inactiveResponse, sendInactive } = require('../helpers/accountStatus.helper');

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'));
}

async function withDirectFallback(run) {
  try {
    return await run(prisma);
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) {
      return await run(prisma.$direct);
    }
    throw e;
  }
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

/**
 * Match on the blind index, never on the plain mobile column. Each accepted
 * variant (0803..., 234803..., 803...) is indexed separately so a user typing
 * any of them still resolves to the same record.
 */
function buildMobileWhereForCountry({ mobile_number, country }) {
  const cc = String(country || '').trim();
  const mobile = String(mobile_number || '').trim();
  const variants = cc === 'NG' ? normalizeNigeriaMobileVariants(mobile) : [mobile];
  const indexes = variants.map(v => blindIndex(v, 'mobile')).filter(Boolean);
  if (!indexes.length) return { mobile_idx: null };
  return { OR: indexes.map(idx => ({ mobile_idx: idx })) };
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return secret;
}

function validatePasswordComplexity(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 16) return 'Password must be between 8 and 16 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least one symbol';
  return '';
}

function signAccessToken(userId, sessionId) {
  const secret = getJwtSecret();
  if (!secret) return null;
  const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
  return jwt.sign({ sub: String(userId), typ: 'access', sid: String(sessionId) }, secret, { expiresIn });
}

/**
 * Re-hash a legacy bcrypt secret with the current scheme on successful login.
 * Best-effort: a failure here must never block a valid login.
 */
async function upgradeSecret(userId, field, plaintext) {
  try {
    const hashed = await hashSecret(plaintext, field);
    await withDirectFallback(p => p.user.update({
      where: { id: Number(userId) },
      data: { [field]: hashed },
    }));
  } catch (e) {
    console.warn(`⚠️ Failed to upgrade ${field} hash for user ${userId}:`, e?.message || e);
  }
}

async function rotateUserSession(userId, deviceId) {
  const sid = randomUUID();
  await withDirectFallback(p => p.user.update({
    where: { id: Number(userId) },
    data: {
      active_session_id: sid,
      active_device_id: deviceId ? String(deviceId) : null,
    },
  }));
  // userAuth compares the token's sid against this row, so a cached copy would
  // reject the token the login just issued.
  await invalidateUser(userId);
  return sid;
}

// Shown on the "verify this device" screen so the user knows which inbox to
// open, without the response handing a full address to whoever holds the
// password.
function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return '';
  const name = value.slice(0, at);
  const domain = value.slice(at);
  if (name.length <= 2) return `${name[0]}*${domain}`;
  return `${name[0]}${'*'.repeat(Math.min(name.length - 2, 6))}${name[name.length - 1]}${domain}`;
}

/**
 * A login is "from a new device" when the account already has a device bound
 * and this request carries a different one. Requests with no device id count as
 * new: we cannot prove they came from the bound device, and the safe default on
 * an ambiguous auth signal is the stricter path.
 *
 * Accounts with no recovery phrase (everyone who registered before the feature)
 * are exempt - there would be nothing to verify against and they would be
 * locked out.
 */
function isNewDeviceLogin(user, deviceId) {
  if (!user || !user.recovery_hash) return false;
  const knownDevice = String(user.active_device_id || '').trim();
  if (!knownDevice) return false;
  return String(deviceId || '').trim() !== knownDevice;
}

// Field-by-field, never a bare spread: `user` still carries the password hash
// and the *_enc / *_idx columns.
function buildLoginData(user, accessToken, needsSetPassword = false) {
  const countryDetails = getCountryByCode(user.country_code);
  const pii = revealUserFields(user);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    next_step: needsSetPassword ? 'set_password' : null,
    force_set_password: needsSetPassword ? true : false,
    user: {
      id: user.id,
      firstname: pii.firstname,
      lastname: pii.lastname,
      username: pii.username,
      email: pii.email,
      mobile: pii.mobile,
      country_code: user.country_code,
      country_name: countryDetails.name,
      country_flag: countryDetails.image_src,
      dial_code: countryDetails.dial_code,
      balance: user.balance,
      currency_symbol: user.currency_symbol || '₦',
      profile_complete: user.profile_complete,
      status: user.status,
      ev: user.ev,
      sv: user.sv,
      tv: user.tv,
      kv: user.kv,
      pn: pinFlag(user),
      image: user.image,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
  };
}

// type picks the token namespace: 'device' for a new-device login,
// 'reactivate' for bringing a closed account back. A code mailed for one
// purpose must never be redeemable against the other.
async function sendDeviceVerificationCode(user, type = 'device') {
  const pii = revealUserFields(user);
  const email = String(pii.email || '').trim();
  if (!email) return { sent: false, email: '' };

  // Same cooldown as the password reset codes, and for the same reason: a
  // double-tapped resend writes a second passwordReset row, and verification
  // takes the newest matching row - so the second code silently retires the one
  // the user is looking at. Reported as sent, because a valid code is already
  // in their inbox. Keyed by blind index, never by the address itself.
  const otpSubject = blindIndex(`${type}:${email}`, 'email');
  if (!(await cache.claimOtpSlot(otpSubject))) return { sent: true, email };

  const code = generateNumericCode(6);
  await PasswordResetModel.insertToken(user.id, email, code, type);
  // No from argument: email.service resolves BREVO_FROM -> EMAIL_FROM ->
  // RESEND_FROM and validates the result. Reading a variable here only put a
  // dead provider's name ahead of the live one.
  const result = await sendResetEmail(email, code, null, { type: 'email_verification' });
  if (!result || !result.queued) {
    console.error('❌ Device verification email not queued for user', user.id);
    await cache.releaseOtpSlot(otpSubject);
    return { sent: false, email };
  }
  return { sent: true, email };
}

function dateKey(d = new Date()) {
  const timeZone = process.env.APP_TIMEZONE;
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(d));

      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const day = parts.find(p => p.type === 'day')?.value;
      if (y && m && day) return `${y}-${m}-${day}`;
    } catch (_) {}
  }

  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function recordDailyLogin(userId) {
  try {
    const day = dateKey();

    // The database side of this is a read-modify-write of a JSON array that
    // grows all day, run on every single login. Redis remembers who already
    // logged in today, so the second login of the day costs one SADD and
    // touches Postgres not at all. Returns null when Redis is unavailable,
    // which falls through to the old path.
    const isNew = await redis.sAddIsNew(redis.key('daily_login', day), Number(userId), 2 * 24 * 60 * 60);
    if (isNew === false) return;

    const key = `daily_login_users:${day}`;
    const existing = await withDirectFallback(p => p.appSetting.findUnique({ where: { setting_key: key } }));
    let set = new Set();
    if (existing?.setting_value) {
      try {
        const arr = JSON.parse(existing.setting_value);
        if (Array.isArray(arr)) set = new Set(arr.map(Number));
      } catch (_) {}
    }
    if (!set.has(Number(userId))) {
      set.add(Number(userId));
      const value = JSON.stringify(Array.from(set));
      if (existing) {
        await withDirectFallback(p => p.appSetting.update({ where: { setting_key: key }, data: { setting_value: value } }));
      } else {
        await withDirectFallback(p => p.appSetting.create({ data: { setting_key: key, setting_value: value, description: 'Unique user IDs that logged in on this date' } }));
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to record daily login:', e.message);
  }
}

async function login(req, res) {
  try {
    const { mobile_number, country, password, pin, device_id } = req.body;
    const effectiveDeviceId = device_id || req.headers['x-device-id'];


    if (!mobile_number || !country || (!password && !pin)) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, and password are required'],
        data: null
      });
    }

    // Three wrong credentials in a row freeze this account for 10 minutes.
    // Checked before the lookup so a locked account costs no database work.
    const lockKey = LoginLockout.lockKey(country, mobile_number);
    const lockedFor = await LoginLockout.getLockRemainingSeconds(lockKey);
    if (lockedFor > 0) {
      const minutes = Math.ceil(lockedFor / 60);
      res.set('Retry-After', String(lockedFor));
      return res.status(429).json({
        remark: 'account_locked',
        status: 'error',
        message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
        data: { retry_after_seconds: lockedFor },
      });
    }

    let user = null;
    try {
      user = await withDirectFallback(p => p.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      }));
      console.log(user ? `✅ User found in database: id=${user.id}` : '❌ User not found in database');
    } catch (dbError) {
      console.error('❌ Database query error:', dbError);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Database connection error. Please try again later.'],
        data: null
      });
    }

    if (!user) {
      return res.status(401).json({
        remark: 'user_not_found',
        status: 'error',
        message: ['Incorrect phone number or PIN. Please check your credentials and try again.'],
        data: null
      });
    }

    // Blocked users cannot login
    if (!isActive(user)) {
      return sendInactive(res, user);
    }

    const hasPassword = !!(user.password && String(user.password).trim());
    if (hasPassword) {
      if (!password) {
        return res.status(400).json({
          remark: 'password_required',
          status: 'error',
          message: ['Password is required'],
          data: null
        });
      }
      const check = await verifySecret(password, user.password, 'password');
      if (!check.ok) {
        const failure = await LoginLockout.registerFailure(lockKey);
        if (failure.locked) {
          const minutes = Math.ceil(failure.remainingSeconds / 60);
          res.set('Retry-After', String(failure.remainingSeconds));
          return res.status(429).json({
            remark: 'account_locked',
            status: 'error',
            message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
            data: { retry_after_seconds: failure.remainingSeconds },
          });
        }
        return res.status(401).json({
          remark: 'invalid_password',
          status: 'error',
          message: [`Incorrect phone number or password. ${failure.attemptsLeft} attempt${failure.attemptsLeft === 1 ? '' : 's'} left before your account is locked for 10 minutes.`],
          data: { attempts_left: failure.attemptsLeft }
        });
      }
      if (check.needsRehash) await upgradeSecret(user.id, 'password', password);
    } else {
      if (!pin) {
        return res.status(400).json({
          remark: 'pin_required',
          status: 'error',
          message: ['PIN is required to login for the first time. Please login with your PIN and set a password.'],
          data: null
        });
      }

      const pinLoginUsed = user.pin_login_used === true;
      if (pinLoginUsed) {
        return res.status(401).json({
          remark: 'password_required',
          status: 'error',
          message: ['Password required. Please reset or set your password to continue.'],
          data: null
        });
      }

      const pinCheck = await verifySecret(pin, user.pin, 'pin');
      if (!pinCheck.ok) {
        const failure = await LoginLockout.registerFailure(lockKey);
        if (failure.locked) {
          const minutes = Math.ceil(failure.remainingSeconds / 60);
          res.set('Retry-After', String(failure.remainingSeconds));
          return res.status(429).json({
            remark: 'account_locked',
            status: 'error',
            message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
            data: { retry_after_seconds: failure.remainingSeconds },
          });
        }
        return res.status(401).json({
          remark: 'invalid_pin',
          status: 'error',
          message: [`Incorrect phone number or PIN. ${failure.attemptsLeft} attempt${failure.attemptsLeft === 1 ? '' : 's'} left before your account is locked for 10 minutes.`],
          data: { attempts_left: failure.attemptsLeft }
        });
      }
      if (pinCheck.needsRehash) await upgradeSecret(user.id, 'pin', pin);

      try {
        await withDirectFallback(p => p.user.update({
          where: { id: Number(user.id) },
          data: { pin_login_used: true },
        }));
        user.pin_login_used = true;
      } catch (e) {
        console.warn('⚠️ Failed to mark pin_login_used:', e?.message || e);
      }
    }

    // Credentials checked out - the failure streak is over.
    await LoginLockout.clearFailures(lockKey);

    // Credentials are correct, but a correct password alone must not move an
    // account onto a device it has never been seen on. Stop here and make the
    // caller clear the email OTP + recovery phrase challenge instead - no token
    // is issued and the existing session on the old device stays alive.
    if (isNewDeviceLogin(user, effectiveDeviceId)) {
      const delivery = await sendDeviceVerificationCode(user);
      const pii = revealUserFields(user);
      return res.status(200).json({
        remark: 'new_device_verification_required',
        status: 'error',
        message: [
          delivery.sent
            ? 'New device detected. Enter the code sent to your email, then your recovery phrase.'
            : 'New device detected, but the verification email could not be sent. Please try again later.',
        ],
        data: {
          new_device: true,
          code_sent: delivery.sent,
          email_masked: maskEmail(pii.email),
          next_step: 'verify_email_then_recovery_phrase',
          recovery_word_count: 12,
        },
      });
    }

    let sessionId;
    try {
      sessionId = await rotateUserSession(user.id, effectiveDeviceId);
    } catch (e) {
      console.error('❌ Failed to persist active session during login:', e);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to create login session'],
        data: null
      });
    }

    const accessToken = signAccessToken(user.id, sessionId);
    if (!accessToken) {
      return res.status(500).json({
        remark: 'config_error',
        status: 'error',
        message: ['JWT_SECRET not configured'],
        data: null
      });
    }
    await recordDailyLogin(user.id);

    const needsSetPassword = !hasPassword;
    return res.json({
      remark: needsSetPassword ? 'set_password_required' : 'login_success',
      status: 'success',
      message: [needsSetPassword ? 'Please set a password to continue' : 'Login successful'],
      data: buildLoginData(user, accessToken, needsSetPassword),
    });
  } catch (error) {
    console.error('Error in login (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process login'],
      data: null
    });
  }
}

async function register(req, res) {
  try {
    const { mobile_number, country, firstname, lastname, email, password, password_confirmation, device_id } = req.body;
    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    if (!mobile_number || !country) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number and country are required'],
        data: null
      });
    }

    const wantsPasswordRegistration = !!password;
    const cleanedEmail = typeof email === 'string' ? email.trim() : '';
    if (wantsPasswordRegistration) {
      if (!cleanedEmail || !firstname || !lastname || !password_confirmation) {
        return res.status(400).json({
          remark: 'validation_error',
          status: 'error',
          message: ['Firstname, lastname, email, password and confirmation are required'],
          data: null
        });
      }
      if (String(password) !== String(password_confirmation)) {
        return res.status(400).json({
          remark: 'password_mismatch',
          status: 'error',
          message: ["Password and confirmation password don't match"],
          data: null
        });
      }
      const pwdErr = validatePasswordComplexity(password);
      if (pwdErr) {
        return res.status(400).json({
          remark: 'weak_password',
          status: 'error',
          message: [pwdErr],
          data: null
        });
      }
    }

    try {
      const existingUser = await withDirectFallback(p => p.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      }));

      if (existingUser) {
        if (existingUser.profile_complete === '1') {
          return res.status(409).json({
            remark: 'user_exists',
            status: 'error',
            message: ['An account with this phone number already exists. Please try logging in instead.'],
            data: null
          });
        } else {
          let sessionId;
          try {
            sessionId = await rotateUserSession(existingUser.id, effectiveDeviceId);
          } catch (e) {
            console.error('❌ Failed to persist active session during registration(profile_incomplete):', e);
            return res.status(500).json({
              remark: 'database_error',
              status: 'error',
              message: ['Failed to create login session'],
              data: null
            });
          }

          const accessToken = signAccessToken(existingUser.id, sessionId);
          if (!accessToken) {
            return res.status(500).json({
              remark: 'config_error',
              status: 'error',
              message: ['JWT_SECRET not configured'],
              data: null
            });
          }
          const countryDetails = getCountryByCode(existingUser.country_code);
          const pii = revealUserFields(existingUser);
          return res.json({
            remark: 'profile_incomplete',
            status: 'success',
            message: ['Please complete your profile setup'],
            data: {
              access_token: accessToken,
              token_type: 'Bearer',
              user: {
                id: existingUser.id,
                firstname: pii.firstname,
                lastname: pii.lastname,
                username: pii.username,
                email: pii.email,
                mobile: pii.mobile,
                country_code: existingUser.country_code,
                country_name: countryDetails.name,
                country_flag: countryDetails.image_src,
                dial_code: countryDetails.dial_code,
                balance: existingUser.balance,
                currency_symbol: existingUser.currency_symbol || '₦',
                profile_complete: existingUser.profile_complete,
                status: existingUser.status,
                ev: existingUser.ev,
                sv: existingUser.sv,
                tv: existingUser.tv,
                kv: existingUser.kv,
                pn: pinFlag(existingUser),
                image: existingUser.image,
                created_at: existingUser.created_at,
                updated_at: existingUser.updated_at
              }
            }
          });
        }
      }
    } catch (dbError) {
      console.error('❌ Database error during user check:', dbError);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Database error occurred. Please try again later.'],
        data: null
      });
    }

    try {
      const hashedPassword = wantsPasswordRegistration ? await hashSecret(password, 'password') : null;
      const newUser = await withDirectFallback(p => p.user.create({
        data: {
          ...protectUserFields({
            firstname: wantsPasswordRegistration ? String(firstname) : '',
            lastname: wantsPasswordRegistration ? String(lastname) : '',
            username: null,
            email: wantsPasswordRegistration ? cleanedEmail : null,
            mobile: String(mobile_number),
          }),
          country_code: String(country),
          balance: '0.00',
          currency_symbol: '₦',
          profile_complete: wantsPasswordRegistration ? '1' : '0',
          status: 1,
          ev: '1',
          sv: '1',
          tv: '1',
          kv: '0',
          image: null,
          pin: null,
          password: hashedPassword,
        },
      }));

      if (wantsPasswordRegistration) {
        let sessionId;
        try {
          sessionId = await rotateUserSession(newUser.id, effectiveDeviceId);
        } catch (e) {
          console.error('❌ Failed to persist active session during registration(registration_success):', e);
          return res.status(500).json({
            remark: 'database_error',
            status: 'error',
            message: ['Failed to create login session'],
            data: null
          });
        }

        const accessToken = signAccessToken(newUser.id, sessionId);
        if (!accessToken) {
          return res.status(500).json({
            remark: 'config_error',
            status: 'error',
            message: ['JWT_SECRET not configured'],
            data: null
          });
        }
        const countryDetails = getCountryByCode(newUser.country_code);
        const pii = revealUserFields(newUser);
        return res.json({
          remark: 'registration_success',
          status: 'success',
          message: ['Registration successful'],
          data: {
            access_token: accessToken,
            token_type: 'Bearer',
            user: {
              id: newUser.id,
              firstname: pii.firstname,
              lastname: pii.lastname,
              username: pii.username,
              email: pii.email,
              mobile: pii.mobile,
              country_code: newUser.country_code,
              country_name: countryDetails.name,
              country_flag: countryDetails.image_src,
              dial_code: countryDetails.dial_code,
              balance: newUser.balance,
              currency_symbol: newUser.currency_symbol || '₦',
              profile_complete: newUser.profile_complete,
              status: newUser.status,
              ev: newUser.ev,
              sv: newUser.sv,
              tv: newUser.tv,
              kv: newUser.kv,
              pn: pinFlag(newUser),
              image: newUser.image,
              created_at: newUser.created_at,
              updated_at: newUser.updated_at
            }
          }
        });
      }

      let sessionId;
      try {
        sessionId = await rotateUserSession(newUser.id, effectiveDeviceId);
      } catch (e) {
        console.error('❌ Failed to persist active session during registration(registration_started):', e);
        return res.status(500).json({
          remark: 'database_error',
          status: 'error',
          message: ['Failed to create login session'],
          data: null
        });
      }

      const accessToken = signAccessToken(newUser.id, sessionId);
      if (!accessToken) {
        return res.status(500).json({
          remark: 'config_error',
          status: 'error',
          message: ['JWT_SECRET not configured'],
          data: null
        });
      }
      const countryDetails = getCountryByCode(newUser.country_code);
      const pii = revealUserFields(newUser);
      return res.json({
        remark: 'registration_started',
        status: 'success',
        message: ['Registration started. Please complete your profile.'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: newUser.id,
            firstname: pii.firstname,
            lastname: pii.lastname,
            username: pii.username,
            email: pii.email,
            mobile: pii.mobile,
            country_code: newUser.country_code,
            country_name: countryDetails.name,
            country_flag: countryDetails.image_src,
            dial_code: countryDetails.dial_code,
            balance: newUser.balance,
            currency_symbol: newUser.currency_symbol || '₦',
            profile_complete: newUser.profile_complete,
            status: newUser.status,
            ev: newUser.ev,
            sv: newUser.sv,
            tv: newUser.tv,
            kv: newUser.kv,
            pn: pinFlag(newUser),
            image: newUser.image,
            created_at: newUser.created_at,
            updated_at: newUser.updated_at
          }
        }
      });
    } catch (dbError) {
      console.error('❌ Error creating user in database:', dbError);

      if (dbError && dbError.code === 'P2002') {
        const target = Array.isArray(dbError.meta?.target)
          ? dbError.meta.target.join(',')
          : (dbError.meta?.target || '').toString();

        if (target.toLowerCase().includes('email')) {
          return res.status(409).json({
            remark: 'email_exists',
            status: 'error',
            message: ['An account with this email address already exists. Please use a different email or try logging in.'],
            data: null
          });
        }

        if (target.toLowerCase().includes('username')) {
          return res.status(409).json({
            remark: 'username_exists',
            status: 'error',
            message: ['This username is already taken. Please choose a different username.'],
            data: null
          });
        }

        return res.status(409).json({
          remark: 'unique_constraint',
          status: 'error',
          message: ['A unique field already exists. Please use different values and try again.'],
          data: null
        });
      }

      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to create user account. Please try again later.'],
        data: null
      });
    }
  } catch (error) {
    console.error('Error in registration (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process registration'],
      data: null
    });
  }
}

async function authentication(req, res) {
  try {
    const { mobile_number, country, pin, device_id } = req.body;
    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    if (!mobile_number || !country) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number and country are required'],
        data: null
      });
    }

      if (pin) {
      // Maintain compatibility: handle login here when PIN is provided.
      //
      // This branch is a full PIN login, so it carries the same per-account
      // lockout as POST /login. Without it the lockout there is decorative: an
      // attacker frozen out after three wrong PINs simply posts the next guess
      // to this endpoint instead and keeps going, because the counter lives per
      // account and nothing here was incrementing it. Same lockKey, so the
      // three attempts are shared across both routes rather than three each.
      const lockKey = LoginLockout.lockKey(country, mobile_number);
      const lockedFor = await LoginLockout.getLockRemainingSeconds(lockKey);
      if (lockedFor > 0) {
        const minutes = Math.ceil(lockedFor / 60);
        res.set('Retry-After', String(lockedFor));
        return res.status(429).json({
          remark: 'account_locked',
          status: 'error',
          message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
          data: { retry_after_seconds: lockedFor },
        });
      }

      let user = null;
      try {
        user = await withDirectFallback(p => p.user.findFirst({
          where: {
            country_code: String(country),
            ...buildMobileWhereForCountry({ mobile_number, country }),
          },
        }));
      } catch (dbError) {
        console.error('❌ Database query error (authentication):', dbError);
        return res.status(500).json({
          remark: 'database_error',
          status: 'error',
          message: ['Database connection error. Please try again later.'],
          data: null
        });
      }

      if (!user) {
        return res.status(401).json({
          remark: 'invalid_pin',
          status: 'error',
          message: ['Incorrect phone number or PIN. Please check your credentials and try again.'],
          data: null
        });
      }
      // Blocked users cannot login
      if (!isActive(user)) {
        return sendInactive(res, user);
      }
      const pinCheck = await verifySecret(pin, user.pin, 'pin');
      if (pinCheck.needsRehash) await upgradeSecret(user.id, 'pin', pin);
      const valid = pinCheck.ok;
      if (!valid) {
        const failure = await LoginLockout.registerFailure(lockKey);
        if (failure.locked) {
          const minutes = Math.ceil(failure.remainingSeconds / 60);
          res.set('Retry-After', String(failure.remainingSeconds));
          return res.status(429).json({
            remark: 'account_locked',
            status: 'error',
            message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
            data: { retry_after_seconds: failure.remainingSeconds },
          });
        }
        return res.status(401).json({
          remark: 'invalid_pin',
          status: 'error',
          message: ['Incorrect phone number or PIN. Please check your credentials and try again.'],
          data: null
        });
      }

      // Only a correct PIN clears the counter, matching POST /login.
      await LoginLockout.clearFailures(lockKey);

      let sessionId;
      try {
        sessionId = await rotateUserSession(user.id, effectiveDeviceId);
      } catch (e) {
        console.error('❌ Failed to persist active session during authentication:', e);
        return res.status(500).json({
          remark: 'database_error',
          status: 'error',
          message: ['Failed to create login session'],
          data: null
        });
      }

      const accessToken = signAccessToken(user.id, sessionId);
      if (!accessToken) {
        return res.status(500).json({
          remark: 'config_error',
          status: 'error',
          message: ['JWT_SECRET not configured'],
          data: null
        });
      }
      await recordDailyLogin(user.id);
      const countryDetails = getCountryByCode(user.country_code);
      const pii = revealUserFields(user);
      return res.json({
        remark: 'login_success',
        status: 'success',
        message: ['Login successful'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: user.id,
            firstname: pii.firstname,
            lastname: pii.lastname,
            username: pii.username,
            email: pii.email,
            mobile: pii.mobile,
            country_code: user.country_code,
            country_name: countryDetails.name,
            country_flag: countryDetails.image_src,
            dial_code: countryDetails.dial_code,
            balance: user.balance,
            currency_symbol: user.currency_symbol,
            profile_complete: user.profile_complete,
            status: user.status,
            ev: user.ev,
            sv: user.sv,
            tv: user.tv,
            kv: user.kv,
            image: user.image,
            created_at: user.created_at,
            updated_at: user.updated_at
          }
        }
      });
    }

    const phoneNumber = `+${country}${mobile_number}`;
    return res.json({
      remark: 'phone_verification_ready',
      status: 'success',
      message: ['Phone number verified. Proceed with OTP verification.'],
      data: {
        mobile_number,
        country,
        phone_number: phoneNumber,
        verification_method: 'firebase_phone_auth'
      }
    });
  } catch (error) {
    console.error('Error in authentication (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process phone verification'],
      data: null
    });
  }
}

function getAuthorization(req, res) {
  const response = {
    remark: 'authorization_info',
    status: 'success',
    message: ['Authorization endpoint ready'],
    data: {
      methods: ['POST'],
      required_fields: ['mobile_number', 'country', 'otp'],
      optional_fields: ['firebase_token'],
      description: 'Use POST method to verify OTP and complete authentication'
    }
  };
  return res.json(response);
}

async function postAuthorization(req, res) {
  try {
    const { mobile_number, country, otp, firebase_token, device_id } = req.body;
    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    if (!mobile_number || !country || !otp) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, and OTP are required'],
        data: null
      });
    }

    // The OTP is checked by Firebase on the handset; this endpoint's whole job
    // is to validate that proof and turn it into a session. Two things it must
    // never do, both of which it did:
    //
    //  - **Proceed with no firebase_token.** The old `else` branch logged the
    //    OTP and carried straight on to signing an access token, so anyone who
    //    knew a phone number could POST it here with any six digits and get
    //    back that account's session, decrypted PII and balance - no password,
    //    no PIN, no lockout, no rate limit. A "development fallback" on an
    //    unauthenticated route mounted in server.js is an account takeover, and
    //    nothing gated it on NODE_ENV.
    //  - **Trust the body's mobile_number once a token verifies.** The token
    //    proves control of the number *inside the token*; it says nothing about
    //    the number in the body. Unbound, any valid Firebase token - including
    //    one minted for the attacker's own phone - could be replayed against
    //    somebody else's number to take their account.
    //
    // The escape hatch stays for local work but has to be asked for explicitly
    // and refuses to exist in production.
    const allowMockOtp =
      process.env.ALLOW_MOCK_OTP === 'true' && process.env.NODE_ENV !== 'production';

    const rejectVerification = () => res.status(401).json({
      remark: 'verification_failed',
      status: 'error',
      message: ['Invalid OTP or Firebase token'],
      data: null,
    });

    if (!firebase_token && !allowMockOtp) {
      console.warn('⚠️ /authorization called without a firebase_token');
      return rejectVerification();
    }

    try {
      if (firebase_token) {
        const decodedToken = await admin.auth().verifyIdToken(firebase_token);
        // Bind the proof to the claim. Canonical on both sides: Firebase hands
        // back E.164 (+234803...), the app sends 0803... - the same account.
        const claimed = canonicalMobile(country, mobile_number);
        const proven = canonicalMobile(country, decodedToken.phone_number);
        if (!claimed || !proven || claimed !== proven) {
          console.warn('⚠️ /authorization token does not match the claimed number', { uid: decodedToken.uid });
          return rejectVerification();
        }
        console.log('✅ Firebase token verified for user:', decodedToken.uid);
      } else {
        console.warn(`⚠️ ALLOW_MOCK_OTP is on - OTP ${otp ? 'not verified' : 'absent'}. Never enable this outside local development.`);
      }

      const secret = getJwtSecret();
      if (!secret) {
        return res.status(500).json({
          remark: 'config_error',
          status: 'error',
          message: ['JWT_SECRET not configured'],
          data: null
        });
      }

      // Ensure user exists (OTP can be used pre-PIN in some flows)
      let user = await withDirectFallback(p => p.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      }));
      if (!user) {
        user = await withDirectFallback(p => p.user.create({
          data: {
            ...protectUserFields({
              firstname: '',
              lastname: '',
              username: null,
              email: null,
              mobile: String(mobile_number),
            }),
            country_code: String(country),
            balance: '0.00',
            currency_symbol: '₦',
            profile_complete: '0',
            status: 1,
            ev: '1',
            sv: '1',
            tv: '1',
            kv: '0',
            image: null,
            pin: null,
          },
        }));
      }

      let sessionId;
      try {
        sessionId = await rotateUserSession(user.id, effectiveDeviceId);
      } catch (e) {
        console.error('❌ Failed to persist active session during authorization:', e);
        return res.status(500).json({
          remark: 'database_error',
          status: 'error',
          message: ['Failed to create login session'],
          data: null
        });
      }

      const accessToken = signAccessToken(user.id, sessionId);
      await recordDailyLogin(user.id);
      const countryDetails = getCountryByCode(user.country_code);

      const pii = revealUserFields(user);
      return res.json({
        remark: 'login_success',
        status: 'success',
        message: ['Login successful'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: user.id,
            firstname: pii.firstname,
            lastname: pii.lastname,
            username: pii.username,
            email: pii.email,
            mobile: pii.mobile,
            country_code: user.country_code,
            country_name: countryDetails.name,
            country_flag: countryDetails.image_src,
            dial_code: countryDetails.dial_code,
            balance: user.balance,
            currency_symbol: user.currency_symbol || '₦',
            profile_complete: user.profile_complete,
            status: user.status,
            ev: user.ev,
            sv: user.sv,
            tv: user.tv,
            kv: user.kv,
            image: user.image,
            created_at: user.created_at,
            updated_at: user.updated_at
          }
        }
      });
    } catch (firebaseError) {
      console.error('Firebase verification error:', firebaseError);
      return res.status(401).json({
        remark: 'verification_failed',
        status: 'error',
        message: ['Invalid OTP or Firebase token'],
        data: null
      });
    }
  } catch (error) {
    console.error('Error in authorization (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to verify OTP'],
      data: null
    });
  }
}

/**
 * Shared lookup for the two new-device endpoints: resolve the account from
 * phone + country + password. Returns either { user } or { response } that the
 * caller must return as-is, so both endpoints answer identically for a wrong
 * phone and a wrong password.
 */
async function resolveUserForDeviceFlow({ mobile_number, country, password }, { allowDeactivated = false } = {}) {
  if (!mobile_number || !country || !password) {
    return {
      response: {
        code: 400,
        body: {
          remark: 'validation_error',
          status: 'error',
          message: ['Mobile number, country and password are required'],
          data: null,
        },
      },
    };
  }

  // Same 3-strike lock as /login. Both new-device endpoints route through here,
  // so the lock cannot be sidestepped by guessing passwords against them.
  const lockKey = LoginLockout.lockKey(country, mobile_number);
  const lockedFor = await LoginLockout.getLockRemainingSeconds(lockKey);
  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60);
    return {
      response: {
        code: 429,
        body: {
          remark: 'account_locked',
          status: 'error',
          message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
          data: { retry_after_seconds: lockedFor },
        },
      },
    };
  }

  const user = await withDirectFallback(p => p.user.findFirst({
    where: {
      country_code: String(country),
      ...buildMobileWhereForCountry({ mobile_number, country }),
    },
  }));

  const invalidCredentials = {
    response: {
      code: 401,
      body: {
        remark: 'invalid_credentials',
        status: 'error',
        message: ['Incorrect phone number or password. Please check your credentials and try again.'],
        data: null,
      },
    },
  };

  if (!user) return invalidCredentials;

  // Password first, status second: answering "deactivated" before the password
  // is checked would turn this endpoint into a lookup for whether a given phone
  // number holds an account.
  if (!user.password) return invalidCredentials;
  const check = await verifySecret(password, user.password, 'password');
  if (!check.ok) {
    await LoginLockout.registerFailure(lockKey);
    return invalidCredentials;
  }

  await LoginLockout.clearFailures(lockKey);

  // The reactivation endpoints pass allowDeactivated - they exist precisely to
  // serve an account this gate would otherwise turn away.
  if (!isActive(user) && !(allowDeactivated && Number(user.status) === DEACTIVATED)) {
    return { response: inactiveResponse(user) };
  }

  return { user };
}

/**
 * POST /login/device-otp
 *
 * Resend the new-device email code. Same credential check as login, so it
 * cannot be used to spray verification mail at an address you do not control.
 */
async function requestDeviceOtp(req, res) {
  try {
    const { mobile_number, country, password } = req.body || {};
    const resolved = await resolveUserForDeviceFlow({ mobile_number, country, password });
    if (resolved.response) {
      return res.status(resolved.response.code).json(resolved.response.body);
    }

    const delivery = await sendDeviceVerificationCode(resolved.user);
    if (!delivery.sent) {
      return res.status(200).json({
        remark: 'email_send_failed',
        status: 'error',
        message: ['Unable to send the verification code. Please try again later.'],
        data: null,
      });
    }

    return res.json({
      remark: 'device_otp_sent',
      status: 'success',
      message: ['Verification code sent to your email'],
      data: { email_masked: maskEmail(delivery.email) },
    });
  } catch (e) {
    console.error('requestDeviceOtp error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to send verification code'],
      data: null,
    });
  }
}

/**
 * POST /login/recovery
 *
 * The only way onto a new device or the web app. Three factors, all required:
 * the password, the emailed code, and the 12-word recovery phrase. On success
 * the session is rotated, which is what signs the previous device out - every
 * request carries the session id and userAuth rejects a token whose sid no
 * longer matches the row.
 */
async function loginWithRecoveryPhrase(req, res) {
  try {
    const { mobile_number, country, password, code, recovery_phrase, device_id } = req.body || {};
    const effectiveDeviceId = device_id || req.headers['x-device-id'];

    if (!code || !recovery_phrase) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Verification code and recovery phrase are required'],
        data: null,
      });
    }

    const resolved = await resolveUserForDeviceFlow({ mobile_number, country, password });
    if (resolved.response) {
      return res.status(resolved.response.code).json(resolved.response.body);
    }
    const user = resolved.user;

    if (!user.recovery_hash) {
      return res.status(200).json({
        remark: 'no_recovery_phrase',
        status: 'error',
        message: ['This account has no recovery phrase. Please contact support.'],
        data: null,
      });
    }

    const pii = revealUserFields(user);
    const email = String(pii.email || '').trim();
    const normalizedCode = String(code).trim().padStart(6, '0');
    const tokenRow = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedCode, 'device');
    if (!tokenRow || Number(tokenRow.user_id) !== Number(user.id)) {
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    // Cheap structural check first (word count + BIP39 checksum) so a typo does
    // not reach the scrypt comparison.
    if (!isValidRecoveryPhrase(recovery_phrase)) {
      return res.status(200).json({
        remark: 'invalid_recovery_phrase',
        status: 'error',
        message: ['That recovery phrase is not valid. Check the spelling and word order.'],
        data: null,
      });
    }

    const phraseCheck = await verifyRecoveryPhrase(recovery_phrase, user.recovery_hash);
    if (!phraseCheck.ok) {
      return res.status(200).json({
        remark: 'invalid_recovery_phrase',
        status: 'error',
        message: ['That recovery phrase does not match this account.'],
        data: null,
      });
    }

    // Burn the code only once every factor has passed.
    await PasswordResetModel.markUsed(tokenRow.id);

    // The account is moving to this device, so any biometric credential held by
    // the old one dies with the session it was bound to.
    await revokeBiometric(user.id);

    let sessionId;
    try {
      sessionId = await rotateUserSession(user.id, effectiveDeviceId);
    } catch (e) {
      console.error('❌ Failed to persist active session during recovery login:', e);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to create login session'],
        data: null,
      });
    }

    const accessToken = signAccessToken(user.id, sessionId);
    if (!accessToken) {
      return res.status(500).json({
        remark: 'config_error',
        status: 'error',
        message: ['JWT_SECRET not configured'],
        data: null,
      });
    }

    await recordDailyLogin(user.id);
    console.log('✅ Recovery-phrase login completed', { userId: user.id });

    return res.json({
      remark: 'login_success',
      status: 'success',
      message: ['Login successful. You have been signed out on your other device.'],
      data: {
        ...buildLoginData(user, accessToken, false),
        signed_out_other_devices: true,
      },
    });
  } catch (e) {
    console.error('loginWithRecoveryPhrase error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process login'],
      data: null,
    });
  }
}

/**
 * Enrols this device for biometric login. Reached only with a live session, and
 * the client only calls it after the user has re-entered their password on the
 * Security screen - so the token is issued to someone who has just proved both
 * possession of the session and knowledge of the password.
 */
async function registerBiometric(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const deviceId = String(req.body?.device_id || req.headers['x-device-id'] || '').trim();
    if (!deviceId) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Device id is required'],
        data: null,
      });
    }

    // Only the device holding the session may enrol. Without this, a stolen
    // access token could mint a credential for a handset the user never used.
    const boundDevice = String(req.user.active_device_id || '').trim();
    if (boundDevice && boundDevice !== deviceId) {
      return res.status(403).json({
        remark: 'device_mismatch',
        status: 'error',
        message: ['Biometric login can only be set up on the device you are signed in on'],
        data: null,
      });
    }

    const token = await issueBiometricToken(userId, deviceId);
    console.log('✅ Biometric credential issued', { userId });

    return res.json({
      remark: 'biometric_registered',
      status: 'success',
      message: ['Biometric login enabled'],
      data: { biometric_token: token },
    });
  } catch (e) {
    console.error('registerBiometric error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to enable biometric login'],
      data: null,
    });
  }
}

async function revokeBiometricCredential(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    await revokeBiometric(userId);
    return res.json({
      remark: 'biometric_revoked',
      status: 'success',
      message: ['Biometric login disabled'],
      data: null,
    });
  } catch (e) {
    console.error('revokeBiometricCredential error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to disable biometric login'],
      data: null,
    });
  }
}

/**
 * Login with the device-bound token instead of the password.
 *
 * The scan happens on the phone - `local_auth` never talks to this endpoint.
 * What arrives here is proof the device holds a credential this account issued
 * to it, which is why the token is checked against the same lockout, the same
 * block flag and the same session rotation as a password login.
 */
async function loginWithBiometric(req, res) {
  try {
    const { mobile_number, country, biometric_token, device_id } = req.body || {};
    const effectiveDeviceId = String(device_id || req.headers['x-device-id'] || '').trim();

    if (!mobile_number || !country || !biometric_token || !effectiveDeviceId) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, device id and biometric token are required'],
        data: null,
      });
    }

    // A biometric login must not walk around a lockout earned by wrong
    // passwords - same freeze, same key.
    const lockKey = LoginLockout.lockKey(country, mobile_number);
    const lockedFor = await LoginLockout.getLockRemainingSeconds(lockKey);
    if (lockedFor > 0) {
      const minutes = Math.ceil(lockedFor / 60);
      res.set('Retry-After', String(lockedFor));
      return res.status(429).json({
        remark: 'account_locked',
        status: 'error',
        message: [`Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`],
        data: { retry_after_seconds: lockedFor },
      });
    }

    const user = await withDirectFallback(p => p.user.findFirst({
      where: {
        country_code: String(country),
        ...buildMobileWhereForCountry({ mobile_number, country }),
      },
    }));

    // Same wording for "no such account" and "bad token": the response must not
    // say which of the two it was.
    const rejection = {
      remark: 'biometric_rejected',
      status: 'error',
      message: ['Biometric login is no longer available on this device. Please sign in with your password.'],
      data: null,
    };

    if (!user) return res.status(401).json(rejection);

    if (!isActive(user)) {
      return sendInactive(res, user);
    }

    const tokenOk = await verifyBiometricToken(user, biometric_token, effectiveDeviceId);
    // The account has since signed in somewhere else, so this handset is no
    // longer the active device - the credential is stale whatever the token says.
    const stillActiveDevice = !user.active_device_id || String(user.active_device_id).trim() === effectiveDeviceId;

    if (!tokenOk || !stillActiveDevice) {
      await revokeBiometric(user.id);
      return res.status(401).json(rejection);
    }

    let sessionId;
    try {
      sessionId = await rotateUserSession(user.id, effectiveDeviceId);
    } catch (e) {
      console.error('❌ Failed to persist active session during biometric login:', e);
      return res.status(500).json({
        remark: 'session_error',
        status: 'error',
        message: ['Failed to create login session'],
        data: null,
      });
    }

    const accessToken = signAccessToken(user.id, sessionId);
    if (!accessToken) {
      return res.status(500).json({
        remark: 'config_error',
        status: 'error',
        message: ['JWT_SECRET not configured'],
        data: null,
      });
    }

    await recordDailyLogin(user.id);
    console.log('✅ Biometric login completed', { userId: user.id });

    return res.json({
      remark: 'login_success',
      status: 'success',
      message: ['Login successful'],
      data: buildLoginData(user, accessToken, false),
    });
  } catch (e) {
    console.error('loginWithBiometric error:', e);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process login'],
      data: null,
    });
  }
}

module.exports = {
  login,
  register,
  authentication,
  getAuthorization,
  postAuthorization,
  requestDeviceOtp,
  loginWithRecoveryPhrase,
  registerBiometric,
  revokeBiometricCredential,
  loginWithBiometric,
  // Shared with account.controller: reactivation re-uses the same phone +
  // password resolution and the same emailed code as the new-device login.
  resolveUserForDeviceFlow,
  sendDeviceVerificationCode,
  maskEmail,
};
