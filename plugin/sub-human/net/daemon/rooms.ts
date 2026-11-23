// What the daemon does with each request (core/api.ts). Rooms hosted here are FsStores, one promise chain per room, so
// writes in this daemon never wait on each other's file lock: the lock only guards against a second daemon, and a
// laptop asleep mid-append can't make a waiter here break a live lock. The rules are core's (plans.ts, tasks.ts); this
// only applies them to the room's state and appends what they return. Rooms hosted elsewhere go to `links`; for rooms
// hosted here, net/host.ts writes what its links send through handle() with the link's machine, and follows each room.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Answers, Message, Op, PlanAct, RoomRequest, TaskAct } from '../../core/api.js';
import { API_VERSION, CODE, SESSION_ID, pingedFile, sessionFile } from '../../core/api.js';
import { sha256 } from '../../core/hash.js';
import { Pointers } from './pointers.js';
import { asRoom, fold } from '../../core/fold.js';
import { pick } from './open.js';
import type { Docs, Draft, Kind, LogLine, RoomState, Snapshot } from '../../core/entries.js';
import { applyPlan, decide, latestVersion } from '../../core/plans.js';
import type { Texts } from '../../core/plans.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { add, claim, done, nextN, release } from '../../core/tasks.js';
import type { FsStore } from '../../store/fs-store.js';
import { openFsStore } from '../../store/fs-store.js';
import type { Draft as StoreDraft } from '../../store/store.js';
import { nextSnapshot } from '../../store/store.js';
import { RETAIN_MS, dropOld, unused } from '../../store/retention.js';
import { writeAtomic } from '../../store/atomic.js';
import { fileKey, roomDir } from '../../home.js';

/** Rooms hosted on another machine: their writes and messages go over that room's link (net/link.ts). */
export interface Links {
  hosts(code: string): boolean;
  forward(code: string, req: RoomRequest): Promise<Result<Answers[Op]>>;
  /** For a room hosted here: a message to a member on another machine, over their link; false when none is up. */
  relay(code: string, to: string, from: string, text: string): boolean;
  /** Such a room's state as this machine's copy holds it, or null when there is none. */
  state(code: string): Promise<RoomState | null>;
  /** R3: closes the room's link for good and deletes its file (the copy is the caller's to delete). */
  forget(code: string): Promise<void>;
}
/** No links: every room is hosted here. */
export const NO_LINKS: Links = {
  hosts: () => false,
  forward: () => Promise.resolve(err('the room\'s host is away; nothing was sent')),
  relay: () => false,
  state: () => Promise.resolve(null),
  forget: () => Promise.resolve(),
};
/** A link following a room hosted here: each line placed and each document put, as they happen. */
export interface Follower { line(l: LogLine): void; doc(key: string, doc: unknown): void }
/** What a follower starts from: the lines after its cursor, or (off the host's chain, or new) a snapshot first. */
export interface Start { readonly snapshot: Snapshot | null; readonly lines: readonly LogLine[]; readonly docs: Docs }

/** Entries only the host writes, from its own rules; a caller asks for them with plan and task. */
const HOST_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'plan', 'plan_ask', 'plan_answer', 'decision', 'plan_sent', 'plan_accept', 'task', 'invite', 'admit', 'kick',
]);
/** Messages kept per inbox until taken, and appended ids remembered per room; the oldest go first. */
const INBOX_MAX = 100;
const IDS_MAX = 10_000;
const DAY_MS = 24 * 3600_000;
/** The chain every join runs on. */
const OPEN = '#open';

interface Placed { readonly seq: number; readonly hash: string }
interface Room { readonly store: FsStore; snap: Snapshot; readonly ids: Map<string, Placed>; readonly followers: Set<Follower> }
/** A session's rooms (code → its name there) and when it was last heard from. */
interface Session { at: number; cc?: string; readonly rooms: Map<string, string> }
interface Writer { readonly code: string; readonly from: string }

export interface RoomsOptions {
  readonly home: string;
  readonly now: () => number;
  readonly machine: string;
  /** A session not heard from for this long is gone. */
  readonly idleMs: number;
  readonly links?: Links;
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
  /** Rooms hosted elsewhere: the daemon sets net/'s once it is made from these rooms. */
  links: Links;

  private readonly pointers: Pointers;
  /** When each session last pinged: what liveness reads (core/api.ts LIVE_MS). Kept a day. */
  private readonly pinged = new Map<string, number>();
  /** Debug lines for the next ping to take (core/api.ts ping). */
  private notes: string[] = [];

  constructor(o: RoomsOptions) {
    this.o = o;
    this.lastSeen = o.now();
    this.links = o.links ?? NO_LINKS;
    this.pointers = new Pointers({
      home: o.home, now: o.now, pingedAt: id => this.pinged.get(id),
      left: p => this.handle({ op: 'append', code: p.code, draft: { kind: 'left', from: p.name, by: 'system', id: p.leave } }),
      away: p => this.handle({ op: 'put_doc', code: p.code, kind: 'presence', name: p.name, doc: { name: p.name, state: 'away', at: this.o.now() } }),
    });
  }

  /** `machine` is a link's, for a write that came over it. */
  handle(req: RoomRequest, machine: string = this.o.machine): Promise<Result<Answers[Op]>> {
    const { links } = this;
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
          // membership is per name: a joined for a member who is here, or a left for one who isn't, changes nothing
          const here = m?.machine !== undefined;
          if ((draft.kind === 'joined' && here) || (draft.kind === 'left' && !here)) return ok({ seq: room.snap.state.seq, hash: room.snap.state.hash });
          return this.place(room, { ...draft, at: now, machine });
        });
      }
      case 'plan':
        return links.hosts(req.code) ? links.forward(req.code, req) : this.queue(req.code, room => this.plan(room, req));
      case 'task':
        return links.hosts(req.code) ? links.forward(req.code, req) : this.queue(req.code, room => this.task(room, req));
      case 'put_doc':
        if (links.hosts(req.code)) return links.forward(req.code, req);
        return this.queue(req.code, async room => {
          if (!member(asRoom(room.snap.state), req.name)) return err(`${req.name} is not in ${req.code}; nothing was written`);
          // a presence is one machine's: `presence/NAME@MACHINE`, stamped with the writer's machine; the store renews
          // the tail's documents stamp
          const doc = req.doc;
          if ('state' in doc) {
            const stamped = { ...doc, machine };
            await room.store.putDoc('presence', `${req.name}@${machine}`, stamped);
            for (const f of room.followers) f.doc(`presence/${req.name}@${machine}`, stamped);
          } else {
            await room.store.putDoc(req.kind, req.name, doc);
            for (const f of room.followers) f.doc(`${req.kind}/${req.name}`, doc);
          }
          return ok(null);
        });
      case 'put_blob':
        if (links.hosts(req.code)) return links.forward(req.code, req);
        return this.queue(req.code, async room => ok({ hash: await room.store.putBlob(req.text) }));
      case 'join': return this.serial(OPEN, () => this.join(req));
      case 'leave': return this.pointers.leave(req.id);
      case 'retire': return this.pointers.retire(req.id);
      case 'handoff': return this.pointers.handoff(req.id, req.cwd);
      case 'claim': return this.pointers.claim(req.id, req.cwd);
      case 'ping': return this.ping(req, now);
      case 'message':
        if (this.receive(req.code, req.to, req.from, req.text) || links.relay(req.code, req.to, req.from, req.text)) return Promise.resolve(ok(null));
        if (links.hosts(req.code)) return links.forward(req.code, req);
        return refuse(`${req.to} isn't in ${req.code} on this machine; nothing was sent`);
      case 'inbox': {
        const messages: Message[] = [];
        for (const code of this.sessions.get(req.session)?.rooms.keys() ?? []) {
          const key = `${req.session}\n${code}`;
          messages.push(...(this.inboxes.get(key) ?? []));
          this.inboxes.delete(key);
        }
        return Promise.resolve(ok({ messages }));
      }
      case 'status': return this.status(req.session);
    }
  }

  /** Keeps the session live and its pointer fresh; a session first heard from leaves a marker, which outlives this daemon. */
  private async ping(req: Extract<RoomRequest, { op: 'ping' }>, now: number): Promise<Result<Answers['ping']>> {
    if (SESSION_ID.test(req.session)) {
      const d = new Date(now);
      void fs.utimes(sessionFile(this.o.home, req.session), d, d).catch(() => undefined); // still alive: keep its pointer
      if (!this.pinged.has(req.session)) await writeAtomic(pingedFile(this.o.home, req.session), '').catch(() => undefined);
    }
    this.pinged.set(req.session, now);
    for (const [id, at] of this.pinged) if (now - at > DAY_MS) this.pinged.delete(id);
    const s = this.sessions.get(req.session) ?? { at: now, rooms: new Map<string, string>() };
    s.at = now;
    if (req.cc !== undefined) s.cc = req.cc;
    if (req.code !== undefined && req.name !== undefined) s.rooms.set(req.code, req.name);
    this.sessions.set(req.session, s);
    for (const [id, x] of this.sessions) if (now - x.at > this.o.idleMs) this.sessions.delete(id);
    const notes = this.notes.splice(0);
    return ok(notes.length ? { notes } : null);
  }

  private async status(session: string | undefined): Promise<Result<Answers['status']>> {
    const live = [...this.live()];
    const cc = [...new Set(live.flatMap(([, s]) => (s.cc === undefined ? [] : [s.cc])))].sort();
    const pinged = session === undefined ? {} : { pinged: this.pinged.has(session) || (await fs.access(pingedFile(this.o.home, session)).then(() => true, () => false)) };
    return ok({ version: API_VERSION, pid: process.pid, sessions: live.length, cc, ...pinged });
  }

  /**
   * R3: deletes each room here, hosted here or a copy with its link, that no pointer or fresh handoff holds and nobody
   * has used for RETAIN_MS, with one debug line; and the ping markers a day old.
   */
  async sweep(): Promise<void> {
    for (const code of await this.codes()) {
      if (await this.pointers.holds(code)) continue;
      await this.serial(code, async () => {
        const dir = roomDir(this.o.home, await fileKey(code));
        if (!(await unused(dir, this.o.now()))) return;
        this.rooms.delete(code);
        await this.links.forget(code);
        await fs.rm(dir, { recursive: true, force: true });
        this.notes.push(`sub-human: deleted room ${code}: nobody had been in it for ${RETAIN_MS / DAY_MS} days`);
      });
    }
    await dropOld(`${this.o.home}/pinged`, this.o.now() - DAY_MS);
  }

  private async codes(): Promise<string[]> {
    return (await fs.readdir(`${this.o.home}/rooms`).catch(() => [])).filter(c => CODE.test(c));
  }

  /** A private message into the inbox of each session here that is `to` in the room; false when there is none. */
  receive(code: string, to: string, from: string, text: string): boolean {
    const ids = [...this.live()].filter(([, s]) => s.rooms.get(code) === to).map(([id]) => id);
    for (const id of ids) {
      const key = `${id}\n${code}`;
      this.inboxes.set(key, [...(this.inboxes.get(key) ?? []), { code, from, text, at: this.o.now() }].slice(-INBOX_MAX));
    }
    return ids.length > 0;
  }

  /** The rooms a session here is in; its name in one; whether any live session is in `code`. */
  roomsOf(session: string): string[] { return [...this.sessions.get(session)?.rooms.keys() ?? []]; }
  nameIn(session: string, code: string): string | undefined { return this.sessions.get(session)?.rooms.get(code); }
  present(code: string): boolean { return [...this.live()].some(([, s]) => s.rooms.has(code)); }

  /** The room's state now, after every write already under way. */
  state(code: string): Promise<Result<RoomState>> { return this.queue(code, room => Promise.resolve(ok(asRoom(room.snap.state)))); }
  async blob(code: string, hash: string): Promise<string | null> {
    const room = await this.room(code);
    return room.ok ? room.value.store.getBlob(hash) : null;
  }

  /**
   * Starts `f` following the room after the cursor (seq and hash; 0 for a new mirror): in the room's chain, so no line
   * falls between what it starts from and what it is then told. The returned function stops it.
   */
  follow(code: string, seq: number, hash: string, f: Follower): Promise<Result<{ start: Start; stop: () => void }>> {
    return this.queue(code, async room => {
      const docs = await room.store.docs();
      const after = seq > 0 ? await room.store.read(seq, hash) : null;
      let start: Start;
      if (after?.ok) start = { snapshot: null, lines: after.value, docs };
      else {
        const c = await room.store.catchup();
        if (!c.ok) return c;
        start = { snapshot: c.value.snapshot ?? nextSnapshot(null, []), lines: c.value.lines, docs };
      }
      room.followers.add(f);
      return ok({ start, stop: () => { room.followers.delete(f); } });
    });
  }

  /** The host's own entries (U15's admission and kicks), placed in order in the room's chain. */
  write(code: string, drafts: readonly Draft[]): Promise<Result<Placed | null>> {
    return this.queue(code, room => this.commit(room, drafts));
  }

  /**
   * A bare /sub-human, on one chain so two first opens make one room: open.ts picks the room; `joined` only when the
   * name isn't a member; then an idle presence here (which makes the room open), the pointer and the cwd's last room.
   */
  private async join(req: Extract<RoomRequest, { op: 'join' }>): Promise<Result<Answers['join']>> {
    const rooms = new Map<string, RoomState>();
    for (const code of await this.codes()) {
      if (this.links.hosts(code)) {
        const s = await this.links.state(code); // a room hosted elsewhere, as its copy here stands
        if (s) rooms.set(code, s);
        continue;
      }
      const room = await this.room(code);
      if (room.ok) rooms.set(code, fold(room.value.snap, [], await room.value.store.docs()));
    }
    const last = await this.pointers.last(req.cwd);
    const p = pick({ rooms, name: req.name, random: Math.random, ...(req.code !== undefined && { asked: req.code }), ...(last !== null && { last }) });
    if (!p.ok) return p;
    if ('rooms' in p.value) return ok({ rooms: p.value.rooms });
    const { code, fresh } = p.value;
    const state = rooms.get(code);
    const me = state?.members.find(m => m.name === req.name);
    if (me?.kicked) return err(`${req.name} was removed from ${code}.`);
    if (me?.machine === undefined) {
      const where = { ...(req.repo !== undefined && { repo: req.repo }), ...(req.branch !== undefined && { branch: req.branch }) };
      const j = await this.handle({ op: 'append', code, draft: { kind: 'joined', from: req.name, by: 'system', id: randomUUID(), ...where } });
      if (!j.ok) return j;
    }
    const here = await this.handle({ op: 'put_doc', code, kind: 'presence', name: req.name, doc: { name: req.name, state: 'idle', at: this.o.now() } });
    if (!here.ok) return here;
    const t = await this.pointers.write(req.id, { code, name: req.name, leave: req.leave });
    if (!t.ok) return t;
    await this.pointers.setLast(req.cwd, code);
    const others = (state?.members ?? []).filter(m => m.machines.length > 0 && m.name !== req.name).map(m => m.name);
    return ok({ code, title: t.value.title, opened: fresh, others });
  }

  /** Runs `fn` after every earlier call on `key` has finished. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /** Settles once every write started so far has finished. */
  async drain(): Promise<void> { await Promise.all(this.chains.values()); }

  private async plan(room: Room, req: Writer & PlanAct): Promise<Result<Answers['plan']>> {
    const s = asRoom(room.snap.state);
    const applied = applyPlan(s, req, req.act === 'edit' ? await sha256(req.text) : '', req.act === 'answer' ? await texts(room, [req.name]) : () => '');
    if (!applied.ok) return applied;
    if ('refused' in applied.value) return ok({ refused: applied.value.refused, latest: latestVersion(s, req.name) });
    // the base is checked before the text is stored, so a refused edit leaves no file behind
    if (req.act === 'edit') await room.store.putBlob(req.text);
    const r = await this.commit(room, applied.value.drafts);
    const after = asRoom(room.snap.state);
    return r.ok ? ok({ seq: after.seq, hash: after.hash, latest: latestVersion(after, req.name) }) : r;
  }

  private async task(room: Room, req: Writer & TaskAct): Promise<Result<Answers['task']>> {
    const s = asRoom(room.snap.state);
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
    for (const f of room.followers) f.line(line.value);
    if (d.kind === 'kick') {
      // a kicked member who was asked never blocks a decision (core/plans.ts decide)
      const s = asRoom(room.snap.state);
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
    const room = { store: store.value, snap: nextSnapshot(c.value.snapshot, c.value.lines), ids, followers: new Set<Follower>() };
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
    const v = latestVersion(asRoom(room.snap.state), n);
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
