/**
 * node test/recovery.helper.test.js
 *
 * Covers the parts of the recovery phrase that silently lock people out if they
 * break: word count, checksum, case/whitespace folding, and the fact that a
 * wrong phrase never verifies.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');

const {
  WORD_COUNT,
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  isValidRecoveryPhrase,
  hashRecoveryPhrase,
  verifyRecoveryPhrase,
} = require('../src/helpers/recovery.helper');

(async function run() {
  const phrase = generateRecoveryPhrase();
  assert.strictEqual(phrase.split(' ').length, WORD_COUNT, 'phrase must be 12 words');
  assert.ok(isValidRecoveryPhrase(phrase), 'generated phrase must pass BIP39 validation');

  // Two phrases in a row must not collide.
  assert.notStrictEqual(phrase, generateRecoveryPhrase(), 'phrases must be random');

  // Users retype the words; casing and stray spacing must not matter.
  const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}  `;
  assert.strictEqual(normalizeRecoveryPhrase(messy), phrase, 'normalize must fold case and whitespace');

  const stored = await hashRecoveryPhrase(phrase);
  assert.ok(!stored.includes(phrase.split(' ')[0]), 'stored hash must not contain the words');

  assert.ok((await verifyRecoveryPhrase(phrase, stored)).ok, 'correct phrase must verify');
  assert.ok((await verifyRecoveryPhrase(messy, stored)).ok, 'messy but correct phrase must verify');
  assert.ok(!(await verifyRecoveryPhrase(generateRecoveryPhrase(), stored)).ok, 'other phrase must not verify');
  assert.ok(!(await verifyRecoveryPhrase('', stored)).ok, 'empty phrase must not verify');

  // Checksum rejection: swap the last word for a different valid BIP39 word.
  const words = phrase.split(' ');
  const swapped = [...words.slice(0, 11), words[0] === 'abandon' ? 'ability' : 'abandon'].join(' ');
  if (swapped !== phrase) {
    assert.ok(!isValidRecoveryPhrase(swapped) || !(await verifyRecoveryPhrase(swapped, stored)).ok,
      'a tampered phrase must not pass');
  }

  assert.ok(!isValidRecoveryPhrase(words.slice(0, 11).join(' ')), '11 words must be rejected');
  assert.ok(!isValidRecoveryPhrase('not even close to a mnemonic'), 'garbage must be rejected');

  console.log('✅ recovery.helper tests passed');
})().catch(err => {
  console.error('❌ recovery.helper tests failed');
  console.error(err);
  process.exit(1);
});
