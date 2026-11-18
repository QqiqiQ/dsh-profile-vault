/**
 * Lunar (Chinese calendar) birthdays.
 *
 * A lunar birthday is the same *lunar* day every year: 二〇〇六年十月初十 was
 * 2006-11-30 in 2006 and is 2026-11-18 in 2026. Storing it as a Gregorian date
 * therefore guarantees a wrong age the moment the year changes, so the stored
 * value is the lunar date itself, written `YYYY-MM-DD`.
 *
 * Conversion uses Intl's Chinese calendar (`u-ca-chinese`) rather than a bundled
 * 1900–2100 table: the runtime ships full ICU, so the epoch data belongs to the
 * platform and cannot rot in this repo.
 */
const FORMATTER = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const MONTH_BY_NAME = new Map(MONTH_NAMES.map((name, index) => [name, index + 1]));
// ICU writes the 11th and 12th months both ways depending on the year ("冬月"
// and "十一月" are the same month), so both spellings have to resolve.
MONTH_BY_NAME.set('十一月', 11);
MONTH_BY_NAME.set('十二月', 12);
MONTH_BY_NAME.set('一月', 1);
const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function dayWord(day) {
  if (day <= 10) return day === 10 ? '初十' : `初${DIGITS[day]}`;
  if (day < 20) return `十${DIGITS[day - 10]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${DIGITS[day - 20]}`;
  return '三十';
}

/** Gregorian (y, m, d — m is 1-based, local time) -> lunar parts. */
export function lunarOfSolar(year, month, day) {
  const parts = FORMATTER.formatToParts(new Date(year, month - 1, day, 12, 0, 0));
  let lunarYear = null;
  let monthName = '';
  let lunarDay = null;
  for (const part of parts) {
    if (part.type === 'relatedYear') lunarYear = Number(part.value);
    else if (part.type === 'year' && lunarYear === null) lunarYear = Number(part.value);
    else if (part.type === 'month') monthName = part.value;
    else if (part.type === 'day') lunarDay = Number(part.value);
  }
  const leap = monthName.startsWith('闰');
  const bare = leap ? monthName.slice(1) : monthName;
  const numeric = /^(\d{1,2})月$/.exec(bare);
  const lunarMonth = MONTH_BY_NAME.get(bare) ?? (numeric === null ? undefined : Number(numeric[1]));
  if (!Number.isInteger(lunarYear) || lunarMonth === undefined || !Number.isInteger(lunarDay)) {
    throw new Error(`无法换算农历：${year}-${month}-${day}`);
  }
  return { year: lunarYear, month: lunarMonth, day: lunarDay, leap };
}

/** Convenience for callers holding a Date. */
export function lunarOfDate(date) {
  return lunarOfSolar(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** `YYYY-MM-DD` (lunar) or `YYYY年M月D日` -> parts, or null. */
export function parseLunarDate(input) {
  if (typeof input !== 'string') return null;
  const text = input.normalize('NFKC').trim();
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 30) return null;
  return { year, month, day };
}

export function formatLunarValue(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** `农历 2006 年十月初十` — the human form shown in the panel and tool output. */
export function formatLunarText(parts) {
  const monthName = MONTH_NAMES[parts.month - 1] ?? `${parts.month} 月`;
  return `农历 ${parts.year} 年${monthName}${dayWord(parts.day)}`;
}

/** The Gregorian date of a given lunar date, or null when it cannot exist. */
export function solarOfLunar(parts) {
  // Start early in the lunar year and walk forward: lunar new year falls between
  // late January and late February, and the 12th month can spill into the next
  // Gregorian year.
  const start = new Date(parts.year, 0, 1, 12, 0, 0);
  for (let offset = 0; offset < 400; offset += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, 12, 0, 0);
    let lunar;
    try {
      lunar = lunarOfSolar(date.getFullYear(), date.getMonth() + 1, date.getDate());
    } catch {
      continue;
    }
    if (lunar.leap) continue;
    if (lunar.year === parts.year && lunar.month === parts.month && lunar.day === parts.day) {
      return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
    }
    if (lunar.year > parts.year) break;
  }
  return null;
}

/**
 * Next time this lunar month/day comes around, as a Gregorian date.
 * Returns `{ year, month, day, inDays, lunarYear, lunarText }` or null.
 */
export function nextLunarOccurrence(parts, asOfDate) {
  const base = new Date(asOfDate.getFullYear(), asOfDate.getMonth(), asOfDate.getDate(), 12, 0, 0);
  for (let offset = 0; offset <= 400; offset += 1) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12, 0, 0);
    const lunar = lunarOfSolar(date.getFullYear(), date.getMonth() + 1, date.getDate());
    if (lunar.leap || lunar.month !== parts.month || lunar.day !== parts.day) continue;
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      inDays: offset,
      lunarYear: lunar.year,
      lunarText: formatLunarText(lunar),
    };
  }
  return null;
}

/**
 * Age in completed lunar years. Birthdays count once the lunar month/day has
 * been reached — the same rule as the Gregorian path.
 */
export function lunarAge(birth, asOfDate) {
  const now = lunarOfDate(asOfDate);
  const passed = now.month > birth.month || (now.month === birth.month && now.day >= birth.day);
  return now.year - birth.year - (passed ? 0 : 1);
}
