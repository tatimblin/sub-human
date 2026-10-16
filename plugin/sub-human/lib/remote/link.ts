/**
 * plugin/sub-human/lib/remote/link.ts: the link daemon, one per machine and room (`scripts/sub-human link CODE`,
 * started detached by the join hook: lib/remote/link-socket.ts start). It holds the one connection to the host
 * (lib/remote/client.ts over the link file's transport: lib/remote/link-connect.ts connectLink), keeps the mirror
 * (lib/room/store-mirror.ts applyLine / applySnapshot / applyDoc / applyBlob) line for line the host's log, prefetches
 * every proposal's plan, and serves the hooks of this machine on its unix socket (link-socket.ts listen). When to dial,
 * retry, ping, swap and stop is the pure state machine in lib/remote/link-engine.ts; this file runs its effects. It
 * never loads the signer.
 *
 *   run({code, log?}) -> Promise<reason>
 *       serveMirror over connectLink, until it stops; also stops LINK_IDLE_MS (SUB_HUMAN_LINK_IDLE_MS) after this machine
 *       has no seat left in the room (idleWatch, reason NO_SEAT), and on SIGTERM, SIGINT or SIGHUP. SIGUSR2 redials now,
 *       as a wake does.
 *   idleWatch(link, mirror, idleMs, {now?, gapMs?}) -> unwatch   stop the link once idleMs have passed with no seat of
 *       this machine in the room. Online, a seat is one the mirror's members document holds, not left, with a fresh
 *       lease or a live claude process of this machine (identity.localSeats: a lease that lapsed during a sleep or a
 *       pause is renewed by keepSeats, not given up); offline, the host's document is stale, so a seat is one a live
 *       claude process of this machine holds: a crashed or abandoned join never leaves a daemon retrying for ever. While
 *       the first connection is made it never stops, nor while the link file holds an invite younger than INVITE_TTL_MS
 *       (an sh2 join over ssh retries until the host admits its key). A tick more than gapMs (LINK_WAKE_GAP_MS) late is
 *       a sleep: it restarts the count and is skipped, so suspended time never counts as idle.
 *   serveMirror({mirror, connect, log?, retryMs?, retryMaxMs?, timings?, clock?, random?, mono?, netSignature?, watch?,
 *       seats?, writeState?, outbox?}) -> Promise<Link>
 *       Listen on socketPath(mirror.dir) (one daemon per socket: LOCK when another one answers there), then run the
 *       engine (link-engine.ts) from start, carrying out its effects:
 *         connect      connect() -> Promise<Client> (hello done)
 *         subscribe    {after: the mirror's last id, hash: that line's hash12; an empty mirror also asks snapshot: true of
 *                      a host whose caps offer it: the host's snapshot then arrives first (applySnapshot checks it; the
 *                      lines after it must chain to its head, else FORK), not every line}
 *         keepSeats    renew the lease of every live seat of this machine (seats(), default identity.localSeats: a
 *                      `beat`, so a seat whose lease lapsed on the host during an outage is back with no "left"/"joined"
 *                      lines; one the host shows as left is logged: the person joins again)
 *         flush        send the outbox, oldest first; a post the host already holds is PLACED_ALREADY (its nonce) and
 *                      counts as sent; one that waited longer than LINK_OUTBOX_AGE_MS or that the host refuses is
 *                      dropped and reported in the document `link` (flush)
 *         sendPing     the heartbeat, with a server whose caps list ping
 *         timers       on the injected clock (lib/clock.ts); wake (wakeWatch: a tick more than wakeGapMs late, or the
 *                      wall clock off the monotonic one by that much) and network changes (netWatch: netSignature, the
 *                      external addresses, changed) are redial events (watch: false turns both off)
 *       The stream goes into the mirror whichever connection carries it (a line it holds already, the same id and bytes,
 *       is skipped: two streams overlap during a swap); a proposal's plan is fetched once. A stream's end on the live
 *       connection is an event: closed (the room's Claude stopped) stops it (ROOM_CLOSED), moved redials the new host
 *       (or, this machine being the new host, waits for the accepting hook to stop it, HANDOFF_SELF_STOP_MS at most),
 *       anything else is lost (FORK: LOG_RESET, AUTH: LINK_REVOKED). A link stopped LINK_REVOKED, TOKEN_UNKNOWN or
 *       KEY_REVOKED drops its token from the link file (refused says why): a new invite line replaces it.
 *       A hook's op while not online is refused OFFLINE at once (before the first connection it waits for it), except an
 *       append marked {queue: true} (lib/room/store-mirror.ts, for an @room post) whose payload is outbox.queueable
 *       (lib/remote/outbox.ts): it is kept in the outbox and answered {queued: n}. Answers, consent, proposals and
 *       agents' posts are never queued. Online, every op is answered within relayMs (LINK_RELAY_MS, inside the hook's
 *       LINK_CALL_MS): a slow link's late answer must not turn into "nothing was sent", since the frame went out. Such a
 *       queueable post goes into the outbox under its nonce and is answered {queued: n, slow: true}; the host's late
 *       answer takes it out (placed, or PLACED_ALREADY), or drops and reports it (a refusal); a connection lost first
 *       leaves it for the next one. Any other op is OFFLINE UNKNOWN_OUTCOME: retrying it is safe (an answer is one per
 *       person per proposal, a join is a rejoin). FORK stops it and keeps the outbox (logged loudly: `sub-human link
 *       --reset CODE` re-mirrors); AUTH or PROTOCOL at hello, or the room closed, stop it too.
 *       Every change is written to the mirror's document `link` {pid, state, since, socket, reason?, code?, why?,
 *       queued?, flush?: {at, sent, unsent: [{text, why}]}, fields?: online, the entry fields the host's caps list} and
 *       to links/<code>.state.json (lib/room/links.ts LinkState, for doctor, the room row and the statusline: attempt,
 *       lastError, lastReason, rttMs, queued), both in the one vocabulary online | connecting | offline | fork | stopped
 *       (the state file says connecting while a redial of an offline link is under way: link-engine.ts shown).
 *       A planned handoff (lib/handoff.ts): the private 'handoff' event is kept for this machine's seat (onAsk); 'moved'
 *       re-points the link file at the new host (onMoved). The hello and every append carry the mirror's host epoch
 *       (STALE on a mismatch); a make-before-break redial says hello with the epoch the mirror holds at that moment.
 *       Link = {state() -> string, stop(why, reason?), wake(why?) -> Promise (the redial), done: Promise<reason>}
 *   ROOM_CLOSED_REASON, NO_SEAT_REASON   the words of a link stopped because the room closed or no seat of this machine
 *                                  is left (reasons ROOM_CLOSED, NO_SEAT): a dormant link, which doctor shows as info
 *   linkTimings(over?) -> {retryMs, retryMaxMs, pingMs, pongMs, deadMs, wakeTickMs, wakeGapMs, netPollMs, relayMs}
 *   nextDelay(prev, base, cap, random?) -> ms (link-engine.ts);  wakeWatch({onWake, tickMs, gapMs, clock?, mono?}) ->
 *   unwatch;  netWatch({onChange, pollMs, clock?, signature?}) -> unwatch;  netSignature(ifaces?) -> string
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as protocol from './protocol.ts';
import * as engine from './link-engine.ts';
import { socketPath, listen } from './link-socket.ts';
import { connectLink } from './link-connect.ts';
import { RoomError } from '../room/validate.ts';
import { reasonOf } from '../reasons.ts';
import { hash12 } from '../text.ts';
import * as config from '../config.ts';
import * as realClock from '../clock.ts';
import * as storeMod from '../room/store.ts';
import * as linksMod from '../room/links.ts';
import * as homeMod from '../home.ts';
import * as identityMod from '../identity.ts';
import * as membersMod from '../room/members.ts';
import { createRequire } from 'node:module';
import type { Reason } from '../reasons.ts';
import type { CodedError, LinkDoc, LinkTimings, MovedEventData, RunningLink, SignedPayload, StreamEvent, Flush } from './types-core.ts';
import type { Clock, TimerHandle } from '../clock.ts';
import type { Entry, Link } from '../room/types.ts';
import type { MirrorRoomStore } from '../room/store-mirror.ts';
import type { Client } from './client.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import type { EngineEvent, EngineState, Effect, Failure, TimerName } from './link-engine.ts';
import type net from 'node:net';

const require = createRequire(import.meta.url);

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

const HANDOFF_SELF_STOP_MS = 10_000;
const handoff = (): typeof import('../handoff.ts') => require('../handoff.ts');
const outboxMod = (): typeof import('./outbox.ts') => require('./outbox.ts');
/** Why a link stopped for good with nothing wrong (reasons ROOM_CLOSED, NO_SEAT): a dormant link. */
const ROOM_CLOSED_REASON = 'the room was closed';
const NO_SEAT_REASON = 'no seat of this machine is left in the room';
const nextDelay = engine.nextDelay;

/** The reasons a link's token never gets in again (kicked, or the host forgot it): the token goes from the link file. */
const SPENT: ReadonlySet<string> = new Set(['LINK_REVOKED', 'TOKEN_UNKNOWN', 'KEY_REVOKED']);
/** A link stopped as spent keeps no token: a new invite line for the room replaces it (lib/remote/joining.ts linkLine),
 * and `sub-human link CODE --forget` needs no --force. The refusal stays in the file for doctor. */
function dropToken(code: string, why: string, reason: Reason): void {
  try {
    const l = linksMod.get(code);
    if (!l || !l.token) return;
    const { token: _spent, ...rest } = l;
    linksMod.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: why, why: reason } });
  } catch { /* a link file that cannot be written: the next join line replaces it anyway */ }
}

// ---------- reconnect: timings, wake, network change ----------
/** Every timing the daemon uses, from lib/config.ts and the SUB_HUMAN_LINK_*_MS overrides tests and the lab use, then `over`. */
const linkTimings = (over: Partial<LinkTimings> = {}): LinkTimings => ({
  retryMs: config.envMs('SUB_HUMAN_LINK_RETRY_MS', config.LINK_RETRY_MS),
  retryMaxMs: config.envMs('SUB_HUMAN_LINK_RETRY_MAX_MS', config.LINK_RETRY_MAX_MS),
  pingMs: config.envMs('SUB_HUMAN_LINK_PING_MS', config.LINK_PING_MS),
  pongMs: config.envMs('SUB_HUMAN_LINK_PONG_MS', config.LINK_PONG_MS),
  deadMs: config.envMs('SUB_HUMAN_LINK_DEAD_MS', config.LINK_DEAD_MS),
  wakeTickMs: config.envMs('SUB_HUMAN_LINK_WAKE_TICK_MS', config.LINK_WAKE_TICK_MS),
  wakeGapMs: config.envMs('SUB_HUMAN_LINK_WAKE_GAP_MS', config.LINK_WAKE_GAP_MS),
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
    for (const a of list || []) if (a && !a.internal && !/^fe80:/i.test(a.address)) out.push(`${name}/${a.address}`);
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
  try { id = JSON.parse(line).id; } catch { return false; }
  return Number.isInteger(id) && (id as number) <= mirror.lastId() && mirror.lineHash(id as number) === hash12(line);
}
/** lib/room/rules.ts: its nonce is in the log, so an earlier try landed. */
const placedAlready = (e: unknown): boolean => reasonOf(e) === 'PLACED_ALREADY';
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const failure = (e: unknown): Failure => {
  const x = e as CodedError | null | undefined;
  return { code: (x && x.code) || null, reason: reasonOf(x), message: String((x && x.message) || x) };
};

async function serveMirror({
  mirror, connect, log = () => {}, retryMs, retryMaxMs, timings, clock = realClock, random = Math.random,
  mono, netSignature: netSig, watch = true, seats, writeState, outbox,
}: ServeMirrorOptions): Promise<RunningLink> {
  const T = linkTimings({ ...timings, retryMs, retryMaxMs });
  const sockFile = socketPath(mirror.dir);
  const box = outbox || outboxMod().open(mirror.dir);
  const localSeats = seats || (() => identityMod.localSeats(mirror.code));
  const saveState = writeState || (rec => linksMod.writeState(mirror.code, rec));
  let st: EngineState = engine.initial(clock.now(), T.retryMs);
  const conns = new Map<number, Client>(); // connection id (the engine's) -> its client
  const after = new Map<number, number>(); // a dial's id -> the mirror line it subscribed after (for its log line)
  const timers = new Map<TimerName, TimerHandle>();
  const dials = new Map<number, () => void>(); // a dial's id -> resolve its wake() promise once it ends
  const unwatch: (() => void)[] = [];
  let pub: string | null = null, pubSince: string | null = null, flushed: Flush | null = null, movedHere = false;
  let srv: net.Server | null = null, finish!: (why: string) => void, firstDone!: () => void;
  const done = new Promise<string>(resolve => { finish = resolve; });
  const first = new Promise<void>(resolve => { firstDone = resolve; });
  const iso = (ms: number) => new Date(ms).toISOString();
  const live = (): Client | null => (st.conn === null ? null : conns.get(st.conn) || null);

  /** The two records observers read: the mirror's document `link` (lib/tail.ts) and links/<code>.state.json. */
  function publish() {
    const c = live();
    const fields = st.phase === 'online' && c && typeof c.fields === 'function' ? c.fields() : [];
    const doc: LinkDoc = {
      pid: process.pid, state: st.phase, since: iso(st.since), socket: sockFile, ...(st.reason ? { reason: st.reason } : {}),
      ...(st.code ? { code: st.code } : {}), ...(st.why ? { why: st.why } : {}), ...(fields.length ? { fields } : {}),
      ...(box.size() ? { queued: box.size() } : {}), ...(flushed ? { flush: flushed } : {}),
    };
    try { mirror.kv.set('link', doc); } catch (e) { log(`status: ${(e as Error).message}`); }
    const p = engine.shown(st);
    if (p !== pub) { pub = p; pubSince = iso(clock.now()); }
    const rec = {
      state: p, since: pubSince, attempt: st.attempts, lastError: st.lastError, ...(st.lastReason ? { lastReason: st.lastReason } : {}),
      ...(st.code ? { lastCode: st.code } : {}), ...(st.prevError ? { prevError: st.prevError } : {}), rttMs: st.rttMs, queued: box.size(),
      pid: process.pid, detail: st.phase, at: iso(clock.now()),
    };
    try { saveState(rec); } catch (e) { log(`state: ${(e as Error).message}`); }
  }

  /** One event through the engine, then its effects, in order. */
  function dispatch(ev: EngineEvent) {
    const r = engine.step(st, ev, { timings: T, random, now: clock.now() });
    st = r.state;
    for (const fx of r.effects) effect(fx);
    if (st.phase !== 'connecting') firstDone();
    for (const [id, resolve] of dials) if (id !== st.dial) { dials.delete(id); resolve(); }
  }

  /** A dial step's outcome: the next step's event, or dialFailed (offline: the person's words for it). */
  const stepOf = (dial: number, p: Promise<unknown>, next: () => EngineEvent) => p.then(() => dispatch(next()), (e: unknown) => {
    const f = failure(e);
    dispatch({ type: 'dialFailed', dial, error: f, offline: handoff().whyOffline(mirror.code, f.message) });
  });

  function effect(fx: Effect) {
    switch (fx.type) {
      case 'connect':
        dials.set(fx.dial, dials.get(fx.dial) || (() => {}));
        stepOf(fx.dial, connect().then(c => { conns.set(fx.dial, c); }), () => ({ type: 'connected', dial: fx.dial }));
        break;
      case 'subscribe': {
        const c = conns.get(fx.dial)!; // connected: the client is in the map
        const from = mirror.lastId();
        after.set(fx.dial, from);
        // an empty mirror starts from the host's snapshot when the host offers one (caps), else from every line
        const snapshot = from === 0 && c.snapshots();
        stepOf(fx.dial, c.subscribe(from, mirror.lineHash(from), ev => onEvent(fx.dial, ev), { snapshot }).ready, () => ({ type: 'subscribed', dial: fx.dial }));
        break;
      }
      case 'keepSeats':
        stepOf(fx.dial, keepSeats(conns.get(fx.dial)!), () => ({ type: 'seated', dial: fx.dial }));
        break;
      case 'flush': {
        const c = conns.get(fx.dial)!;
        stepOf(fx.dial, flush(c), () => ({ type: 'flushed', dial: fx.dial, pings: typeof c.supports === 'function' && c.supports('ping') }));
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
        log(`FORK in room ${mirror.code}: ${fx.why}. Nothing more is synced${kept}; sub-human link --reset ${mirror.code} re-mirrors`);
        break;
      }
      case 'publish':
        publish();
        break;
      case 'log':
        log(fx.msg);
        break;
      case 'finish':
        if (st.lastReason && SPENT.has(st.lastReason)) dropToken(mirror.code, st.lastError || fx.why, st.lastReason);
        for (const u of unwatch.splice(0)) u();
        if (srv) srv.close();
        fs.rmSync(path.dirname(sockFile), { recursive: true, force: true });
        finish(fx.why);
        break;
    }
  }

  async function relay(op: string, params: RelayParams): Promise<unknown> {
    if (st.phase === 'connecting') await first;
    let p = params, queue: boolean | undefined = false;
    if (op === 'append' && p && p.queue) ({ queue, ...p } = p);
    const queueable = queue && outboxMod().queueable(p.payload);
    const id = st.conn, c = live();
    if (st.phase !== 'online' || id === null || !c) {
      if (queueable && !engine.forGood(st)) {
        const n = box.add(p.payload!, clock.now()); // queueable: a payload
        log(`offline: an @room post is queued (${n} waiting)`);
        publish();
        return { queued: n };
      }
      throw new RoomError(st.phase === 'fork' ? 'FORK' : 'OFFLINE', `the link is ${st.phase}${st.reason ? `: ${st.reason}` : ''}`, st.phase === 'fork' ? st.why : 'NOT_SENT');
    }
    const epoch = op === 'append' && typeof mirror.hostState === 'function' ? mirror.hostState().epoch : undefined;
    const sent = epoch === undefined ? p : { ...p, epoch };
    return queueable ? sendPost(id, c, sent) : answerBy(c.request(op, sent), op);
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
  function sendPost(id: number, c: Client, sent: RelayParams): Promise<unknown> {
    const payload = sent.payload!; // queueable: a signed post
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
      }, (e: CodedError) => {
        if (!slow) { clock.clearTimeout(t); reject(e); return; }
        if (placedAlready(e)) { if (box.remove(payload.nonce)) publish(); return; }
        if (e.code === 'OFFLINE' && (c.closed || id !== st.conn)) return; // kept: the next connection sends it again
        if (!box.remove(payload.nonce)) return;
        const why = e.code === 'OFFLINE' ? 'the host never answered' : e.message;
        flushed = { at: iso(clock.now()), sent: 0, unsent: [{ text: clip(String(payload.text || '')), why }] };
        log(`a slow @room post was not placed: ${why}`);
        publish();
      });
    });
  }

  /** Every proposal's plan a snapshot names (as each line's are fetched as it arrives). */
  function prefetchAll(c: Client, es: readonly Entry[]) { for (const e of es) prefetch(c, e); }
  function prefetch(c: Client, e: Entry) {
    if (e.kind !== 'proposal' || !e.hash) return;
    const ref = mirror.blobs.ref(e.path) || `plans/${e.hash}.md`;
    if (mirror.blobs.has(ref)) return;
    c.blobGet(ref).then(b => b && mirror.applyBlob(ref, b), (err: Error) => log(`plan ${ref}: ${err.message}`));
  }

  // A document this version does not stream (a newer host's) is skipped, not fatal: the mirror never takes it.
  function applyDoc(data: StreamEvent<'doc'>['data']) {
    if (!data || typeof data.key !== 'string') return log('skipped: a document with no key');
    try { mirror.applyDoc(data.key, data.value); } catch (e) {
      if ((e as CodedError).code !== 'PROTOCOL') throw e;
      log(`skipped: ${(e as Error).message}`);
    }
  }

  function onEvent(id: number, { ev, data }: StreamEvent) {
    if (engine.forGood(st)) return;
    const c = conns.get(id);
    try {
      if (ev === 'entry') { if (!held(mirror, data)) { const e = mirror.applyLine(data); if (c) prefetch(c, e); } }
      else if (ev === 'snapshot') { if (!heldHead(mirror, data)) { mirror.applySnapshot(data); if (c) prefetchAll(c, data.entries); } }
      else if (ev === 'doc') applyDoc(data);
      else if (ev === 'handoff') handoff().onAsk(mirror, data);
      else if (ev === 'moved') moved(data);
      else if (ev === 'end' && id === st.conn) {
        if (data.reason === 'closed') dispatch({ type: 'stop', phase: 'stopped', why: ROOM_CLOSED_REASON, reason: 'ROOM_CLOSED' });
        else if (data.reason === 'moved') { if (!movedHere) dispatch({ type: 'movedAway', conn: id }); } // the new host here: the accepting hook's reply is still to come
        else {
          const message = data.message ? String(data.message).slice(0, 200) : data.reason === 'FORK' ? 'the host log was reset' : 'the connection to the host closed';
          const reason: Reason | null = data.reason === 'FORK' ? 'LOG_RESET' : data.reason === 'AUTH' ? 'LINK_REVOKED' : null;
          dispatch({ type: 'lost', conn: id, error: { code: data.reason, reason, message }, offline: handoff().whyOffline(mirror.code, message) });
        }
      }
    } catch (err) {
      const e = err as CodedError;
      const fork = e.code === 'FORK';
      dispatch({ type: 'stop', phase: fork ? 'fork' : 'stopped', why: e.message, code: fork ? 'FORK' : null, reason: reasonOf(e) || (fork ? 'NOT_CHAINED' : null) });
    }
  }

  function moved(data: MovedEventData) {
    const r = handoff().onMoved(mirror, data);
    log(`moved: ${r.reason}`);
    if (r.self) {
      movedHere = true; // the accepting hook takes the room over, then stops this daemon; its reply is still to come
      setTimeout(() => dispatch({ type: 'stop', phase: 'stopped', why: r.reason }), HANDOFF_SELF_STOP_MS).unref();
    } else if (r.stop) dispatch({ type: 'stop', phase: 'stopped', why: r.reason });
  }

  /** This machine's live seats renew their lease on the host, so one that lapsed while the link was down is back,
   * quietly: a beat writes no log line (no "left", no "joined"); its pinned key and its link binding never changed. */
  async function keepSeats(c: Client) {
    let names: string[] = [];
    try { names = localSeats(); } catch (e) { log(`seats: ${(e as Error).message}`); }
    const { leaseFresh } = membersMod;
    for (const name of names) {
      const m = mirror.members.read()[name];
      try {
        const r = await c.beat(name);
        if (!r || !r.ok) log(`seat ${name} is not in room ${mirror.code} on the host any more; /sub-human ${name} ${mirror.code} joins again`);
        else if (m && !leaseFresh(m)) log(`seat ${name}: its lease had lapsed on the host; renewed`);
      } catch (e) {
        if ((e as CodedError).code === 'OFFLINE') throw e;
        log(`seat ${name}: ${(e as Error).message}`);
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
      } catch (err) {
        const e = err as CodedError;
        if (e.code === 'OFFLINE' || e.code === 'LOCK') { note(); throw e; }
        if (placedAlready(e)) sent++;
        else drop(x, e.message);
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
  gapMs = config.envMs('SUB_HUMAN_LINK_WAKE_GAP_MS', config.LINK_WAKE_GAP_MS),
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
    const young = !!l && now() - Date.parse(l.created_at ?? '') < config.INVITE_TTL_MS + config.ADMIT_TTL_MS;
    return young && ((!l!.token && typeof l!.invite === 'string') || (!!l!.token && typeof l!.join_as === 'string'));
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
  code: string; log?: (msg: string) => unknown;
}): Promise<string> {
  const store = storeMod;
  const opened = store.open(code);
  if (opened.isHost) throw new RoomError('INVALID', `this machine has no link to room ${code}`);
  const mirror = opened as MirrorRoomStore; // not the host: open() gave the room's mirror
  store.createRoom(code);
  const link = await serveMirror({ mirror, connect: () => connectLink(code), log });
  const unwatch = idleWatch(link, mirror, config.envMs('SUB_HUMAN_LINK_IDLE_MS', config.LINK_IDLE_MS));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => link.stop(`stopped by ${sig}`));
  process.on('SIGUSR2', () => link.wake('SIGUSR2'));
  const why = await link.done;
  unwatch();
  log(`stopped: ${why}`);
  return why;
}

export {
  run, serveMirror, idleWatch, linkTimings, nextDelay, wakeWatch, netWatch, netSignature, ROOM_CLOSED_REASON, NO_SEAT_REASON,
};
