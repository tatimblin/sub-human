// A room for a kit test: my session is the module under test, the other members are scripted here through core.
// The kit's `$.fs` reaches no disk ("no implementation for fs.read"), so the room is a MemoryStore and the test's
// fs.read / fs.list hooks serve its files at the paths home.ts gives; the module's writes reach it through http.fetch.
import type { On, RenderSurface } from 'claude-code';
import type { MockClock } from 'claude-code/testing';
import { mock } from 'claude-code/testing';
import type { DocKind, DocKinds, Draft } from '../../core/entries.js';
import { blobFile, docFile, fileKey, logFile, roomDir, tailFile } from '../../home.js';
import { MemoryStore } from '../../store/memory-store.js';
import { tailText } from '../../store/store.js';
import type { Answers, LinkStatus, Message, PlanAct, Request, TaskAct } from '../../core/api.js';
import { decodeRequest, sessionFile, socketFile } from '../../core/api.js';
import { toolFixture } from './fixtures.js';
import { kitReader } from './kit-fixtures.js';
import { planRule, roomState } from './kit-plans.js';
import { latestVersion } from '../../core/plans.js';
import type { Result } from '../../core/result.js';
import { ok } from '../../core/result.js';
import { taskRule } from './kit-tasks.js';
import { POLL_MS, POLLED } from '../../module/follow.js';

export interface SeedOptions {
  readonly me: string;
  readonly others: readonly string[];
  readonly code?: string;
  /** The clock entries and documents are stamped with: the test's mock clock. */
  readonly now?: () => number;
  /** More environment for the session (SUB_HUMAN_CC_OFF). */
  readonly env?: Readonly<Record<string, string>>;
  /** Files of my own the session reads, by absolute path (a repo's .gitignore). */
  readonly files?: Readonly<Record<string, string>>;
}

/** A colleague, scripted: what their session's module and Claude would write. */
export interface Colleague {
  /** Files edited (their activity document) and, optionally, a commit with this message. */
  activity(o: { files?: readonly string[]; commit?: string; replace?: boolean }): Promise<void>;
  finding(text: string): Promise<void>;
  /** On `machine` (their laptop when not given); each machine's presence is its own document, as the daemon keeps it. */
  presence(state: 'working' | 'idle' | 'away', machine?: string): Promise<void>;
  /** A line typed by the person (`@room`), or posted by their Claude. */
  post(text: string, o?: { to?: string; by?: 'person' | 'claude' }): Promise<void>;
  focus(text: string): Promise<void>;
  /** A plan version of theirs with `text`, asking `people` to agree. */
  plan(name: string, text: string, people: readonly string[]): Promise<void>;
  left(): Promise<void>;
  joined(): Promise<void>;
  /** Their Claude's SendMessage to mine: into my inbox at the daemon, never the log (R6); `code` for another room's. */
  message(text: string, code?: string): void;
  /** A plan act of theirs (answer, accept, send, …) through the host's plan rules; throws when they refuse it. */
  planAct(act: PlanAct): Promise<void>;
  /** A task act of theirs through the host's task rules; the task's number, or it throws when refused. */
  task(act: TaskAct): Promise<number>;
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
  /** Every request the module sent the daemon, decoded. */
  readonly requests: Request[];
  /** Every prompt the module submitted itself (`$.prompt.submit`, a wake), with its context and its input's keys. */
  readonly submitted: { text: string; context: readonly string[]; keys: string[] }[];
  /** Where the session draws: emptied for a -p run. */
  readonly surfaces: RenderSurface[];
  /** Moves my pointer to session `id`, which `$.session.id` then answers (a /clear's handoff), or removes it (a leave). */
  pointer(id: string | null): void;
  /** Makes `$.session.id` answer `id` from now, with no pointer moved (a /clear of a session in no room). */
  resume(id: string): void;
  /** The tools the module registered, by name. */
  readonly registered: string[];
  /** What the daemon's `link` answers for the room: null for a room hosted here. */
  link: LinkStatus | null;
  /**
   * What the test breaks: the daemon refusing every write, the socket refused (the fetch rejects), the log's file
   * refusing reads, tool registration refused.
   */
  readonly broken: { daemon: boolean; socket: boolean; log: boolean; tools: boolean };
  /** Moves the clock one poll on and waits, at most 3 s, until that poll has finished. */
  poll(clock: MockClock): Promise<void>;
  /** Holds every file read until the returned release is called: a slow disk. */
  hold(): () => void;
  /** Waits, at most 3 s, until the session's first poll (started, not awaited, at session.start) has finished. */
  settled(clock: MockClock): Promise<void>;
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
  const broken = { daemon: false, socket: false, log: false, tools: false };
  const registered: string[] = [];
  const requests: Request[] = [];
  const submitted: { text: string; context: readonly string[]; keys: string[] }[] = [];
  const surfaces: RenderSurface[] = ['terminal'];
  const inbox: Message[] = [];
  let polls = 0;
  const dir = roomDir(HOME, await fileKey(code));
  const put = (path: string, text: string): void => { files.set(path, { text, mtime: ++writes }); };
  for (const [path, text] of Object.entries(o.files ?? {})) put(path, text);

  const putDoc = async <K extends DocKind>(kind: K, name: string, doc: DocKinds[K], key = name): Promise<void> => {
    await store.putDoc(kind, key, doc);
    put(docFile(dir, kind, await fileKey(key)), JSON.stringify(doc));
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
  // the daemon's `plan`: the host's rules, then the entries and any new text, as net/daemon/rooms.ts stores them
  const plan = async (from: string, act: PlanAct): Promise<Result<Answers['plan']>> => {
    const r = await planRule(store, code, from, act);
    if (!r.ok) return r;
    if ('refused' in r.value) return ok({ refused: r.value.refused, latest: latestVersion(await roomState(store), act.name) });
    if (act.act === 'edit') put(blobFile(dir, await store.putBlob(act.text)), act.text);
    for (const d of r.value.drafts) await append(d);
    const s = await roomState(store);
    return ok({ seq: s.seq, hash: s.hash, latest: latestVersion(s, act.name) });
  };
  // the daemon's `task`: the host's rules, then their entries
  const task = async (from: string, act: TaskAct): ReturnType<typeof taskRule> => {
    const r = await taskRule(store, from, act);
    if (r.ok) for (const d of r.value.drafts) await append(d);
    return r;
  };
  const read = (path: string): string | undefined =>
    path === logFile(dir) ? store.room.lines.map(l => `${l}\n`).join('') : files.get(path)?.text;

  mock.env(on, { HOME: '/home/me', SUB_HUMAN_HOME: HOME, ...o.env });
  let current = SESSION;
  on('session.id', () => ({ value: current }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', (_, e) => ({ sessionId: e.sessionId }));
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') submitted.push({ text: e.text, context: e.context ?? [], keys: Object.keys(e) });
    return { text: e.text, ...(e.context && { context: e.context }) };
  });
  on('session.surfaces', () => ({ value: [...surfaces] }));
  on('tool.register', (_, e) => {
    if (broken.tools) return { deny: 'tools are off by policy' };
    registered.push(e.name);
    return { value: { tool: `mcp__sub-human__${e.name}` } };
  });
  on('ui.status', (_, e) => { status.push(e.text); return { value: undefined }; });
  on('ui.log', (_, e) => {
    if (e.to !== 'debug') logs.push(e.text);
    else if (e.text === POLLED) polls++;
    return { value: undefined };
  });
  // eslint-disable-next-line require-yield -- refused before it starts, so it streams nothing
  on('process.spawn', async function* (_, e) { spawned.push(e.argv); return { deny: 'no processes in the kit' }; });
  let held: Promise<void> | null = null;
  const hold = (): (() => void) => {
    let release = (): void => {};
    held = new Promise(r => { release = () => { held = null; r(); }; });
    return () => release();
  };
  on('fs.read', async (_, e) => {
    if (held) await held;
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
    if (r?.ok) requests.push(r.value);
    if (broken.socket) return { deny: 'socket refused by policy' };
    if (broken.daemon) return reply(503, { ok: false, error: 'the daemon is broken for this test' });
    if (!r?.ok) return reply(400, { ok: false, error: r ? r.error : 'not the daemon\'s socket' });
    const req = r.value;
    if (req.op === 'ping') return reply(200, { ok: true, value: null });
    if (req.op === 'message') return reply(200, { ok: true, value: null }); // carried to a colleague: they're scripted
    if (req.op === 'inbox') return reply(200, { ok: true, value: { messages: inbox.splice(0) } });
    if (req.op === 'asks') return reply(200, { ok: true, value: { asks: [] } }); // nobody knocks
    if (req.op === 'link') return reply(200, { ok: true, value: result.link });
    if (req.op === 'append' && req.code === code) {
      const line = await store.append({ ...req.draft, at: now(), machine: 'my-laptop' });
      if (!line.ok) return reply(400, { ok: false, error: line.error });
      await tail();
      return reply(200, { ok: true, value: { seq: line.value.entry.seq, hash: line.value.hash } });
    }
    if (req.op === 'plan' && req.code === code) {
      const r = await plan(req.from, req);
      return r.ok ? reply(200, { ok: true, value: r.value }) : reply(400, { ok: false, error: r.error });
    }
    if (req.op === 'task' && req.code === code) {
      const t = await task(req.from, req);
      if (!t.ok) return reply(400, { ok: false, error: t.error });
      const head = await store.head();
      return head.ok ? reply(200, { ok: true, value: { ...head.value, n: t.value.n } }) : reply(500, { ok: false, error: head.error });
    }
    if (req.op !== 'put_doc' || req.code !== code) return reply(400, { ok: false, error: `the kit's daemon takes no ${req.op} here` });
    const doc = req.doc;
    if ('state' in doc) await putDoc('presence', req.name, { ...doc, machine: 'my-laptop' }, `${req.name}@my-laptop`);
    else await putDoc(req.kind, req.name, doc);
    return reply(200, { ok: true, value: null });
  });

  const pointer = (id: string | null): void => {
    const mine = JSON.stringify({ code, name: o.me, title: `${o.me}.${code}`, leave: '00000000-0000-4000-8000-0000000000ee' });
    for (const p of [...files.keys()].filter(k => k.startsWith(`${HOME}/sessions/`))) files.delete(p);
    if (id !== null) { current = id; put(sessionFile(HOME, id), mine); }
  };
  pointer(SESSION);
  for (const name of [o.me, ...o.others]) await append({ kind: 'joined', from: name, by: 'system' });
  const presence = (name: string, state: 'working' | 'idle' | 'away', machine = `${name}-laptop`) =>
    putDoc('presence', name, { name, state, machine, at: now() }, `${name}@${machine}`);
  for (const name of o.others) await presence(name, 'working');

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
    presence: (state, machine) => presence(name, state, machine),
    post: (text, p) => append({ kind: 'post', from: name, by: p?.by ?? 'person', text, ...(p?.to !== undefined && { to: p.to }) }),
    focus: text => putDoc('focus', name, { name, text, at: now() }),
    async plan(plan, text, people) {
      const hash = await store.putBlob(text);
      put(blobFile(dir, hash), text);
      const version = 1 + store.room.lines.filter(l => l.includes(`"kind":"plan"`) && l.includes(`"name":${JSON.stringify(plan)}`)).length;
      await append({ kind: 'plan', from: name, by: 'claude', name: plan, version, hash, base: version - 1, scope: 'group' });
      if (people.length) await append({ kind: 'plan_ask', from: name, by: 'claude', name: plan, version, people });
    },
    async left() { // the daemon's leave: `left`, and this machine's presence away
      await append({ kind: 'left', from: name, by: 'system' });
      await presence(name, 'away');
    },
    joined: () => append({ kind: 'joined', from: name, by: 'system' }),
    message: (text, other) => { inbox.push({ code: other ?? code, from: name, text, at: now() }); },
    async planAct(act) {
      const r = await plan(name, act);
      if (!r.ok) throw new Error(r.error);
      if ('refused' in r.value) throw new Error(r.value.refused);
    },
    async task(act) {
      const r = await task(name, act);
      if (!r.ok) throw new Error(r.error);
      return r.value.n;
    },
  });
  // the poll's host round trips run on real time (hashing, the stubs); bounded well inside the test's own limit
  const until = async (clock: MockClock, want: number): Promise<void> => {
    const end = Date.now() + 3000;
    while (polls < want) {
      if (Date.now() > end) throw new Error('no poll finished within 3 s');
      await clock.settle();
    }
  };
  const poll = async (clock: MockClock): Promise<void> => {
    const want = polls + 1;
    await clock.advance(POLL_MS);
    await until(clock, want);
  };
  const settled = (clock: MockClock): Promise<void> => until(clock, 1);
  const result: Room = { code, home: HOME, store, as, status, logs, spawned, reads, requests, submitted, surfaces, registered, link: null, pointer, resume: id => { current = id; }, broken, poll, settled, hold };
  return result;
}

/** A main-loop turn's start and end, as the engine fires them around a model turn; `turns` stubs both. */
export function turns(on: On): void {
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', (_, e) => ({ text: e.answer }));
}
/** A subagent's turn when `agentId` is given. */
export const turnStart = (turnId: string, agentId?: string) => ({ text: '', turnId, ...(agentId !== undefined && { agentId }) });
export const turnEnd = (turnId: string, aborted = false, agentId?: string) =>
  ({ answer: '', durationMs: 1, isAborted: aborted, turnId, reason: aborted ? 'aborted' : 'answer', ...(agentId !== undefined && { agentId }) }) as const;
