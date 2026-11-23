// A room for a kit test: my session is the module under test, the other members are scripted here through core.
// The kit's `$.fs` reaches no disk ("no implementation for fs.read"), so the room is a MemoryStore and the test's
// fs.read / fs.list hooks serve its files at the paths home.ts gives; the module's writes reach it through http.fetch.
import type { On } from 'claude-code';
import type { MockClock } from 'claude-code/testing';
import { mock } from 'claude-code/testing';
import type { DocKind, DocKinds, Draft } from '../../core/entries.js';
import { docFile, fileKey, logFile, roomDir, tailFile } from '../../home.js';
import { MemoryStore } from '../../store/memory-store.js';
import { tailText } from '../../store/store.js';
import { decodeRequest, sessionFile, socketFile } from '../../core/api.js';
import { toolFixture } from './fixtures.js';
import { kitReader } from './kit-fixtures.js';
import { POLL_MS, POLLED } from '../../module/follow.js';

export interface SeedOptions {
  readonly me: string;
  readonly others: readonly string[];
  readonly code?: string;
  /** The clock entries and documents are stamped with: the test's mock clock. */
  readonly now?: () => number;
}

/** A colleague, scripted: what their session's module and Claude would write. */
export interface Colleague {
  /** Files edited (their activity document) and, optionally, a commit with this message. */
  activity(o: { files?: readonly string[]; commit?: string; replace?: boolean }): Promise<void>;
  finding(text: string): Promise<void>;
  presence(state: 'working' | 'idle'): Promise<void>;
}

export interface Room {
  readonly code: string;
  readonly home: string;
  readonly store: MemoryStore;
  as(name: string): Colleague;
  /** Every `$.ui.status` text and `$.ui.log` line the module drew, and each process it tried to start. */
  readonly status: (string | undefined)[];
  readonly logs: string[];
  readonly spawned: (readonly string[])[];
  /** How many times each path was read, and each folder listed (`list:` and its path). */
  readonly reads: Map<string, number>;
  /** What the test breaks: the daemon refusing every write, the log's file refusing reads. */
  readonly broken: { daemon: boolean; log: boolean };
  /** Moves the clock one poll on and waits, at most 3 s, until that poll has finished. */
  poll(clock: MockClock): Promise<void>;
}

export const HOME = '/home/me/.sub-human';
export const SESSION = 'session-1';
/** My recorded edit (test/fixtures/cc/2.1.330/tool-edit.json); the session runs in the folder it edits in. */
export const EDIT = toolFixture('tool-edit', 'Edit', kitReader);
export const CWD = EDIT.input.file_path.slice(0, EDIT.input.file_path.lastIndexOf('/'));
/** The edited file as the room names it, relative to CWD. */
export const EDITED = EDIT.input.file_path.slice(CWD.length + 1);
export const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const;
export const END = { reason: 'other', sessionId: SESSION, resume: { id: SESSION } } as const;

/** Registers the stubs (before any `$` call: call it first) and seeds the room: everyone joined, colleagues working. */
export async function seedRoom(on: On, o: SeedOptions): Promise<Room> {
  const code = o.code ?? 'otter-4821';
  const now = o.now ?? (() => 0);
  const store = new MemoryStore();
  const files = new Map<string, { text: string; mtime: number }>(); // documents and the pointer, as on disk
  let writes = 0;
  const status: (string | undefined)[] = [];
  const logs: string[] = [];
  const spawned: (readonly string[])[] = [];
  const reads = new Map<string, number>();
  const broken = { daemon: false, log: false };
  let polls = 0;
  const dir = roomDir(HOME, await fileKey(code));
  const put = (path: string, text: string): void => { files.set(path, { text, mtime: ++writes }); };

  const putDoc = async <K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void> => {
    await store.putDoc(kind, name, doc);
    put(docFile(dir, kind, await fileKey(name)), JSON.stringify(doc));
    await tail(`d${writes}`); // the daemon's documents stamp (net/daemon/rooms.ts)
  };
  const tail = async (docs?: string): Promise<void> => {
    const head = await store.head();
    if (head.ok) put(tailFile(dir), docs === undefined ? tailText({ ...head.value, at: now() }) : JSON.stringify({ ...head.value, at: now(), docs }));
  };
  const append = async (d: Draft): Promise<void> => {
    const r = await store.append({ ...d, id: `e${++writes}`, at: now(), machine: `${d.from}-laptop` });
    if (!r.ok) throw new Error(r.error);
    await tail(); // FsStore writes the tail with no stamp
  };
  const read = (path: string): string | undefined =>
    path === logFile(dir) ? store.room.lines.map(l => `${l}\n`).join('') : files.get(path)?.text;

  mock.env(on, { HOME: '/home/me', SUB_HUMAN_HOME: HOME });
  on('session.id', () => ({ value: SESSION }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', (_, e) => ({ sessionId: e.sessionId }));
  on('prompt.submit', (_, e) => ({ text: e.text, ...(e.context && { context: e.context }) }));
  on('ui.status', (_, e) => { status.push(e.text); return { value: undefined }; });
  on('ui.log', (_, e) => {
    if (e.to !== 'debug') logs.push(e.text);
    else if (e.text === POLLED) polls++;
    return { value: undefined };
  });
  // eslint-disable-next-line require-yield -- refused before it starts, so it streams nothing
  on('process.spawn', async function* (_, e) { spawned.push(e.argv); return { deny: 'no processes in the kit' }; });
  on('fs.read', (_, e) => {
    reads.set(e.path, (reads.get(e.path) ?? 0) + 1);
    const text = broken.log && e.path === logFile(dir) ? undefined : read(e.path);
    if (text === undefined) return { deny: `ENOENT: ${e.path}` };
    if (e.offset === undefined && e.length === undefined) return { value: text };
    // a hook answering in the host's place cuts its answer to the range (the kit doesn't)
    const bytes = new TextEncoder().encode(text);
    const start = e.offset ?? 0;
    return { value: new TextDecoder().decode(bytes.slice(start, e.length === undefined ? undefined : start + e.length)) };
  });
  on('fs.list', (_, e) => {
    reads.set(`list:${e.path}`, (reads.get(`list:${e.path}`) ?? 0) + 1);
    const inDir = [...files].filter(([p]) => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'));
    return { value: inDir.map(([p, f]) => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtime, isLink: false })) };
  });
  // the daemon, as far as the module uses it yet: a request decoded by core/api.ts, answered in its envelope
  on('http.fetch', async (_, e) => {
    const reply = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } });
    const r = e.init?.socketPath === socketFile(HOME) && typeof e.init.body === 'string' ? decodeRequest(JSON.parse(e.init.body)) : null;
    if (broken.daemon) return reply(503, { ok: false, error: 'the daemon is broken for this test' });
    if (!r?.ok) return reply(400, { ok: false, error: r ? r.error : 'not the daemon\'s socket' });
    const req = r.value;
    if (req.op !== 'put_doc' || req.code !== code) return reply(400, { ok: false, error: `the kit's daemon takes no ${req.op} here` });
    await putDoc(req.kind, req.name, req.doc);
    return reply(200, { ok: true, value: null });
  });

  put(sessionFile(HOME, SESSION), JSON.stringify({ code, name: o.me, title: `${o.me}.${code}`, leave: '00000000-0000-4000-8000-0000000000ee' }));
  for (const name of [o.me, ...o.others]) await append({ kind: 'joined', from: name, by: 'system' });
  for (const name of o.others) await putDoc('presence', name, { name, state: 'working', at: now() });

  let sha = 0x4f2a9c1;
  const as = (name: string): Colleague => ({
    async activity({ files: edited, commit, replace }) {
      if (edited) {
        const had = replace ? [] : (await store.getDoc('activity', name))?.files ?? [];
        await putDoc('activity', name, { name, files: [...had, ...edited.filter(f => !had.includes(f))], at: now() });
      }
      if (commit !== undefined) await append({ kind: 'activity', from: name, by: 'claude', event: 'commit', text: `committed ${(sha++).toString(16)}: ${commit}` });
    },
    finding: text => append({ kind: 'finding', from: name, by: 'claude', text }),
    presence: state => putDoc('presence', name, { name, state, at: now() }),
  });
  const poll = async (clock: MockClock): Promise<void> => {
    const want = polls + 1;
    await clock.advance(POLL_MS);
    // the poll's host round trips run on real time (hashing, the stubs); bounded well inside the test's own limit
    const until = Date.now() + 3000;
    while (polls < want) {
      if (Date.now() > until) throw new Error('no poll finished within 3 s');
      await clock.settle();
    }
  };
  return { code, home: HOME, store, as, status, logs, spawned, reads, broken, poll };
}
