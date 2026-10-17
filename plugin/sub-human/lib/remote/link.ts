/**
 * plugin/sub-human/lib/remote/link.ts: the link daemon, one per machine and room (`scripts/sub-human link CODE`,
 * started detached by the join hook: lib/remote/link-socket.ts start). It holds the one connection to the host
 * (lib/remote/client.ts over the link file's transport: lib/remote/link-connect.ts connectLink), keeps the mirror
 * (lib/room/store-mirror.ts applyLine / applySnapshot / applyDoc / applyBlob) line for line the host's log, prefetches
 * every proposal's plan, and serves the hooks of this machine on its unix socket (link-socket.ts listen). When to dial,
 * retry, ping, swap and stop is the pure state machine in lib/remote/link-engine.ts; this file runs its effects. It
 * never loads the signer.
 *
 * run stops on SIGTERM, SIGINT or SIGHUP (SIGUSR2 redials now, as a wake does), and LINK_IDLE_MS after this machine
 * has no seat left in the room (idleWatch, NO_SEAT). Online, a seat is one the mirror's members document holds, not
 * left, with a fresh lease or a live claude process here (a lease that lapsed during a sleep is renewed by keepSeats,
 * not given up); offline the host's document is stale, so only a live claude process counts: a crashed or abandoned
 * join never leaves a daemon retrying for ever. It never stops while connecting, nor while the link file holds an
 * invite or join_as younger than INVITE_TTL_MS + ADMIT_TTL_MS. A tick more than LINK_WAKE_GAP_MS late is a sleep:
 * suspended time never counts as idle.
 *
 * serveMirror listens on socketPath(mirror.dir) (one daemon per socket: LOCK when another answers there). An empty
 * mirror subscribes with snapshot: true (the lines after it must chain to its head, else FORK). The stream goes into
 * the mirror whichever connection carries it (a line held already, same id and bytes, is skipped: two streams overlap
 * during a swap). A stream's end on the live connection: closed stops it (ROOM_CLOSED), FORK (LOG_RESET) and AUTH
 * (LINK_REVOKED) stop it; FORK keeps the outbox (`sub-human link --forget CODE` sets the copy aside). A link
 * stopped LINK_REVOKED or TOKEN_UNKNOWN drops its token (dropToken).
 *
 * A hook's op while not online is OFFLINE at once (before the first connection it waits for it), except an @room
 * append marked {queue: true} that outbox.queueable accepts: it is kept in the outbox and answered {queued: n}.
 * Answers, consent, proposals and agents' posts are never queued. Online, every op is answered within relayMs (inside
 * the hook's LINK_CALL_MS; answerBy, sendPost); an op left OFFLINE UNKNOWN_OUTCOME is safe to retry (an answer is one
 * per person per proposal, a join is a rejoin).
 *
 * Every change is written to the mirror's document `link` and to links/<code>.state.json (lib/room/links.ts LinkState,
 * for doctor, the room row and the statusline), both in the one vocabulary online | connecting | offline | fork |
 * stopped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as protocol from './protocol.ts';
import * as engine from './link-engine.ts';
import { socketPath, listen } from './link-socket.ts';
import { connectLink } from './link-connect.ts';
import { RoomError } from '../room/validate.ts';
import { reasonOf, REVOKED } from '../reasons.ts';
import { hash12 } from '../text.ts';
import * as config from '../config.ts';
import { envMs } from '../env.ts';
import * as realClock from '../clock.ts';
import * as storeMod from '../room/store.ts';
import * as linksMod from '../room/links.ts';
import * as homeMod from '../home.ts';
import * as identityMod from '../identity.ts';
import * as membersMod from '../room/members.ts';
import type { Reason } from '../reasons.ts';
import type { LinkDoc, LinkTimings, RunningLink, SignedPayload, StreamEvent, Flush } from './types-core.ts';
import type { Clock, TimerHandle } from '../clock.ts';
import type { Entry, Link } from '../room/types.ts';
import type { MirrorRoomStore } from '../room/store-mirror.ts';
import type { Client } from './client.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import type { EngineEvent, EngineState, EngineEffect, Failure, TimerName } from './link-engine.ts';
import type net from 'node:net';
import { errCode, msgOf } from '../errors.ts';
import { assertNever } from '../../mod/core/never.ts';
import type { RoomCode } from '../brand.ts';
import type * as OutboxMod from './outbox.ts';
import { lazy } from '../io.ts';


/** One relayed op's params as a hook sends them: an append may carry {queue: true}. */
type RelayParams = { queue?: boolean; payload?: SignedPayload; [field: string]: unknown };
/** The link daemon's options (serveMirror). */
interface ServeMirrorOptions {
  mirror: MirrorRoomStore;
  connect: () => Promise<Client>;
  log?: (msg: string) => void;
  retryMs?: number;
  retryMaxMs?: number;
  timings?: Partial<LinkTimings>;
  clock?: Clock;
  random?: () => number;
  mono?: () => number;
  netSignature?: () => string;
  watch?: boolean;
  seats?: () => string[];
  writeState?: (rec: object) => void;
  outbox?: Outbox;
}

// the outbox only when the link daemon needs it (start cost)
const outboxMod = lazy<typeof OutboxMod>(import.meta.url, './outbox.ts');
/** Why a link stopped for good with nothing wrong (reasons ROOM_CLOSED, NO_SEAT): a dormant link. */
const ROOM_CLOSED_REASON = 'the room was closed';
const NO_SEAT_REASON = 'no seat of this machine is left in the room';
const nextDelay: (prev: number, base: number, cap: number, random?: () => number) => number = engine.nextDelay;

/** A link stopped as spent keeps no token: a new invite line for the room replaces it (lib/remote/joining.ts linkLine),
 * and `sub-human link CODE --forget` needs no --force. The refusal stays in the file for doctor. */
function dropToken(code: RoomCode, why: string, reason: Reason): void {
  try {
    const l = linksMod.get(code);
    if (!l || !l.token) return;
    const { token: _spent, ...rest } = l;
    linksMod.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: why, why: reason } });
  } catch { /* a link file that cannot be written: the next join line replaces it anyway */ }
}

// ---------- reconnect: timings, wake, network change ----------
/** Every timing the daemon uses, from lib/config.ts and the SUB_HUMAN_LINK_*_MS overrides tests and the lab use, then `over`. */
const linkTimings = (over: { [K in keyof LinkTimings]?: LinkTimings[K] | undefined } = {}): LinkTimings => ({
  retryMs: envMs('SUB_HUMAN_LINK_RETRY_MS'),
  retryMaxMs: envMs('SUB_HUMAN_LINK_RETRY_MAX_MS'),
  pingMs: envMs('SUB_HUMAN_LINK_PING_MS'),
  pongMs: envMs('SUB_HUMAN_LINK_PONG_MS'),
  deadMs: envMs('SUB_HUMAN_LINK_DEAD_MS'),
  wakeTickMs: envMs('SUB_HUMAN_LINK_WAKE_TICK_MS'),
  wakeGapMs: envMs('SUB_HUMAN_LINK_WAKE_GAP_MS'),
  netPollMs: config.LINK_NET_POLL_MS,
  relayMs: config.LINK_RELAY_MS,
  ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)),
});

/**
 * Call onWake(gapMs) when a timer ticking every tickMs finds the wall clock moved more than gapMs past the tick, or
 * away from the monotonic clock (which does not count a sleep): the machine slept, or its clock jumped.
 */
function wakeWatch({ onWake, tickMs, gapMs, clock = realClock, mono = () => performance.now() }: {
  onWake: (gapMs: number) => void; tickMs: number; gapMs: number; clock?: Clock; mono?: () => number;
}): () => void {
  let wall = clock.now(), m = mono();
  const t = clock.setInterval(() => {
    const w = clock.now(), mm = mono();
    const late = w - wall - tickMs, drift = Math.abs((w - wall) - (mm - m));
    wall = w;
    m = mm;
    if (late > gapMs || drift > gapMs) onWake(Math.round(Math.max(late, drift)));
  }, tickMs);
  if (t && t.unref) t.unref();
  return () => clock.clearInterval(t);
}

/** This machine's external addresses (not loopback, not IPv6 link-local), as one comparable string. */
function netSignature(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list ?? []) if (a && !a.internal && !/^fe80:/i.test(a.address)) out.push(`${name}/${a.address}`);
  }
  return out.sort().join(',');
}

/** Call onChange() when signature() differs from the last poll's (an address came, went or moved). */
function netWatch({ onChange, pollMs, clock = realClock, signature = netSignature }: {
  onChange: () => void; pollMs: number; clock?: Clock; signature?: () => string;
}): () => void {
  let last: string;
  try { last = signature(); } catch { last = ''; }
  const t = clock.setInterval(() => {
    let now: string;
    try { now = signature(); } catch { return; }
    if (now !== last) { last = now; onChange(); }
  }, pollMs);
  if (t && t.unref) t.unref();
  return () => clock.clearInterval(t);
}

/** A snapshot whose head the mirror holds already (two first syncs overlapped while a link was swapped). */
function heldHead(mirror: MirrorRoomStore, snap: { id?: unknown; hash?: unknown } | null): boolean {
  return !!snap && Number.isInteger(snap.id) && (snap.id as number) <= mirror.lastId() && mirror.lineHash(snap.id as number) === snap.hash;
}
/** A host line the mirror holds already (the same id and bytes): two streams overlap while a link is swapped. */
function held(mirror: MirrorRoomStore, line: string): boolean {
  let id: unknown;
  try { const v: unknown = JSON.parse(line); id = v && typeof v === 'object' && 'id' in v ? v.id : undefined; } catch { return false; }
  return Number.isInteger(id) && (id as number) <= mirror.lastId() && mirror.lineHash(id as number) === hash12(line);
}
/** lib/room/rules.ts: its nonce is in the log, so an earlier try landed. */
const placedAlready = (e: unknown): boolean => reasonOf(e) === 'PLACED_ALREADY';
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const failure = (e: unknown): Failure => {
  return { code: errCode(e) || null, reason: reasonOf(e), message: msgOf(e) || String(e) };
};

async function serveMirror({
  mirror, connect, log = () => {}, retryMs, retryMaxMs, timings, clock = realClock, random = Math.random,
  mono, netSignature: netSig, watch = true, seats, writeState, outbox,
}: ServeMirrorOptions): Promise<RunningLink> {
  const T = linkTimings({ ...timings, retryMs, retryMaxMs });
  const sockFile = socketPath(mirror.dir);
  const box = outbox ?? outboxMod().open(mirror.dir);
  const localSeats = seats ?? (() => identityMod.localSeats(mirror.code));
  const saveState = writeState ?? (rec => linksMod.writeState(mirror.code, rec));
  let st: EngineState = engine.initial(clock.now(), T.retryMs);
  const conns = new Map<number, Client>(); // connection id (the engine's) -> its client
  const after = new Map<number, number>(); // a dial's id -> the mirror line it subscribed after (for its log line)
  const timers = new Map<TimerName, TimerHandle>();
  const dials = new Map<number, () => void>(); // a dial's id -> resolve its wake() promise once it ends
  const unwatch: (() => void)[] = [];
  let flushed: Flush | null = null;
  let srv: net.Server | null = null;
  const { promise: done, resolve: finish } = Promise.withResolvers<string>();
  const { promise: first, resolve: firstDone } = Promise.withResolvers<void>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const live = (): Client | null => (st.conn === null ? null : conns.get(st.conn) ?? null);

  /** The two records observers read: the mirror's document `link` (lib/tail.ts) and links/<code>.state.json. */
  function publish() {
    const doc: LinkDoc = {
      pid: process.pid, state: st.phase, since: iso(st.since), socket: sockFile, ...(st.reason ? { reason: st.reason } : {}),
      ...(st.code ? { code: st.code } : {}), ...(st.why ? { why: st.why } : {}),
      ...(box.size() ? { queued: box.size() } : {}), ...(flushed ? { flush: flushed } : {}),
    };
    try { mirror.kv.set('link', doc); } catch (e) { log(`status: ${msgOf(e)}`); }
    // since: the engine's, kept across failed dials, so an offline link's time counts from when it was last online
    const rec = {
      state: engine.shown(st), since: iso(st.since), attempt: st.attempts, lastError: st.lastError, ...(st.lastReason ? { lastReason: st.lastReason } : {}),
      ...(st.code ? { lastCode: st.code } : {}), ...(st.prevError ? { prevError: st.prevError } : {}), rttMs: st.rttMs, queued: box.size(),
      pid: process.pid, detail: st.phase, at: iso(clock.now()),
    };
    try { saveState(rec); } catch (e) { log(`state: ${msgOf(e)}`); }
  }

  /** One event through the engine, then its effects, in order. */
  function dispatch(ev: EngineEvent) {
    const r = engine.step(st, ev, { timings: T, random, now: clock.now() });
    st = r.state;
    for (const fx of r.effects) effect(fx);
    if (st.phase !== 'connecting') firstDone();
    for (const [id, resolve] of dials) if (id !== st.dial) { dials.delete(id); resolve(); }
  }

  /** A dial step's outcome: the next step's event, or dialFailed. */
  // each step ends in an engine event, its failure too (void: nothing else waits on it)
  const stepOf = (dial: number, p: Promise<unknown>, next: () => EngineEvent): void => void p.then(() => dispatch(next()), (e: unknown) => {
    dispatch({ type: 'dialFailed', dial, error: failure(e) });
  });

  /** A dial's client: the engine asks for one only once it connected (the client is in the map). */
  const connOf = (dial: number): Client => {
    const c = conns.get(dial);
    if (!c) throw new Error(`the link engine asked for dial ${dial}, which has no client`);
    return c;
  };

  function effect(fx: EngineEffect) {
    switch (fx.type) {
      case 'connect':
        dials.set(fx.dial, dials.get(fx.dial) ?? (() => {}));
        stepOf(fx.dial, connect().then(c => { conns.set(fx.dial, c); }), () => ({ type: 'connected', dial: fx.dial }));
        break;
      case 'subscribe': {
        const c = connOf(fx.dial);
        const from = mirror.lastId();
        after.set(fx.dial, from);
        // an empty mirror starts from the host's snapshot when the host offers one (caps), else from every line
        const snapshot = from === 0 && c.snapshots();
        stepOf(fx.dial, c.subscribe(from, mirror.lineHash(from), ev => onEvent(fx.dial, ev), { snapshot }).ready, () => ({ type: 'subscribed', dial: fx.dial }));
        break;
      }
      case 'keepSeats':
        stepOf(fx.dial, keepSeats(connOf(fx.dial)), () => ({ type: 'seated', dial: fx.dial }));
        break;
      case 'flush': {
        const c = connOf(fx.dial);
        stepOf(fx.dial, flush(c), () => ({ type: 'flushed', dial: fx.dial }));
        break;
      }
      case 'close': {
        const c = conns.get(fx.conn);
        conns.delete(fx.conn);
        after.delete(fx.conn);
        if (c) c.close();
        break;
      }
      case 'retire': { // close a replaced connection once the ops in flight on it are answered
        const c = conns.get(fx.conn);
        conns.delete(fx.conn);
        after.delete(fx.conn);
        if (c) (typeof c.drain === 'function' ? c.drain() : Promise.resolve()).then(() => c.close(), () => c.close());
        break;
      }
      case 'sendPing': {
        const c = conns.get(fx.conn);
        if (!c) break;
        c.ping(fx.ms).then(r => dispatch({ type: 'pong', conn: fx.conn, rttMs: r.rttMs }), () => dispatch({ type: 'noPong', conn: fx.conn }));
        break;
      }
      case 'setTimer': {
        clock.clearTimeout(timers.get(fx.name));
        timers.set(fx.name, clock.setTimeout(() => { timers.delete(fx.name); dispatch({ type: 'timer', name: fx.name }); }, fx.ms));
        break;
      }
      case 'clearTimer':
        clock.clearTimeout(timers.get(fx.name));
        timers.delete(fx.name);
        break;
      case 'online':
        log(`online: subscribed after line ${after.get(fx.conn) ?? mirror.lastId()}${fx.old !== null ? '; swapped in, the old connection is closed' : ''}`);
        break;
      case 'forked': {
        const kept = box.size() ? `; ${box.size()} queued @room post(s) are kept, not sent` : '';
        log(`FORK in room ${mirror.code}: ${fx.why}. Nothing more is synced${kept}; sub-human link --forget ${mirror.code} sets this copy aside (then join with a new invite)`);
        break;
      }
      case 'publish':
        publish();
        break;
      case 'log':
        log(fx.msg);
        break;
      case 'finish':
        if (st.lastReason && REVOKED.has(st.lastReason)) dropToken(mirror.code, st.lastError || fx.why, st.lastReason);
        for (const u of unwatch.splice(0)) u();
        if (srv) srv.close();
        fs.rmSync(path.dirname(sockFile), { recursive: true, force: true });
        finish(fx.why);
        break;
      default: assertNever(fx, 'link effect');
    }
  }

  async function relay(op: string, params: RelayParams): Promise<unknown> {
    if (st.phase === 'connecting') await first;
    let p = params, queue: boolean | undefined = false;
    if (op === 'append' && p && p.queue) ({ queue, ...p } = p);
    const post = queue && outboxMod().queueable(p.payload) ? p.payload : null; // an @room post the outbox may keep
    const id = st.conn, c = live();
    if (st.phase !== 'online' || id === null || !c) {
      if (post && !engine.forGood(st)) {
        const n = box.add(post, clock.now());
        log(`offline: an @room post is queued (${n} waiting)`);
        publish();
        return { queued: n };
      }
      throw new RoomError(st.phase === 'fork' ? 'FORK' : 'OFFLINE', `the link is ${st.phase}${st.reason ? `: ${st.reason}` : ''}`, st.phase === 'fork' ? st.why : 'NOT_SENT');
    }
    return post ? sendPost(id, c, p, post) : answerBy(c.request(op, p), op);
  }

  /** The hook gives up at LINK_CALL_MS, so the daemon answers first (relayMs): an op the host has not answered by
   * then went out and may still land (a slow link), so it is OFFLINE UNKNOWN_OUTCOME, never "not sent". */
  function answerBy(req: Promise<unknown>, op: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = clock.setTimeout(() => reject(new RoomError('OFFLINE',
        `${op}: no answer from the host within ${T.relayMs} ms (a slow link); ${protocol.UNKNOWN_OUTCOME}`, 'UNKNOWN_OUTCOME')), T.relayMs);
      req.then(r => { clock.clearTimeout(t); resolve(r); }, e => { clock.clearTimeout(t); reject(e); });
    });
  }

  /**
   * A person's signed @room post, online. Answered by relayMs, it is the host's answer. Not answered by then, it is in
   * flight: it goes into the outbox under its nonce and the hook hears {queued, slow: true} ("⧗ sending"), never "not
   * sent". The host's late answer settles it: placed (or PLACED_ALREADY) leaves the outbox, and the late copy IS the
   * post; a refusal is dropped and reported (document `link` flush). A connection that closes first leaves it queued:
   * the next connection sends it again, and the host's nonce check makes that a no-op when the first copy landed.
   */
  function sendPost(id: number, c: Client, sent: RelayParams, payload: SignedPayload): Promise<unknown> {
    const req = c.request('append', sent, { ms: box.ageMs || config.LINK_OUTBOX_AGE_MS });
    return new Promise((resolve, reject) => {
      let slow = false;
      const t = clock.setTimeout(() => {
        slow = true;
        const n = box.add(payload, clock.now(), { force: true });
        log(`slow link: an @room post has no answer within ${T.relayMs} ms; it stays in the outbox under its nonce until the host answers`);
        publish();
        resolve({ queued: n, slow: true });
      }, T.relayMs);
      req.then(r => {
        if (!slow) { clock.clearTimeout(t); resolve(r); return; }
        if (box.remove(payload.nonce)) { log('slow link: the @room post that was in flight landed'); publish(); }
      }, (e: unknown) => {
        if (!slow) { clock.clearTimeout(t); reject(e); return; }
        if (placedAlready(e)) { if (box.remove(payload.nonce)) publish(); return; }
        if (errCode(e) === 'OFFLINE' && (c.closed || id !== st.conn)) return; // kept: the next connection sends it again
        if (!box.remove(payload.nonce)) return;
        const why = errCode(e) === 'OFFLINE' ? 'the host never answered' : msgOf(e);
        flushed = { at: iso(clock.now()), sent: 0, unsent: [{ text: clip(String(payload.text || '')), why }] };
        log(`a slow @room post was not placed: ${why}`);
        publish();
      });
    });
  }

  /** Every proposal's and plan version's text a snapshot names (as each line's are fetched as it arrives). */
  function prefetchAll(c: Client, es: readonly Readonly<Entry>[]) { for (const e of es) prefetch(c, e); }
  function prefetch(c: Client, e: Entry) {
    if ((e.kind !== 'proposal' && e.kind !== 'plan') || !e.hash) return;
    const ref = mirror.blobs.ref(e.path) || `plans/${e.hash}.md`;
    if (mirror.blobs.has(ref)) return;
    c.blobGet(ref).then(b => b && mirror.applyBlob(ref, b), (err: unknown) => log(`plan ${ref}: ${msgOf(err)}`));
  }

  // A document this version does not stream (a newer host's) is skipped, not fatal: the mirror never takes it.
  function applyDoc(data: StreamEvent<'doc'>['data']) {
    if (!data || typeof data.key !== 'string') return log('skipped: a document with no key');
    try { mirror.applyDoc(data.key, data.value); } catch (e) {
      if (errCode(e) !== 'PROTOCOL') throw e;
      log(`skipped: ${msgOf(e)}`);
    }
  }

  function onEvent(id: number, { ev, data }: StreamEvent) {
    if (engine.forGood(st)) return;
    const c = conns.get(id);
    try {
      // ev is one of protocol.EVENTS: the client hands on no other (client.ts isEvent)
      switch (ev) {
        case 'entry': if (!held(mirror, data)) { const e = mirror.applyLine(data); if (c) prefetch(c, e); } break;
        case 'snapshot': if (!heldHead(mirror, data)) { mirror.applySnapshot(data); if (c) prefetchAll(c, data.entries); } break;
        case 'doc': applyDoc(data); break;
        case 'end':
          if (id !== st.conn) break;
          if (data.reason === 'closed') {
            try { storeMod.unindexRooms([mirror.code]); } catch { /* the next look at the open rooms drops it */ } // closed: no open room here (stage 8e I.1)
            dispatch({ type: 'stop', phase: 'stopped', why: ROOM_CLOSED_REASON, reason: 'ROOM_CLOSED' });
          }
          else {
            const message = data.message ? String(data.message).slice(0, 200) : data.reason === 'FORK' ? 'the host log was reset' : 'the connection to the host closed';
            const reason: Reason | null = data.reason === 'FORK' ? 'LOG_RESET' : data.reason === 'AUTH' ? 'LINK_REVOKED' : null;
            dispatch({ type: 'lost', conn: id, error: { code: data.reason, reason, message } });
          }
          break;
        default: assertNever(ev, 'stream event');
      }
    } catch (e) {
      const fork = errCode(e) === 'FORK';
      dispatch({ type: 'stop', phase: fork ? 'fork' : 'stopped', why: msgOf(e), code: fork ? 'FORK' : null, reason: reasonOf(e) || (fork ? 'NOT_CHAINED' : null) });
    }
  }

  /** This machine's live seats renew their lease on the host, so one that lapsed while the link was down is back,
   * quietly: a beat writes no log line (no "left", no "joined"); its pinned key and its link binding never changed. */
  async function keepSeats(c: Client) {
    let names: string[] = [];
    try { names = localSeats(); } catch (e) { log(`seats: ${msgOf(e)}`); }
    const { leaseFresh } = membersMod;
    for (const name of names) {
      const m = mirror.members.read()[name];
      try {
        const r = await c.beat(name);
        if (!r || !r.ok) log(`seat ${name} is not in room ${mirror.code} on the host any more; /sub-human ${name} ${mirror.code} joins again`);
        else if (m && !leaseFresh(m)) log(`seat ${name}: its lease had lapsed on the host; renewed`);
      } catch (e) {
        if (errCode(e) === 'OFFLINE') throw e;
        log(`seat ${name}: ${msgOf(e)}`);
      }
    }
  }

  /** Send the queued @room posts on c, oldest first (c subscribed: the mirror is the host's prefix). A post the host
   * already holds (an earlier try landed) is PLACED_ALREADY by its nonce: done. OFFLINE keeps the rest. */
  async function flush(c: Client) {
    let sent = 0;
    const unsent: Flush['unsent'] = [];
    const note = () => { if (sent || unsent.length) flushed = { at: iso(clock.now()), sent, unsent }; };
    const drop = (x: OutboxItem, why: string) => { unsent.push({ text: clip(String(x.payload.text || '')), why }); log(`a queued @room post was not sent: ${why}`); };
    for (;;) {
      for (const x of box.expire(clock.now())) drop(x, 'it waited too long (the host refuses a signature that old)');
      const x = box.first();
      if (!x) break;
      try {
        await c.append(x.payload);
        sent++;
      } catch (e) {
        if (errCode(e) === 'OFFLINE' || errCode(e) === 'LOCK') { note(); throw e; }
        if (placedAlready(e)) sent++;
        else drop(x, msgOf(e));
      }
      box.remove(x.payload.nonce); // by nonce: a slow post's late answer may have taken it out meanwhile
    }
    note();
    if (sent || unsent.length) log(`outbox: ${sent} queued @room post(s) sent${unsent.length ? `, ${unsent.length} not sent` : ''}`);
  }

  srv = await listen(sockFile, relay);
  dispatch({ type: 'start' });
  if (watch) {
    unwatch.push(wakeWatch({ onWake: gap => dispatch({ type: 'redial', why: `woke from sleep (the clock jumped ${gap} ms)` }), tickMs: T.wakeTickMs, gapMs: T.wakeGapMs, clock, ...(mono ? { mono } : {}) }));
    if (T.netPollMs > 0) unwatch.push(netWatch({ onChange: () => dispatch({ type: 'redial', why: 'the network changed' }), pollMs: T.netPollMs, clock, ...(netSig ? { signature: netSig } : {}) }));
  }
  /** Redial now (a wake, a signal): resolves once that dial ends. */
  const wake = (why = 'asked'): Promise<void> => {
    dispatch({ type: 'redial', why });
    const d = st.dial;
    if (d === null) return Promise.resolve();
    return new Promise<void>(resolve => {
      const prev = dials.get(d);
      dials.set(d, () => { if (prev) prev(); resolve(); });
    });
  };
  return {
    state: () => st.phase,
    stop: (why: string, reason?: Reason) => dispatch({ type: 'stop', phase: 'stopped', why, reason: reason ?? null }),
    wake,
    done,
  };
}

function idleWatch(link: RunningLink, mirror: MirrorRoomStore, idleMs: number, {
  now = Date.now,
  gapMs = envMs('SUB_HUMAN_LINK_WAKE_GAP_MS'),
}: { now?: () => number; gapMs?: number } = {}): () => void {
  const { isMine } = homeMod;
  const { leaseFresh } = membersMod;
  const identity = identityMod;
  // a seat the host shows (not left) whose lease is fresh, or that a live claude process here holds: a lease that
  // lapsed while this machine slept is keepSeats' to renew on the next connection, not a reason to stop
  const held = () => {
    let live: string[] | null = null;
    return Object.values(mirror.members.read()).some(m => m && isMine(m.machine) && !m.left_at
      && (leaseFresh(m) || (live ??= identity.localSeats(mirror.code)).includes(m.name)));
  };
  // an invite not redeemed yet (waiting for the host person's card): kept trying for the invite's life and the card's
  // and a join the host let in whose person has not typed /sub-human yet (join_as): kept for as long too, so a
  // let-in machine's link does not stop NO_SEAT a minute later
  const redeeming = () => {
    const l: Link | null = linksMod.get(mirror.code);
    if (!l) return false;
    const young = now() - Date.parse(l.created_at ?? '') < config.INVITE_TTL_MS + config.ADMIT_TTL_MS;
    return young && ((!l.token && typeof l.invite === 'string') || (!!l.token && typeof l.join_as === 'string'));
  };
  const seated = () => {
    const s = link.state();
    return s === 'connecting' || redeeming() || (s === 'online' ? held() : identity.localSeats(mirror.code).length > 0);
  };
  const tickMs = Math.min(1000, idleMs);
  let since = now(), lastTick = since;
  const t = setInterval(() => {
    const at = now(), late = at - lastTick - tickMs;
    lastTick = at;
    if (late > gapMs) since = at; // the machine slept (or the process was stopped): that time is not idle
    else if (seated()) since = at;
    else if (at - since >= idleMs) link.stop(NO_SEAT_REASON, 'NO_SEAT');
  }, tickMs);
  return () => clearInterval(t);
}

async function run({ code, log = msg => process.stderr.write(`${new Date().toISOString()} sub-human link ${code}: ${msg}\n`) }: {
  code: RoomCode; log?: (msg: string) => unknown;
}): Promise<string> {
  const store = storeMod;
  const opened = store.open(code);
  if (opened.isHost) throw new RoomError('INVALID', `this machine has no link to room ${code}`);
  const mirror = opened as MirrorRoomStore; // not the host: open() gave the room's mirror
  store.createRoom(code);
  const link = await serveMirror({ mirror, connect: () => connectLink(code), log });
  const unwatch = idleWatch(link, mirror, envMs('SUB_HUMAN_LINK_IDLE_MS'));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => link.stop(`stopped by ${sig}`));
  process.on('SIGUSR2', () => { void link.wake('SIGUSR2'); }); // the redial reports through the engine
  const why = await link.done;
  unwatch();
  log(`stopped: ${why}`);
  return why;
}

export {
  run, serveMirror, idleWatch, linkTimings, nextDelay, wakeWatch, netWatch, netSignature, ROOM_CLOSED_REASON, NO_SEAT_REASON,
};
