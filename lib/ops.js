/**
 * The one write path (D10).
 *
 * Both the agent tool and the settings page call these functions, so a rule can
 * never hold on one side and not the other: credential refusal, derived-entry
 * refusal, capacity limits, single-value supersede semantics, and the audit
 * trail all live here.
 */
import { promises as fs } from 'node:fs';
import { id as newId } from './ids.js';
import { matchPeople, nameForms, normalizeName, presentName, labelFor } from './names.js';
import { resolveEntry } from './registry.js';
import {
  coerceMany,
  coerceValue,
  looksLikeCredential,
  looksLikeIdentity,
  maskValue,
  tailOf,
} from './values.js';
import { parseDateValue } from './time.js';

export const LIMITS = Object.freeze({
  people: 500,
  entriesPerPerson: 200,
  observationsPerEntry: 200,
  supersededKept: 20,
  textBytes: 2048,
});

export class OpsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isoOf(value, now) {
  if (value === undefined || value === null || value === '') return now.toISOString();
  if (typeof value !== 'string') throw new OpsError('invalid_value', 'observedAt 需要时间字符串，例如 2026-05-12 或 2026-05-12T10:00:00+08:00');
  const dateOnly = parseDateValue(value);
  if (dateOnly !== null) {
    return new Date(dateOnly.y, (dateOnly.m ?? 1) - 1, dateOnly.d ?? 1, 12, 0, 0).toISOString();
  }
  const stamp = Date.parse(value);
  if (Number.isNaN(stamp)) throw new OpsError('invalid_value', `无法解析时间：${value.slice(0, 40)}`);
  return new Date(stamp).toISOString();
}

function activeObservations(entryRecord) {
  return entryRecord.observations.filter((observation) => observation.supersededAt === null || observation.supersededAt === undefined);
}

function sortObservations(entryRecord) {
  entryRecord.observations.sort((left, right) => left.seq - right.seq);
}

export function createVault({ store, config }) {
  const now = () => new Date();

  // Read-modify-write serialization. The file store already serializes writes per
  // path, but each operation below starts from a snapshot it read before taking
  // that lock; two overlapping writes (an agent tool call and a click in the
  // settings page) would then overwrite each other. Writes are rare, so one
  // vault-wide queue is the cheapest correct answer.
  let writeChain = Promise.resolve();
  function withVaultLock(task) {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  function locked(fn) {
    return (...args) => withVaultLock(() => fn(...args));
  }

  async function list() {
    return store.readAll();
  }

  async function find(ref) {
    const people = await store.readAll();

    if (typeof ref?.personId === 'string' && ref.personId !== '') {
      const hit = people.find((person) => person.id === ref.personId);
      if (hit === undefined) throw new OpsError('not_found', '没有这个 personId 对应的档案');
      return hit;
    }

    const name = typeof ref?.name === 'string' ? ref.name : '';
    if (presentName(name) === '') throw new OpsError('invalid_request', '需要 name 或 personId');
    const matches = matchPeople(people, name);
    if (matches.length === 0) {
      throw new OpsError('not_found', `资料库里没有「${presentName(name)}」。要新建就用 profile_remember（会给这个人建档）。`);
    }
    if (matches.length > 1) {
      throw new OpsError('ambiguous', `「${presentName(name)}」对上 ${matches.length} 个人，请改用 personId：`, {
        choices: matches.map((person) => ({
          personId: person.id,
          relation: person.relation ?? null,
          entriesCount: Object.keys(person.entries ?? {}).length,
          updatedAt: person.updatedAt,
        })),
      });
    }
    return matches[0];
  }

  function assertNameFree(people, displayName, exceptId) {
    const wanted = normalizeName(displayName);
    const clash = people.find((person) => person.id !== exceptId && nameForms(person).has(wanted));
    if (clash !== undefined) {
      throw new OpsError('name_taken', `「${presentName(displayName)}」已经存在（personId ${clash.id}）。用同一个名字继续写就行，或者换个能区分的称呼。`, {
        personId: clash.id,
      });
    }
  }

  async function createPerson({ displayName, relation, aliases }, source) {
    const people = await store.readAll();
    if (people.length >= LIMITS.people) {
      throw new OpsError('too_large', `资料库最多 ${LIMITS.people} 个人，先删掉一些再建。`);
    }
    const name = presentName(displayName);
    if (name === '') throw new OpsError('invalid_request', '新建人物需要姓名');
    if (name.length > 64) throw new OpsError('invalid_value', '姓名超过 64 字');
    assertNameFree(people, name, null);

    const stamp = now().toISOString();
    const person = {
      schemaVersion: 1,
      rev: 0,
      id: newId('per'),
      displayName: name,
      aliases: normalizeAliases(aliases),
      relation: presentName(relation ?? ''),
      tags: [],
      note: '',
      createdAt: stamp,
      updatedAt: stamp,
      entries: {},
      provenance: source ?? { kind: 'panel' },
    };
    return store.createFile(person);
  }

  function normalizeAliases(input) {
    const list = Array.isArray(input) ? input : input === undefined || input === null || input === '' ? [] : [input];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const alias = presentName(item);
      if (alias === '' || seen.has(normalizeName(alias))) continue;
      seen.add(normalizeName(alias));
      out.push(alias);
      if (out.length >= 20) break;
    }
    return out;
  }

  async function putEntry(input) {
    const person = await find(input);
    // An existing entry is authoritative for its own definition: a stored custom
    // key ("x_咖啡") would otherwise be re-derived as a *different* custom key
    // ("x_x咖啡") and silently fork the entry in two.
    const askedKey = typeof input.entryKey === 'string' ? input.entryKey : typeof input.entry === 'string' ? input.entry : '';
    const stored = askedKey !== '' && Object.prototype.hasOwnProperty.call(person.entries ?? {}, askedKey) ? person.entries[askedKey] : undefined;
    let entry;
    if (stored !== undefined) {
      entry = Object.freeze({
        key: stored.key,
        label: stored.label,
        kind: stored.kind,
        cardinality: stored.cardinality,
        stability: stored.stability,
        tier: stored.tier ?? 'normal',
        ...(stored.unit === undefined || stored.unit === null ? {} : { unit: stored.unit }),
      });
    } else {
      const resolved = resolveEntry(input.entryKey ?? input.entry);
      if (!resolved.ok) throw new OpsError(resolved.code, resolved.message);
      entry = resolved.entry;
    }
    const denied = Array.isArray(config?.denyEntries) ? config.denyEntries : [];
    if (denied.includes(entry.key)) {
      throw new OpsError('value_rejected', `「${entry.label}」被配置里的 denyEntries 设为拒收。`);
    }
    const raw = input.value;
    const rawText = Array.isArray(raw) ? raw.map((item) => String(item)).join(' ') : String(raw ?? '');

    if (looksLikeCredential(rawText)) {
      throw new OpsError('value_rejected', '这个值看起来是密码/密钥/验证码，不存进资料库（存了没有收益，泄露不可撤销）。');
    }

    let coerced;
    let values;
    if (entry.cardinality === 'multi') {
      coerced = coerceMany(entry, raw);
      if (!coerced.ok) throw new OpsError(coerced.code, coerced.message);
      values = coerced.values;
    } else {
      coerced = coerceValue(entry, raw);
      if (!coerced.ok) throw new OpsError(coerced.code, coerced.message);
      values = [coerced.value];
    }

    const observedAt = isoOf(input.observedAt, now());
    const recordedAt = now().toISOString();
    const identityish = entry.tier === 'sensitive' || input.sensitive === true || looksLikeIdentity(String(values[0] ?? ''));
    const tier = identityish ? 'sensitive' : entry.tier;

    const wantedMode = input.valueMode === 'last4' ? 'last4' : 'full';
    const warnings = [];
    const storedValues = values.map((value) => {
      if (wantedMode === 'last4') return tailOf(String(value));
      if (input.maskValue === true) return maskValue(String(value));
      return value;
    });
    if (wantedMode === 'last4') {
      warnings.push('只保存了后四位（完整值按你的选择没有落盘）。');
    } else if (identityish && String(values[0] ?? '').length >= 8) {
      warnings.push(
        '这是身份类信息，会以明文保存在本机 ~/.dsh/dsh-profile-vault/；AI 在本会话获得敏感授权后才能读完整值，默认只看到掩码。只要尾号的话，可以用 valueMode: "last4"。',
      );
    }

    const existing = person.entries[entry.key];
    if (existing === undefined && Object.keys(person.entries).length >= LIMITS.entriesPerPerson) {
      throw new OpsError('too_large', `每个人最多 ${LIMITS.entriesPerPerson} 个条目，先删掉一些。`);
    }

    const record = existing ?? {
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      cardinality: entry.cardinality,
      stability: entry.stability,
      tier,
      ...(entry.unit === undefined ? {} : { unit: entry.unit }),
      ...(coerced.precision === undefined ? {} : { precision: coerced.precision }),
      observations: [],
      createdAt: recordedAt,
    };
    if (record.tier !== 'sensitive' && tier === 'sensitive') record.tier = 'sensitive';

    const active = activeObservations(record);
    const activeValues = new Set(active.map((observation) => String(observation.value).toLowerCase()));
    const superseded = [];
    const added = [];
    let nextSeq = record.observations.reduce((max, observation) => Math.max(max, observation.seq ?? 0), 0) + 1;

    for (const value of storedValues) {
      const isNew = !activeValues.has(String(value).toLowerCase());
      if (!isNew) continue;
      const observationId = newId('obs');
      if (entry.cardinality === 'single' && active.length > 0) {
        for (const observation of active) {
          observation.supersededAt = recordedAt;
          observation.supersededBy = observationId;
          superseded.push({ id: observation.id, value: observation.value, observedAt: observation.observedAt });
        }
        active.length = 0;
      }
      const observation = {
        id: observationId,
        seq: nextSeq,
        value,
        ...(coerced.precision === undefined ? {} : { precision: coerced.precision }),
        observedAt,
        recordedAt,
        confidence: input.confidence ?? (input.source?.kind === 'panel' ? 'stated' : 'stated'),
        ...(typeof input.evidence === 'string' && input.evidence.trim() !== ''
          ? { evidence: input.evidence.trim().slice(0, 200) }
          : {}),
        source: input.source ?? { kind: 'panel' },
        supersededAt: null,
        supersededBy: null,
      };
      nextSeq += 1;
      record.observations.push(observation);
      added.push({ id: observation.id, seq: observation.seq, value: observation.value, observedAt: observation.observedAt });
    }

    // Multi values that were already present still count as a no-op success.
    if (added.length === 0 && superseded.length === 0) {
      warnings.push('这个值已经在了，没有重复写入。');
    }

    const activeAfter = activeObservations(record);
    for (const observation of activeAfter) {
      if (observation.supersededBy === undefined) observation.supersededBy = null;
    }
    const supersededRecords = record.observations.filter((observation) => observation.supersededAt !== null);
    if (supersededRecords.length > LIMITS.supersededKept + 20) {
      const drop = new Set(
        supersededRecords
          .slice(0, supersededRecords.length - LIMITS.supersededKept)
          .map((observation) => observation.id),
      );
      record.observations = record.observations.filter((observation) => !drop.has(observation.id));
    }
    sortObservations(record);
    if (record.observations.length > LIMITS.observationsPerEntry) {
      throw new OpsError('too_large', `「${record.label}」的观测超过 ${LIMITS.observationsPerEntry} 条，先删掉一些旧记录。`);
    }

    record.lastObservedAt = observedAt;
    person.entries[entry.key] = record;
    const saved = await store.writePerson(person);

    return {
      person: saved,
      entry: {
        key: record.key,
        label: record.label,
        kind: record.kind,
        cardinality: record.cardinality,
        tier: record.tier,
        unit: record.unit ?? null,
      },
      added,
      superseded,
      change: superseded.length > 0 ? 'superseded' : added.length === 0 ? 'unchanged' : 'appended',
      previous: superseded.at(-1) ?? null,
      warnings,
      masked: wantedMode === 'last4' || input.maskValue === true,
    };
  }

  async function removeObservation({ personId, name, entryKey, observationId }) {
    const person = await find({ personId, name });
    const key = (await resolveKey(person, entryKey)).key;
    const record = person.entries[key];
    if (record === undefined) throw new OpsError('unknown_entry', `这个人没有「${entryKey}」这个条目`);
    const index = record.observations.findIndex((observation) => observation.id === observationId);
    if (index < 0) throw new OpsError('not_found', '没有这条观测（可能已经被删了）');
    const [removed] = record.observations.splice(index, 1);
    await store.trash('observation', { personId: person.id, entryKey: key, observation: removed });
    if (record.observations.length === 0) delete person.entries[key];
    const saved = await store.writePerson(person);
    return { person: saved, removed: { id: removed.id, value: removed.value, entryKey: key } };
  }

  async function resolveKey(person, entryKey) {
    const resolved = resolveEntry(entryKey);
    if (resolved.ok) return resolved;
    // Custom entries live under a derived key ("x_咖啡口味"), so a label lookup
    // has to compare against the stored label too, not just the key.
    const wanted = normalizeName(entryKey);
    const direct = Object.keys(person.entries).find(
      (key) => normalizeName(key) === wanted || normalizeName(person.entries[key].label) === wanted,
    );
    if (direct !== undefined) return { ok: true, entry: { key: direct, label: person.entries[direct].label } };
    throw new OpsError('unknown_entry', `这个人没有「${entryKey}」这个条目`);
  }

  async function removeEntry({ personId, name, entryKey }) {
    const person = await find({ personId, name });
    const key = (await resolveKey(person, entryKey)).key;
    const record = person.entries[key];
    if (record === undefined) throw new OpsError('unknown_entry', `这个人没有「${entryKey}」这个条目`);
    delete person.entries[key];
    await store.trash('entry', { personId: person.id, entry: record });
    const saved = await store.writePerson(person);
    return { person: saved, removed: { key, label: record.label, observations: record.observations.length } };
  }

  async function setPerson({ personId, name, displayName, relation, addAlias, removeAlias }) {
    const person = await find({ personId, name });
    if (displayName !== undefined && displayName !== null) {
      const next = presentName(displayName);
      if (next === '') throw new OpsError('invalid_request', '姓名不能为空');
      const people = await store.readAll();
      assertNameFree(people, next, person.id);
      person.displayName = next;
    }
    if (relation !== undefined && relation !== null) person.relation = presentName(relation);
    if (addAlias !== undefined && addAlias !== null && presentName(addAlias) !== '') {
      const alias = presentName(addAlias);
      const clash = await store.readAll();
      assertNameFree(clash, alias, person.id);
      if (!person.aliases.some((existing) => normalizeName(existing) === normalizeName(alias))) {
        person.aliases.push(alias);
      }
    }
    if (removeAlias !== undefined && removeAlias !== null) {
      const target = normalizeName(removeAlias);
      person.aliases = person.aliases.filter((alias) => normalizeName(alias) !== target);
    }
    const saved = await store.writePerson(person);
    return { person: saved };
  }

  async function removePerson({ personId, name, confirmName }) {
    const person = await find({ personId, name });
    const typed = presentName(confirmName ?? '');
    if (typed === '' || normalizeName(typed) !== normalizeName(person.displayName)) {
      throw new OpsError('confirm_mismatch', `删除整个人需要把姓名「${person.displayName}」原样再输一遍。`);
    }
    await store.trash('person', person, 'delete-person');
    await fs.rm(store.personPath(person.id), { force: true });
    return { personId: person.id, displayName: person.displayName };
  }

  return {
    store,
    list,
    find,
    createPerson: locked(createPerson),
    putEntry: locked(putEntry),
    removeObservation: locked(removeObservation),
    removeEntry: locked(removeEntry),
    setPerson: locked(setPerson),
    removePerson: locked(removePerson),
    labelFor,
  };
}
