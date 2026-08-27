#!/usr/bin/env node
/**
 * One-time backfill: encrypt existing plain-text user PII into the *_enc /
 * *_idx columns, seed balance_mac, and re-hash any plain-text PIN.
 *
 * Order of operations for a live deploy:
 *   1. npm run prisma:db:push        (adds the new nullable columns)
 *   2. node scripts/backfill-pii.js  (this script, idempotent, safe to re-run)
 *   3. node scripts/backfill-pii.js --verify   (confirms 0 rows left plain)
 *   4. Drop the plain columns once step 3 is clean:
 *        ALTER TABLE users
 *          DROP COLUMN firstname, DROP COLUMN lastname, DROP COLUMN username,
 *          DROP COLUMN email,     DROP COLUMN mobile,   DROP COLUMN address,
 *          DROP COLUMN state,     DROP COLUMN city,     DROP COLUMN zip;
 *        ALTER TABLE password_resets
 *          DROP COLUMN email, DROP COLUMN token;
 *      ...then delete those fields from schema.prisma and re-push.
 *
 * Requires PII_HASH_KEY and PII_ENC_KEY to be set to their final production
 * values. Backfilling under one key and serving under another leaves every
 * blind index unmatchable, which reads as "all users vanished".
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const prisma = require('../database/prisma');
const {
  protectUserFields,
  hashSecret,
  balanceMac,
  blindIndex,
  reveal,
  USER_PII_FIELDS,
  USER_INDEXED_FIELDS,
} = require('../src/helpers/pii.helper');

const PLAIN_FIELDS = Object.keys(USER_PII_FIELDS);
const BATCH = 200;

function hasPlainText(user) {
  return PLAIN_FIELDS.some(f => user[f] !== null && user[f] !== undefined && String(user[f]) !== '');
}

function isLegacyPlainPin(pin) {
  const v = String(pin || '');
  if (!v) return false;
  const hashed = /^\$2[aby]?\$/.test(v) || v.startsWith('b3v1$') || v.startsWith('b2b1$');
  return !hashed;
}

async function verify() {
  const total = await prisma.user.count();
  const users = await prisma.user.findMany({ select: { id: true, pin: true, balance_mac: true, ...Object.fromEntries(PLAIN_FIELDS.map(f => [f, true])) } });
  const plain = users.filter(hasPlainText);
  const plainPins = users.filter(u => isLegacyPlainPin(u.pin));
  const noMac = users.filter(u => !u.balance_mac);

  console.log(`users:              ${total}`);
  console.log(`rows w/ plain PII:  ${plain.length}${plain.length ? ` (ids: ${plain.slice(0, 10).map(u => u.id).join(', ')}${plain.length > 10 ? '...' : ''})` : ''}`);
  console.log(`rows w/ plain PIN:  ${plainPins.length}`);
  console.log(`rows w/o balance_mac: ${noMac.length}`);
  const clean = !plain.length && !plainPins.length && !noMac.length;
  console.log(clean ? '\n✅ clean - safe to drop the plain columns' : '\n❌ not clean - re-run the backfill');
  return clean;
}

async function backfill() {
  let cursor = 0;
  let migrated = 0;
  let clearedPins = 0;

  for (;;) {
    const users = await prisma.user.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (!users.length) break;
    cursor = users[users.length - 1].id;

    for (const user of users) {
      const data = {};

      // Only protect fields that still hold plain text; a row already migrated
      // (enc set, plain null) is skipped so re-runs cost nothing and never
      // re-encrypt an empty value over a good one.
      const patch = {};
      for (const field of PLAIN_FIELDS) {
        const plain = user[field];
        if (plain === null || plain === undefined || String(plain) === '') continue;
        if (user[`${field}_enc`]) {
          // Already encrypted; just drop the plain copy.
          data[field] = null;
          continue;
        }
        patch[field] = plain;
      }
      Object.assign(data, protectUserFields(patch));

      // A plain-text PIN cannot be recovered into the new scheme any other way:
      // we have the value here, so hash it now rather than leaving it readable.
      if (isLegacyPlainPin(user.pin)) {
        data.pin = await hashSecret(user.pin, 'pin');
        clearedPins++;
      }

      if (!user.balance_mac) {
        data.balance_mac = balanceMac(`user:${user.id}`, user.balance?.toString?.() ?? String(user.balance ?? '0'));
      }

      if (!Object.keys(data).length) continue;
      await prisma.user.update({ where: { id: user.id }, data });
      migrated++;
    }

    console.log(`... processed through id=${cursor} (${migrated} updated)`);
  }

  console.log(`\nBackfill done. rows updated: ${migrated}, plain PINs hashed: ${clearedPins}`);

  // StaffPay company wallets carry the same tamper evidence as user wallets.
  const wallets = await prisma.staffPayWallet.findMany({ where: { balance_mac: null } });
  for (const w of wallets) {
    await prisma.staffPayWallet.update({
      where: { company_id: w.company_id },
      data: { balance_mac: balanceMac(`staffPayWallet:${w.company_id}`, w.balance.toString()) },
    });
  }
  console.log(`StaffPay wallets stamped: ${wallets.length}`);

  // Reset rows live 5 minutes, so there is nothing worth migrating - just clear
  // the plain email and the live OTP off any row still holding them.
  const cleared = await prisma.passwordReset.updateMany({
    where: { OR: [{ email: { not: null } }, { token: { not: '' } }] },
    data: { email: null, token: '' },
  });
  console.log(`Password-reset rows cleared: ${cleared.count}`);
}

/**
 * Recompute every blind index from the existing ciphertext. Needed after the
 * hash primitive or PII_HASH_KEY changes: the *_enc columns are unaffected
 * (different key, AES) but every *_idx becomes unmatchable, which presents as
 * "no user found" on login. Ciphertext is the source of truth here, so this is
 * safe to run at any point after the initial backfill.
 */
async function reindex() {
  let cursor = 0;
  let updated = 0;

  for (;;) {
    const users = await prisma.user.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (!users.length) break;
    cursor = users[users.length - 1].id;

    for (const user of users) {
      const data = {};
      for (const field of USER_INDEXED_FIELDS) {
        const enc = user[`${field}_enc`];
        if (!enc) continue;
        data[`${field}_idx`] = blindIndex(reveal(enc), USER_PII_FIELDS[field]);
      }
      if (!Object.keys(data).length) continue;
      await prisma.user.update({ where: { id: user.id }, data });
      updated++;
    }
    console.log(`... reindexed through id=${cursor} (${updated} updated)`);
  }

  console.log(`\nReindex done. rows updated: ${updated}`);
}

async function main() {
  const verifyOnly = process.argv.includes('--verify');
  const reindexOnly = process.argv.includes('--reindex');
  try {
    if (reindexOnly) {
      await reindex();
    } else if (verifyOnly) {
      const clean = await verify();
      process.exitCode = clean ? 0 : 1;
    } else {
      await backfill();
      await verify();
    }
  } catch (e) {
    console.error('Backfill failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => null);
  }
}

main();
