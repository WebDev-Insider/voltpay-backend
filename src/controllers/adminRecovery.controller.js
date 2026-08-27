// Recovery-phrase resets, for the support desk.
//
// The phrase is a verify-only secret: minted once at signup, shown once, and
// stored only as a pepper + salt + scrypt digest (helpers/recovery.helper.js).
// There is therefore no "show me this user's phrase" endpoint and there cannot
// be one - a lost phrase can only ever be replaced.
//
// What a reset does: mint a new BIP39 phrase, replace the hash, and send the
// plain words to the address already on the account. The admin never sees them.
// That is the whole security model of this file:
//
//   - the plaintext is not in the response, not in a log line and not in the
//     audit row, so an admin session that has been taken over cannot be used to
//     read a phrase out of the dashboard;
//   - the destination is decrypted from `email_enc`, never taken from the
//     request, so an admin cannot redirect one to an inbox they control;
//   - the phrase on its own is not a login. Recovery sign-in needs the password
//     and a code emailed to that same address as well (auth.controller.js), so
//     this is a support action, not a key to the account;
//   - the real owner hears about it immediately, in-app and by push, and the
//     action is written to admin_audit_log by adminAudit.middleware.
//
// Superadmin-gated and rate limited at the route. See admin.routes.js.

const prisma = require('../../database/prisma');

const { blindIndex, publicUser, revealUserFields } = require('../helpers/pii.helper');
const { generateRecoveryPhrase, hashRecoveryPhrase, WORD_COUNT } = require('../helpers/recovery.helper');
const { isDeleted } = require('../helpers/accountStatus.helper');
const { invalidateUser } = require('../services/userCache.service');
const { sendRecoveryPhraseEmail } = require('../services/email.service');
const { listAdminActions } = require('../services/audit.service');
const { logUserEvent } = require('../services/userAudit.service');
const { notifyUser } = require('../services/notify.service');
const { captureError } = require('../services/alerts.service');

// The audit action adminAudit.middleware derives from
// POST /api/admin/users/:id/recovery-phrase/reset.
const RESET_ACTION = 'recovery-phrase.reset';

const fail = (res, code, remark, message) =>
  res.status(code).json({ remark, status: 'error', message: [message], data: null });

/**
 * `jadeedge@gmail.com` -> `j*******@gmail.com`.
 *
 * Enough for an admin to confirm the mail went where they expected, without
 * the full address sitting on a history screen that is left open all day.
 */
function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at < 1) return '';
  return `${email[0]}${'*'.repeat(Math.max(at - 1, 1))}${email.slice(at)}`;
}

/**
 * GET /admin/recovery-phrase/lookup?q=
 *
 * Exact match on email, phone or username - and on the user id, when the query
 * is short enough not to be a phone number. Partial search is impossible here
 * by design: those columns are ciphertext and are found through a blind index,
 * which matches a whole value or nothing (see CLAUDE.md, Security Rules).
 */
async function lookupUser(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return fail(res, 400, 'bad_request', 'Enter an email, phone number, username or user ID');

    const or = [
      { email_idx: blindIndex(q, 'email') },
      { mobile_idx: blindIndex(q, 'mobile') },
      { username_idx: blindIndex(q, 'username') },
    ];

    // A Nigerian mobile is 13 digits and overflows a Postgres int4, so only a
    // short run of digits is treated as an id.
    if (/^\d{1,9}$/.test(q)) or.push({ id: Number(q) });

    const row = await prisma.user.findFirst({
      where: { OR: or },
      select: {
        id: true,
        firstname_enc: true,
        lastname_enc: true,
        username_enc: true,
        email_enc: true,
        mobile_enc: true,
        country_code: true,
        image: true,
        status: true,
        role: true,
        created_at: true,
        recovery_hash: true,
        recovery_set_at: true,
      },
    });

    if (!row) {
      return fail(
        res,
        404,
        'not_found',
        'No account matches that. Search by the full email, phone number, username or user ID - partial matches are not possible on encrypted columns.',
      );
    }

    // publicUser drops it too, but the hash is lifted off here as well so a
    // future edit to that filter cannot quietly start leaking it.
    const { recovery_hash: recoveryHash, ...safe } = row;

    return res.json({
      remark: 'recovery_lookup',
      status: 'success',
      data: {
        user: publicUser(safe),
        recovery: {
          has_phrase: Boolean(recoveryHash),
          set_at: row.recovery_set_at,
          word_count: WORD_COUNT,
        },
        // Predates the feature: nothing to reset against, and a reset is
        // exactly how such an account gets one.
        deleted: isDeleted(row),
      },
    });
  } catch (e) {
    captureError('admin.recovery_lookup', e);
    return fail(res, 500, 'error', 'Failed to look up that account');
  }
}

/**
 * POST /admin/users/:id/recovery-phrase/reset
 *
 * The email is sent BEFORE the hash is replaced, and the reset is abandoned if
 * the provider does not accept it. Written the other way round, a send that
 * fails would leave the user with an old phrase that no longer verifies and a
 * new one they never received - locked out of recovery with nothing to type.
 *
 * The residual case is the mirror image: mail accepted, database write fails.
 * The user then holds words that do not work yet, which is a second run of this
 * same endpoint away from being fixed. That is the direction to fail in.
 */
async function resetRecoveryPhrase(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'bad_request', 'Invalid user id');

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, status: true, email_enc: true, firstname_enc: true, recovery_set_at: true },
    });

    if (!user) return fail(res, 404, 'not_found', 'User not found');

    if (isDeleted(user)) {
      return fail(res, 409, 'account_deleted', 'This account has been deleted and cannot be signed into. Nothing was changed.');
    }

    const { email, firstname } = revealUserFields(user);
    const to = String(email || '').trim();

    if (!to) {
      return fail(
        res,
        422,
        'no_email',
        'This account has no email address on file, so there is nowhere to send the phrase. Nothing was changed.',
      );
    }

    const phrase = generateRecoveryPhrase();
    const hashed = await hashRecoveryPhrase(phrase);

    const delivery = await sendRecoveryPhraseEmail({ to, phrase, firstName: firstname });

    // No BREVO_API_KEY: the service reports the send as queued and drops it.
    // Rotating the hash on the back of that would lock the user out of recovery
    // for good, so this is a hard stop rather than a warning.
    if (delivery?.dev) {
      return fail(
        res,
        503,
        'email_not_configured',
        'Email delivery is not configured on this environment, so the phrase could not be sent. Nothing was changed.',
      );
    }

    if (!delivery?.queued) {
      return fail(
        res,
        502,
        'email_failed',
        'The email could not be sent, so the phrase was not changed. The old phrase still works. Try again in a moment.',
      );
    }

    const resetAt = new Date();
    await prisma.user.update({ where: { id }, data: { recovery_hash: hashed, recovery_set_at: resetAt } });

    // userCache caches `has_recovery`, and the recovery login path reads the
    // hash - both have to see this now, not in fifteen seconds.
    await invalidateUser(id);

    // Three channels, none of them fatal. This is the notice that lets the real
    // owner catch a reset they did not ask for while it still matters.
    notifyUser({
      userId: id,
      subject: 'Your recovery phrase was reset',
      message:
        'A new 12-word recovery phrase has been emailed to you. Your old phrase no longer works. If you did not ask for this, change your password and contact support now.',
      type: 'security',
      data: { event: 'recovery_phrase_reset' },
    }).catch(e => captureError('admin.recovery_reset_notify', e, { user_id: id }));

    logUserEvent({
      req,
      userId: id,
      event: 'recovery_phrase.admin_reset',
      metadata: { actor: String(req.admin?.name || 'admin').slice(0, 64) },
    }).catch(() => null);

    console.log('🔑 Recovery phrase reset by admin', { user_id: id, actor: req.admin?.name || 'admin' });

    return res.json({
      remark: 'recovery_phrase_reset',
      status: 'success',
      message: [`A new ${WORD_COUNT}-word recovery phrase has been emailed to ${maskEmail(to)}`],
      // Deliberately no phrase. It exists in exactly one place now: that inbox.
      data: { id, email_masked: maskEmail(to), reset_at: resetAt, word_count: WORD_COUNT },
    });
  } catch (e) {
    captureError('admin.recovery_reset', e, { user_id: id });
    return fail(res, 500, 'error', 'Failed to reset the recovery phrase. Nothing was changed.');
  }
}

/**
 * GET /admin/recovery-phrase/resets
 *
 * Read straight off admin_audit_log rather than a table of its own - that log
 * is already written for every admin write, outlives the account it describes,
 * and cannot be edited from the dashboard.
 *
 * The log holds only the user id, as it must. The addresses are decrypted here,
 * at read time, and masked.
 */
async function listResets(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    const { items, pagination } = await listAdminActions({ page, perPage, action: RESET_ACTION });

    const ids = [...new Set(items.map(row => Number(row.target_id)).filter(Number.isInteger))];

    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email_enc: true, username_enc: true } })
      : [];

    const byId = new Map(
      users.map(row => {
        const revealed = revealUserFields(row);
        return [row.id, { email_masked: maskEmail(revealed.email), username: revealed.username || '' }];
      }),
    );

    const rows = items.map(row => {
      const userId = Number(row.target_id);
      const match = byId.get(userId) || {};

      return {
        id: row.id,
        actor: row.actor,
        actor_role: row.metadata?.actor_role || null,
        user_id: Number.isInteger(userId) ? userId : null,
        email_masked: match.email_masked || '',
        username: match.username || '',
        // A 4xx/5xx row is an attempt that changed nothing - worth showing, not
        // worth reading as a completed reset.
        succeeded: Number(row.status_code) >= 200 && Number(row.status_code) < 300,
        status_code: row.status_code,
        ip: row.ip,
        created_at: row.created_at,
      };
    });

    return res.json({ remark: 'recovery_resets', status: 'success', data: { items: rows, pagination } });
  } catch (e) {
    captureError('admin.recovery_resets', e);
    return fail(res, 500, 'error', 'Failed to load the reset history');
  }
}

module.exports = { lookupUser, resetRecoveryPhrase, listResets, __test: { maskEmail } };
