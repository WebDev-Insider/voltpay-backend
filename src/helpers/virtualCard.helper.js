/**
 * USD Virtual Mastercard - the rules, with no database and no network, so the
 * money math, the limits and the form can be tested on their own. The engine
 * is services/virtualCard.service.js; the provider is
 * funding/payvesselCard.service.js.
 *
 * MONEY IS INTEGERS. Naira in kobo, dollars in cents, rates in kobo per dollar,
 * percentages in basis points. Every rounding leans the way that cannot lose
 * money: the rate and the fee round UP, the dollars a customer receives round
 * DOWN, and the difference is never more than a cent.
 */
const crypto = require('crypto');
const { canonicalNigerianState } = require('./nigeriaStates.helper');
const { revealText } = require('./pii.helper');

const STATUS = {
  CREATING: 'creating',
  ACTIVE: 'active',
  FROZEN: 'frozen',
  FAILED: 'failed',
  TERMINATED: 'terminated',
};
/** One of these per user at a time - the partial unique index in the DDL. */
const LIVE_STATUSES = [STATUS.CREATING, STATUS.ACTIVE, STATUS.FROZEN];

const FUNDING = { PROCESSING: 'processing', SUCCESSFUL: 'successful', FAILED: 'failed' };

const BRAND = 'MASTERCARD';

// Payvessel's own numbers (docs, 2026-10-13). Ours sit inside them.
const PROVIDER_MIN_FUND_CENTS = 100; // $1.00 per fund request
const PROVIDER_MAX_TXN_CENTS = 1_000_000; // $10,000 per transaction
const PROVIDER_MAX_BALANCE_CENTS = 10_000_000; // $100,000 on one card
// A card never funded within three weeks is terminated by Payvessel.
const UNFUNDED_TERMINATION_DAYS = 21;

function refusal(statusCode, remark, message, data = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.remark = remark;
  err.data = data;
  return err;
}

/* ------------------------------------------------------------- settings */

// The admin owns these (app_settings, `npm run ddl:virtual-card` seeds the
// starting values). `required` ones have no default in code: an unset creation
// fee is "not available yet", never free, and an unset dollar rate is "no
// top-ups", never a guessed rate.
const SETTINGS = {
  creation_fee: { key: 'vcard_creation_fee', kind: 'naira', required: true, label: 'Card creation fee (NGN)' },
  // What a new card is created holding. Payvessel REFUSES a create without one
  // ("card balance less than initial minimum card balance of 1", first live
  // try 2026-10-14) although its docs call `prefund_amount` optional - so it
  // is never below their $1 floor, and it comes out of the creation price.
  create_prefund_usd: { key: 'vcard_create_prefund_usd', kind: 'usd', fallback: '1', min: PROVIDER_MIN_FUND_CENTS, label: 'Starting balance on a new card (USD)' },
  fx_cost_rate: { key: 'vcard_fx_cost_rate', kind: 'rate', required: true, label: 'What $1 costs VoltPay (NGN)' },
  fx_margin_percent: { key: 'vcard_fx_margin_percent', kind: 'percent', fallback: '2', label: 'FX margin (%)' },
  funding_fee_percent: { key: 'vcard_funding_fee_percent', kind: 'percent', fallback: '2.5', label: 'Top-up fee (%)' },
  funding_fee_min_usd: { key: 'vcard_funding_fee_min_usd', kind: 'usd', fallback: '1', label: 'Minimum top-up fee (USD)' },
  min_fund_usd: { key: 'vcard_min_fund_usd', kind: 'usd', fallback: '5', label: 'Smallest top-up (USD)' },
  max_fund_usd: { key: 'vcard_max_fund_usd', kind: 'usd', fallback: '1000', label: 'Largest top-up (USD)' },
  daily_fund_limit_usd: { key: 'vcard_daily_fund_limit_usd', kind: 'usd', fallback: '1000', label: 'Top-ups per day (USD)' },
  max_balance_usd: { key: 'vcard_max_balance_usd', kind: 'usd', fallback: '5000', label: 'Most a card may hold (USD)' },
  intl_fee_percent: { key: 'vcard_intl_fee_percent', kind: 'percent', fallback: '4', label: 'International fee shown (%)' },
  intl_fee_flat_usd: { key: 'vcard_intl_fee_flat_usd', kind: 'usd', fallback: '0.50', label: 'International fee shown (USD)' },
};
const SETTING_KEYS = Object.values(SETTINGS).map(s => s.key);

const BOUNDS = {
  naira: { min: 0, max: 1_000_000 },
  rate: { min: 100, max: 20_000 },
  percent: { min: 0, max: 50 },
  usd: { min: 0, max: 100_000 },
};

/** "1,550.5" -> 155050 (hundredths). null unless a plain number, ≤ 2 dp. */
function hundredths(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/,/g, '').trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse one setting's value into its integer unit, or null when invalid. */
function parseSettingValue(kind, value) {
  const h = hundredths(value);
  if (h == null) return null;
  const { min, max } = BOUNDS[kind];
  if (h < min * 100 || h > max * 100) return null;
  // Naira fees are whole naira, like every other price an admin sets.
  if (kind === 'naira') return h % 100 === 0 && h > 0 ? h / 100 : null;
  if (kind === 'rate') return h; // kobo per dollar
  if (kind === 'percent') return h; // basis points
  return h; // usd -> cents
}

const envHours = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The live terms, from app_settings rows. Read on every call that quotes or
 * charges, never cached: a rate an admin just changed must be the rate the
 * next customer pays.
 *
 * The dollar rate goes stale. Naira moves daily, so a rate older than
 * VCARD_FX_MAX_AGE_HOURS stops top-ups until somebody confirms it - re-saving
 * the same number counts - rather than selling dollars at last week's price.
 */
function parseSettings(rows = [], { enabled = true, configured = true, now = new Date() } = {}) {
  const byKey = new Map(rows.map(r => [r.setting_key, r]));
  const out = {};
  for (const [name, spec] of Object.entries(SETTINGS)) {
    const row = byKey.get(spec.key);
    const envName = `VCARD_${name.toUpperCase()}`;
    const raw = row?.setting_value ?? process.env[envName] ?? spec.fallback ?? null;
    out[name] = raw == null ? null : parseSettingValue(spec.kind, raw);
    // A bad value in a defaulted setting falls back rather than disabling the
    // service; a required one stays null and says so.
    if (out[name] == null && spec.fallback != null) out[name] = parseSettingValue(spec.kind, spec.fallback);
  }

  const costRow = byKey.get(SETTINGS.fx_cost_rate.key);
  const rateSetAt = costRow?.setting_value ? new Date(costRow.updated_at || costRow.created_at || 0) : null;
  const maxAgeHours = envHours('VCARD_FX_MAX_AGE_HOURS', 24);
  const ageHours = rateSetAt ? (now.getTime() - rateSetAt.getTime()) / 3_600_000 : null;
  // A rate that came from env alone has no timestamp to age - it is a
  // deployment's bridge, and it is as fresh as the deployment says it is.
  const stale = out.fx_cost_rate != null && rateSetAt != null && ageHours > maxAgeHours;

  const costKobo = out.fx_cost_rate;
  const customerKobo = costKobo == null ? null : customerRateKobo(costKobo, out.fx_margin_percent);

  let creationReason = null;
  if (!enabled) creationReason = 'USD cards are paused for now. Please check back soon.';
  else if (!configured) creationReason = 'USD cards are not available yet. Please check back soon.';
  else if (out.creation_fee == null) creationReason = 'USD cards are not available yet. Please check back soon.';

  let fundingReason = null;
  if (!enabled) fundingReason = 'Card top-ups are paused for now. Please try again later.';
  else if (!configured) fundingReason = 'Card top-ups are not available yet.';
  else if (customerKobo == null) fundingReason = 'Card top-ups are not available yet. Please check back soon.';
  else if (stale) fundingReason = 'Card top-ups are paused while we update our dollar rate. Please try again shortly.';

  return {
    enabled,
    configured,
    creation_fee: out.creation_fee,
    // Never under Payvessel's floor, never over a single top-up.
    create_prefund_cents: Math.min(Math.max(PROVIDER_MIN_FUND_CENTS, out.create_prefund_usd), PROVIDER_MAX_TXN_CENTS),
    fx: {
      cost_rate_kobo: costKobo,
      margin_bps: out.fx_margin_percent,
      customer_rate_kobo: customerKobo,
      updated_at: rateSetAt,
      age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
      max_age_hours: maxAgeHours,
      stale,
    },
    funding_fee_bps: out.funding_fee_percent,
    funding_fee_min_cents: out.funding_fee_min_usd,
    min_fund_cents: Math.max(PROVIDER_MIN_FUND_CENTS, out.min_fund_usd),
    max_fund_cents: Math.min(PROVIDER_MAX_TXN_CENTS, out.max_fund_usd),
    daily_fund_limit_cents: out.daily_fund_limit_usd,
    max_balance_cents: Math.min(PROVIDER_MAX_BALANCE_CENTS, out.max_balance_usd),
    intl_fee_bps: out.intl_fee_percent,
    intl_fee_flat_cents: out.intl_fee_flat_usd,
    creation_available: creationReason == null,
    funding_available: fundingReason == null,
    creation_unavailable_reason: creationReason,
    funding_unavailable_reason: fundingReason,
  };
}

/** Kobo per dollar a customer pays: the cost plus the margin, rounded UP. */
function customerRateKobo(costKobo, marginBps = 0) {
  return Math.ceil((Number(costKobo) * (10_000 + Number(marginBps || 0))) / 10_000);
}

/* --------------------------------------------------------------- format */

const pad2 = n => String(n).padStart(2, '0');

/** 123456 kobo -> "1234.56" (a Prisma Decimal string). */
function koboToDecimal(kobo) {
  const k = Math.trunc(Number(kobo) || 0);
  return `${Math.floor(k / 100)}.${pad2(k % 100)}`;
}

/** 1234 cents -> "12.34". */
function usd(cents) {
  const c = Math.trunc(Number(cents) || 0);
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${pad2(a % 100)}`;
}

function nairaText(kobo) {
  return `₦${(Math.trunc(Number(kobo) || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdText(cents) {
  const c = Math.trunc(Number(cents) || 0);
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const percentText = bps => `${(Number(bps || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/** What the app may see. Never the cost rate or the margin. */
function publicSettings(s) {
  return {
    enabled: s.enabled,
    brand: BRAND,
    currency: 'USD',
    creation_available: s.creation_available,
    funding_available: s.funding_available,
    creation_unavailable_reason: s.creation_unavailable_reason,
    funding_unavailable_reason: s.funding_unavailable_reason,
    creation_fee: s.creation_fee,
    // What the new card arrives holding, paid for by the creation price.
    starting_balance_usd: usd(s.create_prefund_cents),
    // The customer's rate in naira per dollar. Null while top-ups are off, so
    // the screen never shows a rate nobody can buy at.
    rate: s.funding_available && s.fx.customer_rate_kobo != null ? Number(koboToDecimal(s.fx.customer_rate_kobo)) : null,
    funding_fee_percent: s.funding_fee_bps / 100,
    funding_fee_min_usd: usd(s.funding_fee_min_cents),
    min_fund_usd: usd(s.min_fund_cents),
    max_fund_usd: usd(s.max_fund_cents),
    daily_fund_limit_usd: usd(s.daily_fund_limit_cents),
    max_balance_usd: usd(s.max_balance_cents),
    intl_fee_percent: s.intl_fee_bps / 100,
    intl_fee_flat_usd: usd(s.intl_fee_flat_cents),
    intl_fee_notice:
      `Payments to merchants outside the US, or in a currency other than USD, may attract a processing fee of about ` +
      `${percentText(s.intl_fee_bps)} + ${usdText(s.intl_fee_flat_cents)}, charged by the card network.`,
    unfunded_termination_days: UNFUNDED_TERMINATION_DAYS,
    reveal_seconds: revealSeconds(),
  };
}

function revealSeconds() {
  const n = Number(process.env.VCARD_REVEAL_SECONDS);
  return Number.isFinite(n) && n >= 10 && n <= 120 ? Math.trunc(n) : 30;
}

/* ------------------------------------------------------------------ fund */

/** Whole naira only, like airtime and electricity. */
function parseWholeNaira(value) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d{1,9}(\.0{1,2})?$/.test(raw)) return null;
  const n = Math.trunc(Number(raw));
  return n > 0 ? n : null;
}

/** The naira that buys `cents` at `rateKobo`, rounded up to whole naira. */
function nairaForCents(cents, rateKobo) {
  return Math.ceil((Math.ceil((Number(cents) * Number(rateKobo)) / 100)) / 100);
}

/**
 * Price one top-up. Throws a worded refusal for anything a limit stops.
 *
 *   amountNgn  the naira the customer converts (whole naira)
 *   feeDueCents  card fees Payvessel charged to OUR wallet because the card
 *                could not cover them (cross-border / contactless recovery):
 *                taken out of this top-up before it reaches the card
 *   balanceCents the card's balance now, for the max-balance limit
 *   todayCents   dollars already bought for this card today (WAT), processing
 *                ones included
 */
function quoteFunding({ amountNgn, settings, feeDueCents = 0, balanceCents = 0, todayCents = 0 }) {
  const s = settings;
  const rate = s.fx.customer_rate_kobo;
  if (!s.funding_available || rate == null) {
    throw refusal(503, 'funding_unavailable', s.funding_unavailable_reason || 'Card top-ups are not available right now.');
  }
  const amount = parseWholeNaira(amountNgn);
  if (amount == null) throw refusal(400, 'validation_error', 'Enter the amount in whole naira, e.g. 20000');

  const amountKobo = amount * 100;
  const cents = Math.floor((amountKobo * 100) / rate);
  const feeCents = Math.max(Math.ceil((cents * s.funding_fee_bps) / 10_000), s.funding_fee_min_cents);
  const feeKobo = Math.ceil((feeCents * rate) / 100);
  const due = Math.max(0, Math.trunc(Number(feeDueCents) || 0));
  const providerCents = cents - due;

  const minNgn = nairaForCents(s.min_fund_cents, rate);
  if (cents < s.min_fund_cents) {
    throw refusal(400, 'below_minimum', `The smallest top-up is ${usdText(s.min_fund_cents)} - about ₦${minNgn.toLocaleString('en-NG')}.`, {
      min_ngn: minNgn,
    });
  }
  if (cents > s.max_fund_cents) {
    throw refusal(400, 'above_maximum', `The largest single top-up is ${usdText(s.max_fund_cents)} - about ₦${nairaForCents(s.max_fund_cents, rate).toLocaleString('en-NG')}.`, {
      max_ngn: Math.floor((s.max_fund_cents * rate) / 10_000),
    });
  }
  if (providerCents < PROVIDER_MIN_FUND_CENTS) {
    throw refusal(400, 'fees_due', `Your card has ${usdText(due)} of international fees to settle first. Add at least ${usdText(due + PROVIDER_MIN_FUND_CENTS)}.`, {
      fee_due_usd: usd(due),
    });
  }
  const left = Math.max(0, s.daily_fund_limit_cents - Math.max(0, Number(todayCents) || 0));
  if (cents > left) {
    throw refusal(
      400,
      'daily_limit',
      left > 0
        ? `You can add ${usdText(left)} more to your card today (limit ${usdText(s.daily_fund_limit_cents)} a day).`
        : `You have reached today's top-up limit of ${usdText(s.daily_fund_limit_cents)}. Try again tomorrow.`,
      { remaining_usd: usd(left) },
    );
  }
  const room = Math.max(0, s.max_balance_cents - Math.max(0, Number(balanceCents) || 0));
  if (providerCents > room) {
    throw refusal(400, 'balance_limit', `Your card can hold up to ${usdText(s.max_balance_cents)}. You can add ${usdText(room)} more.`, {
      room_usd: usd(room),
    });
  }

  return {
    amount_ngn: amount,
    amount_kobo: amountKobo,
    fee_kobo: feeKobo,
    total_kobo: amountKobo + feeKobo,
    cents,
    fee_cents: feeCents,
    fee_due_cents: due,
    provider_cents: providerCents,
    rate_kobo: rate,
    cost_rate_kobo: s.fx.cost_rate_kobo,
  };
}

/** A quote, as the app reads it. */
function publicQuote(q) {
  return {
    amount_ngn: Number(koboToDecimal(q.amount_kobo)),
    fee_ngn: Number(koboToDecimal(q.fee_kobo)),
    total_ngn: Number(koboToDecimal(q.total_kobo)),
    usd_amount: usd(q.cents),
    fee_usd: usd(q.fee_cents),
    fee_due_usd: usd(q.fee_due_cents),
    card_receives_usd: usd(q.provider_cents),
    rate: Number(koboToDecimal(q.rate_kobo)),
  };
}

/* ------------------------------------------------------------------ form */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * A date of birth in any shape the register or a keyboard produces, as
 * YYYY-MM-DD - Payvessel's format. null for anything that is not a real date.
 */
function parseDob(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let y;
  let m;
  let d;
  let hit;
  if ((hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(raw))) [, y, m, d] = hit;
  else if ((hit = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw))) [, d, m, y] = hit;
  else if ((hit = /^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ](\d{4})$/.exec(raw))) {
    d = hit[1];
    m = MONTHS[hit[2].toLowerCase()];
    y = hit[3];
  } else return null;
  const Y = Number(y);
  const M = Number(m);
  const D = Number(d);
  const date = new Date(Date.UTC(Y, M - 1, D));
  if (date.getUTCFullYear() !== Y || date.getUTCMonth() !== M - 1 || date.getUTCDate() !== D) return null;
  return `${Y}-${pad2(M)}-${pad2(D)}`;
}

function ageOn(dob, now = new Date()) {
  const [Y, M, D] = dob.split('-').map(Number);
  let age = now.getUTCFullYear() - Y;
  if (now.getUTCMonth() + 1 < M || (now.getUTCMonth() + 1 === M && now.getUTCDate() < D)) age -= 1;
  return age;
}

const digits11 = v => {
  const s = String(v ?? '').replace(/\s+/g, '');
  return /^\d{11}$/.test(s) ? s : null;
};

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The address half of the form. Everything else comes from the account and
 * its verification, never from the body - see the service's identity().
 */
function validateAddress(body = {}) {
  const errors = [];
  const street = clean(body.street, 120);
  if (street.length < 5) errors.push('Enter your street address (house number and street).');
  const state = canonicalNigerianState(clean(body.state, 40));
  if (!state) errors.push('Choose your state.');
  const lga = clean(body.lga ?? body.city, 60);
  if (!/^[A-Za-z][A-Za-z .'\-/]{1,59}$/.test(lga)) errors.push('Enter your local government area (LGA), e.g. Ikeja.');
  const postal = clean(body.postal_code ?? body.zip, 6);
  if (!/^\d{6}$/.test(postal)) errors.push('Enter your 6-digit postal code, e.g. 100001.');
  if (errors.length) throw refusal(400, 'validation_error', errors[0], { errors });
  return { street, state, lga, postalCode: postal };
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);

function imageLimitBytes() {
  const n = Number(process.env.VCARD_IMAGE_MAX_BYTES);
  return Number.isFinite(n) && n >= 50_000 ? Math.trunc(n) : 600_000;
}

/**
 * The passport photograph, as Payvessel takes it: a base64 data URL. The type
 * is read from the bytes, never from the client's label - a PDF or an SVG
 * renamed .jpg is refused before it leaves this server.
 */
function decodeImage(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw refusal(400, 'photo_required', 'Add a clear passport photograph.');
  const b64 = raw.replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw refusal(400, 'photo_invalid', 'That photo could not be read. Take it again.');
  const buffer = Buffer.from(b64, 'base64');
  const mime = startsWith(buffer, JPEG) ? 'image/jpeg' : startsWith(buffer, PNG) ? 'image/png' : null;
  if (!mime) throw refusal(400, 'photo_invalid', 'The photo must be a JPG or PNG picture.');
  if (buffer.length < 5_000) throw refusal(400, 'photo_invalid', 'That photo is too small to verify. Take a clearer one.');
  if (buffer.length > imageLimitBytes()) {
    throw refusal(400, 'photo_too_large', 'That photo is too large. Take it again at a lower resolution.');
  }
  return { mime, bytes: buffer.length, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
}

/* ------------------------------------------------------------ references */

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** VC-7K3QX2MB: what the customer and support quote. */
function newReference(prefix = 'VC') {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `${prefix}-${out}`;
}

/* ----------------------------------------------------------------- views */

const iso = d => (d ? new Date(d).toISOString() : null);

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86_400_000);
}

/** The card as the owner sees it. Never the provider id or a blind index. */
function publicCard(row) {
  if (!row) return null;
  const masked = revealText(row.masked_pan_enc || '');
  const neverFunded = !row.first_funded_at && [STATUS.ACTIVE, STATUS.FROZEN].includes(row.status);
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    brand: row.brand || BRAND,
    currency: row.currency || 'USD',
    name: revealText(row.name_enc || '').toUpperCase(),
    masked_pan: masked,
    last4: masked ? masked.replace(/\D/g, '').slice(-4) : '',
    expiry: revealText(row.expiry_enc || ''),
    balance_usd: usd(row.balance_cents || 0),
    balance_synced_at: iso(row.balance_synced_at),
    fee_due_usd: usd(row.fee_due_cents || 0),
    creation_fee: Number(row.creation_fee || 0),
    frozen_by_admin: row.status === STATUS.FROZEN && String(row.frozen_by || '').startsWith('admin'),
    failure_reason: row.status === STATUS.FAILED ? row.failure_reason || null : null,
    refunded: Boolean(row.refund_trx),
    // Payvessel closes a card nobody funds within three weeks. Said on the
    // dashboard until the first top-up lands.
    fund_by: neverFunded ? iso(addDays(row.activated_at || row.created_at, UNFUNDED_TERMINATION_DAYS)) : null,
    created_at: iso(row.created_at),
    activated_at: iso(row.activated_at),
    terminated_at: iso(row.terminated_at),
  };
}

const TYPE_LABELS = {
  AUTHORIZATION: 'Card payment',
  SETTLEMENT: 'Card payment',
  CHARGE: 'Card payment',
  FUNDING: 'Card top-up',
  WITHDRAWAL: 'Withdrawal',
  TERMINATION: 'Card closed',
  DECLINE: 'Declined payment',
  REVERSAL: 'Reversal',
  REFUND: 'Refund',
  'CROSS-BORDER': 'International processing fee',
  CROSS_BORDER: 'International processing fee',
  CROSS_BORDER_FEE: 'International processing fee',
  CONTACTLESS_FEE: 'Contactless fee',
};

function fundingItem(row) {
  const status = row.status === FUNDING.SUCCESSFUL ? 'successful' : row.status === FUNDING.FAILED ? 'failed' : 'processing';
  return {
    id: `f${row.id}`,
    kind: 'top_up',
    title: 'Card top-up',
    subtitle:
      status === 'failed'
        ? `${nairaText(Math.round(Number(row.total_ngn) * 100))} refunded to your wallet`
        : `${nairaText(Math.round(Number(row.total_ngn) * 100))} from your wallet`,
    direction: 'credit',
    amount_usd: usd(row.amount_cents),
    amount_ngn: Number(row.total_ngn),
    status,
    reference: row.reference,
    occurred_at: iso(row.created_at),
  };
}

function transactionItem(row) {
  const type = String(row.type || '').toUpperCase();
  const declined = type === 'DECLINE' || /DECLIN|FAIL/.test(String(row.status || '').toUpperCase());
  const merchant = revealText(row.merchant_enc || '');
  const label = TYPE_LABELS[type] || 'Card activity';
  const isPayment = ['AUTHORIZATION', 'SETTLEMENT', 'CHARGE', 'DECLINE'].includes(type);
  return {
    id: `t${row.id}`,
    kind: type === 'FUNDING' ? 'top_up' : /FEE|CROSS/.test(type) ? 'fee' : declined ? 'declined' : row.entry === 'CREDIT' ? 'credit' : 'payment',
    title: isPayment && merchant ? merchant : label,
    subtitle: [isPayment && merchant ? label : null, row.merchant_country || null].filter(Boolean).join(' · ') || label,
    direction: row.entry === 'CREDIT' ? 'credit' : 'debit',
    amount_usd: usd(row.amount_cents),
    fee_usd: row.fee_cents ? usd(row.fee_cents) : null,
    amount_ngn: null,
    status: declined ? 'declined' : 'successful',
    reference: row.provider_txn_id,
    occurred_at: iso(row.occurred_at || row.created_at),
  };
}

const SETTLE_WINDOW_MS = 7 * 86_400_000;

/**
 * Our top-ups and the card's own activity, newest first, as one list.
 *
 * Two kinds of double-counting are folded out:
 *   - Payvessel's FUNDING row for a top-up we already list with its naira
 *     (linked by provider_txn_id when the sync matched it).
 *   - A SETTLEMENT for a purchase whose AUTHORIZATION is already listed: same
 *     merchant, same amount, within a week. A purchase is one line, not two.
 *     UNCONFIRMED against live data - if Payvessel's list turns out to carry
 *     one row per purchase, this simply never matches.
 */
function mergeFeed(fundings = [], txns = []) {
  const linked = new Set(fundings.map(f => f.provider_txn_id).filter(Boolean));
  const auths = txns.filter(t => String(t.type).toUpperCase() === 'AUTHORIZATION');
  const usedAuth = new Set();
  const keep = txns.filter(t => {
    const type = String(t.type).toUpperCase();
    if (type === 'FUNDING' && linked.has(t.provider_txn_id)) return false;
    if (type === 'SETTLEMENT') {
      const at = new Date(t.occurred_at || t.created_at).getTime();
      const twin = auths.find(a => {
        if (usedAuth.has(a.id) || a.amount_cents !== t.amount_cents || a.merchant_enc == null) return false;
        if (revealText(a.merchant_enc) !== revealText(t.merchant_enc || '')) return false;
        const aAt = new Date(a.occurred_at || a.created_at).getTime();
        return aAt <= at && at - aAt <= SETTLE_WINDOW_MS;
      });
      if (twin) {
        usedAuth.add(twin.id);
        return false;
      }
    }
    return true;
  });
  return [...fundings.map(fundingItem), ...keep.map(transactionItem)].sort(
    (a, b) => new Date(b.occurred_at || 0).getTime() - new Date(a.occurred_at || 0).getTime(),
  );
}

module.exports = {
  STATUS,
  LIVE_STATUSES,
  FUNDING,
  BRAND,
  PROVIDER_MIN_FUND_CENTS,
  UNFUNDED_TERMINATION_DAYS,
  SETTINGS,
  SETTING_KEYS,
  refusal,
  parseSettings,
  parseSettingValue,
  publicSettings,
  customerRateKobo,
  quoteFunding,
  publicQuote,
  parseWholeNaira,
  nairaForCents,
  koboToDecimal,
  usd,
  usdText,
  nairaText,
  parseDob,
  ageOn,
  digits11,
  validateAddress,
  decodeImage,
  newReference,
  publicCard,
  fundingItem,
  transactionItem,
  mergeFeed,
  revealSeconds,
};
