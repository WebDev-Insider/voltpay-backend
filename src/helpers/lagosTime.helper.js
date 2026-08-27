/**
 * Calendar boundaries in Nigerian time, as real UTC instants.
 *
 * Every period this product reports on - a statement month, a spending-insight
 * week, a payroll day - is a Nigerian calendar period, not a UTC one. Building
 * them with `new Date(year, month - 1, 1)` uses the *server's* timezone, so the
 * same month means different things on a Lagos box and a UTC one: a purchase at
 * 00:30 WAT on the 1st is 23:30 UTC on the last of the previous month, and
 * lands in the wrong statement on a UTC host.
 *
 * Lagos is UTC+1 all year and has no DST, so a fixed offset is exact here -
 * cheaper and more predictable than Intl round-trips, which is why this is not
 * written against `timeZone: 'Africa/Lagos'`. That assumption is the one thing
 * to revisit if Nigeria ever adopts DST.
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** The Nigerian wall-clock reading of a UTC instant. */
function lagosDateParts(date) {
  const shifted = new Date(date.getTime() + LAGOS_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
  };
}

/**
 * The UTC instant of midnight in Lagos on a given calendar date.
 *
 * Month is 1-12 and day is 1-31, but both may over- or underflow: Date.UTC
 * normalises, so month 13 is next January and day 0 is the last of the previous
 * month. Callers rely on that for "the 1st of next month" and "back to Monday".
 */
function lagosMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day) - LAGOS_OFFSET_MS);
}

module.exports = { LAGOS_OFFSET_MS, lagosDateParts, lagosMidnightUtc };
