/**
 * dsh-profile-vault — 个人信息库。
 *
 * 以姓名为索引存取人物资料；读取在工具执行边界上先向用户要授权（按会话、
 * 按主体、敏感信息单独一层），写入随时可用但受凭证拦截与登记表约束。
 * 派生值（年龄、下次生日）不落盘，读取时按 asOf 现算。
 */
import { createStore } from './lib/store.js';
import { createVault, OpsError } from './lib/ops.js';
import { createConsent, TIER_NORMAL, TIER_SENSITIVE } from './lib/grants.js';
import { createRoutes } from './lib/routes.js';
import { summarize, viewPerson } from './lib/read.js';
import { parseAsOf } from './lib/time.js';
import { normalizeName, presentName } from './lib/names.js';
import { resolveEntry } from './lib/registry.js';

export const inject = ['tools', 'webServer', 'connection'];

const QUERY_PATH = '/profile-vault/query';
const WRITE_PATH = '/profile-vault/write';
const CONSENT_TIMEOUT_MS = 300000;

const GUIDANCE =
  '个人信息库（profile_* 工具）：\n' +
  '- 用户提到某个人的稳定信息（生日、口味、单位、证件…）时用 profile_remember 落库，并带上 observedAt（这件事成立/发生的时间）；不传会被当成"刚刚"。\n' +
  '- 不要存年龄、生肖、星座，也不要自己算：存生日，读取时用返回的 computed（年龄、下次生日）。\n' +
  '- 读库会弹授权卡；被拒绝或询问失败就照实告诉用户，不要换名字、换个人重试。身份证/银行卡这类敏感条目默认只返回掩码，要完整值需用户单独授权。\n' +
  '- 写身份证/银行卡号这类信息时提醒用户它会明文存在本机；只需要尾号时用 valueMode: "last4"。';

function normalizeConfig(raw) {
  const config = raw ?? {};
  return {
    dataDir: typeof config.dataDir === 'string' && config.dataDir !== '' ? config.dataDir : undefined,
    consentTtlHours: Number.isFinite(config.consentTtlHours) ? config.consentTtlHours : 24,
    consentTimeoutMs: Number.isFinite(config.consentTimeoutMs) ? config.consentTimeoutMs : CONSENT_TIMEOUT_MS,
    injectGuidance: config.injectGuidance !== false,
    denyEntries: Array.isArray(config.denyEntries) ? config.denyEntries.filter((item) => typeof item === 'string') : [],
  };
}

function failure(error) {
  if (error instanceof OpsError || typeof error?.code === 'string') {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(Array.isArray(error.choices) ? { choices: error.choices } : {}),
    };
  }
  return { ok: false, code: 'internal', message: String(error?.message ?? error) };
}

function personSubject(input) {
  if (typeof input?.personId === 'string' && input.personId !== '') {
    return { type: 'person', key: `id:${input.personId}`, label: input.personId };
  }
  const name = presentName(input?.name ?? '');
  return { type: 'person', key: `name:${normalizeName(name)}`, label: name };
}

const INDEX_SUBJECT = { type: 'index', key: 'index', label: '姓名索引' };

function lineOfEntry(entry) {
  const parts = [`${entry.label}: ${entry.current === null ? '（空）' : entry.current.value}`];
  if (entry.unit !== undefined && entry.unit !== null && entry.kind === 'number') parts[0] += '';
  if (entry.current !== null) {
    parts.push(`观测 ${entry.current.observedAt.slice(0, 10)}`);
    if (entry.current.confidence !== 'stated') parts.push(`置信 ${entry.current.confidence}`);
    if (entry.current.masked === true) parts.push('掩码');
  }
  const out = [`- ${parts.join(' · ')}`];
  if (entry.computed?.ageYears !== undefined) {
    const next = entry.computed.nextOccurrence;
    const ageLine =
      next === undefined
        ? `  现算：${entry.computed.ageYears} 岁${entry.computed.approximate === true ? '（近似）' : ''}`
        : `  现算：${entry.computed.ageYears} 岁${entry.computed.approximate === true ? '（近似）' : ''}；下次 ${next.date}（${next.inDays === 0 ? '就是今天' : `还有 ${next.inDays} 天`}，届时 ${next.turningAge} 岁）`;
    out.push(ageLine);
  } else if (entry.computed?.nextOccurrence !== undefined) {
    const next = entry.computed.nextOccurrence;
    out.push(`  下次 ${next.date}（${next.inDays === 0 ? '就是今天' : `还有 ${next.inDays} 天`}）`);
  }
  for (const warning of entry.warnings ?? []) out.push(`  ⚠ ${warning}`);
  return out.join('\n');
}

function renderPersonView(value) {
  if (value?.ok === false) return `【未返回数据】${value.code}: ${value.message}`;
  const lines = [];
  const person = value.person;
  const relation = person.relation ? `（${person.relation}）` : '';
  lines.push(`${person.displayName}${relation} · ${person.entriesCount} 条条目 · 数据时间点 ${value.asOfText ?? String(value.asOf ?? '').slice(0, 10)}`);
  for (const entry of value.entries ?? []) lines.push(lineOfEntry(entry));
  if ((value.entries ?? []).length === 0) lines.push('（这个人还没有任何条目）');
  if (value.truncated === true) lines.push('（条目太多，只列了前 60 条）');
  return lines.join('\n');
}

function renderRemember(value) {
  if (value?.ok === false) return `【没有写入】${value.code}: ${value.message}`;
  const written = Array.isArray(value.added) && value.added.length > 0 ? value.added.map((item) => item.value).join('、') : null;
  // `unchanged` adds nothing, so fall back to the value the vault now holds.
  const shown = written ?? value.value ?? '（未变）';
  const verb = value.change === 'unchanged' ? '没有变化' : '已记录';
  const head = `${verb}：${value.person.displayName} · ${value.entry.label} = ${shown}${value.person.created === true ? '（新建人物）' : ''}`;
  const lines = [head];
  if (value.change === 'superseded' && value.previous) {
    lines.push(`覆盖了旧值：${value.previous.value}（观测于 ${String(value.previous.observedAt).slice(0, 10)}，历史仍保留）`);
  }
  for (const warning of value.warnings ?? []) lines.push(`⚠ ${warning}`);
  if (value.computed?.ageYears !== undefined) {
    const next = value.computed.nextOccurrence;
    lines.push(
      `现算：${value.computed.ageYears} 岁${next === undefined ? '' : `；下次生日 ${next.date}（届时 ${next.turningAge} 岁）`}`,
    );
  }
  return lines.join('\n');
}

function renderList(value) {
  if (value?.ok === false) return `【未返回数据】${value.code}: ${value.message}`;
  if (Array.isArray(value.people)) {
    if (value.people.length === 0) return '资料库还是空的。用 profile_remember 记第一个人的信息就会建档。';
    const lines = [`资料库里有 ${value.people.length} 个人：`];
    for (const person of value.people) {
      const relation = person.relation ? `（${person.relation}）` : '';
      lines.push(`- ${person.displayName}${relation} · ${person.entriesCount} 条条目 · 更新 ${String(person.updatedAt).slice(0, 10)}`);
    }
    return lines.join('\n');
  }
  const lines = [`${value.person.displayName} · ${value.person.entriesCount} 条条目`];
  for (const entry of value.entries ?? []) {
    lines.push(`- ${entry.label}（${entry.key}）· ${entry.observations} 条观测 · 最后 ${String(entry.lastObservedAt ?? '').slice(0, 10)}${entry.stale === true ? ' · 可能过期' : ''}`);
  }
  if ((value.entries ?? []).length === 0) lines.push('（还没有条目）');
  return lines.join('\n');
}

function renderForget(value) {
  if (value?.ok === false) return `【没有删除】${value.code}: ${value.message}`;
  return value.message ?? '已删除。';
}

function renderGrants(value) {
  if (value?.ok === false) return `【失败】${value.code}: ${value.message}`;
  if (value.action === 'revoke') return `已撤销 ${value.revoked} 条授权。`;
  if ((value.grants ?? []).length === 0) return '本会话没有任何读取授权。';
  const lines = ['本会话的读取授权：'];
  for (const grant of value.grants) {
    const tier = grant.tier === 'sensitive' ? '（敏感）' : '';
    lines.push(`- ${grant.subject.label}${tier} · 到期 ${String(grant.expiresAt).slice(0, 16).replace('T', ' ')} · 已用 ${grant.useCount} 次`);
  }
  return lines.join('\n');
}

const objectSchema = (properties) => ({ type: 'object', properties, required: [], additionalProperties: false });

/**
 * Output schema. The host validates a tool result against this schema *at call
 * time* and rejects the whole call when it disagrees ("returned invalid output"),
 * after the write already happened. So results are declared by name only, with no
 * type constraints: the fields are rendered to text by `output.render`, and a
 * wrong guess about one field's shape must never turn a successful write into an
 * error. Parameter schemas stay fully typed and closed.
 */
const resultSchema = (properties) => ({
  type: 'object',
  properties: Object.fromEntries(Object.keys(properties).map((key) => [key, {}])),
  required: [],
  additionalProperties: true,
});

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const store = createStore({ root: config.dataDir });
  const vault = createVault({ store, config });
  const consent = createConsent({ store, config, logger: ctx.logger });
  const routes = createRoutes({ vault, store, consent, logger: ctx.logger });
  const connection = ctx.connection;
  const disposers = [];

  const authorize = (exec, subject, tier, hint) =>
    consent.authorize({
      userQuestions: typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined,
      agent: exec.agent,
      signal: exec.signal,
      callId: exec.callId,
      subject,
      tier,
      hint,
    });

  async function record(exec, extra) {
    try {
      await store.appendAudit({
        actor: 'tool',
        sessionId: exec?.agent?.id ?? null,
        ...extra,
      });
    } catch {
      // Audit is evidence, not a gate: never turn a logging fault into a data leak or a crash.
    }
  }

  const remember = {
    name: 'profile_remember',
    description:
      '把某个人的一条信息记进个人信息库（以姓名为索引）。人物不存在会自动建档；同一条目再写一次会追加新观测、把旧值标记为被取代而不是覆盖。' +
      '身份类信息（身份证/银行卡号）会落盘并给警告，只需尾号时传 valueMode: "last4"。密码、密钥、验证码会被拒收。不需要用户授权。',
    parameters: objectSchema({
      name: { type: 'string', description: '姓名；会给这个人建档或匹配已有别名。' },
      personId: { type: 'string', description: '已知档案 id 时优先用它，避免重名歧义。' },
      relation: { type: 'string', description: '与用户的关系：母亲/同事/客户…，新建时写入。' },
      aliases: { type: 'array', items: { type: 'string' }, description: '这个人的其他称呼（妈妈、老妈），之后按别名也能查到。' },
      entry: { type: 'string', description: '条目名或别名：生日 / 出生日期 / birthday 等价；未登记的名字会作为自定义条目。' },
      value: {
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: '值。日期用 1968-05-12（也接受 1968-05 或 1968）；数字只写数字；多值条目可直接给数组。',
      },
      observedAt: {
        type: 'string',
        description: '这件事成立/发生的时间（不是"现在"）。如"三个月前量的体重"就写那天的日期。缺省=现在。',
      },
      evidence: { type: 'string', description: '对话里的原话片段，便于以后核对（≤200 字）。' },
      confidence: { type: 'string', enum: ['stated', 'inferred', 'imported'], description: '用户直说 / 你推断 / 导入。' },
      valueMode: { type: 'string', enum: ['full', 'last4'], description: '身份类信息只要尾号时传 last4，完整值不落盘。' },
      sensitive: { type: 'boolean', description: '强制把这条标成敏感（默认由条目登记表判断）。' },
    }),
    output: {
      schema: resultSchema({
        ok: { type: 'boolean' },
        code: { type: 'string' },
        message: { type: 'string' },
        change: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        person: { type: 'object' },
        entry: { type: 'object' },
        added: { type: 'number' },
        // Nullable in practice (a first write has no previous value), so no type.
        previous: {},
        computed: {},
        value: {},
      }),
      render(_args, value) {
        return [{ type: 'text', text: renderRemember(value) }];
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        let person = null;
        if (typeof args.personId === 'string' && args.personId !== '') {
          person = await vault.find({ personId: args.personId });
        } else {
          try {
            person = await vault.find({ name: args.name });
          } catch (error) {
            if (error?.code !== 'not_found') throw error;
          }
        }
        let created = false;
        if (person === null) {
          if (presentName(args.name ?? '') === '') throw new OpsError('invalid_request', '需要姓名才能建档');
          person = await vault.createPerson(
            { displayName: args.name, relation: args.relation, aliases: args.aliases },
            { kind: 'tool', sessionId: exec.agent?.id ?? null, toolCallId: exec.callId ?? null },
          );
          created = true;
        }

        const result = await vault.putEntry({
          personId: person.id,
          entryKey: args.entry,
          value: args.value,
          observedAt: args.observedAt,
          evidence: args.evidence,
          confidence: args.confidence,
          sensitive: args.sensitive === true,
          valueMode: args.valueMode,
          source: { kind: 'tool', sessionId: exec.agent?.id ?? null, agentId: exec.agent?.id ?? null, toolCallId: exec.callId ?? null },
        });

        const asOf = parseAsOf(undefined);
        const view = viewPerson(result.person, {
          asOfMs: asOf.date.getTime(),
          asOfParts: asOf.parts,
          revealSensitive: false,
          includeHistory: false,
          includeEvidence: false,
          entryKeys: [result.entry.key],
        });
        const entryView = view.entries[0] ?? null;

        await record(exec, { op: 'write', personId: result.person.id, entryKey: result.entry.key, result: result.change });
        return {
          ok: true,
          person: { personId: result.person.id, displayName: result.person.displayName, created },
          entry: result.entry,
          added: result.added,
          change: result.change,
          previous: result.previous,
          warnings: result.warnings,
          computed: entryView?.computed ?? null,
          // What the vault holds now — needed when nothing was added.
          value: entryView?.current?.value ?? null,
        };
      } catch (error) {
        return failure(error);
      }
    },
  };

  const get = {
    name: 'profile_get',
    description:
      '按"姓名 + 条目"读取资料库里某个人的数据。第一次读某个人（或第一次要敏感条目的完整值）会弹授权卡，用户不点允许就什么都拿不到。' +
      '生日这类条目的年龄、下次生日由返回值里的 computed 给出（按 asOf 现算），不要自己算。身份证/银行卡号默认是掩码，要完整值必须传 revealSensitive 并得到用户对敏感条目的单独授权。',
    parameters: objectSchema({
      name: { type: 'string', description: '姓名或已登记的别名。' },
      personId: { type: 'string', description: '已知档案 id 时优先使用。' },
      entry: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: '条目名或别名，可给数组；不给则返回该人全部条目。',
      },
      asOf: { type: 'string', description: '以这个时间点计算年龄/下次生日（如给某人下个月订生日蛋糕，传那天的日期），缺省现在。' },
      includeHistory: { type: 'boolean', description: '是否带上被取代的旧观测。' },
      includeEvidence: { type: 'boolean', description: '是否带上当时记下的原话片段。' },
      revealSensitive: { type: 'boolean', description: '要敏感条目的完整值时必须显式传 true，会单独征求一次授权。' },
    }),
    output: {
      schema: resultSchema({
        ok: { type: 'boolean' },
        code: { type: 'string' },
        message: { type: 'string' },
        person: { type: 'object' },
        entries: { type: 'array' },
        truncated: { type: 'boolean' },
        asOf: { type: 'string' },
        asOfText: { type: 'string' },
        unknownKeys: { type: 'array' },
        unknownEntries: { type: 'array' },
      }),
      render(_args, value) {
        return [{ type: 'text', text: renderPersonView(value) }];
      },
    },
    timeoutMs: CONSENT_TIMEOUT_MS + 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const subject = personSubject(args);
        const tier = args.revealSensitive === true ? TIER_SENSITIVE : TIER_NORMAL;
        const hint = Array.isArray(args.entry) ? args.entry.join('、') : args.entry;
        const allowed = await authorize(exec, subject, tier, hint);
        if (!allowed.ok) return { ok: false, code: allowed.code, message: allowed.message };

        const person = await vault.find({ personId: args.personId, name: args.name });
        const asOf = parseAsOf(args.asOf);
        if (asOf === null) return { ok: false, code: 'invalid_value', message: `asOf 无法解析：${String(args.asOf)}` };

        const rawEntries = Array.isArray(args.entry) ? args.entry : args.entry ? [args.entry] : [];
        const wanted = [];
        const unknown = [];
        for (const raw of rawEntries) {
          const resolved = resolveEntry(raw);
          if (!resolved.ok) {
            if (resolved.code === 'derived_entry') return { ok: false, code: resolved.code, message: resolved.message };
            unknown.push(String(raw));
            continue;
          }
          wanted.push(resolved.entry.key);
        }
        if (wanted.length === 0 && unknown.length > 0) {
          const available = Object.values(person.entries ?? {}).map((entryRecord) => entryRecord.label);
          return {
            ok: false,
            code: 'unknown_entry',
            message: `这个人没有「${unknown.join('、')}」。已有条目：${available.length === 0 ? '（空）' : available.join('、')}`,
          };
        }

        const view = viewPerson(person, {
          asOfMs: asOf.date.getTime(),
          asOfParts: asOf.parts,
          revealSensitive: args.revealSensitive === true,
          includeHistory: args.includeHistory === true,
          includeEvidence: args.includeEvidence === true,
          entryKeys: wanted,
        });

        await record(exec, { op: 'read', subject: subject.key, entries: wanted.length === 0 ? 'all' : wanted, decision: allowed.mode });
        return {
          ok: true,
          ...view,
          ...(unknown.length === 0 ? {} : { unknownEntries: unknown }),
        };
      } catch (error) {
        return failure(error);
      }
    },
  };

  const list = {
    name: 'profile_list',
    description:
      '不带姓名：列出资料库里有哪些人（姓名索引，需要一次索引授权）。带姓名：列出这个人的条目清单与每个条目的观测数量，不含具体值（除非 includeValues: true）。' +
      '先用它确认"资料库里有没有这个人/这个条目"，再决定要不要 profile_get。',
    parameters: objectSchema({
      name: { type: 'string', description: '给了就只列这个人的条目。' },
      personId: { type: 'string', description: '已知档案 id。' },
      includeValues: { type: 'boolean', description: '连最新值一起给（等同一次读取，仍受同一授权约束）。' },
      limit: { type: 'number', description: '人数上限，默认 50，最大 200。' },
    }),
    output: {
      schema: resultSchema({
        ok: { type: 'boolean' },
        code: { type: 'string' },
        message: { type: 'string' },
        people: { type: 'array' },
        total: { type: 'number' },
        truncated: { type: 'boolean' },
        person: { type: 'object' },
        entries: { type: 'array' },
      }),
      render(_args, value) {
        return [{ type: 'text', text: renderList(value) }];
      },
    },
    timeoutMs: CONSENT_TIMEOUT_MS + 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const wantsPerson = typeof args.name === 'string' && args.name !== '' || typeof args.personId === 'string' && args.personId !== '';
        const subject = wantsPerson ? personSubject(args) : INDEX_SUBJECT;
        const hint = wantsPerson ? '条目清单' : undefined;
        const allowed = await authorize(exec, subject, TIER_NORMAL, hint);
        if (!allowed.ok) return { ok: false, code: allowed.code, message: allowed.message };

        if (!wantsPerson) {
          const people = await vault.list();
          const limit = Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : 50, 1), 200);
          const rows = people
            .map((person) => summarize(person))
            .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
            .slice(0, limit);
          await record(exec, { op: 'read', subject: 'index', entries: 'index', decision: allowed.mode });
          return { ok: true, people: rows, total: people.length, truncated: people.length > rows.length };
        }

        const person = await vault.find({ personId: args.personId, name: args.name });
        if (args.includeValues === true) {
          const asOf = parseAsOf(undefined);
          const view = viewPerson(person, {
            asOfMs: asOf.date.getTime(),
            asOfParts: asOf.parts,
            revealSensitive: false,
            includeHistory: false,
            includeEvidence: false,
          });
          await record(exec, { op: 'read', subject: subject.key, entries: 'all', decision: allowed.mode });
          return { ok: true, ...view };
        }

        const now = Date.now();
        const entries = Object.values(person.entries ?? {}).map((entryRecord) => {
          const active = entryRecord.observations.filter((observation) => observation.supersededAt === null || observation.supersededAt === undefined);
          const last = active.reduce((best, current) => (best === null || current.seq > best.seq ? current : best), null);
          const thresholds = { immutable: Infinity, slow: 365, volatile: 90 };
          const threshold = thresholds[entryRecord.stability] ?? 365;
          const ageDays = last === null ? 0 : Math.floor((now - Date.parse(last.observedAt)) / 86400000);
          return {
            key: entryRecord.key,
            label: entryRecord.label,
            kind: entryRecord.kind,
            cardinality: entryRecord.cardinality,
            stability: entryRecord.stability,
            tier: entryRecord.tier ?? 'normal',
            observations: active.length,
            lastObservedAt: last?.observedAt ?? null,
            stale: ageDays > threshold,
          };
        });
        await record(exec, { op: 'read', subject: subject.key, entries: 'list', decision: allowed.mode });
        return { ok: true, person: summarize(person), entries };
      } catch (error) {
        return failure(error);
      }
    },
  };

  const forget = {
    name: 'profile_forget',
    description:
      '删除资料库里的数据：某个人的一条观测（observationId）、某个条目（entry），或者整个人（person: true）。' +
      '删除会先移进 trash/ 目录保留 30 天。需要用户授权（同一个人的读取授权）。必须传 confirm: true。',
    parameters: objectSchema({
      name: { type: 'string', description: '姓名或别名。' },
      personId: { type: 'string', description: '已知档案 id。' },
      entry: { type: 'string', description: '要删的条目。' },
      observationId: { type: 'string', description: '要删的单条观测 id（profile_get 的 history 里给）。' },
      person: { type: 'boolean', description: 'true = 删整个人的档案，必须同时给 confirmName。' },
      confirmName: { type: 'string', description: '删除整个人时，把姓名原样再写一遍；不给则用 name。' },
      reason: { type: 'string', description: '用户要求删除的原因，写进审计。' },
      confirm: { type: 'boolean', description: '固定传 true，防误触。' },
    }),
    output: {
      schema: resultSchema({ ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' } }),
      render(_args, value) {
        return [{ type: 'text', text: renderForget(value) }];
      },
    },
    timeoutMs: CONSENT_TIMEOUT_MS + 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (args.confirm !== true) {
          return { ok: false, code: 'confirm_required', message: '删除需要确认：请向用户说明要删什么，然后在 confirm 传 true 再调一次。' };
        }
        const subject = personSubject(args);
        const allowed = await authorize(exec, subject, TIER_NORMAL, '删除');
        if (!allowed.ok) return { ok: false, code: allowed.code, message: allowed.message };

        if (args.person === true) {
          const removed = await vault.removePerson({
            personId: args.personId,
            name: args.name,
            confirmName: args.confirmName ?? args.name,
          });
          await record(exec, { op: 'delete', personId: removed.personId, scope: 'person', reason: args.reason ?? null });
          return { ok: true, message: `已删除「${removed.displayName}」的整个档案（移入 trash/，30 天后清理）。` };
        }
        if (typeof args.observationId === 'string' && args.observationId !== '') {
          const result = await vault.removeObservation({
            personId: args.personId,
            name: args.name,
            entryKey: args.entry,
            observationId: args.observationId,
          });
          await record(exec, { op: 'delete', personId: result.person.id, entryKey: result.removed.entryKey, scope: 'observation', reason: args.reason ?? null });
          return { ok: true, message: `已删除一条观测（${result.removed.value}）。` };
        }
        if (typeof args.entry === 'string' && args.entry !== '') {
          const result = await vault.removeEntry({ personId: args.personId, name: args.name, entryKey: args.entry });
          await record(exec, { op: 'delete', personId: result.person.id, entryKey: result.removed.key, scope: 'entry', reason: args.reason ?? null });
          return { ok: true, message: `已删除条目「${result.removed.label}」（含 ${result.removed.observations} 条观测，移入 trash/）。` };
        }
        return { ok: false, code: 'invalid_request', message: '要删什么？给 entry、observationId，或者 person: true。' };
      } catch (error) {
        return failure(error);
      }
    },
  };

  const grantsTool = {
    name: 'profile_grants',
    description: '查看或撤销本会话对这些人的读取授权。不需要授权。用户问"谁能读我的资料""把刚才的授权撤掉"时用它。',
    parameters: objectSchema({
      action: { type: 'string', enum: ['list', 'revoke'], description: 'list 列出本会话授权；revoke 撤销。' },
      grantId: { type: 'string', description: 'revoke 时给具体 grant id。' },
      all: { type: 'boolean', description: 'revoke 时 true = 撤销本会话全部授权。' },
    }),
    output: {
      schema: resultSchema({
        ok: { type: 'boolean' },
        code: { type: 'string' },
        message: { type: 'string' },
        action: { type: 'string' },
        revoked: { type: 'number' },
        grants: { type: 'array' },
      }),
      render(_args, value) {
        return [{ type: 'text', text: renderGrants(value) }];
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const sessionId = exec.agent?.id;
        if (sessionId === undefined) return { ok: false, code: 'consent_unavailable', message: '没有会话身份，看不到授权列表。' };
        if (args.action === 'revoke') {
          const result = await consent.revoke({ sessionId, grantId: args.grantId, all: args.all === true });
          return { ok: true, action: 'revoke', revoked: result.revoked };
        }
        const rows = await consent.listFor(sessionId);
        return { ok: true, action: 'list', grants: rows };
      } catch (error) {
        return failure(error);
      }
    },
  };

  disposers.push(ctx.tools.register(remember));
  disposers.push(ctx.tools.register(get));
  disposers.push(ctx.tools.register(list));
  disposers.push(ctx.tools.register(forget));
  disposers.push(ctx.tools.register(grantsTool));

  disposers.push(
    ctx.webServer.register({ kind: 'exact', path: QUERY_PATH, handler: routes.handlerFor(connection, 'query') }),
  );
  disposers.push(
    ctx.webServer.register({ kind: 'exact', path: WRITE_PATH, handler: routes.handlerFor(connection, 'write') }),
  );

  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id;
    if (sessionId === undefined) return;
    void consent.revokeSession(sessionId);
  });

  if (config.injectGuidance) {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      assembled.sections.push({ name: 'dsh-profile-vault:rules', text: GUIDANCE });
      return assembled;
    });
  }

  void store.ensure().catch(() => undefined);

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // Disposal errors must not mask the one that caused teardown.
      }
    }
    void consent.flush();
  };
}
