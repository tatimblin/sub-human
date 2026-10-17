/**
 * plugin/sub-human/lib/remote/link-engine.ts: the link daemon's connection logic as a pure state machine. No I/O, no
 * timers, no clock of its own: step(state, event, ctx) returns the next state and the effects the daemon then runs
 * (lib/remote/link.ts serveMirror: dial, subscribe, renew seats, send the outbox, ping, set or clear a timer, close a
 * connection, publish its state). The time comes in with every event (ctx.now) and the jitter from ctx.random, so a
 * table test drives every path on a fake clock (test/link-engine.node-test.ts). Connections are ids the daemon maps to
 * its clients; the engine only knows which one is live (conn) and which one a dial is making (dial).
 *
 * Phases (lib/room/link-state.ts): connecting (the first dial, nothing online yet), online, offline (a retry timer or
 * a dial under way), and for good fork (the mirror is not the host's prefix) or stopped (AUTH, PROTOCOL, the room
 * closed, no seat left, a signal). A dial runs connect -> subscribe -> keepSeats -> flush,
 * each an effect whose outcome comes back as an event; only after flush does the new connection replace the live one
 * (make before break), which is then retired (closed once the ops in flight on it are answered). One dial at a time.
 *
 * A failed step: FATAL codes stop the link; anything else keeps a live connection when there is one (a failed redial
 * changes nothing), else goes offline and retries after nextDelay. lost is a failed dial with no live one. redial (a wake, a network change, a signal) dials now with the backoff reset. Timers:
 * ping every pingMs; no pong within pongMs makes the link suspect (a make-before-break redial); none within deadMs
 * (noPong) is a dead, half-open connection: a dial under way decides what comes next, else as lost.
 */

import { assertNever } from '../../mod/core/never.ts';
import type { Reason } from '../reasons.ts';
import type { LinkTimings } from './types-core.ts';
import type { LinkStateWord } from '../room/types.ts';

type TimerName = 'retry' | 'ping' | 'pong';
type EngineStep = 'connect' | 'subscribe' | 'seats' | 'flush';

/** Why a dial or a connection failed: its code, its typed reason and its message. */
interface Failure { code?: string | null; reason?: Reason | null; message: string }

interface EngineState {
  phase: LinkStateWord;
  /** why it is in this phase, for people (the document `link` reason) */
  reason: string | null;
  /** the code it stopped with (AUTH, PROTOCOL, FORK), and the typed reason */
  code: string | null;
  why: Reason | null;
  since: number;
  conn: number | null;
  dial: number | null;
  stepOf: EngineStep | null;
  /** the next connection id */
  next: number;
  delay: number;
  attempts: number;
  lastError: string | null;
  lastReason: Reason | null;
  prevError: string | null;
  rttMs: number | null;
  retrying: boolean;
  pinging: boolean;
}

type EngineEvent =
  | { type: 'start' }
  | { type: 'connected' | 'subscribed' | 'seated'; dial: number }
  | { type: 'flushed'; dial: number }
  | { type: 'dialFailed'; dial: number; error: Failure }
  | { type: 'lost'; conn: number; error: Failure }
  | { type: 'redial'; why: string }
  | { type: 'timer'; name: TimerName }
  | { type: 'pong'; conn: number; rttMs: number }
  | { type: 'noPong'; conn: number }
  | { type: 'stop'; phase: 'stopped' | 'fork'; why: string; code?: string | null; reason?: Reason | null };

type EngineEffect =
  | { type: 'connect' | 'subscribe' | 'keepSeats' | 'flush'; dial: number }
  | { type: 'close' | 'retire'; conn: number }
  | { type: 'sendPing'; conn: number; ms: number }
  | { type: 'setTimer'; name: TimerName; ms: number }
  | { type: 'clearTimer'; name: TimerName }
  | { type: 'online'; conn: number; old: number | null }
  | { type: 'forked'; why: string }
  | { type: 'publish' }
  | { type: 'log'; msg: string }
  | { type: 'finish'; why: string };

interface EngineCtx { timings: LinkTimings; random?: () => number; now: number }

const FATAL: ReadonlySet<unknown> = new Set(['FORK', 'AUTH', 'PROTOCOL']);
const FOR_GOOD: ReadonlySet<unknown> = new Set(['fork', 'stopped']);
const forGood = (s: EngineState): boolean => FOR_GOOD.has(s.phase);
const shown = (s: EngineState): LinkStateWord => (s.phase === 'offline' && s.dial !== null ? 'connecting' : s.phase);

/** The next retry delay, decorrelated jitter: random in [base, 3 x prev], at most cap. */
const nextDelay = (prev: number, base: number, cap: number, random: () => number = Math.random): number =>
  Math.round(Math.min(cap, base + random() * (Math.max(base, prev * 3) - base)));

function initial(now: number, retryMs = 0): EngineState {
  return {
    phase: 'connecting', reason: null, code: null, why: null, since: now, conn: null, dial: null, stepOf: null, next: 1,
    delay: retryMs, attempts: 0, lastError: null, lastReason: null, prevError: null, rttMs: null, retrying: false, pinging: false,
  };
}

/** One transition. The state passed in is not changed. */
function step(state: EngineState, event: EngineEvent, ctx: EngineCtx): { state: EngineState; effects: EngineEffect[] } {
  const s: EngineState = { ...state };
  const fx: EngineEffect[] = [];
  const T = ctx.timings;
  const random = ctx.random ?? Math.random;
  const enter = (phase: LinkStateWord, reason: string | null = null, code: string | null = null, why: Reason | null = null) => {
    Object.assign(s, { phase, reason, code, why, since: ctx.now });
    fx.push({ type: 'publish' });
  };
  const clear = (...names: TimerName[]) => {
    for (const n of names) fx.push({ type: 'clearTimer', name: n });
    if (names.includes('retry')) s.retrying = false;
    if (names.includes('pong')) s.pinging = false;
  };

  function dial(why: string | null) {
    if (forGood(s) || s.dial !== null) return;
    if (s.retrying) clear('retry');
    s.attempts++;
    s.dial = s.next++;
    s.stepOf = 'connect';
    fx.push({ type: 'log', msg: s.conn !== null ? `redialing (${why}); the current connection stays until the new one is live` : `connecting${why ? ` (${why})` : ''}` });
    fx.push({ type: 'connect', dial: s.dial });
    fx.push({ type: 'publish' });
  }

  function redial(why: string) {
    if (forGood(s)) return;
    s.delay = T.retryMs;
    if (s.dial === null) fx.push({ type: 'log', msg: `${why}: redialing now` });
    dial(why);
  }

  function stop(phase: 'stopped' | 'fork', why: string, code: string | null = null, reason: Reason | null = null) {
    if (forGood(s)) return;
    clear('retry', 'ping', 'pong');
    const c = s.conn;
    s.conn = null;
    s.lastError = why;
    s.lastReason = reason;
    enter(phase, why, code, reason);
    if (phase === 'fork') fx.push({ type: 'forked', why });
    if (c !== null) fx.push({ type: 'close', conn: c });
    fx.push({ type: 'finish', why });
  }

  /** The live connection is gone (or there was none): offline, and a retry unless a dial or a retry is under way. */
  function fail(e: Failure) {
    if (e.code === 'FORK') return stop('fork', e.message, 'FORK', e.reason || null);
    if (e.code === 'AUTH' || e.code === 'PROTOCOL') return stop('stopped', e.message, e.code, e.reason || null);
    const c = s.conn;
    s.conn = null;
    clear('ping', 'pong');
    if (c !== null) fx.push({ type: 'close', conn: c });
    s.lastError = e.message;
    s.lastReason = e.reason || null;
    fx.push({ type: 'log', msg: `offline: ${e.message}` });
    enter('offline', e.message, null, e.reason || null);
    if (s.dial !== null || s.retrying) return; // that dial's outcome, or the retry already set, decides
    s.delay = nextDelay(s.delay, T.retryMs, T.retryMaxMs, random);
    s.retrying = true;
    fx.push({ type: 'setTimer', name: 'retry', ms: s.delay });
  }

  /** A dial's step outcome for a dial that is not the one under way, or for a link stopped meanwhile: close it. */
  const stale = (d: number): boolean => {
    if (d === s.dial && !forGood(s)) return false;
    if (d === s.dial) { s.dial = null; s.stepOf = null; }
    fx.push({ type: 'close', conn: d });
    return true;
  };

  switch (event.type) {
    case 'start':
      fx.push({ type: 'publish' });
      dial(null);
      break;
    case 'connected':
      if (stale(event.dial)) break;
      s.stepOf = 'subscribe';
      fx.push({ type: 'subscribe', dial: event.dial });
      break;
    case 'subscribed':
      if (stale(event.dial)) break;
      s.stepOf = 'seats';
      fx.push({ type: 'keepSeats', dial: event.dial });
      break;
    case 'seated':
      if (stale(event.dial)) break;
      s.stepOf = 'flush';
      fx.push({ type: 'flush', dial: event.dial });
      break;
    case 'flushed': {
      if (stale(event.dial)) break;
      const old = s.conn;
      s.conn = event.dial;
      s.dial = null;
      s.stepOf = null;
      s.attempts = 0;
      s.delay = T.retryMs;
      if (s.lastError) { s.prevError = s.lastError; s.lastError = null; s.lastReason = null; } // online: why it last went offline is history
      enter('online');
      fx.push({ type: 'online', conn: event.dial, old });
      clear('ping', 'pong');
      if (T.pingMs > 0) fx.push({ type: 'setTimer', name: 'ping', ms: T.pingMs });
      if (old !== null) fx.push({ type: 'retire', conn: old });
      break;
    }
    case 'dialFailed': {
      if (event.dial !== s.dial) { fx.push({ type: 'close', conn: event.dial }); break; }
      s.dial = null;
      s.stepOf = null;
      fx.push({ type: 'close', conn: event.dial });
      if (forGood(s)) break;
      if (s.conn !== null && !FATAL.has(event.error.code)) {
        fx.push({ type: 'log', msg: `redial failed (${event.error.message}); the current connection stays` });
        fx.push({ type: 'publish' });
        break;
      }
      fail(event.error);
      break;
    }
    case 'lost':
      if (event.conn !== s.conn || forGood(s)) break;
      fail(event.error);
      break;
    case 'redial':
      redial(event.why);
      break;
    case 'timer':
      if (event.name === 'retry') {
        s.retrying = false;
        dial('retry');
      } else if (event.name === 'ping') {
        if (s.conn === null || forGood(s)) break;
        s.pinging = true;
        fx.push({ type: 'setTimer', name: 'pong', ms: T.pongMs });
        fx.push({ type: 'sendPing', conn: s.conn, ms: T.deadMs });
      } else if (s.pinging && s.conn !== null) { // pong: late, not yet dead
        redial(`no pong within ${T.pongMs} ms`);
      }
      break;
    case 'pong':
      if (event.conn !== s.conn) break;
      clear('pong');
      s.rttMs = event.rttMs;
      fx.push({ type: 'publish' });
      fx.push({ type: 'setTimer', name: 'ping', ms: T.pingMs });
      break;
    case 'noPong': {
      if (event.conn !== s.conn) break;
      clear('pong');
      const why = `no pong within ${T.deadMs} ms`;
      if (s.dial === null) { fail({ code: 'OFFLINE', message: why }); break; }
      // a dial under way decides what comes next: this one is dead meanwhile
      s.conn = null;
      clear('ping');
      fx.push({ type: 'close', conn: event.conn });
      s.lastError = why;
      s.lastReason = null;
      fx.push({ type: 'log', msg: `offline: ${why}` });
      enter('offline', why);
      break;
    }
    case 'stop':
      stop(event.phase, event.why, event.code ?? null, event.reason ?? null);
      break;
    default: return assertNever(event, 'link event');
  }
  return { state: s, effects: fx };
}

export { initial, step, nextDelay, shown, forGood, FATAL };
export type { EngineState, EngineEvent, EngineEffect, Failure, TimerName, EngineCtx };
