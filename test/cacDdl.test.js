/**
 * node test/cacDdl.test.js
 *
 * `npm run ddl:cac` must bring a table made by an earlier version of itself
 * forward.
 *
 * The first (2026-10-12, business names only) kept documents in per-kind
 * columns and called the registration number `bn_number_enc`. The second held
 * one certificate on the application row (`certificate_url_enc`, `_mime`,
 * `_uploaded_at`, `_uploaded_by`) before an admin could hand over several
 * documents. A database either ran against kept that table - CREATE TABLE IF
 * NOT EXISTS skips an existing table whole - and every CAC request then failed
 * with "The column `(not available)` does not exist". Pinned here, against a
 * fake database and the real encryption:
 *
 *   1. The new columns are added, the old data carried into them - document
 *      links re-encrypted into the one map, the registration number copied, the
 *      certificate moved into cac_deliverables as it is - and only then are the
 *      old columns dropped.
 *   2. A link that will not decrypt (the wrong PII_ENC_KEY) throws before
 *      anything is dropped, so the transaction rolls back with the data intact.
 *   3. A second run, or a table already on the new shape, finds nothing to do,
 *      and an application that already has a certificate row keeps it.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { protectText, revealText } = require('../src/helpers/pii.helper');
const { upgradeLegacyColumns } = require('../scripts/apply-cac-ddl');

/** Just enough Postgres to run upgradeLegacyColumns' statements against. */
function fakeClient(columns, rows, deliverables = []) {
  const cols = new Set(columns);
  const log = [];
  return {
    cols,
    rows,
    deliverables,
    log,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push(s);
      if (s.startsWith('SELECT column_name FROM information_schema.columns')) {
        return { rows: [...cols].map(column_name => ({ column_name })) };
      }
      let m = /^ALTER TABLE cac_applications ADD COLUMN IF NOT EXISTS (\w+) text$/.exec(s);
      if (m) {
        if (!cols.has(m[1])) {
          cols.add(m[1]);
          rows.forEach(r => { r[m[1]] = null; });
        }
        return { rowCount: 0 };
      }
      m = /^ALTER TABLE cac_applications DROP COLUMN IF EXISTS (\w+)$/.exec(s);
      if (m) {
        cols.delete(m[1]);
        rows.forEach(r => { delete r[m[1]]; });
        return { rowCount: 0 };
      }
      if (s.startsWith('UPDATE cac_applications SET registration_number_enc = bn_number_enc')) {
        const hit = rows.filter(r => r.registration_number_enc == null && r.bn_number_enc != null);
        hit.forEach(r => { r.registration_number_enc = r.bn_number_enc; });
        return { rowCount: hit.length };
      }
      if (s.startsWith('UPDATE cac_applications SET documents_enc = $1 WHERE id = $2')) {
        const row = rows.find(r => r.id === params[1]);
        row.documents_enc = params[0];
        return { rowCount: 1 };
      }
      m = /^SELECT id, (.+) FROM cac_applications WHERE documents_enc IS NULL AND \((.+)\)$/.exec(s);
      if (m) {
        const fields = m[1].split(', ').map(f => {
          const alias = /^NULL AS (\w+)$/.exec(f);
          return alias ? { name: alias[1], nullAlias: true } : { name: f, nullAlias: false };
        });
        const urlCols = m[2].split(' OR ').map(c => c.replace(' IS NOT NULL', ''));
        const hit = rows.filter(r => r.documents_enc == null && urlCols.some(c => r[c] != null));
        return {
          rows: hit.map(r => ({
            id: r.id,
            ...Object.fromEntries(fields.map(f => [f.name, f.nullAlias ? null : r[f.name]])),
          })),
        };
      }
      // The certificate carry: an INSERT ... SELECT over the old columns. A
      // column the table never had is selected as NULL by the script itself.
      if (s.startsWith('INSERT INTO cac_deliverables (application_id, kind, url_enc, mime, uploaded_by, created_at) SELECT')) {
        const read = (r, name) => (s.includes(`a.${name}`) ? r[name] : null);
        const hit = rows.filter(
          r => r.certificate_url_enc != null && !deliverables.some(d => d.application_id === r.id && d.kind === 'certificate'),
        );
        for (const r of hit) {
          deliverables.push({
            application_id: r.id,
            kind: 'certificate',
            url_enc: r.certificate_url_enc,
            mime: read(r, 'certificate_mime') ?? 'application/pdf',
            uploaded_by: read(r, 'certificate_uploaded_by'),
            created_at: read(r, 'certificate_uploaded_at') ?? 'CURRENT_TIMESTAMP',
          });
        }
        return { rowCount: hit.length };
      }
      throw new Error(`fake client: unexpected statement: ${s}`);
    },
  };
}

const CERTIFICATE_COLUMNS = ['certificate_url_enc', 'certificate_mime', 'certificate_uploaded_at', 'certificate_uploaded_by'];
const LEGACY = [
  'id', 'user_id', 'reference', 'details_enc', 'valid_id_url_enc', 'valid_id_mime', 'passport_url_enc',
  'passport_mime', 'signature_url_enc', 'signature_mime', 'bn_number_enc', ...CERTIFICATE_COLUMNS,
];
const NOTHING = { registration_numbers: 0, documents: 0, certificates: 0, dropped: [] };

(async () => {
  /* ------------------------------------------- 1. carried, then dropped */

  const uploadedAt = new Date('2026-10-12T15:00:00Z');
  const certificateEnc = protectText('https://app.ufs.sh/f/cert1');
  const rows = [
    {
      id: 1,
      valid_id_url_enc: protectText('https://app.ufs.sh/f/id1'),
      valid_id_mime: 'application/pdf',
      passport_url_enc: protectText('https://app.ufs.sh/f/pp1'),
      passport_mime: 'image/jpeg',
      signature_url_enc: protectText('https://app.ufs.sh/f/sg1'),
      signature_mime: 'image/png',
      bn_number_enc: protectText('BN1234567'),
      certificate_url_enc: certificateEnc,
      certificate_mime: 'application/pdf',
      certificate_uploaded_at: uploadedAt,
      certificate_uploaded_by: 'admin:ops-ada',
    },
    // A draft with no documents yet and no number: nothing to carry.
    {
      id: 2, valid_id_url_enc: null, valid_id_mime: null, passport_url_enc: null, passport_mime: null,
      signature_url_enc: null, signature_mime: null, bn_number_enc: null,
      certificate_url_enc: null, certificate_mime: null, certificate_uploaded_at: null, certificate_uploaded_by: null,
    },
  ];
  const db = fakeClient(LEGACY, rows);
  const report = await upgradeLegacyColumns(db);

  assert.strictEqual(report.documents, 1, 'one row had documents to carry');
  assert.strictEqual(report.registration_numbers, 1);
  assert.strictEqual(report.certificates, 1, 'one row had a certificate to carry');
  assert.deepStrictEqual(report.dropped.sort(), [
    'bn_number_enc', ...CERTIFICATE_COLUMNS, 'passport_mime', 'passport_url_enc', 'signature_mime', 'signature_url_enc',
    'valid_id_mime', 'valid_id_url_enc',
  ].sort());
  assert.ok(db.cols.has('documents_enc') && db.cols.has('registration_number_enc'));
  assert.ok(!db.cols.has('valid_id_url_enc') && !db.cols.has('bn_number_enc'), 'the old columns are gone');
  assert.ok(CERTIFICATE_COLUMNS.every(c => !db.cols.has(c)), 'and so is the single certificate');
  assert.ok(db.cols.has('details_enc'), 'a column every version shares is left alone');

  const carried = JSON.parse(revealText(rows[0].documents_enc));
  assert.deepStrictEqual(carried, {
    valid_id: { url: 'https://app.ufs.sh/f/id1', mime: 'application/pdf' },
    passport: { url: 'https://app.ufs.sh/f/pp1', mime: 'image/jpeg' },
    signature: { url: 'https://app.ufs.sh/f/sg1', mime: 'image/png' },
  });
  assert.ok(rows[0].documents_enc.startsWith('enc:v1:'), 'still ciphertext in its new home');
  assert.strictEqual(revealText(rows[0].registration_number_enc), 'BN1234567');
  assert.strictEqual(rows[1].documents_enc, null, 'nothing invented for a row that had nothing');

  // The certificate is now application 1's `certificate` deliverable: the same
  // ciphertext, moved without being decrypted, with who uploaded it and when.
  assert.deepStrictEqual(db.deliverables, [
    {
      application_id: 1,
      kind: 'certificate',
      url_enc: certificateEnc,
      mime: 'application/pdf',
      uploaded_by: 'admin:ops-ada',
      created_at: uploadedAt,
    },
  ]);
  assert.strictEqual(revealText(db.deliverables[0].url_enc), 'https://app.ufs.sh/f/cert1');

  // Nothing is dropped before every carry has been written.
  const firstDrop = db.log.findIndex(s => s.includes('DROP COLUMN'));
  const lastCarry = db.log
    .map(s => s.includes('SET documents_enc') || s.includes('SET registration_number_enc') || s.startsWith('INSERT INTO cac_deliverables'))
    .lastIndexOf(true);
  assert.ok(lastCarry >= 0 && firstDrop > lastCarry, 'carry first, drop after');

  /* ----------------------------------------- 3. a second run: no-op */

  assert.deepStrictEqual(await upgradeLegacyColumns(db), NOTHING);
  assert.strictEqual(db.deliverables.length, 1, 'never carried twice');

  // A table created by the current script never had the old columns.
  const fresh = fakeClient(['id', 'details_enc', 'documents_enc', 'registration_number_enc'], []);
  assert.deepStrictEqual(await upgradeLegacyColumns(fresh), NOTHING);
  assert.ok(!fresh.log.some(s => s.includes('DROP COLUMN')), 'nothing dropped on the current shape');
  assert.ok(!fresh.log.some(s => s.startsWith('INSERT')), 'and nothing carried');

  // The second version's table with only the link column (an older cut of it):
  // the mime falls back to PDF rather than the carry failing on a missing column.
  const linkOnly = fakeClient(['id', 'details_enc', 'documents_enc', 'registration_number_enc', 'certificate_url_enc'], [
    { id: 4, details_enc: null, documents_enc: null, registration_number_enc: null, certificate_url_enc: certificateEnc },
  ]);
  const linkReport = await upgradeLegacyColumns(linkOnly);
  assert.strictEqual(linkReport.certificates, 1);
  assert.deepStrictEqual(linkReport.dropped, ['certificate_url_enc']);
  assert.strictEqual(linkOnly.deliverables[0].mime, 'application/pdf');
  assert.strictEqual(linkOnly.deliverables[0].uploaded_by, null);

  // An application that already has a certificate row keeps that one.
  const already = fakeClient(
    ['id', 'details_enc', 'documents_enc', 'registration_number_enc', ...CERTIFICATE_COLUMNS],
    [{ id: 5, certificate_url_enc: certificateEnc, certificate_mime: 'image/png', certificate_uploaded_at: null, certificate_uploaded_by: null }],
    [{ application_id: 5, kind: 'certificate', url_enc: 'enc:v1:newer', mime: 'application/pdf' }],
  );
  assert.strictEqual((await upgradeLegacyColumns(already)).certificates, 0);
  assert.deepStrictEqual(already.deliverables.map(d => d.url_enc), ['enc:v1:newer']);

  /* --------------------------- 2. an unreadable link stops everything */

  const badRows = [
    {
      id: 9,
      valid_id_url_enc: 'enc:v1:not:real:ciphertext',
      valid_id_mime: 'image/jpeg',
      passport_url_enc: null,
      passport_mime: null,
      signature_url_enc: null,
      signature_mime: null,
      bn_number_enc: null,
      certificate_url_enc: certificateEnc,
      certificate_mime: 'application/pdf',
      certificate_uploaded_at: null,
      certificate_uploaded_by: null,
    },
  ];
  const bad = fakeClient(LEGACY, badRows);
  const realError = console.error;
  console.error = () => {}; // revealText logs the decrypt failure it reports
  await assert.rejects(upgradeLegacyColumns(bad), /would not decrypt/);
  console.error = realError;
  assert.ok(!bad.log.some(s => s.includes('DROP COLUMN')), 'nothing dropped when a carry failed - the caller rolls back');
  assert.strictEqual(badRows[0].valid_id_url_enc, 'enc:v1:not:real:ciphertext', 'the original is untouched');
  assert.strictEqual(badRows[0].certificate_url_enc, certificateEnc, 'and so is the certificate');

  console.log('✅ CAC DDL upgrade tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
