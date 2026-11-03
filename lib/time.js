/**
 * Time semantics.
 *
 * The vault stores when a fact was true (`observedAt`), never a value that is a
 * function of "now" (age, next birthday). Everything derived is computed here at
 * read time against an explicit `asOf`, which is the whole point: a birthday
 * recorded last year still produces the correct age today.
 *
 * Dates are handled as components (y/m/d) and day differences are taken in UTC
 * so a local DST switch can never turn 1 day into 23 hours.
 */

const DAY_MS = 86400000;

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function todayParts(now = new Date()) {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

export function partsOfDate(date) {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function utcOf(parts) {
  return Date.UTC(parts.y, parts.m - 1, parts.d);
}

/** Whole days from `from` to `to`, both date-only components. */
export function daysBetween(from, to) {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

/**
 * Parse a date value at day, month, or year precision.
 * Accepts `1968-05-12`, `1968/5/12`, `1968年5月12日`, `1968-05`, `1968`.
 */
export function parseDateValue(input) {
  if (typeof input !== 'string') return null;
  const text = input
    .normalize('NFKC')
    .trim()
    .replace(/[年./]/g, '-')
    .replace(/[月]/g, '-')
    .replace(/日/g, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '')
    .replace(/^-+/, '');
  if (text === '') return null;

  let match = /^(\d{4})$/.exec(text);
  if (match !== null) {
    const y = Number(match[1]);
    if (y < 1000 || y > 3000) return null;
    return { text: String(y), y, precision: 'year' };
  }

  match = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (match !== null) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (y < 1000 || y > 3000 || m < 1 || m > 12) return null;
    return { text: `${y}-${pad(m)}`, y, m, precision: 'month' };
  }

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match !== null) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < 1000 || y > 3000 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { text: `${y}-${pad(m)}-${pad(d)}`, y, m, d, precision: 'day' };
  }

  return null;
}

/** Parse a datetime value; stored without a zone, compared as local wall time. */
export function parseDateTimeValue(input) {
  if (typeof input !== 'string') return null;
  const text = input.normalize('NFKC').trim().replace(/[年./]/g, '-').replace(/[月]/g, '-').replace(/日/g, ' ');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const date = parseDateValue(`${match[1]}-${match[2]}-${match[3]}`);
  if (date === null) return null;
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  const ss = match[6] === undefined ? 0 : Number(match[6]);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return { text: `${date.text}T${pad(hh)}:${pad(mm)}:${pad(ss)}`, y: date.y, m: date.m, d: date.d, hh, mm, ss, precision: 'second' };
}

/** Parse the `asOf` argument: a full ISO timestamp, or a plain date. */
export function parseAsOf(input, now = new Date()) {
  if (input === undefined || input === null || input === '') return { date: now, parts: todayParts(now) };
  if (typeof input !== 'string') return null;
  const dateOnly = parseDateValue(input);
  if (dateOnly !== null) {
    return { date: new Date(dateOnly.y, (dateOnly.m ?? 1) - 1, dateOnly.d ?? 1), parts: { y: dateOnly.y, m: dateOnly.m ?? 1, d: dateOnly.d ?? 1 } };
  }
  const stamp = Date.parse(input);
  if (Number.isNaN(stamp)) return null;
  return { date: new Date(stamp), parts: partsOfDate(new Date(stamp)) };
}

/** Age in whole years: "has this year's birthday already happened?". */
export function ageYears(birth, asOfParts) {
  if (birth === null || birth === undefined) return null;
  if (birth.precision === 'year') return asOfParts.y - birth.y;
  if (birth.precision === 'month') {
    return asOfParts.y - birth.y - (asOfParts.m < birth.m ? 1 : 0);
  }
  const beforeBirthday = asOfParts.m < birth.m || (asOfParts.m === birth.m && asOfParts.d < birth.d);
  return asOfParts.y - birth.y - (beforeBirthday ? 1 : 0);
}

/**
 * The next time this birthday comes around, including today.
 * A 02-29 birthday falls on 03-01 in common years (reported as a note, the
 * stored value is never rewritten).
 */
export function nextOccurrence(birth, asOfParts) {
  if (birth === null || birth === undefined || birth.precision !== 'day') return null;

  const occurrenceIn = (year) => {
    if (birth.m === 2 && birth.d === 29 && !isLeapYear(year)) {
      return { y: year, m: 3, d: 1, note: 'leap-day' };
    }
    return { y: year, m: birth.m, d: birth.d };
  };

  let candidate = occurrenceIn(asOfParts.y);
  if (daysBetween(asOfParts, candidate) < 0) candidate = occurrenceIn(asOfParts.y + 1);
  const inDays = daysBetween(asOfParts, candidate);
  return {
    date: `${candidate.y}-${pad(candidate.m)}-${pad(candidate.d)}`,
    inDays,
    turningAge: candidate.y - birth.y,
    ...(candidate.note === undefined ? {} : { note: candidate.note }),
  };
}

export const STALE_DAYS = { immutable: null, slow: 365, volatile: 90 };

/** How old an observation is, and whether that is too old for its stability. */
export function staleness(stability, observedAtMs, asOfMs = Date.now()) {
  const ageDays = Math.max(0, Math.floor((asOfMs - observedAtMs) / DAY_MS));
  // `??` would turn the explicit `immutable: null` into the slow threshold.
  const threshold = Object.prototype.hasOwnProperty.call(STALE_DAYS, stability) ? STALE_DAYS[stability] : STALE_DAYS.slow;
  return { ageDays, threshold, stale: threshold !== null && ageDays > threshold };
}

export function formatDateText(parts) {
  if (parts === null || parts === undefined) return '';
  if (parts.precision === 'year') return String(parts.y);
  if (parts.precision === 'month') return `${parts.y}-${pad(parts.m)}`;
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

export { pad };
