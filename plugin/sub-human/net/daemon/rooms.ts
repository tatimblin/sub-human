// What the daemon does with each request (core/api.ts). Rooms hosted here are FsStores, one promise chain per room, so
// writes in this daemon never wait on each other's file lock: the lock only guards against a second daemon, and a
// laptop asleep mid-append can't make a waiter here break a live lock. The rules are core's (plans.ts, tasks.ts); this
// only applies them to the room's state and appends what they return. Rooms hosted elsewhere go to `links` (U15).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Answers, Message, PlanAct, Pointer, Request, TaskAct } from '../../core/api.js';
import { API_VERSION, SESSION_ID, sessionFile } from '../../core/api.js';
import { writeAtomic } from '../../store/atomic.js';
import { sha256 } from '../../core/hash.js';
import type { Draft, Kind, RoomState, Snapshot } from '../../core/entries.js';
import { accept, answer, ask, decide, edit, latestVersion, send } from '../../core/plans.js';
import type { Texts } from '../../core/plans.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { add, claim, done, nextN, release } from '../../core/tasks.js';
import type { FsStore } from '../../store/fs-store.js';
import { openFsStore } from '../../store/fs-store.js';
import type { Draft as StoreDraft } from '../../store/store.js';
import { nextSnapshot } from '../../store/store.js';

/** Rooms hosted on another machine: their writes and messages go over that room's link. */
export interface Links {
  hosts(code: string): boolean;
  forward(code: string, req: Request): Promise<Result<never>>;
}
/** Until the links exist (U15), a room hosted elsewhere has its host away. */
export const NO_LINKS: Links = {
  hosts: () => false,
  forward: () => Promise.resolve(err('the room\'s host is away; nothing was sent')),
};

/** Entries only the host writes, from its own rules; a caller asks for them with plan and task. */
const HOST_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'plan', 'plan_ask', 'plan_answer', 'decision', 'plan_sent', 'plan_accept', 'task', 'invite', 'admit', 'kick',
]);
/** Messages kept per inbox until taken, and appended ids remembered per room; the oldest go first. */
const INBOX_MAX = 100;
const IDS_MAX = 10_000;
const POINTER_STALE_MS = 24 * 3600_000;

interface Placed { readonly seq: number; readonly hash: string }
interface Room { readonly store: FsStore; snap: Snapshot; readonly ids: Map<string, Placed> }
/** A session's rooms (code → its name there) and when it was last heard from. */
interface Session { at: number; readonly rooms: Map<string, string> }
interface Writer { readonly code: string; readonly from: string }

export interface RoomsOptions {
  readonly home: string;
  readonly now: () => number;
  readonly machine: string;
  /** A session not heard from for this long is gone. */
  readonly idleMs: number;
  readonly links: Links;
}

export class Rooms {
  private readonly o: RoomsOptions;
  private readonly rooms = new Map<string, Room>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly sessions = new Map<string, Session>();
  /** By session and code, so a session in two rooms keeps both. */
  private readonly inboxes = new Map<string, Message[]>();
  /** When any request last came; the daemon's start counts as one. */
  lastSeen: number;

  constructor(o: RoomsOptions) { this.o = o; this.lastSeen = o.now(); }

  handle(req: Request): Promise<Result<Answers[Request['op']]>> {
    const { links } = this.o;
    const now = (this.lastSeen = this.o.now());
    switch (req.op) {
      case 'append': {
        const { code, draft } = req;
        if (HOST_KINDS.has(draft.kind)) return refuse(`a ${draft.kind} entry is the host's to write; nothing was written`);
        if (links.hosts(code)) return links.forward(code, req);
        return this.queue(code, async room => {
          const seen = room.ids.get(draft.id);
          if (seen) return ok(seen); // a retry of a write that was stored
          const m = room.snap.state.members.find(x => x.name === draft.from);
          if (m?.kicked) return err(`${draft.from} was removed from ${code}; nothing was written`);
          if (!m && draft.kind !== 'joined') return err(`${draft.from} is not in ${code}; nothing was written`);
          return this.place(room, { ...draft, at: now, machine: this.o.machine });
        });
      }
      case 'plan':
        return links.hosts(req.code) ? links.forward(req.code, req) : this.queue(req.code, room => this.plan(room, req));
      case 'task':
        return links.hosts(req.code) ? links.forward(req.code, req) : this.queue(req.code, room => this.task(room, req));
      case 'put_doc':
        if (links.hosts(req.code)) return links.forward(req.code, req);
        return this.queue(req.code, async room => {
          if (!member(room.snap.state, req.name)) return err(`${req.name} is not in ${req.code}; nothing was written`);
          await room.store.putDoc(req.kind, req.name, req.doc); // the store renews the tail's documents stamp
          return ok(null);
        });
      case 'put_blob':
        if (links.hosts(req.code)) return links.forward(req.code, req);
        return this.queue(req.code, async room => ok({ hash: await room.store.putBlob(req.text) }));
      case 'session': return this.pointer(req.id, { code: req.code, name: req.name });
      case 'session_end': return this.pointer(req.id, null);
      case 'ping': {
        if (SESSION_ID.test(req.session)) {
          const d = new Date(now);
          void fs.utimes(sessionFile(this.o.home, req.session), d, d).catch(() => undefined); // still alive: keep its pointer
        }
        const s = this.sessions.get(req.session) ?? { at: now, rooms: new Map<string, string>() };
        s.at = now;
        if (req.code !== undefined && req.name !== undefined) s.rooms.set(req.code, req.name);
        this.sessions.set(req.session, s);
        for (const [id, x] of this.sessions) if (now - x.at > this.o.idleMs) this.sessions.delete(id);
        return Promise.resolve(ok(null));
      }
      case 'message': {
        const to = [...this.live()].filter(([, s]) => s.rooms.get(req.code) === req.to).map(([id]) => id);
        if (!to.length) {
          if (links.hosts(req.code)) return links.forward(req.code, req);
          return refuse(`${req.to} isn't in ${req.code} on this machine; nothing was sent`);
        }
        for (const id of to) {
          const key = `${id}\n${req.code}`;
          this.inboxes.set(key, [...(this.inboxes.get(key) ?? []), { code: req.code, from: req.from, text: req.text, at: now }].slice(-INBOX_MAX));
        }
        return Promise.resolve(ok(null));
      }
      case 'inbox': {
        const messages: Message[] = [];
        for (const code of this.sessions.get(req.session)?.rooms.keys() ?? []) {
          const key = `${req.session}\n${code}`;
          messages.push(...(this.inboxes.get(key) ?? []));
          this.inboxes.delete(key);
        }
        return Promise.resolve(ok({ messages }));
      }
      case 'status':
        return Promise.resolve(ok({ version: API_VERSION, pid: process.pid, sessions: [...this.live()].length }));
    }
  }

  /** The host's own entries (U15's admission and kicks), placed in order in the room's chain. */
  write(code: string, drafts: readonly Draft[]): Promise<Result<Placed | null>> {
    return this.queue(code, room => this.commit(room, drafts));
  }

  /**
   * Writes (or with null removes) a session's pointer. A write also sweeps pointers nobody has pinged for a day: their
   * sessions ended without a SessionEnd (a crash, a kill).
   */
  private async pointer(id: string, p: Pointer | null): Promise<Result<null>> {
    const file = sessionFile(this.o.home, id);
    if (p === null) { await fs.rm(file, { force: true }); return ok(null); }
    await writeAtomic(file, JSON.stringify(p));
    const dir = path.dirname(file);
    for (const n of await fs.readdir(dir).catch(() => [])) {
      const old = await fs.stat(`${dir}/${n}`).then(s => this.o.now() - s.mtimeMs > POINTER_STALE_MS, () => false);
      if (old) await fs.rm(`${dir}/${n}`, { force: true });
    }
    return ok(null);
  }

  /** Settles once every write started so far has finished. */
  async drain(): Promise<void> { await Promise.all(this.chains.values()); }

  private async plan(room: Room, req: Writer & PlanAct): Promise<Result<Answers['plan']>> {
    const s = room.snap.state;
    if (!member(s, req.from)) return err(`${req.from} is not in ${req.code}; nothing was written`);
    let drafts: Result<Draft[]>;
    switch (req.act) {
      case 'edit': {
        // the base is checked before the text is stored, so a refused edit leaves no file behind
        drafts = edit(s, { ...req, hash: await sha256(req.text) });
        if (!drafts.ok) return ok({ refused: drafts.error, latest: latestVersion(s, req.name) });
        await room.store.putBlob(req.text);
        break;
      }
      case 'ask': drafts = ask(s, req); break;
      case 'answer': drafts = answer(s, req, await texts(room, [req.name])); break;
      case 'send': drafts = send(s, req); break;
      case 'accept': drafts = accept(s, req); break;
    }
    const r = drafts.ok ? await this.commit(room, drafts.value) : drafts;
    const after = room.snap.state;
    return r.ok ? ok({ seq: after.seq, hash: after.hash, latest: latestVersion(after, req.name) }) : r;
  }

  private async task(room: Room, req: Writer & TaskAct): Promise<Result<Answers['task']>> {
    const s = room.snap.state;
    if (!member(s, req.from)) return err(`${req.from} is not in ${req.code}; nothing was written`);
    const drafts = req.act === 'add' ? add(s, req) : req.act === 'claim' ? claim(s, req) : req.act === 'release' ? release(s, req) : done(s, req);
    const n = req.act === 'add' ? nextN(s.tasks) : req.n;
    const r = drafts.ok ? await this.commit(room, drafts.value) : drafts;
    return r.ok ? ok({ seq: room.snap.state.seq, hash: room.snap.state.hash, n }) : r;
  }

  /** A rule's entries, stamped by the host and placed in order; the last one placed, or null for none. */
  private async commit(room: Room, drafts: readonly Draft[]): Promise<Result<Placed | null>> {
    let last: Placed | null = null;
    for (const d of drafts) {
      const r = await this.place(room, { ...d, id: randomUUID(), at: this.o.now(), machine: this.o.machine });
      if (!r.ok) return r;
      last = r.value;
    }
    return ok(last);
  }

  private async place(room: Room, d: StoreDraft): Promise<Result<Placed>> {
    const line = await room.store.append(d);
    if (!line.ok) return line;
    room.snap = nextSnapshot(room.snap, [line.value]);
    const placed = { seq: line.value.entry.seq, hash: line.value.hash };
    remember(room.ids, d.id, placed);
    if (d.kind === 'kick') {
      // a kicked member who was asked never blocks a decision (core/plans.ts decide)
      const s = room.snap.state;
      const t = await texts(room, s.plans.map(p => p.name));
      const decided = await this.commit(room, s.plans.flatMap(p => decide(s, p.name, d.from, t)));
      if (!decided.ok) return decided;
    }
    return ok(placed);
  }

  /** Runs `fn` on the room after every earlier call on it has finished. */
  private queue<T>(code: string, fn: (room: Room) => Promise<Result<T>>): Promise<Result<T>> {
    const run = (this.chains.get(code) ?? Promise.resolve()).then(async () => {
      const room = await this.room(code);
      return room.ok ? fn(room.value) : room;
    });
    this.chains.set(code, run.catch(() => undefined));
    return run;
  }

  private async room(code: string): Promise<Result<Room>> {
    const known = this.rooms.get(code);
    if (known) return ok(known);
    const store = await openFsStore({ home: this.o.home, code, now: this.o.now });
    if (!store.ok) return store;
    const c = await store.value.catchup();
    if (!c.ok) return err(`room ${code}'s log can't be read (${c.error}); nothing was written`);
    const ids = new Map<string, Placed>();
    for (const l of c.value.lines) remember(ids, l.entry.id, { seq: l.entry.seq, hash: l.hash });
    const room = { store: store.value, snap: nextSnapshot(c.value.snapshot, c.value.lines), ids };
    this.rooms.set(code, room);
    return ok(room);
  }

  private *live(): Iterable<[string, Session]> {
    const now = this.o.now();
    for (const e of this.sessions) if (now - e[1].at <= this.o.idleMs) yield e;
  }
}

/** The latest text of each named plan, for the rules that read a plan's parts. */
async function texts(room: Room, names: readonly string[]): Promise<Texts> {
  const known = new Map<string, string>();
  for (const n of names) {
    const v = latestVersion(room.snap.state, n);
    if (v) known.set(v.hash, (await room.store.getBlob(v.hash)) ?? '');
  }
  return hash => known.get(hash) ?? '';
}
function member(s: RoomState, name: string): boolean { return s.members.some(m => m.name === name && !m.kicked); }
function remember(ids: Map<string, Placed>, id: string, p: Placed): void {
  ids.set(id, p);
  for (const k of ids.keys()) { if (ids.size <= IDS_MAX) break; ids.delete(k); }
}
function refuse(error: string): Promise<Result<never>> { return Promise.resolve(err(error)); }
