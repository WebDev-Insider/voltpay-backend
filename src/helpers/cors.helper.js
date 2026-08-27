// Which browser origins may call the API.
//
// Lives here rather than inline in server.js only so it can be asserted: the
// difference between "allow all" and "allow these" is a security decision, and
// an unset variable silently meaning "everyone" is exactly the kind of thing
// that needs a test standing next to it.

/** "https://a.com, https://b.com/" -> ['https://a.com', 'https://b.com'] */
function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * The `origin` option cors expects.
 *
 * Requests with no Origin - the mobile app, provider webhooks, curl - are not
 * browser cross-origin requests at all and pass through; CORS never protected
 * them. An empty allowlist allows every origin, which is dev only: set
 * CORS_ALLOWED_ORIGINS in production or any site can call the API with a
 * signed-in browser's credentials.
 */
function corsOrigin(allowed) {
  const list = Array.isArray(allowed) ? allowed : parseOrigins(allowed);

  return (origin, cb) => {
    if (!origin || list.length === 0) return cb(null, true);
    cb(null, list.includes(String(origin).replace(/\/$/, '')));
  };
}

module.exports = { parseOrigins, corsOrigin };
