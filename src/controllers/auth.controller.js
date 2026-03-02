const prisma = require('../../database/prisma');
const admin = require('firebase-admin');
const { getCountryByCode } = require('../helpers/country.helper');
const session = require('../services/session.service');
const bcrypt = require('bcryptjs');

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
    const { mobile_number, country, pin } = req.body;

    console.log('📥 Login request (controller):', req.body);

    if (!mobile_number || !country || !pin) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number, country, and PIN are required'],
        data: null
      });
    }

    let user = null;
    try {
      user = await prisma.user.findFirst({
        where: { mobile: String(mobile_number), country_code: String(country) },
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

    // Support hashed and legacy plain-text PINs
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

    const accessToken = `token_${user.id}_${Date.now()}`;
    session.setCurrentUser(user);
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
    const { mobile_number, country } = req.body;
    console.log('📥 Registration request (controller):', req.body);

    if (!mobile_number || !country) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Mobile number and country are required'],
        data: null
      });
    }

    try {
      const existingUser = await prisma.user.findFirst({
        where: { mobile: String(mobile_number), country_code: String(country) },
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
          return res.json({
            remark: 'profile_incomplete',
            status: 'success',
            message: ['Please complete your profile setup'],
            data: {
              user: {
                id: existingUser.id,
                mobile: existingUser.mobile,
                country_code: existingUser.country_code,
                profile_complete: existingUser.profile_complete
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
          firstname: '',
          lastname: '',
          username: '',
          email: '',
          mobile: String(mobile_number),
          country_code: String(country),
          balance: '0.00',
          currency_symbol: '₦',
          profile_complete: '0',
          status: 1,
          ev: '0',
          sv: '0',
          tv: '1',
          kv: '0',
          image: null,
          pin: null,
        },
      });
      return res.json({
        remark: 'registration_started',
        status: 'success',
        message: ['Registration started. Please complete your profile.'],
        data: {
          user: {
            id: newUser.id,
            mobile: newUser.mobile,
            country_code: newUser.country_code,
            profile_complete: newUser.profile_complete,
            sv: newUser.sv,
            ev: newUser.ev,
            kv: newUser.kv
          }
        }
      });
    } catch (dbError) {
      console.error('❌ Error creating user in database:', dbError);
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
    const { mobile_number, country, pin } = req.body;
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
          where: { mobile: String(mobile_number), country_code: String(country) },
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

      const accessToken = `token_${user.id}_${Date.now()}`;
      session.setCurrentUser(user);
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
    const { mobile_number, country, otp, firebase_token } = req.body;
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
        const phoneNumber = `+${country}${mobile_number}`;
        return res.json({
          remark: 'login_success',
          status: 'success',
          message: ['Login successful'],
          data: {
            user: { uid: decodedToken.uid, phone_number: phoneNumber, mobile_number, country, verified: true },
            access_token: firebase_token,
            token_type: 'Bearer'
          }
        });
      } else {
        // Development fallback
        console.log(`📱 Mock OTP verification for ${country}${mobile_number}: ${otp}`);
        return res.json({
          remark: 'login_success',
          status: 'success',
          message: ['Login successful'],
          data: {
            user: { uid: `mock_${mobile_number}`, phone_number: `+${country}${mobile_number}`, mobile_number, country, verified: true },
            access_token: 'mock_token_' + Date.now(),
            token_type: 'Bearer'
          }
        });
      }
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
