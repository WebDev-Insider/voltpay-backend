const prisma = require('../../database/prisma');
const { uploadFile, deleteFileByUrl } = require('../helpers/upload.helper');
const { getCountryByCode } = require('../helpers/country.helper');
const { hashSecret, verifySecret, blindIndex, protectUserFields, revealUserFields, publicUser, pinFlag } = require('../helpers/pii.helper');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { invalidateUser } = require('../services/userCache.service');
const { revokeBiometric } = require('../helpers/biometric.helper');

function signAccessToken(userId, sessionId) {
  const secret = process.env.JWT_SECRET;
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
  // The new session id has to be visible to userAuth on the very next request.
  await invalidateUser(userId);
  return sid;
}

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

function validatePasswordComplexity(password) {
  const p = String(password || '');
  if (p.length < 8 || p.length > 16) return 'Password must be between 8 and 16 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must include at least one number';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least one symbol';
  return '';
}

async function userExist(req, res) {
  try {
    const currentUser = req.user;
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
          ...(lookup.username ? [{ username_idx: blindIndex(lookup.username, 'username') }] : []),
          ...mobileVariants.map(m => ({ mobile_idx: blindIndex(m, 'mobile') })),
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
    const foundPii = revealUserFields(found);

    return res.json({
      remark: 'user_exist',
      status: 'success',
      message: ['User found'],
      data: {
        action_id: '',
        next_step: null,
        user: {
          id: found.id,
          firstname: foundPii.firstname,
          lastname: foundPii.lastname,
          username: foundPii.username,
          email: foundPii.email,
          mobile: foundPii.mobile,
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
    const currentUser = req.user;
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
          ...publicUser(currentUser),
          country_name: countryDetails.name,
          country_flag: countryDetails.image_src,
          dial_code: countryDetails.dial_code,
          // `req.user` has been through userCache.service, which nulls `pin`.
          // See pinFlag: reading `.pin` here is what made every PIN gate in the
          // app demand "set a PIN in Security" for accounts that had one.
          pn: pinFlag(currentUser)
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
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    // firstname / lastname are deliberately not read from the body. The legal
    // name is what KYC and every CBN report is filed against, so it is fixed at
    // registration and only support can change it.
    const { email, username, address, state, city, zip } = req.body;
    console.log('📥 Image file:', req.file ? 'Present' : 'Not provided');

    const currentUserId = Number(currentUser.id);
    const cleanedEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedUsername = typeof username === 'string' ? username.trim() : '';

    let profileImageUrl = null;
    if (req.file) {
      try {
        const uploaded = await uploadFile(req.file, { prefix: 'profile' });
        profileImageUrl = uploaded.url;
        console.log('📸 Profile image uploaded for user', currentUserId);
        // The old picture is now unreachable - do not keep paying to store it.
        await deleteFileByUrl(currentUser.image);
      } catch (uploadError) {
        console.error('Error uploading profile image:', uploadError);
      }
    }

    try {
      if (cleanedEmail) {
        const emailUser = await prisma.user.findFirst({
          where: {
            email_idx: blindIndex(cleanedEmail, 'email'),
            id: { not: currentUserId },
          },
          select: { id: true },
        });
        if (emailUser) {
          return res.status(409).json({
            remark: 'email_exists',
            status: 'error',
            message: ['An account with this email address already exists. Please use a different email or try logging in.'],
            data: null
          });
        }
      }

      if (cleanedUsername) {
        const usernameUser = await prisma.user.findFirst({
          where: {
            username_idx: blindIndex(cleanedUsername, 'username'),
            id: { not: currentUserId },
          },
          select: { id: true },
        });
        if (usernameUser) {
          return res.status(409).json({
            remark: 'username_exists',
            status: 'error',
            message: ['This username is already taken. Please choose a different username.'],
            data: null
          });
        }
      }

      const updated = await prisma.user.update({
        where: { id: currentUserId },
        data: {
          // protectUserFields only touches keys that are present, so an absent
          // field stays untouched rather than being blanked.
          ...protectUserFields(Object.fromEntries(Object.entries({
            username: cleanedUsername, email: cleanedEmail,
            address, state, city, zip,
          }).filter(([, v]) => v !== undefined && v !== null && String(v) !== ''))),
          image: profileImageUrl ?? undefined,
        },
      });
      await invalidateUser(currentUserId);
      const countryDetails = getCountryByCode(updated.country_code);
      return res.json({
        remark: 'profile_updated',
        status: 'success',
        message: ['Profile updated successfully'],
        data: {
          user: {
            ...publicUser(updated),
            country_name: countryDetails.name,
            country_flag: countryDetails.image_src,
            dial_code: countryDetails.dial_code,
            pn: pinFlag(updated)
          }
        }
      });
    } catch (dbError) {
      console.error('❌ Error updating profile in database:', dbError);

      if (dbError && dbError.code === 'P2002') {
        const target = Array.isArray(dbError.meta?.target) ? dbError.meta.target.join(',') : (dbError.meta?.target || '').toString();
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

async function userDataSubmit(req, res) {
  try {
    const {
      firstname,
      lastname,
      email,
      pin,
      country_code,
      mobile_number,
      password,
      password_confirmation,
    } = req.body;
    const effectiveDeviceId = req.body?.device_id || req.headers['x-device-id'];
    console.log('📥 Image file:', req.file ? 'Present' : 'Not provided');

    const cleanedEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedUsername = typeof req.body.username === 'string' ? req.body.username.trim() : '';

    const wantsPasswordSetup = !!(password || password_confirmation);
    if (!firstname || !lastname || (!wantsPasswordSetup && !pin)) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: [wantsPasswordSetup ? 'First name, last name, and password are required' : 'First name, last name, and PIN are required'],
        data: null
      });
    }

    if (wantsPasswordSetup) {
      if (!password || !password_confirmation) {
        return res.status(400).json({
          remark: 'validation_error',
          status: 'error',
          message: ['Password and confirmation are required'],
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

    let profileImageUrl = null;
    if (req.file) {
      try {
        const uploaded = await uploadFile(req.file, { prefix: 'profile' });
        profileImageUrl = uploaded.url;
        console.log('📸 Profile image uploaded (submit)');
      } catch (uploadError) {
        console.error('Error uploading profile image (submit):', uploadError);
      }
    }

    let user = null;
    try {
      const existingUser = await prisma.user.findFirst({
        where: { mobile_idx: blindIndex(mobile_number, 'mobile'), country_code: String(country_code) },
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

      if (cleanedEmail) {
        const emailUser = await prisma.user.findFirst({
          where: {
            email_idx: blindIndex(cleanedEmail, 'email'),
            ...(user ? { id: { not: Number(user.id) } } : {}),
          },
          select: { id: true },
        });
        if (emailUser) {
          return res.status(409).json({
            remark: 'email_exists',
            status: 'error',
            message: ['An account with this email address already exists. Please use a different email or try logging in.'],
            data: null
          });
        }
      }

      if (cleanedUsername) {
        const usernameUser = await prisma.user.findFirst({
          where: {
            username_idx: blindIndex(cleanedUsername, 'username'),
            ...(user ? { id: { not: Number(user.id) } } : {}),
          },
          select: { id: true },
        });
        if (usernameUser) {
          return res.status(409).json({
            remark: 'username_exists',
            status: 'error',
            message: ['This username is already taken. Please choose a different username.'],
            data: null
          });
        }
      }

      if (user) {
        const existingPii = revealUserFields(user);
        const updateData = {
          ...protectUserFields({
            firstname,
            lastname,
            username: cleanedUsername || existingPii.username,
            email: cleanedEmail || existingPii.email,
            address: req.body.address || existingPii.address,
            state: req.body.state || existingPii.state,
            city: req.body.city || existingPii.city,
            zip: req.body.zip || existingPii.zip,
          }),
          profile_complete: '1',
          ev: '1',
          sv: '1',
          kv: '1',
          image: profileImageUrl || user.image,
        };

        if (pin) {
          updateData.pin = await hashSecret(String(pin), 'pin');
        }

        if (wantsPasswordSetup) {
          updateData.password = await hashSecret(String(password), 'password');
        }

        user = await prisma.user.update({
          where: { id: Number(user.id) },
          data: {
            ...updateData,
          },
        });
        await invalidateUser(user.id);
        console.log(`✅ User profile updated in database: id=${user.id}`);
      } else {
        console.log('👤 Creating new user');
        const hashedPin = pin ? await hashSecret(String(pin), 'pin') : null;
        const hashedPassword = wantsPasswordSetup ? await hashSecret(String(password), 'password') : null;
        user = await prisma.user.create({
          data: {
            ...protectUserFields({
              firstname,
              lastname,
              username: cleanedUsername || '',
              email: cleanedEmail || '',
              mobile: String(mobile_number || ''),
              address: req.body.address || '',
              state: req.body.state || '',
              city: req.body.city || '',
              zip: req.body.zip || '',
            }),
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
            ...(hashedPin ? { pin: hashedPin } : {}),
            ...(hashedPassword ? { password: hashedPassword } : {}),
          },
        });
        console.log(`✅ User saved to database: id=${user.id}`);
      }
    } catch (dbError) {
      console.error('❌ Error with database operation (submit):', dbError);

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
        message: ['Database error occurred. Please try again later.'],
        data: null
      });
    }

    let sessionId;
    try {
      sessionId = await rotateUserSession(user.id, effectiveDeviceId);
    } catch (e) {
      console.error('❌ Failed to persist active session during user data submit:', e);
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
    const userPii = revealUserFields(user);
    return res.json({
      remark: 'profile_complete',
      status: 'success',
      message: ['Profile completed successfully'],
      data: {
        access_token: accessToken,
        token_type: 'Bearer',
        user: {
          id: user.id,
          firstname: userPii.firstname,
          lastname: userPii.lastname,
          username: userPii.username,
          email: userPii.email,
          mobile: userPii.mobile,
          country_code: user.country_code,
          balance: user.balance,
          currency_symbol: user.currency_symbol,
          profile_complete: user.profile_complete,
          status: user.status,
          ev: user.ev,
          sv: user.sv,
          tv: user.tv,
          kv: user.kv,
          pn: pinFlag(user),
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
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const body = req.body || {};
    const wantsPasswordChange = !!(
      body.password ||
      body.password_confirmation ||
      body.new_password ||
      body.confirm_password ||
      body.current_password
    );

    if (wantsPasswordChange) {
      const current_password = body.current_password;
      const password = body.password ?? body.new_password;
      const password_confirmation = body.password_confirmation ?? body.confirm_password;

      console.log('📥 Change password request (controller):', { current_password: !!current_password, password: !!password, password_confirmation: !!password_confirmation });

      if (!password || !password_confirmation) {
        return res.status(200).json({
          remark: 'validation_error',
          status: 'error',
          message: ['New password and confirmation are required'],
          data: null
        });
      }

      if (String(password) !== String(password_confirmation)) {
        return res.status(200).json({
          remark: 'password_mismatch',
          status: 'error',
          message: ["Password and confirmation password don't match"],
          data: null
        });
      }

      const pwdErr = validatePasswordComplexity(password);
      if (pwdErr) {
        return res.status(200).json({
          remark: 'weak_password',
          status: 'error',
          message: [pwdErr],
          data: null
        });
      }

      try {
        const dbUser = await prisma.user.findUnique({ where: { id: Number(currentUser.id) }, select: { id: true, password: true } });
        if (!dbUser) {
          return res.status(404).json({
            remark: 'user_not_found',
            status: 'error',
            message: ['User not found'],
            data: null
          });
        }

        const hasPassword = !!(dbUser.password && String(dbUser.password).trim());
        if (hasPassword) {
          if (!current_password) {
            return res.status(200).json({
              remark: 'validation_error',
              status: 'error',
              message: ['Current password is required'],
              data: null
            });
          }
          const storedPassword = String(dbUser.password || '');
          const valid = (await verifySecret(String(current_password), storedPassword, 'password')).ok;
          if (!valid) {
            return res.status(200).json({
              remark: 'invalid_current_password',
              status: 'error',
              message: ['Current password is incorrect'],
              data: null
            });
          }
          if (String(current_password) === String(password)) {
            return res.status(200).json({
              remark: 'password_same_as_current',
              status: 'error',
              message: ['New password must be different from current password'],
              data: null
            });
          }
        }

        const updated = await prisma.user.update({
          where: { id: Number(currentUser.id) },
          data: { password: await hashSecret(String(password), 'password') },
        });
        // The biometric token was issued against the old password. Drop it so
        // the phone has to re-enrol with the new one.
        await revokeBiometric(currentUser.id);
        await invalidateUser(currentUser.id);

        return res.json({
          remark: 'password_changed',
          status: 'success',
          message: ['Password changed successfully'],
          data: { user: publicUser(updated) }
        });
      } catch (err) {
        console.error('❌ Error changing password:', err);
        return res.status(500).json({
          remark: 'database_error',
          status: 'error',
          message: ['Failed to change password. Please try again later.'],
          data: null
        });
      }
    }

    const { current_pin, pin, pin_confirmation } = body;
    console.log('📥 Change PIN request (controller):', { current_pin: !!current_pin, pin: !!pin, pin_confirmation: !!pin_confirmation });

    if (!pin || !pin_confirmation) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['New PIN and confirmation are required'],
        data: null
      });
    }

    const normalizedPin = String(pin).trim();
    const normalizedPinConfirmation = String(pin_confirmation).trim();
    const PIN_DIGITS = 6;

    if (!/^\d+$/.test(normalizedPin) || normalizedPin.length !== PIN_DIGITS) {
      return res.status(200).json({
        remark: 'invalid_pin_format',
        status: 'error',
        message: [`PIN must be exactly ${PIN_DIGITS} digits`],
        data: null
      });
    }

    if (normalizedPin !== normalizedPinConfirmation) {
      return res.status(200).json({
        remark: 'pin_mismatch',
        status: 'error',
        message: ["PIN and confirmation PIN don't match"],
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
      const hasExistingPin = storedPin.trim().length > 0;

      if (hasExistingPin) {
        if (!current_pin) {
          return res.status(200).json({
            remark: 'validation_error',
            status: 'error',
            message: ['Current PIN is required'],
            data: null
          });
        }

        if (String(current_pin).trim() === normalizedPin) {
          return res.status(200).json({
            remark: 'pin_same_as_current',
            status: 'error',
            message: ['New PIN must be different from current PIN'],
            data: null
          });
        }

        const valid = (await verifySecret(String(current_pin), storedPin, 'pin')).ok;
        if (!valid) {
          return res.status(200).json({
            remark: 'invalid_current_pin',
            status: 'error',
            message: ['Current PIN is incorrect'],
            data: null
          });
        }
      }

      const updated = await prisma.user.update({
        where: { id: Number(currentUser.id) },
        data: { pin: await hashSecret(normalizedPin, 'pin') },
      });
      await invalidateUser(currentUser.id);

      return res.json({
        remark: hasExistingPin ? 'pin_changed' : 'pin_set',
        status: 'success',
        message: [hasExistingPin ? 'Pin change successfully' : 'Pin set successfully'],
        data: { user: publicUser(updated) }
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

module.exports = { userInfo, profileSetting, userExist, userDataSubmit, changePassword };
