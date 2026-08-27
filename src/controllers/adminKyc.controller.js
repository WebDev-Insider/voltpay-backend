/**
 * The identification record behind one wallet, for the dashboard.
 *
 *   GET  /api/admin/users/:id/kyc          the record with the numbers masked
 *   POST /api/admin/users/:id/kyc/reveal   the same record with the BVN, the
 *                                          bank account number and the retired
 *                                          NIN in the clear, behind the admin's
 *                                          own password
 *
 * Two endpoints rather than one because they answer different questions. "Is
 * this user verified, and when" is routine and every support agent needs it.
 * "What is their BVN" is a regulated disclosure that should cost something to
 * ask for, be attributable to a person, and be rare enough that the audit log
 * reads like an exception list rather than a page-view counter.
 *
 * Both work on a deleted account. That is the point: stage one of deletion
 * anonymises the user row but deliberately leaves this record intact, because
 * MLPPA 2022 s.19 and the CBN AML/CFT Regulations require five years of it after
 * the relationship ends - and the request that needs it (an NFIU query, a
 * chargeback, a fraud report) almost always arrives after the account is gone.
 * account.controller's retention sweep is the only thing that erases it.
 *
 * The password is re-checked here rather than trusted from the session: a
 * dashboard left open on an unlocked laptop is the realistic threat, and a
 * Bearer token proves only that somebody logged in some hours ago.
 */
const prisma = require('../../database/prisma');
const arewasmart = require('../funding/arewasmart.service');
const { verifySecret, reveal, revealText, revealUserFields, blindIndex } = require('../helpers/pii.helper');
const { matchName, profileName } = require('../helpers/nameMatch.helper');
const { rowIsVerified } = require('../helpers/kycGate.helper');
const { logAdminAction, clientIp } = require('../services/audit.service');
const { securityEvent } = require('../services/alerts.service');
const { notifyUser } = require('../services/notify.service');
const { invalidateUser } = require('../services/userCache.service');
const { finalizeIfVerified } = require('./kyc.controller');

// Must match adminAuth.controller: the domain is part of the digest.
const PASSWORD_DOMAIN = 'admin_password';

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message) {
  return res.status(status).json({ remark, status: 'error', message: [message], data: null });
}

/** Last four digits only, the same shape a bank statement shows. */
function mask(enc) {
  if (!enc) return null;
  const value = reveal(enc);
  return value ? `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : null;
}

/**
 * @param {boolean} revealed  false: numbers masked. true: numbers in the clear.
 *
 * The rest of the record - names, date of birth, phone, the match results - is
 * shown either way. It is the same identity data the deleted-accounts screen
 * already decrypts, and an admin who cannot see the name cannot tell whether
 * they are looking at the right record before asking for the number.
 */
function serialize(row, { revealed }) {
  if (!row) return null;
  return {
    user_id: row.user_id,
    bvn: revealed ? (row.bvn_enc ? reveal(row.bvn_enc) : null) : mask(row.bvn_enc),
    bvn_status: row.status,
    bvn_decline_reason: row.decline_reason || null,
    bvn_verified_at: row.verified_at,
    bvn_match: row.bvn_match || null,
    // The NIN, HISTORICAL ONLY. Nothing writes these any more - the NIN route
    // was withdrawn and answers 410 - and `nin_status` does not affect
    // `verified` below, so a row reading `nin_status: 'verified'` with `status`
    // still `none` is an UNVERIFIED user, not a half-finished application. It is
    // the one combination on this screen worth reading carefully.
    //
    // Still shown, and still revealable: the columns were kept so the evidence
    // survives its retention period, and this is where an agent reads it.
    // `nin_match` is Payvessel's field-by-field result from the attempt.
    nin: revealed ? (row.nin_enc ? reveal(row.nin_enc) : null) : mask(row.nin_enc),
    nin_status: row.nin_status || 'none',
    nin_decline_reason: row.nin_decline_reason || null,
    nin_verified_at: row.nin_verified_at,
    nin_match: row.nin_match || null,
    // The NIN SLIP - live, and a different thing to the four lines above it.
    // Those are the withdrawn automated NIN-number check and grant nothing;
    // `nin_slip_status: 'approved'` is a human decision that DOES open the
    // wallet. The image itself is not here - see getNinSlip, which audits the
    // disclosure - because this serializer feeds a routine support screen.
    nin_slip: revealed
      ? (row.nin_slip_number_enc ? reveal(row.nin_slip_number_enc) : null)
      : mask(row.nin_slip_number_enc),
    nin_slip_status: row.nin_slip_status || 'none',
    nin_slip_decline_reason: row.nin_slip_decline_reason || null,
    nin_slip_submitted_at: row.nin_slip_submitted_at || null,
    nin_slip_reviewed_at: row.nin_slip_reviewed_at || null,
    nin_slip_reviewed_by: row.nin_slip_reviewed_by || null,
    // Withdrawn verification. Present means somebody took this wallet's
    // verification back, and `verified` below will already say false - these
    // three are the who and the why.
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by || null,
    revoke_reason: row.revoke_reason || null,
    // The bank account half - LIVE again, and now REQUIRED. These columns were
    // written, withdrawn, and brought back: today a wallet is verified only when
    // an identity document AND `account_status = 'verified'` both hold, so a row
    // reading `status: 'verified'` with `account_status: 'none'` is an
    // UNVERIFIED user with one step left, not a finished one.
    //
    // Resolved through Paystack, and the name it returned had to match the
    // profile. That makes `account_name` the single most useful line on this
    // screen when reviewing a NIN slip: a bank has independently confirmed a
    // person by that name.
    account_number: revealed
      ? (row.account_number_enc ? reveal(row.account_number_enc) : null)
      : mask(row.account_number_enc),
    account_name: row.account_name_enc ? reveal(row.account_name_enc) : null,
    account_status: row.account_status || 'none',
    account_decline_reason: row.account_decline_reason || null,
    account_verified_at: row.account_verified_at,
    bank_code: row.bank_code || null,
    bank_name: row.bank_name || null,
    firstname: reveal(row.first_name_enc) || null,
    middlename: row.middle_name_enc ? reveal(row.middle_name_enc) : null,
    lastname: reveal(row.last_name_enc) || null,
    dob: reveal(row.dob_enc) || null,
    phone: reveal(row.phone_enc) || null,
    gender: row.gender,
    reference: row.reference,
    submitted_at: row.submitted_at,
    // Read from the gate's own predicate rather than restated here. The rule has
    // changed direction three times, and a dashboard that computes "verified"
    // its own way will eventually disagree with the thing that actually holds
    // the money. Today it is the BVN alone; this line does not need to know that.
    verified: rowIsVerified(row),
    // Historical only - grants nothing. It marks a BROADER set than the current
    // rule (it was written where a verified BVN *or* NIN existed), so a
    // grandfathered row can read `verified: false`. Shown as provenance ("this
    // row was verified before the cutover"), never as an access decision.
    grandfathered: Boolean(row.grandfathered),
  };
}

async function findRecord(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    fail(res, 400, 'validation_error', 'Invalid user id');
    return null;
  }
  if (!prisma.kycVerification) {
    fail(res, 500, 'server_error', 'Missing Prisma model KycVerification. Run prisma generate and restart.');
    return null;
  }

  const row = await prisma.kycVerification.findUnique({ where: { user_id: userId } });
  if (!row) {
    fail(res, 404, 'not_found', 'This user has not submitted an identity verification');
    return null;
  }
  return row;
}

/** GET /api/admin/users/:id/kyc */
async function getUserKyc(req, res) {
  try {
    const row = await findRecord(req, res);
    if (!row) return;
    return ok(res, 'kyc_record', 'OK', { kyc: serialize(row, { revealed: false }) });
  } catch (e) {
    console.error('adminKyc.getUserKyc error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load the verification record');
  }
}

/**
 * POST /api/admin/users/:id/kyc/reveal   { password }
 *
 * Only a real admin account can do this. A static API key or the legacy shared
 * secret has no password to re-enter and no person behind it, so there would be
 * nothing to prove and nobody to attribute the disclosure to - both reasons
 * this endpoint exists.
 */
async function revealUserKyc(req, res) {
  try {
    const admin = req.admin;
    if (!admin?.id || admin.source !== 'session' || !admin.row?.password) {
      return fail(res, 403, 'password_required', 'Sign in with an admin account to view identity numbers');
    }

    const password = String(req.body?.password ?? '');
    if (!password) return fail(res, 400, 'validation_error', 'Enter your password');

    // Same domain the login path hashes with - a different one silently never
    // matches, which would read as "the password is wrong" for everybody.
    const check = await verifySecret(password, admin.row.password, PASSWORD_DOMAIN);
    if (!check?.ok) {
      // Someone with a live admin session guessing at the password gate is
      // either shoulder-surfing or a stolen laptop. Worth waking someone for.
      securityEvent('admin.kyc_reveal_bad_password', 'Wrong password at the identity reveal gate', {
        admin_id: admin.id,
        target_user_id: Number(req.params.id) || null,
        ip: clientIp(req),
      });
      return fail(res, 401, 'invalid_password', 'That password is not correct');
    }

    const row = await findRecord(req, res);
    if (!row) return;

    // Audited by hand, not by adminAudit.middleware: this is a read, and the
    // middleware records writes only. A disclosure that leaves no trace is the
    // thing the password gate is meant to prevent.
    await logAdminAction({
      actor: admin.name || `admin:${admin.id}`,
      action: 'admin.kyc_revealed',
      method: 'POST',
      path: req.originalUrl?.slice(0, 256) || null,
      targetType: 'user',
      targetId: row.user_id,
      statusCode: 200,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
      // Ids only. The numbers that were disclosed must not be written into the
      // record of the disclosure.
      metadata: {
        admin_id: admin.id,
        bvn_status: row.status,
        account_status: row.account_status,
        nin_status: row.nin_status,
      },
    });

    return ok(res, 'kyc_revealed', 'OK', { kyc: serialize(row, { revealed: true }) });
  } catch (e) {
    console.error('adminKyc.revealUserKyc error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load the verification record');
  }
}

/* ========================================================================== */
/*  NIN SLIP REVIEW                                                           */
/* ========================================================================== */
/*
 * The manual verification path, for a user who has no BVN. They upload a photo
 * of their NIN slip; somebody here opens it, compares it against the details on
 * the account, and approves or declines.
 *
 * This is the only place in the product where a human decision opens a wallet,
 * so three things are non-negotiable:
 *
 *   - Every decision is attributable. `nin_slip_reviewed_by` is taken from the
 *     signed-in admin, not from the request body, whenever there is a session.
 *   - Every look at the document is logged. The image is a photograph of a
 *     government ID; opening one is a disclosure even though it is also the job.
 *   - An approval opens the wallet through finalizeIfVerified, the same function
 *     a verified BVN goes through, so there is one implementation of "unlock"
 *     and not two that can disagree.
 *
 * Deliberately NOT behind the password gate that revealUserKyc uses. That gate
 * exists to make an unusual disclosure expensive; this one is the reviewer's
 * entire task, and a password prompt per slip would be typed on autopilot within
 * an hour - all cost, no signal. The audit entry is what carries the weight
 * here instead.
 */

const SLIP_DECISIONS = new Set(['approved', 'declined']);
const SLIP_FILTERS = new Set(['pending', 'approved', 'declined', 'revoked', 'all']);

/** How the queue list shows one slip. No image, no number - see getNinSlip. */
function slipListItem(row) {
  const submitted = row.nin_slip_submitted_at ? new Date(row.nin_slip_submitted_at).getTime() : null;
  return {
    user_id: row.user_id,
    reference: row.reference,
    // The identity as the user typed it, which is exactly what the reviewer
    // compares against the slip. Decrypted here because a list of ciphertext is
    // not a queue anybody can triage.
    firstname: reveal(row.first_name_enc) || null,
    middlename: row.middle_name_enc ? reveal(row.middle_name_enc) : null,
    lastname: reveal(row.last_name_enc) || null,
    dob: reveal(row.dob_enc) || null,
    gender: row.gender || null,
    nin_masked: mask(row.nin_slip_number_enc),
    status: row.nin_slip_status || 'none',
    decline_reason: row.nin_slip_decline_reason || null,
    submitted_at: row.nin_slip_submitted_at || null,
    reviewed_at: row.nin_slip_reviewed_at || null,
    reviewed_by: row.nin_slip_reviewed_by || null,
    // Hours, not days: this queue promises a turnaround of a day or two, and a
    // list that rounds everything under 24h to "0 days" cannot show a reviewer
    // which slip is closest to breaking that promise.
    waiting_hours: submitted === null ? null : Math.floor((Date.now() - submitted) / 3_600_000),
    // The BVN half, so a reviewer can see at a glance that this user really has
    // no other route - a failed BVN attempt is useful context for the decision.
    bvn_status: row.status,
    bvn_decline_reason: row.decline_reason || null,
    // The corroboration. A bank has independently confirmed a customer by this
    // name, which is the strongest thing on the screen other than the slip
    // itself - a forged slip whose name a real bank also holds is a much taller
    // order than a forged slip alone. The account NUMBER is not here; the name
    // is what informs the decision.
    bank_status: row.account_status || 'none',
    bank_name: row.bank_name || null,
    bank_account_name: row.account_name_enc ? reveal(row.account_name_enc) : null,
    // The reviewer's register check, if somebody has already run it. LABELS
    // ONLY - this is exactly what was stored, and what was stored deliberately
    // holds no name, no date of birth and no photograph. A reviewer who wants to
    // see the register's actual record runs the lookup again and pays for it.
    register_check: publicCheck(row.nin_slip_check),
  };
}

/**
 * The stored verdict, on its way out to the dashboard.
 *
 * Everything in the check is already a label rather than a person's data, with
 * one exception: `nin_idx` is a keyed index of the NIN itself. It exists so the
 * server can tell one check from another, and the browser has no use for it -
 * so it stops here. An identifier that never leaves the process cannot be
 * correlated anywhere else.
 */
function publicCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const { nin_idx: _idx, ...rest } = check;
  return rest;
}

const SLIP_LIST_SELECT = {
  user_id: true,
  reference: true,
  first_name_enc: true,
  middle_name_enc: true,
  last_name_enc: true,
  dob_enc: true,
  gender: true,
  nin_slip_number_enc: true,
  nin_slip_status: true,
  nin_slip_decline_reason: true,
  nin_slip_submitted_at: true,
  nin_slip_reviewed_at: true,
  nin_slip_reviewed_by: true,
  status: true,
  decline_reason: true,
  account_status: true,
  account_name_enc: true,
  bank_name: true,
  nin_slip_check: true,
};

/**
 * GET /api/admin/kyc/nin-slips?status=pending&page=1&perPage=25
 *
 * Oldest first, always. This is a promise queue - "a day or two" - so the order
 * that matters is the order the promise was made in, never the order the rows
 * happen to come back in.
 */
async function listNinSlips(req, res) {
  try {
    if (!prisma.kycVerification) {
      return fail(res, 500, 'server_error', 'Missing Prisma model KycVerification. Run prisma generate and restart.');
    }

    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10) || 25, 1), 100);
    const filter = SLIP_FILTERS.has(String(req.query.status || 'pending')) ? String(req.query.status || 'pending') : 'pending';

    // 'none' is every user who never used this path, which is nearly all of
    // them. It is not a review state and must never appear in this queue.
    const where = filter === 'all'
      ? { nin_slip_status: { in: ['pending', 'approved', 'declined', 'revoked'] } }
      : { nin_slip_status: filter };

    const [total, rows, pending, approved, declined] = await Promise.all([
      prisma.kycVerification.count({ where }),
      prisma.kycVerification.findMany({
        where,
        orderBy: { nin_slip_submitted_at: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: SLIP_LIST_SELECT,
      }),
      prisma.kycVerification.count({ where: { nin_slip_status: 'pending' } }),
      prisma.kycVerification.count({ where: { nin_slip_status: 'approved' } }),
      prisma.kycVerification.count({ where: { nin_slip_status: 'declined' } }),
    ]);

    return ok(res, 'kyc_nin_slips', 'OK', {
      items: rows.map(slipListItem),
      page,
      perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
      counts: { pending, approved, declined },
    });
  } catch (e) {
    console.error('adminKyc.listNinSlips error:', { message: e?.message });
    return fail(res, 500, 'error', 'Could not load the NIN slip queue');
  }
}

/**
 * GET /api/admin/kyc/nin-slips/:id      (:id is the user id)
 *
 * The reviewer's actual screen: the photograph, the NIN in the clear, and the
 * details to compare it against.
 *
 * Both the image link and the number are disclosed here, because the review is
 * literally "does the number they typed match the number on the slip" and
 * masking it would make the task impossible while looking like security. The
 * disclosure is logged instead, by hand - adminAudit.middleware records writes,
 * and this is a read.
 */
async function getNinSlip(req, res) {
  try {
    const row = await findRecord(req, res);
    if (!row) return;

    if (!row.nin_slip_status || row.nin_slip_status === 'none') {
      return fail(res, 404, 'not_found', 'This user has not submitted a NIN slip');
    }

    const admin = req.admin;
    await logAdminAction({
      actor: admin?.name || (admin?.id ? `admin:${admin.id}` : 'admin'),
      action: 'admin.kyc_nin_slip_viewed',
      method: 'GET',
      path: req.originalUrl?.slice(0, 256) || null,
      targetType: 'user',
      targetId: row.user_id,
      statusCode: 200,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
      // Ids and states only. The number that was disclosed must not be written
      // into the record of the disclosure.
      metadata: { admin_id: admin?.id || null, nin_slip_status: row.nin_slip_status },
    }).catch(() => {});

    return ok(res, 'kyc_nin_slip', 'OK', {
      slip: {
        ...slipListItem(row),
        // The whole point of the screen. revealText because the column holds an
        // UploadThing URL, which is a bearer link to the photograph.
        slip_url: row.nin_slip_url_enc ? revealText(row.nin_slip_url_enc) : null,
        nin: row.nin_slip_number_enc ? reveal(row.nin_slip_number_enc) : null,
        phone: row.phone_enc ? reveal(row.phone_enc) : null,
        verified: rowIsVerified(row),
      },
    });
  } catch (e) {
    console.error('adminKyc.getNinSlip error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load the NIN slip');
  }
}

/* ------------------------------------------------- the register check ----- */
/*
 * Before a reviewer accepts a photograph as proof of identity, they can ask the
 * NIN register what it holds against that number. ArewaSmart `POST /nin/verify`
 * answers with the name, date of birth, gender, phone and PHOTOGRAPH on file.
 *
 * WHY THIS EXISTS. Everything else on the review screen came from the person
 * being reviewed: they typed the name, they typed the number, they took the
 * photograph. A reviewer comparing those against each other is checking a
 * document against itself. The register is the first input on the screen that
 * the applicant did not supply, and the portrait it returns is the single
 * hardest thing for a forged slip to survive.
 *
 * WHO PAYS. We do - roughly ₦50 a call, on our account, not the customer's.
 * That is the opposite of the BVN path and it changes the abuse shape: nobody
 * can spend a stranger's money here, but a reviewer clicking twice spends ours
 * twice. Hence the dedupe below, and hence `force` being an explicit,
 * separately-audited request rather than a retry button.
 *
 * WHAT IS KEPT. A verdict. Matched or not, when, by whom, and the last four
 * digits so a later check can tell it is about the same number. NOT the name,
 * NOT the date of birth, NOT the photograph. The register's record is a real
 * person's identity - it belongs on the reviewer's screen for the length of one
 * audited request and nowhere else, least of all in a column that outlives the
 * review. This is the same rule the customer-facing BVN lookup follows, applied
 * to the one place where a human genuinely has to see the data.
 */

/** Last four digits of a NIN, for telling one stored verdict from another. */
function last4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Same person's phone? Compared on the last ten digits, like everywhere else. */
function samePhone(a, b) {
  const x = String(a || '').replace(/\D/g, '').slice(-10);
  const y = String(b || '').replace(/\D/g, '').slice(-10);
  return x.length === 10 && x === y;
}

/**
 * Did the register's date of birth agree with what the applicant typed?
 *
 * Returns null - not false - when either side is missing. Absent is not wrong;
 * that lesson cost real money on the Payvessel path and it applies here too. A
 * reviewer shown "date of birth: no" for a field nobody supplied would decline
 * somebody over our own gap.
 */
function sameDob(a, b) {
  const x = String(a || '').trim().slice(0, 10);
  const y = String(b || '').trim().slice(0, 10);
  if (!x || !y) return null;
  return x === y;
}

function sameGender(a, b) {
  const x = String(a || '').trim().toUpperCase().charAt(0);
  const y = String(b || '').trim().toUpperCase().charAt(0);
  if (!x || !y) return null;
  return x === y;
}

/**
 * POST /api/admin/kyc/nin-slips/:id/verify    { force }
 *
 * Runs the register lookup for the slip on screen and returns the record for
 * comparison. Stores only the verdict. Does not decide anything - reviewNinSlip
 * still needs a person to press approve or decline.
 */
async function verifyNinLookup(req, res) {
  try {
    const row = await findRecord(req, res);
    if (!row) return;

    if (!row.nin_slip_status || row.nin_slip_status === 'none') {
      return fail(res, 404, 'not_found', 'This user has not submitted a NIN slip');
    }

    const nin = row.nin_slip_number_enc ? reveal(row.nin_slip_number_enc) : null;
    const digits = String(nin || '').replace(/\D/g, '');
    if (digits.length !== 11) {
      return fail(res, 400, 'no_nin', 'No readable NIN was stored with this slip, so there is nothing to look up');
    }

    // Already answered. Handed back without a provider call and WITHOUT a
    // record: what was stored is a verdict, not the register's data, so a
    // second reviewer sees the finding and not the person. Re-reading it is
    // free; seeing the photograph again costs another lookup, which is what
    // `force` is for.
    const previous = row.nin_slip_check || null;
    const force = req.body?.force === true || String(req.body?.force || '') === 'true';
    if (previous && previous.nin_idx && previous.nin_idx === blindIndex(digits, 'nin_slip') && !force) {
      return ok(res, 'kyc_nin_check_cached', 'This NIN has already been checked against the register', {
        check: publicCheck(previous),
        record: null,
        cached: true,
      });
    }

    if (!arewasmart.isConfigured()) {
      return fail(res, 503, 'unavailable', 'The NIN register is not configured on this environment');
    }

    const admin = req.admin;
    const checkedBy = String(
      (admin?.source === 'session' && admin.name) || req.headers['x-admin-user'] || 'admin',
    ).trim().slice(0, 120);

    let lookup;
    try {
      lookup = await arewasmart.verifyNin({ nin: digits, ref: row.reference || undefined });
    } catch (e) {
      // The register was never read, so nothing is stored and nothing is
      // claimed about this person. A failed lookup must never look like a
      // finding - see the BVN path, where the same distinction decides whether
      // somebody is charged.
      const status = Number(e?.statusCode) || 503;
      console.error('adminKyc.verifyNinLookup provider error:', {
        user_id: row.user_id,
        admin_id: admin?.id || null,
        reason: e?.arewasmart?.reason || null,
      });
      return fail(
        res,
        status === 400 ? 400 : 503,
        status === 400 ? 'validation_error' : 'unavailable',
        status === 400
          ? 'That NIN is not eleven digits'
          : 'Could not reach the NIN register. Nothing has been recorded - try again shortly.',
      );
    }

    // What the applicant told us, to compare the register against.
    const user = await prisma.user.findUnique({ where: { id: Number(row.user_id) } });
    const expected = user ? profileName(revealUserFields(user)) : '';
    const typedDob = row.dob_enc ? reveal(row.dob_enc) : null;
    const typedPhone = row.phone_enc ? reveal(row.phone_enc) : null;

    const record = lookup.found ? lookup.record : null;
    const registerName = record
      ? [record.firstName, record.middleName, record.lastName].filter(Boolean).join(' ')
      : '';
    const nameCheck = record ? matchName(expected, registerName) : null;

    const check = {
      provider: 'arewasmart',
      checked_at: new Date().toISOString(),
      checked_by: checkedBy,
      reference: lookup.reference || null,
      // `nin_last4` is a LABEL - it is what the reviewer reads to satisfy
      // themselves the check belongs to the slip in front of them. `nin_idx` is
      // the KEY, and the two are separate on purpose: four digits collide once
      // in ten thousand, and both places this is compared - the dedupe and the
      // staleness gate - would rather be exact than readable. A blind index is
      // the codebase's existing way to compare an identifier without keeping it.
      nin_last4: last4(digits),
      nin_idx: blindIndex(digits, 'nin_slip'),
      found: Boolean(lookup.found),
      // Counts and booleans. `matchName().missing` holds fragments of a real
      // name and is deliberately not among them.
      name_ok: nameCheck ? nameCheck.ok : null,
      name_matched: nameCheck ? nameCheck.matched : null,
      name_expected: nameCheck ? nameCheck.expectedTokens.length : null,
      name_reason: nameCheck ? nameCheck.reason : null,
      dob_ok: record ? sameDob(typedDob, record.dateOfBirth) : null,
      gender_ok: record ? sameGender(row.gender, record.gender) : null,
      phone_ok: record ? samePhone(typedPhone, record.phoneNumber) : null,
    };

    await prisma.kycVerification.update({
      where: { user_id: row.user_id },
      data: { nin_slip_check: check },
    });

    await logAdminAction({
      actor: checkedBy,
      action: 'admin.kyc_nin_register_checked',
      method: 'POST',
      path: req.originalUrl?.slice(0, 256) || null,
      targetType: 'user',
      targetId: row.user_id,
      statusCode: 200,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
      // The verdict, never the record. The audit trail of a disclosure must not
      // become a second copy of the thing disclosed.
      metadata: {
        admin_id: admin?.id || null,
        reference: row.reference,
        found: check.found,
        name_ok: check.name_ok,
        repeat: Boolean(previous),
      },
    }).catch(() => {});

    return ok(
      res,
      lookup.found ? 'kyc_nin_checked' : 'kyc_nin_not_found',
      lookup.found ? 'The register answered' : 'The register has no record of that NIN',
      {
        check: publicCheck(check),
        cached: false,
        // LIVE, ONE REQUEST ONLY. This is the register's copy of a real person -
        // names and a photograph - and it is here so a reviewer can look at it
        // beside the slip. It is not written to any column and not logged.
        record: record
          ? {
              firstname: record.firstName,
              middlename: record.middleName,
              lastname: record.lastName,
              dob: record.dateOfBirth,
              gender: record.gender,
              phone: record.phoneNumber,
              photo: record.photo,
              tracking_id: record.trackingId,
            }
          : null,
      },
    );
  } catch (e) {
    console.error('adminKyc.verifyNinLookup error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not run the register check');
  }
}

/**
 * PATCH /api/admin/kyc/nin-slips/:id    { status, decline_reason, override_reason }
 *
 * Approve or decline. Only a pending slip can be decided - re-deciding a closed
 * one would send the user a second contradictory push about a slip they have
 * already been told about, and would let an approval be quietly reversed
 * without the revoke audit trail. Reversing a decision is what revokeKyc is for.
 *
 * AN APPROVAL REQUIRES A COMPLETED REGISTER CHECK (see verifyNinLookup above);
 * a decline does not. `override_reason` is how a reviewer approves in spite of a
 * name the register spelled differently - mandatory in that case, ignored
 * otherwise, and written into the audit log either way.
 */
async function reviewNinSlip(req, res) {
  try {
    const row = await findRecord(req, res);
    if (!row) return;

    const decision = String(req.body?.status || '').trim().toLowerCase();
    if (!SLIP_DECISIONS.has(decision)) {
      return fail(res, 400, 'validation_error', `status must be one of: ${[...SLIP_DECISIONS].join(', ')}`);
    }

    // The reason is not paperwork. It is the entire content of the push the user
    // is about to get, and "declined" with no sentence attached leaves them
    // resubmitting the same unreadable photo indefinitely.
    const reason = String(req.body?.decline_reason || '').trim().slice(0, 500);
    if (decision === 'declined' && !reason) {
      return fail(res, 400, 'validation_error', 'A decline reason is required - the user is shown exactly this text');
    }

    if (row.nin_slip_status !== 'pending') {
      return fail(res, 409, 'not_pending', `This slip is already ${row.nin_slip_status}`);
    }

    // ---------------------------------------------------------------------
    // AN APPROVAL NEEDS THE REGISTER BEHIND IT. A DECLINE DOES NOT.
    //
    // Approving is the only action in this product where a person's judgement
    // alone opens a wallet, so it must rest on something the applicant did not
    // supply. The register check is that something, and requiring it here -
    // rather than only grey ing out a button in the dashboard - is what makes it
    // a rule instead of a suggestion.
    //
    // Declining is deliberately exempt. Most declines are an unreadable
    // photograph, and paying ₦50 to establish that a blurry image is blurry
    // would be a tax on the queue moving. It also cannot go wrong in the
    // direction that matters: a wrong decline is re-uploaded, a wrong approval
    // is a stranger holding a verified wallet.
    // ---------------------------------------------------------------------
    const override = String(req.body?.override_reason || '').trim().slice(0, 500);
    let overrode = false;

    if (decision === 'approved') {
      const check = row.nin_slip_check || null;

      if (!check || !check.found) {
        return fail(
          res, 428, 'register_check_required',
          check
            ? 'The register has no record of that NIN. Decline the slip, or re-run the check if you believe it was an outage.'
            : 'Check this NIN against the register before approving. The button is on the review screen.',
        );
      }

      // A stale verdict is not a verdict. If the stored check was run against a
      // different number than the one on the slip today, it is evidence about
      // somebody else. Compared on `nin_idx`, never on the four visible digits -
      // a check whose number merely ENDS the same is not the same check. A
      // verdict written without an index at all is treated as stale rather than
      // trusted, so the unsafe direction costs a lookup instead of an approval.
      const slipDigits = String(reveal(row.nin_slip_number_enc) || '').replace(/\D/g, '');
      if (!check.nin_idx || check.nin_idx !== blindIndex(slipDigits, 'nin_slip')) {
        return fail(
          res, 428, 'register_check_stale',
          'The stored register check was run against a different NIN. Run it again before approving.',
        );
      }

      // A NAME MISMATCH DOES NOT BLOCK THE APPROVAL, IT COSTS A SENTENCE.
      // Registers and profiles disagree for honest reasons - a married name, a
      // NIMC transcription, a profile holding the short form of a longer name -
      // and this route exists precisely because a human can weigh things an
      // automated check cannot. What a human should not be able to do is wave
      // one through silently, so the reason is mandatory and lands in the audit
      // log with their name on it.
      if (check.name_ok === false) {
        if (!override) {
          return fail(
            res, 428, 'register_name_mismatch',
            'The register name did not match this profile. Approving anyway needs a written reason, which is kept in the audit log.',
          );
        }
        overrode = true;
      }
    }

    const admin = req.admin;
    // A signed-in admin names themselves. Only an anonymous static key falls
    // back to whatever the caller claims - and a decision that opens a wallet
    // should have a person's name on it.
    const reviewedBy = String(
      (admin?.source === 'session' && admin.name) || req.body?.reviewed_by || req.headers['x-admin-user'] || 'admin',
    ).trim().slice(0, 120);

    const updated = await prisma.kycVerification.update({
      where: { user_id: row.user_id },
      data: {
        nin_slip_status: decision,
        nin_slip_decline_reason: decision === 'declined' ? reason : null,
        nin_slip_reviewed_by: reviewedBy,
        nin_slip_reviewed_at: new Date(),
        // A decline releases the number. The index is what stops two accounts
        // holding the same NIN, and a rejected attempt must not lock it away
        // from whoever actually owns it - most declines are a blurry photo, not
        // a fraud.
        ...(decision === 'declined' ? { nin_slip_number_idx: null } : {}),
      },
    });

    await logAdminAction({
      actor: reviewedBy,
      action: `admin.kyc_nin_slip_${decision}`,
      method: 'PATCH',
      path: req.originalUrl?.slice(0, 256) || null,
      targetType: 'user',
      targetId: row.user_id,
      statusCode: 200,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
      metadata: {
        admin_id: admin?.id || null,
        reference: row.reference,
        // What the register said, and whether this person went against it. The
        // one combination worth being able to find later is an approval carrying
        // `name_override: true` - a human accepting a slip the register did not
        // corroborate. The reason is theirs, in their words, attributable.
        register_found: row.nin_slip_check?.found ?? null,
        register_name_ok: row.nin_slip_check?.name_ok ?? null,
        name_override: overrode || undefined,
        override_reason: overrode ? override : undefined,
      },
    }).catch(() => {});

    if (decision === 'approved') {
      // One implementation of "unlock", shared with the BVN path: flips `kv`,
      // drops the user cache, and sends the "identity verified" push on the
      // transition. It re-reads the gate predicate itself, so it is safe to
      // call even if something else verified this user a second earlier.
      await finalizeIfVerified({ req, userId: row.user_id, row: updated });
    } else {
      await invalidateUser(row.user_id);
      await notifyUser({
        userId: Number(row.user_id),
        subject: 'NIN slip declined',
        message: `${reason} You can upload a new photo in Settings, or verify with your BVN instead - that one takes seconds.`,
        type: 'kyc',
        data: { status: 'declined', document: 'nin_slip' },
      }).catch(() => {});
    }

    return ok(res, `kyc_nin_slip_${decision}`, `NIN slip ${decision}`, {
      kyc: serialize(updated, { revealed: false }),
    });
  } catch (e) {
    console.error('adminKyc.reviewNinSlip error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not save the decision');
  }
}

/**
 * POST /api/admin/users/:id/kyc/revoke    { reason }
 *
 * Take verification back off a user who already has it. A forged slip that got
 * through, a BVN matched against a profile that has since turned out to belong
 * to someone else, a fraud report that lands a week after the approval.
 *
 * This re-freezes a live wallet holding real money, which is why it is
 * superadmin-gated in the router and why the reason is mandatory: the user is
 * told, in these words, why their money stopped moving.
 *
 * It writes the STATUS columns back to 'revoked' rather than setting a separate
 * flag. kycGate.rowIsVerified then fails with no new branch - there stays
 * exactly one predicate deciding whether a wallet can spend, which is the only
 * way this can be reasoned about at all.
 */
async function revokeKyc(req, res) {
  try {
    const row = await findRecord(req, res);
    if (!row) return;

    if (!rowIsVerified(row)) {
      return fail(res, 409, 'not_verified', 'This user is not verified, so there is nothing to revoke');
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) {
      return fail(res, 400, 'validation_error', 'A reason is required - the user is shown exactly this text');
    }

    const admin = req.admin;
    const revokedBy = String(
      (admin?.source === 'session' && admin.name) || req.body?.revoked_by || req.headers['x-admin-user'] || 'admin',
    ).trim().slice(0, 120);

    // Both doors are shut, not just the one that happened to be open. A user who
    // verified by BVN and later also had a slip approved would otherwise walk
    // straight back through the other one.
    const updated = await prisma.kycVerification.update({
      where: { user_id: row.user_id },
      data: {
        status: row.status === 'verified' ? 'revoked' : row.status,
        nin_slip_status: row.nin_slip_status === 'approved' ? 'revoked' : row.nin_slip_status,
        revoked_at: new Date(),
        revoked_by: revokedBy,
        revoke_reason: reason,
      },
    });

    // The dashboard's own "verify your identity" card reads the legacy `kv`
    // flag, so leaving it at '1' would show a revoked user as verified in the
    // app while the gate refuses every payment - the worst of both.
    await prisma.user.updateMany({ where: { id: Number(row.user_id) }, data: { kv: '0' } });
    await invalidateUser(row.user_id);

    await logAdminAction({
      actor: revokedBy,
      action: 'admin.kyc_revoked',
      method: 'POST',
      path: req.originalUrl?.slice(0, 256) || null,
      targetType: 'user',
      targetId: row.user_id,
      statusCode: 200,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
      metadata: {
        admin_id: admin?.id || null,
        reference: row.reference,
        was_bvn_verified: row.status === 'verified',
        was_slip_approved: row.nin_slip_status === 'approved',
      },
    }).catch(() => {});

    // Worth waking someone for: a verification being withdrawn is either a fraud
    // finding or a mistake, and both are things the next person on shift needs
    // to know happened without going looking for it.
    securityEvent('admin.kyc_revoked', 'Identity verification revoked', {
      user_id: Number(row.user_id),
      admin_id: admin?.id || null,
    });

    await notifyUser({
      userId: Number(row.user_id),
      subject: 'Identity verification withdrawn',
      message: `${reason} Your wallet is on hold until your identity is verified again. You can re-verify in Settings.`,
      type: 'kyc',
      data: { status: 'revoked' },
    }).catch(() => {});

    return ok(res, 'kyc_revoked', 'Verification revoked', { kyc: serialize(updated, { revealed: false }) });
  } catch (e) {
    console.error('adminKyc.revokeKyc error:', { user_id: req.params?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not revoke the verification');
  }
}

module.exports = {
  getUserKyc,
  revealUserKyc,
  listNinSlips,
  getNinSlip,
  verifyNinLookup,
  reviewNinSlip,
  revokeKyc,
  __test: { mask, serialize, slipListItem, last4, sameDob, sameGender, samePhone },
};
