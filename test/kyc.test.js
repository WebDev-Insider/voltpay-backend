/**
 * node test/kyc.test.js
 *
 * No network, no database: covers the pieces of the KYC feature that are pure
 * logic and expensive to get wrong.
 *
 *   1. the gate decision - a wallet that has received the limit or more without
 *      verification must be frozen, and a verified one must never be
 *   2. the TWO-REQUIREMENT rule - an identity document AND a name-matched bank
 *      account. Either one alone leaves the wallet shut.
 *   3. the input validators
 *   4. the name matcher, which is what proves the document belongs to the
 *      person who owns the wallet - and which, since ArewaSmart, is the ONLY
 *      thing that proves it for a BVN too
 *   5. the BVN fee, whose default has to survive an env var nobody set
 *   6. the ArewaSmart client's normalizers, and its retry policy - which is
 *      narrower than the shared one on purpose, because repeating this call
 *      costs the customer money
 *   7. the Payvessel match grader - RETIRED, kept as an archive. See its section.
 */
const assert = require('assert');

const {
  decide,
  rowIsVerified,
  hasIdentity,
  hasBank,
  verifiedVia,
} = require('../src/helpers/kycGate.helper');
const { __test: payvessel } = require('../src/funding/payvessel.service');
const { __test: arewasmart } = require('../src/funding/arewasmart.service');
const { matchName, __test: nameInternals } = require('../src/helpers/nameMatch.helper');
const { publicKyc, __test: validators } = require('../src/controllers/kyc.controller');

const LIMIT = 25_000;

/* ------------------------------------------------------------------ the gate */

assert.strictEqual(decide({ verified: true, funded: 5_000_000 }, LIMIT).ok, true,
  'a verified wallet is never frozen, however much it has received');

assert.strictEqual(decide({ verified: false, funded: 0 }, LIMIT).ok, true,
  'a wallet that has received nothing can spend');

assert.strictEqual(decide({ verified: false, funded: 24_999 }, LIMIT).ok, true,
  'one naira under the limit is still free to spend');

const frozen = decide({ verified: false, funded: LIMIT }, LIMIT);
assert.strictEqual(frozen.ok, false, 'exactly the limit freezes the wallet - the rule is "or more"');
assert.strictEqual(frozen.reason, 'kyc_required');
assert.match(frozen.message, /BVN/, 'the message must tell the user what unlocks it');
// A frozen wallet gets ONE instruction, and it has to be the fastest one that
// works. The NIN slip is a live route, but naming it here would offer a person
// whose money is stuck right now a door that takes a day or two, next to one
// that takes seconds. The slip is offered on the verification screen, where
// there is room to explain the trade; it is not offered in a refusal.
assert.strictEqual(/NIN/.test(frozen.message), false,
  'the refusal must point at the door that opens in seconds, not the one that takes days');

assert.strictEqual(decide({ verified: false, funded: 40_000 }, LIMIT).ok, false,
  'past the limit stays frozen');

// The message is not one sentence any more, because there are now two ways to
// be short. Which one the user is told about has to match which one they are
// actually missing - "verify your BVN" to somebody whose BVN is already
// verified is how a support ticket is born.
const needBank = decide({ verified: false, funded: LIMIT, identity: true, bank: false }, LIMIT);
assert.strictEqual(needBank.ok, false, 'an identity document on its own does not open the wallet');
assert.match(needBank.message, /bank account/i, 'and the user must be told it is the bank account that is missing');
assert.strictEqual(/Verify your BVN/.test(needBank.message), false,
  'do not send somebody back to a form they have already passed');

const waiting = decide({ verified: false, funded: LIMIT, identity: false, bank: false, slipStatus: 'pending' }, LIMIT);
assert.strictEqual(waiting.ok, false, 'a slip under review is not yet an approval');
assert.match(waiting.message, /day or two/i,
  'somebody waiting on a human reviewer must be told it is being reviewed, not told to submit it again');

// The whole balance is frozen, not the excess: the decision does not take an
// amount at all, so a ₦50 airtime top-up is refused for the same reason a
// ₦50,000 transfer is.
assert.strictEqual(Object.keys(decide({ verified: false, funded: LIMIT }, LIMIT)).includes('amount'), false,
  'the verdict must not depend on what is being spent');

/* ------------------------------------------------ identity AND bank account */

// TWO requirements, joined by AND. Identity is a Payvessel-matched BVN or a NIN
// slip a human approved - two doors into the same room. The bank account is a
// wall, not a door: everybody passes it, whichever door they came through.
//
// The AND is not squeamishness. Paystack's /bank/resolve will return the
// registered name for ANY account number in Nigeria, so a "verified" bank
// account proves the account exists and who owns it - never that the person
// holding this wallet is that owner. As a second factor behind a document that
// does prove identity, it is worth having. As a route in on its own it is
// namesake fraud with a receipt. That asymmetry is the whole reason this is an
// AND and can never quietly become an OR.
const BANK = { account_status: 'verified' };

assert.strictEqual(rowIsVerified({ status: 'verified', ...BANK }), true,
  'BVN plus a verified bank account is the pass');
assert.strictEqual(rowIsVerified({ nin_slip_status: 'approved', ...BANK }), true,
  'an approved NIN slip is the other door, and it opens the same room');

assert.strictEqual(rowIsVerified({ status: 'verified', account_status: 'none' }), false,
  'a verified BVN with no bank account is one step short - the bank account is required of everybody');
assert.strictEqual(rowIsVerified({ status: 'verified', account_status: 'failed' }), false,
  'and a bank account whose name did not match the profile is not a bank account');
assert.strictEqual(rowIsVerified({ nin_slip_status: 'approved', account_status: 'none' }), false,
  'the slip route carries the same requirement - there is no cheaper way in');

assert.strictEqual(rowIsVerified({ status: 'none', ...BANK }), false,
  'a bank account on its own verifies nobody - see the /bank/resolve note above');
assert.strictEqual(rowIsVerified({ status: 'failed', nin_slip_status: 'declined', ...BANK }), false,
  'and it cannot rescue a row that failed both identity doors');

assert.strictEqual(rowIsVerified(null), false, 'no row is not a pass');
assert.strictEqual(rowIsVerified({ ...BANK }), false, 'nor is a row with nothing but a bank account');

// The two halves are separately callable because the screen renders them as two
// ticks. They must agree with the predicate that actually moves money.
assert.strictEqual(hasIdentity({ status: 'verified' }), true);
assert.strictEqual(hasIdentity({ nin_slip_status: 'approved' }), true);
assert.strictEqual(hasIdentity({ ...BANK }), false, 'a bank account is not an identity document');
assert.strictEqual(hasBank({ ...BANK }), true);
assert.strictEqual(hasBank({ status: 'verified' }), false, 'and an identity document is not a bank account');
assert.strictEqual(hasIdentity(null), false);
assert.strictEqual(hasBank(null), false);

// `nin_status` is the FOSSIL of the withdrawn automated NIN-number check, and
// `nin_slip_status` is the live reviewed-document path. They are one underscore
// apart and mean opposite things, which is exactly why they were never merged
// into one column. Live rows still carry `nin_status = 'verified'` from the old
// era; reading it again is one `||` away and would promote every one of those
// straight into an unlocked wallet without a single document being looked at.
assert.strictEqual(rowIsVerified({ nin_status: 'verified', ...BANK }), false,
  'the withdrawn NIN-number check still verifies nobody, bank account or not');
assert.strictEqual(hasIdentity({ nin_status: 'verified' }), false,
  'nin_status is a fossil - only nin_slip_status is read');
assert.strictEqual(rowIsVerified({ status: 'verified', nin_status: 'failed', ...BANK }), true,
  'and a historical NIN decline cannot revoke anything - the column is not read at all');

// REVOCATION. An admin taking verification back writes the status column itself
// rather than setting a flag beside it, so it needs no branch here and cannot be
// forgotten by a caller that checks the flag it has not heard of. Both doors are
// shut on a revoke; each is pinned separately because shutting only one would
// leave a user with two routes still verified through the other.
assert.strictEqual(rowIsVerified({ status: 'revoked', ...BANK }), false,
  'a revoked BVN is not a verified BVN');
assert.strictEqual(rowIsVerified({ nin_slip_status: 'revoked', ...BANK }), false,
  'a revoked slip is not an approved slip');
assert.strictEqual(rowIsVerified({ status: 'revoked', nin_slip_status: 'revoked', ...BANK }), false);

// Nothing except the exact strings opens the gate. Pinned because these are
// free-form columns and a typo, a casing slip or a NULL must all fail closed.
for (const status of ['pending', 'failed', 'none', 'revoked', '', null, undefined, 'VERIFIED']) {
  assert.strictEqual(rowIsVerified({ status, nin_status: 'verified', ...BANK }), false,
    `"${status}" is not "verified" and must not unlock a wallet`);
}
for (const slip of ['pending', 'declined', 'none', 'revoked', '', null, undefined, 'APPROVED']) {
  assert.strictEqual(rowIsVerified({ status: 'none', nin_slip_status: slip, ...BANK }), false,
    `"${slip}" is not "approved" and must not unlock a wallet`);
}
for (const bank of ['pending', 'failed', 'none', '', null, undefined, 'VERIFIED']) {
  assert.strictEqual(rowIsVerified({ status: 'verified', account_status: bank }), false,
    `"${bank}" is not a verified bank account and must not unlock a wallet`);
}

// `grandfathered` is IGNORED, not honoured. It was set where
// `status = 'verified' OR nin_status = 'verified'` - a strictly broader set than
// today's rule - so honouring it would reinstate two withdrawn rules at once.
// It survives as a record of who was marked, never as an exemption: a boolean
// column that opens a money gate is a column an attacker would love to reach.
assert.strictEqual(rowIsVerified({ grandfathered: true, status: 'verified', account_status: 'none' }), false,
  'the mark does not excuse a missing bank account');
assert.strictEqual(rowIsVerified({ grandfathered: true, status: 'none', nin_status: 'verified', ...BANK }), false,
  'nor does it carry a NIN-fossil row across the new rule');
assert.strictEqual(rowIsVerified({ grandfathered: true, status: 'failed', nin_status: 'failed' }), false,
  'the mark on its own verifies nobody');

// Which door was used, for the "Verified with your BVN" line on the screen.
// Deliberately non-null on a row that is one step short: it answers "which
// identity document do we hold", not "are you verified". Only `rowIsVerified`
// answers the second question, and only it is allowed to gate money.
assert.strictEqual(verifiedVia({ status: 'verified', account_status: 'none' }), 'bvn',
  'the identity door is named even before the bank account lands');
assert.strictEqual(verifiedVia({ nin_slip_status: 'approved' }), 'nin_slip');
assert.strictEqual(verifiedVia({ status: 'verified', nin_slip_status: 'approved' }), 'bvn',
  'a row holding both reports the BVN - the register beats the photograph');
assert.strictEqual(verifiedVia({ nin_status: 'verified', ...BANK }), null,
  'the fossil names no door');
assert.strictEqual(verifiedVia({ status: 'revoked', nin_slip_status: 'revoked' }), null);
assert.strictEqual(verifiedVia(null), null);

/* ------------------------------------------------------------- the next step */

// `next_step` is a HINT about which form to show next, and with two
// requirements it has to sequence them: identity first, bank account second.
// The order is not cosmetic - the bank check is only meaningful once we know
// whose name we are matching against, and asking for an account number before
// we have a document is asking a stranger for their bank details.
assert.strictEqual(publicKyc({ status: 'none' }).next_step, 'bvn');
assert.strictEqual(publicKyc({ status: 'failed' }).next_step, 'bvn',
  'a declined BVN points back at the BVN form - the slip is offered on the screen, not forced by the hint');
assert.strictEqual(publicKyc({ status: 'none', nin_status: 'verified' }).next_step, 'bvn',
  'the NIN fossil is not a substitute - this row still has an identity document to submit');

assert.strictEqual(publicKyc({ status: 'verified', account_status: 'none' }).next_step, 'bank_account',
  'identity done, bank account outstanding');
assert.strictEqual(publicKyc({ nin_slip_status: 'approved', account_status: 'failed' }).next_step, 'bank_account',
  'a bank account whose name did not match sends them back to the same step, not onwards');

assert.strictEqual(publicKyc({ status: 'verified', account_status: 'verified' }).next_step, null,
  'both requirements met leaves nothing to do - `null` is the only hard statement this field makes');
assert.strictEqual(publicKyc({ nin_slip_status: 'approved', account_status: 'verified' }).next_step, null);

// The BVN path is synchronous, so it never parks anyone. The slip path is a
// person looking at a photograph, so it does - and that state needs its own
// value, because "submit your BVN" shown to somebody who has already sent a
// slip reads as "we lost it" and produces a second upload.
assert.strictEqual(publicKyc({ nin_slip_status: 'pending' }).next_step, 'nin_slip_review',
  'a slip under review is a waiting state, not an actionable one');
assert.strictEqual(publicKyc({ nin_slip_status: 'declined' }).next_step, 'bvn',
  'a declined slip is actionable again');
assert.strictEqual(publicKyc({ status: 'verified', nin_slip_status: 'pending', account_status: 'none' }).next_step,
  'bank_account',
  'a stray pending slip must not park a user whose BVN already passed - identity is satisfied either way');

// The values stay in this closed set: installed APKs branch on the string, and
// an unrecognised one leaves them on a blank screen. A new state gets added
// here deliberately, never by accident.
for (const row of [
  { status: 'none' }, { status: 'failed' }, { status: 'verified' },
  { nin_slip_status: 'pending' }, { nin_slip_status: 'approved' },
  { status: 'verified', account_status: 'verified' },
]) {
  assert.ok([null, 'bvn', 'nin_slip_review', 'bank_account'].includes(publicKyc(row).next_step),
    `next_step must stay inside the set the app knows: got ${publicKyc(row).next_step}`);
}

// The two requirements are reported separately so the screen can draw two ticks
// instead of one opaque boolean, and each must agree with its half of the gate.
const half = publicKyc({ status: 'verified', account_status: 'none' });
assert.strictEqual(half.identity_done, true);
assert.strictEqual(half.bank_done, false);
assert.strictEqual(half.fully_verified, false, 'one tick is not a pass');
assert.strictEqual(half.verified_via, 'bvn', 'and the screen can still say which document we hold');

// `fully_verified` keeps the name it had under every previous rule so an
// installed APK still reads it. What has changed four times now is the rule
// behind it, never the key.
assert.strictEqual(publicKyc({ status: 'verified', account_status: 'verified' }).fully_verified, true,
  'the old key name must carry the current answer');
assert.strictEqual(publicKyc({ status: 'none', nin_status: 'verified', account_status: 'verified' }).fully_verified,
  false, 'and it must agree with the gate, not with the row that once passed an older rule');

// The status payload must never carry an identity number back to the app.
const payload = publicKyc({
  status: 'verified', nin_status: 'verified', account_status: 'verified',
  bvn_enc: 'x', nin_enc: 'y', nin_slip_number_enc: 'z', nin_slip_url_enc: 'u',
});
assert.strictEqual(payload.fully_verified, true);
assert.strictEqual('bvn' in payload, false, 'the BVN must never be echoed to the client');
assert.strictEqual('nin' in payload, false, 'the NIN must never be echoed to the client');
assert.strictEqual('nin_slip_number' in payload, false, 'nor the number off the slip');
// The slip URL is the user's own identity document sitting on object storage.
// The app has no screen that shows it back to them and the admin route serves it
// through its own logged, authenticated handler, so it has no business riding in
// a status poll that any holder of the session token can make.
assert.strictEqual('nin_slip_url' in payload, false, 'nor a link to the document image');

// `nin_status` is still sent, HISTORICALLY ONLY: nothing writes it any more and
// it decides nothing, but an installed APK renders a NIN card off it and would
// print "undefined" without it. A row submitted from here on always reads 'none'.
assert.strictEqual(payload.nin_status, 'verified', 'an existing row still reports what it holds');
assert.strictEqual(publicKyc({ status: 'none' }).nin_status, 'none',
  'and a row that never had one reads none, not undefined');

/* ------------------------------------------------------------ the validators */

assert.strictEqual(validators.cleanBvn('221 5678 9012'), '22156789012', 'spaces in a BVN are a typo, not a rejection');
assert.strictEqual(validators.cleanBvn('2215678901'), null, '10 digits is not a BVN');
assert.strictEqual(validators.cleanBvn('221567890123'), null, '12 digits is not a BVN');
assert.strictEqual(validators.cleanBvn(''), null);

// cleanNin is back, for the SLIP route only. It is its own function rather than
// an alias of cleanBvn even though both take eleven digits today: they are
// numbers on two different national registers, issued by two different bodies,
// and the day one of them changes length the alias would silently validate the
// other one wrongly.
assert.strictEqual(validators.cleanNin('123 4567 8901'), '12345678901', 'spaces on a printed slip are a typo, not a rejection');
assert.strictEqual(validators.cleanNin('1234567890'), null, '10 digits is not a NIN');
assert.strictEqual(validators.cleanNin('123456789012'), null, '12 digits is not a NIN');
assert.strictEqual(validators.cleanNin(''), null);
assert.notStrictEqual(validators.cleanNin, validators.cleanBvn,
  'the NIN and BVN validators must stay separate functions, not one aliased twice');

// The NUBAN is exactly ten digits. Pinned because the value goes into a
// Paystack resolve and then onto the wallet as the account we would pay out to.
assert.strictEqual(validators.cleanAccountNumber('0123 456 789'), '0123456789', 'a pasted account number carries spaces');
assert.strictEqual(validators.cleanAccountNumber('012345678'), null, '9 digits is not a NUBAN');
assert.strictEqual(validators.cleanAccountNumber('01234567890'), null, '11 digits is not a NUBAN');
assert.strictEqual(validators.cleanAccountNumber('012345678a'), null);
assert.strictEqual(validators.cleanAccountNumber(null), null);

assert.strictEqual(validators.cleanName("N'Golo  Ade-Bayo"), "N'Golo Ade-Bayo", 'real names carry hyphens and apostrophes');
assert.strictEqual(validators.cleanName('A'), null, 'one letter is not a name');
assert.strictEqual(validators.cleanName('Robert; DROP TABLE users'), null);

assert.strictEqual(validators.cleanDob('1990-02-31'), null, 'a date JS would roll over to March must be rejected');
assert.strictEqual(validators.cleanDob('1990-02-28'), '1990-02-28');
assert.strictEqual(validators.cleanDob('03/12/1972'), null, 'Payvessel takes YYYY-MM-DD only');
assert.strictEqual(validators.cleanDob(`${new Date().getUTCFullYear() - 5}-01-01`), null, 'a five-year-old has no BVN');

// Gender is optional. The column is nullable because a BVN lookup writes back
// whatever the register returned and the register does not always carry one, so
// an omitted gender lands in a state the reviewer screen already renders - and a
// mandatory field that gates nothing is friction on the free route.
assert.strictEqual(
  validators.parseIdentity({ first_name: 'Ada', last_name: 'Obi', phone_number: '08012345678', dob: '1990-02-28' }).gender,
  null,
  'a missing gender is not an error',
);
assert.strictEqual(
  validators.parseIdentity(
    { first_name: 'Ada', last_name: 'Obi', phone_number: '08012345678', dob: '1990-02-28', gender: 'f' },
  ).gender,
  'Female',
  'gender is normalised to what the register expects',
);

// The payload the Flutter slip form actually posts: a name, a date of birth and
// the number - no phone and no gender. It used to 400 on the phone, because one
// supplied field flips resolveIdentity to the strict branch and the strict
// branch then wanted all six. The profile is what completes it.
const slipBody = { first_name: 'Ada', last_name: 'Obi', dob: '1990-02-28' };
assert.match(
  validators.parseIdentity(slipBody, 'NIN slip').error, /phone number/,
  'with no profile to fall back on the phone is still required',
);
const withProfile = validators.parseIdentity(slipBody, 'NIN slip', { phone: '08031234567' });
assert.strictEqual(withProfile.error, undefined, 'the account mobile completes the form the app does send');
assert.strictEqual(withProfile.phone.msisdn, '2348031234567', 'and is normalised like any other number');
assert.strictEqual(withProfile.gender, null);

// The body still wins. A document may legitimately carry a different number to
// the account, and the fallback must never overwrite one the user typed.
assert.strictEqual(
  validators.parseIdentity({ ...slipBody, phone_number: '08012345678' }, 'NIN slip', { phone: '08031234567' }).phone.msisdn,
  '2348012345678',
  'a typed phone is not replaced by the profile',
);

// The error names the document being submitted: "as it appears on your BVN" is
// the instruction that actually gets the match, because the register holds the
// spelling the bank recorded, not the one the user prefers.
assert.match(
  validators.parseIdentity({ last_name: 'Obi' }, 'BVN').error, /BVN/,
  'the prompt must name the document in front of the user',
);
// The label is still a parameter with a generic default, so an unlabelled call
// asks for something a user can act on rather than "as it appears on your ".
assert.match(validators.parseIdentity({ last_name: 'Obi' }).error, /your ID$/,
  'the default label must still read as a sentence');

/* ------------------------------------------- where the identity details come from */

// A retry may leave the details out and reuse the ones the last attempt stored,
// so a row that cannot produce them must ask rather than post blank names - an
// empty name scores zero at Payvessel and is billed for the privilege.
assert.strictEqual(validators.identityFromRow(null).error, validators.NEED_DETAILS);
assert.strictEqual(
  validators.identityFromRow({ gender: 'Male' }).error,
  validators.NEED_DETAILS,
  'a row with no stored identity columns cannot back a check',
);

// NEED_DETAILS asks for the missing FIELDS and names no document. The form the
// user is already on says BVN; answering a missing date of birth with "verify
// your BVN" would send them back to re-check the number instead.
assert.match(validators.NEED_DETAILS, /date of birth/);
assert.strictEqual(/BVN|NIN/.test(validators.NEED_DETAILS), false,
  'the prompt names the fields it needs, not a document');

const fullBody = {
  first_name: 'Ada', last_name: 'Obi', phone_number: '08012345678', dob: '1990-02-28', gender: 'f',
};

assert.strictEqual(validators.hasIdentityFields(fullBody), true);
assert.strictEqual(validators.hasIdentityFields({ bvn: '22156789012' }), false,
  'a number on its own is a request to reuse the stored details');
assert.strictEqual(validators.hasIdentityFields({ bvn: '22156789012', gender: '' }), false,
  'an empty string is not a supplied field - a form that posts blanks must not count as filled');
assert.strictEqual(validators.hasIdentityFields({ last_name: 'Obi' }), true,
  'one field is enough to mean "parse my body strictly"');

// A body that carries details is parsed strictly, and a HALF-filled one must
// produce the field-level error - never a silent fall back to the saved row,
// which would check a document against details the user thought they had
// replaced.
assert.strictEqual(
  validators.resolveIdentity({ last_name: 'Obi' }, null, 'BVN').error,
  'Enter your first name as it appears on your BVN',
);
assert.strictEqual(
  validators.resolveIdentity({ last_name: 'Obi' }, { gender: 'Male' }, 'BVN').error,
  'Enter your first name as it appears on your BVN',
  'the presence of a row must not rescue a half-filled body',
);

const fromBody = validators.resolveIdentity(fullBody, null, 'BVN');
assert.strictEqual(fromBody.error, undefined, 'a complete body needs no row at all - this is the first submission');
assert.strictEqual(fromBody.firstName, 'Ada');
assert.strictEqual(fromBody.fromBody, true, 'freshly typed details have to be persisted');

// No details anywhere is the one case that cannot proceed.
assert.strictEqual(
  validators.resolveIdentity({ bvn: '22156789012' }, null, 'BVN').error,
  validators.NEED_DETAILS,
);

/* --------------------------------------------------------- the name matcher */

// Every one of these is a real document belonging to the person who owns the
// wallet. Failing any of them is a support ticket, not a fraud catch.
const passes = [
  ['Samuel Owolabi', 'SAMUEL OWOLABI BLESSING', 'the register carries a middle name the profile never held'],
  ['Samuel Owolabi', 'OWOLABI SAMUEL BLESSING', 'registers put the surname first'],
  ['Samuel Owolabi', 'owolabi samuel', 'case and order both vary'],
  ['Adewale Ogunbiyi', 'ADÉWÁLÉ OGUNBIYI', 'the same name with diacritics'],
  ['Ade-Bello Chukwu', 'ADE BELLO CHUKWU', 'a hyphen on one side, a space on the other'],
  ["O'Neil James", 'ONEIL JAMES', 'an apostrophe the register dropped'],
  ['Samuel Owolabi', 'S OWOLABI', 'the register stored an initial'],
  ['Chukwuemeka Obi', 'CHUKWEMEKA OBI', 'one slipped keystroke in a long name'],
  ['Samuel Owolabi', 'MR SAMUEL OWOLABI', 'an honorific on the record'],
];
for (const [profile, provider, why] of passes) {
  assert.strictEqual(matchName(profile, provider).ok, true, `must match: ${why}`);
}

// Every one of these is somebody else, or too little to tell.
const fails = [
  ['Samuel Owolabi', 'SAMUEL ADEBAYO', 'mismatch', 'same first name, different surname'],
  ['Samuel Owolabi', 'BLESSING OKONKWO', 'mismatch', 'a different person entirely'],
  ['Ade Bello', 'ADA BELLO', 'mismatch', 'one letter apart, but too short for that to be a typo'],
  ['Samuel Owolabi', 'SAMUEL', 'mismatch', 'the surname is missing from the record'],
  ['Samuel', 'SAMUEL OWOLABI', 'incomplete_profile', 'a one-word profile would match half the country'],
  ['Samuel Owolabi', '', 'no_name', 'the register returned nothing'],
];
for (const [profile, provider, reason, why] of fails) {
  const result = matchName(profile, provider);
  assert.strictEqual(result.ok, false, `must not match: ${why}`);
  assert.strictEqual(result.reason, reason, `wrong reason for: ${why}`);
}

// The initial shortcut works one way only. "S" on the profile side would match
// almost every account in Nigeria.
assert.strictEqual(matchName('S Owolabi', 'SAMUEL OWOLABI').ok, false,
  'a single letter on the profile side must never stand in for a full name');

// A repeated name needs a repeated match: one "SAMUEL" cannot satisfy two.
assert.strictEqual(matchName('Samuel Samuel', 'SAMUEL OWOLABI').ok, false,
  'each provider word can only be spent once');

// The decline message must never echo the name the register returned - that
// would turn the endpoint into "type a number, read out whose it is".
const mismatchMessage = validators.nameMismatchMessage({ reason: 'mismatch' }, 'Samuel Owolabi', 'your BVN');
assert.strictEqual(mismatchMessage.includes('Samuel Owolabi'), true, 'the user\'s own profile name is safe to show');
assert.strictEqual(/OKONKWO|ADEBAYO/i.test(mismatchMessage), false, 'the resolved name must never appear');

// Capped edit distance must agree with the uncapped answer wherever it matters.
assert.strictEqual(nameInternals.editDistance('CHUKWUEMEKA', 'CHUKWEMEKA', 2), 1);
assert.strictEqual(nameInternals.editDistance('SAMUEL', 'OKONKWO', 2), 3, 'a far-apart pair reports past the cap, not a wrong number');

/* ============================================================================
 * THE PAYVESSEL MATCH GRADER - RETIRED 2026-08-25, KEPT AS AN ARCHIVE
 *
 * Nothing in src/ calls any of this any more. The BVN check moved to ArewaSmart,
 * which is a LOOKUP api rather than a MATCH api: it takes the number alone and
 * returns the register record, so the comparison is now ours and runs through
 * matchName above. The NIN *number* check was withdrawn before that. What is
 * left of payvessel.service in production is `getCreds`, used by
 * payvesselBiller.service for the VAAS betting rail - not one line below.
 *
 * A GREEN TICK HERE IS NOT EVIDENCE THAT THE BVN PATH WORKS. For that, read
 * kycFlow.e2e.test.js.
 *
 * Kept rather than deleted, on purpose and with a cost in mind:
 *
 *   - The fixtures at the bottom are REAL captured payloads, paid for with real
 *     lookups against a real person's BVN. They cannot be regenerated now that
 *     the account is gone, and the three-name ceiling they document is invisible
 *     from any single response.
 *   - Provider migrations get reversed. If ArewaSmart is ever dropped, this is
 *     the difference between switching back and rediscovering the 65 floor at
 *     ₦30 an attempt.
 *
 * DO NOT read the vocabulary below as live rules. NAME_MATCH_MIN, FULL_MATCH vs
 * MATCH, names_match_percentage and the three-name ceiling all describe a
 * provider we no longer call, and none of them constrains matchName.
 * ========================================================================== */

const allMatch = {
  name_match_rlt: 'MATCH',
  names_match_percentage: '100',
  birthday_match_rlt: 'MATCH',
  gender_match_rlt: 'MATCH',
  phone_number_match_rlt: 'MATCH',
};
// The grader is document-agnostic - `label` only ever reaches the decline text -
// so these exercise it through the one document that is still live.
const grade = (data, extra = {}) => payvessel.gradeMatchResult({ success: true, data, ...extra }, 'BVN');

assert.strictEqual(grade(allMatch).verified, true, 'every field matching verifies');

assert.strictEqual(
  grade({ ...allMatch, birthday_match_rlt: 'NO_MATCH' }).verified, false,
  'a matching name on somebody else\'s date of birth is exactly what this catches',
);
assert.strictEqual(grade({ ...allMatch, gender_match_rlt: 'NO_MATCH' }).verified, false);

// Phone is recorded, never decisive. The number on a BVN record is whatever the
// customer gave their bank at enrolment, so a disagreement means a changed SIM
// far more often than it means fraud - and it is not something they can correct
// from our form, so declining on it strands them with no next step.
assert.strictEqual(
  grade({ ...allMatch, phone_number_match_rlt: 'NO_MATCH' }).verified, true,
  'a stale SIM on the register must not block a verified identity',
);
assert.strictEqual(
  grade({ ...allMatch, phone_number_match_rlt: 'NO_MATCH' }).match.phone_number_match_rlt, 'NO_MATCH',
  'but it is still stored, so an admin can see it',
);

// Payvessel does not use one vocabulary across its endpoints - the NIN check
// answered MATCH where the BVN check answers FULL_MATCH - and reading only the
// literal string MATCH scored a perfect date of birth as a failure. The wide
// AFFIRMATIVE set survives the NIN withdrawal on purpose: nothing guarantees the
// BVN endpoint never returns the shorter spelling, and the cost of guessing
// wrong is declining a customer whose details were right.
assert.strictEqual(
  grade({ ...allMatch, birthday_match_rlt: 'FULL_MATCH' }).verified, true,
  'FULL_MATCH is the strongest possible yes, not an unrecognised label',
);

// An omitted field is not a mismatch. Payvessel leaves out fields it has no
// opinion on, and treating silence as disagreement declined submissions that
// passed every check it actually answered.
assert.strictEqual(
  grade({ ...allMatch, gender_match_rlt: null, phone_number_match_rlt: null }).verified, true,
  'unanswered corroborating fields are skipped, not failed',
);

// ...but silence on the two identity fields is still a decline, or an empty
// data object would verify everybody.
assert.strictEqual(
  grade({ ...allMatch, birthday_match_rlt: null }).verified, false,
  'an unanswered date of birth is not an identity',
);
assert.strictEqual(
  grade({ name_match_rlt: null, names_match_percentage: null, birthday_match_rlt: null }).verified, false,
  'an empty comparison must never pass by omission',
);

// The name is the one field graded on a score rather than a label, because NIMC
// records carry middle names customers omit. Above the floor it passes even
// when the label says NO_MATCH; below it, the label cannot save it.
//
// 65 IS LOAD-BEARING - see the NAME_MATCH_MIN comment in payvessel.service.js
// for the four live checks behind it. Payvessel's BVN endpoint never scores
// `middle_name`, so a three-name register tops out at 66; a floor of 70 makes
// every such customer permanently unverifiable. Raising this back to 70 is what
// this assertion exists to stop.
assert.strictEqual(payvessel.NAME_MATCH_MIN, 65, 'the documented floor');
assert.ok(
  payvessel.NAME_MATCH_MIN <= 66,
  'a three-name BVN cannot score above 66, so a floor above it verifies nobody',
);
assert.ok(
  payvessel.NAME_MATCH_MIN > 50,
  'a two-name register scores 50 with one name wrong - the floor must still decline that',
);
assert.strictEqual(
  grade({ ...allMatch, name_match_rlt: 'NO_MATCH', names_match_percentage: '84' }).verified, true,
  'a high similarity score passes a name the label alone would decline',
);
assert.strictEqual(
  grade({ ...allMatch, name_match_rlt: 'NO_MATCH', names_match_percentage: '52' }).verified, false,
  'below the floor is a different person',
);
assert.strictEqual(
  grade({ ...allMatch, name_match_rlt: 'NO_MATCH', names_match_percentage: null }).verified, false,
  'no score and no match label is a decline, not a pass by omission',
);

// `success: false` is how Payvessel says "not found" - and it is still billed,
// which is why every check we can make ourselves runs before the call.
const notFound = payvessel.gradeMatchResult({ success: false, message: 'BVN not found', data: null }, 'BVN');
assert.strictEqual(notFound.verified, false, 'a not-found lookup must never verify anybody');
assert.strictEqual(notFound.reason, 'BVN not found', 'the provider wording describes the record, not the person');
assert.strictEqual(notFound.match, null, 'there is no comparison to store when there was no record');

assert.strictEqual(payvessel.gradeMatchResult(null, 'BVN').verified, false, 'an unparseable answer is a decline');
assert.strictEqual(payvessel.gradeMatchResult({}, 'BVN').verified, false, 'an empty payload is a decline');
assert.strictEqual(
  payvessel.gradeMatchResult({ success: true, data: null }, 'BVN').verified, false,
  'success with no data is a decline - there is nothing to have matched',
);

// isMatch is label comparison, not truthiness: any other string is a decline.
assert.strictEqual(payvessel.isMatch('MATCH'), true);
assert.strictEqual(payvessel.isMatch('match'), true, 'case is normalised');
assert.strictEqual(payvessel.isMatch('FULL_MATCH'), true, 'the BVN endpoint\'s spelling');
assert.strictEqual(payvessel.isMatch('NO_MATCH'), false);
assert.strictEqual(payvessel.isMatch(null), false);
assert.strictEqual(payvessel.isMatch('PARTIAL'), false, 'an unrecognised label is not a pass');

// verdict is the three-way underneath it, and the third value is the one that
// matters: "no answer" has to be distinguishable from "answered no".
assert.strictEqual(payvessel.verdict('FULL_MATCH'), true);
assert.strictEqual(payvessel.verdict('NO_MATCH'), false, 'an explicit no');
assert.strictEqual(payvessel.verdict(null), null, 'no answer is not an answer of no');
assert.strictEqual(payvessel.verdict(''), null);
assert.strictEqual(payvessel.verdict('null'), null, 'a null that survived JSON as text');
assert.strictEqual(payvessel.verdict('PARTIAL_MATCH'), false, 'a partial is a no, and the score decides');

/* --- regression: the two real answers that declined a correct submission --- */

// Payvessel's live NIN answer, 2026-08-24. Name, gender and date of birth all
// MATCH; phone simply not answered. The old grader read that missing field as a
// mismatch and declined an identity the provider had fully confirmed - and
// charged us for it.
//
// Archived rather than deleted with the NIN route: it is a real captured payload,
// and it is the clearest case in the suite of "no answer" having to be
// distinguishable from "answered no". The BVN endpoint omits fields the same way.
assert.strictEqual(
  payvessel.gradeMatchResult({
    success: true,
    data: {
      name_match_rlt: 'MATCH',
      gender_match_rlt: 'MATCH',
      birthday_match_rlt: 'MATCH',
      names_match_percentage: null,
      phone_number_match_rlt: null,
    },
  }, 'NIN').verified,
  true,
  'every field Payvessel answered said yes - that is a verified identity',
);

// THE THREE-NAME CEILING. Four paid checks against one real three-name BVN on
// 2026-08-25 produced these two payloads, and between them they are the whole
// argument for a floor of 65:
//
//   Victory /  --    / Kalunta  -> 66   middle name omitted
//   Victory / Henry  / Kalunta  -> 66   middle name correct, register verbatim
//   Victory / Henry  / Kalunta  -> 66   as above, gender corrected as well
//   Victory / Henry  / Okonkwo  -> 33   surname deliberately wrong
//
// Supplying the CORRECT middle name did not move the score, so `middle_name` is
// never scored; one wrong surname cost exactly a third, so the percentage is
// (names matched / names on the register) over first and last only. 66 is
// therefore not a near miss - it is a PERFECT score for a three-name record, and
// the old 70 floor declined an identity Payvessel had confirmed as far as it is
// able to. These two stay as fixtures because the ceiling is invisible from the
// response alone: nothing in a lone 66 says "this is as high as it goes".
const realBvn = payvessel.gradeMatchResult({
  success: true,
  data: {
    name_match_rlt: 'PARTIAL_MATCH',
    gender_match_rlt: null,
    birthday_match_rlt: 'FULL_MATCH',
    names_match_percentage: '66',
    phone_number_match_rlt: null,
  },
}, 'BVN');
assert.strictEqual(realBvn.verified, true, '66 is a full match on a three-name register, not a near miss');
assert.strictEqual(realBvn.reason, null, 'a pass carries no decline reason');

// The negative control from the same session: same everything, wrong surname.
// This is what the floor is actually for, and it must stay declined.
const wrongSurname = payvessel.gradeMatchResult({
  success: true,
  data: {
    name_match_rlt: 'PARTIAL_MATCH',
    gender_match_rlt: null,
    birthday_match_rlt: 'FULL_MATCH',
    names_match_percentage: '33',
    phone_number_match_rlt: null,
  },
}, 'BVN');
assert.strictEqual(wrongSurname.verified, false, 'one name out of three is a different person');
assert.strictEqual(
  /gender|phone/.test(wrongSurname.reason), false,
  'unanswered fields must not be named as failures',
);
// The advice used to say "check your middle name". Payvessel ignores that field,
// so it sent people to edit the one box that cannot change the answer, at N30 an
// attempt. It must now point at the two names actually being compared.
assert.strictEqual(
  /middle name/.test(wrongSurname.reason), false,
  'never advise editing middle name - the BVN endpoint does not score it',
);
assert.match(wrongSurname.reason, /first name and surname/, 'the advice names the fields that are scored');

// The decline names the field but never the expected value - otherwise it is an
// oracle for guessing somebody's date of birth one digit at a time.
const declined = grade({ ...allMatch, birthday_match_rlt: 'NO_MATCH' });
assert.match(declined.reason, /date of birth/);
assert.strictEqual(/\d{4}-\d{2}-\d{2}/.test(declined.reason), false, 'the decline must not echo a value');

// The stored match object carries labels only, never a value from the register,
// which is what makes it safe to keep on the row and show to an admin.
const storedMatch = grade({ ...allMatch, gender_match_rlt: 'NO_MATCH' }).match;
assert.deepStrictEqual(Object.keys(storedMatch).sort(), [
  'birthday_match_rlt', 'gender_match_rlt', 'name_match_rlt', 'names_match_percentage', 'phone_number_match_rlt',
], 'only the comparison result is stored');

/* ================================================================ the BVN fee */

// ₦60 a lookup, and the number lives in exactly one function so the screen, the
// receipt and the debit cannot quote three different prices.
const withFee = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'KYC_BVN_FEE');
  const previous = process.env.KYC_BVN_FEE;
  if (value === undefined) delete process.env.KYC_BVN_FEE;
  else process.env.KYC_BVN_FEE = value;
  try {
    return fn();
  } finally {
    if (had) process.env.KYC_BVN_FEE = previous;
    else delete process.env.KYC_BVN_FEE;
  }
};

const fee = value => withFee(value, () => validators.bvnFee());

// THE ZERO-DEFAULT BUG, AND THE REASON THIS SECTION EXISTS.
//
// `Number('')` is 0, and 0 is a perfectly finite non-negative number, so a guard
// written as `Number.isFinite(n) && n >= 0` ACCEPTS it. Parsing before checking
// for the unset case therefore turned "nobody set KYC_BVN_FEE" into "the check
// is free" - silently, on every deployment that had not been told about the new
// variable, which is all of them on the day it ships. The empty case has to be
// caught BEFORE the parse. Same trap retry.helper.envInt documents.
assert.strictEqual(fee(undefined), 60, 'unset falls back to the documented ₦60, NOT to free');
assert.strictEqual(fee(''), 60, 'an empty string is unset, not zero');
assert.strictEqual(fee('   '), 60, 'and so is whitespace - a blank line in a .env file');

assert.strictEqual(fee('75'), 75, 'a price change is an env change, not a deploy');
assert.strictEqual(fee(' 75 '), 75, 'padding survives a copy-paste into a dashboard');
assert.strictEqual(fee('0'), 0, 'zero is honoured when it is ASKED for - a free promotion is a real thing');

assert.strictEqual(fee('free'), 60, 'junk falls back rather than becoming NaN');
assert.strictEqual(fee('-10'), 60, 'and a negative fee would CREDIT the wallet on every lookup');

/* =================================================== the ArewaSmart normalizers */

// A lookup api hands back a register record instead of a set of match labels, so
// everything below is about reading somebody's identity out of a shape the
// provider documented as "... other details" and never listed.

// The Payvessel lesson, carried over unchanged: an ABSENT field is not a WRONG
// field. Every one of these must come back null so the caller skips it rather
// than scoring it as a mismatch.
assert.strictEqual(arewasmart.pick({ a: 'x' }, ['b', 'a']), 'x', 'the first alias that has a value wins');
assert.strictEqual(arewasmart.pick({ a: '', b: 'y' }, ['a', 'b']), 'y', 'an empty string is not a value');
assert.strictEqual(arewasmart.pick({ a: 'null' }, ['a']), null,
  'the string "null" is what a JSON null looks like after a careless serializer');
assert.strictEqual(arewasmart.pick(null, ['a']), null, 'and a missing object is not a crash');
assert.strictEqual(arewasmart.pick({ a: '  padded  ' }, ['a']), 'padded');

// Dates. Nigerian registers are not consistent, and we have not seen
// ArewaSmart's spelling yet, so the rule is "handle what turns up, return null
// rather than guess".
assert.strictEqual(arewasmart.normalizeDob('1995-04-12'), '1995-04-12', 'ISO passes through');
assert.strictEqual(arewasmart.normalizeDob('1995/4/2'), '1995-04-02', 'and is padded');
assert.strictEqual(arewasmart.normalizeDob('12/04/1995'), '1995-04-12',
  'DD/MM/YYYY is read DAY-FIRST - the Nigerian convention, and a real ambiguity for the first 12 of a month');
assert.strictEqual(arewasmart.normalizeDob('12-Apr-1995'), '1995-04-12', 'the spelled-out month register format');
assert.strictEqual(arewasmart.normalizeDob('12 April 1995'), '1995-04-12', 'including the long month name');
assert.strictEqual(arewasmart.normalizeDob('not a date'), null, 'anything else is null, never a guess');
assert.strictEqual(arewasmart.normalizeDob(''), null);
assert.strictEqual(arewasmart.normalizeDob(null), null);
// A date of birth is stored, not scored - the NAME is what verification turns
// on - so a null here costs a column, not a customer. That is why the DDL made
// dob_enc nullable rather than making this function try harder.

assert.strictEqual(arewasmart.normalizeGender('Male'), 'MALE');
assert.strictEqual(arewasmart.normalizeGender('f'), 'FEMALE', 'registers abbreviate');
assert.strictEqual(arewasmart.normalizeGender('OTHER'), null, 'an unrecognised value is null, not a default');
assert.strictEqual(arewasmart.normalizeGender(''), null);

assert.strictEqual(arewasmart.normalizePhone('08031234567'), '2348031234567');
assert.strictEqual(arewasmart.normalizePhone('+234 803 123 4567'), '2348031234567', 'punctuation and spaces');
assert.strictEqual(arewasmart.normalizePhone('8031234567'), '2348031234567', 'the bare ten digits');
assert.strictEqual(arewasmart.normalizePhone('12345'), null, 'too short is null, never a padded fiction');
assert.strictEqual(arewasmart.normalizePhone(null), null);

// The record, reduced to the fields we have a use for. Anything the register
// also sent - an address, a photograph, an enrolment branch, a NIN - is dropped
// HERE, at the boundary, so no careless spread further in can leak it.
const record = arewasmart.extractRecord({
  bvn: '22212345678',
  first_name: 'ADA',
  surname: 'OKAFOR',
  other_names: 'CHINELO',
  date_of_birth: '12-04-1995',
  sex: 'Female',
  phone_number1: '08031234567',
  // Everything below is real BVN-register content and must NOT survive.
  address: '12 Awolowo Road, Ikoyi',
  nin: '70011122233',
  enrollmentBank: '044',
  image: 'data:image/jpeg;base64,....',
});
assert.deepStrictEqual(Object.keys(record).sort(),
  ['bvn', 'dateOfBirth', 'firstName', 'gender', 'lastName', 'middleName', 'phoneNumber'],
  'seven fields, and the address, NIN, enrolment bank and photograph are not among them');
assert.strictEqual(record.firstName, 'ADA', 'read through the snake_case alias');
assert.strictEqual(record.lastName, 'OKAFOR', '`surname` is the other spelling registers use');
assert.strictEqual(record.middleName, 'CHINELO', '`other_names` is where the middle name usually lives');
assert.strictEqual(record.dateOfBirth, '1995-04-12');
assert.strictEqual(record.gender, 'FEMALE');
assert.strictEqual(record.phoneNumber, '2348031234567');
assert.strictEqual(arewasmart.extractRecord(null), null, 'no data, no record');

// A record with no name at all is not a verdict about the customer - it is a
// contract we have misread - and verifyBvn turns it into a 503 rather than
// declining somebody and charging them for it.
const nameless = arewasmart.extractRecord({ bvn: '22212345678' });
assert.strictEqual(nameless.firstName, null);
assert.strictEqual(nameless.lastName, null);

// The documented shape, and the one-level-deeper wrapping some gateways add.
assert.strictEqual(arewasmart.unwrap({ data: { bvn: '1' } }).bvn, '1', 'the documented shape');
assert.strictEqual(arewasmart.unwrap({ data: { data: { bvn: '2' } } }).bvn, '2', 'one level deeper');
assert.strictEqual(arewasmart.unwrap({ data: { bvn: '3', data: { bvn: '4' } } }).bvn, '3',
  'a payload that has BOTH is not double-wrapped - the outer one is the record');
assert.strictEqual(arewasmart.unwrap({}), null);
assert.strictEqual(arewasmart.unwrap({ data: [] }), null, 'an array is not a record');

assert.strictEqual(arewasmart.isSuccess({ status: 'success' }, 200), true, 'the documented success');
assert.strictEqual(arewasmart.isSuccess({ status: 'SUCCESS' }, 200), true, 'case is normalised');
assert.strictEqual(arewasmart.isSuccess({ status: 'failed' }, 200), false,
  'a 200 carrying a failure body is a failure - plenty of Nigerian gateways answer 200 for everything');
assert.strictEqual(arewasmart.isSuccess({ status: 'success' }, 404), false,
  'and an HTTP error outranks a success string, not the other way round');
assert.strictEqual(arewasmart.isSuccess({ success: true }, 200), true, 'the boolean spelling');
assert.strictEqual(arewasmart.isSuccess({ success: false }, 200), false);
assert.strictEqual(arewasmart.isSuccess({ data: { bvn: '1' } }, 200), true,
  'no status key at all: fall back to the documented success SHAPE, not to "any 200"');
assert.strictEqual(arewasmart.isSuccess({}, 200), false, 'an empty 200 is not a hit');

// Provider text is shown to nobody, but it is stored as a decline reason.
assert.strictEqual(arewasmart.safeMessage('', 'fallback'), 'fallback');
assert.strictEqual(arewasmart.safeMessage('  a   b  ', 'x'), 'a b', 'whitespace collapsed');
assert.strictEqual(arewasmart.safeMessage('z'.repeat(500), 'x').length, 160,
  'and capped - a provider that echoes the record back must not write it into our column');

/* ------------------------------------------------------ the NIN register record */

// The reviewer's lookup, parsed from the provider's documented sample verbatim.
// The sample is the one published for the V2 endpoint; it is kept after the move
// to /nin/verify because the extractor is alias-driven and this is the widest
// shape it has to survive - not because it is the shape we now expect.
// This one carries a PHOTOGRAPH, which is the whole reason it exists: a reviewer
// holding a forged slip beside the register's own portrait is doing a check the
// applicant cannot fake by being internally consistent.
const ninRecord = arewasmart.extractNinRecord({
  reference: 'NINV212345ABC',
  firstname: 'JOHN',
  surname: 'DOE',
  middlename: 'PETER',
  gender: 'm',
  nin: '12345678901',
  birthdate: '22-02-1990',
  telephoneno: '08012345678',
  photo_path: '/9j/4AAQSkZJRgABAQAAAQABAAD',
  signature_path: '/9j/4AAQSkZJRgABAQAAAQABAAD',
  trackingId: 'TRK123456789Z',
  status: 'successful',
  amount: '50.00',
});

assert.strictEqual(ninRecord.firstName, 'JOHN');
assert.strictEqual(ninRecord.lastName, 'DOE', '`surname`, as the NIN register spells it');
assert.strictEqual(ninRecord.middleName, 'PETER');
assert.strictEqual(ninRecord.dateOfBirth, '1990-02-22', 'DD-MM-YYYY, which is not what Postgres wants');
assert.strictEqual(ninRecord.gender, 'MALE', 'a single letter is the whole value here');
assert.strictEqual(ninRecord.phoneNumber, '2348012345678',
  '`telephoneno` is the NIN spelling and is not one of the BVN phone keys - a shared list is why it resolves');
assert.strictEqual(ninRecord.trackingId, 'TRK123456789Z');
assert.strictEqual('signature' in ninRecord, false,
  'documented, and deliberately not read: it answers nothing the portrait does not, and what is never ' +
  'extracted can never be leaked by a careless spread further in');
assert.strictEqual('amount' in ninRecord, false, 'what the provider charged US is not part of a person\'s record');
assert.strictEqual(arewasmart.extractNinRecord(null), null);

// The photograph arrives as bare base64 and is useless to an <img> until it is
// told what it is. That framing happens once, here, rather than in the browser.
assert.strictEqual(arewasmart.asPhotoDataUri('/9j/4AAQSkZJRg'), 'data:image/jpeg;base64,/9j/4AAQSkZJRg',
  'prefixed exactly once');
assert.strictEqual(arewasmart.asPhotoDataUri('data:image/png;base64,iVBOR'), 'data:image/png;base64,iVBOR',
  'a provider that already framed it is left alone rather than double-prefixed');
assert.strictEqual(arewasmart.asPhotoDataUri('<script>alert(1)</script>'), null,
  'anything that is not base64 is dropped - this string ends up in a src attribute');
assert.strictEqual(arewasmart.asPhotoDataUri('A'.repeat(4_000_000)), null,
  'and an oversized one is dropped rather than pushed through a JSON response');
assert.strictEqual(arewasmart.asPhotoDataUri(''), null);
assert.strictEqual(arewasmart.asPhotoDataUri(null), null);

/* ------------------------------------------------------------ the retry policy */

// DELIBERATELY NARROWER THAN retry.helper's isTransient, and the difference is
// money. Every repeat of this call is another billable lookup, so it repeats
// ONLY where the request provably never reached the register. A customer
// resubmitting after a 503 costs them nothing - the fee follows a completed
// lookup - but a blind retry can pay for the same lookup three times.
const retryable = err => arewasmart.shouldRetryLookup(err);

assert.strictEqual(retryable({ code: 'ECONNREFUSED' }), true, 'nothing was sent - the socket never opened');
assert.strictEqual(retryable({ code: 'ENOTFOUND' }), true, 'DNS never resolved');
assert.strictEqual(retryable({ code: 'EAI_AGAIN' }), true);
assert.strictEqual(retryable({ code: 'UND_ERR_CONNECT_TIMEOUT' }), true, 'the CONNECT timed out, not the request');
assert.strictEqual(retryable({ cause: { code: 'ECONNREFUSED' } }), true, 'undici buries the code one level down');
assert.strictEqual(retryable({ statusCode: 429 }), true, 'a throttle is an invitation to come back');
assert.strictEqual(retryable({ statusCode: 503 }), true, 'and so is an explicit "unavailable"');

assert.strictEqual(retryable({ name: 'AbortError' }), false,
  'OUR timeout fired - the register may well have answered, and may well have billed us');
assert.strictEqual(retryable({ code: 'ECONNRESET' }), false,
  'the connection was up, so the request was probably delivered');
assert.strictEqual(retryable({ statusCode: 500 }), false, 'a 500 can be a lookup that ran and then fell over');
assert.strictEqual(retryable({ statusCode: 502 }), false);
assert.strictEqual(retryable({ statusCode: 504 }), false, 'a gateway timeout means the upstream WAS reached');
assert.strictEqual(retryable({ statusCode: 402 }), false, 'an empty prepaid balance will not fix itself in 1.25s');
assert.strictEqual(retryable({ statusCode: 401 }), false, 'and a rejected token will not either');
assert.strictEqual(retryable(null), false);
assert.strictEqual(retryable({}), false, 'an error we cannot classify is not retried - the default is "do not spend"');

console.log('✅ kyc gate, identity+bank rule, validators, name matcher, BVN fee,');
console.log('   ArewaSmart BVN + NIN normalizers, retry policy, and the archived Payvessel grader all pass');
