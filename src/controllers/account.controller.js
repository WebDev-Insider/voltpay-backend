// Account lifecycle: deactivate (reversible), reactivate (email code + recovery
// phrase), delete (irreversible, wipes every row this user owns).
//
// Deactivate and delete both sit behind userAuth. Reactivate cannot - a
// deactivated user has no session, by design - so it re-proves the password on
// every call and carries its own rate limit, exactly like the new-device login.
const prisma = require('../../database/prisma');
const {
  verifySecret,
  revealUserFields,
  protectText,
  revealText,
  revealLedgerText,
  encryptValue,
  publicUser,
} = require('../helpers/pii.helper');
const { publicCompany, publicStaff } = require('../helpers/staffpayPii.helper');
const { sendAccountClosureEmail } = require('../services/email.service');
const { deleteFileByUrl } = require('../helpers/upload.helper');
const { invalidateUser } = require('../services/userCache.service');
const { revokeBiometric } = require('../helpers/biometric.helper');
const { deactivateDedicatedAccount } = require('../funding/paystack.service');
const { ACTIVE, DEACTIVATED, DELETED, isDeactivated } = require('../helpers/accountStatus.helper');
const {
  resolveUserForDeviceFlow,
  sendDeviceVerificationCode,
  maskEmail,
} = require('./auth.controller');
const PasswordResetModel = require('../models/passwordReset.model');
const { isValidRecoveryPhrase, verifyRecoveryPhrase } = require('../helpers/recovery.helper');
const { logSystemAction } = require('../services/audit.service');
const { captureError } = require('../services/alerts.service');

// A wallet with money in it must not be closed: deletion destroys the ledger it
// would be reconciled from, so there would be no way to pay the balance back.
const MIN_CLOSEABLE_BALANCE = 0.01;

// Cooling period between "delete my account" and the data actually going. A
// phone taken off a table for two minutes should not cost someone their
// financial history permanently; reactivating within the window undoes it.
function deletionGraceDays() {
  // `Number('')` is 0, and 0 here means "wipe it immediately" - the exact
  // behaviour this window exists to remove. Catch the unset case first.
  const raw = String(process.env.ACCOUNT_DELETION_GRACE_DAYS ?? '').trim();
  if (!raw) return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function deletionDueAt(from = new Date()) {
  const due = new Date(from);
  due.setUTCDate(due.getUTCDate() + deletionGraceDays());
  return due;
}

function serverError(res, label, error) {
  console.error(`${label}:`, error);
  return res.status(500).json({
    remark: 'error',
    status: 'error',
    message: ['Failed to process request'],
    data: null,
  });
}

// Password check shared by deactivate and delete. Both are destructive and both
// are reached from a live session, so the session alone is not enough.
async function requirePassword(userId, password) {
  const row = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, password: true },
  });
  if (!row) return { error: { code: 404, remark: 'user_not_found', message: 'User not found' } };

  const stored = String(row.password || '');
  if (!stored.trim()) {
    return { error: { code: 200, remark: 'password_required', message: 'Set a password before closing this account' } };
  }

  const check = await verifySecret(String(password), stored, 'password');
  if (!check.ok) {
    return { error: { code: 200, remark: 'invalid_password', message: 'Password is incorrect' } };
  }
  return { ok: true };
}

// Payroll statuses that still owe somebody money. `queued` and `preparing` have
// not paid out yet, `processing` has transfers in flight at the provider - all
// three can still debit the float or land a webhook, and none of them may be
// left behind an account nobody can sign in to.
const LIVE_PAYROLL_STATUSES = ['queued', 'preparing', 'processing'];

/**
 * StaffPay preconditions for closing an account, in one place because the
 * request endpoint and the purge worker have to agree: what blocks the ask must
 * also block the wipe, or money arriving during the grace period gets stranded.
 *
 * Returns null when clear, otherwise { remark, message } ready to answer with.
 */
async function staffPayBlocker(userId) {
  const id = Number(userId);

  const float = await prisma.staffPayWallet.findFirst({
    where: { balance: { gte: MIN_CLOSEABLE_BALANCE }, company: { owner_user_id: id } },
    select: { id: true },
  });
  if (float) {
    return {
      remark: 'staffpay_balance_not_empty',
      message: 'Empty your StaffPay wallet before deleting your account.',
    };
  }

  const liveRun = await prisma.staffPayPayrollRun.findFirst({
    where: { status: { in: LIVE_PAYROLL_STATUSES }, company: { owner_user_id: id } },
    select: { id: true },
  });
  if (liveRun) {
    return {
      remark: 'staffpay_payroll_pending',
      message: 'You still have a payroll run in progress. Wait for it to finish before deleting your account.',
    };
  }

  return null;
}

function passwordErrorResponse(res, error) {
  return res.status(error.code).json({
    remark: error.remark,
    status: 'error',
    message: [error.message],
    data: null,
  });
}

/**
 * GET /account/export
 *
 * The NDPA 2023 gives a data subject the right to a copy of what is held about
 * them, in a form they can take elsewhere. That is a separate right from
 * erasure, but it belongs next to it: the app offers this before it offers the
 * delete button, because after the grace period there is nothing left to hand
 * over and the user cannot sign in to ask.
 *
 * One JSON document, decrypted, rather than the CSV /transactions/export
 * produces - that one is a statement of the ledger, this is everything.
 * Deliberately capped per section: an export is not a reason to page a million
 * rows into memory, and nobody's account is near the cap.
 */
const EXPORT_ROW_LIMIT = 5000;

async function exportAccountData(req, res) {
  try {
    const id = Number(req.user.id);

    const [user, wallet, funding, requestsSent, requestsReceived, tickets, companies] = await Promise.all([
      prisma.user.findUnique({ where: { id } }),
      prisma.walletTransaction.findMany({ where: { user_id: id }, orderBy: { created_at: 'desc' }, take: EXPORT_ROW_LIMIT }),
      prisma.fundingTransaction.findMany({ where: { user_id: id }, orderBy: { created_at: 'desc' }, take: EXPORT_ROW_LIMIT }),
      prisma.moneyRequest.findMany({ where: { sender_id: id }, orderBy: { created_at: 'desc' }, take: EXPORT_ROW_LIMIT }),
      prisma.moneyRequest.findMany({ where: { receiver_id: id }, orderBy: { created_at: 'desc' }, take: EXPORT_ROW_LIMIT }),
      prisma.supportTicket.findMany({
        where: { user_id: id },
        orderBy: { created_at: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { ticket: true, subject: true, status: true, priority: true, created_at: true, resolved_at: true },
      }),
      prisma.staffPayCompany
        ? prisma.staffPayCompany.findMany({ where: { owner_user_id: id }, include: { staff: true } })
        : [],
    ]);

    if (!user) {
      return res.status(404).json({ remark: 'user_not_found', status: 'error', message: ['User not found'], data: null });
    }

    // Free text in the ledger and in a money request names the counterparty, so
    // it is ciphertext at rest and has to be turned back into words here - an
    // export of "b3v1:..." is not a copy of anyone's data.
    const money_request = row => ({
      ...row,
      note: row.note ? revealText(row.note) : null,
      decline_reason: row.decline_reason ? revealText(row.decline_reason) : null,
    });

    return res.json({
      remark: 'account_export',
      status: 'success',
      message: ['Your data export is ready'],
      data: {
        generated_at: new Date().toISOString(),
        profile: publicUser(user),
        wallet_transactions: wallet.map(row => ({ ...row, ...revealLedgerText(row) })),
        funding_transactions: funding.map(({ raw_payload, ...row }) => row),
        money_requests_sent: requestsSent.map(money_request),
        money_requests_received: requestsReceived.map(money_request),
        support_tickets: tickets,
        staffpay: (companies || []).map(company => ({
          ...publicCompany(company),
          staff: (company.staff || []).map(publicStaff),
        })),
        // Says plainly what an export cannot include and why, so it is not read
        // as the whole file when a five-year retention is still running.
        retention_note: `Records required by Nigerian law (MLPPA 2022 s.19, CBN AML/CFT Regulations) are retained for ${retentionYears()} years after an account closes and are not removed by a deletion request.`,
      },
    });
  } catch (error) {
    return serverError(res, 'Error in account/export (controller)', error);
  }
}

/**
 * POST /account/deactivate
 *
 * Reversible. The row and the money stay exactly as they are; only the status
 * flips and every credential that could open a session without the password is
 * torn down, so "deactivated" also means "signed out everywhere".
 */
async function deactivateAccount(req, res) {
  try {
    const currentUser = req.user;
    const { password } = req.body || {};
    if (!password) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Password is required to deactivate your account'],
        data: null,
      });
    }

    const auth = await requirePassword(currentUser.id, password);
    if (auth.error) return passwordErrorResponse(res, auth.error);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: Number(currentUser.id) },
        data: {
          status: DEACTIVATED,
          // Kills the current session and unbinds the device: userAuth rejects
          // a token whose sid no longer matches the row.
          active_session_id: null,
          active_device_id: null,
        },
      }),
      // Payroll must not keep moving money out of an account nobody is signed
      // in to. Left off after reactivation - the owner turns it back on.
      prisma.staffPayCompany.updateMany({
        where: { owner_user_id: Number(currentUser.id) },
        data: { auto_pay_enabled: false },
      }),
    ]);

    await revokeBiometric(currentUser.id);
    await invalidateUser(currentUser.id);
    console.log('🔕 Account deactivated', { userId: currentUser.id });

    return res.json({
      remark: 'account_deactivated',
      status: 'success',
      message: ['Your account has been deactivated. You can reactivate it anytime.'],
      data: null,
    });
  } catch (error) {
    return serverError(res, 'Error in account/deactivate (controller)', error);
  }
}

/**
 * POST /account/reactivate/request
 *
 * Public. Phone + country + password resolve the account exactly as the
 * new-device login does, then a 6-digit code goes to the address on file.
 */
async function requestReactivation(req, res) {
  try {
    const { mobile_number, country, password } = req.body || {};
    const resolved = await resolveUserForDeviceFlow(
      { mobile_number, country, password },
      { allowDeactivated: true },
    );
    if (resolved.response) {
      return res.status(resolved.response.code).json(resolved.response.body);
    }

    const user = resolved.user;
    if (!isDeactivated(user)) {
      return res.status(200).json({
        remark: 'account_already_active',
        status: 'error',
        message: ['This account is already active. Please sign in.'],
        data: null,
      });
    }

    const delivery = await sendDeviceVerificationCode(user, 'reactivate');
    if (!delivery.sent) {
      return res.status(500).json({
        remark: 'email_send_failed',
        status: 'error',
        message: ['Unable to send the verification code. Please try again later.'],
        data: null,
      });
    }

    return res.json({
      remark: 'reactivation_code_sent',
      status: 'success',
      message: ['Verification code sent to your email'],
      data: {
        email_masked: maskEmail(delivery.email),
        // Present only for an account waiting to be purged, so the app can warn
        // that finishing this flow is also what cancels the deletion.
        deletion_scheduled_at: user.deletion_scheduled_at ? new Date(user.deletion_scheduled_at).toISOString() : null,
      },
    });
  } catch (error) {
    return serverError(res, 'Error in account/reactivate/request (controller)', error);
  }
}

/**
 * POST /account/reactivate/confirm
 *
 * Password + emailed code + recovery phrase, the same three factors as a
 * new-device login. No session is issued here: the user signs in normally
 * afterwards, so reactivation cannot be used as a login side door.
 */
async function confirmReactivation(req, res) {
  try {
    const { mobile_number, country, password, code, recovery_phrase } = req.body || {};

    if (!code) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Verification code is required'],
        data: null,
      });
    }

    const resolved = await resolveUserForDeviceFlow(
      { mobile_number, country, password },
      { allowDeactivated: true },
    );
    if (resolved.response) {
      return res.status(resolved.response.code).json(resolved.response.body);
    }

    const user = resolved.user;
    if (!isDeactivated(user)) {
      return res.status(200).json({
        remark: 'account_already_active',
        status: 'error',
        message: ['This account is already active. Please sign in.'],
        data: null,
      });
    }

    const email = String(revealUserFields(user).email || '').trim();
    const normalizedCode = String(code).trim().padStart(6, '0');
    const tokenRow = await PasswordResetModel.findLatestByEmailAndToken(email, normalizedCode, 'reactivate');
    if (!tokenRow || Number(tokenRow.user_id) !== Number(user.id)) {
      return res.status(200).json({
        remark: 'invalid_or_expired_code',
        status: 'error',
        message: ['Invalid or expired verification code'],
        data: null,
      });
    }

    // Accounts predating the recovery phrase have nothing to check against;
    // password + emailed code is what they registered with, and demanding a
    // phrase they were never given would lock them out for good.
    if (user.recovery_hash) {
      if (!recovery_phrase) {
        return res.status(400).json({
          remark: 'validation_error',
          status: 'error',
          message: ['Your recovery phrase is required'],
          data: null,
        });
      }
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
    }

    // Burn the code only once every factor has passed.
    await PasswordResetModel.markUsed(tokenRow.id);

    // Reactivation is the cancel button for a scheduled deletion: same three
    // factors, and there is no other way back into a deactivated account.
    const wasScheduledForDeletion = Boolean(user.deletion_scheduled_at);
    await prisma.user.update({
      where: { id: Number(user.id) },
      data: {
        status: ACTIVE,
        deletion_requested_at: null,
        deletion_scheduled_at: null,
        deletion_reason: null,
      },
    });
    await invalidateUser(user.id);
    if (wasScheduledForDeletion) {
      await logSystemAction('account.deletion_cancelled', { user_id: Number(user.id) });
    }
    console.log('🔔 Account reactivated', { userId: user.id, cancelled_deletion: wasScheduledForDeletion });

    return res.json({
      remark: 'account_reactivated',
      status: 'success',
      message: [
        wasScheduledForDeletion
          ? 'Your account is active again and the scheduled deletion has been cancelled. Please sign in.'
          : 'Your account is active again. Please sign in.',
      ],
      data: { deletion_cancelled: wasScheduledForDeletion },
    });
  } catch (error) {
    return serverError(res, 'Error in account/reactivate/confirm (controller)', error);
  }
}

/**
 * POST /delete-account
 *
 * Scheduled, not immediate. The account is deactivated the moment it is asked
 * for - session gone, biometrics revoked, payroll stopped - and the row is
 * anonymised by purgeDueDeletions() once the grace period expires. Reactivating
 * inside the window cancels it, which is why deletion reuses the deactivate
 * teardown rather than a state of its own.
 *
 * Anonymise, not delete, and in two stages - because Nigerian law pulls in both
 * directions at once. The NDPA 2023 gives the right to erasure, but it yields
 * where another law requires the data to be kept, and two of them do:
 * s.19 of the Money Laundering (Prevention and Prohibition) Act 2022 and the
 * CBN AML/CFT Regulations require the customer identification record and the
 * transaction records to be preserved for at least five years after the
 * relationship ends. Erasing a customer's identity thirty days after they close
 * their account is not privacy compliance, it is destroying the records an NFIU
 * or EFCC request, a court order or a chargeback would be answered from - and
 * every one of those rows is anchored to users.id, so dropping the row would
 * take the financial record with it.
 *
 * Stage one, when the grace period expires - the account stops existing as far
 * as anyone can reach it:
 *
 *   erased  - PIN, password, recovery phrase, sessions, biometric enrolment,
 *             FCM token, profile image, the plain (pre-encryption) name/contact
 *             columns and every blind index, plus the tables that exist only to
 *             reach the person: password_resets, verification_codes,
 *             push_notifications, and monthly_statements (derived from the
 *             ledger, and its snapshot carries counterparty text).
 *   kept    - wallet_transactions, funding_transactions, money_requests,
 *             user_activity, support tickets and the StaffPay records. The
 *             counterparty text in those is already ciphertext, and half of it
 *             belongs to the other party to the transaction, not to this user.
 *
 * Nulling email_idx / mobile_idx / username_idx is what makes the state final:
 * every login path resolves an account through a blind index, so with those
 * gone there is nothing left to log in with, no way to search the account up by
 * its contact details, and the freed values can be registered again by whoever
 * holds that phone number next.
 *
 * Stage two, five years after closure (purgeExpiredIdentities) - the retention
 * duty has run out, so the identification record itself goes: the *_enc
 * ciphertext on the user row, and the StaffPay company, staff and KYB documents
 * hanging off it. The ledger still stays; by then it names nobody.
 */

// The identity columns, the one place both stages read their field list from -
// two hand-maintained lists would drift, and the one that drifts is the one
// that leaves a name behind.
const RETAINED_PII_FIELDS = ['firstname', 'lastname', 'username', 'email', 'mobile', 'address', 'state', 'city', 'zip'];

// Stage one. fcm_token_enc is in here rather than with the identity columns: it
// is a device push token, useless as a record and live until revoked.
const CREDENTIAL_FIELDS = {
  ...Object.fromEntries(RETAINED_PII_FIELDS.map(f => [f, null])),
  username_idx: null,
  email_idx: null,
  mobile_idx: null,
  image: null,
  pin: null,
  password: null,
  recovery_hash: null,
  recovery_set_at: null,
  active_session_id: null,
  active_device_id: null,
  biometric_hash: null,
  biometric_device_id: null,
  biometric_set_at: null,
  fcm_token_enc: null,
  fcm_device_id: null,
  fcm_platform: null,
  fcm_token_updated_at: null,
  deletion_reason: null,
};

// Stage two.
const IDENTITY_FIELDS = Object.fromEntries(RETAINED_PII_FIELDS.map(f => [`${f}_enc`, null]));

// Statutory minimum is five years from the end of the relationship, so the env
// var can only lengthen it. A shorter one would be a compliance failure that
// cannot be undone once the columns are gone.
function retentionYears() {
  const n = Number(String(process.env.KYC_RETENTION_YEARS ?? '').trim());
  return Number.isFinite(n) && n > 5 ? Math.floor(n) : 5;
}

/** Accounts closed on or before this instant have served their retention. */
function retentionCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retentionYears());
  return cutoff;
}

/**
 * A row that predates the encryption migration keeps its identity in the plain
 * columns only. Move it into the ciphertext columns before stage one nulls
 * those, or stage one destroys the very record stage two exists to preserve.
 * No blind index is written - the account must stay unfindable by contact
 * details, and this record is reached by user id.
 */
function preserveLegacyIdentity(row) {
  const data = {};
  if (!row) return data;
  for (const field of RETAINED_PII_FIELDS) {
    const plain = String(row[field] ?? '').trim();
    if (plain && !row[`${field}_enc`]) data[`${field}_enc`] = encryptValue(plain);
  }
  return data;
}

const IDENTITY_SELECT = Object.fromEntries(
  RETAINED_PII_FIELDS.flatMap(f => [[f, true], [`${f}_enc`, true]]),
);

async function anonymizeUserData(userId, { now = new Date() } = {}) {
  const id = Number(userId);
  const row = await prisma.user.findUnique({ where: { id }, select: IDENTITY_SELECT });
  return prisma.$transaction([
    prisma.pushNotification.deleteMany({ where: { user_id: id } }),
    prisma.monthlyStatement.deleteMany({ where: { user_id: id } }),
    prisma.passwordReset.deleteMany({ where: { user_id: id } }),
    prisma.verificationCode.deleteMany({ where: { user_id: id } }),
    // Standing orders hold *other people's* numbers and nicknames, and a
    // closed account can never buy one again. Their run rows cascade; the money
    // they moved stays in wallet_transactions with the rest of the ledger.
    ...(prisma.scheduledTopup ? [prisma.scheduledTopup.deleteMany({ where: { user_id: id } })] : []),
    prisma.user.update({
      where: { id },
      data: {
        ...preserveLegacyIdentity(row),
        ...CREDENTIAL_FIELDS,
        status: DELETED,
        deleted_at: now,
        // Cleared so the worker cannot pick the same row up twice.
        deletion_scheduled_at: null,
      },
    }),
  ]);
}

async function deleteAccount(req, res) {
  try {
    const currentUser = req.user;
    const { password, reason } = req.body || {};
    if (!password) {
      return res.status(200).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Password is required to delete account'],
        data: null,
      });
    }

    const auth = await requirePassword(currentUser.id, password);
    if (auth.error) return passwordErrorResponse(res, auth.error);

    const dbUser = await prisma.user.findUnique({
      where: { id: Number(currentUser.id) },
      select: { id: true, image: true, balance: true, email: true, email_enc: true },
    });
    if (!dbUser) {
      return res.status(404).json({
        remark: 'user_not_found',
        status: 'error',
        message: ['User not found'],
        data: null,
      });
    }

    if (Number(dbUser.balance) >= MIN_CLOSEABLE_BALANCE) {
      return res.status(200).json({
        remark: 'balance_not_empty',
        status: 'error',
        message: ['Withdraw or spend your remaining wallet balance before deleting your account.'],
        data: null,
      });
    }

    // Same rule for the payroll float, plus any run still owing a staff member.
    const staffPay = await staffPayBlocker(currentUser.id);
    if (staffPay) {
      return res.status(200).json({
        remark: staffPay.remark,
        status: 'error',
        message: [staffPay.message],
        data: null,
      });
    }

    const requestedAt = new Date();
    const scheduledFor = deletionDueAt(requestedAt);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: Number(dbUser.id) },
        data: {
          status: DEACTIVATED,
          deletion_requested_at: requestedAt,
          deletion_scheduled_at: scheduledFor,
          // Their own words, so protected like any other free text they typed.
          deletion_reason: reason ? protectText(String(reason).slice(0, 500)) : null,
          active_session_id: null,
          active_device_id: null,
        },
      }),
      prisma.staffPayCompany.updateMany({
        where: { owner_user_id: Number(dbUser.id) },
        data: { auto_pay_enabled: false },
      }),
    ]);

    await revokeBiometric(dbUser.id);
    await invalidateUser(dbUser.id);
    // admin_audit_log, not user_activity: this trail has to outlive the row it
    // describes, and user_activity is cascaded away with it.
    await logSystemAction('account.deletion_requested', {
      user_id: Number(dbUser.id),
      scheduled_for: scheduledFor.toISOString(),
      grace_days: deletionGraceDays(),
    });
    console.log('🗑️ Account deletion scheduled', { userId: dbUser.id, scheduled_for: scheduledFor.toISOString() });

    const days = deletionGraceDays();

    // To the address on file, not to the requester: this is what tells the real
    // owner of a taken-over account that it is being closed, while there is
    // still a window to cancel. Never fatal - the account is already closed.
    const email = String(revealUserFields(dbUser).email || '').trim();
    if (email) {
      try {
        await sendAccountClosureEmail({
          to: email,
          kind: 'scheduled',
          scheduledFor,
          graceDays: days,
          retentionYears: retentionYears(),
        });
      } catch (e) {
        captureError('account.deletion_email', e, { user_id: dbUser.id });
      }
    }

    return res.json({
      remark: 'account_deletion_scheduled',
      status: 'success',
      message: [
        days > 0
          ? `Your account is closed and will be permanently deleted in ${days} day${days === 1 ? '' : 's'}. Reactivate before then to cancel. Your transaction and identification records are kept for ${retentionYears()} years afterwards, as Nigerian law requires of a payment business.`
          : 'Your account is closed and will be permanently deleted shortly.',
      ],
      data: {
        scheduled_for: scheduledFor.toISOString(),
        grace_days: days,
        retention_years: retentionYears(),
      },
    });
  } catch (error) {
    return serverError(res, 'Error in delete-account (controller)', error);
  }
}

/**
 * Close the StaffPay virtual accounts belonging to a closed account.
 *
 * Stage one, not stage two: a dedicated account is not a record, it is a live
 * payment instrument. Left open it keeps taking transfers into a wallet nobody
 * can sign into, and every naira that lands has to be traced and refunded by
 * hand. The columns are cleared too, so the app cannot show an account number
 * that no longer works.
 */
async function closeStaffPayVirtualAccounts(userId) {
  if (!prisma.staffPayCompany) return;

  const companies = await prisma.staffPayCompany.findMany({
    where: { owner_user_id: Number(userId), paystack_dva_id: { not: null } },
    select: { id: true, paystack_dva_id: true },
  });

  for (const company of companies) {
    try {
      await deactivateDedicatedAccount(company.paystack_dva_id);
    } catch (e) {
      // Worth an alert rather than a log line: the account is still live at the
      // provider and only a human can close it now.
      captureError('account.purge.dva', e, { company_id: company.id });
      continue;
    }

    await prisma.staffPayCompany.update({
      where: { id: company.id },
      data: { paystack_dva_id: null, virtual_account_number: null, virtual_account_bank_name: null },
    });
  }
}

/**
 * Erase one account for good: the personal columns, then the profile image at
 * the upload provider, then the cache. Used only by the purge worker.
 */
async function purgeUser(user) {
  // Read before the wipe, send after it: the notice is the last thing this
  // address is ever used for, and it must not be sent if the wipe fails.
  const email = String(revealUserFields(user).email || '').trim();

  // Before the wipe: after it there is no way back to the company that owns
  // them beyond the owner id, and a live virtual account is money in motion.
  await closeStaffPayVirtualAccounts(user.id);

  await anonymizeUserData(user.id);

  // Outside the transaction on purpose: the file lives with the upload
  // provider, so it cannot be rolled back and must not hold the write open.
  if (user.image) {
    try {
      await deleteFileByUrl(user.image);
    } catch (e) {
      console.error('⚠️ Profile image not removed for deleted account', { userId: user.id });
    }
  }

  await invalidateUser(user.id);

  if (email) {
    try {
      await sendAccountClosureEmail({ to: email, kind: 'completed', retentionYears: retentionYears() });
    } catch (e) {
      captureError('account.deletion_email', e, { user_id: user.id });
    }
  }

  // The audit row has no foreign key to users, so it survives the row it
  // describes - which is the whole point of recording a deletion.
  await logSystemAction('account.purged', { user_id: Number(user.id) });
  console.log('🗑️ Account purged after grace period', { userId: user.id });
}

/**
 * Stage two, for one closed account: the StaffPay side of the retention period.
 *
 * A company's KYB pack is the most sensitive thing in the system - a government
 * ID scan and a CAC certificate - and it is the same five-year record as the
 * user's own KYC, so it lives exactly as long and not a day longer. The staff
 * rows go with it: they are third parties who never opened an account here, and
 * nothing entitles VoltPay to hold a cleaner's name and bank account forever
 * because their employer once used the app.
 *
 * The payroll runs and items stay - they are the payment record - but by the
 * end of this they point at rows that name nobody.
 */
async function eraseStaffPayIdentity(userId) {
  const id = Number(userId);
  if (!prisma.staffPayCompany) return;

  const companies = await prisma.staffPayCompany.findMany({
    where: { owner_user_id: id },
    select: {
      id: true,
      verification: {
        select: {
          gov_id_url_enc: true,
          proof_of_address_url_enc: true,
          cac_certificate_url_enc: true,
          cac_status_report_url_enc: true,
        },
      },
    },
  });
  if (!companies.length) return;

  // Files first: they live at the upload provider, so nulling the column
  // without this leaves the government ID downloadable by anyone holding the
  // URL, with nothing left in the database to say it is still out there.
  for (const company of companies) {
    for (const enc of Object.values(company.verification || {})) {
      const url = enc ? revealText(enc) : '';
      if (!url) continue;
      try {
        await deleteFileByUrl(url);
      } catch (e) {
        console.error('⚠️ KYB document not removed at retention expiry', { company_id: company.id });
      }
    }
  }

  const companyIds = companies.map(c => c.id);
  // Required columns become '' rather than null - the schema will not take a
  // null, and '' is not a unique index the way a blank blind index would be.
  await prisma.$transaction([
    prisma.staffPayStaff.updateMany({
      where: { company_id: { in: companyIds } },
      data: {
        full_name_enc: '',
        phone_enc: null,
        phone_idx: null,
        account_number_enc: '',
        account_name_enc: null,
        paystack_recipient_code: null,
      },
    }),
    prisma.staffPayVerification.updateMany({
      where: { company_id: { in: companyIds } },
      data: {
        trading_name_enc: '',
        trading_name_idx: null,
        support_email_enc: '',
        support_email_idx: null,
        support_phone_enc: '',
        support_phone_idx: null,
        office_address_enc: null,
        gov_id_url_enc: '',
        proof_of_address_url_enc: null,
        cac_certificate_url_enc: '',
        cac_status_report_url_enc: null,
        admin_notes: null,
        decline_reason: null,
      },
    }),
    prisma.staffPayCompany.updateMany({
      where: { id: { in: companyIds } },
      data: {
        name_enc: '',
        name_idx: null,
        address_enc: '',
        phone_enc: '',
        phone_idx: null,
        email_enc: '',
        email_idx: null,
        cac_number: null,
      },
    }),
  ]);
}

/**
 * Stage two, the support side. A complaint file is a record VoltPay has to be
 * able to produce for the same five years - the CBN consumer protection rules
 * are as unimpressed by "the customer left" as the AML ones are - so the ticket
 * header survives: its reference, status, dates and rating. What goes is
 * everything inside it that names the person: the contact details it was raised
 * with, and the message bodies and their attachments, which routinely carry an
 * account number, a screenshot of a transfer or a photograph of an ID.
 */
async function eraseSupportIdentity(userId) {
  const id = Number(userId);
  if (!prisma.supportTicket) return;

  const tickets = await prisma.supportTicket.findMany({
    where: { user_id: id },
    select: { id: true, messages: { select: { attachments: true } } },
  });
  if (!tickets.length) return;

  for (const ticket of tickets) {
    for (const message of ticket.messages) {
      const files = Array.isArray(message.attachments) ? message.attachments : [];
      for (const file of files) {
        if (!file?.url) continue;
        try {
          await deleteFileByUrl(file.url);
        } catch (e) {
          console.error('⚠️ Ticket attachment not removed at retention expiry', { ticket_id: ticket.id });
        }
      }
    }
  }

  const ticketIds = tickets.map(t => t.id);
  await prisma.$transaction([
    prisma.supportTicketMessage.deleteMany({ where: { ticket_id: { in: ticketIds } } }),
    prisma.supportTicket.updateMany({
      where: { id: { in: ticketIds } },
      data: {
        name_enc: null,
        name_idx: null,
        email_enc: null,
        email_idx: null,
        phone_enc: null,
        phone_idx: null,
        rating_comment: null,
      },
    }),
  ]);
}

/**
 * The BVN / NIN record. This is the one thing deletion deliberately does NOT
 * touch: stage one leaves it whole, because the identification evidence behind
 * a wallet is exactly what the Money Laundering Act requires to be kept for
 * five years after the relationship ends, and a closed account is the case an
 * investigator is most likely to ask about. It only goes here, with the rest.
 *
 * The row is dropped rather than blanked: every column on it is identity data
 * or a match result about identity data, so there is nothing left worth a row.
 */
async function eraseKycIdentity(userId) {
  if (!prisma.kycVerification) return;
  await prisma.kycVerification.deleteMany({ where: { user_id: Number(userId) } });
}

/**
 * Stage two, the sweep: closed accounts whose five years are up. Same timer as
 * the grace-period purge, because it is the same job - the law just puts the
 * two halves of it a long way apart.
 */
async function purgeExpiredIdentities(limit) {
  const rows = await prisma.user.findMany({
    where: {
      status: DELETED,
      deleted_at: { not: null, lte: retentionCutoff() },
      // Anything still holding ciphertext, on the user row or in the KYC record.
      // Once all of it is gone the row is done and must not be picked up again
      // on every tick forever.
      OR: [
        ...Object.keys(IDENTITY_FIELDS).map(column => ({ [column]: { not: null } })),
        ...(prisma.kycVerification ? [{ kyc_verification: { isNot: null } }] : []),
      ],
    },
    select: { id: true },
    orderBy: { deleted_at: 'asc' },
    take: Math.max(1, Number(limit) || 25),
  });

  let erased = 0;
  for (const row of rows) {
    try {
      await eraseStaffPayIdentity(row.id);
      await eraseSupportIdentity(row.id);
      await eraseKycIdentity(row.id);
      await prisma.user.update({ where: { id: row.id }, data: IDENTITY_FIELDS });
      await invalidateUser(row.id);
      await logSystemAction('account.retention_expired', {
        user_id: Number(row.id),
        retention_years: retentionYears(),
      });
      erased += 1;
    } catch (error) {
      captureError('account.retention', error, { user_id: row.id });
    }
  }

  return erased;
}

// ponytail: one worker, guarded in-process like the StaffPay scheduler. Two API
// boxes would both wipe the same row - the second one's delete simply misses,
// but move the claim into SQL if this ever runs more than once.
let purging = false;

/**
 * Delete the accounts whose cooling period has expired, then erase the ones
 * whose retention period has. Runs on a timer from server.js.
 */
async function purgeDueDeletions({ limit = 25 } = {}) {
  if (!prisma.user || purging) return { purged: 0, skipped: 0, retention_erased: 0 };
  purging = true;

  try {
    const result = await runPurge(limit);
    // Never let the five-year sweep failing hold up a due deletion, so it runs
    // after and reports separately.
    let retention_erased = 0;
    try {
      retention_erased = await purgeExpiredIdentities(limit);
    } catch (error) {
      captureError('account.retention', error, {});
    }
    return { ...result, retention_erased };
  } finally {
    purging = false;
  }
}

async function runPurge(limit) {
  const due = await prisma.user.findMany({
    where: { deletion_scheduled_at: { not: null, lte: new Date() } },
    select: { id: true, image: true, balance: true, deletion_scheduled_at: true, email: true, email_enc: true },
    orderBy: { deletion_scheduled_at: 'asc' },
    take: Math.max(1, Number(limit) || 25),
  });

  let purged = 0;
  let skipped = 0;

  for (const user of due) {
    try {
      // Money can arrive during the grace period - a refund, a reversal, a
      // transfer from a friend. Destroying the ledger under it would strand it,
      // so the purge stops and a human is told.
      if (Number(user.balance) >= MIN_CLOSEABLE_BALANCE) {
        skipped += 1;
        captureError('account.purge.blocked', 'Scheduled deletion skipped: wallet is not empty', { user_id: user.id });
        continue;
      }

      const staffPay = await staffPayBlocker(user.id);
      if (staffPay) {
        skipped += 1;
        captureError('account.purge.blocked', `Scheduled deletion skipped: ${staffPay.message}`, { user_id: user.id });
        continue;
      }

      await purgeUser(user);
      purged += 1;
    } catch (error) {
      skipped += 1;
      captureError('account.purge', error, { user_id: user.id });
    }
  }

  return { purged, skipped };
}

module.exports = {
  exportAccountData,
  deactivateAccount,
  requestReactivation,
  confirmReactivation,
  deleteAccount,
  purgeDueDeletions,
  // Exported because admin.deleteUser closes accounts too, and there must be
  // exactly one definition of what "erased" means - two would drift, and the
  // one that drifts is the one that leaves a name behind.
  anonymizeUserData,
  // The whole stage-one teardown, used by admin.deleteUser so an admin close
  // and a self-service close are the same act.
  purgeUser,
  // The Deleted Accounts screen reads both to work out which stage a row is at
  // and when its identification record is due to go.
  IDENTITY_FIELDS,
  retentionYears,
  __test: {
    anonymizeUserData,
    CREDENTIAL_FIELDS,
    IDENTITY_FIELDS,
    RETAINED_PII_FIELDS,
    preserveLegacyIdentity,
    staffPayBlocker,
    deletionDueAt,
    deletionGraceDays,
    retentionYears,
    retentionCutoff,
  },
};
