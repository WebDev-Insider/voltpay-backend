/**
 * GET /api/admin/deleted-accounts
 *
 * Every account on its way out of VoltPay, at whichever of the three stages it
 * has reached. account.controller.js owns the lifecycle; this only reads it.
 *
 *   pending    - deletion asked for, grace period running. Signed out
 *                everywhere, but the row is intact and reactivating cancels it.
 *   anonymised - grace period over. Credentials, blind indexes and profile gone,
 *                so nobody can sign in or look the account up by phone or email
 *                ever again, but the identification record is still held: MLPPA
 *                2022 s.19 and the CBN AML/CFT Regulations require five years of
 *                it after the relationship ends, and an NFIU request or a
 *                chargeback in year four is answered from exactly this.
 *   purged     - the five years are up and the identity has been erased too.
 *                The money trail stays, permanently, naming nobody.
 *
 * The retained identity is the point of the screen - an admin who cannot see it
 * cannot answer the request the law expects VoltPay to answer - so this endpoint
 * decrypts it. Reads are not written to the admin audit log, matching every
 * other list endpoint (see adminAudit.middleware: auditing dashboard polling
 * buries the writes that matter).
 */
const prisma = require('../../database/prisma');
const { revealUserFields, revealText } = require('../helpers/pii.helper');
const { DELETED } = require('../helpers/accountStatus.helper');
const { IDENTITY_FIELDS, retentionYears } = require('./account.controller');

const IDENTITY_COLUMNS = Object.keys(IDENTITY_FIELDS);

// Both halves of every identity column: revealUserFields prefers the ciphertext
// and falls back to the plain column, which is all a row still waiting out its
// grace period may have if it predates the encryption migration.
const ROW_SELECT = {
  id: true,
  status: true,
  country_code: true,
  balance: true,
  created_at: true,
  deletion_requested_at: true,
  deletion_scheduled_at: true,
  deletion_reason: true,
  deleted_at: true,
  ...Object.fromEntries(IDENTITY_COLUMNS.map(column => [column, true])),
  ...Object.fromEntries(IDENTITY_COLUMNS.map(column => [column.replace(/_enc$/, ''), true])),
};

const STATUS_PENDING = 'pending';
const STATUS_ANONYMISED = 'anonymised';
const STATUS_PURGED = 'purged';

function stageOf(row) {
  if (Number(row.status) !== DELETED) return STATUS_PENDING;
  const retained = IDENTITY_COLUMNS.some(column => row[column]);
  return retained ? STATUS_ANONYMISED : STATUS_PURGED;
}

/** When the identification record is due to be erased: closure + retention. */
function purgeDueAt(row) {
  if (!row.deleted_at) return null;
  const due = new Date(row.deleted_at);
  due.setUTCFullYear(due.getUTCFullYear() + retentionYears());
  return due;
}

function serialize(row) {
  const identity = revealUserFields(row);
  const stage = stageOf(row);
  const due = purgeDueAt(row);

  return {
    id: row.id,
    stage,
    // Held back rather than nulled at stage one: it is the user's own words
    // about why they left, and support needs it to answer them.
    reason: row.deletion_reason ? revealText(row.deletion_reason) : null,
    requested_at: row.deletion_requested_at,
    scheduled_at: row.deletion_scheduled_at,
    deleted_at: row.deleted_at,
    purge_due_at: due ? due.toISOString() : null,
    // Empty strings from a purged row would render as a blank cell that reads
    // like a bug. Null says "there is nothing left here", which is the truth.
    firstname: identity.firstname || null,
    lastname: identity.lastname || null,
    username: identity.username || null,
    email: identity.email || null,
    mobile: identity.mobile || null,
    country_code: row.country_code,
    balance: row.balance,
    created_at: row.created_at,
  };
}

function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Everything that has been asked to be deleted, filtered but not searched.
 *
 * A closed account is only ever reached by id from here on: the blind indexes
 * are dropped the moment the grace period expires, which is what makes sign-in
 * and lookup-by-phone impossible and frees the number for whoever registers it
 * next. Keeping an index alive for this screen would undo both.
 */
function buildWhere({ stage, from, to }) {
  const and = [{ OR: [{ status: DELETED }, { deletion_scheduled_at: { not: null } }] }];

  if (stage === STATUS_PENDING) and.push({ deletion_scheduled_at: { not: null } });
  if (stage === STATUS_ANONYMISED) {
    and.push({ status: DELETED }, { OR: IDENTITY_COLUMNS.map(column => ({ [column]: { not: null } })) });
  }
  if (stage === STATUS_PURGED) {
    and.push({ status: DELETED }, ...IDENTITY_COLUMNS.map(column => ({ [column]: null })));
  }

  // One range, either date: a row that is still pending has no deleted_at, and
  // a row anonymised long ago may predate deletion_requested_at being recorded.
  const range = {};
  if (from) range.gte = from;
  if (to) range.lte = to;
  if (from || to) {
    and.push({ OR: [{ deletion_requested_at: range }, { deleted_at: range }] });
  }

  return { AND: and };
}

// ponytail: search decrypts and scans, because there is no index left to match
// against - see buildWhere. Bounded so a wide filter cannot walk the table;
// raise it or add a dedicated retention index if closed accounts pass this.
const SEARCH_SCAN_LIMIT = 5000;

function matches(row, needle) {
  return [row.email, row.mobile, row.firstname, row.lastname, row.username]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(needle));
}

async function listDeletedAccounts(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10) || 25, 1), 100);
    const q = String(req.query.q || '').trim();
    const stage = String(req.query.stage || '').trim().toLowerCase();

    const where = buildWhere({
      stage: [STATUS_PENDING, STATUS_ANONYMISED, STATUS_PURGED].includes(stage) ? stage : '',
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    });

    // A user id is the one thing that still resolves in SQL, and it is what an
    // admin holding a transaction reference actually has.
    if (/^\d+$/.test(q)) where.AND.push({ id: Number(q) });

    const orderBy = [{ deletion_requested_at: 'desc' }, { deleted_at: 'desc' }];

    if (!q || /^\d+$/.test(q)) {
      const total = await prisma.user.count({ where });
      const rows = await prisma.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
        select: ROW_SELECT,
      });

      return res.json({
        remark: 'admin_deleted_accounts',
        status: 'success',
        data: {
          items: rows.map(serialize),
          pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
        },
      });
    }

    const scanned = await prisma.user.findMany({ where, orderBy, take: SEARCH_SCAN_LIMIT, select: ROW_SELECT });
    const needle = q.toLowerCase();
    const matched = scanned.map(serialize).filter(row => matches(row, needle));

    return res.json({
      remark: 'admin_deleted_accounts',
      status: 'success',
      data: {
        items: matched.slice((page - 1) * perPage, page * perPage),
        pagination: {
          page,
          perPage,
          total: matched.length,
          totalPages: Math.max(Math.ceil(matched.length / perPage), 1),
          truncated: scanned.length === SEARCH_SCAN_LIMIT,
        },
      },
    });
  } catch (error) {
    console.error('admin.listDeletedAccounts error', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to list deleted accounts'],
      data: null,
    });
  }
}

module.exports = { listDeletedAccounts, __test: { stageOf, purgeDueAt, buildWhere, matches, serialize } };
