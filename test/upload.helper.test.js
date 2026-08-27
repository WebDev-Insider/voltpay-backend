/**
 * node test/upload.helper.test.js
 *
 * No network: covers the URL -> file key parsing that decides whether a
 * replaced profile picture actually gets deleted from UploadThing.
 */
const assert = require('assert');

process.env.UPLOADTHING_TOKEN = process.env.UPLOADTHING_TOKEN || 'test-token';

const { fileKeyFromUrl, isUploadThingUrl } = require('../src/helpers/upload.helper');

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
