/**
 * CAC Registration - the engine. Business names, limited liability companies
 * and incorporated trustees (NGOs) share it; what differs between them is the
 * form and the price, both defined in helpers/cac.helper.js and the admin's
 * settings. The controllers are HTTP in and out.
 *
 * THE SHAPE OF IT. A customer picks a type, fills the form and uploads the
 * documents it asks for, which makes an unpaid `draft`. Paying turns the draft
 * into an application (`submitted`), and only then can anybody at VoltPay touch
 * it. An admin works it - in progress, perhaps a request for more information,
 * then the documents CAC issued (the certificate, and whatever comes with it:
 * status report, MEMART, TIN, ...) - and the customer downloads them once it is
 * `completed`.
 *
 * WHY A DRAFT AT ALL. A Paystack checkout settles after the request that
 * started it has returned - by webhook, by the app's verify, or by the sweep -
 * so the form has to be on our side before the money moves. The draft is that.
 * It is invisible to admins, and every admin transition is guarded on
 * `payment_status: 'paid'` in the SQL, so an unpaid one cannot be processed.
 *
 * TWO WAYS TO PAY, ONE WAY TO BE PAID.
 *   - Wallet: PIN, then ONE transaction - the guarded claim of the draft, the
 *     SQL-guarded balance reserve, the ledger row, the payment row, the event.
 *     A failure anywhere leaves the wallet untouched and the draft a draft.
 *   - Paystack: a checkout for the type's price at that moment. `settlePaystack`
 *     is the only thing that marks it paid, it always asks Paystack itself, and
 *     its claim is an updateMany guarded on the attempt's own status - so the
 *     webhook, the verify and the sweep can race and only one of them wins.
 *
 * MONEY THAT ARRIVES TWICE GOES BACK. A customer can open a checkout, leave it,
 * pay from the wallet, then finish the old checkout in a tab they left open.
 * That second payment finds the application already paid and is credited to
 * their VoltPay wallet in the same transaction that records it. Nothing is kept
 * that was not owed, and nobody has to notice for it to happen.
 *
 * DOCUMENTS. Uploaded before the row is written, so a storage failure leaves no
 * row pointing at nothing; stored as one protectText() map of links, because an
 * UploadThing URL is a bearer token for a photograph of somebody's ID; served
 * only through authenticated endpoints that stream the file, so the link never
 * reaches a phone or a browser. The issued documents (cac_deliverables) follow
 * the same rule, and the customer's download endpoint refuses until the
 * application is `completed`.
 */
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Prisma } = require('@prisma/client');

const prisma = require('../../database/prisma');
const CAC = require('../helpers/cac.helper');
const { revealUserFields, verifySecret, protectText } = require('../helpers/pii.helper');
const { uploadFile, deleteFileByUrl } = require('../helpers/upload.helper');
const { applyBalanceDelta, restampBalance } = require('../helpers/balance.helper');
const { isFeatureEnabled, setFeature } = require('../helpers/featureFlag.helper');
const paystack = require('../funding/paystack.service');
const { generateTrx } = require('./airtime.service');
const { notifyUser } = require('./notify.service');
const { logUserEvent } = require('./userAudit.service');
const { captureError } = require('./alerts.service');
const email = require('./email.service');

const { STATUS, TYPES, refusal } = CAC;

const FEATURE = 'cac_registration';

const minutes = n => n * 60_000;
const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// A checkout younger than this is not asked about - the customer is probably
// still on the page.
const SETTLE_AFTER_MS = () => envMs('CAC_PAYSTACK_SETTLE_AFTER_MS', minutes(2));
// A pending checkout with no payment after this long is `abandoned`. Not
// failed: Paystack can still complete it, and the sweep keeps asking.
const ABANDON_AFTER_MS = () => envMs('CAC_PAYSTACK_ABANDON_AFTER_MS', minutes(24 * 60));
const ABANDONED_RECHECK_FOR_MS = () => envMs('CAC_PAYSTACK_RECHECK_DAYS', 7) * minutes(24 * 60);
const ABANDONED_RECHECK_EVERY_MS = minutes(6 * 60);
// A second tap within this window gets the checkout it already has.
const CHECKOUT_REUSE_MS = minutes(30);
const FETCH_TIMEOUT_MS = 20_000;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

/* -------------------------------------------------------------- settings */

async function upsertSetting(key, value, description) {
  await prisma.appSetting.upsert({
    where: { setting_key: key },
    update: { setting_value: value },
    create: { setting_key: key, setting_value: value, description },
  });
}

/**
 * The live terms for every type. Read on every call that quotes or charges,
 * never cached: a price an admin just changed must be the price the next
 * customer pays.
 *
 * A type's `price` is null until somebody sets one - in the dashboard, or the
 * type's CAC_PRICE_* env for a deployment that has not opened it yet. There is
 * no price in this code, so an unset price is an unavailable type, not a free
 * one.
 */
async function getSettings() {
  const keys = CAC.TYPE_CODES.flatMap(code => {
    const k = CAC.settingKeys(code);
    return [k.price, k.time, k.enabled];
  });
  const [rows, enabled] = await Promise.all([
    prisma.appSetting
      .findMany({ where: { setting_key: { in: keys } }, select: { setting_key: true, setting_value: true } })
      .catch(() => []),
    isFeatureEnabled(FEATURE),
  ]);
  const value = new Map(rows.map(r => [r.setting_key, r.setting_value]));

  const types = CAC.TYPE_CODES.map(code => {
    const k = CAC.settingKeys(code);
    const price = CAC.parsePrice(value.get(k.price)) ?? CAC.parsePrice(process.env[k.env]);
    const typeEnabled = !OFF_VALUES.has(String(value.get(k.enabled) ?? 'on').trim().toLowerCase());
    return {
      ...CAC.publicType(code),
      price,
      processing_time: CAC.cleanProcessingTime(value.get(k.time)) || CAC.DEFAULT_PROCESSING_TIME,
      enabled: typeEnabled,
      available: Boolean(enabled && typeEnabled && price != null),
    };
  });

  return { currency: 'NGN', enabled, available: types.some(t => t.available), types };
}

/** One type's quote out of the settings. */
function quoteFor(settings, code) {
  return settings.types.find(t => t.code === code) || null;
}

const toBool = v => v === true || ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());

/**
 * Admin. With a `registration_type`: that type's price, processing time and
 * on/off. Without one: `enabled` is the whole service's switch.
 */
async function updateSettings(input = {}) {
  const code = input.registration_type;
  if (code === undefined || code === null || code === '') {
    if (input.price !== undefined || input.processing_time !== undefined) {
      throw refusal(400, 'validation_error', 'Choose which registration type the price is for');
    }
    if (input.enabled !== undefined) await setFeature(FEATURE, toBool(input.enabled));
    return getSettings();
  }
  if (!CAC.isType(code)) throw refusal(400, 'validation_error', 'Unknown registration type');
  const k = CAC.settingKeys(code);
  const label = TYPES[code].label;

  if (input.price !== undefined) {
    const price = CAC.parsePrice(input.price);
    if (price == null) {
      throw refusal(
        400,
        'validation_error',
        `The price must be whole naira between ₦${CAC.MIN_PRICE.toLocaleString()} and ₦${CAC.MAX_PRICE.toLocaleString()}`,
      );
    }
    await upsertSetting(k.price, String(price), `CAC registration price: ${label} (NGN)`);
  }
  if (input.processing_time !== undefined) {
    const text = CAC.cleanProcessingTime(input.processing_time);
    if (!text) throw refusal(400, 'validation_error', 'The processing time must be 3 to 60 characters, e.g. "5-10 working days"');
    await upsertSetting(k.time, text, `CAC processing time shown to customers: ${label}`);
  }
  if (input.enabled !== undefined) {
    await upsertSetting(k.enabled, toBool(input.enabled) ? 'on' : 'off', `CAC registration on sale: ${label}`);
  }
  return getSettings();
}

/** The quote the customer approved must still be the type's price. */
function assertQuote(settings, code, expectedAmount) {
  const quote = quoteFor(settings, code);
  const label = TYPES[code]?.short || 'This registration';
  if (!settings.enabled) {
    throw refusal(503, 'feature_disabled', 'CAC registration is temporarily unavailable. Please try again later.');
  }
  if (!quote || quote.price == null) {
    throw refusal(503, 'price_unavailable', `${label} registration is not available yet. Please check back soon.`);
  }
  if (!quote.enabled) {
    throw refusal(503, 'type_unavailable', `${label} registration is paused for now. Please try again later.`);
  }
  if (expectedAmount !== undefined && expectedAmount !== null && expectedAmount !== '') {
    if (Number(expectedAmount) !== quote.price) {
      throw refusal(
        409,
        'price_changed',
        `The price is now ₦${quote.price.toLocaleString()}. Review it and pay again.`,
        { price: quote.price },
      );
    }
  }
  return quote;
}

/* ------------------------------------------------------------- small parts */

const naira = n => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const decimal = n => new Prisma.Decimal(Number(n).toFixed(2));

function actorOf(admin) {
  if (!admin) return 'admin';
  return `admin:${String(admin.name || admin.id || 'admin').slice(0, 48)}`;
}

function notify(row, key, subject, message) {
  const data = { application_id: row.id, status: row.status };
  return notifyUser({
    userId: row.user_id,
    subject,
    message,
    type: 'cac',
    data,
    // The app routes a tap on `type`, and only `pushData` reaches the device.
    pushData: { ...data, type: 'cac' },
    clientMessageId: key,
  }).catch(() => false);
}

async function event(db, row, name, { from = null, to = null, actor = 'system', note = null, meta = null } = {}) {
  return db.cacApplicationEvent.create({
    data: {
      application_id: row.id,
      event: name,
      from_status: from,
      to_status: to,
      actor,
      note_enc: note ? protectText(note) : null,
      meta,
    },
  });
}

async function ownedApplication(userId, id, db = prisma) {
  const appId = Number(id);
  if (!Number.isInteger(appId) || appId <= 0) throw refusal(404, 'not_found', 'Application not found');
  const row = await db.cacApplication.findFirst({ where: { id: appId, user_id: Number(userId) } });
  // A discarded draft is gone as far as the customer is concerned.
  if (!row || row.status === 'discarded') throw refusal(404, 'not_found', 'Application not found');
  return row;
}

const typeLabelOf = row => (TYPES[CAC.typeOf(row)] || TYPES[CAC.DEFAULT_TYPE]).short;

/* ------------------------------------------------------------- documents */

/** Best effort: a file we could not delete must never fail the request. */
async function discardFiles(urls) {
  await Promise.all(urls.filter(Boolean).map(url => deleteFileByUrl(url).catch(() => false)));
}

const urlsOf = docs => Object.values(docs || {}).map(d => d?.url).filter(Boolean);

/**
 * Check every file the form needs, then upload them. All checked before any
 * goes up, so a bad tenth file does not leave the first nine in storage.
 *
 * `required` is the full list of documents these details call for. On a new
 * form every one must be here; on an update, any one already stored may be
 * left out. A file for a slot the form does not call for is not uploaded.
 *
 * The stored name is ours (`m2_passport.jpg`), never the phone's - a gallery
 * file name is often the person's own name.
 */
async function uploadDocuments(files, userId, { required, stored = {}, requireAll }) {
  const picked = [];
  for (const doc of required) {
    const file = files?.[doc.kind]?.[0];
    if (!file) {
      if (requireAll || !stored[doc.kind]?.url) {
        throw refusal(400, 'validation_error', `Attach ${doc.phrase}`, { field: doc.kind });
      }
      continue;
    }
    const check = CAC.checkFile(file, { accept: doc.accept, maxBytes: CAC.DOCUMENT_MAX_BYTES, phrase: doc.phrase });
    if (!check.ok) throw refusal(400, 'validation_error', check.message, { field: doc.kind });
    picked.push({ kind: doc.kind, file, mime: check.mime });
  }

  const uploaded = {};
  try {
    for (const { kind, file, mime } of picked) {
      const result = await uploadFile(
        { buffer: file.buffer, mimetype: mime, originalname: `${kind}.${CAC.extensionFor(mime)}` },
        { prefix: `cac_${kind}_${userId}` },
      );
      uploaded[kind] = { url: result.url, mime };
    }
  } catch (e) {
    await discardFiles(urlsOf(uploaded));
    console.error('cac.uploadDocuments failed:', { user_id: userId, message: e?.message });
    throw refusal(502, 'upload_failed', 'We could not save your documents. Please try again.');
  }
  return uploaded;
}

/**
 * The map the row should hold after an upload: what was stored, the new files
 * over it, and nothing the form no longer calls for. `dropped` is every link
 * that is no longer referenced - replaced, or belonging to a person or a type
 * that has gone - for deletion once the write has committed.
 */
function mergeDocuments(stored, uploaded, required) {
  const keep = new Set(required.map(d => d.kind));
  const next = {};
  const dropped = [];
  for (const [kind, doc] of Object.entries(stored || {})) {
    if (!keep.has(kind) || uploaded[kind]) dropped.push(doc?.url);
    else next[kind] = doc;
  }
  Object.assign(next, uploaded);
  return { next, dropped: dropped.filter(Boolean) };
}

/**
 * Stream a stored file to the response. The link is decrypted here and goes no
 * further: the caller gets the bytes, never the bearer URL.
 */
async function pipeFile(res, url, { mime, filename, disposition = 'inline' }) {
  if (!url) throw refusal(404, 'not_found', 'File not found');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw refusal(502, 'storage_unavailable', 'The file could not be fetched right now. Please try again.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok || !upstream.body) {
    throw refusal(502, 'storage_unavailable', 'The file could not be fetched right now. Please try again.');
  }

  res.status(200);
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/* ------------------------------------------------------------ the customer */

async function pendingCheckout(applicationId) {
  return prisma.cacPayment.findFirst({
    where: { application_id: applicationId, method: 'paystack', status: 'pending' },
    orderBy: { created_at: 'desc' },
  });
}

function draftView(row, pending) {
  const view = CAC.publicApplication(row, { detail: true });
  view.pending_payment = pending
    ? { reference: pending.reference, amount: Number(pending.amount), created_at: CAC.iso(pending.created_at) }
    : null;
  return view;
}

/**
 * A draft as the review screen needs it: the form, any open checkout, and the
 * live terms for its type. The quote travels with the draft so the screen
 * shows the price the server will charge - and sends it back with the PIN.
 */
async function draftWithQuote(row) {
  const [pending, settings] = await Promise.all([pendingCheckout(row.id), getSettings()]);
  return { ...draftView(row, pending), quote: quoteFor(settings, CAC.typeOf(row)) };
}

/** The service home: every type with its live terms, any draft, the latest applications. */
async function home(userId) {
  const uid = Number(userId);
  const [settings, draft, recent, total, active] = await Promise.all([
    getSettings(),
    prisma.cacApplication.findFirst({
      where: { user_id: uid, status: STATUS.DRAFT },
      orderBy: { updated_at: 'desc' },
    }),
    prisma.cacApplication.findMany({
      where: { user_id: uid, status: { in: CAC.VISIBLE_STATUSES } },
      orderBy: { created_at: 'desc' },
      take: 3,
    }),
    prisma.cacApplication.count({ where: { user_id: uid, status: { in: CAC.VISIBLE_STATUSES } } }),
    prisma.cacApplication.count({
      where: { user_id: uid, status: { in: [STATUS.SUBMITTED, STATUS.IN_PROGRESS, STATUS.NEEDS_MORE_INFO] } },
    }),
  ]);
  return {
    service: settings,
    draft: draft ? draftView(draft, await pendingCheckout(draft.id)) : null,
    recent: recent.map(r => CAC.publicApplication(r)),
    counts: { total, active },
  };
}

async function listForUser(userId, { status = '', page = 1, perPage = 20 } = {}) {
  const uid = Number(userId);
  const where = { user_id: uid, status: { in: CAC.VISIBLE_STATUSES } };
  if (CAC.VISIBLE_STATUSES.includes(status)) where.status = status;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const take = Math.min(50, Math.max(1, parseInt(perPage, 10) || 20));
  const [total, rows] = await Promise.all([
    prisma.cacApplication.count({ where }),
    prisma.cacApplication.findMany({ where, orderBy: { created_at: 'desc' }, skip: (p - 1) * take, take }),
  ]);
  return {
    applications: rows.map(r => CAC.publicApplication(r)),
    page: p,
    per_page: take,
    total,
    has_more: p * take < total,
  };
}

async function detailForUser(userId, id) {
  const row = await ownedApplication(userId, id);
  if (row.status === STATUS.DRAFT) return draftWithQuote(row);
  const [events, deliverables] = await Promise.all([
    prisma.cacApplicationEvent.findMany({ where: { application_id: row.id }, orderBy: { created_at: 'asc' } }),
    // Only a completed application shows what was issued, so only then is it read.
    row.status === STATUS.COMPLETED ? deliverablesOf(row.id) : [],
  ]);
  return CAC.publicApplication(row, { detail: true, events, deliverables });
}

/**
 * POST /cac/applications - the form and its documents.
 *
 * ONE DRAFT PER CUSTOMER, and a second form updates it in place rather than
 * replacing it - including switching its type. In place matters: a checkout
 * opened for the first form is attached to this row, and if the customer
 * finishes it later it must find an application to pay for - not a deleted
 * one, with their money and nowhere to put it.
 */
async function createDraft({ userId, body, files, req }) {
  const uid = Number(userId);
  const check = CAC.validateDetails(body);
  if (!check.ok) throw refusal(400, 'validation_error', check.message, { field: check.field });
  const details = check.details;

  const settings = await getSettings();
  assertQuote(settings, details.registration_type);

  const existing = await prisma.cacApplication.findFirst({
    where: { user_id: uid, status: STATUS.DRAFT, payment_status: 'unpaid' },
    orderBy: { updated_at: 'desc' },
  });

  const required = CAC.requiredDocuments(details);
  const uploaded = await uploadDocuments(files, uid, { required, requireAll: true });
  const stored = existing ? CAC.revealDocuments(existing) : {};
  const { next, dropped } = mergeDocuments(stored, uploaded, required);
  const data = {
    registration_type: details.registration_type,
    details_enc: CAC.protectDetails(details),
    documents_enc: CAC.protectDocuments(next),
  };

  let row;
  try {
    if (existing) {
      row = await prisma.$transaction(async tx => {
        const claimed = await tx.cacApplication.updateMany({
          where: { id: existing.id, status: STATUS.DRAFT, payment_status: 'unpaid' },
          data,
        });
        // Paid between our read and this write - by a checkout that just landed.
        // Their money bought the earlier form; this one is refused, not merged.
        if (!claimed.count) {
          throw refusal(409, 'already_paid', 'Your earlier application was just paid for. Check My Applications.');
        }
        await event(tx, existing, 'draft_updated', {
          from: STATUS.DRAFT,
          to: STATUS.DRAFT,
          actor: 'user',
          meta: { fields: Object.keys(details), documents: Object.keys(uploaded), resubmitted_form: true },
        });
        return tx.cacApplication.findUnique({ where: { id: existing.id } });
      });
      // The earlier form's files, every one replaced or no longer called for.
      await discardFiles(dropped);
    } else {
      row = await createWithReference(uid, data);
      await event(prisma, row, 'created', { to: STATUS.DRAFT, actor: 'user', meta: { registration_type: details.registration_type } });
    }
  } catch (e) {
    await discardFiles(urlsOf(uploaded));
    throw e;
  }

  await logUserEvent({
    req,
    userId: uid,
    event: 'cac.draft_saved',
    metadata: { application_id: row.id, registration_type: details.registration_type },
  }).catch(() => {});
  return draftWithQuote(row);
}

async function createWithReference(userId, data) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.cacApplication.create({
        data: { ...data, user_id: userId, reference: CAC.newReference(crypto.randomBytes) },
      });
    } catch (e) {
      // 32^8 references: a collision is a once-in-a-lifetime event, but a
      // unique index that throws is still not a reason to lose a form.
      if (e?.code !== 'P2002') throw e;
    }
  }
  throw refusal(500, 'error', 'Could not save your application. Please try again.');
}

/**
 * POST /cac/applications/:id/update - edit a draft before paying, or answer a
 * request for more information. The second sends it back to the queue as
 * `submitted`: it needs an admin's eyes again, which is what that status means.
 *
 * A draft may change its type - it has not been paid for. A paid application
 * may not: it was bought as one thing, and the price was that thing's.
 */
async function updateApplication({ userId, id, body, files, req }) {
  const uid = Number(userId);
  const row = await ownedApplication(uid, id);
  if (!CAC.USER_EDITABLE.includes(row.status)) {
    throw refusal(409, 'not_editable', 'This application can no longer be changed.');
  }

  const before = CAC.revealDetails(row);
  const currentType = CAC.typeOf(row, before);
  const responding = row.status === STATUS.NEEDS_MORE_INFO;
  if (responding && body?.registration_type && body.registration_type !== currentType) {
    throw refusal(400, 'type_locked', 'The registration type cannot be changed after payment.');
  }

  const check = CAC.validateDetails(body, { ...before, registration_type: currentType });
  if (!check.ok) throw refusal(400, 'validation_error', check.message, { field: check.field });
  const details = check.details;
  if (!responding && details.registration_type !== currentType) {
    // Switching a draft's type: the new type has to be on sale.
    assertQuote(await getSettings(), details.registration_type);
  }
  const changed = CAC.changedFields(before, details);

  const required = CAC.requiredDocuments(details);
  const hasFiles = required.some(doc => files?.[doc.kind]?.[0]);
  // Sending it back unchanged would put it in the queue to be asked the same
  // question again.
  if (responding && !changed.length && !hasFiles) {
    throw refusal(400, 'nothing_changed', 'Update the details or documents we asked about, then send it back.');
  }

  const stored = CAC.revealDocuments(row);
  const uploaded = await uploadDocuments(files, uid, { required, stored, requireAll: false });
  const { next, dropped } = mergeDocuments(stored, uploaded, required);
  const now = new Date();
  const data = {
    registration_type: details.registration_type,
    details_enc: CAC.protectDetails(details),
    documents_enc: CAC.protectDocuments(next),
  };
  if (responding) {
    Object.assign(data, {
      status: STATUS.SUBMITTED,
      submitted_at: now,
      info_provided_at: now,
      admin_note_enc: null,
      resubmissions: { increment: 1 },
    });
  }

  try {
    await prisma.$transaction(async tx => {
      // Guarded on the row we read. An admin acting in between - a rejection,
      // say - wins, and this edit is refused rather than undoing their decision.
      const claimed = await tx.cacApplication.updateMany({
        where: { id: row.id, user_id: uid, status: row.status, updated_at: row.updated_at },
        data,
      });
      if (!claimed.count) {
        throw refusal(409, 'stale', 'Your application changed while you were editing it. Reload it and try again.');
      }
      await event(tx, row, responding ? 'info_provided' : 'draft_updated', {
        from: row.status,
        to: responding ? STATUS.SUBMITTED : row.status,
        actor: 'user',
        meta: { fields: changed, documents: Object.keys(uploaded) },
      });
    });
  } catch (e) {
    await discardFiles(urlsOf(uploaded));
    throw e;
  }
  // The files this replaced or no longer needs, now that nothing points at them.
  await discardFiles(dropped);

  if (responding) {
    await logUserEvent({
      req,
      userId: uid,
      event: 'cac.info_provided',
      metadata: { application_id: row.id, fields: changed, documents: Object.keys(uploaded) },
    }).catch(() => {});
  }
  return detailForUser(uid, row.id);
}

/**
 * Wipe a draft's form and files and leave a tombstone. Not a delete: a late
 * checkout for it must still find the row, see it is not payable, and hand the
 * money back - a deleted row would leave that payment with nowhere to go.
 */
async function retireDraft(row, reason, actor = 'system') {
  const wiped = await prisma.cacApplication.updateMany({
    where: { id: row.id, status: STATUS.DRAFT, payment_status: 'unpaid' },
    data: { status: 'discarded', details_enc: CAC.protectDetails({}), documents_enc: null },
  });
  if (!wiped.count) return false;
  await event(prisma, row, 'discarded', { from: STATUS.DRAFT, to: 'discarded', actor, meta: { reason } });
  await discardFiles(urlsOf(CAC.revealDocuments(row)));
  return true;
}

/** DELETE /cac/applications/:id - the customer drops an unpaid draft. */
async function discardDraft({ userId, id }) {
  const row = await ownedApplication(userId, id);
  if (row.status !== STATUS.DRAFT || row.payment_status !== 'unpaid') {
    throw refusal(409, 'not_a_draft', 'Only an unpaid application can be discarded.');
  }
  // An open checkout is settled first: if it was paid, this is an application
  // now and not the customer's to discard. If it completes AFTER the discard,
  // the tombstone makes settlePaystack hand the money back to the wallet - the
  // right outcome for somebody who asked to drop the application.
  const pending = await pendingCheckout(row.id);
  if (pending) {
    const settled = await settlePaystack(pending.reference, { source: 'discard' }).catch(() => null);
    if (settled?.paid) throw refusal(409, 'already_paid', 'This application was just paid for. Check My Applications.');
  }
  if (!(await retireDraft(row, 'customer', 'user'))) {
    throw refusal(409, 'already_paid', 'This application was just paid for. Check My Applications.');
  }
  return { discarded: true };
}

/* ----------------------------------------------------------- paying: wallet */

/**
 * POST /cac/applications/:id/pay/wallet   { pin, expected_amount }
 *
 * One transaction. The draft is claimed first, then the balance is reserved in
 * the SQL (`balance >= price`), and either refusal rolls the other back - there
 * is no state in which the wallet was debited and the application not paid, or
 * the application paid and the wallet not debited.
 */
async function payWithWallet({ userId, id, pin, expectedAmount, req }) {
  const uid = Number(userId);
  const row = await ownedApplication(uid, id);
  if (row.payment_status === 'paid') return { row, alreadyPaid: true };
  if (row.status !== STATUS.DRAFT) throw refusal(409, 'not_payable', 'This application cannot be paid for.');

  const settings = await getSettings();
  const quote = assertQuote(settings, CAC.typeOf(row), expectedAmount);

  const code = String(pin ?? '').trim();
  if (!code) throw refusal(400, 'validation_error', 'Enter your PIN to pay');
  // Against a FRESH row: req.user may be a cached copy, and a PIN is never
  // checked against one.
  const fresh = await prisma.user.findUnique({ where: { id: uid } });
  if (!fresh) throw refusal(401, 'unauthorized', 'Please login again');
  if (!(await verifySecret(code, fresh.pin, 'pin')).ok) throw refusal(401, 'invalid_pin', 'Incorrect PIN');

  // An open checkout may already have been paid. Ask before charging, so the
  // ordinary case is never a duplicate payment that has to be handed back.
  const pending = await pendingCheckout(row.id);
  if (pending) {
    const settled = await settlePaystack(pending.reference, { source: 'wallet_precheck' }).catch(() => null);
    if (settled?.paid) return { row: await ownedApplication(uid, row.id), alreadyPaid: true };
  }

  const price = quote.price;
  const amount = decimal(price);
  const zero = decimal(0);
  const trx = generateTrx('cac');
  const now = new Date();

  await prisma.$transaction(async tx => {
    const claimed = await tx.cacApplication.updateMany({
      where: { id: row.id, user_id: uid, status: STATUS.DRAFT, payment_status: 'unpaid' },
      data: {
        status: STATUS.SUBMITTED,
        payment_status: 'paid',
        payment_method: 'wallet',
        payment_reference: trx,
        amount_paid: amount,
        paid_at: now,
        submitted_at: now,
      },
    });
    if (!claimed.count) throw refusal(409, 'already_paid', 'This application has already been paid for.');

    // The guard is in the SQL, so two payments racing cannot both pass a
    // balance read that was true for each of them alone.
    const reserved = await tx.user.updateMany({
      where: { id: uid, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (!reserved.count) {
      throw refusal(400, 'insufficient_balance', `Your wallet balance is below ${naira(price)}. Fund your wallet or pay with card or bank.`, {
        price,
      });
    }
    await restampBalance(tx, 'user', uid);

    await tx.cacPayment.create({
      data: {
        application_id: row.id,
        user_id: uid,
        method: 'wallet',
        reference: trx,
        amount,
        amount_received: amount,
        status: 'success',
        paid_at: now,
      },
    });

    const details = `CAC ${typeLabelOf(row).toLowerCase()} registration ${row.reference}`;
    await tx.walletTransaction.create({
      data: {
        user_id: uid,
        trx,
        trx_type: '-',
        amount,
        charge: zero,
        total_amount: amount,
        remark: 'cac_registration',
        details: protectText(details),
        other_data: {
          title: 'CAC Registration',
          subtitle: protectText(details),
          feedback: 'Successful',
          note: 'Wallet',
          image_src: '',
        },
        // Ids and our own references only. The business name is the customer's
        // and `meta` is not encrypted.
        meta: { source: 'wallet', application_id: row.id, reference: row.reference, registration_type: CAC.typeOf(row) },
      },
    });

    await event(tx, row, 'paid', {
      from: STATUS.DRAFT,
      to: STATUS.SUBMITTED,
      actor: 'user',
      meta: { method: 'wallet', amount: price, reference: trx },
    });
  });

  const paid = await prisma.cacApplication.findUnique({ where: { id: row.id } });
  await logUserEvent({
    req,
    userId: uid,
    event: 'cac.paid',
    metadata: { application_id: row.id, trx, amount: price, method: 'wallet', registration_type: CAC.typeOf(row) },
  }).catch(() => {});
  await notifyPaid(paid, quote);
  return { row: paid, alreadyPaid: false, trx };
}

/* --------------------------------------------------------- paying: Paystack */

function callbackUrl(req) {
  const configured = String(process.env.CAC_PAYSTACK_CALLBACK_URL || '').trim();
  if (configured) return configured;
  const base = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
  const prefix = process.env.API_PREFIX || '/api';
  if (base) return `${base}${prefix}/cac/paystack/callback`;
  if (!req) return undefined;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get?.('host');
  return host ? `${proto}://${host}${prefix}/cac/paystack/callback` : undefined;
}

/**
 * POST /cac/applications/:id/paystack   { expected_amount }
 *
 * Opens a checkout for the type's price right now. Moves no money: the
 * customer pays on Paystack's page, and settlePaystack() is what records it.
 */
async function initializePaystack({ userId, id, expectedAmount, req }) {
  const uid = Number(userId);
  const row = await ownedApplication(uid, id);
  if (row.payment_status === 'paid') throw refusal(409, 'already_paid', 'This application has already been paid for.');
  if (row.status !== STATUS.DRAFT) throw refusal(409, 'not_payable', 'This application cannot be paid for.');

  const settings = await getSettings();
  const quote = assertQuote(settings, CAC.typeOf(row), expectedAmount);
  const amount = decimal(quote.price);

  // A second tap gets the checkout it already has, so one application does not
  // collect a drawer of open checkouts that could each be paid.
  const recent = await prisma.cacPayment.findFirst({
    where: {
      application_id: row.id,
      method: 'paystack',
      status: 'pending',
      amount,
      created_at: { gt: new Date(Date.now() - CHECKOUT_REUSE_MS) },
    },
    orderBy: { created_at: 'desc' },
  });
  if (recent?.authorization_url) {
    return { reference: recent.reference, authorization_url: recent.authorization_url, amount: quote.price };
  }

  const user = await prisma.user.findUnique({ where: { id: uid } });
  const details = CAC.revealDetails(row);
  const payer = String(revealUserFields(user || {}).email || details.email || '').trim() || `user${uid}@voltpay.local`;

  const reference = `CACPAY-${row.id}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const payment = await prisma.cacPayment.create({
    data: { application_id: row.id, user_id: uid, method: 'paystack', reference, amount, status: 'pending' },
  });

  let checkout;
  try {
    checkout = await paystack.initializeTransaction({
      email: payer,
      amountKobo: quote.price * 100,
      reference,
      callback_url: callbackUrl(req),
      metadata: { purpose: 'cac_registration', application_id: row.id, user_id: uid, registration_type: CAC.typeOf(row) },
    });
  } catch (e) {
    // The customer never got a link, so nothing can be paid on this attempt.
    await prisma.cacPayment
      .update({ where: { id: payment.id }, data: { status: 'failed', failure_reason: 'initialize_failed' } })
      .catch(() => null);
    console.error('cac.initializePaystack failed:', { application_id: row.id, message: e?.message });
    throw refusal(
      503,
      'paystack_unavailable',
      'Card and bank payments are briefly unavailable. Pay from your wallet, or try again shortly.',
    );
  }

  await prisma.cacPayment.update({ where: { id: payment.id }, data: { authorization_url: checkout.authorization_url } });
  return { reference, authorization_url: checkout.authorization_url, amount: quote.price };
}

/** Paystack's own record, or null when Paystack has never heard of it. */
async function paystackRecord(reference) {
  try {
    const { data } = await paystack.verifyTransaction(reference);
    return data || null;
  } catch (e) {
    const status = Number(e?.statusCode || 0);
    // A 4xx is an answer: "no such transaction". Anything else is an outage,
    // and an outage is never read as "not paid".
    if (status === 400 || status === 404) return null;
    throw e;
  }
}

/**
 * Credit a payment that bought nothing back to the customer's wallet, inside
 * the caller's transaction. Used when money arrives for an application that is
 * already paid (or was discarded), and when it arrives short.
 */
async function handBack(tx, payment, amountNaira, reason) {
  const amount = decimal(amountNaira);
  const trx = generateTrx('cacref');
  await applyBalanceDelta(tx, 'user', payment.user_id, amount);
  const details = 'CAC registration payment returned';
  await tx.walletTransaction.create({
    data: {
      user_id: payment.user_id,
      trx,
      trx_type: '+',
      amount,
      charge: decimal(0),
      total_amount: amount,
      remark: 'cac_refund',
      details: protectText(details),
      other_data: {
        title: 'CAC Registration refund',
        subtitle: protectText(details),
        feedback: 'Successful',
        note: reason === 'duplicate' ? 'Duplicate payment' : 'Payment returned',
        image_src: '',
      },
      meta: {
        source: 'cac',
        application_id: payment.application_id,
        payment_reference: payment.reference,
        reason,
      },
    },
  });
  await tx.cacPayment.update({
    where: { id: payment.id },
    data: { status: 'refunded_to_wallet', refund_trx: trx, failure_reason: reason },
  });
  return trx;
}

/**
 * Settle one Paystack attempt from Paystack's own record. The webhook, the
 * app's verify and the sweep all come through here, and none of them is
 * believed on its own say-so: the outcome is always read back from Paystack.
 *
 * Returns { found, paid, state, duplicate }. Throws only for an outage.
 */
async function settlePaystack(reference, { source = 'verify' } = {}) {
  const ref = String(reference || '').trim();
  if (!ref || !prisma.cacPayment) return { found: false, paid: false, state: 'unknown' };
  const payment = await prisma.cacPayment.findUnique({ where: { reference: ref } });
  if (!payment || payment.method !== 'paystack') return { found: false, paid: false, state: 'unknown' };
  if (payment.status === 'success') return { found: true, paid: true, state: 'success' };
  if (payment.status === 'refunded_to_wallet') return { found: true, paid: false, state: 'refunded', duplicate: true };

  const record = await paystackRecord(ref);
  const providerStatus = String(record?.status || 'not_found').toLowerCase();
  await prisma.cacPayment
    .update({ where: { id: payment.id }, data: { provider_status: providerStatus, checked_at: new Date() } })
    .catch(() => null);
  if (providerStatus !== 'success') return { found: true, paid: false, state: providerStatus };

  const receivedKobo = Number(record.amount || 0);
  const expectedKobo = Math.round(Number(payment.amount) * 100);
  const currencyOk = String(record.currency || 'NGN').toUpperCase() === 'NGN';
  const paidAt = record.paid_at ? new Date(record.paid_at) : new Date();

  const outcome = await prisma.$transaction(async tx => {
    // The claim: only one of webhook, verify and sweep gets past this.
    const won = await tx.cacPayment.updateMany({
      where: { id: payment.id, status: { in: ['pending', 'abandoned', 'failed'] } },
      data: {
        status: 'success',
        provider_status: 'success',
        amount_received: decimal(receivedKobo / 100),
        paid_at: paidAt,
      },
    });
    if (!won.count) return { already: true };

    const application = await tx.cacApplication.findUnique({ where: { id: payment.application_id } });

    if (!currencyOk || receivedKobo < expectedKobo) {
      // Paystack fixes the amount at initialize, so this should not happen.
      // If it ever does, what did arrive is the customer's - back it goes.
      if (currencyOk && receivedKobo > 0) await handBack(tx, payment, receivedKobo / 100, 'short_payment');
      else await tx.cacPayment.update({ where: { id: payment.id }, data: { status: 'failed', failure_reason: 'amount_mismatch' } });
      return { mismatch: true, application };
    }

    const claimed = await tx.cacApplication.updateMany({
      where: { id: payment.application_id, status: STATUS.DRAFT, payment_status: 'unpaid' },
      data: {
        status: STATUS.SUBMITTED,
        payment_status: 'paid',
        payment_method: 'paystack',
        payment_reference: ref,
        amount_paid: payment.amount,
        paid_at: paidAt,
        submitted_at: paidAt,
      },
    });
    if (!claimed.count) {
      // Paid already - from the wallet, or a second checkout - or discarded.
      // This money bought nothing, so it goes straight back.
      const trx = await handBack(tx, payment, Number(payment.amount), 'duplicate');
      if (application) {
        await event(tx, application, 'duplicate_payment_refunded', {
          actor: 'system',
          meta: { reference: ref, amount: Number(payment.amount), trx },
        });
      }
      return { duplicate: true, application };
    }

    await event(tx, application, 'paid', {
      from: STATUS.DRAFT,
      to: STATUS.SUBMITTED,
      actor: source === 'webhook' ? 'system' : 'user',
      meta: { method: 'paystack', amount: Number(payment.amount), reference: ref, via: source },
    });
    return { paid: true };
  });

  if (outcome.already) {
    const fresh = await prisma.cacPayment.findUnique({ where: { id: payment.id } });
    return { found: true, paid: fresh?.status === 'success', state: fresh?.status || 'success' };
  }
  if (outcome.mismatch) {
    captureError('cac.paystack_amount_mismatch', new Error('Paystack amount below the price'), {
      payment_id: payment.id,
      received_kobo: receivedKobo,
      expected_kobo: expectedKobo,
    });
    return { found: true, paid: false, state: 'amount_mismatch' };
  }
  if (outcome.duplicate) {
    const app = outcome.application;
    if (app) {
      await notify(
        app,
        `cac:${app.id}:dup:${payment.id}`,
        'Payment returned to your wallet',
        `Your application ${app.reference} was already paid for, so the extra ${naira(payment.amount)} card payment has been credited to your VoltPay wallet.`,
      );
    }
    return { found: true, paid: false, state: 'refunded', duplicate: true };
  }

  const paid = await prisma.cacApplication.findUnique({ where: { id: payment.application_id } });
  await logUserEvent({
    userId: payment.user_id,
    event: 'cac.paid',
    metadata: { application_id: payment.application_id, reference: ref, amount: Number(payment.amount), method: 'paystack' },
  }).catch(() => {});
  const settings = await getSettings().catch(() => null);
  await notifyPaid(paid, settings ? quoteFor(settings, CAC.typeOf(paid)) : null);
  return { found: true, paid: true, state: 'success' };
}

/** POST /cac/applications/:id/paystack/verify  { reference } - the app's return from checkout. */
async function verifyPaystack({ userId, id, reference }) {
  const row = await ownedApplication(userId, id);
  const ref = String(reference || '').trim();
  const payment = ref ? await prisma.cacPayment.findUnique({ where: { reference: ref } }) : null;
  if (!payment || payment.application_id !== row.id || payment.user_id !== Number(userId)) {
    throw refusal(404, 'not_found', 'Payment not found');
  }
  let result;
  try {
    result = await settlePaystack(ref, { source: 'verify' });
  } catch (e) {
    throw refusal(
      503,
      'verify_unavailable',
      'We could not confirm your payment yet. If you paid, it will show here automatically within a few minutes.',
    );
  }
  return { result, application: await detailForUser(userId, row.id) };
}

async function notifyPaid(row, quote) {
  if (!row) return;
  await notify(
    row,
    `cac:${row.id}:paid`,
    'CAC application submitted',
    `Payment received - your ${typeLabelOf(row).toLowerCase()} application ${row.reference} is in the queue. ` +
      `Registration usually takes ${quote?.processing_time || CAC.DEFAULT_PROCESSING_TIME}.`,
  );
}

/* --------------------------------------------------------------- the admin */

const ADMIN_EVENT_LABELS = {
  created: 'Draft created',
  draft_updated: 'Draft edited by the customer',
  paid: 'Paid',
  started: 'Marked in progress',
  info_requested: 'More information requested',
  info_provided: 'Customer updated the application',
  // Written before an application could hold several documents.
  certificate_uploaded: 'Certificate uploaded',
  deliverable_uploaded: 'Document uploaded for the customer',
  deliverable_removed: 'Document removed',
  completed: 'Marked completed',
  rejected: 'Rejected',
  refunded: 'Refunded to wallet',
  duplicate_payment_refunded: 'Duplicate payment refunded to wallet',
  discarded: 'Draft discarded',
  note: 'Internal note',
};

function minutesSince(date, now = Date.now()) {
  if (!date) return null;
  return Math.max(0, Math.floor((now - new Date(date).getTime()) / 60_000));
}

function adminListItem(row) {
  const details = CAC.revealDetails(row);
  const code = CAC.typeOf(row, details);
  // How long it has been waiting on us, from the moment it last landed in the queue.
  const waitingSince = row.status === STATUS.SUBMITTED ? row.submitted_at || row.paid_at : null;
  return {
    id: row.id,
    reference: row.reference,
    user_id: row.user_id,
    registration_type: code,
    registration_type_label: TYPES[code].short,
    status: row.status,
    status_label: CAC.STATUS_LABELS[row.status] || row.status,
    business_name: CAC.displayName(row, details),
    owner_name: details.owner_name || '',
    amount_paid: row.amount_paid != null ? Number(row.amount_paid) : null,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    resubmitted: Number(row.resubmissions || 0) > 0,
    paid_at: CAC.iso(row.paid_at),
    updated_at: CAC.iso(row.updated_at),
    waiting_minutes: minutesSince(waitingSince),
  };
}

/** GET /admin/cac/applications - paid applications only. Drafts are not work. */
async function adminList({ status = '', type = '', q = '', page = 1, perPage = 25 } = {}) {
  const where = { status: { in: CAC.VISIBLE_STATUSES } };
  if (CAC.VISIBLE_STATUSES.includes(status)) where.status = status;
  if (CAC.isType(type)) where.registration_type = type;
  const ref = String(q || '').trim().toUpperCase().replace(/\s+/g, '');
  if (ref) where.reference = { startsWith: ref.startsWith('CAC-') ? ref : `CAC-${ref}` };

  // The work queue is first come, first served; the archive is newest first.
  const queue = [STATUS.SUBMITTED, STATUS.IN_PROGRESS, STATUS.NEEDS_MORE_INFO].includes(status);
  const orderBy = queue ? [{ submitted_at: 'asc' }, { id: 'asc' }] : [{ paid_at: 'desc' }, { id: 'desc' }];
  const p = Math.max(1, parseInt(page, 10) || 1);
  const take = Math.min(100, Math.max(1, parseInt(perPage, 10) || 25));
  const countWhere = { status: { in: CAC.VISIBLE_STATUSES }, ...(CAC.isType(type) ? { registration_type: type } : {}) };

  const [total, rows, grouped, oldest, revenue] = await Promise.all([
    prisma.cacApplication.count({ where }),
    prisma.cacApplication.findMany({ where, orderBy, skip: (p - 1) * take, take }),
    prisma.cacApplication.groupBy({ by: ['status'], where: countWhere, _count: { _all: true } }),
    prisma.cacApplication.findFirst({
      where: { ...countWhere, status: STATUS.SUBMITTED },
      orderBy: { submitted_at: 'asc' },
      select: { submitted_at: true },
    }),
    prisma.cacApplication.aggregate({ where: { ...countWhere, payment_status: 'paid' }, _sum: { amount_paid: true } }),
  ]);

  const counts = Object.fromEntries(CAC.VISIBLE_STATUSES.map(s => [s, 0]));
  for (const g of grouped) counts[g.status] = g._count?._all ?? 0;

  return {
    items: rows.map(adminListItem),
    counts,
    stats: {
      waiting: counts.submitted,
      oldest_waiting_minutes: minutesSince(oldest?.submitted_at),
      collected: Number(revenue?._sum?.amount_paid || 0),
    },
    types: CAC.TYPE_CODES.map(code => ({ code, label: TYPES[code].short })),
    pagination: { page: p, perPage: take, total, totalPages: Math.max(1, Math.ceil(total / take)) },
  };
}

function adminActions(row, deliverables = []) {
  const paid = row.payment_status === 'paid';
  const can = action => paid && CAC.TRANSITIONS[action].from.includes(row.status);
  const hasCertificate = deliverables.some(d => d.kind === 'certificate');
  return {
    start: can('start'),
    // Not capped at MAX_DELIVERABLES: replacing the certificate is a swap, and
    // must stay possible on a full application. The service refuses the rest.
    upload_documents: paid && CAC.DELIVERABLES_UPLOADABLE.includes(row.status),
    request_info: can('request_info'),
    complete: can('complete') && hasCertificate,
    reject: can('reject'),
    refund: row.status === STATUS.REJECTED && paid && !row.refunded_at,
  };
}

async function deliverablesOf(applicationId, db = prisma) {
  return db.cacDeliverable.findMany({ where: { application_id: applicationId }, orderBy: { created_at: 'asc' } });
}

async function findForAdmin(id) {
  const appId = Number(id);
  const row = Number.isInteger(appId) && appId > 0 ? await prisma.cacApplication.findUnique({ where: { id: appId } }) : null;
  if (!row || row.status === STATUS.DRAFT || row.status === 'discarded') {
    throw refusal(404, 'not_found', 'Application not found');
  }
  return row;
}

/** GET /admin/cac/applications/:id - everything a reviewer needs on one screen. */
async function adminDetail(id) {
  const row = await findForAdmin(id);
  const [events, payments, user, deliverables] = await Promise.all([
    prisma.cacApplicationEvent.findMany({ where: { application_id: row.id }, orderBy: { created_at: 'asc' } }),
    prisma.cacPayment.findMany({ where: { application_id: row.id }, orderBy: { created_at: 'asc' } }),
    prisma.user.findUnique({ where: { id: row.user_id } }),
    deliverablesOf(row.id),
  ]);
  // The whole NIN: the admin types it into CAC's portal. This read is logged as
  // a disclosure by the controller.
  const base = CAC.publicApplication(row, { detail: true, events, deliverables, fullNin: true });
  const pii = revealUserFields(user || {});
  // A path on the admin API, streamed through it. Never the link itself.
  const docPath = kind => `cac/applications/${row.id}/documents/${kind}`;
  const certificateLocked = row.status === STATUS.COMPLETED;

  return {
    application: {
      ...base,
      user_id: row.user_id,
      user_name: [pii.firstname, pii.lastname].filter(Boolean).join(' ') || pii.username || `User #${row.user_id}`,
      registered_name: CAC.safeText(row.registered_name_enc) || null,
      registration_number: CAC.safeText(row.registration_number_enc) || null,
      admin_note: CAC.safeText(row.admin_note_enc) || null,
      resubmissions: row.resubmissions,
      started_at: CAC.iso(row.started_at),
      info_requested_at: CAC.iso(row.info_requested_at),
      info_provided_at: CAC.iso(row.info_provided_at),
      refunded_at: CAC.iso(row.refunded_at),
      refund_trx: row.refund_trx || null,
      documents: base.documents.map(doc => ({ ...doc, path: doc.uploaded ? docPath(doc.kind) : null })),
      // Everything issued so far, whatever the status - the customer's own
      // list (`base.deliverables`) stays empty until completion.
      deliverables: CAC.sortDeliverables(deliverables).map(d => ({
        ...CAC.publicDeliverable(row, d),
        uploaded_by: d.uploaded_by || null,
        path: `cac/applications/${row.id}/deliverables/${d.id}`,
        // A completed application's certificate can be replaced, never removed.
        removable: !(d.kind === 'certificate' && certificateLocked),
      })),
      max_deliverables: CAC.MAX_DELIVERABLES,
    },
    events: events.map(e => ({
      id: e.id,
      event: e.event,
      title: ADMIN_EVENT_LABELS[e.event] || e.event,
      from_status: e.from_status,
      to_status: e.to_status,
      actor: e.actor,
      note: CAC.safeText(e.note_enc) || null,
      meta: e.meta || null,
      created_at: CAC.iso(e.created_at),
    })),
    payments: payments.map(p => ({
      id: p.id,
      method: p.method,
      reference: p.reference,
      amount: Number(p.amount),
      amount_received: p.amount_received != null ? Number(p.amount_received) : null,
      status: p.status,
      provider_status: p.provider_status,
      failure_reason: p.failure_reason,
      refund_trx: p.refund_trx,
      paid_at: CAC.iso(p.paid_at),
      created_at: CAC.iso(p.created_at),
    })),
    actions: adminActions(row, deliverables),
  };
}

/** Stream one of the customer's own documents to an admin. */
async function adminDocument(res, id, kind) {
  const row = await findForAdmin(id);
  if (!CAC.documentSpec(kind)) throw refusal(404, 'not_found', 'Unknown document');
  const doc = CAC.revealDocuments(row)[kind];
  if (!doc?.url) throw refusal(404, 'not_found', 'This document was not uploaded');
  await pipeFile(res, doc.url, {
    mime: doc.mime,
    filename: `${row.reference}-${kind}.${CAC.extensionFor(doc.mime)}`,
    disposition: 'inline',
  });
  return row;
}

/** One deliverable of one application, or a 404 - never another's. */
async function findDeliverable(applicationId, docId) {
  const did = Number(docId);
  const d = Number.isInteger(did) && did > 0 ? await prisma.cacDeliverable.findUnique({ where: { id: did } }) : null;
  if (!d || d.application_id !== applicationId) throw refusal(404, 'not_found', 'Document not found');
  return d;
}

/** Stream an issued document to an admin, whatever the status. */
async function adminDeliverable(res, id, docId) {
  const row = await findForAdmin(id);
  const d = await findDeliverable(row.id, docId);
  await pipeFile(res, CAC.safeText(d.url_enc), {
    mime: d.mime,
    filename: CAC.publicDeliverable(row, d).file_name,
    disposition: 'inline',
  });
  return { row, deliverable: d };
}

/**
 * Refund the price to the customer's wallet, inside the caller's transaction.
 * Guarded on `refunded_at: null`, so a double click refunds once.
 */
async function refundInTx(tx, row, actor) {
  const amount = decimal(row.amount_paid || 0);
  if (!(Number(row.amount_paid) > 0)) throw refusal(409, 'nothing_to_refund', 'There is no payment on this application to refund.');
  const trx = generateTrx('cacref');
  const now = new Date();
  const claimed = await tx.cacApplication.updateMany({
    where: { id: row.id, status: STATUS.REJECTED, payment_status: 'paid', refunded_at: null },
    data: { payment_status: 'refunded', refunded_at: now, refund_trx: trx },
  });
  if (!claimed.count) throw refusal(409, 'already_refunded', 'This application has already been refunded.');

  await applyBalanceDelta(tx, 'user', row.user_id, amount);
  const details = `CAC registration refund ${row.reference}`;
  await tx.walletTransaction.create({
    data: {
      user_id: row.user_id,
      trx,
      trx_type: '+',
      amount,
      charge: decimal(0),
      total_amount: amount,
      remark: 'cac_refund',
      details: protectText(details),
      other_data: {
        title: 'CAC Registration refund',
        subtitle: protectText(details),
        feedback: 'Successful',
        note: 'Refund',
        image_src: '',
      },
      meta: { source: 'cac', application_id: row.id, reference: row.reference, reversal_of: row.payment_reference || null },
    },
  });
  await event(tx, row, 'refunded', { actor, meta: { amount: Number(row.amount_paid), trx } });
  return trx;
}

/**
 * One admin decision: start | request_info | complete | reject.
 *
 * Guarded on the status that was read AND on payment_status 'paid', so two
 * admins cannot both act on one application, and an unpaid one cannot be acted
 * on at all. `refund` applies to reject only; the controller checks the role.
 */
async function adminTransition({ id, action, note, refund = false, admin }) {
  const t = CAC.TRANSITIONS[action];
  if (!t) throw refusal(400, 'validation_error', 'Unknown action');
  const row = await findForAdmin(id);
  if (row.payment_status !== 'paid') {
    throw refusal(409, 'unpaid', 'This application is not paid for, so it cannot be processed.');
  }
  if (!t.from.includes(row.status)) {
    throw refusal(
      409,
      'invalid_transition',
      `This application is ${CAC.STATUS_LABELS[row.status] || row.status}, so that action is not available.`,
    );
  }

  let text = null;
  if (action === 'request_info' || action === 'reject') {
    const check = CAC.validateNote(note, { label: action === 'reject' ? 'reason' : 'request' });
    if (!check.ok) throw refusal(400, 'validation_error', check.message);
    text = check.note;
  }
  const noCertificate = () =>
    refusal(409, 'certificate_required', 'Upload the CAC certificate before marking this completed.');
  if (action === 'complete' && !(await prisma.cacDeliverable.count({ where: { application_id: row.id, kind: 'certificate' } }))) {
    throw noCertificate();
  }

  const actor = actorOf(admin);
  const now = new Date();
  const data = { status: t.to, [t.stamp]: now };
  if (text) data.admin_note_enc = protectText(text);
  else if (action === 'start' || action === 'complete') data.admin_note_enc = null;

  let refundTrx = null;
  await prisma.$transaction(async tx => {
    const claimed = await tx.cacApplication.updateMany({
      where: { id: row.id, status: row.status, payment_status: 'paid' },
      data,
    });
    if (!claimed.count) {
      throw refusal(409, 'stale', 'This application changed while you were looking at it. Refresh and try again.');
    }
    // Counted again under the row lock the claim just took: a certificate
    // removed by another admin a moment ago must not let this complete.
    if (action === 'complete' && !(await tx.cacDeliverable.count({ where: { application_id: row.id, kind: 'certificate' } }))) {
      throw noCertificate();
    }
    await event(tx, row, t.event, { from: row.status, to: t.to, actor, note: text });
    // Same transaction: a rejection that promised a refund never lands without it.
    if (action === 'reject' && refund) refundTrx = await refundInTx(tx, { ...row, status: STATUS.REJECTED }, actor);
  });

  const updated = await prisma.cacApplication.findUnique({ where: { id: row.id } });
  await afterTransition(updated, action, { note: text, refunded: Boolean(refundTrx) });
  return { application: updated, refund_trx: refundTrx };
}

/** POST /admin/cac/applications/:id/refund - for a rejection that was not refunded at the time. */
async function adminRefund({ id, admin }) {
  const row = await findForAdmin(id);
  if (row.status !== STATUS.REJECTED) throw refusal(409, 'not_rejected', 'Only a rejected application can be refunded.');
  if (row.payment_status !== 'paid' || row.refunded_at) {
    throw refusal(409, 'already_refunded', 'This application has already been refunded.');
  }
  const actor = actorOf(admin);
  let trx = null;
  await prisma.$transaction(async tx => {
    trx = await refundInTx(tx, row, actor);
  });
  const updated = await prisma.cacApplication.findUnique({ where: { id: row.id } });
  await notify(
    updated,
    `cac:${row.id}:refunded`,
    'CAC registration refunded',
    `${naira(row.amount_paid)} for application ${row.reference} has been refunded to your VoltPay wallet.`,
  );
  return { application: updated, refund_trx: trx };
}

/**
 * POST /admin/cac/applications/:id/deliverables (multipart `file` + kind, label)
 *
 * One document CAC issued, handed on to the customer. An admin uploads them one
 * at a time - the certificate, the status report, the MEMART - and the
 * customer sees the whole set once the application is completed.
 *
 * The certificate is special in two ways: a second one REPLACES the first
 * (there is only ever one), and uploading it is where the registered name and
 * registration number are recorded, because that is the document they are
 * read off. Anything else is added beside it, up to MAX_DELIVERABLES.
 */
async function adminUploadDeliverable({ id, file, kind, label, registeredName, registrationNumber, admin }) {
  const row = await findForAdmin(id);
  if (row.payment_status !== 'paid' || !CAC.DELIVERABLES_UPLOADABLE.includes(row.status)) {
    throw refusal(409, 'invalid_transition', 'Mark the application in progress before uploading its documents.');
  }
  const code = CAC.typeOf(row);
  const type = TYPES[code];
  const docKind = String(kind || '').trim().toLowerCase();
  if (!type.deliverables.includes(docKind)) {
    throw refusal(400, 'validation_error', `Choose what this document is: ${type.deliverables.join(', ')}`);
  }
  const docLabel = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (docLabel.length > 80) throw refusal(400, 'validation_error', 'Keep the document name under 80 characters');
  if (docKind === 'other' && docLabel.length < 3) {
    throw refusal(400, 'validation_error', 'Give an "other" document a name the customer will recognise');
  }
  const check = CAC.checkFile(file, {
    accept: CAC.DELIVERABLE_ACCEPT,
    maxBytes: CAC.DELIVERABLE_MAX_BYTES,
    phrase: docKind === 'certificate' ? 'the certificate' : 'the document',
  });
  if (!check.ok) throw refusal(400, 'validation_error', check.message);

  const isCertificate = docKind === 'certificate';
  const name = isCertificate ? String(registeredName ?? '').replace(/\s+/g, ' ').trim() : '';
  if (name && (name.length < 3 || name.length > 80)) {
    throw refusal(400, 'validation_error', 'The registered name must be 3 to 80 characters');
  }
  const number = isCertificate ? CAC.cleanRegistrationNumber(code, registrationNumber) : '';
  if (number === null) {
    throw refusal(400, 'validation_error', `The registration number should look like ${type.registrationPrefix} 1234567`);
  }

  let uploaded;
  try {
    uploaded = await uploadFile(
      { buffer: file.buffer, mimetype: check.mime, originalname: `${docKind}.${CAC.extensionFor(check.mime)}` },
      { prefix: `cac_${docKind}_${row.id}` },
    );
  } catch (e) {
    console.error('cac.adminUploadDeliverable upload failed:', { application_id: row.id, message: e?.message });
    throw refusal(502, 'upload_failed', 'The document could not be stored. Please try again.');
  }

  const actor = actorOf(admin);
  const touch = { updated_at: new Date() };
  if (name) touch.registered_name_enc = protectText(name);
  if (number) touch.registration_number_enc = protectText(number);

  let replaced = [];
  let created;
  try {
    await prisma.$transaction(async tx => {
      // The status guard, and a row lock: uploads, removals and "complete" on
      // one application take turns.
      const claimed = await tx.cacApplication.updateMany({
        where: { id: row.id, status: { in: CAC.DELIVERABLES_UPLOADABLE }, payment_status: 'paid' },
        data: touch,
      });
      if (!claimed.count) throw refusal(409, 'stale', 'This application changed while you were uploading. Refresh and try again.');

      if (isCertificate) {
        replaced = await tx.cacDeliverable.findMany({ where: { application_id: row.id, kind: 'certificate' } });
        if (replaced.length) {
          await tx.cacDeliverable.deleteMany({ where: { id: { in: replaced.map(r => r.id) } } });
        }
      } else if ((await tx.cacDeliverable.count({ where: { application_id: row.id } })) >= CAC.MAX_DELIVERABLES) {
        throw refusal(409, 'too_many_documents', `An application can carry at most ${CAC.MAX_DELIVERABLES} documents. Remove one first.`);
      }

      created = await tx.cacDeliverable.create({
        data: {
          application_id: row.id,
          kind: docKind,
          label_enc: docLabel ? protectText(docLabel) : null,
          url_enc: protectText(uploaded.url),
          mime: check.mime,
          size: file.buffer.length,
          uploaded_by: actor,
        },
      });
      await event(tx, row, 'deliverable_uploaded', {
        actor,
        meta: {
          deliverable_id: created.id,
          kind: docKind,
          replaced: replaced.length > 0,
          mime: check.mime,
          with_registration_number: Boolean(number),
        },
      });
    });
  } catch (e) {
    await discardFiles([uploaded.url]);
    throw e;
  }
  // The certificate this replaced, now that nothing points at it.
  await discardFiles(replaced.map(r => CAC.safeText(r.url_enc)));

  // Before completion the customer hears once, with the whole set. After it,
  // a document added (a TIN that came later) or a certificate corrected is
  // news nobody would otherwise know to look for.
  if (row.status === STATUS.COMPLETED) {
    const what = CAC.deliverableLabel(code, created);
    await notify(
      row,
      `cac:${row.id}:deliverable:${created.id}`,
      isCertificate && replaced.length ? 'Your CAC certificate was updated' : 'New document for your CAC registration',
      `${what} for application ${row.reference} is ready. Download it in VoltPay.`,
    );
  }
  return { deliverable: created };
}

/**
 * DELETE /admin/cac/applications/:id/deliverables/:docId - a wrong file. A
 * completed application's certificate cannot go (it would be completed with
 * none); upload the right one over it instead.
 */
async function adminDeleteDeliverable({ id, docId, admin }) {
  const row = await findForAdmin(id);
  const d = await findDeliverable(row.id, docId);
  const allowed = d.kind === 'certificate' ? [STATUS.IN_PROGRESS] : CAC.DELIVERABLES_UPLOADABLE;
  if (!allowed.includes(row.status)) {
    throw refusal(
      409,
      d.kind === 'certificate' ? 'certificate_locked' : 'invalid_transition',
      d.kind === 'certificate'
        ? 'A completed application keeps its certificate. Upload the correct one to replace it.'
        : 'Documents can only be changed while the application is in progress or completed.',
    );
  }
  await prisma.$transaction(async tx => {
    // Same lock as the upload and "complete": re-check the status under it.
    const locked = await tx.cacApplication.updateMany({
      where: { id: row.id, status: { in: allowed }, payment_status: 'paid' },
      data: { updated_at: new Date() },
    });
    if (!locked.count) throw refusal(409, 'stale', 'This application changed while you were looking at it. Refresh and try again.');
    const gone = await tx.cacDeliverable.deleteMany({ where: { id: d.id, application_id: row.id } });
    if (!gone.count) throw refusal(404, 'not_found', 'Document not found');
    await event(tx, row, 'deliverable_removed', { actor: actorOf(admin), meta: { deliverable_id: d.id, kind: d.kind } });
  });
  await discardFiles([CAC.safeText(d.url_enc)]);
  return { removed: true };
}

/** POST /admin/cac/applications/:id/notes - internal, never shown to the customer. */
async function adminAddNote({ id, note, admin }) {
  const row = await findForAdmin(id);
  const check = CAC.validateNote(note, { label: 'note', min: 3 });
  if (!check.ok) throw refusal(400, 'validation_error', check.message);
  await event(prisma, row, 'note', { actor: actorOf(admin), note: check.note });
  return { application: row };
}

async function customerEmail(row) {
  const user = await prisma.user.findUnique({ where: { id: row.user_id } }).catch(() => null);
  const profile = String(revealUserFields(user || {}).email || '').trim();
  return profile || CAC.revealDetails(row).email || '';
}

/** The customer hears about every decision, in their own words. */
async function afterTransition(row, action, { note, refunded }) {
  const name = CAC.displayName(row);
  const type = TYPES[CAC.typeOf(row)];
  if (action === 'start') {
    await notify(
      row,
      `cac:${row.id}:in_progress:${CAC.iso(row.started_at)}`,
      'Your CAC application is in progress',
      `We have started registering ${name || `your ${type.noun}`} with CAC (${row.reference}).`,
    );
  } else if (action === 'request_info') {
    const sentence = /[.!?]$/.test(note) ? note : `${note}.`;
    await notify(
      row,
      `cac:${row.id}:needs_more_info:${CAC.iso(row.info_requested_at)}`,
      'More information needed for your CAC application',
      `${sentence} Open application ${row.reference} in VoltPay to update it.`,
    );
  } else if (action === 'complete') {
    const number = CAC.safeText(row.registration_number_enc);
    const issued = CAC.sortDeliverables(await deliverablesOf(row.id).catch(() => []))
      .map(d => CAC.deliverableLabel(CAC.typeOf(row), d));
    const more = issued.length > 1 ? ` and ${issued.length - 1} more document${issued.length > 2 ? 's' : ''}` : '';
    await notify(
      row,
      `cac:${row.id}:completed`,
      'Your CAC documents are ready',
      `${name || `Your ${type.noun}`} is now registered${number ? ` (${number})` : ''}. ` +
        `Download your certificate${more} in VoltPay.`,
    );
    const to = await customerEmail(row);
    if (to) {
      await email
        .sendCacCertificateEmail({
          to,
          reference: row.reference,
          businessName: name,
          registrationNumber: number,
          typeLabel: type.label,
          certificateLabel: type.certificateLabel,
          documents: issued,
        })
        .catch(e => console.error('cac completed email failed:', { application_id: row.id, message: e?.message }));
    }
  } else if (action === 'reject') {
    const sentence = /[.!?]$/.test(note) ? note : `${note}.`;
    await notify(
      row,
      `cac:${row.id}:rejected`,
      'Your CAC application was not successful',
      `${sentence}${refunded ? ` ${naira(row.amount_paid)} has been refunded to your VoltPay wallet.` : ''}`,
    );
  }
}

/* ---------------------------------------------------------- the customer's documents */

/**
 * GET /cac/applications/:id/deliverables/:docId - one issued document, to its
 * owner, once the application is completed. Before that an admin may still be
 * putting the set together, so nothing is handed out early.
 */
async function deliverableForUser(res, userId, id, docId) {
  const row = await ownedApplication(userId, id);
  if (row.status !== STATUS.COMPLETED) {
    throw refusal(403, 'documents_unavailable', 'Your documents will be available here once registration is completed.');
  }
  const d = await findDeliverable(row.id, docId);
  await pipeFile(res, CAC.safeText(d.url_enc), {
    mime: d.mime,
    filename: CAC.publicDeliverable(row, d).file_name,
    disposition: 'attachment',
  });
  return row;
}

/* ---------------------------------------------------------------- the sweep */

/**
 * The database is behind the code: a CAC table is missing (P2021 / 42P01), or
 * one of its columns is (P2022 / 42703) - a table made by an older run of
 * `npm run ddl:cac`. Not an outage and not the customer's doing: the fix is to
 * run the script, so it is said once, in those words, instead of paging ops on
 * every sweep and answering the app with a bare 500.
 */
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
  console.warn('⚠️  CAC Registration tables are missing or out of date - run `npm run ddl:cac`. The service is unavailable until then.');
}

/**
 * Finishes what nobody else did, every few minutes:
 *
 *   1. Paystack checkouts with no settlement - the webhook was dropped, or the
 *      app closed before verifying. Asked about until Paystack answers, marked
 *      `abandoned` after a day, and re-asked about now and then for a week,
 *      because Paystack can still complete an abandoned checkout.
 *   2. Drafts nobody came back to. Their documents are photographs of somebody's
 *      ID with no reason to exist any more, so the form and the files go and a
 *      tombstone stays (see retireDraft). CAC_DRAFT_TTL_DAYS=0 turns this off.
 */
async function sweep({ now = new Date() } = {}) {
  const out = { checked: 0, settled: 0, abandoned: 0, retired: 0 };
  if (!prisma.cacPayment || !prisma.cacApplication) return out;
  const t = now.getTime();

  let due;
  try {
    due = await prisma.cacPayment.findMany({
      where: {
        method: 'paystack',
        OR: [
          { status: 'pending', created_at: { lt: new Date(t - SETTLE_AFTER_MS()) } },
          {
            status: 'abandoned',
            created_at: { gt: new Date(t - ABANDONED_RECHECK_FOR_MS()) },
            checked_at: { lt: new Date(t - ABANDONED_RECHECK_EVERY_MS) },
          },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: 25,
    });
  } catch (e) {
    // The timer starts on every boot, including one deployed ahead of
    // `npm run ddl:cac` or after a schema change it has not caught up with.
    // That idles the sweep with one warning - it must not page ops every five
    // minutes. Any other error still goes up.
    if (!isSchemaBehind(e)) throw e;
    warnSchemaBehind();
    return { skipped: 'no_tables' };
  }

  for (const p of due) {
    out.checked += 1;
    try {
      const r = await settlePaystack(p.reference, { source: 'sweep' });
      if (r.paid || r.duplicate) {
        out.settled += 1;
      } else if (p.status === 'pending' && t - new Date(p.created_at).getTime() > ABANDON_AFTER_MS()) {
        const n = await prisma.cacPayment.updateMany({ where: { id: p.id, status: 'pending' }, data: { status: 'abandoned' } });
        out.abandoned += n.count;
      }
    } catch (e) {
      // Paystack is down: next tick. Never read as "not paid".
      captureError('cac.sweep.settle', e, { payment_id: p.id });
    }
  }

  const ttlDays = Number(process.env.CAC_DRAFT_TTL_DAYS ?? 14);
  if (Number.isFinite(ttlDays) && ttlDays > 0) {
    const stale = await prisma.cacApplication.findMany({
      where: { status: STATUS.DRAFT, payment_status: 'unpaid', updated_at: { lt: new Date(t - ttlDays * minutes(24 * 60)) } },
      take: 25,
    });
    for (const row of stale) {
      // A checkout still pending gets settled by step 1 first; leave it.
      const open = await prisma.cacPayment.count({ where: { application_id: row.id, status: 'pending' } });
      if (open) continue;
      if (await retireDraft(row, 'expired').catch(() => false)) out.retired += 1;
    }
  }
  return out;
}

module.exports = {
  FEATURE,
  getSettings,
  updateSettings,
  home,
  listForUser,
  detailForUser,
  createDraft,
  updateApplication,
  discardDraft,
  payWithWallet,
  initializePaystack,
  verifyPaystack,
  settlePaystack,
  adminList,
  adminDetail,
  adminDocument,
  adminDeliverable,
  adminTransition,
  adminRefund,
  adminUploadDeliverable,
  adminDeleteDeliverable,
  adminAddNote,
  deliverableForUser,
  sweep,
  isSchemaBehind,
  warnSchemaBehind,
  __test: { assertQuote, callbackUrl, pipeFile, mergeDocuments },
};
