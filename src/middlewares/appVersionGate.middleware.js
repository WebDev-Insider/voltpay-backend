// The global version gate. Answers "is this build still allowed to talk to us?"
// on every request, instead of only on the one endpoint the app calls at start.
//
// Why this exists on top of GET /app/version-check:
//
//  - The startup check is a single request with a short timeout sitting on the
//    critical path of a cold start. On a slow connection it times out, the app
//    fails open (correctly - see appVersion.controller), and the user then
//    spends the *entire session* on a retired build, moving money with the bug
//    the release was meant to fix. This closes that window: "open" now lasts
//    only until the first successful round trip, and that round trip is itself
//    the gate. A retired build cannot log in, fetch a balance or send a naira
//    without being told to update, because all three are requests.
//  - It catches a session already in progress. Publish a fix at 2pm and an app
//    that has been open since morning is stopped on its next tap rather than on
//    its next cold start, which might be days away.
//  - It costs no extra request. The version rides a header the app already
//    sends next to X-Device-Id, and getUpdateSettings() is Redis-cached for
//    APP_UPDATE_TTL seconds, so this is a cache read and not a database read.
//
// Three rules keep it from stranding anyone:
//
//  - **No header means allow.** The admin dashboard, the web build, curl and
//    every webhook caller send no X-App-Version. Absent is "not a mobile build",
//    never "unknown, so block".
//  - **/app/version-check stays reachable.** It is what the Update Required
//    screen calls to discover it may leave. Gating it would make a mistyped
//    minimum version permanent, fixable only by reinstalling.
//  - **No download link means no block.** setUpdateSettings already refuses to
//    save that combination, but rules written straight to the database could
//    still produce it, and a block with nothing to download is a dead end.
//
// Fails OPEN, like every other read in appUpdate.helper. A cache or database
// blip must never lock the installed base out of wallets holding their money.

const AppUpdate = require('../helpers/appUpdate.helper');

// Lower-cased because Express normalises header names; req.get() is
// case-insensitive either way, but this is the name the app sends.
const VERSION_HEADER = 'X-App-Version';

// Everything the Update Required screen needs in order to release the user has
// to stay reachable from behind the gate.
const EXEMPT_PREFIXES = ['/app/version-check'];

function isExempt(route) {
  return EXEMPT_PREFIXES.some(prefix => route.startsWith(prefix));
}

async function appVersionGate(req, res, next) {
  try {
    const version = String(req.get(VERSION_HEADER) || '').trim();
    // Not a mobile build. Nothing to judge.
    if (!version) return next();

    if (isExempt(req.path || '')) return next();

    const settings = await AppUpdate.getUpdateSettings();
    const verdict = AppUpdate.evaluate(version, settings);
    if (!verdict.update_required) return next();

    // Refusing without giving them somewhere to go is worse than letting them
    // through on a stale build.
    const downloadUrl = AppUpdate.downloadLink(settings);
    if (!downloadUrl) return next();

    const message = settings.message || AppUpdate.DEFAULT_MESSAGE;

    // 426 rather than 401 or 403 on purpose. Both of those already mean
    // something specific to this app's Dio interceptor - 401 forces a logout,
    // 403 opens the KYC prompt - and a third meaning on either one is a
    // mis-fire waiting to happen. 426 collides with nothing.
    //
    // The body is deliberately the same shape as GET /app/version-check, so the
    // client parses both with one model.
    return res.status(426).json({
      remark: 'update_required',
      status: 'error',
      message: [message],
      data: {
        is_active: settings.is_active,
        latest_version: settings.latest_version,
        min_version: settings.min_version,
        force_update: settings.force_update,
        android_download_url: settings.android_download_url,
        update_page_url: settings.update_page_url,
        message,
        download_url: downloadUrl,
        current_version: verdict.current_version,
        update_required: true,
        update_available: true,
      },
    });
  } catch (e) {
    console.warn('appVersionGate: check failed, letting the request through', {
      reason: String(e?.message || e).slice(0, 160),
    });
    return next();
  }
}

module.exports = appVersionGate;
