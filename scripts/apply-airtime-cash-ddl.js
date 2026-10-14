// Airtime to Cash: conversions, their event trail, and the bank payouts.
//
//   airtime_cash_conversions  one row per attempt, from the OTP onwards
//       UNIQUE (reference), UNIQUE (provider_request_id) - one row per
//       MySubWallet request-id, so a requery always names exactly one row.
//   airtime_cash_events       status changes, OTP sends and admin notes
//   airtime_cash_withdrawals  one Paystack transfer each
//       UNIQUE (reference) - the transfer reference, so the webhook and the
//       poll can only ever settle one row.
//
// No foreign key to users, on purpose: like wallet_transactions, a record of
// money owed is never cascaded away with an account.
//
// Additive only: three new tables, nothing existing is touched. Prisma CLI
// cannot reach Neon from this machine, so the DDL goes over pg on DIRECT_URL
// like every other script here. Re-running is a no-op.
require('dotenv').config();
const { Client } = require('pg');
const dns = require('dns');

const STATEMENTS = [
  // Withdrawals first: conversions point at them.
  `CREATE TABLE IF NOT EXISTS airtime_cash_withdrawals (
     id                 serial PRIMARY KEY,
     user_id            integer NOT NULL,
     reference          text NOT NULL,
     amount             numeric(15,2) NOT NULL,
     fee                numeric(15,2) NOT NULL DEFAULT 0,
     provider_fee       numeric(15,2) NOT NULL DEFAULT 0,
     conversion_count   integer NOT NULL DEFAULT 0,
     bank_code          text NOT NULL,
     bank_name          text,
     account_number_enc text NOT NULL,
     account_number_idx text NOT NULL,
     account_last4      text,
     account_name_enc   text,
     account_source     text,
     save_account       boolean NOT NULL DEFAULT false,
     recipient_code     text,
     transfer_code      text,
     status             text NOT NULL DEFAULT 'pending',
     failure_reason     text,
     provider_message   text,
     submitted_at       timestamp(3),
     completed_at       timestamp(3),
     created_at         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS airtime_cash_withdrawals_reference_key
     ON airtime_cash_withdrawals (reference)`,
  `CREATE INDEX IF NOT EXISTS airtime_cash_withdrawals_user_id_created_at_idx
     ON airtime_cash_withdrawals (user_id, created_at)`,
  // The sweep's in-flight scan: pending/processing rows by age.
  `CREATE INDEX IF NOT EXISTS airtime_cash_withdrawals_status_updated_at_idx
     ON airtime_cash_withdrawals (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS airtime_cash_withdrawals_account_number_idx_idx
     ON airtime_cash_withdrawals (account_number_idx)`,

  `CREATE TABLE IF NOT EXISTS airtime_cash_conversions (
     id                     serial PRIMARY KEY,
     user_id                integer NOT NULL,
     reference              text NOT NULL,
     network                text NOT NULL,
     phone_enc              text NOT NULL,
     phone_idx              text NOT NULL,
     phone_format           text,
     status                 text NOT NULL DEFAULT 'awaiting_otp',
     amount                 numeric(15,2),
     payout_rate_bps        integer,
     fee                    numeric(15,2),
     payout                 numeric(15,2),
     provider_rate_bps      integer,
     provider_credit        numeric(15,2),
     margin                 numeric(15,2),
     provider_status        text,
     provider_request_id    text,
     provider_message       text,
     provider_token_enc     text,
     otp_sends              integer NOT NULL DEFAULT 0,
     otp_attempts           integer NOT NULL DEFAULT 0,
     convert_attempts       integer NOT NULL DEFAULT 0,
     otp_sent_at            timestamp(3),
     otp_expires_at         timestamp(3),
     otp_verified_at        timestamp(3),
     submitted_at           timestamp(3),
     converted_at           timestamp(3),
     provider_checked_at    timestamp(3),
     available_at           timestamp(3),
     settled_by             text,
     withdrawal_id          integer REFERENCES airtime_cash_withdrawals(id) ON DELETE SET NULL ON UPDATE CASCADE,
     withdrawn_at           timestamp(3),
     failed_at              timestamp(3),
     failure_reason         text,
     unconfirmed_alerted_at timestamp(3),
     settlement_alerted_at  timestamp(3),
     created_at             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS airtime_cash_conversions_reference_key
     ON airtime_cash_conversions (reference)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS airtime_cash_conversions_provider_request_id_key
     ON airtime_cash_conversions (provider_request_id)`,
  `CREATE INDEX IF NOT EXISTS airtime_cash_conversions_user_id_created_at_idx
     ON airtime_cash_conversions (user_id, created_at)`,
  // The admin queue and every sweep pass lead with status.
  `CREATE INDEX IF NOT EXISTS airtime_cash_conversions_status_created_at_idx
     ON airtime_cash_conversions (status, created_at)`,
  // The per-line OTP cap counts sends to one line across every account.
  `CREATE INDEX IF NOT EXISTS airtime_cash_conversions_phone_idx_created_at_idx
     ON airtime_cash_conversions (phone_idx, created_at)`,
  `CREATE INDEX IF NOT EXISTS airtime_cash_conversions_withdrawal_id_idx
     ON airtime_cash_conversions (withdrawal_id)`,

  `CREATE TABLE IF NOT EXISTS airtime_cash_events (
     id            serial PRIMARY KEY,
     conversion_id integer NOT NULL REFERENCES airtime_cash_conversions(id) ON DELETE CASCADE ON UPDATE CASCADE,
     event         text NOT NULL,
     from_status   text,
     to_status     text,
     actor         text NOT NULL DEFAULT 'system',
     note          text,
     meta          jsonb,
     created_at    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS airtime_cash_events_conversion_id_created_at_idx
     ON airtime_cash_events (conversion_id, created_at)`,
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

(async () => {
  const client = await connect();

  await client.query('BEGIN');
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].trim()}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
