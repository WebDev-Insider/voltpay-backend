// Force update. One admin call decides which app builds are still allowed in.
//
// The case this exists for: a build ships with a bug that costs money - a wrong
// fee, a double debit, a rail that mis-vends - and the fix is already on the
// website as an APK. Nothing pushes it onto the handsets by itself, so until
// the user is told to update they keep transacting on the broken build. This is
// how they are told, and how they are stopped when telling is not enough.
//
// Settings live in app_settings, exactly like the kill switches in
// featureFlag.helper: already backed up, already visible to the dashboard,
// survives a restart, no migration. Cached for APP_UPDATE_TTL seconds only -
// a release rule that takes ten minutes to reach the first handset is not
// useful during a rollout. Reference data uses 600s; this deliberately does not.
//
// Reads fail OPEN - if the rules cannot be read, nobody is blocked. A cache or
// database blip must never lock the entire installed base out of a wallet they
// have money in. Being one release behind for an hour is recoverable; being
// unable to open the app is not.

const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const TTL = Number(process.env.APP_UPDATE_TTL_SECONDS || 30);

const CACHE_KEY = redis.key('app_update', 'settings');

// setting_key -> the name the API speaks. Keeping the map in one place means
// the reader, the writer and the cache invalidation cannot drift apart.
const KEYS = {
  latest_version: 'app_update_latest_version',
  min_version: 'app_update_min_version',
  force_update: 'app_update_force',
  android_download_url: 'app_update_android_url',
  update_page_url: 'app_update_page_url',
  message: 'app_update_message',
  is_active: 'app_update_active',
};

const DESCRIPTIONS = {
  latest_version: 'Newest VoltPay build available for download',
  min_version: 'Oldest VoltPay build still allowed to run',
  force_update: 'Block builds below the minimum version (on/off)',
  android_download_url: 'Direct APK download link',
  update_page_url: 'Web page users are sent to when there is no direct link',
  message: 'Text shown on the update screen',
  is_active: 'Whether these update rules are enforced at all (on/off)',
};

const ON_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);

const MESSAGE_MAX = 300;
const DEFAULT_MESSAGE = 'Please update VoltPay to continue.';

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ON_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * `1.0.5`, `v1.0.5`, `1.0.5+12`, `1.0.5-beta.2` -> comparable parts.
 *
 * The `+12` is Flutter's build number: pubspec writes `version: 1.0.5+12` and
 * package_info_plus reports the two separately, but a hand-typed value in the
 * dashboard may well carry it. It is metadata, not precedence (semver 10), so
 * it is dropped rather than compared - otherwise `1.0.5+9` would read as newer
 * than `1.0.5+10`.
 *
 * Returns null for anything that is not a version at all. Callers treat null
 * as "cannot judge", never as "older".
 */
function parseVersion(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const cleaned = text.replace(/^[vV]/, '').split('+')[0];
  const dash = cleaned.indexOf('-');
  const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const pre = dash === -1 ? '' : cleaned.slice(dash + 1);

  const parts = core.split('.');
  if (!parts.length || parts.length > 4) return null;

  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part.trim())) return null;
    nums.push(Number.parseInt(part, 10));
  }

  return { nums, pre };
}

/** Semver 11: numeric identifiers compare numerically and rank below alphanumerics. */
function comparePre(a, b) {
  if (a === b) return 0;
  const left = a.split('.');
  const right = b.split('.');
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i++) {
    const x = left[i];
    const y = right[i];
    // A shorter prerelease is the lower one: 1.0.0-beta < 1.0.0-beta.2.
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number.parseInt(x, 10);
      const dy = Number.parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * -1 if a < b, 0 if equal, 1 if a > b, and **null** if either side is not a
 * version we understand.
 *
 * The null is the whole point. Returning 0 or -1 for junk would mean a typo in
 * the dashboard ("1.0.5 " with a stray letter, or an empty field) silently
 * decides whether millions of handsets are locked out. A caller that cannot
 * compare must let the user through.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i++) {
    // 1.2 and 1.2.0 are the same release; the missing segment is a zero.
    const x = left.nums[i] ?? 0;
    const y = right.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return comparePre(left.pre, right.pre);
}

function isValidVersion(value) {
  return parseVersion(value) !== null;
}

/** Only http(s). A `market://` or `intent://` link cannot be opened by the web build. */
function isValidUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return true; // empty is allowed; it just means "not set"
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function blankSettings() {
  return {
    latest_version: '',
    min_version: '',
    force_update: false,
    android_download_url: '',
    update_page_url: '',
    message: '',
    is_active: false,
  };
}

/**
 * The rules as the admin last saved them. Never throws - a failure here answers
 * with the blank set, which evaluates to "nobody is blocked".
 */
async function getUpdateSettings() {
  try {
    const rows = await redis.cached(CACHE_KEY, TTL, async () => {
      const found = await prisma.appSetting.findMany({
        where: { setting_key: { in: Object.values(KEYS) } },
        select: { setting_key: true, setting_value: true },
      });
      // Cached as a plain object of strings so a JSON round trip cannot turn a
      // boolean into the string "false" on one path and a real false on another.
      return Object.fromEntries(found.map(r => [r.setting_key, r.setting_value ?? '']));
    });

    const byKey = rows || {};

    return {
      latest_version: String(byKey[KEYS.latest_version] ?? '').trim(),
      min_version: String(byKey[KEYS.min_version] ?? '').trim(),
      force_update: toBool(byKey[KEYS.force_update]),
      android_download_url: String(byKey[KEYS.android_download_url] ?? '').trim(),
      update_page_url: String(byKey[KEYS.update_page_url] ?? '').trim(),
      message: String(byKey[KEYS.message] ?? '').trim(),
      is_active: toBool(byKey[KEYS.is_active]),
    };
  } catch (e) {
    console.warn('appUpdate: read failed, nobody will be blocked', {
      reason: String(e?.message || e).slice(0, 120),
    });
    return blankSettings();
  }
}

/**
 * What a given build should be told.
 *
 * `update_required` is the only field that takes the screen away from the user,
 * so it needs all four of: rules switched on, force switched on, a minimum that
 * parses, and a current version that parses and is genuinely below it. Anything
 * missing and the answer is false.
 */
function evaluate(currentVersion, settings) {
  const active = Boolean(settings?.is_active);
  const belowMin = active ? compareVersions(currentVersion, settings.min_version) : null;
  const behindLatest = active ? compareVersions(currentVersion, settings.latest_version) : null;

  return {
    current_version: String(currentVersion ?? '').trim(),
    update_required: active && Boolean(settings.force_update) && belowMin === -1,
    update_available: active && (behindLatest === -1 || belowMin === -1),
  };
}

/** The link the update button opens: the APK first, the web page as the fallback. */
function downloadLink(settings) {
  return settings?.android_download_url || settings?.update_page_url || '';
}

/**
 * Save. Every field is optional - the dashboard sends the whole form, but a
 * partial patch leaves the rest of the rules alone.
 *
 * Validation refuses the two states that cannot be undone from a handset:
 *
 *  - a minimum above the latest build, which blocks users who already have the
 *    newest APK and leaves them nothing to update to;
 *  - force update with no link at all, which puts an Update Required screen in
 *    front of every user with a button that goes nowhere.
 *
 * Both are one-way doors: the affected app cannot reach any screen from which
 * the mistake could be reported, and the only fix is an admin noticing. So they
 * are rejected here rather than stored.
 *
 * @throws {Error} with `.code = 'VALIDATION_ERROR'` and `.messages` (string[]).
 */
async function setUpdateSettings(patch = {}) {
  const current = await getUpdateSettings();
  const next = { ...current };

  const has = field => Object.prototype.hasOwnProperty.call(patch, field);
  const errors = [];

  if (has('latest_version')) next.latest_version = String(patch.latest_version ?? '').trim();
  if (has('min_version')) next.min_version = String(patch.min_version ?? '').trim();
  if (has('force_update')) next.force_update = toBool(patch.force_update);
  if (has('is_active')) next.is_active = toBool(patch.is_active);
  if (has('android_download_url')) next.android_download_url = String(patch.android_download_url ?? '').trim();
  if (has('update_page_url')) next.update_page_url = String(patch.update_page_url ?? '').trim();
  if (has('message')) next.message = String(patch.message ?? '').trim();

  if (!next.latest_version) {
    errors.push('Latest version is required');
  } else if (!isValidVersion(next.latest_version)) {
    errors.push('Latest version must look like 1.0.5');
  }

  if (!next.min_version) {
    errors.push('Minimum version is required');
  } else if (!isValidVersion(next.min_version)) {
    errors.push('Minimum version must look like 1.0.5');
  }

  if (isValidVersion(next.latest_version) && isValidVersion(next.min_version)) {
    if (compareVersions(next.min_version, next.latest_version) === 1) {
      errors.push('Minimum version cannot be newer than the latest version - that would block everyone, including users already on the newest build');
    }
  }

  if (!isValidUrl(next.android_download_url)) errors.push('Download URL must be a full http(s) link');
  if (!isValidUrl(next.update_page_url)) errors.push('Update page URL must be a full http(s) link');

  if (next.message.length > MESSAGE_MAX) {
    errors.push(`Message must be ${MESSAGE_MAX} characters or fewer`);
  }

  if (next.is_active && next.force_update && !downloadLink(next)) {
    errors.push('Add a download URL or an update page URL before switching force update on - without one the update screen has nothing to open');
  }

  if (errors.length) {
    const err = new Error(errors[0]);
    err.code = 'VALIDATION_ERROR';
    err.messages = errors;
    throw err;
  }

  const values = {
    [KEYS.latest_version]: next.latest_version,
    [KEYS.min_version]: next.min_version,
    [KEYS.force_update]: next.force_update ? 'on' : 'off',
    [KEYS.android_download_url]: next.android_download_url,
    [KEYS.update_page_url]: next.update_page_url,
    [KEYS.message]: next.message,
    [KEYS.is_active]: next.is_active ? 'on' : 'off',
  };

  // One transaction: a half-written rule set (new minimum, old force flag) is
  // exactly the combination that locks people out by accident.
  await prisma.$transaction(
    Object.entries(values).map(([setting_key, setting_value]) => {
      const field = Object.keys(KEYS).find(name => KEYS[name] === setting_key);
      return prisma.appSetting.upsert({
        where: { setting_key },
        update: { setting_value },
        create: { setting_key, setting_value, description: DESCRIPTIONS[field] || null },
      });
    })
  );

  await redis.del(CACHE_KEY);

  return next;
}

module.exports = {
  getUpdateSettings,
  setUpdateSettings,
  compareVersions,
  parseVersion,
  isValidVersion,
  evaluate,
  downloadLink,
  DEFAULT_MESSAGE,
  MESSAGE_MAX,
  __test: { KEYS, comparePre, isValidUrl, toBool },
};
