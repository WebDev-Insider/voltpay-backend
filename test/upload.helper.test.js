/**
 * node test/upload.helper.test.js
 *
 * No network: covers the URL -> file key parsing that decides whether a
 * replaced profile picture actually gets deleted from UploadThing.
 */
const assert = require('assert');

process.env.UPLOADTHING_TOKEN = process.env.UPLOADTHING_TOKEN || 'test-token';

const { fileKeyFromUrl, isUploadThingUrl, describeTokenProblem } = require('../src/helpers/upload.helper');

/* -------------------------------------------------------------------------- */
/* Token shape                                                                 */
/* -------------------------------------------------------------------------- */

// Production lost every support attachment to `Invalid token. A token is a
// base64 encoded JSON object matching { apiKey, appId, regions[] }`. UploadThing
// decodes with Effect's STRICT base64 schema, so a wrapping quote or a dropped
// '=' is fatal - while Node's own Buffer.from() ignores both and decodes fine.
// That is why "it works locally" did not catch it, and why these cases exist.
const validToken = Buffer.from(
  JSON.stringify({ apiKey: 'sk_test_abc', appId: '81koz5bvw8', regions: ['sea1'] })
).toString('base64');

assert.strictEqual(describeTokenProblem(validToken), null, 'a well formed v7 token has no problem');

for (const [label, token] of [
  ['wrapping double quotes', `"${validToken}"`],
  ['wrapping single quotes', `'${validToken}'`],
  ['trailing space', `${validToken} `],
  ['leading space', ` ${validToken}`],
]) {
  assert.match(
    describeTokenProblem(token),
    /not base64/,
    `${label} is reported as a non-base64 character, not a vague failure`
  );
}

assert.match(
  describeTokenProblem(validToken.replace(/=+$/, '')),
  /multiple of 4|not base64/,
  'stripped "=" padding is caught'
);
// Two different wrong-content cases, and they get different advice: a legacy
// sk_live secret is base64-clean but decodes to a bare string, while a v6-era
// token decodes to JSON of the wrong shape.
assert.match(
  describeTokenProblem(Buffer.from('sk_live_legacysecretvalue').toString('base64')),
  /does not decode to JSON/,
  'a legacy secret is base64 but is not JSON'
);
assert.match(
  describeTokenProblem(Buffer.from(JSON.stringify({ secret: 'x', appId: 'y' })).toString('base64')),
  /not \{ apiKey, appId, regions/,
  'JSON of the wrong shape is named as such'
);

// The message must never carry the token - it holds the account apiKey.
for (const bad of [`"${validToken}"`, `${validToken} `, validToken.slice(0, -4)]) {
  const message = describeTokenProblem(bad) || '';
  assert.ok(!message.includes(bad.slice(4, 20)), 'the problem description never quotes the token back');
}

assert.strictEqual(fileKeyFromUrl('https://81koz5bvw8.ufs.sh/f/abc123XYZ'), 'abc123XYZ');
assert.strictEqual(fileKeyFromUrl('https://utfs.io/f/abc123XYZ'), 'abc123XYZ', 'legacy utfs.io urls still parse');
assert.strictEqual(fileKeyFromUrl('https://81koz5bvw8.ufs.sh/f/abc123XYZ?v=2'), 'abc123XYZ', 'query string is not part of the key');
assert.strictEqual(fileKeyFromUrl('https://81koz5bvw8.ufs.sh/f/abc123XYZ/'), 'abc123XYZ');

// Anything that is not ours must not produce a key - deleteFiles on a guessed
// key would be a delete against someone else's file.
assert.strictEqual(fileKeyFromUrl('https://example.com/f/abc123XYZ'), '');
assert.strictEqual(fileKeyFromUrl(''), '');
assert.strictEqual(fileKeyFromUrl(null), '');
assert.strictEqual(isUploadThingUrl('https://example.com/img.png'), false);

console.log('✅ upload.helper tests passed');
