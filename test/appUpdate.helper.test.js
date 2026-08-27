/**
 * node test/appUpdate.helper.test.js
 *
 * Version comparison is the one piece of this feature with no safe failure
 * mode. Get it wrong in one direction and a build with a known money bug keeps
 * transacting; get it wrong in the other and every handset in the country is
 * staring at an Update Required screen it cannot dismiss, with a wallet behind
 * it. Neither shows up in a normal test run, so the comparison and the two
 * refused admin states are pinned here.
 *
 * Pure functions only - nothing below touches Postgres or Redis.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const {
  compareVersions,
  parseVersion,
  isValidVersion,
  evaluate,
  downloadLink,
  __test: { isValidUrl, toBool },
} = require('../src/helpers/appUpdate.helper');

function main() {
  // --- ordering ------------------------------------------------------------
  assert.strictEqual(compareVersions('1.0.3', '1.0.5'), -1, '1.0.3 is older than 1.0.5');
  assert.strictEqual(compareVersions('1.0.5', '1.0.3'), 1);
  assert.strictEqual(compareVersions('1.0.5', '1.0.5'), 0);

  // The classic string-comparison bug: '1.0.10' < '1.0.9' alphabetically.
  assert.strictEqual(compareVersions('1.0.9', '1.0.10'), -1, 'segments compare as numbers, not text');
  assert.strictEqual(compareVersions('1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareVersions('2.0.0', '1.99.99'), 1, 'major outranks everything below it');

  // Missing segments are zeros, so these are the same release.
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.2', '1.2.1'), -1);

  // --- shapes a real pubspec / dashboard produces --------------------------
  // `+12` is Flutter's build number: metadata, never precedence. Comparing it
  // would make 1.0.5+9 look newer than 1.0.5+10.
  assert.strictEqual(compareVersions('1.0.5+12', '1.0.5'), 0, 'build number is not precedence');
  assert.strictEqual(compareVersions('1.0.5+9', '1.0.5+10'), 0);
  assert.strictEqual(compareVersions('v1.0.5', '1.0.5'), 0, 'a leading v is cosmetic');
  assert.strictEqual(compareVersions(' 1.0.5 ', '1.0.5'), 0, 'whitespace from a copy-paste');

  // Semver 11: a prerelease sits below the release it leads to.
  assert.strictEqual(compareVersions('1.0.5-beta', '1.0.5'), -1);
  assert.strictEqual(compareVersions('1.0.5-beta', '1.0.5-beta.2'), -1);
  assert.strictEqual(compareVersions('1.0.5-alpha', '1.0.5-beta'), -1);
  assert.strictEqual(compareVersions('1.0.5-2', '1.0.5-10'), -1, 'numeric prerelease ids compare numerically');

  // --- junk is "cannot judge", never "older" -------------------------------
  // This is the guard that keeps a typo in the dashboard from locking the
  // installed base out: null propagates to update_required === false.
  for (const bad of ['', '   ', null, undefined, 'latest', '1.0.x', '1..0', 'v', '1.0.5.6.7', {}, []]) {
    assert.strictEqual(compareVersions(bad, '1.0.5'), null, `"${String(bad)}" must not compare`);
    assert.strictEqual(compareVersions('1.0.5', bad), null, `"${String(bad)}" must not compare`);
    assert.strictEqual(isValidVersion(bad), false, `"${String(bad)}" must not validate`);
  }
  assert.strictEqual(parseVersion('1.0.5').nums.join('.'), '1.0.5');
  assert.ok(isValidVersion('1.0.5') && isValidVersion('1.0') && isValidVersion('10.20.30'));

  // --- the verdict ---------------------------------------------------------
  const rules = {
    is_active: true,
    force_update: true,
    latest_version: '1.0.5',
    min_version: '1.0.5',
    message: 'Please update',
    android_download_url: 'https://voltpay.ng/voltpay-1.0.5.apk',
    update_page_url: '',
  };

  const old = evaluate('1.0.3', rules);
  assert.strictEqual(old.update_required, true, 'a build below the minimum is blocked');
  assert.strictEqual(old.update_available, true);

  const current = evaluate('1.0.5', rules);
  assert.strictEqual(current.update_required, false, 'the newest build is never blocked');
  assert.strictEqual(current.update_available, false);

  // A tester ahead of the release must not be blocked or nagged.
  const ahead = evaluate('1.1.0', rules);
  assert.strictEqual(ahead.update_required, false);
  assert.strictEqual(ahead.update_available, false);

  // Soft update: offered, never enforced.
  const soft = evaluate('1.0.3', { ...rules, force_update: false });
  assert.strictEqual(soft.update_required, false, 'force off means nobody is blocked');
  assert.strictEqual(soft.update_available, true, 'but the prompt still shows');

  // Behind latest, at or above minimum - the ordinary "there is a new one" case.
  const behind = evaluate('1.0.4', { ...rules, min_version: '1.0.0' });
  assert.strictEqual(behind.update_required, false);
  assert.strictEqual(behind.update_available, true);

  // --- every fail-open path ------------------------------------------------
  assert.strictEqual(evaluate('1.0.3', { ...rules, is_active: false }).update_required, false, 'switched off blocks nobody');
  assert.strictEqual(evaluate('1.0.3', { ...rules, is_active: false }).update_available, false);
  assert.strictEqual(evaluate('', rules).update_required, false, 'an app that cannot name its version is let through');
  assert.strictEqual(evaluate('not-a-version', rules).update_required, false);
  assert.strictEqual(evaluate('1.0.3', { ...rules, min_version: '' }).update_required, false, 'no minimum blocks nobody');
  assert.strictEqual(evaluate('1.0.3', { ...rules, min_version: 'oops' }).update_required, false);
  assert.strictEqual(evaluate('1.0.3', {}).update_required, false, 'blank settings block nobody');
  assert.strictEqual(evaluate('1.0.3', null).update_required, false);

  // --- the link the button opens ------------------------------------------
  assert.strictEqual(downloadLink(rules), 'https://voltpay.ng/voltpay-1.0.5.apk', 'APK wins when both are set');
  assert.strictEqual(
    downloadLink({ android_download_url: '', update_page_url: 'https://voltpay.ng/download' }),
    'https://voltpay.ng/download',
    'the web page is the fallback'
  );
  assert.strictEqual(downloadLink({}), '');

  // --- input the admin form has to reject ---------------------------------
  assert.ok(isValidUrl('https://voltpay.ng/app.apk'));
  assert.ok(isValidUrl('http://voltpay.ng/app.apk'));
  assert.ok(isValidUrl(''), 'empty means "not set", which is allowed');
  // Neither the Android WebView nor the Flutter web build can open these.
  assert.strictEqual(isValidUrl('voltpay.ng/app.apk'), false, 'a bare host is not a link');
  assert.strictEqual(isValidUrl('javascript:alert(1)'), false);
  assert.strictEqual(isValidUrl('market://details?id=ng.voltpay'), false);

  // The dashboard sends JSON booleans; a curl or an older client sends strings.
  for (const on of [true, 'true', 'on', 1, '1', 'yes']) assert.strictEqual(toBool(on), true, `${on} is on`);
  for (const off of [false, 'false', 'off', 0, '0', 'no', 'anything']) assert.strictEqual(toBool(off), false, `${off} is off`);
  assert.strictEqual(toBool(undefined), false, 'absent is off');
  assert.strictEqual(toBool(null, true), true, 'absent takes the caller fallback');

  console.log('✅ appUpdate.helper tests passed');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
