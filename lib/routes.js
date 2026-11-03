/**
 * The settings page's data channel.
 *
 * A plain HTTP route rather than a Remote: the page only needs request/response
 * JSON, and a route keeps this plugin buildless. The first thing every request
 * does is ask `connection.requestRejection` — the host's login-token / loopback /
 * same-site fence. Without that call any local page could read or rewrite the
 * vault.
 */
import { OpsError } from './ops.js';
import { registryCatalog } from './registry.js';
import { summarize, viewPerson } from './read.js';
import { parseAsOf } from './time.js';

const MAX_BODY_BYTES = 256 * 1024;

const STATUS = {
  not_found: 404,
  ambiguous: 409,
  conflict: 409,
  name_taken: 409,
  confirm_mismatch: 400,
  invalid_request: 400,
  invalid_entry: 400,
  invalid_value: 400,
  unknown_entry: 404,
  value_rejected: 422,
  derived_entry: 422,
  too_large: 413,
  denied: 403,
  consent_unavailable: 503,
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return { ok: false, code: 'too_large' };
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'invalid_json' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
}

export function createRoutes({ vault, store, consent, logger }) {
  function viewSaved(person, extra = {}, options = {}) {
    const asOf = parseAsOf(undefined);
    return {
      ok: true,
      view: viewPerson(person, {
        asOfMs: asOf.date.getTime(),
        asOfParts: asOf.parts,
        revealSensitive: options.reveal === true,
        includeHistory: options.history === true,
        includeEvidence: options.evidence === true,
      }),
      ...extra,
    };
  }

  async function guardRevision(body) {
    if (!Number.isInteger(body.baseRev)) return;
    const person = await vault.find({ personId: body.personId, name: body.name });
    if ((person.rev ?? 0) !== body.baseRev) {
      throw new OpsError('conflict', '这条刚在别处改过（版本号已经变了）。已为你刷新，请确认后重新保存。', { rev: person.rev ?? 0 });
    }
  }

  async function handleQuery(body) {
    const op = body.op;
    if (op === 'list') {
      const people = await vault.list();
      const rows = people
        .map((person) => summarize(person))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return { ok: true, people: rows };
    }
    if (op === 'person') {
      const person = await vault.find({ personId: body.personId, name: body.name });
      return viewSaved(person, {}, { reveal: body.reveal === true, history: body.history === true, evidence: body.evidence === true });
    }
    if (op === 'meta') {
      const stats = await store.stats();
      const audit = await store.readAudit(30);
      return { ok: true, registry: registryCatalog(), stats, audit };
    }
    if (op === 'grants') {
      const data = await store.readGrants();
      const now = Date.now();
      return {
        ok: true,
        grants: data.grants
          .filter((grant) => grant.revokedAt === null && Date.parse(grant.expiresAt) > now)
          .map((grant) => ({
            id: grant.id,
            sessionId: grant.sessionId,
            subject: grant.subject,
            tier: grant.tier,
            expiresAt: grant.expiresAt,
            useCount: grant.useCount ?? 0,
            lastUsedAt: grant.lastUsedAt ?? null,
          })),
      };
    }
    throw new OpsError('invalid_request', `未知的读取操作：${String(op)}`);
  }

  async function handleWrite(body) {
    const op = body.op;
    // Writes answer with the same view the panel is showing, so a save followed
    // by a masked rebuild cannot leave the toolbar out of step with the values.
    const viewOptions = {
      reveal: body.reveal === true,
      history: body.history === true,
      evidence: body.evidence === true,
    };

    if (op === 'create-person') {
      const person = await vault.createPerson(
        { displayName: body.displayName, relation: body.relation, aliases: body.aliases },
        { kind: 'panel' },
      );
      await store.appendAudit({ actor: 'panel', op, personId: person.id, result: 'ok' });
      return viewSaved(person, { created: true }, viewOptions);
    }

    if (op === 'put-entry') {
      await guardRevision(body);
      const result = await vault.putEntry({
        personId: body.personId,
        name: body.name,
        entryKey: body.entryKey,
        value: body.value,
        observedAt: body.observedAt,
        evidence: body.evidence,
        valueMode: body.valueMode,
        sensitive: body.sensitive,
        source: { kind: 'panel' },
      });
      await store.appendAudit({
        actor: 'panel',
        op,
        personId: result.person.id,
        entryKey: result.entry.key,
        result: result.change,
      });
      return viewSaved(result.person, { change: result.change, warnings: result.warnings, entry: result.entry }, viewOptions);
    }

    if (op === 'delete-observation') {
      await guardRevision(body);
      const result = await vault.removeObservation({
        personId: body.personId,
        name: body.name,
        entryKey: body.entryKey,
        observationId: body.observationId,
      });
      await store.appendAudit({ actor: 'panel', op, personId: body.personId, entryKey: body.entryKey, result: 'ok' });
      return viewSaved(result.person, { removed: result.removed }, viewOptions);
    }

    if (op === 'update-observation') {
      await guardRevision(body);
      const result = await vault.updateObservation({
        personId: body.personId,
        name: body.name,
        entryKey: body.entryKey,
        observationId: body.observationId,
        value: body.value,
        observedAt: body.observedAt,
        valueMode: body.valueMode,
      });
      await store.appendAudit({ actor: 'panel', op, personId: body.personId, entryKey: body.entryKey, result: 'edited' });
      return viewSaved(result.person, { change: result.change, entry: result.entry, previous: result.previous }, viewOptions);
    }

    if (op === 'delete-entry') {
      await guardRevision(body);
      const result = await vault.removeEntry({ personId: body.personId, name: body.name, entryKey: body.entryKey });
      await store.appendAudit({ actor: 'panel', op, personId: body.personId, entryKey: body.entryKey, result: 'ok' });
      return viewSaved(result.person, { removed: result.removed }, viewOptions);
    }

    if (op === 'set-person') {
      await guardRevision(body);
      const result = await vault.setPerson({
        personId: body.personId,
        name: body.name,
        displayName: body.displayName,
        relation: body.relation,
        addAlias: body.addAlias,
        removeAlias: body.removeAlias,
      });
      await store.appendAudit({ actor: 'panel', op, personId: result.person.id, result: 'ok' });
      return viewSaved(result.person, {}, viewOptions);
    }

    if (op === 'delete-person') {
      const removed = await vault.removePerson({ personId: body.personId, name: body.name, confirmName: body.confirmName });
      await store.appendAudit({ actor: 'panel', op, personId: removed.personId, result: 'ok' });
      return { ok: true, removed };
    }

    if (op === 'revoke-grant') {
      const result = await consent.revoke({ sessionId: body.sessionId, grantId: body.grantId, all: body.all === true });
      await store.appendAudit({ actor: 'panel', op, grantId: body.grantId ?? null, result: `revoked:${result.revoked}` });
      return { ok: true, ...result };
    }

    throw new OpsError('invalid_request', `未知的写入操作：${String(op)}`);
  }

  function handlerFor(connection, mode) {
    const isWrite = mode === 'write';
    return async (req, res) => {
      try {
        const rejection = connection?.requestRejection?.(req);
        if (rejection !== undefined && rejection !== null) {
          res.statusCode = rejection;
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'expected POST' } });
          return;
        }
        const media = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
        if (media !== 'application/json') {
          sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'expected application/json' } });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code === 'too_large' ? 413 : 400, { error: { code: body.code, message: '请求体不是合法 JSON 对象' } });
          return;
        }
        const payload = body.value;
        const result = isWrite ? await handleWrite(payload) : await handleQuery(payload);
        sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof OpsError || typeof error?.code === 'string') {
          const code = error.code;
          const status = STATUS[code] ?? 400;
          sendJson(res, status, {
            error: {
              code,
              message: error.message,
              ...(error.choices === undefined ? {} : { choices: error.choices }),
              ...(error.rev === undefined ? {} : { rev: error.rev }),
              ...(error.personId === undefined ? {} : { personId: error.personId }),
            },
          });
          return;
        }
        logger?.error?.(`[profile-vault] 路由异常：${error?.stack ?? error}`);
        sendJson(res, 500, { error: { code: 'internal', message: '插件内部错误，详情见宿主日志' } });
      }
    };
  }

  return { handleQuery, handleWrite, handlerFor };
}
