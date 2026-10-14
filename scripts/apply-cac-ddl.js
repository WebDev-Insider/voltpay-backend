// CAC Registration - business names, limited companies and incorporated
// trustees: applications, their history, payments, and the starting prices.
//
//   cac_applications        one row per application, from the unpaid draft on
//       UNIQUE (reference) - CAC-XXXXXXXX, what the customer and support quote.
//   cac_application_events  every status change, payment, refund and admin note
//   cac_payments            one row per payment attempt, wallet or Paystack
//       UNIQUE (reference) - the Paystack reference (CACPAY-...) or the wallet
//       ledger trx, so a webhook, a verify and the sweep can only ever settle
//       one row between them.
//   cac_deliverables        what CAC issued, one row per file: the certificate
//       and whatever comes with it (status report, MEMART, TIN, ...)
//
// No foreign key to users, on purpose: like wallet_transactions, a record of
// money paid is never cascaded away with an account.
//
// Every typed field and every document link is ciphertext - see
// cac.helper.js. Nothing here is searchable but the reference, by design.
//
// THE PRICES. Seeded into app_settings with the figures agreed with the
// processing partner (2026-10-12) - but only where no price exists yet, so this
// never overwrites a price an admin has since changed in the dashboard. From
// here on the dashboard owns them; the numbers below are a starting point, not
// the price.
//
// Additive only: three new tables and three settings rows. Prisma CLI cannot
// reach Neon from this machine, so the DDL goes over pg on DIRECT_URL like
// every other script here. Re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');
const dns = require('dns');

const STARTING_PRICES = [
  ['cac_price_business_name', '35000', 'CAC registration price: business name / enterprise (NGN)'],
  ['cac_price_limited_company', '55000', 'CAC registration price: limited liability company (NGN)'],
  ['cac_price_incorporated_trustees', '150000', 'CAC registration price: incorporated trustees / NGO (NGN)'],
];

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cac_applications (
     id                      serial PRIMARY KEY,
     user_id                 integer NOT NULL,
     reference               text NOT NULL,
     registration_type       text NOT NULL DEFAULT 'business_name',
     status                  text NOT NULL DEFAULT 'draft',
     payment_status          text NOT NULL DEFAULT 'unpaid',
     payment_method          text,
     payment_reference       text,
     amount_paid             numeric(15,2),
     details_enc             text NOT NULL,
     documents_enc           text,
     registered_name_enc     text,
     registration_number_enc text,
     admin_note_enc          text,
     resubmissions           integer NOT NULL DEFAULT 0,
     paid_at                 timestamp(3),
     submitted_at            timestamp(3),
     started_at              timestamp(3),
     info_requested_at       timestamp(3),
     info_provided_at        timestamp(3),
     completed_at            timestamp(3),
     rejected_at             timestamp(3),
     refunded_at             timestamp(3),
     refund_trx              text,
     created_at              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cac_applications_reference_key
     ON cac_applications (reference)`,
  `CREATE INDEX IF NOT EXISTS cac_applications_user_id_created_at_idx
     ON cac_applications (user_id, created_at)`,
  // The admin queue and the draft purge both lead with status.
  `CREATE INDEX IF NOT EXISTS cac_applications_status_updated_at_idx
     ON cac_applications (status, updated_at)`,

  `CREATE TABLE IF NOT EXISTS cac_application_events (
     id             serial PRIMARY KEY,
     application_id integer NOT NULL REFERENCES cac_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
     event          text NOT NULL,
     from_status    text,
     to_status      text,
     actor          text NOT NULL DEFAULT 'system',
     note_enc       text,
     meta           jsonb,
     created_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS cac_application_events_application_id_created_at_idx
     ON cac_application_events (application_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS cac_payments (
     id                serial PRIMARY KEY,
     application_id    integer NOT NULL REFERENCES cac_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
     user_id           integer NOT NULL,
     method            text NOT NULL,
     reference         text NOT NULL,
     amount            numeric(15,2) NOT NULL,
     amount_received   numeric(15,2),
     status            text NOT NULL DEFAULT 'pending',
     provider_status   text,
     authorization_url text,
     failure_reason    text,
     refund_trx        text,
     paid_at           timestamp(3),
     checked_at        timestamp(3),
     created_at        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cac_payments_reference_key
     ON cac_payments (reference)`,
  `CREATE INDEX IF NOT EXISTS cac_payments_application_id_idx
     ON cac_payments (application_id)`,
  // The sweep's scan: unsettled Paystack attempts by age.
  `CREATE INDEX IF NOT EXISTS cac_payments_status_created_at_idx
     ON cac_payments (status, created_at)`,

  `CREATE TABLE IF NOT EXISTS cac_deliverables (
     id             serial PRIMARY KEY,
     application_id integer NOT NULL REFERENCES cac_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
     kind           text NOT NULL,
     label_enc      text,
     url_enc        text NOT NULL,
     mime           text NOT NULL,
     size           integer,
     uploaded_by    text,
     created_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS cac_deliverables_application_id_idx
     ON cac_deliverables (application_id)`,
];

/**
 * An A record for `hostname`, tried three ways - see the same function in
 * apply-staffpay-scheduler-ddl.js for why a plain resolve4() is not enough on
 * this machine.
 */
async function resolveHostIp(hostname) {
  try {
    const { address } = await dns.promises.lookup(hostname, { family: 4 });
    return { ip: address, via: 'OS resolver (retry)' };
  } catch (_) { /* fall through */ }

  const configured = dns.promises.getServers()
    .filter(s => !/^(127\.|::1$|0\.0\.0\.0)/.test(s));

  for (const [servers, via] of [[configured, 'configured DNS'], [['1.1.1.1', '8.8.8.8'], 'public DNS']]) {
    if (!servers.length) continue;
    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(servers);
      const [ip] = await resolver.resolve4(hostname);
      if (ip) return { ip, via };
    } catch (_) { /* try the next set */ }
  }

  throw new Error(
    `could not resolve ${hostname}. DNS is down on this machine - check the router, ` +
    'or run this script from a network that resolves.',
  );
}

// Neon routes on SNI, so the original hostname stays as `servername` when the
// connection falls back to an IP.
async function connect() {
  const url = new URL(process.env.DIRECT_URL);
  const ssl = { rejectUnauthorized: false, servername: url.hostname };
  try {
    const client = new Client({ connectionString: process.env.DIRECT_URL, ssl });
    await client.connect();
    return client;
  } catch (e) {
    if (e?.code !== 'EAI_AGAIN' && e?.code !== 'ENOTFOUND') throw e;
    const { ip, via } = await resolveHostIp(url.hostname);
    const client = new Client({
      host: ip,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      ssl,
    });
    await client.connect();
    console.log(`note  resolved ${url.hostname} to ${ip} via ${via} (OS resolver failed first)`);
    return client;
  }
}

/**
 * Bring forward a table made by an earlier cut of this script.
 *
 * The first (business names only, 2026-10-12) kept each document in its own
 * pair of columns (`valid_id_url_enc` + `valid_id_mime`, ...) and called the
 * registration number `bn_number_enc`. The second held ONE certificate on the
 * application row (`certificate_url_enc`, `_mime`, `_uploaded_at`,
 * `_uploaded_by`) before an admin could hand over several documents. On a
 * database either ran against, the CREATE TABLE above is skipped - IF NOT
 * EXISTS skips the whole statement, new columns included - and the app then
 * asks for columns that are not there: "The column `(not available)` does not
 * exist in the current database."
 *
 * So: add the new columns, carry any data across into them, and only then drop
 * the old ones - all inside the caller's transaction, so nothing is dropped
 * unless everything was carried. Re-running finds nothing to do.
 *
 * A carried document link is decrypted and re-encrypted into the new map, so
 * PII_ENC_KEY must be the key it was written with; if a link will not decrypt,
 * this throws and the transaction rolls back rather than dropping it.
 */
const LEGACY_DOCUMENTS = ['valid_id', 'passport', 'signature'];

async function upgradeLegacyColumns(client) {
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'cac_applications'",
  );
  const has = new Set(rows.map(r => r.column_name));

  await client.query('ALTER TABLE cac_applications ADD COLUMN IF NOT EXISTS documents_enc text');
  await client.query('ALTER TABLE cac_applications ADD COLUMN IF NOT EXISTS registration_number_enc text');

  const report = { registration_numbers: 0, documents: 0, certificates: 0, dropped: [] };

  if (has.has('bn_number_enc')) {
    // Same protectText() format on both sides, so a straight copy.
    const moved = await client.query(
      `UPDATE cac_applications SET registration_number_enc = bn_number_enc
        WHERE registration_number_enc IS NULL AND bn_number_enc IS NOT NULL`,
    );
    report.registration_numbers = moved.rowCount;
  }

  const kinds = LEGACY_DOCUMENTS.filter(k => has.has(`${k}_url_enc`));
  if (kinds.length) {
    const select = kinds.flatMap(k => [`${k}_url_enc`, has.has(`${k}_mime`) ? `${k}_mime` : `NULL AS ${k}_mime`]);
    const pending = await client.query(
      `SELECT id, ${select.join(', ')} FROM cac_applications
        WHERE documents_enc IS NULL AND (${kinds.map(k => `${k}_url_enc IS NOT NULL`).join(' OR ')})`,
    );
    if (pending.rows.length) {
      // Loaded only when there is something to carry: it needs the PII keys.
      const { protectText, revealText } = require('../src/helpers/pii.helper');
      for (const row of pending.rows) {
        const docs = {};
        for (const k of kinds) {
          if (!row[`${k}_url_enc`]) continue;
          const url = revealText(row[`${k}_url_enc`]);
          if (!url) {
            throw new Error(`application ${row.id}: its ${k} link would not decrypt - is PII_ENC_KEY the key it was written with?`);
          }
          docs[k] = { url, mime: row[`${k}_mime`] || null };
        }
        await client.query('UPDATE cac_applications SET documents_enc = $1 WHERE id = $2', [protectText(JSON.stringify(docs)), row.id]);
        report.documents += 1;
      }
    }
  }

  // The single certificate becomes the application's `certificate`
  // deliverable. A straight copy - the link is protectText() on both sides, so
  // nothing is decrypted - and an application that already has a certificate
  // row keeps it. cac_deliverables exists by now: it is in STATEMENTS.
  if (has.has('certificate_url_enc')) {
    const col = (name, fallback) => (has.has(name) ? `a.${name}` : fallback);
    const carried = await client.query(
      `INSERT INTO cac_deliverables (application_id, kind, url_enc, mime, uploaded_by, created_at)
       SELECT a.id, 'certificate', a.certificate_url_enc,
              COALESCE(${col('certificate_mime', 'NULL')}, 'application/pdf'),
              ${col('certificate_uploaded_by', 'NULL')},
              COALESCE(${col('certificate_uploaded_at', 'NULL')}, CURRENT_TIMESTAMP)
         FROM cac_applications a
        WHERE a.certificate_url_enc IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM cac_deliverables d WHERE d.application_id = a.id AND d.kind = 'certificate'
          )`,
    );
    report.certificates = carried.rowCount;
  }

  const legacy = [
    ...LEGACY_DOCUMENTS.flatMap(k => [`${k}_url_enc`, `${k}_mime`]),
    'bn_number_enc',
    'certificate_url_enc',
    'certificate_mime',
    'certificate_uploaded_at',
    'certificate_uploaded_by',
  ].filter(col => has.has(col));
  for (const col of legacy) {
    await client.query(`ALTER TABLE cac_applications DROP COLUMN IF EXISTS ${col}`);
    report.dropped.push(col);
  }
  return report;
}

async function main() {
  const client = await connect();

  await client.query('BEGIN');
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].trim()}`);
    }
    const upgrade = await upgradeLegacyColumns(client);
    if (upgrade.dropped.length) {
      console.log(
        `ok    upgraded cac_applications from an earlier version: carried ${upgrade.documents} document set(s), ` +
          `${upgrade.registration_numbers} registration number(s) and ${upgrade.certificates} certificate(s), ` +
          `dropped ${upgrade.dropped.join(', ')}`,
      );
    }
    // updated_at has no database default (Prisma stamps it client-side), so it
    // is set here. DO NOTHING: an existing price is the admin's, and stays.
    for (const [key, value, description] of STARTING_PRICES) {
      const { rowCount } = await client.query(
        `INSERT INTO app_settings (setting_key, setting_value, description, created_at, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (setting_key) DO NOTHING`,
        [key, value, description],
      );
      console.log(rowCount ? `ok    seeded ${key} = ${value}` : `kept  ${key} (already set - the dashboard's value stands)`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done');
}

if (require.main === module) {
  main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { upgradeLegacyColumns };
