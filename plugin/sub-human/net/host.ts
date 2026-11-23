// The host's side of every link (ARCHITECTURE §8, R29a, R30, R31, R37, R40), in the daemon: one loopback listener for
// every room hosted here, reached by tailscaled (Funnel or Serve: a PROXY v2 header, then a WebSocket) or by a joiner's
// `ssh -W` (Noise's frames as they are). A connection is capped per source (the PROXY header's, counted as soon as it
// parses) and in all, and the handshake's third message must carry a known link key for its room or an open invite's
// MAC before a card is shown or a record touched. Another machine dialling a line already pending or used refuses both
// dials and alerts the host. Once a link is up, each write's `from` must be the link's member, the host's own kinds are
// refused (Rooms), and every write and subscribe is rate-limited per link.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import * as v from '../vendor/valibot.mjs';
import type { Ask, RoomRequest, Via } from '../core/api.js';
import { decodeRequest } from '../core/api.js';
import type { LogLine } from '../core/entries.js';
import type { ByeReason, ToLink } from '../core/protocol.js';
import { decodeToHost, encode, hello, negotiate } from '../core/protocol.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { writeAtomic } from '../store/atomic.js';
import type { Channel, KeyPair } from './channel.js';
import { HANDSHAKE_MS, accept } from './channel.js';
import type { Rooms } from './daemon/rooms.js';
import type { InviteRecord, Pathway } from './invite.js';
import { mint, verify } from './invite.js';
import { nameFrom } from '../commands/membership.js';
import { LIMITS } from '../core/entries.js';
import { parseProxy } from './proxy-v2.js';
import { acceptWs } from './pathways/tailscale.js';

export const INVITE_TTL_MS: number = 15 * 60_000;
export const ADMIT_MS: number = 5 * 60_000;
export const SOURCE_MAX: number = 8;
/** Every ssh -W connection is the one source `local`, so it has a cap of its own, well under the total. */
export const LOCAL_MAX: number = 32;
/** Connections not yet closed from every source together, so many made-up sources still hold little. */
export const TOTAL_MAX: number = 64;
/** Of those, what only local connections (ssh -W, which come with no PROXY header) may take: so public sources can't
 *  lock out ssh joiners. */
export const LOCAL_RESERVE: number = 8;
type Rated = 'append' | 'put_blob' | 'put_doc' | 'message' | 'subscribe';
/** Per link and minute (R40); a plan or task call counts as an append. */
export const RATES: Readonly<Record<Rated, number>> = { append: 120, put_blob: 30, put_doc: 240, message: 120, subscribe: 6 };

/** A machine let into a room: its link key, the member it writes as, the invite it came in on. */
interface LinkRecord { key: string; code: string; name: string; machine: string; invite: string; kicked: boolean }
/** The listener's port and the forwards publishing it are kept, so a restart serves the lines and links out there. */
interface State { invites: InviteRecord[]; links: LinkRecord[]; port: number; forwards: ('public' | 'tailnet')[] }
/** A forward that publishes the listener (net/pathways/tailscale.ts): its https origin, and how to take it down. */
export interface Forward { readonly origin: string; off(): Promise<void> }
export type Expose = (mode: 'public' | 'tailnet', port: number) => Promise<Result<Forward>>;

export interface HostOptions {
  readonly home: string;
  readonly rooms: Rooms;
  readonly key: KeyPair;
  readonly machine: string;
  readonly now: () => number;
  /** The listener's loopback port; 0 picks one. */
  readonly port: number;
  /** How a joiner's ssh reaches this machine (SUB_HUMAN_SSH_ADDR): [user@]host[:port]. */
  readonly sshAddr: string;
  readonly expose: Expose;
  /** Holds off sleep while a link is live (R28); answers the release. */
  readonly awake: () => () => void;
  readonly rates?: Partial<Record<Rated, number>>;
}

const short = v.pipe(v.string(), v.maxLength(256));
/** Message 3's payload: who dials, for which room, and the invite's MAC when it is a first dial. */
const payload = v.object({
  code: short,
  // a member name by the entry rule; a machine in hostname characters only (both are shown on the host's card)
  name: v.pipe(v.string(), v.maxLength(LIMITS.name), v.check(n => nameFrom(n) === n)),
  machine: v.pipe(v.string(), v.regex(/^[A-Za-z0-9.-]{1,64}$/)),
  mac: v.exactOptional(short),
});
const stateSchema = v.object({
  invites: v.array(v.object({ id: v.string(), code: v.string(), name: v.string(), macKey: v.string(), expiresAt: v.number(), state: v.picklist(['open', 'pending', 'used', 'dead']) })),
  links: v.array(v.object({ key: v.string(), code: v.string(), name: v.string(), machine: v.string(), invite: v.string(), kicked: v.boolean() })),
  port: v.number(),
  forwards: v.array(v.picklist(['public', 'tailnet'])),
});

interface Live {
  readonly ch: Channel; readonly link: LinkRecord; out: Promise<void>; stop?: () => void; closing?: true;
  readonly used: Map<string, { at: number; n: number }>;
}
/** How long a link told bye has to close before the host closes it, so the bye is read first. */
const BYE_MS = 1000;
type Outgoing = ToLink | (() => Promise<ToLink | null>);
/** An ask shown to the host's sessions. A joiner's carries its invite and key, and the dial now waiting on it (gen). */
interface Waiting {
  ask: Ask; readonly shown: Set<string>; answer?: (yes: boolean) => void;
  readonly invite?: string; readonly key?: string; gen: number; decided?: Promise<boolean>;
}

export class Host {
  private readonly o: HostOptions;
  private s: State = { invites: [], links: [], port: 0, forwards: [] };
  private saving: Promise<void> = Promise.resolve();
  private server: net.Server | null = null;
  private readonly sources = new Map<string, number>();
  private total = 0;
  private readonly socks = new Set<net.Socket>();
  private readonly live = new Set<Live>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly forwards = new Map<string, Forward>();
  private release: (() => void) | null = null;

  constructor(o: HostOptions) { this.o = o; }
  private get file(): string { return `${this.o.home}/host.json`; }

  async start(): Promise<void> {
    const text = await fs.readFile(this.file, 'utf8').catch(() => 'null');
    const r = v.safeParse(stateSchema, parseJson(text));
    if (r.success) this.s = r.output;
    if (!this.wanted()) return;
    const port = await this.listen();
    for (const mode of this.s.forwards) {
      const f = await this.o.expose(mode, port);
      if (f.ok) this.forwards.set(mode, f.value);
    }
  }

  /** Whether anyone may still come in: a link not kicked, or a line not yet used. */
  private wanted(): boolean {
    const now = this.o.now();
    return this.s.links.some(l => !l.kicked) || this.s.invites.some(i => i.state === 'open' && now < i.expiresAt);
  }

  /** Links are told the host is away; the forwards stay up while anyone may come back through them. */
  async stop(): Promise<void> {
    for (const l of this.live) this.bye(l, 'host_away');
    for (const w of this.waiting.values()) w.answer?.(false);
    await Promise.all([...this.live].map(l => l.out));
    if (!this.wanted() && this.s.forwards.length) {
      await Promise.all([...this.forwards.values()].map(f => f.off().catch(() => undefined)));
      await this.save(s => ({ ...s, forwards: [] }));
    }
    this.forwards.clear();
    const s = this.server;
    this.server = null;
    for (const sock of this.socks) sock.destroy(); // what never got in, or is still saying bye
    if (s) await new Promise(res => { s.close(res); });
    await this.saving;
  }

  /** The listener's port, started if it isn't. */
  async listen(): Promise<number> {
    if (!this.server) {
      const s = net.createServer(sock => { this.sniff(sock); });
      const bind = (port: number): Promise<void> => new Promise((res, rej) => { s.once('error', rej).listen(port, '127.0.0.1', () => { res(); }); });
      await bind(this.o.port || this.s.port).catch(() => bind(0)); // the port kept, unless something else took it
      this.server = s;
    }
    const a = this.server.address();
    const port = a !== null && typeof a === 'object' ? a.port : 0;
    if (port !== this.s.port) await this.save(st => ({ ...st, port }));
    return port;
  }

  /** One line for NAME by the chosen pathway, recorded in the room (never its secret). */
  async invite(req: { code: string; from: string; name: string; via: Via }): Promise<Result<{ line: string }>> {
    const st = await this.o.rooms.state(req.code);
    if (!st.ok) return st;
    if (!st.value.members.some(m => m.name === req.from && !m.kicked)) return err(`${req.from} is not in ${req.code}; no invite was made`);
    if (st.value.members.some(m => m.name === req.name && m.kicked)) return err(`${req.name} was removed from ${req.code}; no invite was made`);
    const port = await this.listen();
    let via: Pathway;
    if (req.via === 'ssh') {
      const m = /^(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/.exec(this.o.sshAddr);
      if (!m?.[2]) return err(`"${this.o.sshAddr}" is not an ssh address; no invite was made. Set SUB_HUMAN_SSH_ADDR to [user@]host`);
      via = { kind: 'ssh', host: m[2], user: m[1] ?? null, sshPort: m[3] ? Number(m[3]) : null, port };
    } else {
      let f = this.forwards.get(req.via);
      if (!f) {
        const r = await this.o.expose(req.via, port);
        if (!r.ok) return r;
        f = r.value;
        this.forwards.set(req.via, f);
        const mode = req.via;
        await this.save(s => ({ ...s, forwards: [...new Set([...s.forwards, mode])] }));
      }
      via = { kind: 'https', origin: f.origin };
    }
    const now = this.o.now();
    const { line, record } = mint({ code: req.code, name: req.name, hostKey: this.o.key.pub, via, now, ttlMs: INVITE_TTL_MS });
    await this.save(s => ({ ...s, invites: [...s.invites.filter(i => now < i.expiresAt && i.state !== 'dead'), record] }));
    const w = await this.o.rooms.write(req.code, [{ kind: 'invite', invite: record.id, name: req.name, expires: record.expiresAt, from: req.from, by: 'person' }]);
    return w.ok ? ok({ line }) : w;
  }

  /** The asks for a session's rooms it hasn't been shown yet. */
  asks(session: string): Ask[] {
    const rooms = new Set(this.o.rooms.roomsOf(session));
    const out = [...this.waiting.values()].filter(w => rooms.has(w.ask.code) && !w.shown.has(session));
    for (const w of out) w.shown.add(session);
    return out.map(w => w.ask);
  }

  /** A session's answer to an ask of its own room: Let in or Refuse a joiner, or kick whom a leaked line let in. */
  async answer(req: { session: string; code: string; id: string; answer: 'let_in' | 'refuse' | 'kick' }): Promise<Result<null>> {
    const w = this.waiting.get(req.id), from = this.o.rooms.nameIn(req.session, req.code);
    if (!w || w.ask.code !== req.code || from === undefined) return err('that ask was already answered or is gone; nothing was done');
    if (req.answer === 'kick') {
      if (w.ask.kind !== 'leaked') return err('there is nobody to kick for that ask');
      this.waiting.delete(req.id);
      return this.kick({ code: req.code, from, name: w.ask.name });
    }
    if (!w.answer) return err('that ask takes no answer; nothing was done');
    w.answer(req.answer === 'let_in');
    return ok(null);
  }

  async kick(req: { code: string; from: string; name: string }): Promise<Result<null>> {
    const w = await this.o.rooms.write(req.code, [{ kind: 'kick', name: req.name, from: req.from, by: 'person' }]);
    if (!w.ok) return w;
    const out = (c: string, n: string): boolean => c === req.code && n === req.name;
    await this.save(s => ({
      ...s,
      invites: s.invites.map(i => (out(i.code, i.name) ? { ...i, state: 'dead' } : i)),
      links: s.links.map(l => (out(l.code, l.name) ? { ...l, kicked: true } : l)),
    }));
    for (const l of this.live) if (out(l.link.code, l.link.name)) this.bye(l, 'kicked');
    return ok(null);
  }

  /** A message to `to` over their live links; false when none is up. */
  relay(code: string, to: string, from: string, text: string): boolean {
    const links = [...this.live].filter(l => l.link.code === code && l.link.name === to);
    for (const l of links) this.send(l, { t: 'message', to, from, text });
    return links.length > 0;
  }

  /** A connection from a pathway: capped per source, then the handshake and admission. */
  accept(stream: Duplex, source: string): void {
    if (this.take(stream, source)) this.handshake(stream);
  }

  /** Counts a connection against its source's cap and the total until it closes; false (and closed) when either is full. */
  private take(stream: Duplex, source: string): boolean {
    const n = this.sources.get(source) ?? 0;
    const cap = source === 'local' ? TOTAL_MAX : TOTAL_MAX - LOCAL_RESERVE;
    if (n >= (source === 'local' ? LOCAL_MAX : SOURCE_MAX) || this.total >= cap) { stream.destroy(); return false; }
    this.sources.set(source, n + 1);
    this.total++;
    stream.once('close', () => {
      this.total--;
      const k = (this.sources.get(source) ?? 1) - 1;
      if (k) this.sources.set(source, k); else this.sources.delete(source);
    });
    return true;
  }

  private handshake(stream: Duplex): void {
    let link: LinkRecord | null = null;
    const admit = async (rk: Buffer, p: Buffer, check: string): Promise<boolean> => { link = await this.admit(rk, p, check); return link !== null; };
    void accept(stream, { s: this.o.key, admit }).then(ch => { if (ch && link) this.serve(ch, link); }, () => undefined);
  }

  /** tailscaled's connections open with a PROXY v2 header and then a WebSocket; an ssh -W one with Noise's frames. */
  private sniff(sock: net.Socket): void {
    sock.on('error', () => undefined);
    this.socks.add(sock);
    sock.once('close', () => { this.socks.delete(sock); });
    const quiet = setTimeout(() => { sock.destroy(); }, HANDSHAKE_MS); // a connection that says nothing holds nothing
    let buf = Buffer.alloc(0);
    const first = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf[0] === 0x0d) {
        const p = parseProxy(buf);
        if (p.kind === 'more') return;
        clearTimeout(quiet);
        sock.off('data', first);
        // tailscaled names the joiner's own address; a loopback one is a local peer claiming to be the forward
        if (p.kind === 'bad' || /^(127\.|0:0:0:0:0:0:0:1$|0:0:0:0:0:ffff:7f)/.test(p.source)) { sock.destroy(); return; }
        if (this.take(sock, perNet(p.source))) void acceptWs(sock, p.rest).then(d => { if (d) this.handshake(d); else sock.destroy(); });
        return;
      }
      clearTimeout(quiet);
      sock.off('data', first);
      // HTTP with no PROXY header did not come through the forward: refused (R29a)
      if (/^[A-Z]/.test(buf.toString('latin1', 0, 1))) { sock.destroy(); return; }
      sock.unshift(buf);
      this.accept(sock, 'local');
    };
    sock.on('data', first);
  }

  /** The link a dial is admitted as, or null. A dial with neither a known key nor an invite's MAC touches nothing. */
  private async admit(rk: Buffer, raw: Buffer, check: string): Promise<LinkRecord | null> {
    const r = v.safeParse(payload, parseJson(raw.toString('utf8')));
    if (!r.success) return null;
    const p = r.output, key = rk.toString('base64url');
    const known = this.s.links.find(l => l.key === key && l.code === p.code);
    if (known) return known.kicked ? null : known;
    if (p.mac === undefined) return null;
    const proof = Buffer.from(p.mac, 'base64url');
    const judge = (): ReturnType<typeof verify> => verify(proof, this.o.key.pub, rk, this.s.invites, this.o.now());
    const first = judge();
    if (first.kind === 'none' || first.kind === 'dead') return null;
    const st = await this.o.rooms.state(first.record.code);
    // judged again after the wait: another dial of the same line may have made it pending meanwhile
    const verdict = judge();
    if (verdict.kind === 'none' || verdict.kind === 'dead') return null;
    const rec = verdict.record;
    const mine = [...this.waiting.values()].find(w => w.invite === rec.id);
    // the same machine dialling its pending line again (a retry) takes its own dial's place: no leak
    if (verdict.kind === 'again' && mine?.key === key) {
      // the card is shown again with the new channel's check string, which is the one the joiner now reads out
      mine.ask = { ...mine.ask, check, machine: p.machine };
      mine.shown.clear();
      return this.decide(mine, ++mine.gen, p);
    }
    const member = st.ok && st.value.members.some(m => m.name === p.name && !m.kicked);
    const ask = { id: randomUUID(), code: rec.code, name: p.name, expected: rec.name, machine: p.machine, check, member };
    if (verdict.kind === 'again') {
      // a leaked line: the dial waiting on it is refused too; a member it already let in can be kicked from the card
      mine?.answer?.(false);
      const got = this.s.links.find(l => l.invite === rec.id);
      await this.setInvite(rec.id, 'dead');
      this.waiting.set(ask.id, { ask: { ...ask, kind: got ? 'leaked' : 'again', name: got?.name ?? p.name }, shown: new Set(), gen: 0 });
      setTimeout(() => { this.waiting.delete(ask.id); }, ADMIT_MS).unref();
      return null;
    }
    const w: Waiting = { ask: { ...ask, kind: 'admit' }, shown: new Set(), invite: rec.id, key, gen: 0 };
    w.decided = new Promise(res => {
      const t = setTimeout(() => { res(false); }, ADMIT_MS);
      w.answer = y => { clearTimeout(t); res(y); };
    });
    // pending and waiting before the save's await, so a dial of the line in the meantime finds both and refuses this one
    this.waiting.set(ask.id, w);
    await this.setInvite(rec.id, 'pending');
    return this.decide(w, 0, p);
  }

  /** The host's answer for the dial `gen` of a joiner's ask: the link it is let in as, or null. */
  private async decide(w: Waiting, gen: number, p: { name: string; machine: string }): Promise<LinkRecord | null> {
    const yes = await w.decided;
    const { invite = '', key = '' } = w, code = w.ask.code;
    if (gen !== w.gen) return null; // a later dial of the same machine took this one's place
    this.waiting.delete(w.ask.id);
    const admit = { kind: 'admit', invite, name: p.name, link: key.slice(0, 16), from: p.name, by: 'system' } as const;
    // the admit is written first: a link is saved only once the room records it
    const placed = yes ? await this.o.rooms.write(code, [admit]).catch(() => null) : null;
    if (!placed?.ok) { await this.setInvite(invite, 'dead'); return null; }
    const link = { key, code, name: p.name, machine: p.machine, invite, kicked: false };
    await this.save(s => ({ ...s, invites: s.invites.map(i => (i.id === invite ? { ...i, state: 'used' } : i)), links: [...s.links.filter(l => l.key !== key || l.code !== code), link] }));
    return link;
  }

  private serve(ch: Channel, link: LinkRecord): void {
    const l: Live = { ch, link, out: Promise.resolve(), used: new Map() };
    this.live.add(l);
    this.awake();
    let chain = Promise.resolve();
    ch.onMessage(m => { chain = chain.then(() => this.on(l, m.toString('utf8'))).catch(() => { ch.close(); }); });
    ch.onClose(() => { l.stop?.(); this.live.delete(l); this.awake(); });
    this.send(l, hello('', this.o.machine));
  }

  private async on(l: Live, text: string): Promise<void> {
    const r = decodeToHost(text);
    if (!r.ok || !r.value || l.closing) return;
    const m = r.value, { code, name, machine } = l.link, rooms = this.o.rooms;
    const refuse = (id: string, reason = `this machine writes as ${name} only`): void => { this.send(l, { t: 'refused', id, reason }); };
    const write = async (id: string, req: Result<RoomRequest>, rate?: Rated): Promise<void> => {
      if (!req.ok) return refuse(id, req.error);
      if (rate && !this.allow(l, rate)) return refuse(id, 'too many writes from this machine; wait a minute');
      const a = await rooms.handle(req.value, { machine });
      this.send(l, a.ok ? { t: 'ack', id } : { t: 'refused', id, reason: a.error });
    };
    switch (m.t) {
      case 'hello': if (!negotiate(hello('', this.o.machine), m).ok) this.bye(l, 'skew'); return;
      case 'ping': this.send(l, { t: 'pong', n: m.n }); if (!rooms.present(code)) this.bye(l, 'host_away'); return;
      case 'pong': return;
      case 'subscribe': if (this.allow(l, 'subscribe')) return this.subscribe(l, m.after_seq, m.hash); this.bye(l, 'closed'); return;
      case 'append': {
        const draft = m.entry;
        return draft.from === name ? write(draft.id, ok({ op: 'append', code, draft }), 'append') : refuse(draft.id);
      }
      case 'put_doc': {
        const [kind, who] = m.key.split('/');
        const q = decodeRequest({ op: 'put_doc', code, kind, name, doc: m.doc });
        if (who !== name) return refuse(m.id);
        return write(m.id, q.ok && q.value.op === 'put_doc' ? ok(q.value) : err(q.ok ? 'not a document' : q.error), 'put_doc');
      }
      case 'put_blob': return write(m.id, ok({ op: 'put_blob', code, text: m.text }), 'put_blob');
      case 'call': {
        const q = m.req;
        if (q.code !== code || q.from !== name) return refuse(m.id);
        if (!this.allow(l, 'append')) return refuse(m.id, 'too many writes from this machine; wait a minute');
        const a = await rooms.handle(q, { machine });
        this.send(l, a.ok ? { t: 'answer', id: m.id, value: a.value } : { t: 'refused', id: m.id, reason: a.error });
        return;
      }
      case 'message': {
        const q = decodeRequest({ op: 'message', code, to: m.to, from: name, text: m.text }); // the socket's limits
        if (q.ok && q.value.op === 'message' && this.allow(l, 'message')) await rooms.handle(q.value);
        return;
      }
    }
  }

  /** The lines after the link's cursor (or the snapshot, then the lines after it), with plan text and documents. */
  private async subscribe(l: Live, seq: number, hash: string): Promise<void> {
    const { code } = l.link;
    if (!this.o.rooms.present(code)) { this.bye(l, 'host_away'); return; }
    l.stop?.();
    const f = await this.o.rooms.follow(code, seq, hash, {
      line: line => { this.lines(l, [line]); },
      doc: (key, doc) => { this.send(l, { t: 'put_doc', id: randomUUID(), key, doc }); },
    });
    if (!f.ok) { this.bye(l, 'closed'); return; }
    l.stop = f.value.stop;
    const { snapshot, lines, docs } = f.value.start;
    if (snapshot) this.send(l, { t: 'snapshot', snapshot }, ...snapshot.state.plans.flatMap(p => p.versions.map(x => this.blob(l, x.hash))));
    const all = [['presence', docs.presence], ['activity', docs.activity], ['focus', docs.focus]] as const;
    for (const [kind, list] of all) for (const d of list) this.send(l, { t: 'put_doc', id: randomUUID(), key: `${kind}/${d.name}`, doc: d });
    this.lines(l, lines);
  }

  /** Lines in order, each plan's text before its line. */
  private lines(l: Live, lines: readonly LogLine[]): void {
    this.send(l, ...lines.flatMap(x => (x.entry.kind === 'plan' ? [this.blob(l, x.entry.hash)] : [])), { t: 'lines', lines: [...lines] });
  }
  private blob(l: Live, hash: string): () => Promise<ToLink | null> {
    return async () => {
      const text = await this.o.rooms.blob(l.link.code, hash);
      return text === null ? null : { t: 'put_blob', id: randomUUID(), hash, text };
    };
  }

  /** Sends after everything queued before. */
  private send(l: Live, ...ms: Outgoing[]): void {
    l.out = l.out.then(async () => {
      for (const m of ms) {
        const x = typeof m === 'function' ? await m() : m;
        if (x) l.ch.send(Buffer.from(encode(x)));
      }
    }).catch(() => undefined);
  }
  private bye(l: Live, reason: ByeReason): void {
    if (l.closing) return;
    l.closing = true;
    l.stop?.();
    this.send(l, { t: 'bye', reason });
    l.out = l.out.then(() => { setTimeout(() => { l.ch.close(); }, BYE_MS).unref(); });
  }

  private allow(l: Live, op: Rated): boolean {
    const now = this.o.now(), w = l.used.get(op);
    if (!w || now - w.at >= 60_000) { l.used.set(op, { at: now, n: 1 }); return true; }
    return ++w.n <= (this.o.rates?.[op] ?? RATES[op]);
  }

  private awake(): void {
    if (this.live.size && !this.release) this.release = this.o.awake();
    else if (!this.live.size && this.release) { this.release(); this.release = null; }
  }

  private setInvite(id: string, st: InviteRecord['state']): Promise<void> {
    return this.save(s => ({ ...s, invites: s.invites.map(i => (i.id === id ? { ...i, state: st } : i)) }));
  }
  private save(f: (s: State) => State): Promise<void> {
    this.s = f(this.s);
    const text = JSON.stringify(this.s);
    this.saving = this.saving.then(() => writeAtomic(this.file, text)).catch(() => undefined);
    return this.saving;
  }
}

/** A source as its cap counts it: an IPv4 address, or an IPv6 one's /64, which one joiner holds whole. */
const perNet = (s: string): string => (s.includes(':') ? `${s.split(':').slice(0, 4).join(':')}::/64` : s);

function parseJson(text: string): unknown {
  try { const x: unknown = JSON.parse(text); return x; } catch { return null; }
}
