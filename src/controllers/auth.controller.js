const prisma = require('../../database/prisma');
const admin = require('firebase-admin');
const { getCountryByCode } = require('../helpers/country.helper');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

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

function dateKey(d = new Date()) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function recordDailyLogin(userId) {
  try {
    const key = `daily_login_users:${dateKey()}`;
    const existing = await prisma.appSetting.findUnique({ where: { setting_key: key } });
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
        await prisma.appSetting.update({ where: { setting_key: key }, data: { setting_value: value } });
      } else {
        await prisma.appSetting.create({ data: { setting_key: key, setting_value: value, description: 'Unique user IDs that logged in on this date' } });
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

    console.log('📥 Login request (controller):', req.body);

    if (!mobile_number || !country || (!password && !pin)) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, and password are required'],
        data: null
      });
    }

    let user = null;
    try {
      user = await prisma.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      });
      if (user) {
        console.log(`✅ User found in database: ${user.firstname} ${user.lastname}`);
      } else {
        console.log('❌ User not found in database');
      }
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
    if (Number(user.status) !== 1) {
      return res.status(403).json({
        remark: 'blocked',
        status: 'error',
        message: ['Your account is blocked. Please contact support.'],
        data: null
      });
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
      const validPassword = await bcrypt.compare(String(password), String(user.password));
      if (!validPassword) {
        return res.status(401).json({
          remark: 'invalid_password',
          status: 'error',
          message: ['Incorrect phone number or password. Please check your credentials and try again.'],
          data: null
        });
      }
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

      const storedPin = String(user.pin || '');
      const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
      const validPin = storedPin
        ? (looksHashed ? await bcrypt.compare(String(pin), storedPin) : storedPin === String(pin))
        : false;
      if (!validPin) {
        return res.status(401).json({
          remark: 'invalid_pin',
          status: 'error',
          message: ['Incorrect phone number or PIN. Please check your credentials and try again.'],
          data: null
        });
      }

      try {
        await prisma.user.update({
          where: { id: Number(user.id) },
          data: { pin_login_used: true },
        });
        user.pin_login_used = true;
      } catch (e) {
        console.warn('⚠️ Failed to mark pin_login_used:', e?.message || e);
      }
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

    const countryDetails = getCountryByCode(user.country_code);
    const needsSetPassword = !hasPassword;
    return res.json({
      remark: needsSetPassword ? 'set_password_required' : 'login_success',
      status: 'success',
      message: [needsSetPassword ? 'Please set a password to continue' : 'Login successful'],
      data: {
        access_token: accessToken,
        token_type: 'Bearer',
        next_step: needsSetPassword ? 'set_password' : null,
        force_set_password: needsSetPassword ? true : false,
        user: {
          id: user.id,
          firstname: user.firstname,
          lastname: user.lastname,
          username: user.username,
          email: user.email,
          mobile: user.mobile,
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
          pn: user.pin ? '1' : '0',
          image: user.image,
          created_at: user.created_at,
          updated_at: user.updated_at
        }
      }
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
    console.log('📥 Registration request (controller):', req.body);

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
      const existingUser = await prisma.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      });

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
          return res.json({
            remark: 'profile_incomplete',
            status: 'success',
            message: ['Please complete your profile setup'],
            data: {
              access_token: accessToken,
              token_type: 'Bearer',
              user: {
                id: existingUser.id,
                firstname: existingUser.firstname,
                lastname: existingUser.lastname,
                username: existingUser.username,
                email: existingUser.email,
                mobile: existingUser.mobile,
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
                pn: existingUser.pin ? '1' : '0',
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
      const newUser = await prisma.user.create({
        data: {
          firstname: wantsPasswordRegistration ? String(firstname) : '',
          lastname: wantsPasswordRegistration ? String(lastname) : '',
          username: null,
          email: wantsPasswordRegistration ? cleanedEmail : null,
          mobile: String(mobile_number),
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
          password: wantsPasswordRegistration ? await bcrypt.hash(String(password), 10) : null,
        },
      });

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
        return res.json({
          remark: 'registration_success',
          status: 'success',
          message: ['Registration successful'],
          data: {
            access_token: accessToken,
            token_type: 'Bearer',
            user: {
              id: newUser.id,
              firstname: newUser.firstname,
              lastname: newUser.lastname,
              username: newUser.username,
              email: newUser.email,
              mobile: newUser.mobile,
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
              pn: newUser.pin ? '1' : '0',
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
      return res.json({
        remark: 'registration_started',
        status: 'success',
        message: ['Registration started. Please complete your profile.'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: newUser.id,
            firstname: newUser.firstname,
            lastname: newUser.lastname,
            username: newUser.username,
            email: newUser.email,
            mobile: newUser.mobile,
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
            pn: newUser.pin ? '1' : '0',
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
    console.log('📥 Authentication request (controller):', req.body);

    if (!mobile_number || !country) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number and country are required'],
        data: null
      });
    }

      if (pin) {
      // Maintain compatibility: handle login here when PIN is provided
      let user = null;
      try {
        user = await prisma.user.findFirst({
          where: {
            country_code: String(country),
            ...buildMobileWhereForCountry({ mobile_number, country }),
          },
        });
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
      if (Number(user.status) !== 1) {
        return res.status(403).json({
          remark: 'blocked',
          status: 'error',
          message: ['Your account is blocked. Please contact support.'],
          data: null
        });
      }
      const storedPin = String(user.pin || '');
      const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
      const valid = storedPin
        ? (looksHashed ? await bcrypt.compare(String(pin), storedPin) : storedPin === String(pin))
        : false;
      if (!valid) {
        return res.status(401).json({
          remark: 'invalid_pin',
          status: 'error',
          message: ['Incorrect phone number or PIN. Please check your credentials and try again.'],
          data: null
        });
      }

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
      return res.json({
        remark: 'login_success',
        status: 'success',
        message: ['Login successful'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: user.id,
            firstname: user.firstname,
            lastname: user.lastname,
            username: user.username,
            email: user.email,
            mobile: user.mobile,
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
    console.log('📥 Authorization request (controller):', req.body);

    if (!mobile_number || !country || !otp) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, and OTP are required'],
        data: null
      });
    }

    try {
      if (firebase_token) {
        const decodedToken = await admin.auth().verifyIdToken(firebase_token);
        console.log('✅ Firebase token verified for user:', decodedToken.uid);
      } else {
        // Development fallback
        console.log(`📱 Mock OTP verification for ${country}${mobile_number}: ${otp}`);
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
      let user = await prisma.user.findFirst({
        where: {
          country_code: String(country),
          ...buildMobileWhereForCountry({ mobile_number, country }),
        },
      });
      if (!user) {
        user = await prisma.user.create({
          data: {
            firstname: '',
            lastname: '',
            username: null,
            email: null,
            mobile: String(mobile_number),
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
        });
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

      return res.json({
        remark: 'login_success',
        status: 'success',
        message: ['Login successful'],
        data: {
          access_token: accessToken,
          token_type: 'Bearer',
          user: {
            id: user.id,
            firstname: user.firstname,
            lastname: user.lastname,
            username: user.username,
            email: user.email,
            mobile: user.mobile,
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

module.exports = { login, register, authentication, getAuthorization, postAuthorization };
