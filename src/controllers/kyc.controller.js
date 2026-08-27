/**
 * Individual KYC: the BVN, through ArewaSmart.
 *
 * The BVN proves the person exists on the NIBSS banking register. That is what
 * identifies the human behind the wallet, which is all this gate exists to
 * establish - and it must resolve to the name on the VoltPay profile, which is
 * what stops a verified stranger's document from unlocking somebody else's
 * wallet.
 *
 * THE PROVIDER CHANGED ON 2026-08-25, AND SO DID THE SHAPE OF THE CHECK.
 * Payvessel was a match api: we sent the BVN plus six typed identity fields and
 * it graded them. ArewaSmart is a lookup api - we send the BVN alone and it
 * returns the register record. Three things follow, and they are why this file
 * no longer looks like the NIN-slip route beside it:
 *
 *   - THE FORM IS ONE FIELD. There is nothing to type but the number. The
 *     register is authoritative for the name, the date of birth, the gender and
 *     the phone, so asking the user to retype them would only add a way to be
 *     declined for a spelling. The NIN-slip route below still collects all six,
 *     because a photograph has nothing to score against.
 *   - THE NAME MATCH IS OURS. There is no provider score to read. The register's
 *     name is compared against the VoltPay profile here, with matchName() - the
 *     same helper the bank step uses, so both halves of verification agree on
 *     what "the same person" means.
 *   - IT IS PAID BY THE CUSTOMER. ₦60, debited from the wallet, PIN required
 *     like any other debit. See the fee section below for when it is and is not
 *     charged, which is the single most consequential rule in this file.
 *
 * NIN *number* verification was offered as an alternative for a time and has
 * been WITHDRAWN. The columns, the stored records and payvessel.verifyNin all
 * survive - identity data inside its retention period, and this repo has no git
 * history to recover a deleted file from - but nothing accepts a NIN any more,
 * and `nin_status` no longer opens the gate (see kycGate.rowIsVerified). POST
 * /kyc/nin/verify answers 410, not 404: installed APKs still call it, and "this
 * is gone, use your BVN" is an instruction where a 404 is a mystery.
 *
 * Calls:
 *   GET  /kyc/status        what the Settings screen renders
 *   POST /kyc/bvn/verify    BVN lookup - paid, PIN'd, verdict in the response
 *   POST /kyc/nin-slip      the free manual route, for a user with no BVN
 *   POST /kyc/bank/verify   the second half, required of everybody
 *
 * SYNCHRONOUS. The verdict is in the HTTP response, so there is no reference to
 * reconcile, no callback token, and no `pending` state to escape from on the BVN
 * path. A submission is decided by the time the request returns.
 *
 * Storage rules, same as the rest of the codebase:
 *   - every field here is regulated identity data, so all of it is AES-GCM
 *     ciphertext. The BVN also gets a blind index, which is what stops it from
 *     verifying two accounts without the number ever being stored in the clear.
 *   - nothing from the request body is ever logged. Not the BVN, not the PIN,
 *     not the names, not on the error path.
 *   - AND NOTHING FROM THE REGISTER IS EVER ECHOED. A lookup api hands back a
 *     real person's identity; repeat any of it to the client and this endpoint
 *     becomes a BVN-to-identity service for anybody with an account. The
 *     register's values are written to the encrypted columns and dropped.
 */
const crypto = require('crypto');

const { Prisma } = require('@prisma/client');
const prisma = require('../../database/prisma');
const arewasmart = require('../funding/arewasmart.service');
const paystack = require('../funding/paystack.service');
const { protect, reveal, blindIndex, revealUserFields, protectText, verifySecret } = require('../helpers/pii.helper');
const { uploadFile } = require('../helpers/upload.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { kycAllowance, rowIsVerified, hasIdentity, hasBank, verifiedVia } = require('../helpers/kycGate.helper');
const { matchName, profileName } = require('../helpers/nameMatch.helper');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { notifyUser } = require('../services/notify.service');
const { logUserEvent } = require('../services/userAudit.service');
const { invalidateUser } = require('../services/userCache.service');
const { securityEvent } = require('../services/alerts.service');

const GENDERS = new Map([
  ['male', 'Male'],
  ['m', 'Male'],
  ['female', 'Female'],
  ['f', 'Female'],
]);

/* ------------------------------------------------------------------- fee */

/**
 * What a BVN lookup costs the customer, in naira.
 *
 * Env-driven because it is a price, and a price set in code is a deploy every
 * time the provider moves theirs. Read per call rather than captured at module
 * load so it can be changed without a restart.
 *
 * WHEN IT IS CHARGED - the rule the whole flow is arranged around:
 *
 *   CHARGED on any lookup that COMPLETED. That includes "no such BVN" and it
 *   includes a register name that does not match the profile. Both are real
 *   answers from the register; the provider bills us for them exactly as it
 *   bills for a pass, and an endpoint that only charges on success is a free
 *   BVN-enumeration service running at our expense.
 *
 *   NEVER CHARGED when the lookup did not run: our token rejected, our prepaid
 *   balance empty, a timeout, a 500. Structurally, not by convention -
 *   arewasmart.verifyBvn returns an object only when it reached the register and
 *   throws for everything else, so there is no branch on which this fee can be
 *   taken for our own outage.
 *
 * The customer is told the price before they submit: `bvn_fee` rides in the
 * status response and in the step copy, so the screen quotes the server's number
 * rather than a hardcoded one that can drift.
 */
function bvnFee() {
  // The unset case is caught BEFORE the parse, and it has to be: `Number('')` is
  // 0, and 0 is a perfectly finite non-negative number, so parsing first turns
  // "nobody set KYC_BVN_FEE" into "the check is free" on every deployment that
  // has not been told about the variable yet. Same trap retry.helper documents.
  const raw = String(process.env.KYC_BVN_FEE ?? '').trim();
  if (!raw) return 60;
  const fee = Number(raw);
  return Number.isFinite(fee) && fee >= 0 ? fee : 60;
}

/**
 * THE FEE IS DELIBERATELY OUTSIDE THE KYC GATE, AND THAT IS LOAD-BEARING.
 *
 * kycGate freezes a wallet once it has received the unverified limit. If that
 * guard sat in front of this debit, a frozen user could not pay the fee, could
 * not verify, and could never thaw - the lock would be permanent and self
 * inflicted. `requireKyc` is route-level middleware and is deliberately absent
 * from kyc.routes.js; do not add it there.
 *
 * A user who genuinely cannot afford ₦60 is not stuck either: the NIN-slip route
 * is free, and the insufficient-balance message points at it rather than telling
 * them to fund a wallet they may not be able to fund.
 */
const CANNOT_AFFORD =
  amount =>
    `Verifying your BVN costs ₦${amount}, and your wallet balance is lower than that. ` +
    'You can fund your wallet and try again, or upload a photo of your NIN slip instead - that route is free, ' +
    'and our team reviews it within a day or two.';

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

function requireModel(res) {
  if (prisma.kycVerification) return true;
  res.status(500).json({
    remark: 'server_error',
    status: 'error',
    message: ['Missing Prisma model KycVerification. Run prisma generate + db push and restart.'],
    data: null,
  });
  return false;
}

/* ------------------------------------------------------------- validation */

// A BVN is exactly 11 digits. Anything else is a typo, and sending it costs a
// paid lookup to be told so.
function cleanBvn(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

// A NIN is also exactly 11 digits. Its own function rather than an alias of
// cleanBvn: the two are unrelated registers that happen to agree on a length,
// and one of them changing format should not silently change the other.
function cleanNin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  // Letters, spaces, hyphens and apostrophes - Nigerian names carry all three.
  return /^[A-Za-z][A-Za-z '-]{1,49}$/.test(name) ? name : null;
}

// YYYY-MM-DD, and it must be a real calendar date: "1990-02-31" parses in JS
// and rolls over to March, which would store a different birthday than the one
// typed and put a wrong date in front of the reviewer.
function cleanDob(value) {
  const raw = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;

  const ageMs = Date.now() - date.getTime();
  const years = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 16 || years > 120) return null;
  return raw;
}

/* ---------------------------------------------- typed identity details ----
 * THE NIN-SLIP ROUTE ONLY, since the BVN moved to a lookup api.
 *
 * A photograph cannot be scored, so the slip route still asks for the six fields
 * and puts them in front of a reviewer beside the image. The BVN route no longer
 * has any use for them: it reads the register instead, and asking a customer to
 * retype what we are about to look up would only add a way to be declined.
 *
 * Everything from here to the name-matching section serves that one route.
 */

// The keys a client sends when it is supplying identity details rather than
// asking us to reuse the stored ones. Presence of any of them means "parse the
// body strictly" - a half-filled form must produce the field-level error that
// tells the user what is missing, never a silent fall back to the saved row.
const IDENTITY_KEYS = [
  'first_name', 'firstname', 'last_name', 'lastname', 'middle_name', 'middlename',
  'phone_number', 'phone', 'mobile', 'dob', 'date_of_birth', 'gender',
];

function hasIdentityFields(body) {
  return IDENTITY_KEYS.some(key => String(body?.[key] ?? '').trim() !== '');
}

/**
 * The personal details the document is scored against.
 *
 * `label` names the document in the error text so the user knows which record
 * to copy from - the two registers do not always hold the same spelling, and
 * "as it appears on your NIN" is the instruction that gets the match.
 *
 * Returns `{ error }` for the caller to hand back, or the cleaned values.
 */
function parseIdentity(body, label = 'ID', fallback = {}) {
  const firstName = cleanName(body.first_name ?? body.firstname);
  if (!firstName) return { error: `Enter your first name as it appears on your ${label}` };

  const lastName = cleanName(body.last_name ?? body.lastname);
  if (!lastName) return { error: `Enter your last name as it appears on your ${label}` };

  // Optional: plenty of records carry no middle name.
  const rawMiddle = String(body.middle_name ?? body.middlename ?? '').trim();
  const middleName = rawMiddle ? cleanName(rawMiddle) : '';
  if (rawMiddle && !middleName) return { error: 'Enter a valid middle name' };

  // The one field a form never has to ask for. Every route that parses an
  // identity is authenticated, so the number on the account is the number the
  // user signed in with - asking them to retype it adds a field whose only two
  // outcomes are "the same" and "a typo we then file against their wallet".
  // The body still wins when it carries one, because a document can legitimately
  // hold a different number to the account.
  const phone = normalizeNgPhone(body.phone_number ?? body.phone ?? body.mobile)
    || normalizeNgPhone(fallback.phone);
  if (!phone) return { error: 'Enter a valid Nigerian phone number' };

  const dob = cleanDob(body.dob ?? body.date_of_birth);
  if (!dob) return { error: 'Enter your date of birth as YYYY-MM-DD' };

  // Optional, and deliberately so. `gender` is nullable because a BVN lookup
  // writes back whatever the register returned and the register does not always
  // carry one - so a null here is a state the reviewer screen already renders
  // rather than a new one. It gates nothing, and a mandatory field that gates
  // nothing is friction on the free route, which is the route a wallet frozen
  // by the gate has to be able to reach.
  const gender = GENDERS.get(String(body.gender ?? '').trim().toLowerCase()) || null;

  return { firstName, middleName, lastName, phone, dob, gender };
}

// What a caller sees when neither the request nor the row can produce a usable
// set of details. Phrased as a plain instruction because there is no earlier
// step to send anyone back to - the form in front of them is the one to fill.
const NEED_DETAILS = 'Enter your name, date of birth, gender and phone number to verify this document';

/**
 * The same details, read back off a row an earlier submission wrote.
 *
 * Decrypted per request and held only long enough to build the record. A row
 * that cannot produce a full set is reported as an error rather than passed on
 * with blanks - which is now the ordinary case rather than a legacy one, because
 * a BVN lookup writes only what the register returned and the register does not
 * always carry a date of birth. Blank fields in front of a reviewer are worse
 * than a form, so the user is asked.
 */
function identityFromRow(row) {
  try {
    const firstName = row?.first_name_enc ? reveal(row.first_name_enc) : null;
    const lastName = row?.last_name_enc ? reveal(row.last_name_enc) : null;
    const dob = row?.dob_enc ? reveal(row.dob_enc) : null;
    const phoneRaw = row?.phone_enc ? reveal(row.phone_enc) : null;
    const phone = phoneRaw ? normalizeNgPhone(phoneRaw) : null;

    if (!firstName || !lastName || !dob || !phone || !row?.gender) {
      return { error: NEED_DETAILS };
    }

    return {
      firstName,
      middleName: row.middle_name_enc ? reveal(row.middle_name_enc) || '' : '',
      lastName,
      phone,
      dob,
      gender: row.gender,
    };
  } catch {
    // A column we cannot decrypt must not 500. Ask for the details again - the
    // form rewrites all of them.
    return { error: 'We could not read your saved details. Please enter them again.' };
  }
}

/**
 * Where one submission's identity details come from: the body, or the row.
 *
 * The body wins whenever it carries any of them. Falling back to the row is a
 * convenience, not a shortcut: it only spares someone retyping six fields they
 * already gave us, and the details are still matched against the profile name on
 * every submission, so a reused set is checked exactly as hard as a freshly
 * typed one.
 *
 * The row it reads back may have been written by a BVN lookup rather than by a
 * form, in which case the details are the REGISTER's - which is the better
 * prefill, not a worse one.
 *
 * `fromBody` tells the caller whether there is anything new to persist.
 *
 * `fallback` fills the fields the FORM does not carry, and is what stops the
 * strict branch from demanding six fields off a client that only ever sends
 * four. It is not a third source of identity - it holds the profile's own
 * mobile, which this route already authenticated against.
 */
function resolveIdentity(body, row, label, fallback = {}) {
  if (hasIdentityFields(body)) {
    const parsed = parseIdentity(body, label, fallback);
    return parsed.error ? parsed : { ...parsed, fromBody: true };
  }

  const stored = identityFromRow(row);
  return stored.error ? stored : { ...stored, fromBody: false };
}

/* ----------------------------------------------------------- name matching */

/**
 * The name on this user's VoltPay profile, decrypted.
 *
 * Read through revealUserFields rather than off the row: the plain `firstname`
 * column is only populated on accounts that predate the PII migration, so
 * reading it directly would compare a live account against an empty string and
 * fail every match.
 */
function nameOnProfile(user) {
  return profileName(revealUserFields(user));
}

/**
 * The mobile on this user's VoltPay profile, decrypted. Read the same way and
 * for the same reason as [nameOnProfile] - the plain `mobile` column is only
 * populated on accounts predating the PII migration.
 */
function phoneOnProfile(user) {
  return revealUserFields(user).mobile || null;
}

/**
 * Friendly wording for a failed name check.
 *
 * Deliberately never echoes the name the register returned. Repeating it back
 * would turn this endpoint into a lookup service: type any number, read out
 * whose it is. The user's own profile name is safe to show - it is their
 * account, they are authenticated, and it is the thing they need to see to
 * understand what went wrong.
 */
function nameMismatchMessage(result, expected, subject) {
  if (result.reason === 'incomplete_profile') {
    return 'Add your full first and last name to your VoltPay profile before verifying - we need it to check that ' +
      `${subject} belongs to you.`;
  }
  if (result.reason === 'no_name') {
    return `We could not read a name for ${subject}. Please check the details and try again.`;
  }
  return `The name on ${subject} does not match your VoltPay profile, which says "${expected}". ` +
    'Please use your own details, or update your profile name in Settings if it is wrong.';
}

/* --------------------------------------------------------------- the doc */

/**
 * Which columns one document's number and verdict live in.
 *
 * One entry, since NIN was withdrawn. The table survives the removal on purpose:
 * it is what keeps the column names out of the flow below, and this rule has now
 * changed direction four times (BVN, then BVN-and-NIN, then either, now BVN
 * alone through a different provider). Re-adding a document here is a data
 * change; unpicking hardcoded column names in a money-gating path is not.
 *
 * `verify` takes the number and nothing else now. That is the ArewaSmart switch
 * in one line: the old signature carried six typed identity fields for the
 * provider to grade, and there is nothing left to send.
 */
const DOCUMENTS = {
  bvn: {
    label: 'BVN',
    clean: cleanBvn,
    verify: number => arewasmart.verifyBvn({ bvn: number }),
    // Where the number and the verdict live.
    encField: 'bvn_enc',
    idxField: 'bvn_idx',
    statusField: 'status',
    reasonField: 'decline_reason',
    matchField: 'bvn_match',
    verifiedAtField: 'verified_at',
  },
};

/**
 * What the app should put in front of the user next:
 *   bvn              - no identity document yet. Start here.
 *   nin_slip_review  - their slip is in our queue. Waiting on US, not on them.
 *   bank_account     - identity is done, the bank account is the last step.
 *   null             - nothing outstanding.
 *
 * Order matters and is not arbitrary. Identity comes first because the bank
 * step needs the row the identity step creates, and because the name the bank
 * check matches against is the one the identity step established.
 *
 * `nin_slip_review` before `bank_account` is a UX call, not a technical one: a
 * user can do the bank step while their slip is in the queue, and the screen
 * should let them. This is only what to lead with, and "we are working on it"
 * is the more important thing to say.
 *
 * `'bvn'` stays the value for "start at the beginning" rather than becoming a
 * new sentinel, because installed APKs branch on this value and an unrecognised
 * one renders as a dead screen.
 */
function nextStep(row) {
  if (rowIsVerified(row)) return null;
  if (!hasIdentity(row)) return row?.nin_slip_status === 'pending' ? 'nin_slip_review' : 'bvn';
  return 'bank_account';
}

/**
 * What leaves the server.
 *
 * No identity number is echoed back - not the BVN, not the NIN. The user typed
 * them, they do not need them read back, and every echo is another place an
 * identity number can end up in a log or a screenshot. The slip URL is not
 * echoed either: it is a bearer link to a photograph of a government document,
 * and the only party who needs it is the admin reviewing it.
 */
function publicKyc(row) {
  if (!row) return null;

  return {
    // The BVN. Synchronous, so this is never `pending`.
    status: row.status,
    decline_reason: row.decline_reason || null,
    submitted_at: row.submitted_at,
    verified_at: row.verified_at,

    // The NIN, HISTORICAL ONLY. Nothing writes these any more and they do not
    // affect the gate. Still sent so an installed APK that renders a NIN card
    // gets a well-formed answer instead of undefined; on any row submitted from
    // here on they are permanently 'none' / null.
    nin_status: row.nin_status || 'none',
    nin_decline_reason: row.nin_decline_reason || null,
    nin_verified_at: row.nin_verified_at || null,

    // The NIN SLIP - the live manual path, and not the three keys above it.
    // none | pending | approved | declined | revoked. `pending` is real here,
    // unlike the BVN: a human has to look at it.
    nin_slip_status: row.nin_slip_status || 'none',
    nin_slip_decline_reason: row.nin_slip_decline_reason || null,
    nin_slip_submitted_at: row.nin_slip_submitted_at || null,
    nin_slip_reviewed_at: row.nin_slip_reviewed_at || null,

    // THE BANK ACCOUNT - required of everybody, whichever identity route they
    // took. The number is masked, never echoed; the bank and the resolved name
    // are shown because the user needs to see which account is on their wallet.
    bank_status: row.account_status || 'none',
    bank_decline_reason: row.account_decline_reason || null,
    bank_name: row.bank_name || null,
    bank_account_name: row.account_name_enc ? reveal(row.account_name_enc) : null,
    bank_account_masked: row.account_number_enc
      ? `****${String(reveal(row.account_number_enc) || '').slice(-4)}`
      : null,
    bank_verified_at: row.account_verified_at || null,

    // The two requirements, reported separately, so the screen can render two
    // steps with two ticks instead of one opaque boolean.
    identity_done: hasIdentity(row),
    bank_done: hasBank(row),

    // Which identity route was taken, so the screen can say "Verified with your
    // BVN" rather than leaving the user to guess which of the two we accepted.
    // Non-null on a row that is not yet fully verified - that is the
    // one-step-left state, not a bug.
    verified_via: verifiedVia(row),

    // BOTH requirements met. The key keeps the name it had under the older rules
    // so an already-installed APK still reads it; what has changed underneath is
    // the rule, never the shape of the answer.
    fully_verified: rowIsVerified(row),

    // bvn | nin_slip_review | bank_account | null. See nextStep.
    next_step: nextStep(row),
  };
}

/* -------------------------------------------------------------- GET status */

async function status(req, res) {
  try {
    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');

    const row = prisma.kycVerification
      ? await prisma.kycVerification.findUnique({ where: { user_id: Number(user.id) } })
      : null;
    const allowance = await kycAllowance(user.id);
    const fee = bvnFee();
    // Display only, and it comes off the cached row on purpose - the screen is
    // showing the user roughly what they have, not making a spend decision. The
    // decision is made against a fresh row inside the submission's transaction.
    const balance = Number(user.balance?.toString?.() ?? user.balance ?? 0);

    return ok(res, 'kyc_status', 'OK', {
      verification: publicKyc(row),
      // The name every check has to agree with, so the form can prefill it and
      // the user is not guessing at what we hold.
      profile_name: nameOnProfile(user),
      // What a BVN lookup costs, quoted by the server so the screen, the receipt
      // and the debit can never disagree about the price. `can_afford_bvn` saves
      // the app from doing naira arithmetic to decide whether to lead with the
      // free route instead.
      bvn_fee: fee,
      can_afford_bvn: Number.isFinite(balance) && balance >= fee,
      // `verified` here is the gate's own answer, not the row's - they can only
      // differ if the gate is switched off, and the app should follow the gate.
      verified: allowance.verified,
      limit: allowance.limit,
      // How much has landed in the virtual account, and how much more it can
      // take before the wallet locks. `locked` is the one the app acts on.
      funded: allowance.funded,
      remaining: allowance.remaining,
      locked: allowance.locked,
      // Which identity route was taken, or null. The gate's own answer.
      method: allowance.method,
      // The two requirements as the gate sees them, so the screen's ticks and
      // the gate's verdict can never disagree.
      identity_done: allowance.identity_done,
      bank_done: allowance.bank_done,
      bank_required: allowance.bank_required,
      // What the screen tells the user they unlock.
      requirement:
        'A wallet that receives the unverified limit or more is held until your identity is verified. ' +
        'Verify your identity and add your bank account to unlock it.',
      // The flow, in the server's words, so the app and the admin dashboard
      // cannot drift apart on what was promised or how long it takes. Changing a
      // timescale here changes it everywhere it is quoted.
      steps: [
        {
          key: 'identity',
          title: 'Verify your identity',
          detail: 'Choose one - your BVN, or a photo of your NIN slip.',
          done: allowance.identity_done,
          options: [
            {
              key: 'bvn',
              title: 'Verify with BVN',
              subtitle: `Takes seconds · ₦${fee}`,
              detail:
                `We look your BVN up on the banking register and confirm you instantly. The ₦${fee} check fee is ` +
                'charged once the lookup runs, whether or not it matches - so enter your own BVN carefully.',
              instant: true,
              // Recommended while they can pay for it. A screen that leads with a
              // paid option the wallet cannot cover sends the user to a dead end
              // and then makes them find their own way back.
              recommended: Number.isFinite(balance) && balance >= fee,
              fee,
              // Priced separately from `fee` so a future free promotion is a
              // value change rather than a schema change on the client.
              free: fee === 0,
            },
            {
              key: 'nin_slip',
              title: 'Upload NIN slip',
              subtitle: 'Takes 1-2 days · Free',
              detail: 'No BVN? Upload a clear photo of your NIN slip and our team will review it by hand. There is no charge for this.',
              instant: false,
              recommended: !(Number.isFinite(balance) && balance >= fee),
              fee: 0,
              free: true,
            },
          ],
        },
        {
          key: 'bank_account',
          title: 'Add your bank account',
          detail: 'Required for everyone. We confirm the account is in your name - it takes a second and costs nothing.',
          done: allowance.bank_done,
          options: [],
        },
      ],
    });
  } catch (e) {
    console.error('kyc.status error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load your verification status');
  }
}

/* ---------------------------------------------------- finishing the record */

/**
 * Called whenever a document lands. Opens the wallet if the row now passes the
 * gate.
 *
 * Written as "check the predicate, then act" rather than "we just verified a
 * BVN, so open it". The gate is the one place the rule lives, and this has to
 * agree with it - which is exactly what let the rule change three times without
 * this function needing an edit.
 *
 * Idempotent: it re-reads the predicate, so two checks completing close together
 * cannot double-notify or leave `kv` disagreeing with the gate.
 */
async function finalizeIfVerified({ req, userId, row }) {
  if (!rowIsVerified(row)) return false;

  // The dashboard still reads the legacy `kv` flag to decide whether to show
  // the "verify your identity" card, so a verified user has to flip it or the
  // card outlives the verification it is asking for.
  const updated = await prisma.user.updateMany({
    where: { id: Number(userId), kv: { not: '1' } },
    data: { kv: '1' },
  });
  await invalidateUser(userId);

  // updateMany reports how many rows it changed, so this only fires on the
  // transition - a repeated submission does not send a second "verified" push
  // to somebody who was already told.
  if (updated.count === 0) return false;

  await logUserEvent({
    req,
    userId,
    event: 'kyc.verified',
    metadata: { reference: row.reference },
  }).catch(() => {});

  await notifyUser({
    userId: Number(userId),
    subject: 'Identity verified',
    message: 'Your identity is verified. Your wallet is unlocked - you can spend and receive without limits.',
    type: 'kyc',
    data: { status: 'verified' },
  }).catch(() => {});

  return true;
}

/* --------------------------------------------------------- the shared flow */

/**
 * Turn the register record into the encrypted identity columns.
 *
 * This is where the ArewaSmart switch pays for itself: under the old match api
 * these columns held whatever the customer typed, which had passed a grading but
 * was still their transcription of their own document. Now they hold what the
 * register actually says. Nothing is copied from the request.
 *
 * Every field but the two names is optional. The BVN register carries a date of
 * birth, a phone and a gender for virtually everybody, but "virtually" is not
 * "always", and a missing field must not become a failed write on a lookup the
 * customer has already paid for - which is why those columns are nullable. The
 * phone falls back to the number on the VoltPay account, which is a number we
 * know belongs to this person because they logged in with it.
 */
function identityColumnsFrom(record, user) {
  const columns = {
    first_name_enc: protect(record.firstName, 'name').enc,
    middle_name_enc: record.middleName ? protect(record.middleName, 'name').enc : null,
    last_name_enc: protect(record.lastName, 'name').enc,
    dob_enc: record.dateOfBirth ? protect(record.dateOfBirth, 'dob').enc : null,
    gender: record.gender ? GENDERS.get(record.gender.toLowerCase()) || null : null,
    submitted_at: new Date(),
    // Synchronous provider: nothing calls back and no token is handed out.
    // Cleared rather than left holding a stale unique value.
    callback_token: null,
  };

  const phone = record.phoneNumber || revealUserFields(user)?.mobile || null;
  const normalized = phone ? normalizeNgPhone(phone) : null;
  columns.phone_enc = normalized ? protect(normalized.msisdn, 'mobile').enc : null;

  return columns;
}

/**
 * Run the BVN check end to end. Paid, so the order of everything here is about
 * money.
 *
 * THREE PHASES, AND THE BOUNDARY BETWEEN THEM IS THE POINT.
 *
 * 1. FREE GUARDS. Everything that can decline without spending anything:
 *    already verified, wrong length, no PIN, wrong PIN, an unusable profile
 *    name, the number already claimed by another account, and finally "can this
 *    wallet even afford the fee". A decline we can reach on our own is a decline
 *    nobody should pay for - not the customer, and not us.
 *
 * 2. THE PAID LOOKUP. One call. Past this line the register has answered and the
 *    customer owes ₦60 whatever the answer was.
 *
 * 3. SETTLE. One transaction: take the fee, write the verdict, write the ledger
 *    row. All three or none of them.
 *
 * Failure modes are split deliberately, and the split is enforced by the service
 * rather than by care here:
 *   - the register answered "no such BVN", or answered with somebody else's name
 *     -> the customer's check failed. Recorded, charged, and they can retry.
 *   - the provider never answered, or rejected our token, or is out of credit
 *     -> OUR problem. Nothing is written, nothing is charged, 503. Burning
 *     somebody's ₦60 over our empty prepaid balance is not a decline, it is
 *     theft with extra steps.
 */
async function submitDocument(req, res, kind) {
  const doc = DOCUMENTS[kind];

  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');
    if (!arewasmart.isConfigured()) {
      return fail(res, 503, 'unavailable', 'Identity verification is temporarily unavailable');
    }

    const existing = await prisma.kycVerification.findUnique({ where: { user_id: Number(user.id) } });
    // A verified row has nothing left to submit. Refusing it is not pedantry:
    // it would cost the customer another ₦60 to reach a conclusion this row
    // already holds, and it would not move the gate one inch.
    if (rowIsVerified(existing)) {
      return fail(res, 400, 'already_verified', 'Your identity is already verified', {
        verification: publicKyc(existing),
      });
    }
    // The same waste, one step earlier, and NOT covered by the check above since
    // verification became identity AND bank: a user whose identity is settled
    // and whose bank account is not reads as unverified there, so the guard let
    // them pay for a lookup that cannot move the gate.
    //
    // Keyed on `hasIdentity`, not on this document's own status column. The
    // identity half is satisfied by EITHER route - a verified BVN or an approved
    // NIN slip - so a customer whose slip came back approved while their bank
    // step was still outstanding would otherwise be charged ₦60 to establish
    // something we already know. That is the exact user the free route exists
    // for, being billed for having used it.
    if (hasIdentity(existing)) {
      return fail(
        res,
        400,
        'already_verified',
        'Your identity is already verified. Add and verify your bank account to unlock your wallet.',
        { verification: publicKyc(existing) },
      );
    }

    const body = req.body || {};
    const number = doc.clean(body[kind]);
    if (!number) return fail(res, 400, 'validation_error', `Enter a valid 11-digit ${doc.label}`);

    // The PIN, exactly as every other wallet debit takes it. Checked against a
    // FRESH row: req.user can be a cached copy, and a PIN check never runs
    // against one.
    const pin = String(body.pin ?? '').trim();
    if (!pin) return fail(res, 400, 'validation_error', 'Enter your PIN to confirm the verification fee');

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return fail(res, 401, 'unauthorized', 'Please login again');
    if (!(await verifySecret(pin, freshUser.pin, 'pin')).ok) {
      return fail(res, 401, 'invalid_pin', 'Incorrect PIN');
    }

    // The profile name is what the register will be matched against, so a
    // profile that cannot produce one is a guaranteed decline. Catching it here
    // means the customer is told to fix their profile for free, instead of
    // paying the fee to be told the same thing.
    //
    // Matching the name against ITSELF is the idiom on purpose: it asks
    // matchName whether this profile is usable at all, without this file having
    // its own opinion about how many words that takes. A second definition of
    // "usable" here would be a second thing to keep in step with the helper.
    const expected = nameOnProfile(user);
    const profileCheck = matchName(expected, expected);
    if (!profileCheck.ok) {
      return fail(res, 400, 'name_mismatch', nameMismatchMessage(profileCheck, expected, `your ${doc.label}`), {
        verification: publicKyc(existing),
        profile_name: expected,
      });
    }

    // One document, one account. Checked on the blind index, so the comparison
    // never needs the number in plain text - and a second account trying the
    // same number is exactly the signal worth alerting on.
    const idx = blindIndex(number, kind);
    const claimedBy = await prisma.kycVerification.findFirst({
      where: { [doc.idxField]: idx, user_id: { not: Number(user.id) } },
      select: { user_id: true },
    });
    if (claimedBy) {
      securityEvent(`kyc.${kind}_reuse`, `${doc.label} already attached to another account`, {
        user_id: Number(user.id),
        existing_user_id: claimedBy.user_id,
      });
      return fail(res, 409, `${kind}_in_use`, `This ${doc.label} is already linked to another VoltPay account`);
    }

    // Can they afford it? A pre-flight read, not the guard - the real one is
    // inside the transaction below, against a row read there. This one exists so
    // we do not spend a provider call on a wallet that was never going to be
    // able to settle it.
    const fee = bvnFee();
    const balanceNow = Number(freshUser.balance?.toString?.() ?? freshUser.balance ?? 0);
    if (!Number.isFinite(balanceNow) || balanceNow < fee) {
      return fail(res, 400, 'insufficient_balance', CANNOT_AFFORD(fee), {
        verification: publicKyc(existing),
        fee,
        balance: balanceNow,
      });
    }

    /* ------------------------------------------------- the paid boundary --
     * Everything above is free. Everything below is owed. `verifyBvn` returns
     * an object only when the register answered; anything else throws with
     * statusCode 503 and lands in the catch, where nothing is written and
     * nothing is charged.
     */
    const lookup = await doc.verify(number);

    // The match is ours now - there is no provider score to read. The register's
    // full name against the VoltPay profile, through the same helper the bank
    // step uses, so both halves of verification agree on what "the same person"
    // means. Note this finally reads the middle name, which the old provider
    // took and never scored.
    const record = lookup.record;
    const registerName = record
      ? [record.firstName, record.middleName, record.lastName].filter(Boolean).join(' ')
      : '';
    const nameCheck = matchName(expected, registerName);
    const verified = lookup.found && nameCheck.ok;

    const reason = !lookup.found
      ? 'We could not find that BVN. Check the number and try again.'
      : 'The name on that BVN does not match your VoltPay profile. ' +
        `Your profile says "${expected}" - use your own BVN, or update your profile in Settings if it is wrong.`;

    const data = {
      [doc.encField]: protect(number, kind).enc,
      // The index is claimed only by a verified document. A failed attempt must
      // not lock the number out of the account that really owns it.
      [doc.idxField]: verified ? idx : null,
      [doc.statusField]: verified ? 'verified' : 'failed',
      [doc.reasonField]: verified ? null : reason,
      // AUDIT ONLY, AND DELIBERATELY VALUE-FREE. Under the match api this column
      // held the provider's labels, which were safe because they described the
      // comparison rather than the person. A lookup api gives us the person, so
      // the same column now holds counts and a reference and nothing else -
      // never a name, never a fragment of one. `nameCheck.missing` in particular
      // holds pieces of a real name and must not be stored or logged.
      [doc.matchField]: {
        provider: 'arewasmart',
        reference: lookup.reference || null,
        found: lookup.found,
        name_ok: nameCheck.ok,
        name_tokens_expected: nameCheck.expectedTokens.length,
        name_tokens_matched: nameCheck.matched,
        fee,
        checked_at: new Date().toISOString(),
      },
      [doc.verifiedAtField]: verified ? new Date() : null,
    };

    // The register's own details, written ONLY on a verification that actually
    // succeeded - `verified`, not `lookup.found`.
    //
    // The difference is the whole risk of a lookup api. A found-but-mismatched
    // BVN is a real person's register record, and it is not this customer's:
    // somebody typing a relative's number, or a digit wrong into a live BVN,
    // gets a stranger's name, date of birth and phone handed back. Keying on
    // `found` would file all of it against their wallet, encrypted but retained,
    // on a check we had just declined - and `identityFromRow` would then offer
    // that stranger's details as the prefill for their free NIN-slip attempt,
    // putting a name in front of a reviewer that the customer never typed.
    //
    // A lookup that did not verify establishes nothing about who is holding this
    // account, so it writes the verdict and leaves these columns exactly as they
    // were: empty on a first attempt, and whatever an earlier success
    // established on a retry.
    if (verified) Object.assign(data, identityColumnsFrom(record, user));

    const trx = `kycbvn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const debit = new Prisma.Decimal(fee.toFixed(2));
    const zero = new Prisma.Decimal('0.00');
    const feeDetails = `BVN verification fee`;

    let saved;
    try {
      await prisma.$transaction(async tx => {
        // The real balance guard, against a row read inside the transaction.
        //
        // Losing here means a concurrent spend emptied the wallet in the
        // milliseconds since the pre-flight check. We have already paid the
        // provider and we roll the whole thing back anyway: the alternative is
        // recording a verification we were not paid for, or charging a wallet
        // that cannot cover it. We eat one provider fee on a genuinely rare
        // race; the customer is told the truth and can retry.
        const row = await tx.user.findUnique({ where: { id: Number(user.id) } });
        const balance = Number(row?.balance?.toString?.() ?? row?.balance ?? 0);
        if (!Number.isFinite(balance) || balance < fee) {
          const err = new Error('Insufficient balance');
          err.code = 'INSUFFICIENT';
          throw err;
        }

        await applyBalanceDelta(tx, 'user', user.id, debit.negated());

        saved = existing
          ? await tx.kycVerification.update({ where: { user_id: Number(user.id) }, data })
          : await tx.kycVerification.create({
            data: {
              ...data,
              user_id: Number(user.id),
              reference: `kyc_${user.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            },
          });

        await tx.walletTransaction.create({
          data: {
            user_id: Number(user.id),
            trx,
            trx_type: '-',
            amount: debit,
            charge: zero,
            total_amount: debit,
            remark: 'kyc_bvn_verification',
            details: protectText(feeDetails),
            other_data: {
              title: 'BVN verification',
              subtitle: protectText(feeDetails),
              // The fee is owed on a completed lookup, so a declined check still
              // reads "Successful" as a TRANSACTION - the service was delivered,
              // the answer was just no. `note` carries the outcome so the
              // statement does not look like a silent deduction.
              feedback: 'Successful',
              note: verified ? 'Verified' : 'Not verified',
              image_src: '',
            },
            // Ids and our own references only. Never the BVN, never a name.
            meta: {
              source: 'wallet',
              kyc_reference: saved.reference,
              provider: 'arewasmart',
              provider_reference: lookup.reference || null,
              verified,
            },
          },
        });
      });
    } catch (e) {
      if (e?.code === 'INSUFFICIENT') {
        return fail(res, 400, 'insufficient_balance', CANNOT_AFFORD(fee), {
          verification: publicKyc(existing),
          fee,
        });
      }
      // P2002 = the unique index is taken, so the same number verified on
      // another account between our check above and this write. That is a
      // decline for this one, not a crash - and the transaction rolled back, so
      // they were not charged for it either.
      if (e?.code !== 'P2002') throw e;
      securityEvent(`kyc.${kind}_reuse`, `${doc.label} claimed by another account mid-submission`, {
        user_id: Number(user.id),
      });
      return fail(res, 409, `${kind}_in_use`, `This ${doc.label} is already linked to another VoltPay account`);
    }

    await logUserEvent({
      req,
      userId: user.id,
      event: verified ? `kyc.${kind}_verified` : `kyc.${kind}_failed`,
      // `charged` reconciles provider spend against attempts, and it is always
      // true down here: reaching this line means the register answered, and a
      // completed lookup is billed whatever it said. It stays an explicit field
      // rather than an implied one so the audit row states the fact instead of
      // leaving it to be inferred from the code that wrote it.
      metadata: {
        reference: saved.reference,
        charged: true,
        fee,
        trx,
        provider_reference: lookup.reference || null,
      },
    }).catch(() => {});

    if (!verified) {
      await notifyUser({
        userId: Number(user.id),
        subject: `${doc.label} verification failed`,
        message: `${saved[doc.reasonField]} The ₦${fee} check fee has been charged as the lookup was completed.`,
        type: 'kyc',
        data: { status: 'failed', document: kind },
      }).catch(() => {});

      return fail(res, 400, `${kind}_failed`, saved[doc.reasonField], {
        verification: publicKyc(saved),
        fee,
        charged: true,
      });
    }

    // May or may not complete the picture. A verified BVN is the identity half;
    // the bank account is the other half and is required of everybody. The
    // predicate decides, not this function - and it is the same call the bank
    // route makes, so there is one implementation of "unlock" and not two.
    await finalizeIfVerified({ req, userId: user.id, row: saved });

    // The wording has to follow the predicate too. Telling somebody their wallet
    // is unlocked while rowIsVerified() would still refuse them is not a
    // cosmetic slip: they close the screen, try to pay, and get a refusal that
    // contradicts the sentence we just showed them.
    return ok(
      res,
      `kyc_${kind}_verified`,
      rowIsVerified(saved)
        ? `Your ${doc.label} is verified. Your identity is confirmed and your wallet is unlocked.`
        : `Your ${doc.label} is verified. Add and verify your bank account to unlock your wallet - it takes a second, and it is free.`,
      { verification: publicKyc(saved), fee, charged: true },
    );
  } catch (e) {
    // 503 means the register was never read: a rejected token, an empty prepaid
    // balance at the provider, a timeout, an upstream 500. OUR problem in every
    // case, so the row is left exactly as it was, NOTHING IS CHARGED, and the
    // customer is asked to come back rather than marked failed over it.
    if (e?.statusCode === 503) {
      // `reason` is the service's own one-word classification - auth, billing,
      // rate_limit, upstream, unexpected_shape - and it is the only thing here
      // that says what to actually do, where our customer-facing message is
      // deliberately vague. Logged server-side only. It is a fixed vocabulary,
      // never the provider's body, so there is no chance of a register value
      // reaching a log line through it.
      console.error(`kyc.submit${kind} provider unavailable:`, {
        user_id: req.user?.id,
        message: e?.message,
        reason: e?.arewasmart?.reason || null,
      });
      return fail(res, 503, 'unavailable', 'Identity verification is temporarily unavailable. Please try again shortly. You have not been charged.');
    }

    // `e.message` only. Never the request body - it holds an identity number and
    // a PIN.
    console.error(`kyc.submit${kind} error:`, { user_id: req.user?.id, message: e?.message });
    return fail(
      res,
      e?.statusCode && e.statusCode < 500 ? e.statusCode : 502,
      'error',
      `Could not verify your ${doc.label}. Please try again.`,
    );
  }
}

/* ------------------------------------------------------------- the routes */

/**
 * POST /kyc/bvn/verify   { bvn, pin }
 *
 * Two fields, and that is the whole form. ArewaSmart reads the register and
 * hands back the record, so there is nothing for the customer to transcribe -
 * and nothing for them to be declined over transcribing wrongly. The PIN is
 * there because this debits the wallet ₦60, like any other debit.
 *
 * Verdict inline: the register answers within the request.
 */
async function submitBvn(req, res) {
  return submitDocument(req, res, 'bvn');
}

/**
 * POST /kyc/nin-slip - the manual path, for a user with no BVN.
 *
 * multipart/form-data: `slip` (the photograph) + `nin` + the identity details,
 * which may be omitted if an earlier submission already stored them.
 *
 * This is the OPPOSITE trust model to the BVN route above it. Nothing here is
 * checked against a register - a photograph is not evidence a machine can score
 * - so the endpoint's whole job is to get a legible document and a consistent
 * set of details in front of a human being, and then get out of the way. The
 * verdict is `pending` and it stays pending until an admin says otherwise.
 *
 * Because the reviewer is a person, their attention is the scarce resource, and
 * every guard below exists to spend less of it: the free checks that would end
 * in a decline anyway run here, so the queue holds only slips that are worth
 * opening.
 */
async function submitNinSlip(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');

    const existing = await prisma.kycVerification.findUnique({ where: { user_id: Number(user.id) } });

    if (rowIsVerified(existing)) {
      return fail(res, 400, 'already_verified', 'Your identity is already verified', {
        verification: publicKyc(existing),
      });
    }
    // One slip in the queue at a time. Without this the user who does not see an
    // instant result submits again, and a reviewer opens the same document three
    // times - which is the one cost this path cannot absorb.
    if (existing?.nin_slip_status === 'pending') {
      return fail(res, 400, 'nin_slip_pending', 'Your NIN slip is already under review. This usually takes a day or two.', {
        verification: publicKyc(existing),
      });
    }

    if (!req.file) return fail(res, 400, 'validation_error', 'Attach a clear photo of your NIN slip');

    const body = req.body || {};
    const nin = cleanNin(body.nin);
    if (!nin) return fail(res, 400, 'validation_error', 'Enter the 11-digit NIN printed on your slip');

    // The slip form asks for a name, a date of birth and the number - not a
    // phone, because the account already carries one and this request arrived
    // authenticated against it.
    const details = resolveIdentity(body, existing, 'NIN slip', { phone: phoneOnProfile(user) });
    if (details.error) return fail(res, 400, 'validation_error', details.error);

    // Same profile-name guard as the BVN route, and here it saves a person's
    // time rather than ₦30. A slip whose name does not match the account is
    // going to be declined; telling the user now, for free, is strictly better
    // than telling them in two days.
    const expected = nameOnProfile(user);
    const typed = [details.firstName, details.middleName, details.lastName].filter(Boolean).join(' ');
    const nameCheck = matchName(expected, typed);
    if (!nameCheck.ok) {
      return fail(res, 400, 'name_mismatch', nameMismatchMessage(nameCheck, expected, 'your NIN slip'), {
        verification: publicKyc(existing),
        profile_name: expected,
      });
    }

    // One NIN, one account - checked on the blind index, so the comparison never
    // needs the number in plain text.
    //
    // Unlike the BVN route, a PENDING slip claims the index too. A pending row
    // lives for a day or two, which is ample time for the same number to be
    // submitted on a second account, and two identical slips in the queue is
    // precisely the fraud a reviewer is least likely to spot - they see one
    // screen at a time. A decline releases the claim (see reviewNinSlip), so a
    // rejected attempt cannot lock the number away from whoever really owns it.
    const idx = blindIndex(nin, 'nin_slip');
    const claimedBy = await prisma.kycVerification.findFirst({
      where: { nin_slip_number_idx: idx, user_id: { not: Number(user.id) } },
      select: { user_id: true },
    });
    if (claimedBy) {
      securityEvent('kyc.nin_slip_reuse', 'NIN already attached to another account', {
        user_id: Number(user.id),
        existing_user_id: claimedBy.user_id,
      });
      return fail(res, 409, 'nin_in_use', 'This NIN is already linked to another VoltPay account');
    }

    // Upload before the write, so a storage failure leaves no row pointing at a
    // document that does not exist. protectText, not the raw URL: an UploadThing
    // link is a bearer token for a photograph of a government ID, so storing it
    // in plain text would make a read-only database leak into a KYC leak.
    const uploaded = await uploadFile(req.file, { prefix: `kyc_nin_slip_${user.id}` });
    const ninPii = protect(nin, 'nin_slip');

    const data = {
      nin_slip_url_enc: protectText(uploaded.url),
      nin_slip_number_enc: ninPii.enc,
      nin_slip_number_idx: idx,
      nin_slip_status: 'pending',
      nin_slip_submitted_at: new Date(),
      // A resubmission after a decline starts clean. Leaving the old reason on
      // the row would show the user the last rejection next to their new pending
      // slip, which reads as though it had already been rejected again.
      nin_slip_decline_reason: null,
      nin_slip_reviewed_by: null,
      nin_slip_reviewed_at: null,
    };

    if (details.fromBody) {
      Object.assign(data, {
        first_name_enc: protect(details.firstName, 'name').enc,
        middle_name_enc: details.middleName ? protect(details.middleName, 'name').enc : null,
        last_name_enc: protect(details.lastName, 'name').enc,
        phone_enc: protect(details.phone.msisdn, 'mobile').enc,
        dob_enc: protect(details.dob, 'dob').enc,
        gender: details.gender,
      });
      // `submitted_at` belongs to the BVN attempt. Only stamp it when this
      // request is what created the row - overwriting it on a slip submission
      // would rewrite the history of a BVN check that already happened.
      if (!existing) data.submitted_at = new Date();
    }

    let saved;
    try {
      saved = existing
        ? await prisma.kycVerification.update({ where: { user_id: Number(user.id) }, data })
        : await prisma.kycVerification.create({
          data: {
            ...data,
            user_id: Number(user.id),
            reference: `kyc_${user.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          },
        });
    } catch (e) {
      if (e?.code !== 'P2002') throw e;
      securityEvent('kyc.nin_slip_reuse', 'NIN claimed by another account mid-submission', {
        user_id: Number(user.id),
      });
      return fail(res, 409, 'nin_in_use', 'This NIN is already linked to another VoltPay account');
    }

    await logUserEvent({
      req,
      userId: user.id,
      event: 'kyc.nin_slip_submitted',
      metadata: { reference: saved.reference, resubmission: existing?.nin_slip_status === 'declined' },
    }).catch(() => {});

    await notifyUser({
      userId: Number(user.id),
      subject: 'NIN slip received',
      message: 'We have your NIN slip and our team is reviewing it. This usually takes a day or two - we will let you know as soon as it is done.',
      type: 'kyc',
      data: { status: 'pending', document: 'nin_slip' },
    }).catch(() => {});

    return ok(
      res,
      'kyc_nin_slip_submitted',
      'Your NIN slip is under review. This usually takes a day or two, and we will notify you as soon as it is done.',
      { verification: publicKyc(saved) },
    );
  } catch (e) {
    // `e.message` only. Never the body - it holds an identity number.
    console.error('kyc.submitNinSlip error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 502, 'error', 'Could not submit your NIN slip. Please try again.');
  }
}

/* ------------------------------------------------------ the bank account */

/*
 * The second half of verification, required of everybody whichever identity
 * route they took. Paystack resolves the account number to the name the bank has
 * on file, and that name has to match the profile.
 *
 * What this proves and what it does not: /bank/resolve answers for ANY account
 * number - anyone can resolve anyone's - so a successful resolve is not evidence
 * that the person asking owns the account. It is evidence that a licensed bank
 * ran KYC on somebody with this name, and NIBSS ties every Nigerian account to a
 * BVN. Behind an identity document that is a genuine second factor. In front of
 * one it would be namesake fraud, which is why kycGate treats this as an AND and
 * never as a route in. See bankRequired() there.
 *
 * Free and instant, unlike the BVN check, so there is no fee, no PIN and no
 * spend to guard here - the limiter on the route is about Paystack's own rate
 * limits and about not letting the endpoint become an account-name lookup
 * service. Worth saying out loud on the screen: a user who has just paid ₦60
 * will assume the next step costs something too and may stop there.
 */

// NUBAN is exactly 10 digits.
function cleanAccountNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

/**
 * GET /kyc/banks - the picker's list.
 *
 * Straight off paystack.service, which already holds a 24h in-process cache.
 * Nigerian bank codes change about twice a year, so this is not worth a Redis
 * key of its own - and if Paystack is unreachable the honest answer is an empty
 * picker with a message, not a stale list that resolves against nothing.
 */
async function listBanks(req, res) {
  try {
    const rows = await paystack.listBanks({ currency: 'NGN' });
    const banks = rows
      .filter(b => b?.code && b?.name)
      .map(b => ({ code: String(b.code), name: String(b.name), slug: b.slug || null, type: b.type || null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return ok(res, 'kyc_banks', 'OK', { banks });
  } catch (e) {
    console.error('kyc.listBanks error:', { message: e?.message });
    return fail(res, 503, 'unavailable', 'Could not load the bank list. Please try again shortly.');
  }
}

/**
 * POST /kyc/bank/verify   { account_number, bank_code }
 *
 * Requires the identity record to exist already. Not an arbitrary ordering:
 * there is nothing to create a row from here - this route knows an account
 * number and a bank code and nothing about who the person is - and the row is
 * where the identity half's verdict lives. Creating one would mean a row that
 * passes half the gate without either document having been seen.
 *
 * Note it matches against the VOLTPAY PROFILE, not against the identity row's
 * own name columns. Those may be empty (a BVN lookup writes only what the
 * register returned) and, more importantly, the profile is the one name both
 * halves of verification agree on.
 */
async function verifyBankAccount(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');
    // paystack.service throws on a missing key rather than exposing a predicate,
    // and a thrown "Missing required env" would surface to the user as "try
    // again" - which they would, forever. Checked here so an unconfigured
    // deployment says the honest thing once.
    if (!String(process.env.PAYSTACK_SECRET_KEY || '').trim()) {
      return fail(res, 503, 'unavailable', 'Bank verification is temporarily unavailable');
    }

    const accountNumber = cleanAccountNumber(req.body?.account_number);
    if (!accountNumber) return fail(res, 400, 'validation_error', 'Enter your 10-digit account number');

    const bankCode = String(req.body?.bank_code ?? '').trim();
    if (!bankCode) return fail(res, 400, 'validation_error', 'Select your bank');

    const existing = await prisma.kycVerification.findUnique({ where: { user_id: Number(user.id) } });
    if (!existing) {
      return fail(res, 409, 'identity_first', 'Verify your identity first - your BVN, or your NIN slip - then add your bank account');
    }

    // Re-linking the same account is a no-op worth saying so about; the user has
    // probably tapped twice on a slow connection.
    const alreadyIdx = blindIndex(accountNumber, 'account_number');
    if (existing.account_status === 'verified' && existing.account_number_idx === alreadyIdx) {
      return ok(res, 'kyc_bank_verified', 'This bank account is already verified on your VoltPay account', {
        verification: publicKyc(existing),
      });
    }

    // One account, one wallet. Checked on the blind index so the comparison never
    // needs the number in plain text.
    const claimedBy = await prisma.kycVerification.findFirst({
      where: { account_number_idx: alreadyIdx, user_id: { not: Number(user.id) } },
      select: { user_id: true },
    });
    if (claimedBy) {
      securityEvent('kyc.bank_account_reuse', 'Bank account already attached to another account', {
        user_id: Number(user.id),
        existing_user_id: claimedBy.user_id,
      });
      return fail(res, 409, 'account_in_use', 'This bank account is already linked to another VoltPay account');
    }

    // Ask Paystack. A resolve failure is a wrong number or a wrong bank, not an
    // outage - Paystack answers 422 for an unresolvable NUBAN - so it is
    // reported as a validation error and nothing is written.
    let resolvedName = '';
    try {
      const { data } = await paystack.resolveAccount({ account_number: accountNumber, bank_code: bankCode });
      resolvedName = String(data?.account_name || '').trim();
    } catch (e) {
      console.error('kyc.verifyBankAccount resolve failed:', { user_id: user.id, message: e?.message });
      return fail(res, 400, 'account_not_found', 'We could not find that account. Check the number and the bank and try again.');
    }
    if (!resolvedName) {
      return fail(res, 400, 'account_not_found', 'We could not find that account. Check the number and the bank and try again.');
    }

    // The name the bank holds has to be the name on the wallet. This is the
    // whole security value of the step - without it, linking an account proves
    // only that some account exists.
    const expected = nameOnProfile(user);
    const nameCheck = matchName(expected, resolvedName);
    if (!nameCheck.ok) {
      // Recorded as a failure so support can see the attempt, but the number is
      // NOT indexed - a failed attempt must not lock the account out of the
      // wallet that really owns it.
      await prisma.kycVerification.update({
        where: { user_id: Number(user.id) },
        data: {
          account_status: 'failed',
          account_decline_reason: 'The name on this bank account does not match your VoltPay profile',
          account_verified_at: null,
        },
      }).catch(() => {});

      securityEvent('kyc.bank_name_mismatch', 'Bank account name did not match the profile', {
        user_id: Number(user.id),
      });

      // Deliberately never echoes `resolvedName`. Repeating it back would turn
      // this endpoint into an account-name lookup service: type any number, read
      // out whose it is. The user's own profile name is safe - it is their
      // account and they are authenticated.
      return fail(
        res,
        400,
        'name_mismatch',
        `That account is not in your name. Your VoltPay profile says "${expected}", and the bank has it under a different name. ` +
        'Use an account in your own name, or update your profile in Settings if it is wrong.',
        { verification: publicKyc(existing), profile_name: expected },
      );
    }

    // Bank name for display. Looked up from the cached list rather than trusted
    // from the body: the client picked a code, and the label that goes on the
    // record should be ours, not theirs.
    let bankName = null;
    try {
      const banks = await paystack.listBanks({ currency: 'NGN' });
      bankName = banks.find(b => String(b.code) === bankCode)?.name || null;
    } catch { /* display only - never fail a verification over a label */ }

    const changing = Boolean(existing.account_number_idx) && existing.account_number_idx !== alreadyIdx;

    let saved;
    try {
      saved = await prisma.kycVerification.update({
        where: { user_id: Number(user.id) },
        data: {
          account_number_enc: protect(accountNumber, 'account_number').enc,
          account_number_idx: alreadyIdx,
          account_name_enc: protect(resolvedName, 'name').enc,
          bank_code: bankCode,
          bank_name: bankName,
          account_status: 'verified',
          account_decline_reason: null,
          account_verified_at: new Date(),
        },
      });
    } catch (e) {
      if (e?.code !== 'P2002') throw e;
      securityEvent('kyc.bank_account_reuse', 'Bank account claimed by another wallet mid-submission', {
        user_id: Number(user.id),
      });
      return fail(res, 409, 'account_in_use', 'This bank account is already linked to another VoltPay account');
    }

    await logUserEvent({
      req,
      userId: user.id,
      event: changing ? 'kyc.bank_account_changed' : 'kyc.bank_account_verified',
      // Ids and the bank only. Never the account number.
      metadata: { reference: saved.reference, bank_code: bankCode },
    }).catch(() => {});

    // Swapping the account behind a verified wallet is the shape an account
    // takeover leaves. It is also what somebody changing banks does, so it is
    // not blocked - but it is not silent either.
    if (changing) {
      securityEvent('kyc.bank_account_changed', 'Verified bank account replaced', {
        user_id: Number(user.id),
      });
      await notifyUser({
        userId: Number(user.id),
        subject: 'Bank account changed',
        message: `The bank account on your VoltPay identity was changed to ${bankName || 'a new bank'} ****${accountNumber.slice(-4)}. If this was not you, contact support now.`,
        type: 'kyc',
        data: { status: 'changed', document: 'bank_account' },
      }).catch(() => {});
    }

    // May or may not complete the picture - it depends on whether the identity
    // half is already done. The predicate decides, not this function.
    await finalizeIfVerified({ req, userId: user.id, row: saved });

    return ok(
      res,
      'kyc_bank_verified',
      rowIsVerified(saved)
        ? 'Your bank account is verified. Your identity is confirmed and your wallet is unlocked.'
        : 'Your bank account is verified. Finish verifying your identity to unlock your wallet.',
      { verification: publicKyc(saved) },
    );
  } catch (e) {
    console.error('kyc.verifyBankAccount error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 502, 'error', 'Could not verify your bank account. Please try again.');
  }
}

/**
 * POST /kyc/nin/verify - WITHDRAWN.
 *
 * Kept as a route so an installed APK gets a sentence it can show the user
 * instead of a 404 body it will render as "something went wrong". 410 Gone is
 * the accurate code: the endpoint existed, it is deliberately not coming back,
 * and no amount of retrying will change that.
 *
 * Nothing is written and Payvessel is never called, so this costs nothing.
 */
async function submitNin(req, res) {
  return fail(
    res,
    410,
    'nin_withdrawn',
    'NIN verification is no longer available. Please verify your BVN instead - update your app if you do not see the BVN form.',
  );
}

module.exports = {
  status,
  submitBvn,
  submitNin,
  submitNinSlip,
  listBanks,
  verifyBankAccount,
  publicKyc,
  // Exported for adminKyc.reviewNinSlip. An approval has to open the wallet by
  // exactly the same route a verified BVN does - flip `kv`, drop the cache, send
  // one push on the transition - and a second copy of that in the admin
  // controller is a second place for it to drift out of step with the gate.
  finalizeIfVerified,
  __test: {
    cleanBvn,
    cleanNin,
    cleanAccountNumber,
    cleanName,
    cleanDob,
    parseIdentity,
    hasIdentityFields,
    resolveIdentity,
    nextStep,
    nameMismatchMessage,
    identityFromRow,
    identityColumnsFrom,
    bvnFee,
    NEED_DETAILS,
  },
};
