// Does the name on an identity record belong to the person who owns this
// VoltPay account?
//
// Asked in two places on the KYC path, against two very different inputs:
//
//   - the bank account name the bank lookup resolves ("SAMUEL OWOLABI BLESSING"),
//     compared against the profile name ("Samuel Owolabi")
//   - the name the user typed for the BVN check, compared against the same
//     profile name, *before* a paid provider call is spent on it
//
// A plain string comparison answers "no" to almost every real Nigerian bank
// account, for reasons that have nothing to do with fraud:
//
//   order      banks store surname first, profiles store it last
//   extras     the bank record carries a middle name the profile never asked for
//   case       bank records are upper case, near universally
//   marks      "Adéwálé" and "Adewale" are the same person
//   joiners    "Ade-Bello" and "Ade Bello"; "O'Neil" and "ONeil"
//   initials   "S. OWOLABI" for Samuel Owolabi
//   spelling   "Chukwuemeka" typed as "Chukwemeka" - one slipped keystroke
//
// So the rule is directional and token-based: **every** word in the profile
// name has to find a partner in the provider's name. Extra words on the
// provider side are fine (that is a middle name we never held); a missing word
// is not (that is a different person). Order is ignored entirely.
//
// Directional on purpose. Matching both ways would reject an account whose bank
// record simply holds more of the person's name than the profile does, which is
// the single most common shape of a legitimate account.

// One slipped keystroke is a typo; three is a different name. Scaled by length
// so the tolerance cannot swallow a short name whole - at distance 1, "Ade" and
// "Ada" are different people, while "Chukwuemeka" and "Chukwemeka" are not.
function allowedDistance(length) {
  if (length >= 8) return 2;
  if (length >= 5) return 1;
  return 0;
}

// Minimum profile words that must be present before a match means anything. A
// one-word profile ("Samuel") would match half the country's bank accounts, so
// it is treated as an incomplete profile rather than a pass.
const MIN_TOKENS = 2;

function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Strip a name down to the letters that carry identity.
 *
 * NFD splits "é" into "e" + a combining accent, and the range below deletes the
 * accent - so a name typed with marks and the same name typed without collapse
 * to one string. Joiners become spaces rather than vanishing, so "Ade-Bello"
 * reads as two words and can match a record that spells it as two.
 */
function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    // Apostrophes close up ("O'NEIL" -> "ONEIL"); every other joiner opens out.
    .replace(/['’`]/g, '')
    .replace(/[^A-Z]+/g, ' ')
    .trim();
}

/**
 * The words of a name, with the noise dropped.
 *
 * Honorifics and suffixes are removed because a bank record carrying "MR" would
 * otherwise be a word the profile can never supply - and on the profile side it
 * would be a word the bank can never supply. Either way it is a false mismatch.
 */
const NOISE = new Set([
  'MR', 'MRS', 'MISS', 'MS', 'DR', 'PROF', 'ENGR', 'BARR', 'CHIEF', 'ALHAJI',
  'ALHAJA', 'PASTOR', 'REV', 'HON', 'JR', 'SNR', 'SR', 'JNR', 'II', 'III',
]);

function nameTokens(value) {
  return normalizeName(value)
    .split(' ')
    .filter(token => token && !NOISE.has(token));
}

/**
 * Levenshtein distance, capped: it stops as soon as the answer is known to
 * exceed `max`, so a comparison between two unrelated names costs a row or two
 * rather than the full matrix.
 */
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowBest) rowBest = current[j];
    }
    // Every remaining row can only add to the best value on this one, so once
    // the whole row is past the cap the final answer is too.
    if (rowBest > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Can one profile word be considered present in the provider's name?
 *
 * A single letter matches a word beginning with it, which is what makes
 * "S. OWOLABI" work for Samuel Owolabi. It is only ever allowed in that
 * direction, and only for a genuine initial - a one-letter provider token can
 * satisfy a full profile word, but never the reverse, because "S" on the
 * profile side would match almost anything.
 */
function tokenMatches(expected, actual) {
  if (expected === actual) return true;
  if (actual.length === 1) return expected.startsWith(actual);
  if (expected.length === 1) return false;

  const max = Math.min(allowedDistance(Math.max(expected.length, actual.length)), envNumber('KYC_NAME_MAX_EDITS', 2));
  if (max <= 0) return false;
  return editDistance(expected, actual, max) <= max;
}

/**
 * Compare a provider's name against the name on the VoltPay profile.
 *
 * @param {string} expected  the profile name - what we already hold
 * @param {string} actual    the name the provider returned or the user typed
 * @returns {{ok: boolean, reason: string|null, expectedTokens: string[], missing: string[], matched: number}}
 *
 * `reason` is null on a pass and a machine code on a failure:
 *   incomplete_profile  the profile has fewer than two usable words
 *   no_name             the provider gave us nothing to compare
 *   mismatch            at least one profile word is absent
 *
 * Nothing here logs, and the caller must not log `missing` either - it holds
 * fragments of a real person's name.
 */
function matchName(expected, actual) {
  const expectedTokens = nameTokens(expected);
  const actualTokens = nameTokens(actual);

  if (expectedTokens.length < MIN_TOKENS) {
    return { ok: false, reason: 'incomplete_profile', expectedTokens, missing: [], matched: 0 };
  }
  if (!actualTokens.length) {
    return { ok: false, reason: 'no_name', expectedTokens, missing: expectedTokens, matched: 0 };
  }

  // Each provider word can only be spent once, so a profile reading
  // "Samuel Samuel" cannot be satisfied by a single "SAMUEL" on the record.
  const unused = [...actualTokens];
  const missing = [];

  for (const token of expectedTokens) {
    const at = unused.findIndex(candidate => tokenMatches(token, candidate));
    if (at === -1) missing.push(token);
    else unused.splice(at, 1);
  }

  return {
    ok: missing.length === 0,
    reason: missing.length ? 'mismatch' : null,
    expectedTokens,
    missing,
    matched: expectedTokens.length - missing.length,
  };
}

/**
 * The profile name as one string, from a revealed user row.
 *
 * Takes the output of `revealUserFields()`, never the raw row - the plain
 * `firstname` / `lastname` columns are only populated on accounts that predate
 * the PII migration, and reading them directly would compare a live account
 * against an empty string.
 */
function profileName(revealed) {
  return [revealed?.firstname, revealed?.lastname]
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  matchName,
  profileName,
  normalizeName,
  nameTokens,
  __test: { editDistance, tokenMatches, allowedDistance, MIN_TOKENS },
};
