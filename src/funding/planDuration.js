// How long a data bundle lasts, read once and in one place.
//
// Providers say it however they like, and none of them is going to change for
// our convenience. MySubWallet has no duration field: the validity is a phrase
// in the middle of the plan name, after the price - "750MB GIFTING = ₦194.00
// 1 Day Special", "5GB SME = ₦1,480.00 incl. 3GB Night Data 30 Days". Earlier
// rails stated it as an integer field (PairGate's `duration`) or as a delimited
// suffix ("500 MB - Monthly (SME)"), and a future one will do something else
// again.
//
// Every shape ends up as the same two values on a shaped plan - `duration_days`
// for sorting and bucketing, `validity` for a customer to read - so the picker
// looks the same whichever upstream is answering.
//
// **The rule this file exists to keep: never print a duration the provider did
// not state.** A plan whose validity cannot be read carries no label and no
// bucket, and stays reachable under "All". That is deliberate rather than lazy.
// Guessing a validity - from the plan family, from the price, from the bundle
// size - is how a customer pays for what they read as 30 days and gets seven,
// and a wrong duration on a paid product is worse than no duration at all.

/* ------------------------------------------------------------------ parsing */

// The units providers actually write. An hour-scale bundle rounds up to
// one day so it lands on the "Daily" shelf; its own label still says "2 hours",
// so rounding the bucket never rounds the promise.
const UNIT_DAYS = {
  day: 1,
  dy: 1,
  week: 7,
  wk: 7,
  month: 30,
  mth: 30,
  year: 365,
  yr: 365,
  hour: 1 / 24,
  hr: 1 / 24,
};

// What each spelling is called when we say it back. "30 DAYS" and "30days" both
// come out as "30 days".
const UNIT_WORD = {
  day: 'day',
  dy: 'day',
  week: 'week',
  wk: 'week',
  month: 'month',
  mth: 'month',
  year: 'year',
  yr: 'year',
  hour: 'hour',
  hr: 'hour',
};

// Longest spelling first inside each pair, so "months" is not eaten by "mth".
const UNITS = 'day|dy|week|wk|month|mth|year|yr|hour|hr';

// A number and a unit: "30 Days", "30days", "7-day", "24 hrs", "1 Month".
//
// The unit is mandatory, which is what keeps "1GB" and "3 mins" from parsing as
// a validity. First match wins rather than largest: providers state the validity
// once, as the only duration in the string, and taking the largest would read
// "1GB for 7 days + 2GB night valid 30 days" as a 30-day bundle.
const NUMERIC_RE = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*-?\s*(${UNITS})s?\b`, 'i');

// The word forms, for a provider that names the tier instead of the count.
// "Weekend" and "Night" are deliberately absent: they are real plans but their
// length is an inference, and this file does not infer.
const WORD_DAYS = {
  daily: 1,
  weekly: 7,
  fortnightly: 14,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
  annually: 365,
  annual: 365,
};

const WORDS = Object.keys(WORD_DAYS).sort((a, b) => b.length - a.length).join('|');
const WORD_RE = new RegExp(String.raw`\b(${WORDS})\b`, 'i');

// Either form, for the stripper below.
const DURATION_TOKEN = String.raw`(?:\d+(?:\.\d+)?\s*-?\s*(?:${UNITS})s?|${WORDS})`;

function pluralise(count, word) {
  const n = Number.isInteger(count) ? count : Number(count.toFixed(1));
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The first stated validity and where it sits in the string. One matcher for
// both readers below, so "what counts as a duration" is decided in one place.
function matchDuration(s) {
  const numeric = NUMERIC_RE.exec(s);
  if (numeric) {
    const count = Number(numeric[1]);
    const unit = numeric[2].toLowerCase();
    if (Number.isFinite(count) && count > 0 && UNIT_DAYS[unit]) {
      return {
        days: Math.max(1, Math.round(count * UNIT_DAYS[unit])),
        label: pluralise(count, UNIT_WORD[unit]),
        index: numeric.index,
        length: numeric[0].length,
      };
    }
  }

  const word = WORD_RE.exec(s);
  if (word) {
    const key = word[1].toLowerCase();
    return {
      days: WORD_DAYS[key],
      label: key.charAt(0).toUpperCase() + key.slice(1),
      index: word.index,
      length: word[0].length,
    };
  }

  return null;
}

/**
 * The validity stated inside a plan name, or null when none is.
 *
 * Returns the provider's own wording as `label`, tidied but not converted: a
 * provider's "Monthly" stays "Monthly" rather than becoming "30 days". The 30
 * is ours - a bucketing convenience - and printing it back as though the
 * provider had said it is the exact thing the header warns about. `days` is the
 * number, for sorting and for which shelf the plan sits on.
 */
function readDuration(text) {
  const found = matchDuration(String(text || ''));
  return found ? { days: found.days, label: found.label } : null;
}

/**
 * readDuration, plus the text with that duration cut out of it.
 *
 * For a provider that writes the validity mid-sentence - "1 Day Special",
 * "incl. 3GB Night Data 30 Days" - where stripDuration's delimiter guard would
 * rightly leave it alone. The caller is the one asserting that the first
 * duration in this text *is* the validity; this only does the cutting. With no
 * duration found, the text comes back whole and `duration` is null, so nothing
 * is ever removed on a guess.
 */
function splitDuration(text) {
  const s = String(text || '');
  const found = matchDuration(s);
  if (!found) return { duration: null, rest: s.replace(/\s{2,}/g, ' ').trim() };

  const rest = `${s.slice(0, found.index)} ${s.slice(found.index + found.length)}`
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { duration: { days: found.days, label: found.label }, rest };
}

/** A provider-supplied day count, or 0 when there is not a usable one. */
function toDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * A day count said out loud.
 *
 * Used only for the rail that hands us a number, so nothing here is a guess.
 * Whole years get named as years because "365 days" reads like a typo; anything
 * else stays in days, which is how every Nigerian carrier advertises a bundle.
 */
function durationLabel(days) {
  const n = toDays(days);
  if (!n) return '';
  if (n % 365 === 0) {
    const years = n / 365;
    return `${years} year${years === 1 ? '' : 's'}`;
  }
  return `${n} day${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ buckets */

// The shelves the picker offers, and where each one stops.
//
// The bands are wide on purpose. A tab is a coarse filter - "show me the monthly
// ones" - and the tile underneath always prints the exact validity, so a 90-day
// bundle sitting under "Monthly" and reading "90 days" on its face misleads
// nobody. The cuts err upward for the same reason: a 90-day plan filed under
// Monthly undersells itself, while the same plan filed under Yearly would be a
// lie, and only one of those costs a customer anything.
const BUCKETS = [
  { slug: 'daily', label: 'Daily', maxDays: 3 },
  { slug: 'weekly', label: 'Weekly', maxDays: 20 },
  { slug: 'monthly', label: 'Monthly', maxDays: 120 },
  { slug: 'yearly', label: 'Yearly', maxDays: Infinity },
];

const BUCKET_ORDER = BUCKETS.map(b => b.slug);
const BUCKET_LABELS = Object.fromEntries(BUCKETS.map(b => [b.slug, b.label]));

/** Which shelf a bundle belongs on. Empty string when its validity is unknown. */
function durationBucket(days) {
  const n = toDays(days);
  if (!n) return '';
  return (BUCKETS.find(b => n <= b.maxDays) || BUCKETS[BUCKETS.length - 1]).slug;
}

/* ------------------------------------------------------------------ display */

// A duration that is delimited - trailing after a dash, or alone in brackets -
// is the provider's validity and comes out. One that is part of the name is left
// where it is: the guard is the delimiter, not the words.
const PAREN_DURATION_RE = new RegExp(String.raw`\s*\(\s*${DURATION_TOKEN}\s*\)`, 'gi');
const DASH_DURATION_RE = new RegExp(String.raw`\s*[-–—]\s*${DURATION_TOKEN}\b`, 'gi');

/**
 * The plan name with its validity taken out, for a UI that shows the validity
 * on its own line.
 *
 * "1GB (AWOOF Special) - 30 Days" -> "1GB (AWOOF Special)"
 * "500 MB - Monthly (SME)"        -> "500 MB (SME)"
 *
 * The last line of defence against a tile that prints "Monthly" twice: the
 * provider module should already have taken the validity out of the name it
 * hands over, and this catches any that still carry it delimited. Falls back to
 * the original whenever stripping would leave nothing, because a nameless plan
 * in the grid is worse than a repeated word.
 */
function stripDuration(name) {
  const original = String(name || '').trim();
  const stripped = original
    .replace(PAREN_DURATION_RE, '')
    .replace(DASH_DURATION_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s–—,-]+$/, '')
    .trim();
  return stripped || original;
}

module.exports = {
  readDuration,
  splitDuration,
  durationLabel,
  durationBucket,
  stripDuration,
  toDays,
  BUCKETS,
  BUCKET_ORDER,
  BUCKET_LABELS,
};
