const prisma = require('../../database/prisma');
const cloudinary = require('cloudinary').v2;
const { getCountryByCode } = require('../helpers/country.helper');
const session = require('../services/session.service');
const bcrypt = require('bcryptjs');

function normalizeLookupUserInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { username: '', mobile: '' };
  const digits = raw.replace(/\D/g, '');
  const looksNumeric = digits.length > 0 && digits.length >= Math.min(raw.length, digits.length);
  if (looksNumeric) {
    const last10 = digits.length > 10 ? digits.slice(-10) : digits;
    const variants = Array.from(
      new Set([
        digits,
        last10,
        last10.length === 10 ? `0${last10}` : '',
      ].filter(Boolean))
    );
    return { username: '', mobile: variants.join(',') };
  }
  return { username: raw, mobile: '' };
}

async function userExist(req, res) {
  try {
    const currentUser = req.user || session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    const input = String(req.body?.user || '').trim();
    if (!input) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['user is required'], data: null });
    }

    const lookup = normalizeLookupUserInput(input);
    const mobileVariants = lookup.mobile
      ? lookup.mobile.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const found = await prisma.user.findFirst({
      where: {
        OR: [
          ...(lookup.username ? [{ username: lookup.username }] : []),
          ...(mobileVariants.length ? mobileVariants.map(m => ({ mobile: m })) : []),
        ],
      },
    });

    if (!found) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null });
    }

    if (Number(found.id) === Number(currentUser.id)) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['You cannot perform this action on yourself'], data: null });
    }

    const countryDetails = getCountryByCode(found.country_code);

    return res.json({
      remark: 'user_exist',
      status: 'success',
      message: ['User found'],
      data: {
        action_id: '',
        next_step: null,
        user: {
          id: found.id,
          firstname: found.firstname,
          lastname: found.lastname,
          username: found.username,
          email: found.email,
          mobile: found.mobile,
          dial_code: countryDetails.dial_code,
          country_code: found.country_code,
          country_name: countryDetails.name,
          country_flag: countryDetails.image_src,
          balance: found.balance,
          status: String(found.status),
          image: found.image,
          image_src: found.image,
        },
      },
    });
  } catch (error) {
    console.error('Error in userExist (controller):', error);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to verify user'], data: null });
  }
}

async function userInfo(req, res) {
  try {
    console.log('📥 User info request (controller)');
    const currentUser = session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const countryDetails = getCountryByCode(currentUser.country_code);
    return res.json({
      remark: 'user_info',
      status: 'success',
      message: ['User information fetched successfully'],
      data: {
        user: {
          ...currentUser,
          country_name: countryDetails.name,
          country_flag: countryDetails.image_src,
          dial_code: countryDetails.dial_code
        }
      }
    });
  } catch (error) {
    console.error('Error fetching user info (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch user information'],
      data: null
    });
  }
}

async function profileSetting(req, res) {
  try {
    const currentUser = session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const { firstname, lastname, email, username, address, state, city, zip } = req.body;
    console.log('📥 Profile setting request (controller):', req.body);
    console.log('📥 Image file:', req.file ? 'Present' : 'Not provided');

    let profileImageUrl = null;
    if (req.file) {
      try {
        const uploadResult = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            {
              resource_type: 'image',
              folder: 'ovopay/profiles',
              transformation: [
                { width: 400, height: 400, crop: 'fill' },
                { quality: 'auto' }
              ]
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          ).end(req.file.buffer);
        });
        profileImageUrl = uploadResult.secure_url;
        console.log('📸 Profile image uploaded:', profileImageUrl);
      } catch (uploadError) {
        console.error('Error uploading profile image:', uploadError);
      }
    }

    try {
      const updated = await prisma.user.update({
        where: { id: Number(currentUser.id) },
        data: {
          firstname: firstname ?? undefined,
          lastname: lastname ?? undefined,
          username: username ?? undefined,
          email: email ?? undefined,
          address: address ?? undefined,
          state: state ?? undefined,
          city: city ?? undefined,
          zip: zip ?? undefined,
          image: profileImageUrl ?? undefined,
        },
      });
      session.setCurrentUser(updated);
      const countryDetails = getCountryByCode(updated.country_code);
      return res.json({
        remark: 'profile_updated',
        status: 'success',
        message: ['Profile updated successfully'],
        data: {
          user: {
            ...updated,
            country_name: countryDetails.name,
            country_flag: countryDetails.image_src,
            dial_code: countryDetails.dial_code
          }
        }
      });
    } catch (dbError) {
      console.error('❌ Error updating profile in database:', dbError);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to update profile. Please try again later.'],
        data: null
      });
    }
  } catch (error) {
    console.error('Error updating profile (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to update profile'],
      data: null
    });
  }
}

module.exports = { userInfo, profileSetting };

async function userDataSubmit(req, res) {
  try {
    const { firstname, lastname, email, pin, country_code, mobile_number } = req.body;
    console.log('📥 User data submit request (controller):', req.body);
    console.log('📥 Image file:', req.file ? 'Present' : 'Not provided');

    if (!firstname || !lastname || !pin) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['First name, last name, and PIN are required'],
        data: null
      });
    }

    let profileImageUrl = null;
    if (req.file) {
      try {
        const uploadResult = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            {
              resource_type: 'image',
              folder: 'ovopay/profiles',
              transformation: [
                { width: 400, height: 400, crop: 'fill' },
                { quality: 'auto' }
              ]
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          ).end(req.file.buffer);
        });
        profileImageUrl = uploadResult.secure_url;
        console.log('📸 Profile image uploaded (submit):', profileImageUrl);
      } catch (uploadError) {
        console.error('Error uploading profile image (submit):', uploadError);
      }
    }

    let user = null;
    try {
      const existingUser = await prisma.user.findFirst({
        where: { mobile: String(mobile_number), country_code: String(country_code) },
      });

      if (existingUser) {
        if (existingUser.profile_complete === '1') {
          return res.status(409).json({
            remark: 'user_exists',
            status: 'error',
            message: ['An account with this phone number already exists. Please use a different phone number or try logging in.'],
            data: null
          });
        }
        user = existingUser;
      }

      if (email) {
        const emailUser = await prisma.user.findFirst({ where: { email: String(email) } });
        if (emailUser) {
          return res.status(409).json({
            remark: 'email_exists',
            status: 'error',
            message: ['An account with this email address already exists. Please use a different email or try logging in.'],
            data: null
          });
        }
      }

      if (user) {
        const hashedPin = await bcrypt.hash(String(pin), 10);
        user = await prisma.user.update({
          where: { id: Number(user.id) },
          data: {
            firstname,
            lastname,
            username: req.body.username || user.username,
            email: email || user.email,
            pin: hashedPin,
            profile_complete: '1',
            ev: '1',
            sv: '1',
            kv: '1',
            image: profileImageUrl || user.image,
            address: req.body.address || user.address,
            state: req.body.state || user.state,
            city: req.body.city || user.city,
            zip: req.body.zip || user.zip,
          },
        });
        console.log(`✅ User profile updated in database: ${user.firstname} ${user.lastname}`);
      } else {
        console.log(`👤 Creating new user with mobile: ${mobile_number}`);
        const hashedPin = await bcrypt.hash(String(pin), 10);
        user = await prisma.user.create({
          data: {
            firstname,
            lastname,
            username: req.body.username || '',
            email: email || null,
            mobile: String(mobile_number || ''),
            country_code: String(country_code || ''),
            balance: '0',
            currency_symbol: '₦',
            profile_complete: '1',
            status: 1,
            ev: '1',
            sv: '1',
            tv: '1',
            kv: '1',
            image: profileImageUrl || 'sample.jpg',
            address: req.body.address || '',
            state: req.body.state || '',
            city: req.body.city || '',
            zip: req.body.zip || '',
            pin: hashedPin,
          },
        });
        console.log(`✅ User saved to database: ${user.firstname} ${user.lastname}`);
      }
    } catch (dbError) {
      console.error('❌ Error with database operation (submit):', dbError);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Database error occurred. Please try again later.'],
        data: null
      });
    }

    session.setCurrentUser(user);
    return res.json({
      remark: 'profile_complete',
      status: 'success',
      message: ['Profile completed successfully'],
      data: {
        access_token: `token_${user.id}_${Date.now()}`,
        token_type: 'Bearer',
        user: {
          id: user.id,
          firstname: user.firstname,
          lastname: user.lastname,
          username: user.username,
          email: user.email,
          mobile: user.mobile,
          country_code: user.country_code,
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
  } catch (error) {
    console.error('Error in user data submit (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to complete profile'],
      data: null
    });
  }
}

async function changePassword(req, res) {
  try {
    const currentUser = session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const { current_pin, pin, pin_confirmation } = req.body || {};
    console.log('📥 Change PIN request (controller):', { current_pin: !!current_pin, pin: !!pin, pin_confirmation: !!pin_confirmation });

    if (!current_pin || !pin || !pin_confirmation) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Current PIN, new PIN, and confirmation are required'],
        data: null
      });
    }

    if (String(pin) !== String(pin_confirmation)) {
      return res.status(200).json({
        remark: 'pin_mismatch',
        status: 'error',
        message: ["PIN and confirmation PIN don't match"],
        data: null
      });
    }

    // Optional: Disallow same PIN as current
    if (String(current_pin) === String(pin)) {
      return res.status(200).json({
        remark: 'pin_same_as_current',
        status: 'error',
        message: ['New PIN must be different from current PIN'],
        data: null
      });
    }

    try {
      const dbUser = await prisma.user.findUnique({ where: { id: Number(currentUser.id) }, select: { id: true, pin: true } });
      if (!dbUser) {
        return res.status(404).json({
          remark: 'user_not_found',
          status: 'error',
          message: ['User not found'],
          data: null
        });
      }

      const storedPin = String(dbUser.pin || '');
      const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
      const valid = looksHashed ? (await bcrypt.compare(String(current_pin), storedPin)) : storedPin === String(current_pin);
      if (!valid) {
        return res.status(200).json({
          remark: 'invalid_current_pin',
          status: 'error',
          message: ['Current PIN is incorrect'],
          data: null
        });
      }

      const updated = await prisma.user.update({
        where: { id: Number(currentUser.id) },
        data: { pin: await bcrypt.hash(String(pin), 10) },
      });

      // Refresh session user
      session.setCurrentUser(updated);

      return res.json({
        remark: 'pin_changed',
        status: 'success',
        message: ['Pin change successfully'],
        data: { user: updated }
      });
    } catch (err) {
      console.error('❌ Error changing PIN:', err);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to change PIN. Please try again later.'],
        data: null
      });
    }
  } catch (error) {
    console.error('Error in change PIN (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process request'],
      data: null
    });
  }
}

async function deleteAccount(req, res) {
  try {
    const currentUser = session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const { pin } = req.body || {};
    if (!pin) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['PIN is required to delete account'],
        data: null
      });
    }

    try {
      const dbUser = await prisma.user.findUnique({ where: { id: Number(currentUser.id) }, select: { id: true, pin: true } });
      if (!dbUser) {
        return res.status(404).json({
          remark: 'user_not_found',
          status: 'error',
          message: ['User not found'],
          data: null
        });
      }

      const storedPin = String(dbUser.pin || '');
      const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
      const valid = looksHashed ? (await bcrypt.compare(String(pin), storedPin)) : storedPin === String(pin);
      if (!valid) {
        return res.status(200).json({
          remark: 'invalid_pin',
          status: 'error',
          message: ['PIN is incorrect'],
          data: null
        });
      }

      // Hard delete the user account
      await prisma.user.delete({ where: { id: Number(currentUser.id) } });

      // Clear session
      session.setCurrentUser(null);

      return res.json({
        remark: 'account_deleted',
        status: 'success',
        message: ['Your account has been deleted successfully'],
        data: null
      });
    } catch (err) {
      console.error('❌ Error deleting account:', err);
      return res.status(500).json({
        remark: 'database_error',
        status: 'error',
        message: ['Failed to delete account. Please try again later.'],
        data: null
      });
    }
  } catch (error) {
    console.error('Error in delete account (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to process request'],
      data: null
    });
  }
}

module.exports = { userInfo, profileSetting, userExist, userDataSubmit, changePassword, deleteAccount };
