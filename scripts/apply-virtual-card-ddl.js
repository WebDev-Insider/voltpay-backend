// USD Virtual Mastercard - cards, their top-ups, their activity, their events,
// and the starting prices and limits.
//
//   virtual_cards              one row per card, from the paid `creating` row on
//       UNIQUE (reference)          VC-XXXXXXXX, ours, and the create reference
//       UNIQUE (provider_card_id)   Payvessel's id, once known
//       UNIQUE (user_id) WHERE status IN ('creating','active','frozen')
//                                   ONE LIVE CARD PER USER - a second create
//                                   races into this and its fee debit rolls back
//   virtual_card_fundings      one row per top-up
//       UNIQUE (reference)          the ledger trx; `_r` is its refund
//       UNIQUE (card_id) WHERE status = 'processing'
//                                   ONE TOP-UP IN FLIGHT PER CARD - a lost answer
//                                   can never become a second debit
//   virtual_card_transactions  Payvessel's record of the card's activity
//   virtual_card_events        transitions, refunds, freezes, reveals (never what
//                              a reveal showed)
//   virtual_card_webhooks      every signed delivery from Payvessel: event, outcome,
//       UNIQUE (delivery_key)       sha256 of the raw body, so a resend is known
//                                   as one - ids and outcomes only, never the body
//
// No foreign key to users, on purpose: like wallet_transactions, a record of
// money paid is never cascaded away with an account.
//
// No card number or CVV column exists, and none may be added: they are read
// from Payvessel at the moment they are shown and never kept.
//
// THE PRICES. The fees and limits are seeded into app_settings only where none
// exists yet - the dashboard owns them from then on. Two are deliberately NOT
// seeded, because a guess would be charged to real customers:
//   - the card CREATION PRICE: the admin sets it (it was ₦5,000 in the first
//     brief, and the owner has since said it may not be). Until it is set, the
//     app says "not available yet" and no card can be bought.
//   - the dollar rate: until an admin sets what a dollar costs us, top-ups say
//     "not available yet" rather than sell at a guessed rate.
// A database this script already ran against keeps whatever creation price it
// holds - DO NOTHING never overwrites - and the dashboard changes it.
//
// Additive only. Prisma CLI cannot reach Neon from this machine, so the DDL
// goes over pg on DIRECT_URL like every other script here. Re-running is a
// no-op, and every column is also ensured with ADD COLUMN IF NOT EXISTS, so a
// table made by an earlier cut of this script is brought forward rather than
// skipped whole by CREATE TABLE IF NOT EXISTS.
require('dotenv').config();
const { Client } = require('pg');
const dns = require('dns');

const STARTING_SETTINGS = [
  // Payvessel refuses a create without at least $1 on the card (2026-10-14).
  ['vcard_create_prefund_usd', '1', 'USD card: starting balance a new card is created with (USD, min 1)'],
  ['vcard_fx_margin_percent', '2', 'USD card: margin added to the dollar cost (%)'],
  ['vcard_funding_fee_percent', '2.5', 'USD card: top-up fee (%)'],
  ['vcard_funding_fee_min_usd', '1', 'USD card: minimum top-up fee (USD)'],
  ['vcard_min_fund_usd', '5', 'USD card: smallest top-up (USD)'],
  ['vcard_max_fund_usd', '1000', 'USD card: largest single top-up (USD)'],
  ['vcard_daily_fund_limit_usd', '1000', 'USD card: top-ups per card per day (USD)'],
  ['vcard_max_balance_usd', '5000', 'USD card: most a card may hold (USD)'],
  ['vcard_intl_fee_percent', '4', 'USD card: international fee shown to customers (%)'],
  ['vcard_intl_fee_flat_usd', '0.50', 'USD card: international fee shown to customers (USD)'],
];

// [column, type, constraints]. `constraints` applies on CREATE; an ALTER on a
// table that already has rows adds the column nullable unless it has a DEFAULT.
const TABLES = {
  virtual_cards: [
    ['id', 'serial', 'PRIMARY KEY'],
    ['user_id', 'integer', 'NOT NULL'],
    ['reference', 'text', 'NOT NULL'],
    ['provider', 'text', "NOT NULL DEFAULT 'payvessel'"],
    ['provider_card_id', 'text', ''],
    ['status', 'text', "NOT NULL DEFAULT 'creating'"],
    ['provider_status', 'text', ''],
    ['brand', 'text', "NOT NULL DEFAULT 'MASTERCARD'"],
    ['currency', 'text', "NOT NULL DEFAULT 'USD'"],
    ['name_enc', 'text', ''],
    ['masked_pan_enc', 'text', ''],
    ['expiry_enc', 'text', ''],
    ['balance_cents', 'integer', 'NOT NULL DEFAULT 0'],
    ['balance_synced_at', 'timestamp(3)', ''],
    ['creation_fee', 'numeric(15,2)', 'NOT NULL'],
    ['creation_trx', 'text', 'NOT NULL'],
    ['refund_trx', 'text', ''],
    ['bvn_idx', 'text', ''],
    ['nin_idx', 'text', ''],
    ['create_state', 'text', "NOT NULL DEFAULT 'pending'"],
    ['create_attempted_at', 'timestamp(3)', ''],
    ['create_checks', 'integer', 'NOT NULL DEFAULT 0'],
    ['failure_reason', 'text', ''],
    ['provider_message', 'text', ''],
    ['fee_due_cents', 'integer', 'NOT NULL DEFAULT 0'],
    ['first_funded_at', 'timestamp(3)', ''],
    ['fund_reminder_at', 'timestamp(3)', ''],
    ['activated_at', 'timestamp(3)', ''],
    ['frozen_at', 'timestamp(3)', ''],
    ['frozen_by', 'text', ''],
    ['failed_at', 'timestamp(3)', ''],
    ['terminated_at', 'timestamp(3)', ''],
    ['termination_refund_trx', 'text', ''],
    ['pending_alerted_at', 'timestamp(3)', ''],
    ['checked_at', 'timestamp(3)', ''],
    ['created_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ],
  virtual_card_fundings: [
    ['id', 'serial', 'PRIMARY KEY'],
    ['card_id', 'integer', 'NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE ON UPDATE CASCADE'],
    ['user_id', 'integer', 'NOT NULL'],
    ['reference', 'text', 'NOT NULL'],
    ['status', 'text', "NOT NULL DEFAULT 'processing'"],
    ['provider_state', 'text', "NOT NULL DEFAULT 'pending'"],
    ['amount_ngn', 'numeric(15,2)', 'NOT NULL'],
    ['fee_ngn', 'numeric(15,2)', 'NOT NULL'],
    ['total_ngn', 'numeric(15,2)', 'NOT NULL'],
    ['amount_cents', 'integer', 'NOT NULL'],
    ['fee_cents', 'integer', 'NOT NULL'],
    ['fee_due_cents', 'integer', 'NOT NULL DEFAULT 0'],
    ['provider_amount_cents', 'integer', 'NOT NULL'],
    ['rate_kobo', 'integer', 'NOT NULL'],
    ['cost_rate_kobo', 'integer', ''],
    ['provider_txn_id', 'text', ''],
    ['provider_message', 'text', ''],
    ['failure_reason', 'text', ''],
    ['refund_trx', 'text', ''],
    ['checks', 'integer', 'NOT NULL DEFAULT 0'],
    ['sent_at', 'timestamp(3)', ''],
    ['settled_at', 'timestamp(3)', ''],
    ['checked_at', 'timestamp(3)', ''],
    ['created_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ],
  virtual_card_transactions: [
    ['id', 'serial', 'PRIMARY KEY'],
    ['card_id', 'integer', 'NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE ON UPDATE CASCADE'],
    ['user_id', 'integer', 'NOT NULL'],
    ['provider_txn_id', 'text', 'NOT NULL'],
    ['type', 'text', 'NOT NULL'],
    ['entry', 'text', 'NOT NULL'],
    ['status', 'text', ''],
    ['amount_cents', 'integer', 'NOT NULL'],
    ['fee_cents', 'integer', 'NOT NULL DEFAULT 0'],
    ['currency', 'text', "NOT NULL DEFAULT 'USD'"],
    ['merchant_enc', 'text', ''],
    ['merchant_country', 'text', ''],
    ['description_enc', 'text', ''],
    ['occurred_at', 'timestamp(3)', 'NOT NULL'],
    ['source', 'text', 'NOT NULL'],
    ['created_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ],
  virtual_card_events: [
    ['id', 'serial', 'PRIMARY KEY'],
    ['card_id', 'integer', 'NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE ON UPDATE CASCADE'],
    ['event', 'text', 'NOT NULL'],
    ['actor', 'text', "NOT NULL DEFAULT 'system'"],
    ['meta', 'jsonb', ''],
    ['created_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ],
  // No foreign key to virtual_cards: a delivery for a card we do not know is
  // still a delivery, and the log outlives any card.
  virtual_card_webhooks: [
    ['id', 'serial', 'PRIMARY KEY'],
    ['delivery_key', 'text', 'NOT NULL'],
    ['event', 'text', 'NOT NULL'],
    ['card_id', 'integer', ''],
    ['provider_reference', 'text', ''],
    ['outcome', 'text', "NOT NULL DEFAULT 'received'"],
    ['detail', 'text', ''],
    ['attempts', 'integer', 'NOT NULL DEFAULT 1'],
    ['received_at', 'timestamp(3)', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['processed_at', 'timestamp(3)', ''],
  ],
};

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_cards_reference_key ON virtual_cards (reference)',
  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_cards_provider_card_id_key ON virtual_cards (provider_card_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_cards_termination_refund_trx_key ON virtual_cards (termination_refund_trx)',
  // The money guard. Prisma cannot declare a partial index, so it lives here.
  `CREATE UNIQUE INDEX IF NOT EXISTS virtual_cards_one_live_per_user
     ON virtual_cards (user_id) WHERE status IN ('creating', 'active', 'frozen')`,
  'CREATE INDEX IF NOT EXISTS virtual_cards_user_id_created_at_idx ON virtual_cards (user_id, created_at)',
  // The sweep's scans lead with status.
  'CREATE INDEX IF NOT EXISTS virtual_cards_status_updated_at_idx ON virtual_cards (status, updated_at)',
  'CREATE INDEX IF NOT EXISTS virtual_cards_bvn_idx_idx ON virtual_cards (bvn_idx)',
  'CREATE INDEX IF NOT EXISTS virtual_cards_nin_idx_idx ON virtual_cards (nin_idx)',

  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_fundings_reference_key ON virtual_card_fundings (reference)',
  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_fundings_provider_txn_id_key ON virtual_card_fundings (provider_txn_id)',
  // The second money guard: one top-up in flight per card.
  `CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_fundings_one_in_flight
     ON virtual_card_fundings (card_id) WHERE status = 'processing'`,
  'CREATE INDEX IF NOT EXISTS virtual_card_fundings_card_id_created_at_idx ON virtual_card_fundings (card_id, created_at)',
  'CREATE INDEX IF NOT EXISTS virtual_card_fundings_status_updated_at_idx ON virtual_card_fundings (status, updated_at)',
  'CREATE INDEX IF NOT EXISTS virtual_card_fundings_user_id_created_at_idx ON virtual_card_fundings (user_id, created_at)',

  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_transactions_provider_txn_id_key ON virtual_card_transactions (provider_txn_id)',
  'CREATE INDEX IF NOT EXISTS virtual_card_transactions_card_id_occurred_at_idx ON virtual_card_transactions (card_id, occurred_at)',

  'CREATE INDEX IF NOT EXISTS virtual_card_events_card_id_created_at_idx ON virtual_card_events (card_id, created_at)',

  // A resend of the same delivery is recognised by this, not processed twice.
  'CREATE UNIQUE INDEX IF NOT EXISTS virtual_card_webhooks_delivery_key_key ON virtual_card_webhooks (delivery_key)',
  'CREATE INDEX IF NOT EXISTS virtual_card_webhooks_received_at_idx ON virtual_card_webhooks (received_at)',
];

function createStatement(table, columns) {
  const body = columns.map(([name, type, constraints]) => `     ${name} ${type}${constraints ? ` ${constraints}` : ''}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${body}\n   )`;
}

/**
 * Every column, added if missing. On a table that already holds rows a NOT
 * NULL column with no DEFAULT cannot be added as such, so it goes in nullable
 * - the code always writes it - and the script says so.
 */
async function ensureColumns(client, table, columns) {
  const { rows } = await client.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  const has = new Set(rows.map(r => r.column_name));
  const added = [];
  for (const [name, type, constraints] of columns) {
    if (has.has(name) || /PRIMARY KEY/.test(constraints)) continue;
    const keep = /DEFAULT/.test(constraints) ? constraints.replace(/\s*REFERENCES.*$/, '') : constraints.replace(/NOT NULL\s*/, '').replace(/\s*REFERENCES.*$/, '');
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}${keep.trim() ? ` ${keep.trim()}` : ''}`);
    added.push(name);
  }
  return added;
}

/** An A record for `hostname`, tried three ways - see apply-cac-ddl.js. */
async function resolveHostIp(hostname) {
  try {
    const { address } = await dns.promises.lookup(hostname, { family: 4 });
    return { ip: address, via: 'OS resolver (retry)' };
  } catch (_) { /* fall through */ }

  const configured = dns.promises.getServers().filter(s => !/^(127\.|::1$|0\.0\.0\.0)/.test(s));
  for (const [servers, via] of [[configured, 'configured DNS'], [['1.1.1.1', '8.8.8.8'], 'public DNS']]) {
    if (!servers.length) continue;
    try {
      const resolver = new dns.promises.Resolver();
      resolver.setServers(servers);
      const [ip] = await resolver.resolve4(hostname);
      if (ip) return { ip, via };
    } catch (_) { /* try the next set */ }
  }
  throw new Error(`could not resolve ${hostname}. DNS is down on this machine - check the router, or run this script from a network that resolves.`);
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

async function main() {
  const client = await connect();
  await client.query('BEGIN');
  try {
    for (const [table, columns] of Object.entries(TABLES)) {
      await client.query(createStatement(table, columns));
      const added = await ensureColumns(client, table, columns);
      console.log(`ok    ${table}${added.length ? ` (added ${added.join(', ')})` : ''}`);
    }
    for (const sql of INDEXES) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /, '').trim()}`);
    }
    // updated_at has no database default on app_settings (Prisma stamps it
    // client-side), so it is set here. DO NOTHING: the dashboard's value stands.
    for (const [key, value, description] of STARTING_SETTINGS) {
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
  console.log('next  in the dashboard (USD Cards > Settings): set the card creation price - no card can be bought until it is set -');
  console.log('      and the dollar rate (what $1 costs VoltPay) - top-ups stay off until it is set.');
}

if (require.main === module) {
  main().catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { TABLES, INDEXES, STARTING_SETTINGS, createStatement, ensureColumns };
