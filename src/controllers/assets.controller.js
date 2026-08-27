const path = require('path');

const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'brand');

/**
 * The brand files an email can link to. An allowlist rather than a directory
 * listing: `filename` comes off the URL, and mapping it through a fixed object
 * means no amount of `../` in the path can reach anything else on disk.
 */
const BRAND_FILES = {
  'voltpay-logo.png': 'voltpay-logo.png',
  'voltpay-logo-white.png': 'voltpay-logo-white.png',
};

function getCountryFlag(req, res) {
  const { filename } = req.params;
  console.log('📥 Country flag request for:', filename);

  const flagMappings = {
    'us.png': 'https://flagcdn.com/w320/us.png',
    'gb.png': 'https://flagcdn.com/w320/gb.png',
    'ca.png': 'https://flagcdn.com/w320/ca.png',
    'af.png': 'https://flagcdn.com/w320/af.png',
    'au.png': 'https://flagcdn.com/w320/au.png',
    'de.png': 'https://flagcdn.com/w320/de.png',
    'fr.png': 'https://flagcdn.com/w320/fr.png',
    'in.png': 'https://flagcdn.com/w320/in.png',
    'ng.png': 'https://flagcdn.com/w320/ng.png',
    'default.png': 'https://flagcdn.com/w320/un.png'
  };

  const flagUrl = flagMappings[filename] || flagMappings['default.png'];
  console.log('📥 Redirecting to flag URL:', flagUrl);
  return res.redirect(flagUrl);
}

/**
 * The logo in the header of every VoltPay email.
 *
 * It has to be a hosted URL: Gmail, Outlook.com and Yahoo all strip `data:`
 * image sources, so a base64 logo is invisible in the three clients that
 * matter most here. Public and unauthenticated by design - the recipient's
 * mail client fetches it with no session, and it is a logo, not user data.
 *
 * Two headers earn their place:
 *
 *   Cross-Origin-Resource-Policy   helmet() sets this to `same-origin` for the
 *     whole app, which makes a browser refuse the image when a webmail client
 *     renders the message on its own domain. Relaxed to `cross-origin` for
 *     this route only.
 *
 *   Cache-Control                  Gmail caches through its own image proxy,
 *     but Apple Mail and Outlook fetch every open. A year of immutable cache
 *     means one download per recipient rather than one per read. The filename
 *     is the cache key, so a new logo ships as a new filename.
 */
function getBrandAsset(req, res) {
  const file = BRAND_FILES[String(req.params.filename || '')];
  if (!file) return res.status(404).end();

  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'image/png');

  return res.sendFile(path.join(BRAND_DIR, file), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

module.exports = {
  getCountryFlag,
  getBrandAsset,
};
