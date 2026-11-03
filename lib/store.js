/**
 * File store: one JSON file per person, atomic replacement, per-path serialization.
 *
 * `people/<id>.json` is the only truth source (D6). Names, counts and indexes are
 * derived by reading those files, so nothing can drift: if the files say it, it
 * happened. Writes go tmp → fsync → rename so a crash leaves the old file intact.
 */
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCKS = new Map();

async function withLock(key, task) {
  const previous = LOCKS.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  LOCKS.set(key, chained);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (LOCKS.get(key) === chained) LOCKS.delete(key);
  }
}

async function readJsonFile(path) {
  const text = await fs.readFile(path, 'utf8');
  return JSON.parse(text);
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path);
}

export function defaultRoot() {
  return join(homedir(), '.dsh', 'dsh-profile-vault');
}

export function createStore(options = {}) {
  const root = options.root ?? defaultRoot();
  const peopleDir = join(root, 'people');
  const trashDir = join(root, 'trash');
  const auditDir = join(root, 'audit');
  const metaPath = join(root, 'vault.json');
  const grantsPath = join(root, 'grants.json');
  let ready = null;

  async function ensure() {
    if (ready === null) {
      ready = (async () => {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.mkdir(peopleDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
        try {
          await fs.access(metaPath);
        } catch {
          await writeJsonAtomic(metaPath, {
            schemaVersion: 1,
            instanceId: randomUUID(),
            createdAt: new Date().toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
            encrypted: false,
          });
        }
      })();
    }
    return ready;
  }

  function personPath(personId) {
    return join(peopleDir, `${personId}.json`);
  }

  async function readMeta() {
    await ensure();
    try {
      return await readJsonFile(metaPath);
    } catch {
      return { schemaVersion: 1, encrypted: false };
    }
  }

  async function listPersonFiles() {
    await ensure();
    let names;
    try {
      names = await fs.readdir(peopleDir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith('.json') && !name.startsWith('.')).map((name) => join(peopleDir, name));
  }

  /** Every readable person, skipping (and quarantining) corrupt files. */
  async function readAll() {
    const files = await listPersonFiles();
    const people = [];
    for (const file of files) {
      try {
        const person = await readJsonFile(file);
        if (typeof person?.id === 'string' && typeof person?.displayName === 'string') people.push(person);
      } catch {
        await quarantine(file);
      }
    }
    return people;
  }

  async function quarantine(file) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = join(trashDir, `corrupt-${stamp}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(target, { recursive: true });
      await fs.rename(file, join(target, 'record.json'));
    } catch {
      // Quarantine is best-effort: a file we cannot move still must not block reads.
    }
  }

  async function readPerson(personId) {
    await ensure();
    return readJsonFile(personPath(personId));
  }

  function writePerson(person) {
    return withLock(person.id, async () => {
      await ensure();
      const next = {
        ...person,
        rev: Number.isInteger(person.rev) ? person.rev + 1 : 1,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(personPath(next.id), next);
      return next;
    });
  }

  function createFile(person) {
    return withLock(person.id, async () => {
      await ensure();
      await writeJsonAtomic(personPath(person.id), person);
      return person;
    });
  }

  async function trash(kind, payload, note) {
    await ensure();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(trashDir, `${stamp}-${kind}-${randomUUID().slice(0, 8)}.json`);
    await writeJsonAtomic(file, { kind, deletedAt: new Date().toISOString(), note: note ?? null, payload });
    return file;
  }

  async function appendAudit(record) {
    await ensure();
    const month = new Date().toISOString().slice(0, 7);
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    await fs.appendFile(join(auditDir, `${month}.jsonl`), line, { encoding: 'utf8', mode: 0o600 });
  }

  async function readAudit(limit = 200) {
    await ensure();
    let names;
    try {
      names = (await fs.readdir(auditDir)).filter((name) => name.endsWith('.jsonl')).sort().reverse();
    } catch {
      return [];
    }
    const rows = [];
    for (const name of names) {
      const text = await fs.readFile(join(auditDir, name), 'utf8');
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          rows.push(JSON.parse(lines[index]));
        } catch {
          // A half-written trailing line is possible; skip it.
        }
        if (rows.length >= limit) return rows.reverse();
      }
    }
    return rows.reverse();
  }

  async function readGrants() {
    await ensure();
    try {
      const data = await readJsonFile(grantsPath);
      return Array.isArray(data?.grants) ? data : { version: 1, grants: [] };
    } catch {
      return { version: 1, grants: [] };
    }
  }

  function writeGrants(data) {
    return withLock('grants', async () => {
      await ensure();
      await writeJsonAtomic(grantsPath, { version: 1, updatedAt: new Date().toISOString(), grants: data.grants });
      return data;
    });
  }

  async function stats() {
    await ensure();
    const people = await readAll();
    const entries = people.reduce((total, person) => total + Object.keys(person.entries ?? {}).length, 0);
    const meta = await readMeta();
    return { root, people: people.length, entries, encrypted: meta.encrypted === true, timeZone: meta.timeZone };
  }

  return {
    root,
    ensure,
    readMeta,
    readAll,
    readPerson,
    writePerson,
    createFile,
    trash,
    appendAudit,
    readAudit,
    readGrants,
    writeGrants,
    stats,
    personPath,
  };
}

/** Synchronous existence probe, used only by tests and diagnostics. */
export function personFileExists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
