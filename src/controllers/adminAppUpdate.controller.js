// The App Updates screen: what an admin sets after uploading a new APK.
//
// Deliberately not superadmin-gated. The risky direction here is the release
// rule being wrong during a rollout - a bad build still reachable, or an
// over-strict minimum left in place - and both are fixed by someone editing
// this page quickly. The gate that matters is the validation in the helper,
// which refuses the two settings that cannot be undone from a handset.
//
// Every write here is picked up by adminAudit.middleware, which records the
// admin, the route and the safe scalars (`is_active` among them). Nothing on
// this screen is user data, so the whole body is safe to reason about in an
// audit row.

const AppUpdate = require('../helpers/appUpdate.helper');

/** Shape the dashboard renders. Same field names the app sees, plus the link the button would open. */
function present(settings) {
  return {
    latest_version: settings.latest_version,
    min_version: settings.min_version,
    force_update: settings.force_update,
    android_download_url: settings.android_download_url,
    update_page_url: settings.update_page_url,
    message: settings.message,
    is_active: settings.is_active,
    download_url: AppUpdate.downloadLink(settings),
  };
}

async function getAppUpdate(req, res) {
  try {
    const settings = await AppUpdate.getUpdateSettings();

    return res.json({
      remark: 'app_update_settings',
      status: 'success',
      message: ['App update settings fetched successfully'],
      data: { app_update: present(settings), message_max_length: AppUpdate.MESSAGE_MAX },
    });
  } catch (e) {
    console.error('admin.getAppUpdate error', e);

    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to load app update settings'],
      data: null,
    });
  }
}

async function updateAppUpdate(req, res) {
  try {
    const body = req.body || {};
    const patch = {};

    // Copied field by field rather than spread: an unrecognised key in the body
    // must not reach the helper, and an absent key must stay absent so a partial
    // save leaves the rest of the rules alone.
    for (const field of [
      'latest_version',
      'min_version',
      'force_update',
      'android_download_url',
      'update_page_url',
      'message',
      'is_active',
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Nothing to update'],
        data: null,
      });
    }

    const saved = await AppUpdate.setUpdateSettings(patch);

    return res.json({
      remark: 'app_update_saved',
      status: 'success',
      message: [
        saved.is_active && saved.force_update
          ? `Builds below ${saved.min_version} are now blocked`
          : saved.is_active
            ? `Users below ${saved.latest_version} will be offered the update`
            : 'App update rules saved but not enforced',
      ],
      data: { app_update: present(saved) },
    });
  } catch (e) {
    if (e?.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: e.messages || [e.message],
        data: null,
      });
    }

    console.error('admin.updateAppUpdate error', e);

    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to save app update settings'],
      data: null,
    });
  }
}

module.exports = { getAppUpdate, updateAppUpdate };
