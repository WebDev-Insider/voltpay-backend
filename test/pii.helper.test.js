/**
 * Self-check for src/helpers/pii.helper.js.
 * Run: node test/pii.helper.test.js
 */

const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');

const pii = require('../src/helpers/pii.helper');

async function main() {

// --- primitive -------------------------------------------------------------
// Official BLAKE3 test vector. Guards against a bad swap of the digest: if this
// fails the library is not computing BLAKE3 and nothing below can be trusted.
const { blake3 } = require('@noble/hashes/blake3.js');
assert.strictEqual(
  Buffer.from(blake3(Buffer.from('abc'))).toString('hex'),
  '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85',
  'BLAKE3("abc") must match the spec vector'
);

// --- verify-only secrets ---------------------------------------------------
const pinHash = await pii.hashSecret('1234', 'pin');
assert.ok(!pinHash.includes('1234'), 'hash must not contain the plaintext');
assert.ok(pinHash.startsWith('b3v1$'), 'hash must carry a version tag');
assert.strictEqual((await pii.verifySecret('1234', pinHash, 'pin')).ok, true, 'correct PIN verifies');
assert.strictEqual((await pii.verifySecret('1235', pinHash, 'pin')).ok, false, 'wrong PIN rejected');

// Salted: same input, different stored value each time.
assert.notStrictEqual(pinHash, await pii.hashSecret('1234', 'pin'), 'salt must randomise the digest');

// Domain-separated: a PIN hash must not validate as a password.
assert.strictEqual((await pii.verifySecret('1234', pinHash, 'password')).ok, false, 'domains must not cross');

// A plain-text leftover must never authenticate.
assert.strictEqual((await pii.verifySecret('1234', '1234', 'pin')).ok, false, 'plain-text column must be rejected');
assert.strictEqual((await pii.verifySecret('', pinHash, 'pin')).ok, false, 'empty input rejected');
assert.strictEqual((await pii.verifySecret('1234', null, 'pin')).ok, false, 'null column rejected');

// Legacy bcrypt rows still work and are flagged for upgrade.
const bcryptHash = require('bcryptjs').hashSync('1234', 10);
const legacy = await pii.verifySecret('1234', bcryptHash, 'pin');
assert.ok(legacy.ok && legacy.needsRehash, 'legacy bcrypt verifies and requests rehash');

// Pre-Blake3 rows (keyed blake2b512) also verify and are flagged for upgrade,
// so a digest swap never locks anyone out.
const legacyB2b = (() => {
  const salt = crypto.randomBytes(16);
  const peppered = crypto
    .createHmac('blake2b512', Buffer.from(process.env.PII_HASH_KEY, 'hex'))
    .update('pin').update('\x00').update('1234', 'utf8')
    .digest();
  const digest = crypto.scryptSync(peppered, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `b2b1$${salt.toString('base64')}$${digest.toString('base64')}`;
})();
const upgraded = await pii.verifySecret('1234', legacyB2b, 'pin');
assert.ok(upgraded.ok && upgraded.needsRehash, 'blake2b row verifies and requests rehash');
assert.strictEqual((await pii.verifySecret('9999', legacyB2b, 'pin')).ok, false, 'wrong PIN still rejected on legacy row');

// --- reversible PII --------------------------------------------------------
const { enc, idx } = pii.protect('User@Example.COM ', 'email');
assert.ok(!enc.includes('example'), 'ciphertext must not leak the plaintext');
assert.strictEqual(pii.reveal(enc), 'User@Example.COM', 'round-trips exactly');

// Blind index is deterministic after normalisation, so lookups match.
assert.strictEqual(idx, pii.blindIndex('user@example.com', 'email'), 'index normalises case/space');
assert.notStrictEqual(idx, pii.blindIndex('user@example.com', 'username'), 'index is domain-scoped');

// Nigerian mobile variants normalise to digits only.
assert.strictEqual(pii.blindIndex('+234 803 111 2222', 'mobile'), pii.blindIndex('2348031112222', 'mobile'));

// GCM must reject tampering rather than return garbage.
const [iv, tag, ct] = enc.split(':');
const flipped = Buffer.from(ct, 'base64');
flipped[0] ^= 0xff;
assert.throws(() => pii.reveal(`${iv}:${tag}:${flipped.toString('base64')}`), 'tampered ciphertext must throw');

assert.strictEqual(pii.reveal(null), '', 'unset column reads as empty');
assert.deepStrictEqual(pii.protect('', 'email'), { enc: null, idx: null }, 'empty input stores nothing');

// --- user field mapping ----------------------------------------------------
const row = pii.protectUserFields({ firstname: 'Ada', email: 'ada@voltpay.ng', mobile: '08031112222' });
assert.strictEqual(row.firstname, null, 'plain column is explicitly nulled');
assert.strictEqual(row.email, null, 'plain column is explicitly nulled');
assert.ok(row.firstname_enc && row.email_enc && row.mobile_enc, 'ciphertext columns written');
assert.ok(row.email_idx && row.mobile_idx, 'indexed fields get an index');
assert.strictEqual(row.firstname_idx, undefined, 'non-indexed fields get no index');

const revealed = pii.revealUserFields({ id: 1, ...row });
assert.strictEqual(revealed.firstname, 'Ada');
assert.strictEqual(revealed.email, 'ada@voltpay.ng');

// Mid-migration rows (plain still present, no ciphertext yet) still read.
assert.strictEqual(pii.revealUserFields({ id: 2, firstname: 'Legacy' }).firstname, 'Legacy');

// --- balance integrity -----------------------------------------------------
// Owner key is the `<wallet>:<ownerId>` string balance.helper.js builds.
const mac = pii.balanceMac('user:7', '1500.00');
assert.ok(pii.verifyBalanceMac('user:7', '1500.00', mac), 'untouched balance verifies');
assert.ok(!pii.verifyBalanceMac('user:7', '9500.00', mac), 'edited balance fails');
assert.ok(!pii.verifyBalanceMac('user:8', '1500.00', mac), 'balance MAC is bound to the owner');
assert.ok(!pii.verifyBalanceMac('staffPayWallet:7', '1500.00', mac), 'balance MAC is bound to the wallet type');
assert.ok(!pii.verifyBalanceMac('user:7', '1500.00', null), 'missing MAC fails');

// --- key isolation ---------------------------------------------------------
// A different key must not decrypt or match. Nothing is readable without env.
const realEnc = process.env.PII_ENC_KEY;
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
assert.throws(() => pii.reveal(enc), 'wrong key must not decrypt');
process.env.PII_ENC_KEY = realEnc;

process.env.PII_HASH_KEY = '';
assert.throws(() => pii.blindIndex('a@b.com', 'email'), 'missing key must fail loudly, not silently');

  console.log('✅ pii.helper: all checks passed');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
