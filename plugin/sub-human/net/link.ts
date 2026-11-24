// The joiner's side (ARCHITECTURE §7 "Remote join", §8, R28, R32, R36), in the daemon: one link per room hosted
// elsewhere, each running core/link-engine.ts and doing its effects, and keeping store/mirror-store.ts in step with
// the host (the snapshot and the lines after it; a fork resyncs). Writes, private messages and plan and task requests
// go over it; while it is down the member's own documents wait here and are sent again on reconnect, a person's post
// queues for a while under its id, and every other write fails at once. join() proves an invite line and waits for
// the host's Let in; then the room's link starts and stays, across restarts, until the host removes this machine.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as v from '../vendor/valibot.mjs';
import type { AppendDraft, Answers, LinkStatus, Op, RoomRequest } from '../core/api.js';
import { HOST_AWAY as AWAY, decodeAppendDraft, readAnswer } from '../core/api.js';
import type { RoomState } from '../core/entries.js';
import { DOC_KINDS } from '../core/entries.js';
import { fold } from '../core/fold.js';
import type { LinkEffect, LinkEvent, LinkState, Timer, Timings } from '../core/link-engine.js';
import { initial, step } from '../core/link-engine.js';
import type { ToHost } from '../core/protocol.js';
import { decodeToLink, encode, hello, negotiate, skewLine } from '../core/protocol.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { decodeDoc, parseJson } from '../core/schema.js';
import { fileKey, roomDir } from '../home.js';
import { writeAtomic } from '../store/atomic.js';
import { MirrorStore } from '../store/mirror-store.js';
import type { Draft } from '../store/store.js';
import type { Channel, KeyPair } from './channel.js';
import { NoiseError, connect } from './channel.js';
import type { Rooms } from './daemon/rooms.js';
import type { Pathway } from './invite.js';
import { mac, parse } from './invite.js';

/** A pathway's one job: a byte stream to the host the line names. */
export type Dial = (via: Pathway, code: string) => Promise<Duplex>;
export interface Clock { now(): number; after(ms: number, fn: () => void): () => void }
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => { const t = setTimeout(fn, ms); t.unref(); return () => { clearTimeout(t); }; },
};
export const TIMINGS: Timings = { retryMs: 1000, retryMaxMs: 60_000, dialMs: 20_000, pingMs: 25_000, pongMs: 10_000, tickMs: 5000, postTtlMs: 10 * 60_000 };
/** How long a write waits for the host's ack, and a join for the host's answer (its card waits five minutes). */
const WRITE_MS = 15_000;
const JOIN_MS = 6 * 60_000;

const linkFile = v.object({
  code: v.string(), name: v.string(), hostKey: v.string(), stopped: v.exactOptional(v.string()),
  via: v.variant('kind', [
    v.object({ kind: v.literal('https'), origin: v.string() }),
    v.object({ kind: v.literal('ssh'), host: v.string(), user: v.nullable(v.string()), sshPort: v.nullable(v.number()), port: v.number() }),
  ]),
});
type LinkFile = v.InferOutput<typeof linkFile>;

export interface LinkSetOptions {
  readonly home: string;
  readonly rooms: Rooms;
  readonly key: KeyPair;
  readonly machine: string;
  readonly dial: Dial;
  readonly clock?: Clock;
  readonly timings?: Timings;
  /** Each phase a room's link enters. */
  readonly phase?: (code: string, phase: LinkStatus['phase']) => void;
}

export class LinkSet {
  private readonly o: LinkSetOptions;
  private readonly links = new Map<string, Link>();
  private readonly joining = new Map<string, LinkStatus>();
  constructor(o: LinkSetOptions) { this.o = o; }

  async start(): Promise<void> {
    const dir = `${this.o.home}/links`;
    for (const n of await fs.readdir(dir).catch(() => [])) {
      if (!n.endsWith('.json')) continue;
      const r = parseJson(linkFile, await fs.readFile(`${dir}/${n}`, 'utf8').catch(() => ''));
      // one unreadable file costs its own room's link, never the daemon's start
      if (r.ok) await this.add(r.value);
      else this.o.rooms.note(`sub-human: could not read its record of a room joined elsewhere (${n}: ${r.error}); that room stays closed here`);
    }
  }
  stop(): void { for (const l of this.links.values()) l.close(); }

  hosts(code: string): boolean { return this.links.has(code); }
  forward(code: string, req: RoomRequest): Promise<Result<Answers[Op]>> {
    return this.links.get(code)?.forward(req) ?? Promise.resolve(err(AWAY));
  }
  async state(code: string): Promise<RoomState | null> {
    const m = this.links.get(code)?.mirror;
    const c = m ? await m.catchup() : null;
    return m && c?.ok ? fold(c.value.snapshot, c.value.lines, await m.docs()) : null;
  }
  async forget(code: string): Promise<void> {
    this.links.get(code)?.close();
    this.links.delete(code);
    await fs.rm(`${this.o.home}/links/${await fileKey(code)}.json`, { force: true });
  }
  status(code: string): LinkStatus | null { return this.links.get(code)?.status ?? this.joining.get(code) ?? null; }

  /** Proves the line to its host and answers the check string; the host's answer arrives later (status). */
  async join(line: string, name: string): Promise<Result<{ code: string; check: string }>> {
    const inv = parse(line);
    if (!inv.ok) return err(`${inv.error}; nothing was sent`);
    const { code, hostKey, via } = inv.value;
    if (this.links.has(code) && this.links.get(code)?.status.phase !== 'stopped') return err(`this machine is already in ${code}`);
    // a room here with no link to it is hosted here: a line naming its code must not turn it into a copy of another's
    const hosted = !this.links.has(code) && await fs.stat(roomDir(this.o.home, await fileKey(code))).then(() => true, () => false);
    if (hosted) return err(`this machine already hosts room ${code}; nothing was sent`);
    let ch: Channel, stream: Duplex | null = null;
    try {
      const pay = { code, name, machine: this.o.machine, mac: mac(inv.value, this.o.key.pub).toString('base64url') };
      stream = await this.o.dial(via, code);
      ch = await connect(stream, { s: this.o.key, rs: hostKey, payload: Buffer.from(JSON.stringify(pay)) });
    } catch (e) {
      // a pathway's own failure first; a handshake nobody completes is someone without the line's key
      const why = stream?.errored ?? e;
      if (why instanceof NoiseError) return err('whoever answered is not the host the line names; nothing was sent. Ask the host for a new invite');
      return err(`the room's host could not be reached (${why instanceof Error ? why.message : String(why)}); nothing was sent`);
    }
    this.joining.set(code, { phase: 'waiting', why: null });
    let over = false;
    const done = async (why: string | null): Promise<void> => {
      if (over) return;
      over = true;
      cancel();
      ch.close();
      if (why !== null) { this.joining.set(code, { phase: 'stopped', why }); return; }
      const file: LinkFile = { code, name, hostKey: hostKey.toString('base64url'), via };
      await writeAtomic(`${this.o.home}/links/${await fileKey(code)}.json`, JSON.stringify(file));
      await this.add(file);
      this.joining.delete(code);
    };
    const refused = 'the host did not let this machine in; ask them for a new invite';
    const cancel = (this.o.clock ?? REAL_CLOCK).after(JOIN_MS, () => { void done(refused); });
    ch.onMessage(b => {
      const m = decodeToLink(b.toString('utf8'));
      if (!m.ok || m.value?.t !== 'hello') return;
      const a = negotiate(hello(name, this.o.machine), m.value);
      void done(a.ok ? null : skewLine(a.update, 'the host'));
    });
    ch.onClose(() => { void done(refused); });
    return ok({ code, check: ch.check });
  }

  private async add(file: LinkFile): Promise<void> {
    this.links.get(file.code)?.close();
    const link = new Link(this.o, file, roomDir(this.o.home, await fileKey(file.code)));
    this.links.set(file.code, link);
    link.start();
  }
}

class Link {
  readonly mirror: MirrorStore;
  status: LinkStatus = { phase: 'connecting', why: null };
  private readonly o: LinkSetOptions;
  private readonly file: LinkFile;
  private readonly clock: Clock;
  private state: LinkState;
  private readonly conns = new Map<number, Channel>();
  private readonly timers = new Map<Timer, () => void>();
  private readonly waits = new Map<string, (r: Result<unknown>) => void>();
  /** Posts not yet acked, by id: the engine says when to send them. */
  private readonly posts = new Map<string, AppendDraft>();
  private subscribing: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private pings = 0;
  private ticking: (() => void) | null = null;

  constructor(o: LinkSetOptions, file: LinkFile, dir: string) {
    this.o = o;
    this.file = file;
    this.clock = o.clock ?? REAL_CLOCK;
    this.state = initial(o.timings ?? TIMINGS, this.clock.now(), Math.floor(Math.random() * 2 ** 31));
    this.mirror = new MirrorStore(dir, {
      append: d => this.write(d),
      putDoc: (kind, n, doc) => { this.send({ t: 'put_doc', id: randomUUID(), key: `${kind}/${n}`, doc }); return Promise.resolve(); },
      putBlob: (text, hash) => { this.send({ t: 'put_blob', id: randomUUID(), hash, text }); return Promise.resolve(); },
    });
  }

  start(): void {
    if (this.file.stopped !== undefined) { this.status = { phase: 'stopped', why: this.file.stopped }; return; }
    this.run({ type: 'start' });
    const tick = (): void => { this.run({ type: 'tick' }); this.ticking = this.clock.after(this.state.timings.tickMs, tick); };
    this.ticking = this.clock.after(this.state.timings.tickMs, tick);
  }
  close(): void {
    this.ticking?.();
    for (const t of this.timers.values()) t();
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    for (const w of this.waits.values()) w(err(AWAY));
  }

  async forward(req: RoomRequest): Promise<Result<Answers[Op]>> {
    if (this.status.phase === 'stopped') return err(`${this.status.why ?? AWAY}; nothing was sent`);
    const online = this.status.phase === 'online';
    switch (req.op) {
      case 'append': {
        const draft = { ...req.draft, at: this.clock.now(), machine: this.o.machine };
        if (!online && !(draft.kind === 'post' && draft.by === 'person')) return err(AWAY);
        if (!online) return (await this.queue(draft)).ok ? ok({ seq: 0, hash: '' }) : err(AWAY);
        const line = await this.mirror.append(draft);
        return line.ok ? ok({ seq: line.value.entry.seq, hash: line.value.hash }) : line;
      }
      case 'put_doc': await this.mirror.putDoc(req.kind, req.name, req.doc); return ok(null);
      case 'put_blob': return online ? ok({ hash: await this.mirror.putBlob(req.text) }) : err(AWAY);
      case 'message': if (!online) return err(AWAY); this.send({ t: 'message', to: req.to, from: req.from, text: req.text }); return ok(null);
      case 'plan': case 'task': {
        if (!online) return err(AWAY);
        const id = randomUUID();
        const r = await this.wait(id, () => { this.send({ t: 'call', id, req }); });
        return r.ok ? readAnswer(req.op, 200, JSON.stringify({ ok: true, value: r.value })) : r;
      }
      case 'join': case 'leave': case 'retire': case 'handoff': case 'claim': case 'ping': case 'inbox': case 'status':
        return err(`${req.op} is not sent to a room's host; nothing was done`);
    }
  }

  /** The host's ack for a draft, its line by then extended here. A person's post goes through the engine's queue. */
  private async write(d: Draft): Promise<Result<null>> {
    if (d.kind === 'post' && d.by === 'person') return this.queue(d);
    const e = decodeAppendDraft(d);
    if (!e.ok) return e;
    const r = await this.wait(d.id, () => { this.send({ t: 'append', entry: e.value }); });
    return r.ok ? ok(null) : r;
  }
  private async queue(d: Draft): Promise<Result<null>> {
    const e = decodeAppendDraft(d);
    if (!e.ok) return e;
    this.posts.set(d.id, e.value);
    const r = await this.wait(d.id, () => { this.run({ type: 'post', id: d.id }); }, this.status.phase === 'online' ? WRITE_MS : 0);
    return r.ok ? ok(null) : r;
  }

  /** Runs `go`, then waits up to `ms` for the host's answer to `id` (0: only starts it). */
  private wait(id: string, go: () => void, ms = WRITE_MS): Promise<Result<unknown>> {
    return new Promise(resolve => {
      if (ms === 0) { go(); resolve(ok(null)); return; }
      const cancel = this.clock.after(ms, () => { this.waits.delete(id); resolve(err('the room\'s host did not answer; nothing was confirmed')); });
      this.waits.set(id, r => { cancel(); this.waits.delete(id); resolve(r); });
      go();
    });
  }

  private run(event: LinkEvent): void {
    const r = step(this.state, event, this.clock.now());
    this.state = r.state;
    for (const fx of r.effects) this.effect(fx);
  }

  private effect(fx: LinkEffect): void {
    switch (fx.type) {
      case 'dial': void this.dial(fx.conn); break;
      case 'close': this.conns.get(fx.conn)?.close(); this.conns.delete(fx.conn); break;
      case 'ping': this.send({ t: 'ping', n: ++this.pings }); break;
      case 'subscribe':
        this.subscribing = fx.conn;
        this.chain = this.chain.then(async () => {
          const h = fx.fresh ? null : await this.mirror.head();
          this.send({ t: 'subscribe', after_seq: h?.ok ? h.value.seq : 0, hash: h?.ok ? h.value.hash : '' });
        });
        break;
      case 'flush':
        this.chain = this.chain.then(async () => {
          for (const kind of DOC_KINDS) {
            const doc = await this.mirror.getDoc(kind, this.file.name);
            if (doc) this.send({ t: 'put_doc', id: randomUUID(), key: `${kind}/${this.file.name}`, doc });
          }
          for (const id of fx.posts) this.sendPost(id);
        });
        break;
      case 'send': this.sendPost(fx.id); break;
      case 'setTimer':
        this.timers.get(fx.name)?.();
        this.timers.set(fx.name, this.clock.after(fx.ms, () => { this.timers.delete(fx.name); this.run({ type: 'timer', name: fx.name }); }));
        break;
      case 'clearTimer': this.timers.get(fx.name)?.(); this.timers.delete(fx.name); break;
      case 'expired': for (const id of fx.ids) { this.posts.delete(id); this.waits.get(id)?.(err('the room\'s host stayed away; the post was not sent')); } break;
      case 'status': this.status = { phase: fx.phase, why: fx.why }; this.o.phase?.(this.file.code, fx.phase); break;
      case 'finish': void this.finish(fx.why); break;
    }
  }

  /** Kicked, refused or a skew: for good. The link file says so, so a restart does not dial again. */
  private async finish(why: string): Promise<void> {
    this.close();
    this.status = { phase: 'stopped', why };
    await writeAtomic(`${this.o.home}/links/${await fileKey(this.file.code)}.json`, JSON.stringify({ ...this.file, stopped: why }));
  }

  private async dial(conn: number): Promise<void> {
    const { code, name } = this.file;
    try {
      const stream = await this.o.dial(this.file.via, code);
      const payload = Buffer.from(JSON.stringify({ code, name, machine: this.o.machine }));
      const ch = await connect(stream, { s: this.o.key, rs: Buffer.from(this.file.hostKey, 'base64url'), payload });
      if (this.state.conn !== conn) { ch.close(); return; }
      this.conns.set(conn, ch);
      ch.onMessage(b => { this.chain = this.chain.then(() => this.on(conn, b.toString('utf8'))).catch(() => undefined); });
      ch.onClose(e => { this.conns.delete(conn); this.run({ type: 'failed', conn, why: e?.message ?? 'the host closed the connection' }); });
      ch.send(Buffer.from(encode(hello(name, this.o.machine))));
    } catch (e) {
      this.run({ type: 'failed', conn, why: e instanceof Error ? e.message : String(e) });
    }
  }

  private async on(conn: number, text: string): Promise<void> {
    const r = decodeToLink(text);
    if (!r.ok || !r.value) return;
    const m = r.value;
    switch (m.t) {
      case 'hello': {
        const a = negotiate(hello(this.file.name, this.o.machine), m);
        if (a.ok) this.run({ type: 'connected', conn });
        else { this.run({ type: 'bye', conn, reason: 'skew' }); this.status = { phase: 'stopped', why: skewLine(a.update, 'the host') }; }
        return;
      }
      case 'ping': this.send({ t: 'pong', n: m.n }); return;
      case 'pong': this.run({ type: 'pong', conn }); return;
      case 'snapshot': await this.mirror.reset(m.snapshot); return;
      case 'lines': {
        const x = await this.mirror.extend(m.lines);
        if (!x.ok) { this.run({ type: 'fork', conn }); return; }
        if (this.subscribing === conn) { this.subscribing = null; this.run({ type: 'synced', conn }); }
        return;
      }
      case 'put_doc': {
        const [kind, who] = m.key.split('/');
        const k = DOC_KINDS.find(d => d === kind);
        const doc = k && who !== undefined && who !== this.file.name ? decodeDoc(k, m.doc) : null;
        if (k && doc?.ok) await this.mirror.hostDoc(k, who ?? '', doc.value);
        return;
      }
      case 'put_blob': await this.mirror.hostBlob(m.text); return;
      case 'message': this.o.rooms.receive(this.file.code, m.to, m.from, m.text); return;
      case 'ack': case 'refused': case 'answer':
        this.posts.delete(m.id);
        this.run({ type: 'acked', id: m.id });
        this.waits.get(m.id)?.(m.t === 'refused' ? err(m.reason) : ok(m.t === 'answer' ? m.value : null));
        return;
      case 'bye': this.run({ type: 'bye', conn, reason: m.reason }); return;
    }
  }

  private sendPost(id: string): void {
    const entry = this.posts.get(id);
    if (entry) this.send({ t: 'append', entry });
  }
  /** On the live connection, if there is one; nothing otherwise (the engine re-sends what must be). */
  private send(m: ToHost): void {
    const ch = this.state.conn === null ? undefined : this.conns.get(this.state.conn);
    try { ch?.send(Buffer.from(encode(m))); } catch { /* closing: its close is the engine's event */ }
  }
}
