// GET /app/version-check - the first call a cold app makes, before login.
//
// Public on purpose: a user who cannot get past the update screen has no token
// to authenticate with, and the whole point is to answer a build that is not
// allowed to do anything else yet.
//
// The app sends the version it is running and gets back both the rules and the
// verdict. Two reasons to compute the verdict here rather than leave it to the
// client: the comparison is written once instead of once per platform, and a
// build shipped before some future versioning change still gets a correct
// answer from a server that knows about it. The app keeps its own comparison as
// a fallback for the case where this endpoint cannot be reached at all.

const AppUpdate = require('../helpers/appUpdate.helper');

async function versionCheck(req, res) {
  try {
    const currentVersion = String(req.query.version || req.query.app_version || '').trim();
    const settings = await AppUpdate.getUpdateSettings();
    const verdict = AppUpdate.evaluate(currentVersion, settings);

    const message = settings.message || AppUpdate.DEFAULT_MESSAGE;

    return res.json({
      remark: 'version_check',
      status: 'success',
      message: ['Version settings fetched successfully'],
      data: {
        is_active: settings.is_active,
        latest_version: settings.latest_version,
        min_version: settings.min_version,
        force_update: settings.force_update,
        android_download_url: settings.android_download_url,
        update_page_url: settings.update_page_url,
        // Always a usable sentence, so the app never has to invent one.
        message,
        // The link the button should open, already resolved: APK first, web
        // page second. An app that only reads this field cannot end up with a
        // button that does nothing.
        download_url: AppUpdate.downloadLink(settings),
        // Absent `?version=`, both are false and the app falls back to its own
        // comparison against min_version / latest_version above.
        current_version: verdict.current_version,
        update_required: verdict.update_required,
        update_available: verdict.update_available,
      },
    });
  } catch (error) {
    // Never a 500. An app that cannot read this must carry on, not stall on a
    // splash screen - and the safe answer to "am I allowed?" is always yes.
    console.error('appVersion.versionCheck error', error);
    return res.json({
      remark: 'version_check',
      status: 'success',
      message: ['Version settings unavailable'],
      data: {
        is_active: false,
        latest_version: '',
        min_version: '',
        force_update: false,
        android_download_url: '',
        update_page_url: '',
        message: AppUpdate.DEFAULT_MESSAGE,
        download_url: '',
        current_version: String(req.query.version || '').trim(),
        update_required: false,
        update_available: false,
      },
    });
  }
}

module.exports = { versionCheck };
