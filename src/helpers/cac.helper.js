// CAC Registration - the rules. No database and no network: everything here is
// a function of its arguments, so it is what the tests pin. The engine is
// services/cac.service.js.
//
// THREE REGISTRATION TYPES, ONE PIPELINE. A business name (enterprise), a
// limited liability company and incorporated trustees (an NGO) differ in what
// the form collects - a company has directors and shareholders and a share
// capital, an NGO has at least two trustees and a constitution - and in their
// price. They do not differ in how an application is paid for, processed or
// delivered, so everything after the form is shared.
//
// WHAT IS STORED, AND HOW. Everything the customer types - including every
// director's or trustee's details - is one JSON object written through
// protectText() into `details_enc`. Every document is an UploadThing link,
// which is a bearer token for a photograph of a government ID, so the map of
// them is protectText()'d too, into `documents_enc`. Nothing in the table is
// searchable but the reference, and that is deliberate.
const { protectText, revealText } = require('./pii.helper');
const { normalizeNgPhone } = require('./phone.helper');

const STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  IN_PROGRESS: 'in_progress',
  NEEDS_MORE_INFO: 'needs_more_info',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
};

// A draft is not an application - it is a form nobody has paid for - so it is
// never in the customer's list and never in the admin queue.
const VISIBLE_STATUSES = [
  STATUS.SUBMITTED,
  STATUS.IN_PROGRESS,
  STATUS.NEEDS_MORE_INFO,
  STATUS.COMPLETED,
  STATUS.REJECTED,
];

const STATUS_LABELS = {
  draft: 'Awaiting payment',
  submitted: 'Submitted',
  in_progress: 'In Progress',
  needs_more_info: 'Needs More Info',
  completed: 'Completed',
  rejected: 'Rejected',
};

/* ------------------------------------------------------------- the types */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

// One person's three documents, as the processing partner's checklist names
// them. A NIN slip is often a PDF; a passport photograph and a signature are
// images by definition. `label` is for a screen, `noun` for a sentence.
//
// `valid_id` is the key the stored documents and the upload fields already
// use, so it stays - only what it is called changed, when the ID became the
// NIN slip or card rather than a choice of four.
const PERSON_DOCUMENTS = {
  valid_id: { label: 'NIN slip or card', noun: 'NIN slip or card', accept: DOCUMENT_TYPES },
  passport: { label: 'Passport photograph', noun: 'passport photograph', accept: IMAGE_TYPES },
  signature: { label: 'Signature specimen', noun: 'signature specimen', accept: IMAGE_TYPES },
};

// Other directors, shareholders or trustees sit in fixed slots, so a person's
// documents stay theirs when somebody above them on the form is removed.
const MEMBER_SLOTS = ['m1', 'm2', 'm3', 'm4'];

const LTD_ROLES = { director: 'Director', shareholder: 'Shareholder', both: 'Director and shareholder' };

/**
 * What each registration type collects. The price is NOT here: it is an admin
 * setting per type (see settingKeys), and this file has no opinion on it.
 */
const TYPES = {
  business_name: {
    label: 'Business Name (Enterprise)',
    short: 'Business Name',
    noun: 'business name',
    description: 'For sole traders and small businesses, registered in the owner\'s name.',
    natureLabel: 'Nature of business',
    natureMax: 120,
    // CAC's own words: the physical business or shop address.
    addressLabel: 'Principal place of business',
    ownerRole: 'Proprietor',
    members: null,
    shares: false,
    extraDocuments: [],
    registrationPrefix: 'BN',
    certificateLabel: 'Certificate of Registration of Business Name',
    // What an admin may hand back on completion, in the order offered.
    deliverables: ['certificate', 'status_report', 'tin', 'other'],
  },
  limited_company: {
    label: 'Limited Liability Company (LTD)',
    short: 'Limited Company',
    noun: 'company',
    description: 'A separate legal entity with shares. Add up to 4 other directors or shareholders.',
    natureLabel: 'Principal business activity',
    natureMax: 120,
    addressLabel: 'Registered office address',
    ownerRole: 'Director and shareholder',
    members: { min: 0, max: 4, label: 'Director / shareholder', roles: LTD_ROLES },
    shares: true,
    extraDocuments: [],
    registrationPrefix: 'RC',
    certificateLabel: 'Certificate of Incorporation',
    deliverables: ['certificate', 'status_report', 'memart', 'tin', 'other'],
  },
  incorporated_trustees: {
    label: 'Incorporated Trustees (NGO)',
    short: 'NGO / Incorporated Trustees',
    noun: 'organisation',
    description: 'For NGOs, foundations, religious bodies and associations. Needs at least two trustees and a constitution.',
    natureLabel: 'Aims and objectives',
    natureMax: 500,
    addressLabel: 'Address of the organisation',
    ownerRole: 'Trustee',
    // The applicant is trustee one, and CAC wants at least two.
    members: { min: 1, max: 4, label: 'Trustee', roles: null },
    shares: false,
    extraDocuments: [{ kind: 'constitution', label: 'Constitution', noun: 'constitution', accept: DOCUMENT_TYPES }],
    registrationPrefix: 'IT',
    certificateLabel: 'Certificate of Incorporation (Incorporated Trustees)',
    deliverables: ['certificate', 'status_report', 'constitution', 'tin', 'other'],
  },
};
const TYPE_CODES = Object.keys(TYPES);
const DEFAULT_TYPE = 'business_name';

const isType = code => Object.prototype.hasOwnProperty.call(TYPES, String(code));

// Admin settings, one set per type. Env is only a bridge for a deployment
// whose admin has not saved a price - the dashboard value always wins.
const settingKeys = code => ({
  price: `cac_price_${code}`,
  time: `cac_time_${code}`,
  enabled: `cac_enabled_${code}`,
  env: `CAC_PRICE_${String(code).toUpperCase()}`,
});

// Every document field a form may carry: the applicant's three, three per
// member slot, and each type's extras. The upload middleware is built from
// this list, so the two cannot drift apart.
const UPLOAD_FIELDS = [
  ...Object.keys(PERSON_DOCUMENTS),
  ...MEMBER_SLOTS.flatMap(slot => Object.keys(PERSON_DOCUMENTS).map(k => `${slot}_${k}`)),
  ...new Set(TYPE_CODES.flatMap(code => TYPES[code].extraDocuments.map(d => d.kind))),
];

/** Label and accepted types for any document kind, or null for an unknown one. */
function documentSpec(kind) {
  if (PERSON_DOCUMENTS[kind]) return PERSON_DOCUMENTS[kind];
  const m = /^(m\d)_(valid_id|passport|signature)$/.exec(String(kind));
  if (m && MEMBER_SLOTS.includes(m[1])) return PERSON_DOCUMENTS[m[2]];
  for (const code of TYPE_CODES) {
    const extra = TYPES[code].extraDocuments.find(d => d.kind === kind);
    if (extra) return extra;
  }
  return null;
}

/**
 * The documents a set of details needs, in the order a person reads them.
 * `label` says whose each is on a screen ("Trustee 2 - Valid ID"); `phrase`
 * says it in a sentence ("Trustee 2's valid ID").
 */
function requiredDocuments(details) {
  const type = TYPES[details?.registration_type] || TYPES[DEFAULT_TYPE];
  const out = Object.entries(PERSON_DOCUMENTS).map(([kind, spec]) => ({
    kind,
    label: spec.label,
    phrase: `the ${spec.noun}`,
    accept: spec.accept,
  }));
  (details?.members || []).forEach((m, i) => {
    const who = `${type.members?.label || 'Member'} ${i + 2}`;
    for (const [doc, spec] of Object.entries(PERSON_DOCUMENTS)) {
      out.push({ kind: `${m.slot}_${doc}`, label: `${who} - ${spec.label}`, phrase: `${who}'s ${spec.noun}`, accept: spec.accept });
    }
  });
  for (const extra of type.extraDocuments) {
    out.push({ kind: extra.kind, label: extra.label, phrase: `the ${extra.noun}`, accept: extra.accept });
  }
  return out;
}

/* -------------------------------------------------------------- statuses */

// Admin actions: where each may start from and where it lands. Every one of
// them is ALSO guarded on `payment_status: 'paid'` in the SQL, which is what
// makes "never process an unpaid application" structural rather than a rule
// the dashboard has to remember.
const TRANSITIONS = {
  start: { from: [STATUS.SUBMITTED], to: STATUS.IN_PROGRESS, stamp: 'started_at', event: 'started' },
  request_info: {
    from: [STATUS.SUBMITTED, STATUS.IN_PROGRESS],
    to: STATUS.NEEDS_MORE_INFO,
    stamp: 'info_requested_at',
    event: 'info_requested',
  },
  complete: { from: [STATUS.IN_PROGRESS], to: STATUS.COMPLETED, stamp: 'completed_at', event: 'completed' },
  reject: {
    from: [STATUS.SUBMITTED, STATUS.IN_PROGRESS, STATUS.NEEDS_MORE_INFO],
    to: STATUS.REJECTED,
    stamp: 'rejected_at',
    event: 'rejected',
  },
};

// The customer edits a draft in place, and answers a request for more
// information - which sends the application back to the queue as `submitted`.
const USER_EDITABLE = [STATUS.DRAFT, STATUS.NEEDS_MORE_INFO];
// The documents CAC issues go up while the work is in hand, and can be added
// to or corrected after completion. Never before somebody has started.
const DELIVERABLES_UPLOADABLE = [STATUS.IN_PROGRESS, STATUS.COMPLETED];

/* ---------------------------------------------------------- deliverables */

/**
 * What CAC hands back, and an admin hands on: the certificate, and whatever
 * comes with it - a status report, a company's memorandum and articles, an
 * NGO's certified constitution, a TIN. Each is a row in `cac_deliverables`.
 *
 * The certificate is the one that matters to the rules: an application cannot
 * be completed without it, there is only ever one (a second upload replaces
 * it), and once completed it can be replaced but never removed. Everything
 * else is added beside it, up to MAX_DELIVERABLES.
 */
const DELIVERABLE_KINDS = {
  certificate: 'Certificate',
  status_report: 'Status report',
  memart: 'Memorandum and Articles of Association',
  constitution: 'Certified constitution',
  tin: 'TIN certificate',
  other: 'Other document',
};
// Display order: the certificate first, then as listed above.
const DELIVERABLE_ORDER = Object.keys(DELIVERABLE_KINDS);
const MAX_DELIVERABLES = 10;

// Only the NIN slip or card is collected now - CAC validates every person on a
// registration against NIMC, so the NIN is mandatory and its slip is the ID.
// The other three remain so an application saved before that still reads.
const ID_TYPES = {
  nin: 'NIN slip / card',
  voters_card: "Voter's card",
  drivers_licence: "Driver's licence",
  intl_passport: 'International passport',
};

const DELIVERABLE_ACCEPT = DOCUMENT_TYPES;
const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const DELIVERABLE_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_PROCESSING_TIME = '5-10 working days';
// Sanity bounds, not prices. A price is only ever what an admin set.
const MIN_PRICE = 100;
const MAX_PRICE = 1_000_000;
// CAMA 2020 s.27: a private company's issued share capital is at least
// ₦100,000. The ceiling is ours - CAC filing fees and stamp duty grow with the
// capital, and the admin's price is set for the standard package.
const MIN_SHARE_CAPITAL = 100_000;
function maxShareCapital() {
  const raw = String(process.env.CAC_MAX_SHARE_CAPITAL ?? '').trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= MIN_SHARE_CAPITAL ? n : 1_000_000;
}

const MIN_NOTE = 8;
const MAX_NOTE = 1000;

/* ----------------------------------------------------------------- errors */

/** A refusal worded for whoever reads it. The controller sends it as is. */
function refusal(statusCode, remark, message, data = null) {
  return Object.assign(new Error(message), { statusCode, remark, data });
}

/* ------------------------------------------------------------------ price */

/**
 * Whole naira inside the bounds, or null. Whole because Paystack takes kobo and
 * `price * 100` is only exact for an integer.
 */
function parsePrice(raw) {
  const text = String(raw ?? '').trim().replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < MIN_PRICE || n > MAX_PRICE) return null;
  return n;
}

function cleanProcessingTime(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 3 || text.length > 60) return null;
  return text;
}

/* -------------------------------------------------------------- validation */

const squash = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// Letters, digits and the punctuation a registered name actually uses. No angle
// brackets or quotes beyond the apostrophe - the value ends up in a CAC filing
// and in admin HTML.
const BUSINESS_NAME = /^[A-Za-z0-9][A-Za-z0-9 &'.,()-]*$/;
const PERSON_NAME = /^[A-Za-z][A-Za-z' -]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function ageOn(dob, today) {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function invalid(field, message) {
  return { ok: false, field, message };
}

const PERSON_KEYS = ['full_name', 'nin', 'dob', 'phone', 'email', 'residential_address'];

const NIN = /^\d{11}$/;
// Of the three proposed-name boxes, how many must be filled.
const REQUIRED_NAMES = 2;

/**
 * Whether two records describe the same person, for carrying a stored NIN.
 * The app is only ever shown a NIN's last four digits, so on an edit it has
 * nothing to send back and leaves the box empty. That must keep the number
 * for the person it belongs to - and must NOT hand it to somebody else: a
 * member slot freed by a removal is reused by the next person added, and an
 * applicant may change who the owner is. Name and date of birth both
 * unchanged is the test; anything else asks for the NIN again.
 */
function samePerson(a, b) {
  return (
    Boolean(a && b) &&
    squash(a.full_name).toUpperCase() === squash(b.full_name).toUpperCase() &&
    squash(a.dob) === squash(b.dob)
  );
}

/**
 * One person's details, normalised. `who` names them in the message ("Trustee
 * 2's date of birth ..."), `prefix` names the field for the app, and `stored`
 * is what is on file for them, if anything - see samePerson.
 */
function validatePerson(p, { who, prefix, today, stored = null }) {
  const name = squash(p.full_name);
  const field = key => `${prefix}${key}`;
  const whose = who ? `${who}'s` : "the owner's";
  // CAC checks the name against the NIN record, so "as on their ID" is not
  // enough - a name that differs from NIMC's comes back from CAC refused.
  if (name.length < 5 || name.length > 100 || !PERSON_NAME.test(name)) {
    return invalid(field('full_name'), `Enter ${whose} full name exactly as on their NIN`);
  }
  if (name.split(' ').filter(Boolean).length < 2) return invalid(field('full_name'), `Enter ${whose} first name and surname`);

  const dobText = squash(p.dob);
  const m = ISO_DATE.exec(dobText);
  const dob = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  // A date that does not survive the round trip (2001-02-30) is not a date.
  if (!dob || dob.toISOString().slice(0, 10) !== dobText) return invalid(field('dob'), `Enter ${whose} date of birth as YYYY-MM-DD`);
  const age = ageOn(dob, today);
  // CAC registers adults; a minor needs a guardian on the form, which this
  // service does not collect.
  if (age < 18) return invalid(field('dob'), `${who || 'The business owner'} must be at least 18 years old`);
  if (age > 120) return invalid(field('dob'), `Check ${whose} date of birth`);

  // Mandatory for every proprietor, director and trustee: CAC validates each
  // one against NIMC. Spaces and dashes are how people copy it off a slip.
  let nin = String(p.nin ?? '').replace(/[\s-]/g, '');
  if (!nin && stored?.nin) {
    if (!samePerson(stored, { full_name: name, dob: dobText })) {
      return invalid(field('nin'), `Enter ${whose} NIN again - the name or date of birth changed`);
    }
    nin = stored.nin;
  }
  if (!NIN.test(nin)) return invalid(field('nin'), `Enter ${whose} NIN - the 11-digit National Identification Number`);

  const phone = normalizeNgPhone(p.phone);
  if (!phone) return invalid(field('phone'), `Enter a valid Nigerian phone number for ${who || 'the owner'}`);

  const email = squash(p.email).toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return invalid(field('email'), `Enter a valid email address for ${who || 'the owner'}`);

  const address = squash(p.residential_address);
  if (address.length < 10 || address.length > 250) {
    return invalid(field('residential_address'), `Enter ${whose} residential address - house number, street, city and state`);
  }

  return {
    ok: true,
    // The ID is always the NIN slip or card now; whatever an older app sends
    // as `id_type` is not read.
    person: { full_name: name, nin, dob: dobText, phone: phone.msisdn, email, residential_address: address, id_type: 'nin' },
  };
}

/** `members` arrives as a JSON string in a multipart form, or an array in JSON. */
function parseMembers(raw) {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const wholeNumber = v => {
  const text = String(v ?? '').trim().replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Merge what was sent over what is stored, then validate the whole object.
 *
 * Validating the merge rather than the request is what lets an update send one
 * field: the stored values were valid when they were written, the rules here
 * are the same rules, and so a partial update cannot leave the row in a state
 * a full submission would have been refused for.
 */
function validateDetails(body = {}, existing = null, { today = new Date() } = {}) {
  const base = existing || {};
  const code = squash(body.registration_type ?? base.registration_type ?? DEFAULT_TYPE).toLowerCase();
  if (!isType(code)) return invalid('registration_type', 'Choose the type of registration');
  const type = TYPES[code];

  const names = [0, 1, 2].map(i => base.proposed_names?.[i] ?? '');
  [body.proposed_name_1, body.proposed_name_2, body.proposed_name_3].forEach((n, i) => {
    if (n !== undefined) names[i] = n;
  });
  const pick = key => squash(body[key] ?? base[key] ?? '');
  const owner = {
    full_name: body.owner_name ?? base.owner_name ?? '',
    // Blank means "the one on file" - see samePerson.
    nin: body.nin ?? '',
    dob: body.dob ?? base.dob ?? '',
    phone: body.phone ?? base.phone ?? '',
    email: body.email ?? base.email ?? '',
    residential_address: body.residential_address ?? base.residential_address ?? '',
  };

  const d = {
    registration_type: code,
    proposed_names: names.map(squash),
    nature_of_business: pick('nature_of_business'),
    business_address: pick('business_address'),
  };

  // Two names in order of preference, as CAC's name search takes them; a
  // third is a spare the reviewer can fall back on, never a requirement.
  for (let i = 0; i < 3; i += 1) {
    const n = d.proposed_names[i];
    const field = `proposed_name_${i + 1}`;
    if (!n) {
      if (i < REQUIRED_NAMES) return invalid(field, `Enter proposed name ${i + 1}`);
      continue;
    }
    if (n.length < 3 || n.length > 80) return invalid(field, `Proposed name ${i + 1} must be 3 to 80 characters`);
    if (!BUSINESS_NAME.test(n)) {
      return invalid(field, `Proposed name ${i + 1} can only use letters, numbers, spaces and & ' . , ( ) -`);
    }
  }
  const seen = d.proposed_names.map(n => n.toUpperCase());
  const repeat = seen.findIndex((n, i) => n && seen.indexOf(n) !== i);
  if (repeat >= 0) {
    return invalid(`proposed_name_${repeat + 1}`, 'Give different names - CAC moves to the next one if the first is taken');
  }
  d.proposed_names = d.proposed_names.filter(Boolean);

  if (d.nature_of_business.length < 3 || d.nature_of_business.length > type.natureMax) {
    return invalid('nature_of_business', `Enter the ${type.natureLabel.toLowerCase()} (3 to ${type.natureMax} characters)`);
  }
  if (d.business_address.length < 10 || d.business_address.length > 250) {
    return invalid('business_address', `Enter the ${type.addressLabel.toLowerCase()} - house number, street, city and state`);
  }

  const storedOwner = base.nin ? { full_name: base.owner_name, dob: base.dob, nin: base.nin } : null;
  const ownerCheck = validatePerson(owner, { who: null, prefix: '', today, stored: storedOwner });
  if (!ownerCheck.ok) {
    // The applicant's fields keep their original names in the API.
    return ownerCheck.field === 'full_name' ? { ...ownerCheck, field: 'owner_name' } : ownerCheck;
  }
  const o = ownerCheck.person;
  Object.assign(d, {
    owner_name: o.full_name,
    nin: o.nin,
    dob: o.dob,
    phone: o.phone,
    email: o.email,
    residential_address: o.residential_address,
    id_type: o.id_type,
  });

  // Members: other directors and shareholders, or other trustees.
  let rawMembers = parseMembers(body.members);
  if (rawMembers === null) return invalid('members', 'The other people on this application could not be read');
  if (rawMembers === undefined) rawMembers = base.registration_type === code ? base.members || [] : [];
  if (!type.members) rawMembers = [];
  const limits = type.members || { min: 0, max: 0 };
  if (rawMembers.length < limits.min) {
    return invalid('members', `Add at least ${limits.min} more ${limits.label.toLowerCase()} - CAC needs ${limits.min + 1} in all`);
  }
  if (rawMembers.length > limits.max) return invalid('members', `Add at most ${limits.max} more ${(limits.label || 'people').toLowerCase()}s`);

  const slots = new Set();
  const members = [];
  for (let i = 0; i < rawMembers.length; i += 1) {
    const raw = rawMembers[i] || {};
    const slot = squash(raw.slot);
    if (!MEMBER_SLOTS.includes(slot) || slots.has(slot)) return invalid('members', 'The other people on this application could not be read');
    slots.add(slot);
    const who = `${limits.label} ${i + 2}`;
    const stored = (base.members || []).find(m => m?.slot === slot) || null;
    const check = validatePerson(raw, { who, prefix: `${slot}.`, today, stored });
    if (!check.ok) return check;
    const member = { slot, ...check.person };
    if (type.shares) {
      const role = squash(raw.role).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(LTD_ROLES, role)) return invalid(`${slot}.role`, `Choose what ${who} will be`);
      member.role = role;
      const shares = role === 'director' ? 0 : wholeNumber(raw.shares);
      if (role !== 'director' && (!Number.isInteger(shares) || shares < 1 || shares > 99)) {
        return invalid(`${slot}.shares`, `Enter ${who}'s share of the company as a whole percentage`);
      }
      member.shares = shares;
    }
    members.push(member);
  }
  d.members = members;

  // One NIN is one person. Two people on the form with the same number is a
  // copy-paste slip, and CAC would refuse the filing over it.
  const nins = [d.nin, ...members.map(m => m.nin)];
  const clash = nins.findIndex((n, i) => nins.indexOf(n) !== i);
  if (clash > 0) {
    return invalid(
      `${members[clash - 1].slot}.nin`,
      `${limits.label} ${clash + 1} has the same NIN as somebody else on this application - each person has their own`,
    );
  }

  if (type.shares) {
    const capital = wholeNumber(body.share_capital ?? base.share_capital);
    const max = maxShareCapital();
    if (!Number.isInteger(capital) || capital < MIN_SHARE_CAPITAL || capital > max) {
      return invalid(
        'share_capital',
        `Share capital must be between ₦${MIN_SHARE_CAPITAL.toLocaleString('en-NG')} and ₦${max.toLocaleString('en-NG')}`,
      );
    }
    // The applicant is always a director and a shareholder of their company.
    const ownerShares = wholeNumber(body.owner_shares ?? base.owner_shares ?? (members.length ? null : 100));
    if (!Number.isInteger(ownerShares) || ownerShares < 1 || ownerShares > 100) {
      return invalid('owner_shares', 'Enter your share of the company as a whole percentage');
    }
    const total = ownerShares + members.reduce((n, m) => n + (m.shares || 0), 0);
    if (total !== 100) return invalid('owner_shares', `The shares add up to ${total}% - they must add up to 100%`);
    d.share_capital = capital;
    d.owner_shares = ownerShares;
  }

  return { ok: true, details: d };
}

/** Which keys an update actually changed - names only, for the audit trail. */
function changedFields(before = {}, after = {}) {
  const changed = [];
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed;
}

function validateNote(raw, { label = 'note', min = MIN_NOTE } = {}) {
  const note = String(raw ?? '').trim();
  if (note.length < min) return invalid('note', `Write a ${label} of at least ${min} characters`);
  if (note.length > MAX_NOTE) return invalid('note', `Keep the ${label} under ${MAX_NOTE} characters`);
  return { ok: true, note };
}

/**
 * BN 1234567 -> BN1234567, RC-1234567 -> RC1234567, IT 123456 -> IT123456.
 * The prefix is the type's, so a company cannot be given a business name's
 * number by a slip of the keyboard. '' means none given; null means malformed.
 */
function cleanRegistrationNumber(code, raw) {
  const prefix = (TYPES[code] || TYPES[DEFAULT_TYPE]).registrationPrefix;
  const text = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!text) return '';
  const m = new RegExp(`^(?:${prefix})?(\\d{4,10})$`).exec(text);
  return m ? `${prefix}${m[1]}` : null;
}

/* ------------------------------------------------------------------- files */

/**
 * The type a file really is, from its first bytes - never the type the client
 * claimed. These files are later served to an admin's browser from the
 * dashboard's own origin, so trusting a client's `image/svg+xml` or a renamed
 * HTML file would be stored XSS against the people with the most access.
 */
function sniffType(buffer) {
  const b = buffer && buffer.length ? buffer : null;
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function extensionFor(mime) {
  return EXTENSIONS[mime] || 'bin';
}

const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Check one uploaded file against what its slot accepts. `phrase` names it in a
 * sentence: "the passport photograph", "Trustee 2's valid ID".
 */
function checkFile(file, { accept, maxBytes, phrase }) {
  if (!file || !file.buffer || !file.buffer.length) return invalid('file', `Attach ${phrase}`);
  if (file.buffer.length > maxBytes) {
    return invalid('file', `${capitalise(phrase)} is over ${Math.round(maxBytes / 1024 / 1024)}MB. Send a smaller one.`);
  }
  const mime = sniffType(file.buffer);
  if (!mime || !accept.includes(mime)) {
    const kinds = accept.includes('application/pdf') ? 'a JPG, PNG or PDF' : 'a JPG or PNG photo';
    return invalid('file', `${capitalise(phrase)} must be ${kinds}`);
  }
  return { ok: true, mime };
}

/* -------------------------------------------------------------- reading back */

function revealJson(enc) {
  try {
    const text = revealText(enc || '');
    const parsed = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const revealDetails = row => revealJson(row?.details_enc);
const protectDetails = details => protectText(JSON.stringify(details));
/** { kind: { url, mime } } - the bearer links, for the server's eyes only. */
const revealDocuments = row => revealJson(row?.documents_enc);
const protectDocuments = docs => protectText(JSON.stringify(docs || {}));

const safeText = enc => (enc ? revealText(enc) : '');

const typeOf = (row, details) => (isType(row?.registration_type) ? row.registration_type : details?.registration_type || DEFAULT_TYPE);

/** The name a list shows: the registered name once there is one, else choice one. */
function displayName(row, details = revealDetails(row)) {
  return safeText(row?.registered_name_enc) || details.proposed_names?.[0] || '';
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The customer's progress, as steps the app draws without knowing the rules.
 * Computed here so the app and the admin screen can never disagree about what
 * the customer was shown.
 */
function timeline(row) {
  const s = row.status;
  const started = Boolean(row.started_at);
  const steps = [
    {
      key: 'submitted',
      title: 'Application submitted',
      subtitle: 'Payment received and your application is in the queue',
      state: 'done',
      at: iso(row.paid_at || row.submitted_at),
    },
    {
      key: 'in_progress',
      title: 'Processing with CAC',
      subtitle: 'Name availability search and registration',
      state:
        s === STATUS.IN_PROGRESS ? 'current'
          : s === STATUS.COMPLETED || started ? 'done'
            : 'pending',
      at: iso(row.started_at),
    },
  ];
  if (s === STATUS.NEEDS_MORE_INFO) {
    steps.push({
      key: 'needs_more_info',
      title: 'More information needed',
      subtitle: 'Update your application so we can continue',
      state: 'current',
      at: iso(row.info_requested_at),
    });
  }
  if (s === STATUS.REJECTED) {
    steps.push({
      key: 'rejected',
      title: 'Application not successful',
      subtitle: row.refunded_at ? 'Your payment was refunded to your VoltPay wallet' : 'See the reason below',
      state: 'failed',
      at: iso(row.rejected_at),
    });
  } else {
    steps.push({
      key: 'completed',
      title: 'Documents ready',
      subtitle: 'Registration is complete - your certificate and documents are here',
      state: s === STATUS.COMPLETED ? 'done' : 'pending',
      at: iso(row.completed_at),
    });
  }
  return steps;
}

// What the customer is shown of the history. Admin notes and draft edits are
// internal; everything that changed the state of their application is theirs.
const USER_EVENTS = {
  paid: 'Payment received',
  started: 'Processing started',
  info_requested: 'More information requested',
  info_provided: 'You updated your application',
  completed: 'Registration completed - documents issued',
  rejected: 'Application not successful',
  refunded: 'Refunded to your wallet',
  duplicate_payment_refunded: 'Duplicate payment refunded to your wallet',
};
// Whose words the customer may read: the request and the rejection reason are
// written for them. Nothing else an admin typed is.
const USER_VISIBLE_NOTES = new Set(['info_requested', 'rejected']);

function publicEvent(e) {
  return {
    id: e.id,
    event: e.event,
    title: USER_EVENTS[e.event] || e.event,
    note: USER_VISIBLE_NOTES.has(e.event) ? safeText(e.note_enc) || null : null,
    at: iso(e.created_at),
  };
}

/** A NIN's last four digits - a label to recognise it by, never a key. */
const last4 = nin => (/^\d{11}$/.test(String(nin || '')) ? String(nin).slice(-4) : null);

/** Every document the details call for, and whether we hold each one. Never the link. */
function documentStates(details, docs) {
  return requiredDocuments(details).map(({ kind, label }) => ({
    kind,
    label,
    uploaded: Boolean(docs?.[kind]?.url),
    mime_type: docs?.[kind]?.mime || null,
  }));
}

/** A deliverable's name on screen: what the admin called it, else its kind's. */
function deliverableLabel(code, d) {
  const typed = safeText(d?.label_enc);
  if (typed) return typed;
  if (d?.kind === 'certificate') return (TYPES[code] || TYPES[DEFAULT_TYPE]).certificateLabel;
  return DELIVERABLE_KINDS[d?.kind] || 'Document';
}

/** CAC-7K3QX2MB-Certificate.pdf, CAC-7K3QX2MB-Status-report.pdf ... */
function deliverableFileName(row, d, label) {
  const slug = String(label || DELIVERABLE_KINDS[d?.kind] || 'Document')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'Document';
  return `${row.reference}-${d?.kind === 'certificate' ? 'Certificate' : slug}.${extensionFor(d?.mime)}`;
}

/** Certificate first, then by kind, then oldest first within a kind. */
function sortDeliverables(list) {
  const rank = kind => {
    const i = DELIVERABLE_ORDER.indexOf(kind);
    return i < 0 ? DELIVERABLE_ORDER.length : i;
  };
  return [...(list || [])].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || new Date(a.created_at) - new Date(b.created_at) || a.id - b.id,
  );
}

/**
 * One deliverable as the customer sees it: a name, a file name, a type. Never
 * the link - the bytes come through the authenticated download endpoint.
 */
function publicDeliverable(row, d) {
  const code = typeOf(row);
  const label = deliverableLabel(code, d);
  return {
    id: d.id,
    kind: d.kind,
    label,
    file_name: deliverableFileName(row, d, label),
    mime_type: d.mime || null,
    size: d.size ?? null,
    created_at: iso(d.created_at),
  };
}

/** The type's public description - what the app needs to label a form. */
function publicType(code) {
  const t = TYPES[code];
  return {
    code,
    label: t.label,
    short: t.short,
    description: t.description,
    nature_label: t.natureLabel,
    nature_max: t.natureMax,
    address_label: t.addressLabel,
    owner_role: t.ownerRole,
    members: t.members
      ? {
        min: t.members.min,
        max: t.members.max,
        label: t.members.label,
        roles: t.members.roles ? Object.entries(t.members.roles).map(([value, label]) => ({ value, label })) : null,
      }
      : null,
    shares: t.shares,
    share_capital: t.shares ? { min: MIN_SHARE_CAPITAL, max: maxShareCapital() } : null,
    extra_documents: t.extraDocuments.map(d => ({ kind: d.kind, label: d.label })),
    registration_prefix: t.registrationPrefix,
    certificate_label: t.certificateLabel,
    // What an admin can issue for this type, with the label each starts as.
    deliverable_kinds: t.deliverables.map(kind => ({
      kind,
      label: kind === 'certificate' ? t.certificateLabel : DELIVERABLE_KINDS[kind],
    })),
  };
}

/**
 * The customer's view of one application. `detail` adds the form back, the
 * documents, the timeline and the history - the list does not need them.
 *
 * `deliverables` are the documents CAC issued (cac_deliverables rows), shown
 * only once the application is completed - an admin may be uploading them one
 * at a time while it is in progress, and a half-delivered set is not the
 * customer's to download yet.
 *
 * Never carries a document link: what was issued is downloaded through an
 * authenticated endpoint, and the customer's own uploads are not sent back at
 * all - they already have them, and a link is a bearer token.
 *
 * Never carries a whole NIN either, unless `fullNin` - which only the admin
 * view passes, because the admin files it with CAC. The customer typed it and
 * is shown the last four digits, as the KYC screens do.
 */
function publicApplication(row, { detail = false, events = [], deliverables = [], fullNin = false } = {}) {
  if (!row) return null;
  const details = revealDetails(row);
  const code = typeOf(row, details);
  const type = TYPES[code];
  const status = row.status;
  const completed = status === STATUS.COMPLETED;
  const base = {
    id: row.id,
    reference: row.reference,
    registration_type: code,
    registration_type_label: type.label,
    status,
    status_label: STATUS_LABELS[status] || status,
    payment_status: row.payment_status,
    payment_method: row.payment_method || null,
    amount_paid: row.amount_paid != null ? Number(row.amount_paid) : null,
    business_name: displayName(row, details),
    registered_name: completed ? safeText(row.registered_name_enc) || null : null,
    registration_number: completed ? safeText(row.registration_number_enc) || null : null,
    // The request or the reason, only while it is the current state of affairs.
    admin_note:
      status === STATUS.NEEDS_MORE_INFO || status === STATUS.REJECTED ? safeText(row.admin_note_enc) || null : null,
    can_edit: USER_EDITABLE.includes(status),
    refunded: Boolean(row.refunded_at),
    deliverables: completed ? sortDeliverables(deliverables).map(d => publicDeliverable(row, d)) : [],
    paid_at: iso(row.paid_at),
    submitted_at: iso(row.submitted_at),
    completed_at: iso(row.completed_at),
    rejected_at: iso(row.rejected_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  if (!detail) return base;
  return {
    ...base,
    type: publicType(code),
    details: {
      registration_type: code,
      proposed_names: details.proposed_names || [],
      nature_of_business: details.nature_of_business || '',
      business_address: details.business_address || '',
      owner_name: details.owner_name || '',
      ...(fullNin ? { nin: details.nin || null } : {}),
      nin_last4: last4(details.nin),
      dob: details.dob || '',
      phone: details.phone || '',
      email: details.email || '',
      residential_address: details.residential_address || '',
      id_type: details.id_type || 'nin',
      id_type_label: ID_TYPES[details.id_type] || ID_TYPES.nin,
      share_capital: details.share_capital ?? null,
      owner_shares: details.owner_shares ?? null,
      // `nin` is taken out by name: the stored member carries the whole number.
      members: (details.members || []).map(({ nin, ...m }) => ({
        ...m,
        ...(fullNin ? { nin: nin || null } : {}),
        nin_last4: last4(nin),
        id_type_label: ID_TYPES[m.id_type] || ID_TYPES.nin,
        role_label: m.role ? LTD_ROLES[m.role] || m.role : null,
      })),
    },
    documents: documentStates({ ...details, registration_type: code }, revealDocuments(row)),
    timeline: status === STATUS.DRAFT ? [] : timeline(row),
    history: events.filter(e => USER_EVENTS[e.event]).map(publicEvent),
  };
}

/** Reference shown to the customer: CAC- and eight unambiguous characters. */
function newReference(randomBytes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `CAC-${out}`;
}

module.exports = {
  STATUS,
  STATUS_LABELS,
  VISIBLE_STATUSES,
  TYPES,
  TYPE_CODES,
  DEFAULT_TYPE,
  MEMBER_SLOTS,
  PERSON_DOCUMENTS,
  PERSON_KEYS,
  UPLOAD_FIELDS,
  TRANSITIONS,
  USER_EDITABLE,
  DELIVERABLES_UPLOADABLE,
  DELIVERABLE_KINDS,
  MAX_DELIVERABLES,
  ID_TYPES,
  DELIVERABLE_ACCEPT,
  DOCUMENT_MAX_BYTES,
  DELIVERABLE_MAX_BYTES,
  DEFAULT_PROCESSING_TIME,
  MIN_PRICE,
  MAX_PRICE,
  MIN_SHARE_CAPITAL,
  MIN_NOTE,
  isType,
  settingKeys,
  maxShareCapital,
  documentSpec,
  requiredDocuments,
  refusal,
  parsePrice,
  cleanProcessingTime,
  validateDetails,
  changedFields,
  validateNote,
  cleanRegistrationNumber,
  sniffType,
  extensionFor,
  checkFile,
  revealDetails,
  protectDetails,
  revealDocuments,
  protectDocuments,
  displayName,
  typeOf,
  timeline,
  publicApplication,
  publicType,
  publicEvent,
  publicDeliverable,
  deliverableLabel,
  sortDeliverables,
  newReference,
  iso,
  safeText,
  USER_EVENTS,
};
