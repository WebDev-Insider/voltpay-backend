// Reading an env var the way it actually arrives, not the way it was written.
//
// The same value reaches the process differently depending on where it was set:
// dotenv strips the quotes off a `.env` line, while the Render dashboard stores
// the field byte for byte. So a value copied out of `.env` into Render keeps its
// quotes, and one pasted from a vendor's docs can keep a trailing space.
//
// Neither is visible in the dashboard and neither fails at boot - both fail at
// the vendor, hours later, on the request that needed them. That has cost this
// backend two outages: a quoted BREVO_FROM took every email offline with
// `400 valid sender email required`, and a quoted UPLOADTHING_TOKEN took every
// support attachment offline with `Invalid token`.
//
// Trim and unquote at the point of reading, so the two spellings converge.

/** Strips one matching pair of wrapping quotes, and surrounding whitespace. */
function unquote(value) {
  const str = String(value == null ? '' : value).trim();
  const wrapped =
    str.length >= 2 &&
    ((str[0] === '"' && str.endsWith('"')) || (str[0] === "'" && str.endsWith("'")));
  return wrapped ? str.slice(1, -1).trim() : str;
}

/** process.env[name], trimmed and unquoted. Always a string - '' when unset. */
function envValue(name) {
  return unquote(process.env[name]);
}

module.exports = { unquote, envValue };
