/**
 * core/link-engine.ts: a mirror's connection to its host as a pure state machine (R32, R34, R36). step(state, event,
 * now) returns the next state and the effects net/link.ts then runs; time comes in with every event and the jitter
 * from a seed kept in the state, so a table test drives every path on a fake clock.
 *
 * One connection at a time, each an id: dial -> connected (channel up, hellos agreed) -> subscribe -> synced -> online,
 * where flush re-sends the member's documents and every post not yet acked. A failure goes offline and retries after a
 * jittered backoff; bye host_away goes host_away and keeps retrying; kicked, refused and skew stop for good. A ping
 * every pingMs; no pong within pongMs is a dead, half-open connection. tick every tickMs: a gap or a backwards jump is
 * sleep or a clock change, and like a network change it checks now: a ping when online, else a dial now, dropping a
 * dial or a sync under way, which may never finish. A dial not synced within dialMs is dropped too.
 * A fork resubscribes from scratch, and the posts still queued are re-sent under their client ids. A post waits for
 * its ack at most postTtlMs, then is dropped and named in an expired effect.
 */
import type { ByeReason } from './protocol.js';

export interface Timings {
  retryMs: number; retryMaxMs: number; dialMs: number; pingMs: number; pongMs: number; tickMs: number; postTtlMs: number;
}
export type Phase = 'connecting' | 'online' | 'offline' | 'host_away' | 'stopped';
export type Timer = 'retry' | 'dial' | 'ping' | 'pong';

export interface LinkState {
  readonly timings: Timings;
  readonly phase: Phase;
  /** why it is offline or stopped, for people */
  readonly why: string | null;
  /** when the phase last changed */
  readonly since: number;
  readonly conn: number | null;
  readonly synced: boolean;
  readonly next: number;
  readonly delay: number;
  readonly seed: number;
  readonly lastTick: number;
  readonly retrying: boolean;
  /** posts sent or waiting, not yet acked, oldest first */
  readonly queue: readonly { id: string; at: number }[];
}

export type LinkEvent =
  | { type: 'start' }
  | { type: 'connected' | 'synced' | 'pong' | 'fork'; conn: number }
  | { type: 'failed'; conn: number; why: string }
  | { type: 'bye'; conn: number; reason: ByeReason }
  | { type: 'timer'; name: Timer }
  | { type: 'tick' }
  | { type: 'network' }
  | { type: 'post' | 'acked'; id: string }
  | { type: 'stop'; why: string };

export type LinkEffect =
  | { type: 'dial' | 'close' | 'ping'; conn: number }
  | { type: 'subscribe'; conn: number; fresh: boolean }
  | { type: 'flush'; conn: number; posts: string[] }
  | { type: 'send'; conn: number; id: string }
  | { type: 'setTimer'; name: Timer; ms: number }
  | { type: 'clearTimer'; name: Timer }
  | { type: 'expired'; ids: string[] }
  | { type: 'status'; phase: Phase; why: string | null }
  | { type: 'finish'; why: string };

const BYE: Readonly<Record<ByeReason, string>> = {
  kicked: 'the host removed you from this room',
  refused: 'the host did not let this machine in',
  skew: 'the host and this machine run different sub-human versions',
  host_away: 'host away',
  closed: 'the host closed the connection',
};

/** A pure PRNG step (mulberry32): the next seed and a draw in [0, 1). */
function draw(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [s, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

/** Decorrelated jitter: a draw in [base, 3 × prev], at most cap. */
export const backoff = (prev: number, base: number, cap: number, r: number): number =>
  Math.round(Math.min(cap, base + r * (Math.max(base, prev * 3) - base)));

export function initial(timings: Timings, now: number, seed: number): LinkState {
  return {
    timings, phase: 'connecting', why: null, since: now, conn: null, synced: false, next: 1, delay: timings.retryMs,
    seed, lastTick: now, retrying: false, queue: [],
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function step(state: LinkState, event: LinkEvent, now: number): { state: LinkState; effects: LinkEffect[] } {
  const s: Mutable<LinkState> = { ...state };
  const fx: LinkEffect[] = [];
  const T = s.timings;
  const live = (conn: number): boolean => conn === s.conn && s.phase !== 'stopped';

  const enter = (phase: Phase, why: string | null): void => {
    if (phase !== s.phase) s.since = now;
    s.phase = phase;
    s.why = why;
    fx.push({ type: 'status', phase, why });
  };
  const clear = (...names: Timer[]): void => {
    for (const name of names) fx.push({ type: 'clearTimer', name });
    if (names.includes('retry')) s.retrying = false;
  };
  const dial = (): void => {
    if (s.phase === 'stopped' || s.conn !== null) return;
    if (s.retrying) clear('retry');
    s.conn = s.next++;
    s.synced = false;
    fx.push({ type: 'dial', conn: s.conn }, { type: 'setTimer', name: 'dial', ms: T.dialMs });
  };
  /** Drop the connection, if any, and retry after the backoff; a host away stays away until a dial gets through. */
  const drop = (why: string, away = s.phase === 'host_away'): void => {
    if (s.conn !== null) fx.push({ type: 'close', conn: s.conn });
    s.conn = null;
    s.synced = false;
    clear('dial', 'ping', 'pong');
    enter(away ? 'host_away' : 'offline', away ? BYE.host_away : why);
    if (s.retrying) return;
    const [seed, r] = draw(s.seed);
    s.seed = seed;
    s.delay = backoff(s.delay, T.retryMs, T.retryMaxMs, r);
    s.retrying = true;
    fx.push({ type: 'setTimer', name: 'retry', ms: s.delay });
  };
  const stop = (why: string): void => {
    if (s.phase === 'stopped') return;
    if (s.conn !== null) fx.push({ type: 'close', conn: s.conn });
    s.conn = null;
    clear('retry', 'dial', 'ping', 'pong');
    enter('stopped', why);
    fx.push({ type: 'finish', why });
  };
  /** Is it still there? Online: a ping now. Otherwise a dial now, the backoff reset. */
  const check = (): void => {
    if (s.phase === 'stopped') return;
    if (s.conn !== null && s.synced) return ping(s.conn);
    if (s.conn !== null) drop('the connection stalled');
    s.delay = T.retryMs;
    dial();
  };
  const ping = (conn: number): void => {
    clear('ping');
    fx.push({ type: 'ping', conn }, { type: 'setTimer', name: 'pong', ms: T.pongMs });
  };
  const expire = (): void => {
    const old = s.queue.filter(p => now - p.at >= T.postTtlMs);
    if (!old.length) return;
    s.queue = s.queue.filter(p => now - p.at < T.postTtlMs);
    fx.push({ type: 'expired', ids: old.map(p => p.id) });
  };

  switch (event.type) {
    case 'start':
      if (s.phase === 'stopped') break;
      enter('connecting', null);
      dial();
      break;
    case 'connected':
      if (live(event.conn)) fx.push({ type: 'subscribe', conn: event.conn, fresh: false });
      break;
    case 'synced':
      if (!live(event.conn)) break;
      s.synced = true;
      clear('dial');
      s.delay = T.retryMs;
      enter('online', null);
      fx.push({ type: 'flush', conn: event.conn, posts: s.queue.map(p => p.id) });
      if (T.pingMs > 0) fx.push({ type: 'setTimer', name: 'ping', ms: T.pingMs });
      break;
    case 'fork':
      if (!live(event.conn)) break;
      s.synced = false;
      fx.push({ type: 'subscribe', conn: event.conn, fresh: true }, { type: 'setTimer', name: 'dial', ms: T.dialMs });
      break;
    case 'failed':
      if (live(event.conn)) drop(event.why);
      break;
    case 'bye':
      if (!live(event.conn)) break;
      if (event.reason === 'host_away') drop(BYE.host_away, true);
      else if (event.reason === 'closed') drop(BYE.closed);
      else stop(BYE[event.reason]);
      break;
    case 'pong':
      if (!live(event.conn)) break;
      clear('pong');
      if (T.pingMs > 0) fx.push({ type: 'setTimer', name: 'ping', ms: T.pingMs });
      break;
    case 'timer':
      if (event.name === 'retry') { s.retrying = false; dial(); }
      else if (event.name === 'ping') { if (s.conn !== null && s.synced) ping(s.conn); }
      else if (event.name === 'dial') { if (s.conn !== null && !s.synced) drop(`no answer from the host within ${T.dialMs / 1000} s`); }
      else if (s.conn !== null) drop(`no answer from the host within ${T.pongMs / 1000} s`);
      expire();
      break;
    case 'tick': {
      const gap = now - s.lastTick;
      s.lastTick = now;
      if (gap < 0 || gap > 3 * T.tickMs) check(); // slept, or the wall clock jumped
      expire();
      break;
    }
    case 'network':
      check();
      break;
    case 'post':
      if (s.phase === 'stopped' || s.queue.some(p => p.id === event.id)) break;
      s.queue = [...s.queue, { id: event.id, at: now }];
      if (s.conn !== null && s.synced) fx.push({ type: 'send', conn: s.conn, id: event.id });
      break;
    case 'acked':
      s.queue = s.queue.filter(p => p.id !== event.id);
      break;
    case 'stop':
      stop(event.why);
      break;
  }
  return { state: s, effects: fx };
}
