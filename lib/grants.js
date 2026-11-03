/**
 * Consent gate (D1, D2, D8).
 *
 * The gate sits at the tool boundary: `authorize()` runs before any file is
 * opened, so a refusal means the vault was not read at all. Grants are keyed by
 * `(session, subject, tier)` and never cross a session; the sensitive tier is
 * always short-lived even when persistent grants are enabled.
 */
import { id as newId } from './ids.js';

export const OPTION_SESSION = '允许本会话';
export const OPTION_ONCE = '仅本次';
export const OPTION_DENY = '拒绝';

export const TIER_NORMAL = 'normal';
export const TIER_SENSITIVE = 'sensitive';

function clockSkew(now, stamp) {
  return now - stamp;
}

export function subjectKey(subject, tier) {
  return `${subject.type}:${subject.key}:${tier}`;
}

export function createConsent({ store, config, logger }) {
  const ttlHours = Number.isFinite(config.consentTtlHours) ? config.consentTtlHours : 24;
  const pending = new Map();
  const usage = new Map();
  let flushTimer = null;
  let dirty = false;

  function sessionKey(sessionId, subject, tier) {
    return `${sessionId}|${subjectKey(subject, tier)}`;
  }

  function isValid(grant, sessionId, subject, tier, now) {
    return (
      grant.sessionId === sessionId &&
      grant.tier === tier &&
      grant.subject.type === subject.type &&
      grant.subject.key === subject.key &&
      grant.revokedAt === null &&
      Date.parse(grant.expiresAt) > now
    );
  }

  async function lookup(sessionId, subject, tier) {
    const data = await store.readGrants();
    const now = Date.now();
    const hit = data.grants.find((grant) => isValid(grant, sessionId, subject, tier, now));
    return hit ?? null;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 3000);
    if (typeof flushTimer === 'object' && flushTimer !== null && typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      const data = await store.readGrants();
      await store.writeGrants(data);
    } catch (error) {
      logger?.warn?.(`[profile-vault] 写 grants.json 失败：${error?.message ?? error}`);
    }
  }

  /**
   * Count a use without a synchronous disk write per read. Deltas are held here
   * and applied by `flush()` — mutating a copy read by `touch` would be lost when
   * `flush()` re-reads the file.
   */
  async function touch(grant) {
    if (typeof grant.id !== 'string') return;
    const delta = usage.get(grant.id) ?? { count: 0, at: null };
    delta.count += 1;
    delta.at = new Date().toISOString();
    usage.set(grant.id, delta);
    scheduleFlush();
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    const deltas = new Map(usage);
    usage.clear();
    try {
      const data = await store.readGrants();
      let changed = false;
      for (const grant of data.grants) {
        const delta = deltas.get(grant.id);
        if (delta === undefined) continue;
        grant.useCount = (grant.useCount ?? 0) + delta.count;
        grant.lastUsedAt = delta.at;
        changed = true;
      }
      if (changed) await store.writeGrants(data);
    } catch (error) {
      logger?.warn?.(`[profile-vault] 写 grants.json 失败：${error?.message ?? error}`);
    }
  }

  async function persist(sessionId, subject, tier, questionId, callId) {
    const data = await store.readGrants();
    const now = Date.now();
    const hours = tier === TIER_SENSITIVE ? Math.min(ttlHours, 24) : ttlHours;
    const grant = {
      id: newId('grant'),
      sessionId,
      subject,
      tier,
      scope: 'session',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
      questionId,
      callId,
      useCount: 0,
      lastUsedAt: null,
      revokedAt: null,
    };
    data.grants = data.grants.filter((item) => !isValid(item, sessionId, subject, tier, now));
    data.grants.push(grant);
    await store.writeGrants(data);
    return grant;
  }

  function describe(subject, tier, hint) {
    const who = subject.type === 'person' ? subject.label : '资料库的姓名索引';
    if (tier === TIER_SENSITIVE) {
      return {
        question: `允许本会话读取「${who}」的敏感信息吗？`,
        detail:
          '身份证号、银行卡号这类条目默认只给掩码。允许后本会话内可以看到完整值——它们会进入这次对话的上下文，并留在会话记录里。' +
          `${hint ? ` 本次涉及：${hint}。` : ''}`,
      };
    }
    if (subject.type === 'index') {
      return {
        question: '允许本会话查看资料库里有哪些人吗？',
        detail: '只返回姓名索引与条目数量，不返回任何值。可以随时在设置页撤销。',
      };
    }
    return {
      question: `允许本会话读取「${who}」的资料吗？`,
      detail:
        `读取范围：${hint ?? '该人的条目'}。允许后本会话内不再重复询问，24 小时后或会话结束自动失效，也可在设置页随时撤销。`,
    };
  }

  /**
   * Resolve permission before any read. `userQuestions` is passed instead of
   * captured so a missing service degrades into `consent_unavailable` rather than
   * a plugin that fails to load.
   */
  async function authorize({ userQuestions, agent, signal, callId, subject, tier, hint }) {
    if (agent === undefined || agent === null) {
      return { ok: false, code: 'consent_unavailable', message: '这个调用没有会话身份，无法向你确认授权，因此不读取任何数据。' };
    }
    const sessionId = agent.id;
    const existing = await lookup(sessionId, subject, tier);
    if (existing !== null) {
      void touch(existing);
      return { ok: true, grant: existing, mode: 'session' };
    }

    if (userQuestions === undefined || userQuestions === null) {
      return { ok: false, code: 'consent_unavailable', message: '当前宿主没有提供用户确认通道，无法征得授权，因此不读取任何数据。' };
    }

    const dedupe = sessionKey(sessionId, subject, tier);
    const running = pending.get(dedupe);
    if (running !== undefined) {
      const shared = await running;
      if (shared.ok) void touch(shared.grant);
      return shared;
    }

    const task = (async () => {
      const text = describe(subject, tier, hint);
      let answer;
      try {
        answer = await userQuestions.ask({
          questions: [
            {
              id: 'profile-consent',
              header: tier === TIER_SENSITIVE ? '敏感信息访问' : '个人信息访问',
              question: text.question,
              detail: text.detail,
              options: [
                { label: OPTION_SESSION, description: '本会话内不再重复询问；24 小时后或会话结束自动失效' },
                { label: OPTION_ONCE, description: '只放行这一次读取' },
                { label: OPTION_DENY, description: '不读取、不返回任何数据' },
              ],
            },
          ],
          agent,
          ...(signal === undefined ? {} : { signal }),
          ...(callId === undefined ? {} : { wait: { callId } }),
        });
      } catch (error) {
        return { ok: false, code: 'consent_unavailable', message: `授权询问没能完成（${error?.code ?? error?.message ?? '未知原因'}），按失败关闭处理，不读取任何数据。` };
      }

      const selected = answer?.answers?.[0]?.selected ?? [];
      if (selected.includes(OPTION_SESSION)) {
        const grant = await persist(sessionId, subject, tier, 'profile-consent', callId);
        return { ok: true, grant, mode: 'session' };
      }
      if (selected.includes(OPTION_ONCE)) {
        return { ok: true, grant: { id: 'grant_once', sessionId, subject, tier, scope: 'once' }, mode: 'once' };
      }
      return { ok: false, code: 'denied', message: '用户没有允许这次读取，因此没有返回任何数据。' };
    })();

    pending.set(dedupe, task);
    try {
      return await task;
    } finally {
      pending.delete(dedupe);
    }
  }

  async function listFor(sessionId) {
    const data = await store.readGrants();
    const now = Date.now();
    return data.grants.filter((grant) => grant.sessionId === sessionId && grant.revokedAt === null && Date.parse(grant.expiresAt) > now);
  }

  async function revoke({ sessionId, grantId, all }) {
    const data = await store.readGrants();
    const now = new Date().toISOString();
    let count = 0;
    for (const grant of data.grants) {
      if (grant.revokedAt !== null) continue;
      if (all === true) {
        if (grant.sessionId === sessionId) {
          grant.revokedAt = now;
          count += 1;
        }
      } else if (grant.id === grantId) {
        grant.revokedAt = now;
        count += 1;
      }
    }
    if (count > 0) await store.writeGrants(data);
    return { revoked: count };
  }

  /** A disposed session drops every grant it held: the reason it had one is gone. */
  async function revokeSession(sessionId) {
    const data = await store.readGrants();
    const now = new Date().toISOString();
    let count = 0;
    for (const grant of data.grants) {
      if (grant.sessionId === sessionId && grant.revokedAt === null) {
        grant.revokedAt = now;
        count += 1;
      }
    }
    if (count > 0) await store.writeGrants(data);
    return count;
  }

  async function prune() {
    const data = await store.readGrants();
    const now = Date.now();
    const kept = data.grants.filter((grant) => grant.revokedAt === null && clockSkew(now, Date.parse(grant.expiresAt)) < 0);
    const removed = data.grants.length - kept.length;
    if (removed > 0) {
      data.grants = kept;
      await store.writeGrants(data);
    }
    return { kept: kept.length, removed };
  }

  return { authorize, listFor, revoke, revokeSession, prune, flush, subjectKey, OPTION_SESSION, OPTION_ONCE, OPTION_DENY };
}
