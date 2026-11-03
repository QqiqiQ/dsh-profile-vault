/**
 * Read views.
 *
 * Reads never mutate and never invent: every number here is derived from a
 * stored observation plus the caller's `asOf`. Sensitivity is applied at this
 * boundary too — a sensitive value only reaches the caller unmasked when the
 * caller passed `revealSensitive` and holds the matching consent tier.
 */
import { ageYears, formatDateText, nextOccurrence, parseDateValue, partsOfDate, staleness } from './time.js';
import { maskValue } from './values.js';

const DAY_MS = 86400000;

function activeOf(record) {
  return record.observations.filter((observation) => observation.supersededAt === null || observation.supersededAt === undefined);
}

function latestOf(record) {
  const active = activeOf(record);
  if (active.length === 0) return null;
  return active.reduce((best, current) => (current.seq > best.seq ? current : best));
}

export function summarize(person) {
  return {
    personId: person.id,
    displayName: person.displayName,
    aliases: person.aliases ?? [],
    relation: person.relation ?? '',
    entriesCount: Object.keys(person.entries ?? {}).length,
    updatedAt: person.updatedAt,
    createdAt: person.createdAt,
  };
}

export function describeValue(record, value) {
  if (value === null || value === undefined) return '';
  if (record.kind === 'bool') return value === true ? '是' : '否';
  if (record.kind === 'number') return record.unit === undefined || record.unit === null ? String(value) : `${value} ${record.unit}`;
  return String(value);
}

/**
 * One entry, resolved for display: current value, derived facts, staleness, and
 * the masked flag a caller uses to decide whether it may show the raw string.
 */
export function viewEntry(record, options) {
  const { asOfMs, asOfParts, revealSensitive, includeHistory, includeEvidence } = options;
  const latest = latestOf(record);
  const active = activeOf(record);
  const sensitive = record.tier === 'sensitive';
  const masked = sensitive && revealSensitive !== true;
  const warnings = [];

  if (latest === null) {
    return {
      key: record.key,
      label: record.label,
      kind: record.kind,
      cardinality: record.cardinality,
      stability: record.stability,
      tier: record.tier ?? 'normal',
      unit: record.unit ?? null,
      current: null,
      observations: 0,
      history: [],
      warnings: ['这个条目下没有有效观测'],
    };
  }

  const shown = masked ? maskValue(latest.value) : latest.value;
  const age = staleness(record.stability, Date.parse(latest.observedAt), asOfMs);
  if (age.stale) {
    warnings.push(`这是 ${age.ageDays} 天前的观测（阈值 ${age.threshold} 天），涉及现值请先向本人确认。`);
  }
  if (masked) warnings.push('身份类信息，默认掩码；要看完整值需敏感授权 + revealSensitive。');

  const entry = {
    key: record.key,
    label: record.label,
    kind: record.kind,
    cardinality: record.cardinality,
    stability: record.stability,
    tier: record.tier ?? 'normal',
    unit: record.unit ?? null,
    observations: active.length,
    current: {
      id: latest.id,
      value: shown,
      masked,
      observedAt: latest.observedAt,
      recordedAt: latest.recordedAt,
      ageDays: age.ageDays,
      confidence: latest.confidence ?? 'stated',
      precision: latest.precision ?? null,
      source: latest.source?.kind ?? 'tool',
      ...(includeEvidence === true && typeof latest.evidence === 'string' ? { evidence: latest.evidence } : {}),
      ...(typeof latest.evidence === 'string' ? { hasEvidence: true } : {}),
    },
    history: [],
    warnings,
  };

  // A multi-valued entry holds several observations at once (two phone numbers,
  // three hobbies). `current` can only show one of them, so expose all of them —
  // otherwise a second email looks like it was never saved.
  if (record.cardinality === 'multi' && active.length > 1) {
    entry.values = [...active]
      .sort((left, right) => left.seq - right.seq)
      .map((observation) => ({
        id: observation.id,
        value: masked ? maskValue(observation.value) : observation.value,
        observedAt: observation.observedAt,
        recordedAt: observation.recordedAt,
        masked,
      }));
  }

  if (record.kind === 'date' && latest.value) {
    const parts = parseDateValue(String(latest.value));
    if (parts !== null) {
      const occurrence = parts.precision === 'day' ? nextOccurrence(parts, asOfParts) : null;
      const isBirthday = record.key === 'birthday' || record.key === 'birthday_lunar';
      if (isBirthday) {
        const years = ageYears(parts, asOfParts);
        entry.computed = {
          ageYears: years,
          ...(parts.precision !== 'day' ? { approximate: true } : {}),
          ...(occurrence === null ? {} : { nextOccurrence: occurrence }),
        };
        if (parts.precision !== 'day') {
          warnings.push('只记到年/月，年龄是近似值；要精确请在生日那条补全到日。');
        }
        if (occurrence?.note === 'leap-day') {
          warnings.push('2 月 29 日生日，平年按 3 月 1 日算；原始值没有改。');
        }
      } else if (occurrence !== null) {
        entry.computed = { nextOccurrence: occurrence };
      }
    }
  }

  if (includeHistory === true) {
    entry.history = [...record.observations]
      .sort((left, right) => right.seq - left.seq)
      .map((observation) => ({
        id: observation.id,
        value: sensitive && revealSensitive !== true ? maskValue(observation.value) : observation.value,
        observedAt: observation.observedAt,
        recordedAt: observation.recordedAt,
        confidence: observation.confidence ?? 'stated',
        supersededAt: observation.supersededAt ?? null,
        supersededBy: observation.supersededBy ?? null,
        source: observation.source?.kind ?? 'tool',
        ...(includeEvidence === true && typeof observation.evidence === 'string' ? { evidence: observation.evidence } : {}),
      }));
  }

  return entry;
}

/** Whole-person view; `entryKeys` narrows it to the entries actually asked for. */
export function viewPerson(person, options) {
  // `asOfMs` drives staleness and `asOfParts` drives birthday arithmetic; a
  // caller that only knows the timestamp still gets both.
  const asOfParts = options.asOfParts ?? partsOfDate(new Date(options.asOfMs));
  const entryOptions = { ...options, asOfParts };
  const wanted = Array.isArray(options.entryKeys) && options.entryKeys.length > 0 ? new Set(options.entryKeys) : null;
  const all = Object.values(person.entries ?? {});
  const selected = wanted === null ? all : all.filter((record) => wanted.has(record.key) || wanted.has(record.label));
  const truncated = wanted === null && selected.length > 60;
  const visible = truncated ? selected.slice(0, 60) : selected;

  return {
    person: {
      ...summarize(person),
      rev: person.rev ?? 0,
      note: person.note ?? '',
    },
    entries: visible.map((record) => viewEntry(record, entryOptions)),
    truncated,
    asOf: new Date(options.asOfMs).toISOString(),
    // The ISO stamp above is UTC; a reader asking "as of which day" wants the
    // caller's own calendar day (2027-01-01 must not print as 2026-12-31).
    asOfText: formatDateText(partsOfDate(new Date(options.asOfMs))),
    ...(wanted === null ? {} : { unknownKeys: [...wanted].filter((key) => !all.some((record) => record.key === key || record.label === key)) }),
  };
}
