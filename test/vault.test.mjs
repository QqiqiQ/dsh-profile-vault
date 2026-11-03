/**
 * Unit tests for the parts that encode a decision: name matching, time
 * arithmetic, masking, append-and-supersede, the consent gate, and the HTTP
 * route's masking/optimistic-lock behaviour.
 *
 * Every test runs against a throwaway root under the OS temp directory, so a
 * failing run can never touch ~/.dsh/dsh-profile-vault.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeName, matchPeople } from '../lib/names.js';
import { parseDateValue, ageYears, nextOccurrence, staleness } from '../lib/time.js';
import { maskValue, tailOf, coerceValue } from '../lib/values.js';
import { resolveEntry } from '../lib/registry.js';
import { createStore } from '../lib/store.js';
import { createVault } from '../lib/ops.js';
import { createConsent, OPTION_SESSION, OPTION_ONCE, OPTION_DENY } from '../lib/grants.js';
import { createRoutes } from '../lib/routes.js';

async function tempVault(t) {
  const root = await mkdtemp(join(tmpdir(), 'pv-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = createStore({ root });
  return { root, store, vault: createVault({ store, config: {} }) };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
  };
}

test('names: normalize, fold aliases, and stay case-insensitive', () => {
  assert.equal(normalizeName(' 张 三 '), '张三');
  assert.equal(normalizeName('ＺＨＡＮＧ'), 'zhang');
  assert.equal(normalizeName('·王·小·明·'), '王小明');

  const people = [
    { id: 'per_a', displayName: '林黛玉', aliases: ['黛玉', '林妹妹'] },
    { id: 'per_b', displayName: '贾宝玉', aliases: [] },
  ];
  assert.deepEqual(matchPeople(people, '林妹妹').map((person) => person.id), ['per_a']);
  assert.deepEqual(matchPeople(people, '贾宝 玉').map((person) => person.id), ['per_b']);
  assert.deepEqual(matchPeople(people, '薛宝钗'), []);
});

test('age: only counts this year once the birthday has passed', () => {
  const birth = parseDateValue('1968-05-12');
  assert.equal(ageYears(birth, { y: 2026, m: 5, d: 11 }), 57);
  assert.equal(ageYears(birth, { y: 2026, m: 5, d: 12 }), 58);
  assert.equal(ageYears(birth, { y: 2026, m: 11, d: 3 }), 58);
});

test('next occurrence: today is inDays 0, and 02-29 falls to 03-01', () => {
  const birth = parseDateValue('1990-05-12');
  const today = nextOccurrence(birth, { y: 2026, m: 5, d: 12 });
  assert.equal(today.date, '2026-05-12');
  assert.equal(today.inDays, 0);
  assert.equal(today.turningAge, 36);

  const passed = nextOccurrence(birth, { y: 2026, m: 5, d: 13 });
  assert.equal(passed.date, '2027-05-12');

  const leap = nextOccurrence(parseDateValue('2000-02-29'), { y: 2026, m: 2, d: 25 });
  assert.equal(leap.date, '2026-03-01');
  assert.equal(leap.note, 'leap-day');
});

test('staleness: volatile data goes stale after 90 days, immutable never', () => {
  const now = Date.parse('2026-11-03T00:00:00Z');
  const eightyDaysAgo = now - 80 * 86_400_000;
  const fourHundredDaysAgo = now - 400 * 86_400_000;
  assert.equal(staleness('volatile', eightyDaysAgo, now).stale, false);
  assert.equal(staleness('volatile', fourHundredDaysAgo, now).stale, true);
  assert.equal(staleness('immutable', Date.parse('1990-01-01T00:00:00Z'), now).stale, false);
});

test('masking: keep a recognisable head and tail, never the middle', () => {
  const id = '110101199001011234';
  const masked = maskValue(id);
  assert.ok(masked.includes('*'));
  assert.ok(masked.startsWith('110'));
  assert.ok(masked.endsWith('1234'));
  assert.equal(masked.length, id.length);
  assert.equal(tailOf(id), '****1234');
});

test('registry: derived and credential entries are refused with a pointer', () => {
  const age = resolveEntry('年龄');
  assert.equal(age.ok, false);
  assert.equal(age.code, 'derived_entry');
  assert.match(age.message, /birthday/);

  const password = resolveEntry('登录密码');
  assert.equal(password.ok, true);
  assert.equal(password.entry.key, 'password');

  const refused = coerceValue(password.entry, 'hunter2');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'value_rejected');

  const custom = resolveEntry('咖啡口味');
  assert.equal(custom.ok, true);
  assert.equal(custom.entry.key, 'x_咖啡口味');
  assert.equal(custom.custom, true);
});

test('putEntry: a new value supersedes the old one instead of overwriting it', async (t) => {
  const { vault } = await tempVault(t);
  const person = await vault.createPerson({ displayName: '林黛玉', relation: '朋友' }, { kind: 'tool' });

  await vault.putEntry({ personId: person.id, entryKey: '生日', value: '1990-05-12', source: { kind: 'tool' } });
  const second = await vault.putEntry({ personId: person.id, entryKey: '生日', value: '1990-06-01', source: { kind: 'tool' } });

  const record = second.person.entries.birthday;
  assert.equal(record.observations.length, 2);
  const active = record.observations.filter((observation) => observation.supersededAt === null);
  assert.equal(active.length, 1);
  assert.equal(active[0].value, '1990-06-01');

  const unchanged = await vault.putEntry({ personId: person.id, entryKey: '生日', value: '1990-06-01', source: { kind: 'tool' } });
  assert.equal(unchanged.change, 'unchanged');
  assert.equal(unchanged.person.entries.birthday.observations.length, 2);
});

test('putEntry: writing a custom entry twice keeps one entry, not two forks', async (t) => {
  const { vault } = await tempVault(t);
  const person = await vault.createPerson({ displayName: '贾宝玉' }, { kind: 'tool' });

  await vault.putEntry({ personId: person.id, entryKey: '咖啡口味', value: '拿铁', source: { kind: 'tool' } });
  const again = await vault.putEntry({ personId: person.id, entryKey: 'x_咖啡口味', value: '美式', source: { kind: 'tool' } });

  const custom = Object.keys(again.person.entries).filter((key) => key.startsWith('x_'));
  assert.deepEqual(custom, ['x_咖啡口味']);
});

test('concurrent writes both land (one vault-wide queue)', async (t) => {
  const { vault } = await tempVault(t);
  const person = await vault.createPerson({ displayName: '史湘云' }, { kind: 'tool' });

  await Promise.all([
    vault.putEntry({ personId: person.id, entryKey: '爱好', value: '下棋', source: { kind: 'tool' } }),
    vault.putEntry({ personId: person.id, entryKey: '身高', value: 165, source: { kind: 'tool' } }),
  ]);

  const fresh = await vault.find({ personId: person.id });
  assert.ok(fresh.entries.hobbies, 'first write survived');
  assert.ok(fresh.entries.height, 'second write survived');
});

test('consent: one session grant, a fresh ask per session, revocable', async (t) => {
  const { store } = await tempVault(t);
  const consent = createConsent({ store, config: {} });
  let asked = 0;
  const userQuestions = {
    ask: async () => {
      asked += 1;
      return { answers: [{ id: 'profile-consent', selected: [OPTION_SESSION] }] };
    },
  };
  const subject = { type: 'person', key: 'id:per_a', label: '林黛玉' };

  const first = await consent.authorize({ userQuestions, agent: { id: 'session-1' }, subject, tier: 'normal' });
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'session');

  const second = await consent.authorize({ userQuestions, agent: { id: 'session-1' }, subject, tier: 'normal' });
  assert.equal(second.ok, true);
  assert.equal(asked, 1, 'the session grant is reused without asking again');

  const other = await consent.authorize({ userQuestions, agent: { id: 'session-2' }, subject, tier: 'normal' });
  assert.equal(other.ok, true);
  assert.equal(asked, 2, 'grants never cross sessions');

  await consent.revoke({ sessionId: 'session-1', all: true });
  await consent.authorize({ userQuestions, agent: { id: 'session-1' }, subject, tier: 'normal' });
  assert.equal(asked, 3, 'revoking forces the next read to ask again');
});

test('consent: denial, missing agent, and a missing question service fail closed', async (t) => {
  const { store } = await tempVault(t);
  const consent = createConsent({ store, config: {} });
  const subject = { type: 'person', key: 'id:per_b', label: '贾宝玉' };

  const deny = { ask: async () => ({ answers: [{ id: 'profile-consent', selected: [OPTION_DENY] }] }) };
  const denied = await consent.authorize({ userQuestions: deny, agent: { id: 'session-3' }, subject, tier: 'normal' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'denied');

  const noAgent = await consent.authorize({ userQuestions: deny, subject, tier: 'normal' });
  assert.equal(noAgent.code, 'consent_unavailable');

  const noService = await consent.authorize({ agent: { id: 'session-4' }, subject, tier: 'normal' });
  assert.equal(noService.code, 'consent_unavailable');

  const throwing = { ask: async () => { throw Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' }); } };
  const aborted = await consent.authorize({ userQuestions: throwing, agent: { id: 'session-5' }, subject, tier: 'normal' });
  assert.equal(aborted.code, 'consent_unavailable');
});

test('consent: two parallel reads share one question', async (t) => {
  const { store } = await tempVault(t);
  const consent = createConsent({ store, config: {} });
  let asked = 0;
  const slow = {
    ask: async () => {
      asked += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { answers: [{ id: 'profile-consent', selected: [OPTION_ONCE] }] };
    },
  };
  const subject = { type: 'person', key: 'id:per_c', label: '妙玉' };
  const agent = { id: 'session-6' };

  const [left, right] = await Promise.all([
    consent.authorize({ userQuestions: slow, agent, subject, tier: 'normal' }),
    consent.authorize({ userQuestions: slow, agent, subject, tier: 'normal' }),
  ]);
  assert.equal(asked, 1);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.mode, 'once');
});

test('route: identity values are masked until reveal is asked for', async (t) => {
  const { store, vault } = await tempVault(t);
  const routes = createRoutes({ vault, store, consent: createConsent({ store, config: {} }) });

  const created = await routes.handleWrite({ op: 'create-person', displayName: '贾宝玉', relation: '朋友' });
  const personId = created.view.person.personId;

  const written = await routes.handleWrite({ op: 'put-entry', personId, entryKey: '身份证号', value: '110101199001011234' });
  assert.equal(written.ok, true);

  const masked = await routes.handleQuery({ op: 'person', personId });
  const card = masked.view.entries.find((entry) => entry.key === 'id_card');
  assert.equal(card.current.masked, true);
  assert.equal(card.current.value, maskValue('110101199001011234'));

  const revealed = await routes.handleQuery({ op: 'person', personId, reveal: true });
  const full = revealed.view.entries.find((entry) => entry.key === 'id_card');
  assert.equal(full.current.value, '110101199001011234');
});

test('route: a stale baseRev is a conflict, not a silent overwrite', async (t) => {
  const { store, vault } = await tempVault(t);
  const routes = createRoutes({ vault, store, consent: createConsent({ store, config: {} }) });

  const created = await routes.handleWrite({ op: 'create-person', displayName: '妙玉' });
  const personId = created.view.person.personId;
  const rev = created.view.person.rev;

  await routes.handleWrite({ op: 'put-entry', personId, entryKey: '身高', value: 170, baseRev: rev });
  await assert.rejects(
    () => routes.handleWrite({ op: 'put-entry', personId, entryKey: '身高', value: 171, baseRev: rev }),
    (error) => error.code === 'conflict',
  );
});

test('route handler: refused connections and non-POST never reach the vault', async (t) => {
  const { store, vault } = await tempVault(t);
  const routes = createRoutes({ vault, store, consent: createConsent({ store, config: {} }) });

  const refused = fakeResponse();
  await routes.handlerFor({ requestRejection: () => 403 }, 'query')(
    { method: 'POST', headers: { 'content-type': 'application/json' } },
    refused,
  );
  assert.equal(refused.statusCode, 403);

  const get = fakeResponse();
  await routes.handlerFor({}, 'query')({ method: 'GET', headers: {} }, get);
  assert.equal(get.statusCode, 405);

  const wrongType = fakeResponse();
  await routes.handlerFor({}, 'query')({ method: 'POST', headers: { 'content-type': 'text/plain' } }, wrongType);
  assert.equal(wrongType.statusCode, 415);

  const request = Readable.from([Buffer.from(JSON.stringify({ op: 'list' }))]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  const ok = fakeResponse();
  await routes.handlerFor({}, 'query')(request, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body).people, []);
});
