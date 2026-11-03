/**
 * Tool-layer tests: the part the other tests cannot reach.
 *
 * `apply()` runs against a fake context, so these calls exercise argument handling,
 * registry refusals, and — most importantly — that every tool's returned value only
 * uses fields its declared output schema knows about. A closed schema plus an extra
 * field is a "returned invalid output" error at call time, which is not caught by
 * any unit test below the tool boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

async function mount(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pv-tools-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const tools = new Map();
  const ctx = {
    logger: { warn() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    webServer: { register: () => () => {} },
  };

  apply(ctx, { dataDir, injectGuidance: false });
  return tools;
}

function exec(sessionId = 'session-test') {
  return { agent: { id: sessionId }, callId: 'call-1', signal: undefined };
}

function declaredKeys(definition) {
  return new Set(Object.keys(definition.output.schema.properties ?? {}));
}

function assertDeclared(definition, value) {
  const declared = declaredKeys(definition);
  const extra = Object.keys(value ?? {}).filter((key) => !declared.has(key));
  assert.deepEqual(extra, [], `${definition.name} returned fields its output schema does not declare`);
}

test('profile_remember: writes, then reports what changed', async (t) => {
  const tools = await mount(t);
  const remember = tools.get('profile_remember');
  assert.ok(remember, 'profile_remember is registered');

  const created = await remember.execute(
    { name: '林黛玉', relation: '朋友', entry: '生日', value: '1990-05-12', observedAt: '2026-01-02' },
    exec(),
  );
  assert.equal(created.ok, true);
  assert.equal(created.change, 'appended');
  assert.equal(created.person.created, true);
  assert.equal(created.computed.ageYears, 36);
  assertDeclared(remember, created);

  const updated = await remember.execute({ personId: created.person.personId, entry: '生日', value: '1990-06-01' }, exec());
  assert.equal(updated.ok, true);
  assert.equal(updated.change, 'superseded');
  assert.equal(updated.previous.value, '1990-05-12');
  assertDeclared(remember, updated);
});

test('profile_remember: refusals carry a code the model can act on', async (t) => {
  const tools = await mount(t);
  const remember = tools.get('profile_remember');

  const derived = await remember.execute({ name: '贾宝玉', entry: '年龄', value: '18' }, exec());
  assert.equal(derived.ok, false);
  assert.equal(derived.code, 'derived_entry');

  const credential = await remember.execute({ name: '贾宝玉', entry: '密码', value: 'hunter2' }, exec());
  assert.equal(credential.ok, false);
  assert.equal(credential.code, 'value_rejected');

  const missingName = await remember.execute({ entry: '生日', value: '1990-01-01' }, exec());
  assert.equal(missingName.ok, false);
  assert.equal(missingName.code, 'invalid_request');
});

test('profile_get: refuses to read without a consent channel, and asks when there is one', async (t) => {
  const tools = await mount(t);
  const remember = tools.get('profile_remember');
  const get = tools.get('profile_get');

  const saved = await remember.execute({ name: '妙玉', entry: '生日', value: '1995-03-04' }, exec());
  const personId = saved.person.personId;

  const unavailable = await get.execute({ personId }, exec('session-a'));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'consent_unavailable');
  assertDeclared(get, unavailable);

  // Re-mount with a question service that says yes.
  const dataDir = await mkdtemp(join(tmpdir(), 'pv-tools-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const asked = [];
  const registry = new Map();
  const ctx = {
    logger: { warn() {}, error() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    get: (name) =>
      name === 'userQuestions'
        ? {
            ask: async (request) => {
              asked.push(request);
              return { answers: [{ id: 'profile-consent', selected: ['允许本会话'] }] };
            },
          }
        : undefined,
    tools: {
      register(definition) {
        registry.set(definition.name, definition);
        return () => {};
      },
    },
    webServer: { register: () => () => {} },
  };
  apply(ctx, { dataDir, injectGuidance: false });

  const created = await registry.get('profile_remember').execute({ name: '妙玉', entry: '生日', value: '1995-03-04' }, exec());
  const read = await registry.get('profile_get').execute(
    { personId: created.person.personId, entry: '生日', asOf: '2027-03-04' },
    exec('session-b'),
  );
  assert.equal(asked.length, 1);
  assert.equal(asked[0].questions[0].options.length, 3);
  assert.equal(read.ok, true);
  assert.equal(read.entries[0].computed.ageYears, 32);
  assert.equal(read.asOfText, '2027-03-04', 'the as-of day is shown in local calendar terms');
  assertDeclared(registry.get('profile_get'), read);

  // The grant is per session: a second session asks again.
  await registry.get('profile_get').execute({ personId: created.person.personId }, exec('session-c'));
  assert.equal(asked.length, 2);
});

test('profile_remember: reports the value even when nothing changed', async (t) => {
  const tools = await mount(t);
  const remember = tools.get('profile_remember');

  const first = await remember.execute({ name: '秦可卿', entry: '生日', value: '1990-05-12' }, exec());
  assert.equal(first.change, 'appended');
  assert.equal(first.value, '1990-05-12');

  const again = await remember.execute({ name: '秦可卿', entry: '生日', value: '1990-05-12' }, exec());
  assert.equal(again.change, 'unchanged');
  assert.deepEqual(again.added, []);
  assert.equal(again.value, '1990-05-12', 'an unchanged write still reports the stored value');
});

test('profile_forget: needs the literal confirm flag and never deletes silently', async (t) => {
  const tools = await mount(t);
  const remember = tools.get('profile_remember');
  const forget = tools.get('profile_forget');
  const saved = await remember.execute({ name: '史湘云', entry: '生日', value: '1992-02-29' }, exec());
  const noConfirm = await forget.execute({ personId: saved.person.personId, entry: '生日' }, exec());
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.code, 'confirm_required');
  assertDeclared(forget, noConfirm);

  const confirmed = await forget.execute({ personId: saved.person.personId, entry: '生日', confirm: true }, exec());
  assert.equal(confirmed.ok, false, 'deleting still needs consent');
  assert.equal(confirmed.code, 'consent_unavailable');
});

test('profile_grants: lists this session without asking anything', async (t) => {
  const tools = await mount(t);
  const grants = tools.get('profile_grants');
  const listed = await grants.execute({ action: 'list' }, exec('session-g'));
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.grants, []);
  assertDeclared(grants, listed);
});

test('every tool result schema stays permissive', async (t) => {
  const tools = await mount(t);
  assert.equal(tools.size, 5);
  for (const definition of tools.values()) {
    const schema = definition.output.schema;
    assert.equal(schema.additionalProperties, true, `${definition.name} must allow extra fields`);
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      // The host validates results at call time, after the write. A type guess
      // that turns out wrong breaks the tool, so results are name-only.
      assert.deepEqual(property, {}, `${definition.name}.${key} must not constrain its type`);
    }
  }
});
