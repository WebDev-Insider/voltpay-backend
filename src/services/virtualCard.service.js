/**
 * USD Virtual Mastercard - the engine. One card per customer, issued by
 * Payvessel, funded in naira from the VoltPay wallet. The rules are in
 * helpers/virtualCard.helper.js, the wire format in
 * funding/payvesselCard.service.js; the controllers are HTTP in and out.
 *
 * WHERE THE MONEY IS. The customer's naira moves in OUR ledger
 * (wallet_transactions, through the balance helper) and nowhere else. The
 * dollars live at Payvessel: card balances, and our business USD wallet that
 * funds them. So a card's balance is always Payvessel's figure, read back -
 * never computed here - and a card transaction is a display row, not a ledger
 * row.
 *
 * DEBIT FIRST, THEN ASK - AND NEVER ASK TWICE. Creating and funding both
 * reserve the wallet in ONE transaction (claim + SQL-guarded balance + ledger
 * row), and only then call Payvessel. What happens next depends on the answer:
 *
 *   accepted    the money stays debited; a create is `creating` until the card
 *               reads ACTIVE, a top-up is `successful`
 *   refused     Payvessel provably did nothing - refunded in one transaction,
 *               guarded so it can happen once
 *   ambiguous   sent, answer lost. NOT refunded: the call may have run, and
 *               neither call takes an idempotency key, so re-sending is how
 *               one card becomes two. The sweep reads the card back (or
 *               finds it in the list), and refunds only after several
 *               successful reads over a window show nothing happened.
 *
 * THE WEBHOOK IS REQUIRED; THE SWEEP IS THE BACKSTOP. Payvessel's webhook is
 * how a card's activity reaches us in real time - purchases, declines,
 * refunds, fees, a card becoming ready - and the only source of the customer's
 * "you paid $X at Y" push. It is answered within Payvessel's 10-second window
 * (database work only; the read-back runs after the answer) and every
 * delivery is logged for the admin. Money never waits on it, though: a lost
 * delivery is caught by the 5-minute sweep and the app's own reads, which
 * settle every create and top-up with no webhook at all. Payvessel has only
 * accepted a callback URL on the business website's own domain (see
 * payvesselAccount.service.js), so the backend must be reachable there.
 *
 * CREDENTIALS. The full card number and CVV exist only inside reveal(), for
 * the length of one authenticated, PIN-checked request. Nothing stores,
 * caches or logs them; the masked number, expiry and name are protectText().
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');

const prisma = require('../../database/prisma');
const VC = require('../helpers/virtualCard.helper');
const payvessel = require('../funding/payvesselCard.service');
const { blindIndex, reveal, revealUserFields, verifySecret, protectText, revealText } = require('../helpers/pii.helper');
const { applyBalanceDelta, restampBalance } = require('../helpers/balance.helper');
const { isFeatureEnabled, setFeature } = require('../helpers/featureFlag.helper');
const { isKycVerified } = require('../helpers/kycGate.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');
const { generateTrx } = require('./airtime.service');
const { notifyUser } = require('./notify.service');
const { logUserEvent } = require('./userAudit.service');
const { captureError, paymentFailure, securityEvent } = require('./alerts.service');

const { STATUS, FUNDING, LIVE_STATUSES, refusal } = VC;

const FEATURE = 'virtual_card';

const minutes = n => n * 60_000;
const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// An answer we could not read is settled by reading back, and only refunded
// once this long has passed AND this many reads succeeded without finding it.
const CREATE_REFUND_AFTER_MS = () => envMs('VCARD_CREATE_UNKNOWN_REFUND_AFTER_MS', minutes(30));
const FUND_REFUND_AFTER_MS = () => envMs('VCARD_FUND_UNKNOWN_REFUND_AFTER_MS', minutes(30));
const READS_BEFORE_REFUND = 3;
// A row stamped `pending` was debited and never sent: the process died between
// the two. After this long nobody is coming back to send it.
const NEVER_SENT_AFTER_MS = minutes(2);
// A card Payvessel keeps PENDING longer than this pages ops, once.
const PENDING_ALERT_AFTER_MS = () => envMs('VCARD_PENDING_ALERT_AFTER_MS', minutes(120));
// How fresh a balance must be before a top-up checks the max-balance limit, or
// the dashboard re-reads it.
const BALANCE_FRESH_MS = 60_000;
const HOME_PROVIDER_BUDGET_MS = 6_000;
const REMINDER_AFTER_DAYS = () => envMs('VCARD_FUND_REMINDER_DAYS', 14);
// A termination Payvessel accepted, or whose answer was lost, and that still
// reads open this long after: it never happened, and the request is closed.
const TERMINATE_SETTLE_MS = () => envMs('VCARD_TERMINATE_SETTLE_MS', minutes(30));

const OUTAGE_KINDS = new Set(['misconfigured', 'float', 'rate_limited', 'outage']);

/* ------------------------------------------------------------ small parts */

const decimalKobo = kobo => new Prisma.Decimal(VC.koboToDecimal(kobo));
const nairaOf = d => Number(d?.toString?.() ?? d ?? 0);
const koboOf = d => Math.round(nairaOf(d) * 100);
const ZERO = new Prisma.Decimal('0.00');

function since(date, now = Date.now()) {
  return date ? now - new Date(date).getTime() : Infinity;
}

/** The value, or `fallback` once `ms` passes. The work itself carries on. */
function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function actorOf(admin) {
  if (!admin) return 'admin';
  return `admin:${String(admin.name || admin.id || 'admin').slice(0, 48)}`;
}

async function event(db, card, name, { actor = 'system', meta = null } = {}) {
  return db.virtualCardEvent.create({ data: { card_id: card.id, event: name, actor, meta } });
}

function notify(card, key, subject, message) {
  const data = { card_id: card.id, status: card.status };
  return notifyUser({
    userId: card.user_id,
    subject,
    message,
    type: 'virtual_card',
    data,
    // The app routes a tap on `type`, and only `pushData` reaches the device.
    pushData: { ...data, type: 'virtual_card' },
    clientMessageId: key,
  }).catch(() => false);
}

/** Ops. Ids and amounts only - a provider message can quote a name. */
function pageOps(action, card, error, extra = {}) {
  return paymentFailure({
    provider: 'payvessel',
    action,
    reference: extra.reference || card?.reference || null,
    userId: card?.user_id,
    amount: extra.amount,
    message: `${error?.kind || 'error'}: ${String(error?.providerMessage || error?.message || 'card call failed').slice(0, 160)}`,
    context: { card_id: card?.id || null, kind: error?.kind || null },
  }).catch(() => false);
}

/** "You were refunded" in the customer's words, for a refusal kind. */
function failureWording(error) {
  if (!error || OUTAGE_KINDS.has(error.kind)) return 'Our card partner is briefly unavailable.';
  if (error.kind === 'not_found') return 'Our card partner could not find your card.';
  return error.message || 'Our card partner declined the request.';
}

/* ---------------------------------------------------------------- settings */

async function readSettingRows() {
  return prisma.appSetting
    .findMany({
      where: { setting_key: { in: VC.SETTING_KEYS } },
      select: { setting_key: true, setting_value: true, updated_at: true, created_at: true },
    })
    .catch(() => []);
}

/**
 * The live terms. Never cached: a rate an admin just changed must be the rate
 * the next customer pays.
 */
async function getSettings({ now = new Date() } = {}) {
  const [rows, enabled] = await Promise.all([readSettingRows(), isFeatureEnabled(FEATURE)]);
  return VC.parseSettings(rows, { enabled, configured: payvessel.isConfigured(), now });
}

/**
 * Admin. Any subset of the SETTINGS names, plus `enabled` for the kill switch.
 * Every value is validated against the same parser that reads it back, so a
 * value that saves is a value that works.
 */
async function updateSettings(input = {}) {
  const writes = [];
  for (const [name, spec] of Object.entries(VC.SETTINGS)) {
    if (input[name] === undefined) continue;
    const raw = String(input[name] ?? '').replace(/,/g, '').trim();
    const parsed = VC.parseSettingValue(spec.kind, raw);
    if (parsed == null) {
      throw refusal(400, 'validation_error', `${spec.label}: enter a valid ${spec.kind === 'naira' ? 'whole naira amount' : 'number'}.`);
    }
    // A floor set by the provider, said out loud rather than clamped quietly.
    if (spec.min != null && parsed < spec.min) {
      throw refusal(400, 'validation_error', `${spec.label}: at least ${VC.usdText(spec.min)} - Payvessel will not create a card with less.`);
    }
    writes.push({ key: spec.key, value: raw, label: spec.label });
  }
  // The rate drives what customers pay, so a fat-fingered one is refused here
  // rather than discovered on a statement: a 25% move in one save is a typo.
  const rateWrite = writes.find(w => w.key === VC.SETTINGS.fx_cost_rate.key);
  if (rateWrite && !input.confirm_rate_jump) {
    const current = (await readSettingRows()).find(r => r.setting_key === rateWrite.key);
    const before = VC.parseSettingValue('rate', current?.setting_value);
    const after = VC.parseSettingValue('rate', rateWrite.value);
    if (before && after && Math.abs(after - before) / before > 0.25) {
      throw refusal(409, 'rate_jump', `That moves the dollar rate by more than 25% (₦${(before / 100).toLocaleString()} → ₦${(after / 100).toLocaleString()}). Save again with "confirm" if it is right.`);
    }
  }
  for (const w of writes) {
    // updated_at is the rate's timestamp - re-saving the same number is how an
    // admin confirms it is still current, so an unchanged value still writes.
    await prisma.appSetting.upsert({
      where: { setting_key: w.key },
      update: { setting_value: w.value },
      create: { setting_key: w.key, setting_value: w.value, description: `USD card: ${w.label}` },
    });
  }
  if (input.enabled !== undefined) {
    const on = input.enabled === true || ['1', 'true', 'on', 'yes'].includes(String(input.enabled).trim().toLowerCase());
    await setFeature(FEATURE, on);
  }
  return getSettings();
}

/** Admin view of the settings: everything, including the cost and margin. */
function adminSettingsView(s) {
  return {
    ...VC.publicSettings(s),
    create_prefund_usd: VC.usd(s.create_prefund_cents),
    // The part of every creation price that goes onto the card, at today's
    // cost - so the admin can see a price that cannot cover it. Payvessel's own
    // issuance fee comes on top and is not known to us exactly.
    prefund_cost_ngn:
      s.fx.cost_rate_kobo == null ? null : Math.ceil((s.create_prefund_cents * s.fx.cost_rate_kobo) / 100) / 100,
    fx_cost_rate: s.fx.cost_rate_kobo == null ? null : Number(VC.koboToDecimal(s.fx.cost_rate_kobo)),
    fx_margin_percent: s.fx.margin_bps / 100,
    customer_rate: s.fx.customer_rate_kobo == null ? null : Number(VC.koboToDecimal(s.fx.customer_rate_kobo)),
    fx_updated_at: s.fx.updated_at ? new Date(s.fx.updated_at).toISOString() : null,
    fx_age_hours: s.fx.age_hours,
    fx_max_age_hours: s.fx.max_age_hours,
    fx_stale: s.fx.stale,
    configured: s.configured,
    sandbox: payvessel.isSandboxHost(),
  };
}

/* ------------------------------------------------------------------ lookups */

async function liveCard(userId, db = prisma) {
  return db.virtualCard.findFirst({
    where: { user_id: Number(userId), status: { in: LIVE_STATUSES } },
    orderBy: { created_at: 'desc' },
  });
}

async function latestCard(userId) {
  return prisma.virtualCard.findFirst({ where: { user_id: Number(userId) }, orderBy: { created_at: 'desc' } });
}

async function freshUser(uid) {
  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) throw refusal(401, 'unauthorized', 'Please login again');
  return user;
}

/** Against a FRESH row: req.user may be a cached copy, and a PIN is never checked against one. */
async function checkPin(uid, pin) {
  const code = String(pin ?? '').trim();
  if (!code) throw refusal(400, 'validation_error', 'Enter your PIN to continue');
  const user = await freshUser(uid);
  if (!(await verifySecret(code, user.pin, 'pin')).ok) throw refusal(401, 'invalid_pin', 'Incorrect PIN');
  return user;
}

const walletBalance = user => nairaOf(user?.balance);

/* ----------------------------------------------------------------- identity */

const safeReveal = enc => {
  try {
    return enc ? reveal(enc) : '';
  } catch {
    return '';
  }
};

const last4 = v => (v ? String(v).slice(-4) : '');
const tidy = v => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Who this card is for. The name, phone and email come from the account and
 * its verification - never from the request - because Payvessel matches them
 * against the BVN, and a card is the account holder's or nobody's.
 *
 * The BVN and NIN come from the verification on file when there is one; a
 * customer verified by one document types the other here. Both are held for
 * this request only: what survives is a blind index each, so one identity can
 * never back cards on two VoltPay accounts.
 */
async function identity(uid, body = {}) {
  const [user, kyc] = await Promise.all([
    freshUser(uid),
    prisma.kycVerification.findUnique({
      where: { user_id: uid },
      select: {
        status: true,
        bvn_enc: true,
        nin_slip_status: true,
        nin_slip_number_enc: true,
        first_name_enc: true,
        last_name_enc: true,
        dob_enc: true,
      },
    }),
  ]);
  const profile = revealUserFields(user);

  // The register's name first - it is what Payvessel will check the BVN
  // against - and the profile's when the register gave none.
  const firstName = tidy(safeReveal(kyc?.first_name_enc)) || tidy(profile.firstname);
  const lastName = tidy(safeReveal(kyc?.last_name_enc)) || tidy(profile.lastname);
  if (!firstName || !lastName) {
    throw refusal(400, 'name_required', 'Your legal name is missing from your profile. Contact support to add it.');
  }

  const phone = normalizeNgPhone(profile.mobile);
  if (!phone) throw refusal(400, 'phone_required', 'Your profile needs a valid Nigerian phone number before you can get a card.');

  // Typed only when the profile has none - an email on the account is the one
  // we send receipts to, and it stays the card's.
  let email = tidy(profile.email).toLowerCase();
  const typedEmail = tidy(body.email).toLowerCase();
  if (!email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(typedEmail)) throw refusal(400, 'email_required', 'Enter a valid email address.');
    email = typedEmail;
  }

  const bvnOnFile = kyc?.status === 'verified' ? VC.digits11(safeReveal(kyc.bvn_enc)) : null;
  const ninOnFile = kyc?.nin_slip_status === 'approved' ? VC.digits11(safeReveal(kyc.nin_slip_number_enc)) : null;
  const bvn = bvnOnFile || VC.digits11(body.bvn);
  const nin = ninOnFile || VC.digits11(body.nin);
  if (!bvn) throw refusal(400, 'bvn_required', 'Enter your 11-digit BVN.');
  if (!nin) throw refusal(400, 'nin_required', 'Enter your 11-digit NIN.');

  const dobOnFile = VC.parseDob(safeReveal(kyc?.dob_enc));
  const dob = dobOnFile || VC.parseDob(body.dob);
  if (!dob) throw refusal(400, 'dob_required', 'Enter your date of birth.');
  if (VC.ageOn(dob) < 18) throw refusal(400, 'too_young', 'You must be 18 or older to get a USD card.');
  if (VC.ageOn(dob) > 110) throw refusal(400, 'dob_required', 'Check your date of birth.');

  return {
    user,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email,
    phone: phone.local,
    bvn,
    nin,
    dob,
    bvnTyped: !bvnOnFile,
    ninTyped: !ninOnFile,
    bvnIdx: blindIndex(bvn, 'bvn'),
    ninIdx: blindIndex(nin, 'nin_slip'),
  };
}

/**
 * One identity, one VoltPay account - checked against other customers' cards,
 * their verifications and their funding accounts, the same three places the
 * Fund Account flow checks a NIN.
 */
async function assertIdentityFree(uid, id) {
  const otherCard = await prisma.virtualCard.findFirst({
    where: {
      user_id: { not: uid },
      status: { not: STATUS.FAILED },
      OR: [{ bvn_idx: id.bvnIdx }, { nin_idx: id.ninIdx }],
    },
    select: { user_id: true },
  });
  let claim = otherCard ? { user_id: otherCard.user_id, via: 'card' } : null;

  if (!claim && id.bvnTyped) {
    const kyc = await prisma.kycVerification.findFirst({
      where: { user_id: { not: uid }, bvn_idx: id.bvnIdx },
      select: { user_id: true },
    });
    if (kyc) claim = { user_id: kyc.user_id, via: 'bvn' };
  }
  if (!claim && id.ninTyped) {
    const [kyc, funding] = await Promise.all([
      prisma.kycVerification.findFirst({
        where: { user_id: { not: uid }, OR: [{ nin_slip_number_idx: id.ninIdx }, { nin_idx: blindIndex(id.nin, 'nin') }] },
        select: { user_id: true },
      }),
      prisma.fundingTransaction.findFirst({
        where: { status: 'virtual_account', user_id: { not: uid }, raw_payload: { path: ['nin_idx'], equals: id.ninIdx } },
        select: { user_id: true },
      }),
    ]);
    if (kyc || funding) claim = { user_id: (kyc || funding).user_id, via: 'nin' };
  }

  if (claim) {
    securityEvent('virtual_card.identity_reuse', 'BVN or NIN already linked to another VoltPay account', {
      user_id: uid,
      existing_user_id: claim.user_id,
      via: claim.via,
    });
    throw refusal(409, 'identity_in_use', 'This BVN or NIN is already linked to another VoltPay account.');
  }
}

/** The form, prefilled from what the account already holds. */
async function form(userId) {
  const uid = Number(userId);
  const [settings, user, kyc] = await Promise.all([
    getSettings(),
    freshUser(uid),
    prisma.kycVerification.findUnique({
      where: { user_id: uid },
      select: {
        status: true,
        bvn_enc: true,
        nin_slip_status: true,
        nin_slip_number_enc: true,
        first_name_enc: true,
        last_name_enc: true,
        dob_enc: true,
      },
    }),
  ]);
  const profile = revealUserFields(user);
  const firstName = tidy(safeReveal(kyc?.first_name_enc)) || tidy(profile.firstname);
  const lastName = tidy(safeReveal(kyc?.last_name_enc)) || tidy(profile.lastname);
  const bvn = kyc?.status === 'verified' ? VC.digits11(safeReveal(kyc.bvn_enc)) : null;
  const nin = kyc?.nin_slip_status === 'approved' ? VC.digits11(safeReveal(kyc.nin_slip_number_enc)) : null;
  const dob = VC.parseDob(safeReveal(kyc?.dob_enc));
  const phone = normalizeNgPhone(profile.mobile);
  const zip = tidy(profile.zip);
  return {
    creation_fee: settings.creation_fee,
    starting_balance_usd: VC.usd(settings.create_prefund_cents),
    creation_available: settings.creation_available,
    creation_unavailable_reason: settings.creation_unavailable_reason,
    wallet_balance: walletBalance(user),
    first_name: firstName,
    last_name: lastName,
    name_on_card: `${firstName} ${lastName}`.trim().toUpperCase(),
    email: tidy(profile.email).toLowerCase(),
    email_on_file: Boolean(tidy(profile.email)),
    phone: phone ? phone.local : '',
    // Only ever the last four. The whole number never goes back to a phone.
    bvn_on_file: Boolean(bvn),
    bvn_last4: last4(bvn),
    nin_on_file: Boolean(nin),
    nin_last4: last4(nin),
    dob_on_file: Boolean(dob),
    dob: dob || '',
    street: tidy(profile.address),
    state: tidy(profile.state),
    lga: tidy(profile.city),
    postal_code: /^\d{6}$/.test(zip) ? zip : '',
    consent_text:
      'I agree that VoltPay shares my name, contact details, BVN, NIN, date of birth, address and photo with its card ' +
      'issuing partner to issue and manage my USD card.',
  };
}

/** The review step: everything checked except the PIN and the photo. */
async function validateApplication(userId, body = {}) {
  const uid = Number(userId);
  const settings = await getSettings();
  if (!settings.creation_available) throw refusal(503, 'creation_unavailable', settings.creation_unavailable_reason);
  if (!(await isKycVerified(uid))) {
    throw refusal(403, 'kyc_required', 'Verify your identity and bank account in Settings to get a USD card.');
  }
  const existing = await liveCard(uid);
  if (existing) throw refusal(409, 'card_exists', 'You already have a USD card.', { card: VC.publicCard(existing) });

  const id = await identity(uid, body);
  const address = VC.validateAddress(body);
  await assertIdentityFree(uid, id);

  const balance = walletBalance(id.user);
  return {
    settings,
    id,
    address,
    summary: {
      name_on_card: id.name.toUpperCase(),
      email: id.email,
      phone: id.phone,
      bvn_last4: last4(id.bvn),
      nin_last4: last4(id.nin),
      dob: id.dob,
      street: address.street,
      state: address.state,
      lga: address.lga,
      postal_code: address.postalCode,
      creation_fee: settings.creation_fee,
      starting_balance_usd: VC.usd(settings.create_prefund_cents),
      wallet_balance: balance,
      sufficient_balance: balance >= settings.creation_fee,
    },
  };
}

/* ----------------------------------------------------------------- creation */

const consented = v => v === true || ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * The creation price is the admin's and can change at any moment, so the app
 * sends the price it showed (`expected_fee`) and anything else is refused with
 * the price as it is now - never charged. Required, not optional: this route
 * has no older app build to stay compatible with, and an unseen price is
 * exactly the charge this check exists to stop.
 */
function assertCreationPrice(settings, expectedFee) {
  const shown = String(expectedFee ?? '').replace(/,/g, '').trim();
  const now = settings.creation_fee;
  if (!shown) throw refusal(400, 'validation_error', 'Review the card price and try again.', { creation_fee: now });
  if (Number(shown) !== now) {
    throw refusal(409, 'price_changed', `The card price is now ${VC.nairaText(now * 100)}. Review it and pay again.`, { creation_fee: now });
  }
}

/**
 * POST /virtual-card/create  { pin, consent, expected_fee, image, street, state, lga, postal_code, (bvn), (nin), (dob), (email) }
 *
 * The fee is reserved with the card row in one transaction; the call to
 * Payvessel happens after it commits, so a crash can only ever leave a paid
 * `creating` row - which the sweep finishes - never a card nobody paid for.
 * The price paid is frozen onto the card (`creation_fee`), so a refund always
 * returns what this customer paid, whatever the price is by then.
 */
async function createCard({ userId, body = {}, pin, req }) {
  const uid = Number(userId);
  const { settings, id, address } = await validateApplication(uid, body);
  assertCreationPrice(settings, body.expected_fee);
  if (!consented(body.consent)) throw refusal(400, 'consent_required', 'Tick the box to agree to share your details with our card partner.');
  const photo = VC.decodeImage(body.image);
  await checkPin(uid, pin);

  const feeKobo = settings.creation_fee * 100;
  const fee = decimalKobo(feeKobo);
  const reference = VC.newReference('VC');
  const trx = generateTrx('vcard');

  let card;
  try {
    card = await prisma.$transaction(async tx => {
      // The one-live-card-per-user partial unique index is the guard here: two
      // taps racing both reach this insert and the loser's P2002 rolls back
      // its debit with it.
      const row = await tx.virtualCard.create({
        data: {
          user_id: uid,
          reference,
          status: STATUS.CREATING,
          create_state: 'pending',
          brand: VC.BRAND,
          currency: 'USD',
          name_enc: protectText(id.name),
          creation_fee: fee,
          creation_trx: trx,
          bvn_idx: id.bvnIdx,
          nin_idx: id.ninIdx,
        },
      });
      const reserved = await tx.user.updateMany({
        where: { id: uid, balance: { gte: fee } },
        data: { balance: { decrement: fee } },
      });
      if (!reserved.count) {
        throw refusal(400, 'insufficient_balance', `Your wallet balance is below ${VC.nairaText(feeKobo)}. Fund your wallet and try again.`);
      }
      await restampBalance(tx, 'user', uid);
      await tx.walletTransaction.create({
        data: {
          user_id: uid,
          trx,
          trx_type: '-',
          amount: fee,
          charge: ZERO,
          total_amount: fee,
          remark: 'virtual_card',
          details: protectText(`USD Virtual Mastercard - card creation, ${VC.usdText(settings.create_prefund_cents)} starting balance included`),
          other_data: {
            title: 'USD Card Creation',
            subtitle: protectText('Virtual Mastercard'),
            feedback: 'Successful',
            note: 'Wallet',
            image_src: '',
          },
          // Ids only. `meta` is not encrypted.
          meta: { kind: 'creation_fee', card_id: row.id, reference, prefund_cents: settings.create_prefund_cents },
        },
      });
      await event(tx, row, 'fee_charged', {
        actor: 'user',
        meta: { amount: settings.creation_fee, trx, prefund_cents: settings.create_prefund_cents },
      });
      return row;
    });
  } catch (e) {
    if (e?.code === 'P2002') throw refusal(409, 'card_exists', 'You already have a USD card.');
    throw e;
  }

  // Durable "about to send". A row still `pending` later was never sent, and
  // is refunded without asking anybody; a `sent` one may have reached
  // Payvessel and is only ever settled by reading back.
  await prisma.virtualCard.update({ where: { id: card.id }, data: { create_state: 'sent', create_attempted_at: new Date() } });

  let created = null;
  let failure = null;
  try {
    created = await payvessel.createCard({
      reference,
      name: id.name,
      brand: VC.BRAND,
      prefundCents: settings.create_prefund_cents,
      kyc: {
        firstName: id.firstName,
        lastName: id.lastName,
        email: id.email,
        phone: id.phone,
        bvn: id.bvn,
        nin: id.nin,
        dob: id.dob,
        image: photo.dataUrl,
        state: address.state,
        lga: address.lga,
        street: address.street,
        postalCode: address.postalCode,
      },
    });
  } catch (e) {
    failure = e;
  }
  // The BVN, NIN and photograph go out of scope here and are not kept.

  await logUserEvent({ req, userId: uid, event: 'virtual_card.create', metadata: { card_id: card.id, reference, outcome: failure ? failure.kind || 'error' : 'accepted' } }).catch(() => {});

  if (created) {
    const after = await applyProviderCard(card, created, { source: 'create' });
    return { card: VC.publicCard(after), processing: after.status === STATUS.CREATING };
  }

  if (failure?.kind === 'ambiguous' || !failure?.kind) {
    // Unknown: the sweep (and the app's next read) will find out.
    await prisma.virtualCard.update({
      where: { id: card.id },
      data: { create_state: 'unknown', provider_message: String(failure?.providerMessage || failure?.message || '').slice(0, 200) },
    });
    if (!failure?.kind) captureError('virtual_card.create', failure, { card_id: card.id });
    return { card: VC.publicCard(await prisma.virtualCard.findUnique({ where: { id: card.id } })), processing: true };
  }

  // Payvessel provably did nothing. Money back, in one transaction.
  const reason = failureWording(failure);
  await refundCreation(card, { reason, providerMessage: failure.providerMessage, createState: 'refused' });
  if (OUTAGE_KINDS.has(failure.kind)) pageOps('card_create', card, failure, { amount: settings.creation_fee });
  const fresh = await prisma.virtualCard.findUnique({ where: { id: card.id } });
  throw refusal(
    OUTAGE_KINDS.has(failure.kind) ? 503 : 422,
    OUTAGE_KINDS.has(failure.kind) ? 'card_unavailable' : 'card_declined',
    `We could not create your card. ${reason} Your ${VC.nairaText(feeKobo)} has been returned to your wallet.`,
    { card: VC.publicCard(fresh), refunded: true },
  );
}

/**
 * The creation fee goes back, once. The guarded claim (still `creating`, no
 * refund yet) is what makes the webhook, the sweep and the request that made
 * the card unable to refund it twice between them; the `_r` ledger trx is
 * unique as well.
 */
async function refundCreation(card, { reason, providerMessage = '', createState = null, actor = 'system' } = {}) {
  const refundTrx = `${card.creation_trx}_r`;
  const now = new Date();
  const done = await prisma.$transaction(async tx => {
    const claimed = await tx.virtualCard.updateMany({
      where: { id: card.id, status: STATUS.CREATING, refund_trx: null },
      data: {
        status: STATUS.FAILED,
        failed_at: now,
        failure_reason: String(reason || '').slice(0, 200),
        provider_message: String(providerMessage || '').slice(0, 200) || undefined,
        refund_trx: refundTrx,
        ...(createState ? { create_state: createState } : {}),
      },
    });
    if (!claimed.count) return false;
    await applyBalanceDelta(tx, 'user', card.user_id, card.creation_fee);
    await tx.walletTransaction.create({
      data: {
        user_id: Number(card.user_id),
        trx: refundTrx,
        trx_type: '+',
        amount: card.creation_fee,
        charge: ZERO,
        total_amount: card.creation_fee,
        remark: 'virtual_card',
        details: protectText('USD Virtual Mastercard - creation fee refunded'),
        other_data: {
          title: 'USD Card Refund',
          subtitle: protectText('Card could not be created'),
          feedback: 'Refunded',
          note: 'Wallet',
          image_src: '',
        },
        meta: { kind: 'creation_refund', card_id: card.id, reference: card.reference, reversal_of: card.creation_trx },
      },
    });
    const original = await tx.walletTransaction.findUnique({ where: { trx: card.creation_trx } });
    if (original) {
      const other = original.other_data && typeof original.other_data === 'object' ? original.other_data : {};
      await tx.walletTransaction.update({ where: { trx: card.creation_trx }, data: { other_data: { ...other, feedback: 'Failed', note: 'Refunded' } } });
    }
    await event(tx, card, 'refunded', { actor, meta: { trx: refundTrx, amount: nairaOf(card.creation_fee), reason: String(reason || '').slice(0, 120) } });
    return true;
  });
  return done;
}

/**
 * Payvessel's word on a card, applied to ours. Every transition is an
 * updateMany guarded on the status it leaves, so two readers racing - the
 * request that made the card, the webhook, the sweep, the app's poll - apply
 * it once, and only one of them sends the push.
 */
async function applyProviderCard(row, card, { source = 'poll' } = {}) {
  const now = new Date();
  const base = {
    provider_status: card.status,
    checked_at: now,
    ...(card.id && !row.provider_card_id ? { provider_card_id: card.id } : {}),
    ...(card.masked_pan ? { masked_pan_enc: protectText(card.masked_pan) } : {}),
    ...(card.expiry ? { expiry_enc: protectText(card.expiry) } : {}),
    ...(card.balance_cents != null ? { balance_cents: card.balance_cents, balance_synced_at: now } : {}),
  };
  const current = () => prisma.virtualCard.findUnique({ where: { id: row.id } });

  if (row.status === STATUS.CREATING && source === 'create') base.create_state = 'accepted';

  if (card.status === 'PENDING') {
    await prisma.virtualCard.update({ where: { id: row.id }, data: base });
    return current();
  }

  if (card.status === 'ACTIVE' || card.status === 'FROZEN') {
    const target = card.status === 'ACTIVE' ? STATUS.ACTIVE : STATUS.FROZEN;
    if (row.status === STATUS.CREATING) {
      const claimed = await prisma.virtualCard.updateMany({
        where: { id: row.id, status: STATUS.CREATING },
        data: {
          ...base,
          status: target,
          activated_at: now,
          create_state: 'accepted',
          // Created holding its starting balance: already funded, so no
          // "fund it within 21 days" warning and no reminder.
          ...(card.balance_cents > 0 && !row.first_funded_at ? { first_funded_at: now } : {}),
          ...(target === STATUS.FROZEN ? { frozen_at: now, frozen_by: 'provider' } : {}),
        },
      });
      if (claimed.count) {
        await event(prisma, row, 'activated', { meta: { source } });
        notify({ ...row, status: target }, `vcard-ready-${row.id}`, 'Your USD card is ready', 'Your VoltPay USD Virtual Mastercard is ready. Add dollars to start paying online.');
      }
      return current();
    }
    // A freeze or unfreeze made outside the app (Payvessel's own dashboard).
    if ([STATUS.ACTIVE, STATUS.FROZEN].includes(row.status) && row.status !== target) {
      await prisma.virtualCard.updateMany({
        where: { id: row.id, status: row.status },
        data: { ...base, status: target, ...(target === STATUS.FROZEN ? { frozen_at: now, frozen_by: row.frozen_by || 'provider' } : { frozen_at: null, frozen_by: null }) },
      });
      await event(prisma, row, target === STATUS.FROZEN ? 'frozen' : 'unfrozen', { meta: { source } });
      return current();
    }
    await prisma.virtualCard.update({ where: { id: row.id }, data: base });
    return current();
  }

  if (card.status === 'FAILED') {
    if (row.status === STATUS.CREATING) {
      await prisma.virtualCard.update({ where: { id: row.id }, data: base });
      const refunded = await refundCreation(row, { reason: 'Our card partner could not issue the card.', providerMessage: `FAILED (${source})` });
      if (refunded) {
        notify(row, `vcard-failed-${row.id}`, 'Your USD card could not be created', `We could not create your USD card. ${VC.nairaText(koboOf(row.creation_fee))} has been returned to your wallet.`);
      }
      return current();
    }
    captureError('virtual_card.unexpected_failed', new Error('A live card reads FAILED at Payvessel'), { card_id: row.id, status: row.status });
    return current();
  }

  if (card.status === 'TERMINATED') {
    await handleTermination(row, { amountCents: null, source });
    return current();
  }

  await prisma.virtualCard.update({ where: { id: row.id }, data: base });
  return current();
}

/**
 * Find a card whose create answer we never read. By our reference when
 * Payvessel echoes it, otherwise by name and time: a customer card, named
 * as we named it, made within the window of our attempt, and not already
 * someone else's row. More than one candidate is not guessed between.
 */
function findCreatedCard(cards, row, claimed) {
  const want = String(revealText(row.name_enc || '')).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
  const byRef = cards.find(c => c.reference && c.reference === row.reference);
  if (byRef) return { match: byRef };
  const at = new Date(row.create_attempted_at || row.created_at).getTime();
  const candidates = cards.filter(c => {
    if (!c.id || claimed.has(c.id)) return false;
    if (c.kind && c.kind !== 'customer') return false;
    const names = [c.card_name, c.customer_name].map(n => String(n || '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' '));
    if (!names.includes(want)) return false;
    const t = new Date(c.created_at || 0).getTime();
    return Number.isFinite(t) && t >= at - minutes(5) && t <= at + minutes(60);
  });
  if (candidates.length === 1) return { match: candidates[0] };
  return { match: null, ambiguous: candidates.length > 1 };
}

/**
 * Finish one `creating` card, by reading Payvessel. Safe from anywhere - the
 * sweep, the app's poll, the webhook - because every outcome is a guarded
 * transition.
 */
async function settleCreating(row) {
  if (!row || row.status !== STATUS.CREATING) return row;

  if (row.provider_card_id) {
    const card = await payvessel.getCard(row.provider_card_id);
    const after = await applyProviderCard(row, card, { source: 'poll' });
    if (after?.status === STATUS.CREATING && since(row.create_attempted_at || row.created_at) > PENDING_ALERT_AFTER_MS() && !row.pending_alerted_at) {
      await prisma.virtualCard.update({ where: { id: row.id }, data: { pending_alerted_at: new Date() } });
      pageOps('card_pending', row, { kind: 'pending', message: 'Card still PENDING at Payvessel' });
    }
    return after;
  }

  // Debited and never sent: whatever owned this request is gone. Nobody asked
  // Payvessel for anything, so there is nothing to wait for.
  if (row.create_state === 'pending') {
    if (since(row.updated_at) < NEVER_SENT_AFTER_MS) return row;
    await refundCreation(row, { reason: 'We could not reach our card partner.', providerMessage: 'never sent' });
    notify(row, `vcard-failed-${row.id}`, 'Your USD card could not be created', `We could not create your USD card. ${VC.nairaText(koboOf(row.creation_fee))} has been returned to your wallet.`);
    return prisma.virtualCard.findUnique({ where: { id: row.id } });
  }

  // Sent, answer lost. Look for it.
  const cards = await payvessel.listCards();
  const ids = cards.map(c => c.id).filter(Boolean);
  const owned = ids.length
    ? await prisma.virtualCard.findMany({ where: { provider_card_id: { in: ids }, id: { not: row.id } }, select: { provider_card_id: true } })
    : [];
  const { match, ambiguous } = findCreatedCard(cards, row, new Set(owned.map(o => o.provider_card_id)));
  if (match) {
    const linked = await prisma.virtualCard.updateMany({ where: { id: row.id, provider_card_id: null }, data: { provider_card_id: match.id, create_state: 'accepted' } });
    if (linked.count) await event(prisma, row, 'linked', { meta: { via: match.reference === row.reference ? 'reference' : 'name_time' } });
    const fresh = await prisma.virtualCard.findUnique({ where: { id: row.id } });
    return applyProviderCard(fresh, match, { source: 'reconcile' });
  }

  // A read that succeeded and found nothing. Counted, and only a run of them
  // over the whole window is evidence that the create never happened.
  const checks = (row.create_checks || 0) + 1;
  await prisma.virtualCard.update({ where: { id: row.id }, data: { create_checks: checks, checked_at: new Date() } });
  if (ambiguous) {
    pageOps('card_reconcile', row, { kind: 'ambiguous', message: 'Several Payvessel cards match a lost create; not linked automatically' });
    return prisma.virtualCard.findUnique({ where: { id: row.id } });
  }
  if (checks >= READS_BEFORE_REFUND && since(row.create_attempted_at || row.created_at) > CREATE_REFUND_AFTER_MS()) {
    const refunded = await refundCreation(row, { reason: 'We could not confirm your card with our card partner.', providerMessage: 'not found after window' });
    if (refunded) {
      notify(row, `vcard-failed-${row.id}`, 'Your USD card could not be created', `We could not create your USD card. ${VC.nairaText(koboOf(row.creation_fee))} has been returned to your wallet.`);
      // Refunded on absence of evidence: worth a look on Payvessel's side.
      pageOps('card_create_unconfirmed', row, { kind: 'unconfirmed', message: 'Refunded a create Payvessel never showed - check their dashboard for this reference' });
    }
  }
  return prisma.virtualCard.findUnique({ where: { id: row.id } });
}

/* ---------------------------------------------------------------- home/read */

/** Re-read balance and status for a live card. Best effort by design. */
async function refreshCard(row) {
  if (!row?.provider_card_id || ![STATUS.ACTIVE, STATUS.FROZEN].includes(row.status)) return row;
  const card = await payvessel.getCard(row.provider_card_id);
  return applyProviderCard(row, card, { source: 'refresh' });
}

async function feed(card, { page = 1, perPage = 20 } = {}) {
  if (!card) return { items: [], total: 0 };
  const [fundings, txns] = await Promise.all([
    prisma.virtualCardFunding.findMany({ where: { card_id: card.id }, orderBy: { created_at: 'desc' }, take: 300 }),
    prisma.virtualCardTransaction.findMany({ where: { card_id: card.id }, orderBy: { occurred_at: 'desc' }, take: 300 }),
  ]);
  const all = VC.mergeFeed(fundings, txns);
  const size = Math.min(50, Math.max(1, Number(perPage) || 20));
  const p = Math.max(1, Number(page) || 1);
  return { items: all.slice((p - 1) * size, p * size), total: all.length, page: p, per_page: size };
}

/**
 * GET /virtual-card - everything the card screens open on. A card still being
 * made is asked about here too, within a budget, so the processing screen
 * moves as soon as Payvessel does.
 */
async function home(userId) {
  const uid = Number(userId);
  const [settings, user, verified] = await Promise.all([getSettings(), freshUser(uid), isKycVerified(uid)]);
  let card = await latestCard(uid);

  if (card?.status === STATUS.CREATING) {
    card = await withDeadline(settleCreating(card), HOME_PROVIDER_BUDGET_MS, card);
  } else if (card && [STATUS.ACTIVE, STATUS.FROZEN].includes(card.status) && since(card.balance_synced_at) > BALANCE_FRESH_MS) {
    card = await withDeadline(
      (async () => {
        const fresh = await refreshCard(card);
        await syncTransactions(fresh).catch(() => null);
        return fresh;
      })(),
      HOME_PROVIDER_BUDGET_MS,
      card,
    );
  }

  const live = card && LIVE_STATUSES.includes(card.status);
  const recent = live ? (await feed(card, { perPage: 5 })).items : [];
  const processing = live
    ? await prisma.virtualCardFunding.findFirst({ where: { card_id: card.id, status: FUNDING.PROCESSING }, orderBy: { created_at: 'desc' } })
    : null;

  return {
    settings: VC.publicSettings(settings),
    card: VC.publicCard(card),
    has_live_card: Boolean(live),
    recent_transactions: recent,
    pending_top_up: processing ? VC.fundingItem(processing) : null,
    wallet_balance: walletBalance(user),
    kyc_verified: verified,
  };
}

async function transactions(userId, { page = 1 } = {}) {
  const card = (await liveCard(userId)) || (await latestCard(userId));
  const out = await feed(card, { page, perPage: 20 });
  return { ...out, total_pages: Math.max(1, Math.ceil(out.total / out.per_page)) };
}

/* ------------------------------------------------------------------ funding */

/** Dollars already bought for this card today, Lagos time. Processing counts. */
async function fundedTodayCents(cardId, now = new Date()) {
  const { year, month, day } = lagosDateParts(now);
  const agg = await prisma.virtualCardFunding.aggregate({
    where: { card_id: cardId, status: { in: [FUNDING.PROCESSING, FUNDING.SUCCESSFUL] }, created_at: { gte: lagosMidnightUtc(year, month, day) } },
    _sum: { amount_cents: true },
  });
  return Number(agg?._sum?.amount_cents || 0);
}

async function fundableCard(uid) {
  const card = await liveCard(uid);
  if (!card) throw refusal(404, 'no_card', 'You do not have a USD card yet.');
  if (card.status === STATUS.CREATING) throw refusal(409, 'card_not_ready', 'Your card is still being created. Try again in a few minutes.');
  if (card.status === STATUS.FROZEN) throw refusal(409, 'card_frozen', 'Your card is frozen. Unfreeze it to add money.');
  // Money added under a termination would be on a card about to close, and
  // outside the balance recorded for its refund.
  if (await openTermination(card.id)) {
    throw refusal(409, 'card_terminating', 'Your card is being terminated, so it cannot take money. We will notify you as soon as it is done.');
  }
  return card;
}

/** GET /virtual-card/quote?amount= - prices a top-up, moves nothing. */
async function quote(userId, amountNgn) {
  const uid = Number(userId);
  const settings = await getSettings();
  let card = await fundableCard(uid);
  if (since(card.balance_synced_at) > BALANCE_FRESH_MS) card = await withDeadline(refreshCard(card), HOME_PROVIDER_BUDGET_MS, card);
  const q = VC.quoteFunding({
    amountNgn,
    settings,
    feeDueCents: card.fee_due_cents,
    balanceCents: card.balance_cents,
    todayCents: await fundedTodayCents(card.id),
  });
  const user = await freshUser(uid);
  return { quote: VC.publicQuote(q), wallet_balance: walletBalance(user), sufficient_balance: koboOf(user.balance) >= q.total_kobo };
}

/**
 * POST /virtual-card/fund  { amount, expected_total, pin }
 *
 * `expected_total` is the naira the customer saw. If the rate or a fee moved
 * since, the top-up is refused with the new quote rather than charged at a
 * number nobody agreed to.
 */
async function fundCard({ userId, amountNgn, expectedTotal, pin, req }) {
  const uid = Number(userId);
  const settings = await getSettings();
  if (!settings.funding_available) throw refusal(503, 'funding_unavailable', settings.funding_unavailable_reason);
  if (!(await isKycVerified(uid))) throw refusal(403, 'kyc_required', 'Verify your identity and bank account in Settings to top up your card.');

  let card = await fundableCard(uid);
  if (since(card.balance_synced_at) > BALANCE_FRESH_MS) card = await withDeadline(refreshCard(card), HOME_PROVIDER_BUDGET_MS, card);
  if (card.status !== STATUS.ACTIVE) throw refusal(409, 'card_frozen', 'Your card is frozen. Unfreeze it to add money.');

  const q = VC.quoteFunding({
    amountNgn,
    settings,
    feeDueCents: card.fee_due_cents,
    balanceCents: card.balance_cents,
    todayCents: await fundedTodayCents(card.id),
  });
  if (expectedTotal !== undefined && expectedTotal !== null && expectedTotal !== '') {
    if (Math.round(Number(expectedTotal) * 100) !== q.total_kobo) {
      throw refusal(409, 'quote_changed', `The price has changed: ${VC.nairaText(q.total_kobo)} now. Review it and try again.`, { quote: VC.publicQuote(q) });
    }
  }
  await checkPin(uid, pin);

  const reference = generateTrx('vcfund');
  const total = decimalKobo(q.total_kobo);
  const now = new Date();

  let funding;
  try {
    funding = await prisma.$transaction(async tx => {
      // Fees Payvessel recovered from our wallet are settled out of this
      // top-up. Claimed against the exact figure that was quoted, so a fee
      // arriving mid-request re-quotes instead of being skipped or doubled.
      if (q.fee_due_cents > 0) {
        const taken = await tx.virtualCard.updateMany({
          where: { id: card.id, fee_due_cents: q.fee_due_cents },
          data: { fee_due_cents: 0 },
        });
        if (!taken.count) throw refusal(409, 'quote_changed', 'Your card fees changed. Review the top-up and try again.');
      }
      // One top-up in flight per card - the partial unique index on
      // (card_id) WHERE status = 'processing' - so two taps cannot both debit.
      const row = await tx.virtualCardFunding.create({
        data: {
          card_id: card.id,
          user_id: uid,
          reference,
          status: FUNDING.PROCESSING,
          provider_state: 'pending',
          amount_ngn: decimalKobo(q.amount_kobo),
          fee_ngn: decimalKobo(q.fee_kobo),
          total_ngn: total,
          amount_cents: q.cents,
          fee_cents: q.fee_cents,
          fee_due_cents: q.fee_due_cents,
          provider_amount_cents: q.provider_cents,
          rate_kobo: q.rate_kobo,
          cost_rate_kobo: q.cost_rate_kobo,
        },
      });
      const reserved = await tx.user.updateMany({
        where: { id: uid, balance: { gte: total } },
        data: { balance: { decrement: total } },
      });
      if (!reserved.count) {
        throw refusal(400, 'insufficient_balance', `Your wallet balance is below ${VC.nairaText(q.total_kobo)}. Fund your wallet and try again.`);
      }
      await restampBalance(tx, 'user', uid);
      await tx.walletTransaction.create({
        data: {
          user_id: uid,
          trx: reference,
          trx_type: '-',
          amount: decimalKobo(q.amount_kobo),
          charge: decimalKobo(q.fee_kobo),
          total_amount: total,
          remark: 'virtual_card',
          details: protectText(`USD card top-up - ${VC.usdText(q.cents)}`),
          other_data: {
            title: 'USD Card Top-up',
            subtitle: protectText(`${VC.usdText(q.cents)} at ₦${(q.rate_kobo / 100).toLocaleString('en-NG')}/$1`),
            feedback: 'Processing',
            note: 'Wallet',
            image_src: '',
          },
          meta: { kind: 'funding', card_id: card.id, funding_id: row.id, usd_cents: q.cents, rate_kobo: q.rate_kobo, bill_status: 'processing' },
        },
      });
      await event(tx, card, 'funding_started', { actor: 'user', meta: { funding_id: row.id, cents: q.cents, provider_cents: q.provider_cents } });
      return row;
    });
  } catch (e) {
    if (e?.code === 'P2002') throw refusal(409, 'funding_in_progress', 'Your last top-up is still being confirmed. Try again in a minute.');
    throw e;
  }

  await prisma.virtualCardFunding.update({ where: { id: funding.id }, data: { provider_state: 'sent', sent_at: new Date() } });

  let after = null;
  let failure = null;
  try {
    after = await payvessel.fundCard(card.provider_card_id, q.provider_cents);
  } catch (e) {
    failure = e;
  }

  await logUserEvent({ req, userId: uid, event: 'virtual_card.fund', metadata: { card_id: card.id, funding_id: funding.id, cents: q.cents, outcome: failure ? failure.kind || 'error' : 'accepted' } }).catch(() => {});

  if (after) {
    await settleFundingSuccess(funding, { cardAfter: after });
    const fresh = await prisma.virtualCardFunding.findUnique({ where: { id: funding.id } });
    return { funding: VC.fundingItem(fresh), card: VC.publicCard(await prisma.virtualCard.findUnique({ where: { id: card.id } })), processing: false };
  }

  if (failure?.kind === 'ambiguous' || !failure?.kind) {
    await prisma.virtualCardFunding.update({
      where: { id: funding.id },
      data: { provider_state: 'unknown', provider_message: String(failure?.providerMessage || failure?.message || '').slice(0, 200) },
    });
    if (!failure?.kind) captureError('virtual_card.fund', failure, { card_id: card.id, funding_id: funding.id });
    const fresh = await prisma.virtualCardFunding.findUnique({ where: { id: funding.id } });
    return { funding: VC.fundingItem(fresh), card: VC.publicCard(card), processing: true };
  }

  const reason = failureWording(failure);
  await refundFunding(funding, { reason, providerMessage: failure.providerMessage, providerState: 'refused' });
  if (OUTAGE_KINDS.has(failure.kind)) pageOps('card_fund', card, failure, { reference, amount: nairaOf(total) });
  throw refusal(
    OUTAGE_KINDS.has(failure.kind) ? 503 : 422,
    OUTAGE_KINDS.has(failure.kind) ? 'funding_unavailable' : 'funding_declined',
    `Your top-up did not go through. ${reason} ${VC.nairaText(q.total_kobo)} has been returned to your wallet.`,
    { refunded: true },
  );
}

/** A top-up Payvessel confirmed. Once: guarded on `processing`. */
async function settleFundingSuccess(funding, { cardAfter = null, providerTxnId = null, source = 'api' } = {}) {
  const now = new Date();
  return prisma.$transaction(async tx => {
    const claimed = await tx.virtualCardFunding.updateMany({
      where: { id: funding.id, status: FUNDING.PROCESSING },
      data: {
        status: FUNDING.SUCCESSFUL,
        provider_state: 'confirmed',
        settled_at: now,
        ...(providerTxnId ? { provider_txn_id: providerTxnId } : {}),
      },
    });
    if (!claimed.count) return false;
    const ledger = await tx.walletTransaction.findUnique({ where: { trx: funding.reference } });
    if (ledger) {
      const other = ledger.other_data && typeof ledger.other_data === 'object' ? ledger.other_data : {};
      const meta = ledger.meta && typeof ledger.meta === 'object' ? ledger.meta : {};
      await tx.walletTransaction.update({
        where: { trx: funding.reference },
        data: { other_data: { ...other, feedback: 'Successful' }, meta: { ...meta, bill_status: 'successful' } },
      });
    }
    const card = await tx.virtualCard.findUnique({ where: { id: funding.card_id } });
    await tx.virtualCard.update({
      where: { id: funding.card_id },
      data: {
        ...(card?.first_funded_at ? {} : { first_funded_at: now }),
        ...(cardAfter?.balance_cents != null
          ? { balance_cents: cardAfter.balance_cents, balance_synced_at: now }
          : { balance_cents: { increment: funding.provider_amount_cents } }),
      },
    });
    await event(tx, { id: funding.card_id }, 'funded', { meta: { funding_id: funding.id, cents: funding.provider_amount_cents, source } });
    return true;
  });
}

/** A top-up that did not happen: the naira back, the fees back on the card. */
async function refundFunding(funding, { reason, providerMessage = '', providerState = null, actor = 'system' } = {}) {
  const refundTrx = `${funding.reference}_r`;
  const now = new Date();
  return prisma.$transaction(async tx => {
    const claimed = await tx.virtualCardFunding.updateMany({
      where: { id: funding.id, status: FUNDING.PROCESSING, refund_trx: null },
      data: {
        status: FUNDING.FAILED,
        settled_at: now,
        failure_reason: String(reason || '').slice(0, 200),
        provider_message: String(providerMessage || '').slice(0, 200) || undefined,
        refund_trx: refundTrx,
        ...(providerState ? { provider_state: providerState } : {}),
      },
    });
    if (!claimed.count) return false;
    await applyBalanceDelta(tx, 'user', funding.user_id, funding.total_ngn);
    await tx.walletTransaction.create({
      data: {
        user_id: Number(funding.user_id),
        trx: refundTrx,
        trx_type: '+',
        amount: funding.total_ngn,
        charge: ZERO,
        total_amount: funding.total_ngn,
        remark: 'virtual_card',
        details: protectText('USD card top-up refunded'),
        other_data: {
          title: 'USD Card Top-up Refund',
          subtitle: protectText(`${VC.usdText(funding.amount_cents)} top-up did not go through`),
          feedback: 'Refunded',
          note: 'Wallet',
          image_src: '',
        },
        meta: { kind: 'funding_refund', card_id: funding.card_id, funding_id: funding.id, reversal_of: funding.reference, bill_status: 'refunded' },
      },
    });
    const ledger = await tx.walletTransaction.findUnique({ where: { trx: funding.reference } });
    if (ledger) {
      const other = ledger.other_data && typeof ledger.other_data === 'object' ? ledger.other_data : {};
      const meta = ledger.meta && typeof ledger.meta === 'object' ? ledger.meta : {};
      await tx.walletTransaction.update({
        where: { trx: funding.reference },
        data: { other_data: { ...other, feedback: 'Failed', note: 'Refunded' }, meta: { ...meta, bill_status: 'refunded' } },
      });
    }
    // The fees this top-up was going to settle are owed again.
    if (funding.fee_due_cents > 0) {
      await tx.virtualCard.update({ where: { id: funding.card_id }, data: { fee_due_cents: { increment: funding.fee_due_cents } } });
    }
    await event(tx, { id: funding.card_id }, 'funding_refunded', { actor, meta: { funding_id: funding.id, trx: refundTrx, reason: String(reason || '').slice(0, 120) } });
    return true;
  });
}

const isFundingCredit = t => t.type === 'FUNDING' && t.entry === 'CREDIT' && !/FAIL|DECLIN|REVERS/.test(t.status || '');

/**
 * A top-up whose answer was lost, settled from the card's own transaction
 * list: a FUNDING credit of exactly what we asked for, after we sent it, that
 * no other top-up has claimed. Absence counts only after several good reads
 * over the window.
 */
async function resolveFunding(funding) {
  if (!funding || funding.status !== FUNDING.PROCESSING) return funding;
  const card = await prisma.virtualCard.findUnique({ where: { id: funding.card_id } });

  if (funding.provider_state === 'pending') {
    if (since(funding.updated_at) < NEVER_SENT_AFTER_MS) return funding;
    const refunded = await refundFunding(funding, { reason: 'We could not reach our card partner.', providerMessage: 'never sent' });
    if (refunded) notify(card, `vcard-fund-failed-${funding.id}`, 'Card top-up did not go through', `Your ${VC.usdText(funding.amount_cents)} top-up did not go through. ${VC.nairaText(koboOf(funding.total_ngn))} has been returned to your wallet.`);
    return prisma.virtualCardFunding.findUnique({ where: { id: funding.id } });
  }

  if (!card?.provider_card_id) return funding;
  const txns = await payvessel.listTransactions(card.provider_card_id, { size: 100 });
  await storeTransactions(card, txns, 'sync');
  const sentAt = new Date(funding.sent_at || funding.created_at).getTime();
  const taken = new Set(
    (await prisma.virtualCardFunding.findMany({ where: { card_id: card.id, provider_txn_id: { not: null } }, select: { provider_txn_id: true } })).map(r => r.provider_txn_id),
  );
  const match = txns.find(t => {
    if (!isFundingCredit(t) || taken.has(t.id) || t.amount_cents !== funding.provider_amount_cents) return false;
    const at = new Date(t.occurred_at || 0).getTime();
    return Number.isFinite(at) && at >= sentAt - minutes(5);
  });
  if (match) {
    const settled = await settleFundingSuccess(funding, { providerTxnId: match.id, source: 'reconcile' });
    if (settled) {
      await refreshCard(card).catch(() => null);
      notify(card, `vcard-funded-${funding.id}`, 'Card top-up successful', `${VC.usdText(funding.provider_amount_cents)} has been added to your USD card.`);
    }
    return prisma.virtualCardFunding.findUnique({ where: { id: funding.id } });
  }

  const checks = (funding.checks || 0) + 1;
  await prisma.virtualCardFunding.update({ where: { id: funding.id }, data: { checks, checked_at: new Date() } });
  if (checks >= READS_BEFORE_REFUND && since(funding.sent_at || funding.created_at) > FUND_REFUND_AFTER_MS()) {
    const refunded = await refundFunding(funding, { reason: 'We could not confirm your top-up with our card partner.', providerMessage: 'not found after window' });
    if (refunded) {
      notify(card, `vcard-fund-failed-${funding.id}`, 'Card top-up did not go through', `Your ${VC.usdText(funding.amount_cents)} top-up did not go through. ${VC.nairaText(koboOf(funding.total_ngn))} has been returned to your wallet.`);
      pageOps('card_fund_unconfirmed', card, { kind: 'unconfirmed', message: 'Refunded a top-up Payvessel never showed - check the card on their dashboard' }, { reference: funding.reference });
    }
  }
  return prisma.virtualCardFunding.findUnique({ where: { id: funding.id } });
}

/* ------------------------------------------------------------- transactions */

/**
 * Card activity into our table, once each (provider id is unique). Returns
 * the rows that were NEW, so a fee is only ever counted the first time.
 */
async function storeTransactions(card, txns, source) {
  const rows = (txns || []).filter(t => t?.id).map(t => ({
    card_id: card.id,
    user_id: card.user_id,
    provider_txn_id: String(t.id).slice(0, 120),
    type: String(t.type || 'UNKNOWN').slice(0, 40),
    entry: t.entry === 'CREDIT' ? 'CREDIT' : 'DEBIT',
    status: String(t.status || '').slice(0, 40) || null,
    amount_cents: Math.trunc(Number(t.amount_cents) || 0),
    fee_cents: Math.trunc(Number(t.fee_cents) || 0),
    currency: String(t.currency || 'USD').slice(0, 3),
    // Not personal, but free text from outside: same treatment as the ledger.
    merchant_enc: t.merchant ? protectText(String(t.merchant).slice(0, 120)) : null,
    merchant_country: t.merchant_country || null,
    description_enc: t.description ? protectText(String(t.description).slice(0, 200)) : null,
    occurred_at: t.occurred_at && !Number.isNaN(new Date(t.occurred_at).getTime()) ? new Date(t.occurred_at) : new Date(),
    source,
  }));
  if (!rows.length) return [];
  const existing = new Set(
    (await prisma.virtualCardTransaction.findMany({ where: { provider_txn_id: { in: rows.map(r => r.provider_txn_id) } }, select: { provider_txn_id: true } })).map(
      r => r.provider_txn_id,
    ),
  );
  const fresh = rows.filter(r => !existing.has(r.provider_txn_id));
  if (fresh.length) await prisma.virtualCardTransaction.createMany({ data: fresh, skipDuplicates: true });
  return fresh;
}

/** Pull the card's history, link our top-ups to Payvessel's FUNDING rows, spot a termination. */
async function syncTransactions(card) {
  if (!card?.provider_card_id) return 0;
  const txns = await payvessel.listTransactions(card.provider_card_id, { size: 50 });
  const fresh = await storeTransactions(card, txns, 'sync');

  // Link successful top-ups to their FUNDING row, so the feed lists each once.
  const unlinked = await prisma.virtualCardFunding.findMany({
    where: { card_id: card.id, status: FUNDING.SUCCESSFUL, provider_txn_id: null },
    orderBy: { created_at: 'asc' },
  });
  if (unlinked.length) {
    const taken = new Set(
      (await prisma.virtualCardFunding.findMany({ where: { card_id: card.id, provider_txn_id: { not: null } }, select: { provider_txn_id: true } })).map(r => r.provider_txn_id),
    );
    for (const f of unlinked) {
      const sentAt = new Date(f.sent_at || f.created_at).getTime();
      const t = txns.find(x => isFundingCredit(x) && !taken.has(x.id) && x.amount_cents === f.provider_amount_cents && new Date(x.occurred_at || 0).getTime() >= sentAt - minutes(5));
      if (!t) continue;
      taken.add(t.id);
      await prisma.virtualCardFunding.updateMany({ where: { id: f.id, provider_txn_id: null }, data: { provider_txn_id: t.id } }).catch(() => null);
    }
  }

  const termination = fresh.find(t => String(t.type).toUpperCase() === 'TERMINATION');
  if (termination) await handleTermination(card, { amountCents: termination.amount_cents, source: 'sync' });
  return fresh.length;
}

/* -------------------------------------------------------------- termination */

/**
 * A termination a customer or an admin asked for that has no answer yet: the
 * latest `terminate_requested` with no `terminate_failed` after it. Its
 * balance - read from Payvessel the moment they asked, written down BEFORE the
 * terminate call - is what a lost answer is settled from, so the money is never
 * untracked. A request that failed is closed and never used again: the card
 * may have been spent since, and crediting its old balance would pay twice.
 */
async function openTermination(cardId) {
  const last = await prisma.virtualCardEvent.findFirst({
    where: { card_id: cardId, event: { in: ['terminate_requested', 'terminate_failed'] } },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });
  if (!last || last.event !== 'terminate_requested') return null;
  const cents = Number(last.meta?.balance_cents);
  return { cents: Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : null, actor: last.actor || 'user', at: new Date(last.created_at) };
}

/**
 * Payvessel named what it returned for a card we had already credited - from
 * the balance recorded when the customer asked. Payvessel's terminate returns
 * the balance "minus fees", and a purchase can land between our read and the
 * close, so the two can differ: the figure is kept beside the credit, and a
 * difference pages ops once with both numbers. Nothing is credited or taken
 * back automatically - a second figure is evidence, not an instruction.
 */
async function reconcileReportedAmount(row, reported, source) {
  const card = await prisma.virtualCard.findUnique({ where: { id: row.id }, select: { termination_refund_trx: true } });
  if (!card?.termination_refund_trx) return;
  const seen = await prisma.virtualCardEvent.findFirst({ where: { card_id: row.id, event: 'termination_amount_reported' }, select: { id: true } });
  if (seen) return;
  const credited = await prisma.virtualCardEvent.findFirst({
    where: { card_id: row.id, event: 'balance_returned' },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });
  const basis = Number(credited?.meta?.basis_cents);
  await event(prisma, row, 'termination_amount_reported', { meta: { cents: reported, source, credited_basis_cents: Number.isFinite(basis) ? basis : null } });
  if (Number.isFinite(basis) && basis !== reported) {
    pageOps('termination_amount_mismatch', row, {
      kind: 'terminated',
      message: `Payvessel returned ${VC.usdText(reported)} for this card; the customer was credited from ${VC.usdText(basis)}. Reconcile the ${VC.usdText(Math.abs(basis - reported))} difference.`,
    });
  }
}

/** The customer is told once that the card is closed, in words that fit who closed it. */
function notifyClosed(row, actor, refund) {
  const back = refund && refund.kobo > 0 ? ` ${VC.usdText(refund.cents)} (${VC.nairaText(refund.kobo)}) has been returned to your wallet.` : '';
  const owed = refund && refund.due > 0 ? ` ${VC.usdText(refund.due)} of card fees you owed was deducted first.` : '';
  let subject;
  let message;
  if (actor === 'user') {
    subject = 'USD card terminated';
    message = `You terminated your USD card.${back}${owed}`;
  } else if (String(actor).startsWith('admin')) {
    subject = 'Your USD card was closed';
    message = `VoltPay closed your USD card.${back}${owed} Contact support if you have questions.`;
  } else {
    subject = 'Your USD card was closed';
    message = `Your USD card was closed by our card partner.${back || ' Any balance left on it is being returned to your wallet.'}${owed}`;
  }
  return notify({ ...row, status: STATUS.TERMINATED }, `vcard-terminated-${row.id}`, subject, message);
}

/**
 * A card is closed - by the customer, by an admin, or by Payvessel itself
 * (three weeks unfunded, eight declines in a day, its own dashboard). Every
 * path lands here, and here only, so the card is marked closed once and its
 * money is credited once.
 *
 * Whatever the card held went back to OUR business USD wallet, so it is owed to
 * the customer: credited at the cost rate (no margin), less any card fees they
 * owe, under the unique `vcterm_` trx. How much, in this order:
 *   1. Payvessel's own figure (the termination webhook, a TERMINATION row);
 *   2. the balance read from Payvessel when a customer or admin asked for the
 *      termination - recorded before the call (openTermination);
 *   3. neither - Payvessel closed a card on its own and named no amount -
 *      nothing is guessed: ops are paged with the last balance we saw.
 * A figure that arrives after the card was credited is kept as an event for
 * reconciliation and never credited again; one that disagrees with what was
 * credited pages ops with both numbers.
 */
async function handleTermination(row, { amountCents = null, recordedCents = null, source = 'poll', actor = null } = {}) {
  const now = new Date();
  const reported = Math.max(0, Math.trunc(Number(amountCents) || 0));
  const request = await openTermination(row.id);
  let basis = reported > 0 ? reported : null;
  if (basis == null && recordedCents != null) basis = Math.max(0, Math.trunc(Number(recordedCents) || 0));
  if (basis == null && request) basis = request.cents;
  // Whoever asked, when the closure is the answer to a request; otherwise
  // Payvessel closed it on its own.
  actor = actor || request?.actor || 'system';
  const rate = basis > 0 ? (await getSettings()).fx.cost_rate_kobo : null;
  const trx = `vcterm_${row.reference}`;

  let claimed = false;
  let refund = null;
  try {
    await prisma.$transaction(async tx => {
      const closed = await tx.virtualCard.updateMany({
        where: { id: row.id, status: { in: LIVE_STATUSES } },
        data: { status: STATUS.TERMINATED, terminated_at: now, provider_status: 'TERMINATED' },
      });
      claimed = closed.count > 0;
      if (claimed) await event(tx, row, 'terminated', { actor, meta: { source, amount_cents: reported || null } });
      if (!(basis > 0) || !rate) return;

      const card = await tx.virtualCard.findUnique({ where: { id: row.id } });
      if (card?.termination_refund_trx) return;
      const due = Math.max(0, Number(card?.fee_due_cents) || 0);
      const cents = Math.max(0, basis - due);
      const kobo = Math.floor((cents * rate) / 100);
      // The guard: one credit per card, from whichever path gets here first.
      const marked = await tx.virtualCard.updateMany({
        where: { id: row.id, termination_refund_trx: null },
        data: { termination_refund_trx: trx, fee_due_cents: 0 },
      });
      if (!marked.count) return;
      if (kobo > 0) {
        const amount = decimalKobo(kobo);
        await applyBalanceDelta(tx, 'user', row.user_id, amount);
        await tx.walletTransaction.create({
          data: {
            user_id: Number(row.user_id),
            trx,
            trx_type: '+',
            amount,
            charge: ZERO,
            total_amount: amount,
            remark: 'virtual_card',
            details: protectText(`USD card closed - ${VC.usdText(cents)} returned`),
            other_data: {
              title: 'USD Card Balance Returned',
              subtitle: protectText(`${VC.usdText(cents)} at ₦${(rate / 100).toLocaleString('en-NG')}/$1`),
              feedback: 'Successful',
              note: 'Wallet',
              image_src: '',
            },
            meta: { kind: 'termination_refund', card_id: row.id, usd_cents: cents, fee_due_cents: due, rate_kobo: rate },
          },
        });
      }
      await event(tx, row, 'balance_returned', {
        actor,
        meta: { basis_cents: basis, fee_due_cents: due, cents, kobo, rate_kobo: rate, trx, from: reported > 0 ? 'payvessel' : 'recorded' },
      });
      refund = { cents, due, kobo };
    });
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    // A concurrent path credited it first; this transaction rolled back whole.
    claimed = false;
    refund = null;
  }

  if (!refund && reported > 0) await reconcileReportedAmount(row, reported, source);

  if (claimed) {
    if (basis == null && (row.balance_cents || 0) > 0) {
      pageOps('card_terminated', row, {
        kind: 'terminated',
        message: `Card closed with ${VC.usdText(row.balance_cents)} last seen and no amount from Payvessel - credit the customer from their dashboard`,
      });
    } else if (basis > 0 && !rate) {
      pageOps('card_terminated', row, { kind: 'terminated', message: `Card closed with ${VC.usdText(basis)} to return and no dollar rate set` });
    }
    notifyClosed(row, actor, refund);
  } else if (refund && refund.kobo > 0) {
    notify(
      row,
      `vcard-term-refund-${row.id}`,
      'Card balance returned',
      `${VC.usdText(refund.cents)} (${VC.nairaText(refund.kobo)}) from your closed USD card has been returned to your wallet.`,
    );
  }
  return { terminated: claimed, refund };
}

/**
 * What stops a termination, or null. Shared by the preview and the action so
 * the app never offers a step the server would refuse.
 *   - a card still being made is not a card yet;
 *   - an admin's freeze is a risk hold: closing the card would hand its money
 *     back to the very account under review, so only an admin may close it;
 *   - a top-up still being confirmed is money in flight, and terminating under
 *     it could leave dollars nobody can account for.
 */
async function terminationBlocker(card, { isAdmin = false } = {}) {
  if (!card) return refusal(404, 'no_card', 'You do not have a USD card to terminate.');
  if (card.status === STATUS.CREATING) {
    return refusal(409, 'card_not_ready', 'Your card is still being created. You can terminate it once it is ready.');
  }
  if (![STATUS.ACTIVE, STATUS.FROZEN].includes(card.status)) return refusal(409, 'no_card', 'There is no open card to terminate.');
  if (!isAdmin && card.status === STATUS.FROZEN && String(card.frozen_by || '').startsWith('admin')) {
    return refusal(403, 'frozen_by_admin', 'VoltPay is reviewing this card. Contact support to close it.');
  }
  const inFlight = await prisma.virtualCardFunding.findFirst({ where: { card_id: card.id, status: FUNDING.PROCESSING }, select: { id: true } });
  if (inFlight) {
    return refusal(409, 'funding_in_progress', 'Your last top-up is still being confirmed. You can terminate the card once it settles - usually within a few minutes.');
  }
  return null;
}

/**
 * Close a card at Payvessel, then here - never the other way round, and never
 * one without the other:
 *   1. read the card's balance from Payvessel (a failed read changes nothing);
 *   2. write the request and that balance down (`terminate_requested`);
 *   3. ask Payvessel to terminate;
 *   4. read the card back - Payvessel's word, not the call's answer, decides:
 *        TERMINATED          -> closed here and credited (handleTermination)
 *        refused             -> nothing happened; said so, request closed
 *        accepted/unreadable -> pending; the sweep reads it back and finishes
 *                               (settleTermination), and funding waits
 * Terminating an already-terminated card is not an error: it is closed here
 * cleanly and answered as done.
 */
async function terminateCard(card, { actor = 'user', note = null, req = null, isAdmin = false } = {}) {
  if (card.status === STATUS.TERMINATED) return { card, alreadyTerminated: true, refund: null };

  let before;
  try {
    before = await payvessel.getCard(card.provider_card_id);
  } catch (e) {
    if (e?.kind === 'not_found') {
      pageOps('card_missing', card, e);
      throw refusal(409, 'termination_failed', 'We could not find this card with our card partner. Contact support.');
    }
    throw refusal(503, 'termination_unavailable', 'We could not reach our card partner. Nothing has changed - please try again shortly.');
  }
  if (before.status === 'TERMINATED') {
    // Closed already - on Payvessel's own dashboard, or by an earlier request
    // whose answer was lost.
    const done = await handleTermination(card, { source: 'already_terminated', actor });
    return { card: await prisma.virtualCard.findUnique({ where: { id: card.id } }), alreadyTerminated: true, refund: done.refund };
  }

  const balanceCents = Math.max(0, Number(before.balance_cents ?? card.balance_cents) || 0);
  if (balanceCents > 0) {
    const settings = await getSettings();
    if (settings.fx.cost_rate_kobo == null || settings.fx.stale) {
      throw refusal(503, 'rate_unavailable', 'Card termination is paused while we update our dollar rate. Nothing has changed - please try again shortly.');
    }
  }

  await event(prisma, card, 'terminate_requested', {
    actor,
    meta: { balance_cents: balanceCents, fee_due_cents: card.fee_due_cents || 0, ...(note ? { note: String(note).slice(0, 200) } : {}) },
  });
  if (req) {
    await logUserEvent({ req, userId: card.user_id, event: 'virtual_card.terminate_requested', metadata: { card_id: card.id, balance_cents: balanceCents } }).catch(() => {});
  }

  let answer = null;
  let failure = null;
  try {
    answer = await payvessel.terminateCard(card.provider_card_id);
  } catch (e) {
    failure = e;
  }
  let state = answer?.status || null;
  if (state !== 'TERMINATED') {
    try {
      state = (await payvessel.getCard(card.provider_card_id)).status || null;
    } catch {
      state = null;
    }
  }

  if (state === 'TERMINATED') {
    const done = await handleTermination(card, { recordedCents: balanceCents, source: isAdmin ? 'admin' : 'customer', actor });
    return { card: await prisma.virtualCard.findUnique({ where: { id: card.id } }), alreadyTerminated: false, refund: done.refund };
  }

  // Accepted but not visible yet, or an answer we could not read: Payvessel
  // may be closing it. The request and its balance are written down; the
  // sweep reads the card back and finishes the job either way.
  const provedNothing = Boolean(failure) && !['ambiguous', 'outage'].includes(failure.kind);
  if (!provedNothing) return { card, pending: true, refund: null };

  // Payvessel refused it: nothing happened anywhere. The request is closed so
  // its balance can never be credited later.
  await event(prisma, card, 'terminate_failed', { actor, meta: { kind: failure?.kind || null, provider_status: state } });
  if (failure && OUTAGE_KINDS.has(failure.kind)) pageOps('card_terminate', card, failure);
  const why = failure ? failureWording(failure) : 'Our card partner did not close it.';
  throw refusal(failure && OUTAGE_KINDS.has(failure.kind) ? 503 : 422, 'termination_failed', `We could not terminate your card. ${why} Nothing has changed.`);
}

/**
 * The sweep's half of a termination left pending: read the card back. Closed
 * at Payvessel -> closed and credited here from the recorded balance (through
 * refreshCard -> handleTermination). Still open TERMINATE_SETTLE_MS after the
 * request -> it never happened: the request is closed, so the card can take
 * money again and that balance is never credited, and whoever asked is told -
 * the customer was promised a notification either way. True when it settled.
 */
async function settleTermination(row, now = new Date()) {
  const request = await openTermination(row.id);
  if (!request) return false;
  const fresh = await refreshCard(row);
  if (fresh?.status === STATUS.TERMINATED) return true;
  if (now.getTime() - request.at.getTime() < TERMINATE_SETTLE_MS()) return false;

  await event(prisma, row, 'terminate_failed', { actor: request.actor, meta: { kind: 'still_open', provider_status: fresh?.provider_status || null } });
  if (request.actor === 'user') {
    notify(
      row,
      `vcard-terminate-failed-${row.id}-${request.at.getTime()}`,
      'Your USD card was not terminated',
      'Our card partner did not close your USD card, so nothing has changed and it still works. You can try again from the card screen.',
    );
  } else {
    pageOps('card_terminate', row, {
      kind: 'still_open',
      message: `Terminated by ${request.actor}, and Payvessel still shows the card open. Nothing was credited - terminate it again or check Payvessel.`,
    });
  }
  return true;
}

/**
 * GET /virtual-card/terminate - what terminating would do, for the confirm
 * sheet: the balance (read fresh from Payvessel when it answers in time), card
 * fees owed, and what comes back in naira. The rate itself never reaches the
 * app - only the amount.
 */
async function terminationPreview(userId) {
  const card = await liveCard(Number(userId));
  if (!card) throw refusal(404, 'no_card', 'You do not have a USD card to terminate.');
  const blocker = await terminationBlocker(card);
  let balanceCents = Math.max(0, card.balance_cents || 0);
  let fresh = false;
  if (!blocker && card.provider_card_id) {
    const read = await withDeadline(payvessel.getCard(card.provider_card_id), HOME_PROVIDER_BUDGET_MS, null);
    if (read?.balance_cents != null) {
      balanceCents = Math.max(0, read.balance_cents);
      fresh = true;
    }
  }
  const settings = await getSettings();
  const due = Math.max(0, card.fee_due_cents || 0);
  const refundCents = Math.max(0, balanceCents - due);
  const rateOk = settings.fx.cost_rate_kobo != null && !settings.fx.stale;
  const refundKobo = rateOk ? Math.floor((refundCents * settings.fx.cost_rate_kobo) / 100) : null;
  let reason = blocker ? blocker.message : null;
  if (!reason && balanceCents > 0 && !rateOk) reason = 'Card termination is paused while we update our dollar rate. Please try again shortly.';
  return {
    balance_usd: VC.usd(balanceCents),
    balance_fresh: fresh,
    fee_due_usd: VC.usd(due),
    refund_usd: VC.usd(refundCents),
    refund_ngn: refundKobo == null ? null : Number(VC.koboToDecimal(refundKobo)),
    can_terminate: !reason,
    blocked_reason: reason,
    blocked_remark: blocker ? blocker.remark : reason ? 'rate_unavailable' : null,
  };
}

/**
 * POST /virtual-card/terminate  { pin }
 *
 * The customer's own card only - the route takes no card id, so there is
 * nothing to point at someone else's. A repeat after success answers "already
 * terminated" rather than an error, so a lost answer is safe to retry.
 */
async function terminate({ userId, pin, req }) {
  const uid = Number(userId);
  const card = await liveCard(uid);
  if (!card) {
    const last = await latestCard(uid);
    if (last?.status === STATUS.TERMINATED) return { card: VC.publicCard(last), alreadyTerminated: true, refund: null };
    throw refusal(404, 'no_card', 'You do not have a USD card to terminate.');
  }
  const blocker = await terminationBlocker(card);
  if (blocker) throw blocker;
  await checkPin(uid, pin);
  const out = await terminateCard(card, { actor: 'user', req });
  await logUserEvent({
    req,
    userId: uid,
    event: 'virtual_card.terminate',
    metadata: { card_id: card.id, outcome: out.pending ? 'pending' : out.alreadyTerminated ? 'already_terminated' : 'terminated' },
  }).catch(() => {});
  return { ...out, card: VC.publicCard(out.card) };
}

/* --------------------------------------------------------- freeze / reveal */

async function freeze({ userId, req }) {
  const uid = Number(userId);
  const card = await liveCard(uid);
  if (!card) throw refusal(404, 'no_card', 'You do not have a USD card yet.');
  if (card.status === STATUS.FROZEN) return { card: VC.publicCard(card) };
  if (card.status !== STATUS.ACTIVE) throw refusal(409, 'card_not_ready', 'Your card is still being created.');
  return setFrozen(card, true, { actor: 'user', req });
}

async function unfreeze({ userId, pin, req }) {
  const uid = Number(userId);
  const card = await liveCard(uid);
  if (!card) throw refusal(404, 'no_card', 'You do not have a USD card yet.');
  if (card.status === STATUS.ACTIVE) return { card: VC.publicCard(card) };
  if (card.status !== STATUS.FROZEN) throw refusal(409, 'card_not_ready', 'Your card is still being created.');
  // An admin's freeze is a risk hold, and the customer cannot lift it.
  if (String(card.frozen_by || '').startsWith('admin')) {
    throw refusal(403, 'frozen_by_admin', 'Your card was frozen by VoltPay for a security review. Contact support to unfreeze it.');
  }
  await checkPin(uid, pin);
  return setFrozen(card, false, { actor: 'user', req });
}

/**
 * Freeze or unfreeze at Payvessel, then here. A lost answer is settled by
 * reading the card back - the read is cheap and moves nothing.
 */
async function setFrozen(card, frozen, { actor = 'user', req = null, note = null } = {}) {
  let after = null;
  try {
    after = frozen ? await payvessel.freezeCard(card.provider_card_id) : await payvessel.unfreezeCard(card.provider_card_id);
  } catch (e) {
    if (e?.kind === 'ambiguous') {
      after = await payvessel.getCard(card.provider_card_id).catch(() => null);
    } else {
      if (OUTAGE_KINDS.has(e?.kind)) pageOps(frozen ? 'card_freeze' : 'card_unfreeze', card, e);
      throw refusal(OUTAGE_KINDS.has(e?.kind) ? 503 : 422, 'card_action_failed', `We could not ${frozen ? 'freeze' : 'unfreeze'} your card. ${failureWording(e)} Please try again.`);
    }
  }
  const want = frozen ? 'FROZEN' : 'ACTIVE';
  // Payvessel's answer is the truth. If it says the card did not move, we do
  // not pretend it did; an acknowledgement with no card object says nothing
  // either way, and the call itself succeeded.
  if (!after || (after.status && after.status !== want)) {
    if (after) await applyProviderCard(card, after, { source: 'freeze' });
    throw refusal(503, 'card_action_failed', `We could not ${frozen ? 'freeze' : 'unfreeze'} your card right now. Please try again.`);
  }
  const now = new Date();
  await prisma.virtualCard.updateMany({
    where: { id: card.id, status: frozen ? STATUS.ACTIVE : STATUS.FROZEN },
    data: frozen
      ? { status: STATUS.FROZEN, frozen_at: now, frozen_by: actor, provider_status: 'FROZEN', checked_at: now }
      : { status: STATUS.ACTIVE, frozen_at: null, frozen_by: null, provider_status: 'ACTIVE', checked_at: now },
  });
  await event(prisma, card, frozen ? 'frozen' : 'unfrozen', { actor, meta: note ? { note: String(note).slice(0, 200) } : null });
  if (req) await logUserEvent({ req, userId: card.user_id, event: frozen ? 'virtual_card.freeze' : 'virtual_card.unfreeze', metadata: { card_id: card.id } }).catch(() => {});
  return { card: VC.publicCard(await prisma.virtualCard.findUnique({ where: { id: card.id } })) };
}

/**
 * POST /virtual-card/reveal  { pin }
 *
 * The one place the full number exists outside Payvessel: read at this moment,
 * returned once over HTTPS with no-store, and dropped. The app shows it for
 * `expires_in` seconds and clears it. Logged as an event - never with a value.
 */
async function revealDetails({ userId, pin, req }) {
  const uid = Number(userId);
  const card = await liveCard(uid);
  if (!card || ![STATUS.ACTIVE, STATUS.FROZEN].includes(card.status)) throw refusal(409, 'card_not_ready', 'Your card is not ready yet.');
  await checkPin(uid, pin);

  let details;
  try {
    details = await payvessel.getCard(card.provider_card_id, { withSecrets: true });
  } catch (e) {
    throw refusal(503, 'details_unavailable', 'We could not load your card details right now. Please try again shortly.');
  }
  if (!details.card_number || !details.cvv) {
    throw refusal(409, 'details_unavailable', 'Your card details are not available yet. Please try again shortly.');
  }
  // The balance came with it - keep it, without the credentials.
  if (details.balance_cents != null) {
    await prisma.virtualCard.update({ where: { id: card.id }, data: { balance_cents: details.balance_cents, balance_synced_at: new Date() } }).catch(() => null);
  }
  await event(prisma, card, 'revealed', { actor: 'user' });
  await logUserEvent({ req, userId: uid, event: 'virtual_card.reveal', metadata: { card_id: card.id } }).catch(() => {});

  return {
    details: {
      card_number: details.card_number,
      cvv: details.cvv,
      expiry: details.expiry || revealText(card.expiry_enc || ''),
      name: (revealText(card.name_enc || '') || details.name || '').toUpperCase(),
      billing_address: details.billing_address,
    },
    expires_in: VC.revealSeconds(),
  };
}

/* ------------------------------------------------------------------ webhook */

const CREATE_EVENTS = new Set(['issuing.created.successful', 'issuing.created.failed']);
const TXN_EVENTS = new Set(['issuing.transaction', 'issuing.charge', 'card.transaction']);
// card.transaction fees Payvessel took from OUR wallet because the card could
// not pay them. Theirs to recover from the customer, by their own docs.
const RECOVERY_FEES = new Set(['cross_border_fee', 'contactless_fee']);

/**
 * The URL to paste into Payvessel's dashboard. Payvessel has only accepted a
 * callback on the business website's own domain, so PUBLIC_BASE_URL has to be
 * that domain (a Render custom domain such as api.<domain>), not onrender.com.
 */
function webhookUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
  const prefix = process.env.API_PREFIX || '/api';
  return base ? `${base}${prefix}/virtual-card/webhook` : null;
}

/**
 * Write a signed delivery down before acting on it. One row per distinct body
 * (sha256 of the raw bytes), so Payvessel resending the same delivery is
 * recognised, and the admin can see what arrived and when. Ids and outcomes
 * only: the body can name the cardholder and the merchant, and is never kept.
 */
async function recordDelivery(rawBody, body = {}) {
  const bytes = rawBody && rawBody.length ? rawBody : Buffer.from(JSON.stringify(body || {}));
  const key = crypto.createHash('sha256').update(bytes).digest('hex');
  const eventName = String(body?.event || '').trim().toLowerCase().slice(0, 60) || 'unknown';
  const ref = String(body?.reference || body?.card_id || body?.card?.id || '').trim().slice(0, 120) || null;
  try {
    const row = await prisma.virtualCardWebhook.create({ data: { delivery_key: key, event: eventName, provider_reference: ref } });
    return { row, duplicate: false };
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    const row = await prisma.virtualCardWebhook.findUnique({ where: { delivery_key: key } });
    if (row) await prisma.virtualCardWebhook.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return { row, duplicate: true };
  }
}

async function markDelivery(delivery, outcome, { cardId = null, detail = null } = {}) {
  if (!delivery?.row) return;
  await prisma.virtualCardWebhook
    .update({
      where: { id: delivery.row.id },
      data: { outcome, card_id: cardId, detail: detail ? String(detail).slice(0, 160) : null, processed_at: new Date() },
    })
    .catch(() => null);
}

/**
 * Tell the customer what just happened on their card - the reason the webhook
 * matters. Once per transaction (the push is keyed on Payvessel's reference),
 * and only for a row this delivery stored first, so a retry - or a sync that
 * got there earlier - never pushes twice. A SETTLEMENT is the second half of a
 * purchase already pushed at authorisation, and a FUNDING is our own top-up,
 * which the app reports itself: neither is pushed.
 */
function notifyCardActivity(card, t) {
  const type = String(t.type || '').toUpperCase();
  const amount = VC.usdText(t.amount_cents);
  const merchant = String(t.merchant || '').trim().slice(0, 60);
  const declined = type === 'DECLINE' || /DECLIN|FAIL/.test(String(t.status || '').toUpperCase());
  let subject;
  let message;
  if (declined) {
    const why = String(t.description || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    subject = 'Card payment declined';
    message = `A ${amount} payment${merchant ? ` at ${merchant}` : ''} was declined${why ? `: ${why}` : ''}.`;
  } else if (['AUTHORIZATION', 'CHARGE'].includes(type) && t.entry === 'DEBIT') {
    subject = 'USD card payment';
    message = `You paid ${amount}${merchant ? ` at ${merchant}` : ''} with your USD card.`;
  } else if (['REVERSAL', 'REFUND'].includes(type) && t.entry === 'CREDIT') {
    subject = 'Card refund';
    message = `${amount}${merchant ? ` from ${merchant}` : ''} was returned to your USD card.`;
  } else if (/CROSS/.test(type) && t.entry === 'DEBIT') {
    subject = 'International processing fee';
    message = `A ${amount} international processing fee was charged to your USD card.`;
  } else {
    return null;
  }
  return notify(card, `vcard-txn-${t.id}`, subject, message);
}

/**
 * POST /virtual-card/webhook - signature-checked and recorded by the controller.
 *
 * Answers FAST. Payvessel counts a delivery as failed after 10 seconds and
 * sends it again, so this does only database work - store, link, owe, close,
 * push - and hands back `followUp`, the read-back from Payvessel, which the
 * controller runs after it has answered. If the follow-up dies, the sweep makes
 * the same read within five minutes.
 *
 * Lifecycle events are not believed on their own: they say which card to look
 * at, and the outcome is read back. Transaction events ARE the record (there is
 * nothing to read a single one back from), which is what the HMAC is for, and
 * each is stored once on its reference.
 */
async function handleWebhook(body = {}) {
  const name = String(body.event || '').trim().toLowerCase();

  if (CREATE_EVENTS.has(name)) {
    const reference = String(body.reference || '').trim();
    let card = reference ? await prisma.virtualCard.findUnique({ where: { reference } }) : null;
    const providerId = String(body.card?.id || '').trim();
    if (!card && providerId) card = await prisma.virtualCard.findFirst({ where: { provider_card_id: providerId } });
    if (!card) return { handled: false, reason: 'unknown_card' };
    if (card.status === STATUS.FAILED && name === 'issuing.created.successful') {
      // A card arrived after we refunded it. The customer paid nothing for it
      // and it costs us its issuance - a human decides what to do with it.
      pageOps('card_created_after_refund', card, { kind: 'late_card', message: 'Payvessel created a card that was already refunded' });
      return { handled: true, cardId: card.id, reason: 'created_after_refund' };
    }
    if (providerId && !card.provider_card_id) {
      await prisma.virtualCard.updateMany({ where: { id: card.id, provider_card_id: null }, data: { provider_card_id: providerId } });
    }
    const cardId = card.id;
    return {
      handled: true,
      cardId,
      followUp: async () => settleCreating(await prisma.virtualCard.findUnique({ where: { id: cardId } })),
    };
  }

  if (TXN_EVENTS.has(name)) {
    const providerId = String(body.card_id || '').trim();
    const card = providerId ? await prisma.virtualCard.findFirst({ where: { provider_card_id: providerId } }) : null;
    if (!card) return { handled: false, reason: 'unknown_card' };
    const t = payvessel.normalizeTransaction(body, { cardId: providerId });
    if (name === 'issuing.charge') t.type = 'CHARGE';
    const eventType = String(body.event_type || '').toLowerCase();
    const fresh = await storeTransactions(card, [t], 'webhook');

    const recovered =
      name === 'card.transaction' &&
      RECOVERY_FEES.has(eventType) &&
      String(body.charged_from || '').toLowerCase() === 'merchant_wallet' &&
      /^success/.test(String(body.status || '').toLowerCase());
    if (recovered && fresh.length && t.amount_cents > 0) {
      await prisma.virtualCard.update({ where: { id: card.id }, data: { fee_due_cents: { increment: t.amount_cents } } });
      await event(prisma, card, 'fee_due', { meta: { cents: t.amount_cents, type: eventType, reference: t.id } });
      notify(
        card,
        `vcard-fee-${t.id}`,
        'International processing fee',
        `A ${VC.usdText(t.amount_cents)} international processing fee could not be taken from your card. It will be deducted from your next top-up.`,
      );
    } else if (fresh.length) {
      notifyCardActivity(card, t);
    }
    if (String(t.type).toUpperCase() === 'TERMINATION' || eventType === 'termination') {
      await handleTermination(card, { amountCents: t.amount_cents, source: 'webhook' });
    }
    // The balance moved; read it rather than compute it - after answering.
    return { handled: true, cardId: card.id, followUp: () => refreshCard(card) };
  }

  if (name === 'issuing.terminated') {
    const providerId = String(body.card_id || '').trim();
    const card = providerId ? await prisma.virtualCard.findFirst({ where: { provider_card_id: providerId } }) : null;
    if (!card) return { handled: false, reason: 'unknown_card' };
    await handleTermination(card, { amountCents: payvessel.toCents(body.amount), source: 'webhook' });
    return { handled: true, cardId: card.id };
  }

  // issuing.activation carries a code for a card we do not issue (physical /
  // contactless). Acknowledged and never stored.
  return { handled: false, reason: 'ignored_event' };
}

/** Is Payvessel actually calling us? The admin's first question when a card looks stuck. */
async function webhookStatus() {
  const since24h = new Date(Date.now() - 86_400_000);
  const [last, received, failed] = await Promise.all([
    prisma.virtualCardWebhook.findFirst({ orderBy: { received_at: 'desc' } }),
    prisma.virtualCardWebhook.count({ where: { received_at: { gte: since24h } } }),
    prisma.virtualCardWebhook.count({ where: { received_at: { gte: since24h }, outcome: 'failed' } }),
  ]);
  return {
    url: webhookUrl(),
    last_received_at: last?.received_at || null,
    last_event: last?.event || null,
    last_outcome: last?.outcome || null,
    received_24h: received,
    failed_24h: failed,
  };
}

async function adminWebhooks({ page = 1, perPage = 25 } = {}) {
  const size = Math.min(100, Math.max(1, Number(perPage) || 25));
  const p = Math.max(1, Number(page) || 1);
  const [rows, total] = await Promise.all([
    prisma.virtualCardWebhook.findMany({ orderBy: { received_at: 'desc' }, skip: (p - 1) * size, take: size }),
    prisma.virtualCardWebhook.count(),
  ]);
  return {
    items: rows.map(r => ({
      id: r.id,
      event: r.event,
      outcome: r.outcome,
      detail: r.detail,
      card_id: r.card_id,
      provider_reference: r.provider_reference,
      attempts: r.attempts,
      received_at: r.received_at,
      processed_at: r.processed_at,
    })),
    pagination: { page: p, perPage: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

/* -------------------------------------------------------------------- admin */

function adminCardView(row, user = null) {
  const profile = user ? revealUserFields(user) : {};
  return {
    ...VC.publicCard(row),
    user_id: row.user_id,
    user_name: user ? `${profile.firstname || ''} ${profile.lastname || ''}`.trim() : null,
    username: user ? profile.username || null : null,
    provider: row.provider,
    provider_card_id: row.provider_card_id,
    provider_status: row.provider_status,
    create_state: row.create_state,
    create_checks: row.create_checks,
    creation_trx: row.creation_trx,
    refund_trx: row.refund_trx,
    termination_refund_trx: row.termination_refund_trx,
    provider_message: row.provider_message,
    frozen_by: row.frozen_by,
    failed_at: row.failed_at,
    first_funded_at: row.first_funded_at,
    checked_at: row.checked_at,
    balance_cents: row.balance_cents,
    fee_due_cents: row.fee_due_cents,
  };
}

function adminFundingView(row) {
  return {
    id: row.id,
    card_id: row.card_id,
    user_id: row.user_id,
    reference: row.reference,
    status: row.status,
    provider_state: row.provider_state,
    provider_txn_id: row.provider_txn_id,
    amount_ngn: nairaOf(row.amount_ngn),
    fee_ngn: nairaOf(row.fee_ngn),
    total_ngn: nairaOf(row.total_ngn),
    amount_usd: VC.usd(row.amount_cents),
    fee_usd: VC.usd(row.fee_cents),
    fee_due_usd: VC.usd(row.fee_due_cents),
    card_received_usd: VC.usd(row.provider_amount_cents),
    rate: row.rate_kobo / 100,
    cost_rate: row.cost_rate_kobo ? row.cost_rate_kobo / 100 : null,
    // What the FX margin earned on this top-up, before Payvessel's own fee.
    fx_margin_ngn: row.cost_rate_kobo ? Math.round(((row.rate_kobo - row.cost_rate_kobo) * row.amount_cents) / 100) / 100 : null,
    failure_reason: row.failure_reason,
    provider_message: row.provider_message,
    refund_trx: row.refund_trx,
    checks: row.checks,
    sent_at: row.sent_at,
    settled_at: row.settled_at,
    created_at: row.created_at,
  };
}

async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(Number))];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } } });
  return new Map(users.map(u => [u.id, u]));
}

async function adminOverview() {
  const { year, month, day } = lagosDateParts(new Date());
  const today = lagosMidnightUtc(year, month, day);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [byStatus, fundedToday, fees, failedWeek, stuck, settings, float, webhook] = await Promise.all([
    prisma.virtualCard.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.virtualCardFunding.aggregate({
      where: { status: FUNDING.SUCCESSFUL, created_at: { gte: today } },
      _sum: { total_ngn: true, amount_cents: true, fee_ngn: true },
      _count: { _all: true },
    }),
    prisma.virtualCard.aggregate({ where: { status: { not: STATUS.FAILED } }, _sum: { creation_fee: true } }),
    prisma.virtualCard.count({ where: { status: STATUS.FAILED, failed_at: { gte: weekAgo } } }),
    prisma.virtualCardFunding.count({ where: { status: FUNDING.PROCESSING } }),
    getSettings(),
    withDeadline(payvessel.walletBalance(), 5_000, null),
    // Its own table: a database behind the code (no webhook log yet) must not
    // take the rest of the overview down with it.
    webhookStatus().catch(() => ({ url: webhookUrl(), unavailable: true })),
  ]);
  const counts = Object.fromEntries(byStatus.map(g => [g.status, g._count._all]));
  return {
    counts,
    funded_today: {
      count: fundedToday?._count?._all || 0,
      naira: nairaOf(fundedToday?._sum?.total_ngn),
      usd: VC.usd(fundedToday?._sum?.amount_cents || 0),
      fees_ngn: nairaOf(fundedToday?._sum?.fee_ngn),
    },
    creation_fees_ngn: nairaOf(fees?._sum?.creation_fee),
    failed_last_7_days: failedWeek,
    fundings_processing: stuck,
    payvessel_wallet: float
      ? { available: float.available_cents == null ? null : VC.usd(float.available_cents), currency: float.currency }
      : null,
    webhook,
    settings: adminSettingsView(settings),
  };
}

async function adminList({ status = '', q = '', page = 1, perPage = 25 } = {}) {
  const where = {};
  if (status && Object.values(STATUS).includes(status)) where.status = status;
  const term = String(q || '').trim();
  if (term) {
    if (/^VC-[A-Z0-9]{4,}$/i.test(term)) where.reference = term.toUpperCase();
    else if (/^\d+$/.test(term)) where.user_id = Number(term);
    else where.provider_card_id = term;
  }
  const size = Math.min(100, Math.max(1, Number(perPage) || 25));
  const p = Math.max(1, Number(page) || 1);
  const [rows, total] = await Promise.all([
    prisma.virtualCard.findMany({ where, orderBy: { created_at: 'desc' }, skip: (p - 1) * size, take: size }),
    prisma.virtualCard.count({ where }),
  ]);
  const users = await usersById(rows.map(r => r.user_id));
  return {
    items: rows.map(r => adminCardView(r, users.get(r.user_id))),
    pagination: { page: p, perPage: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

async function adminDetail(id) {
  const card = await prisma.virtualCard.findUnique({ where: { id: Number(id) } });
  if (!card) throw refusal(404, 'not_found', 'Card not found');
  const [users, fundings, txns, events] = await Promise.all([
    usersById([card.user_id]),
    prisma.virtualCardFunding.findMany({ where: { card_id: card.id }, orderBy: { created_at: 'desc' }, take: 100 }),
    prisma.virtualCardTransaction.findMany({ where: { card_id: card.id }, orderBy: { occurred_at: 'desc' }, take: 100 }),
    prisma.virtualCardEvent.findMany({ where: { card_id: card.id }, orderBy: { created_at: 'desc' }, take: 100 }),
  ]);
  return {
    card: adminCardView(card, users.get(card.user_id)),
    fundings: fundings.map(adminFundingView),
    transactions: txns.map(t => ({ ...VC.transactionItem(t), type: t.type, entry: t.entry, provider_status: t.status, source: t.source })),
    events: events.map(e => ({ id: e.id, event: e.event, actor: e.actor, meta: e.meta, created_at: e.created_at })),
  };
}

async function adminFundings({ status = '', q = '', page = 1, perPage = 25 } = {}) {
  const where = {};
  if (status && Object.values(FUNDING).includes(status)) where.status = status;
  const term = String(q || '').trim();
  if (term) {
    if (/^\d+$/.test(term)) where.user_id = Number(term);
    else where.reference = term;
  }
  const size = Math.min(100, Math.max(1, Number(perPage) || 25));
  const p = Math.max(1, Number(page) || 1);
  const [rows, total] = await Promise.all([
    prisma.virtualCardFunding.findMany({ where, orderBy: { created_at: 'desc' }, skip: (p - 1) * size, take: size }),
    prisma.virtualCardFunding.count({ where }),
  ]);
  return {
    items: rows.map(adminFundingView),
    pagination: { page: p, perPage: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

async function adminSetFrozen({ id, frozen, note, admin }) {
  const card = await prisma.virtualCard.findUnique({ where: { id: Number(id) } });
  if (!card) throw refusal(404, 'not_found', 'Card not found');
  if (frozen && card.status === STATUS.FROZEN) {
    // Already frozen (by the customer): take ownership so they cannot lift it.
    await prisma.virtualCard.update({ where: { id: card.id }, data: { frozen_by: actorOf(admin) } });
    await event(prisma, card, 'frozen', { actor: actorOf(admin), meta: note ? { note: String(note).slice(0, 200) } : null });
    return adminDetail(card.id);
  }
  if (frozen && card.status !== STATUS.ACTIVE) throw refusal(409, 'not_active', 'Only an active card can be frozen.');
  if (!frozen && card.status !== STATUS.FROZEN) throw refusal(409, 'not_frozen', 'This card is not frozen.');
  await setFrozen(card, frozen, { actor: actorOf(admin), note });
  if (frozen) {
    notify(card, `vcard-admin-freeze-${card.id}-${Date.now()}`, 'Your USD card was frozen', 'Your USD card has been frozen by VoltPay for a security review. Contact support if you have questions.');
  }
  return adminDetail(card.id);
}

/**
 * An admin closes a card - fraud, a chargeback, the customer's request through
 * support. Same path as the customer's (balance read, request recorded, read
 * back, credited once), with two differences: an admin's own risk hold does not
 * stop it, and the reason is required, because it is the audit record of why a
 * customer's card was taken away.
 */
async function adminTerminate({ id, note, admin }) {
  const why = String(note ?? '').trim();
  if (why.length < 8) throw refusal(400, 'note_required', 'Say why the card is being closed (at least 8 characters). It is kept in the card history.');
  const card = await prisma.virtualCard.findUnique({ where: { id: Number(id) } });
  if (!card) throw refusal(404, 'not_found', 'Card not found');
  if (card.status !== STATUS.TERMINATED) {
    const blocker = await terminationBlocker(card, { isAdmin: true });
    if (blocker) throw blocker;
  }
  const out = await terminateCard(card, { actor: actorOf(admin), note: why, isAdmin: true });
  const detail = await adminDetail(card.id);
  return { ...detail, pending: Boolean(out.pending), already_terminated: Boolean(out.alreadyTerminated) };
}

/** Support tool: read the card, its history, and anything in flight, now. */
async function adminSync(id) {
  let card = await prisma.virtualCard.findUnique({ where: { id: Number(id) } });
  if (!card) throw refusal(404, 'not_found', 'Card not found');
  if (card.status === STATUS.CREATING) card = await settleCreating(card);
  else if ([STATUS.ACTIVE, STATUS.FROZEN].includes(card.status)) {
    card = await refreshCard(card);
    await syncTransactions(card);
  }
  const open = await prisma.virtualCardFunding.findMany({ where: { card_id: card.id, status: FUNDING.PROCESSING } });
  for (const f of open) await resolveFunding(f).catch(e => captureError('virtual_card.admin_sync', e, { funding_id: f.id }));
  return adminDetail(card.id);
}

/* -------------------------------------------------------------------- sweep */

function isSchemaBehind(e) {
  const code = String(e?.code || '');
  const pgCode = String(e?.meta?.code || e?.cause?.code || '');
  return (
    code === 'P2021' ||
    code === 'P2022' ||
    pgCode === '42P01' ||
    pgCode === '42703' ||
    /does not exist in the current database/i.test(String(e?.message || '')) ||
    /(relation|table|column)\s+\S+\s+does not exist/i.test(String(e?.message || ''))
  );
}

let warnedSchemaBehind = false;
function warnSchemaBehind() {
  if (warnedSchemaBehind) return;
  warnedSchemaBehind = true;
  console.warn('⚠️  USD card tables are missing or out of date - run `npm run ddl:virtual-card`. The service is unavailable until then.');
}

/**
 * Finishes what nobody else did, every few minutes, with nobody involved:
 *   1. cards still `creating` - read back, activated, or refunded
 *   2. top-ups whose answer was lost - matched in the card's history, or refunded
 *   3. live cards - balance and history re-read, a termination noticed
 *   4. cards never funded - one reminder before Payvessel closes them
 */
async function sweep({ now = new Date() } = {}) {
  if (!payvessel.isConfigured()) return { skipped: 'not_configured' };
  const out = { creating: 0, fundings: 0, synced: 0, reminded: 0 };
  try {
    const creating = await prisma.virtualCard.findMany({
      where: { status: STATUS.CREATING, updated_at: { lt: new Date(now.getTime() - 60_000) } },
      orderBy: { updated_at: 'asc' },
      take: 20,
    });
    for (const row of creating) {
      try {
        await settleCreating(row);
        out.creating += 1;
      } catch (e) {
        captureError('virtual_card.sweep_create', e, { card_id: row.id });
      }
    }

    const fundings = await prisma.virtualCardFunding.findMany({
      where: { status: FUNDING.PROCESSING, updated_at: { lt: new Date(now.getTime() - 2 * 60_000) } },
      orderBy: { updated_at: 'asc' },
      take: 20,
    });
    for (const f of fundings) {
      try {
        await resolveFunding(f);
        out.fundings += 1;
      } catch (e) {
        captureError('virtual_card.sweep_fund', e, { funding_id: f.id });
      }
    }

    // Terminations left pending - accepted but not visible yet, or an answer
    // that was lost. Newest first, so the latest event per card is the one
    // read; a card whose latest is `terminate_requested` and is still open
    // here is settled (settleTermination). Terminations are rare, and a
    // request is answered within TERMINATE_SETTLE_MS, so the window is wide.
    const asked = await prisma.virtualCardEvent.findMany({
      where: { event: { in: ['terminate_requested', 'terminate_failed'] }, created_at: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { card_id: true, event: true },
      take: 500,
    });
    const latest = new Map();
    for (const e of asked) if (!latest.has(e.card_id)) latest.set(e.card_id, e.event);
    const pendingIds = [...latest].filter(([, ev]) => ev === 'terminate_requested').map(([cardId]) => cardId);
    if (pendingIds.length) {
      const open = await prisma.virtualCard.findMany({
        where: { id: { in: pendingIds }, status: { in: [STATUS.ACTIVE, STATUS.FROZEN] } },
        take: 20,
      });
      for (const row of open) {
        try {
          if (await settleTermination(row, now)) out.terminations = (out.terminations || 0) + 1;
        } catch (e) {
          captureError('virtual_card.sweep_terminate', e, { card_id: row.id });
        }
      }
    }

    // Live cards whose figures are old. Oldest first, a few per pass, so the
    // read budget scales with the sweep rather than the number of cards.
    const stale = await prisma.virtualCard.findMany({
      where: {
        status: { in: [STATUS.ACTIVE, STATUS.FROZEN] },
        OR: [{ checked_at: null }, { checked_at: { lt: new Date(now.getTime() - 6 * 3_600_000) } }],
      },
      orderBy: { checked_at: 'asc' },
      take: 25,
    });
    for (const row of stale) {
      try {
        const fresh = await refreshCard(row);
        await syncTransactions(fresh);
        out.synced += 1;
      } catch (e) {
        if (e?.kind === 'not_found') {
          pageOps('card_missing', row, e);
          await prisma.virtualCard.update({ where: { id: row.id }, data: { checked_at: now } });
        } else captureError('virtual_card.sweep_sync', e, { card_id: row.id });
      }
    }

    const remindBefore = new Date(now.getTime() - REMINDER_AFTER_DAYS() * 86_400_000);
    const unfunded = await prisma.virtualCard.findMany({
      where: { status: STATUS.ACTIVE, first_funded_at: null, fund_reminder_at: null, activated_at: { lt: remindBefore } },
      take: 50,
    });
    for (const row of unfunded) {
      const claimed = await prisma.virtualCard.updateMany({ where: { id: row.id, fund_reminder_at: null }, data: { fund_reminder_at: now } });
      if (!claimed.count) continue;
      notify(row, `vcard-remind-${row.id}`, 'Add money to keep your USD card', `Cards that are never funded are closed ${VC.UNFUNDED_TERMINATION_DAYS} days after they are created. Add dollars to keep yours.`);
      out.reminded += 1;
    }
  } catch (e) {
    if (isSchemaBehind(e)) {
      warnSchemaBehind();
      return { skipped: 'schema_behind' };
    }
    throw e;
  }
  return out;
}

module.exports = {
  FEATURE,
  getSettings,
  updateSettings,
  adminSettingsView,
  home,
  form,
  validateApplication,
  createCard,
  quote,
  fundCard,
  freeze,
  unfreeze,
  terminate,
  terminationPreview,
  revealDetails,
  transactions,
  handleWebhook,
  recordDelivery,
  markDelivery,
  webhookStatus,
  webhookUrl,
  adminWebhooks,
  settleCreating,
  resolveFunding,
  syncTransactions,
  handleTermination,
  sweep,
  adminOverview,
  adminList,
  adminDetail,
  adminFundings,
  adminSetFrozen,
  adminTerminate,
  adminSync,
  isSchemaBehind,
  warnSchemaBehind,
  __test: { findCreatedCard, refundCreation, refundFunding, settleFundingSuccess, applyProviderCard, storeTransactions, fundedTodayCents },
};
