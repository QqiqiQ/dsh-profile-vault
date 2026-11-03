/**
 * Smoke test for the Client half.
 *
 * The settings page never runs in Node, so a typo in it would only surface as a
 * blank page for the user. This harness loads client.js through a fake module
 * loader with a minimal React (hooks kept in a slot array, effects run once per
 * mount) and a stubbed fetch that answers like the real routes do. It then clicks
 * the first person and checks the rendered text.
 *
 * It is a smoke test, not a renderer: child components are only referenced, never
 * mounted. What it protects is the top-level data flow — route shapes, state
 * wiring, and the render path that would otherwise fail silently in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const realSetTimeout = globalThis.setTimeout;

// A 7s toast timer would keep the test process alive and is irrelevant here.
globalThis.setTimeout = (fn, ms, ...rest) => {
  const timer = realSetTimeout(fn, Math.min(ms ?? 0, 5), ...rest);
  if (typeof timer?.unref === 'function') timer.unref();
  return timer;
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement() {
    return {
      textContent: '',
      setAttribute() {},
      remove() {},
    };
  },
};

/* A React small enough to run one component, big enough for its hooks. */
const hooks = [];
let cursor = 0;
let effects = [];
let dirty = false;

const React = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? [] : children;
    return { type, props: { ...(props ?? {}), children: flat.flat() } };
  },
  useRef(initial) {
    return { current: initial };
  },
  useState(initial) {
    const index = cursor++;
    if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = hooks[index];
    return [
      slot.value,
      (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (value !== slot.value) {
          slot.value = value;
          dirty = true;
        }
      },
    ];
  },
  useEffect(fn) {
    effects.push(fn);
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  Fragment: 'fragment',
};

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) {
    collectText(node.props.children, out);
    return out;
  }
  if (typeof node === 'function' || typeof node === 'string') return out;
  return out;
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  walk(node.props?.children, visit);
}

/**
 * Expand function components so the tree is plain host elements. Children run
 * their hooks into the same slot array, in the same order every pass, which is
 * exactly what the real renderer does for a static tree like this one.
 */
function resolve(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(resolve);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return resolve(node.type(node.props ?? {}));
  if (node.props === undefined) return node;
  return { ...node, props: { ...node.props, children: resolve(node.props.children) } };
}

function findClickable(tree, label) {
  let found = null;
  walk(tree, (element) => {
    const onClick = element.props?.onClick;
    if (typeof onClick !== 'function' || found !== null) return;
    const text = collectText(element).join('');
    if (text.includes(label)) found = onClick;
  });
  return found;
}

const REGISTRY = [
  { key: 'birthday', label: '生日', kind: 'date', cardinality: 'single', stability: 'immutable', tier: 'normal' },
  { key: 'id_card', label: '身份证号', kind: 'text', cardinality: 'single', stability: 'immutable', tier: 'sensitive' },
];

const PERSON = {
  personId: 'per_1',
  displayName: '林黛玉',
  aliases: ['黛玉'],
  relation: '朋友',
  entriesCount: 2,
  updatedAt: '2026-11-01T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
  rev: 3,
  note: '',
};

const VIEW = {
  person: PERSON,
  entries: [
    {
      key: 'birthday',
      label: '生日',
      kind: 'date',
      cardinality: 'single',
      stability: 'immutable',
      tier: 'normal',
      unit: null,
      observations: 1,
      current: {
        value: '1990-05-12',
        masked: false,
        observedAt: '2026-01-02T00:00:00.000Z',
        recordedAt: '2026-01-02T00:00:00.000Z',
        ageDays: 300,
        confidence: 'stated',
        precision: 'day',
        source: 'tool',
      },
      history: [],
      warnings: [],
      computed: { ageYears: 36, nextOccurrence: { date: '2027-05-12', inDays: 190, turningAge: 37 } },
    },
    {
      key: 'id_card',
      label: '身份证号',
      kind: 'text',
      cardinality: 'single',
      stability: 'immutable',
      tier: 'sensitive',
      unit: null,
      observations: 1,
      current: {
        value: '110***********1234',
        masked: true,
        observedAt: '2026-01-02T00:00:00.000Z',
        recordedAt: '2026-01-02T00:00:00.000Z',
        ageDays: 300,
        confidence: 'stated',
        precision: null,
        source: 'panel',
      },
      history: [],
      warnings: ['身份类信息，默认掩码；要看完整值需敏感授权 + revealSensitive。'],
    },
  ],
  truncated: false,
  asOf: '2026-11-03T00:00:00.000Z',
};

function respond(payload) {
  if (payload.op === 'list') return { ok: true, people: [PERSON] };
  if (payload.op === 'meta') {
    return { ok: true, registry: REGISTRY, stats: { people: 1, entries: 2, observations: 2 }, audit: [] };
  }
  if (payload.op === 'grants') return { ok: true, grants: [] };
  if (payload.op === 'person') return { ok: true, view: VIEW };
  return { ok: true };
}

globalThis.fetch = async (path, init) => {
  const payload = JSON.parse(init?.body ?? '{}');
  return { ok: true, status: 200, json: async () => respond(payload) };
};

function flush() {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

async function mount(component) {
  let tree = null;
  for (let pass = 0; pass < 12; pass += 1) {
    cursor = 0;
    effects = [];
    dirty = false;
    tree = resolve(component());
    if (pass === 0) {
      for (const effect of effects) effect();
    }
    await flush();
    await flush();
    if (!dirty) break;
  }
  return tree;
}

test('client: mounts the settings panel and renders a person with masked data', async () => {
  // Imported here, not at the top: the module reads `window` while evaluating.
  await import('../client.js');

  const factory = (require) => {
    assert.equal(require('react'), React);
    return captured.factory(require);
  };
  assert.ok(captured !== null, 'client.js registered itself with the module loader');
  assert.equal(captured.id, 'dsh-profile-vault', 'loader id must equal the package name');

  const moduleExports = factory((name) => (name === 'react' ? React : undefined));
  assert.deepEqual(moduleExports.inject, ['slots']);

  const registrations = [];
  const slots = {
    inject(owner, register) {
      assert.equal(owner, 'settings.section');
      register();
    },
    register(props, component) {
      registrations.push({ props, component });
      return () => {};
    },
  };
  const effectsRun = [];
  const ctx = {
    get(name) {
      return name === 'slots' ? slots : undefined;
    },
    effect(fn, label) {
      effectsRun.push(label);
      const dispose = fn();
      return dispose;
    },
  };

  moduleExports.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].props.id, 'profile-vault');
  assert.equal(registrations[0].props.name, 'settings.section');
  assert.equal(registrations[0].props.order, 26);
  assert.equal(registrations[0].props.label, '个人资料');

  const Panel = registrations[0].component;
  const tree = await mount(Panel);
  const initialText = collectText(tree).join('');
  assert.match(initialText, /个人资料/);
  assert.match(initialText, /没有加密/);
  assert.match(initialText, /林黛玉/);

  const click = findClickable(tree, '林黛玉');
  assert.ok(click !== null, 'the person row is clickable');
  await click();
  const afterClick = await mount(Panel);
  const text = collectText(afterClick).join('');
  assert.match(text, /生日/);
  assert.match(text, /身份证号/);
  assert.match(text, /110\*+1234/);
  assert.match(text, /2027-05-12/);
});
