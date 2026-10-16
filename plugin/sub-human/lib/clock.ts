/**
 * A tiny injectable clock, so code that waits (the `sub-human tail` settle and poll loops) can be tested
 * without real sleeps. Production code takes a clock (default: `real`) and calls only these methods:
 *
 *   now() -> ms                          Date.now()
 *   setTimeout(fn, ms, ...args) / clearTimeout(h)
 *   setInterval(fn, ms, ...args) / clearInterval(h)
 *   sleep(ms) -> Promise                 resolves after ms
 *
 * The module itself is the real clock (import * as clock; clock.now() etc.); `.real` is the same object to pass around.
 *
 * createFake({ now = 0 }) -> a clock with the same methods plus:
 *   advance(ms)                          move time forward, firing due timers in order (by due time, then
 *                                        by creation); timers a callback schedules inside the window fire too
 *   advanceAsync(ms) -> Promise          the same, but lets promise callbacks run before each timer and at
 *                                        the end, so `await clock.sleep()` loops make progress
 *   runAll(limit = 1000)                 fire timers until none are left (intervals count toward limit)
 *   pending() -> number                  timers still scheduled
 *   set(ms)                              jump `now` without firing anything
 * Fake handles support ref()/unref()/hasRef()/refresh() as no-ops (refresh re-arms), like Node's Timeout.
 *
 * Why not node:test mock.timers: it patches the globals for the whole process (so it also freezes the
 * helpers' own sleeps and child-process polling) and does not fake Date unless asked; an injected clock
 * only affects the code under test. mock.timers is fine for a unit that uses globals and nothing else.
 */

/** A timer handle: Node's Timeout from the real clock, a fake Handle from createFake(). */
interface TimerHandle {
  ref(): TimerHandle;
  unref(): TimerHandle;
  hasRef(): boolean;
  refresh(): TimerHandle;
  [Symbol.toPrimitive](): number;
}
type TimerCallback = (...args: any[]) => void; // any: a timer passes the caller's extra args through untouched
type ClearArg = TimerHandle | number | null | undefined;

/** The methods code that waits calls (default: the real clock). */
interface Clock {
  now(): number;
  setTimeout(fn: TimerCallback, ms?: number, ...args: unknown[]): TimerHandle;
  clearTimeout(h: ClearArg): void;
  setInterval(fn: TimerCallback, ms?: number, ...args: unknown[]): TimerHandle;
  clearInterval(h: ClearArg): void;
  sleep(ms: number): Promise<void>;
}

/** createFake()'s clock: a Clock plus the controls tests drive it with. */
interface FakeClock extends Clock {
  advance(ms: number): void;
  advanceAsync(ms: number): Promise<void>;
  runAll(limit?: number): void;
  pending(): number;
  set(ms: number): void;
}

// The real clock's handles are always Node Timeouts (or what a caller kept of one: its number).
const nodeHandle = (h: ClearArg) => (h ?? undefined) as NodeJS.Timeout | number | undefined;

const real: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms, ...a) => setTimeout(fn, ms, ...a),
  clearTimeout: h => clearTimeout(nodeHandle(h)),
  setInterval: (fn, ms, ...a) => setInterval(fn, ms, ...a),
  clearInterval: h => clearInterval(nodeHandle(h)),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

interface FakeTimer { id: number; seq: number; fn: TimerCallback; args: unknown[]; ms: number; due: number; repeat: boolean }

function createFake({ now: start = 0 }: { now?: number } = {}): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, FakeTimer>(); // id -> timer

  class Handle implements TimerHandle {
    id: number;
    _t: FakeTimer;
    constructor(t: FakeTimer) { this.id = t.id; this._t = t; }
    ref() { return this; }
    unref() { return this; }
    hasRef() { return true; }
    refresh() { const t = this._t; t.due = now + t.ms; t.seq = ++seq; timers.set(t.id, t); return this; }
    [Symbol.toPrimitive]() { return this.id; }
  }

  function add(fn: TimerCallback, ms: number | undefined, args: unknown[], repeat: boolean): Handle {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function');
    ms = Math.max(1, Number(ms) || 0); // Node clamps 0 to 1 ms
    const t = { id: ++seq, seq, fn, args, ms, due: now + ms, repeat };
    timers.set(t.id, t);
    return new Handle(t);
  }
  const clear = (h: ClearArg): void => { if (h != null) timers.delete(typeof h === 'object' ? (h as Handle).id : Number(h)); };

  function next(until: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const t of timers.values()) {
      if (t.due > until) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  }
  function fire(t: FakeTimer): void {
    now = Math.max(now, t.due);
    if (t.repeat) { t.due += t.ms; t.seq = ++seq; } else timers.delete(t.id);
    t.fn(...t.args);
  }

  const flush = () => new Promise<void>(r => setImmediate(r));

  const clock: FakeClock = {
    now: () => now,
    setTimeout: (fn, ms, ...a) => add(fn, ms, a, false),
    clearTimeout: clear,
    setInterval: (fn, ms, ...a) => add(fn, ms, a, true),
    clearInterval: clear,
    sleep: ms => new Promise<void>(r => add(r, ms, [], false)),

    advance(ms) {
      const until = now + Math.max(0, Number(ms) || 0);
      for (let t; (t = next(until));) fire(t);
      now = until;
    },
    async advanceAsync(ms) {
      const until = now + Math.max(0, Number(ms) || 0);
      await flush();
      for (let t; (t = next(until));) { fire(t); await flush(); }
      now = until;
      await flush();
    },
    runAll(limit = 1000) {
      for (let i = 0; timers.size; i++) {
        if (i >= limit) throw new Error(`runAll: still ${timers.size} timer(s) after ${limit} firings`);
        fire(next(Infinity)!); // timers is not empty, so some timer is due by Infinity
      }
    },
    pending: () => timers.size,
    set(ms) { now = Number(ms); },
  };
  return clock;
}

// The module itself is the real clock: each method of `real`, exported under its own name (aliased so the module
// scope never shadows the global timers they call).
const now: () => number = real.now;
const realSetTimeout: (fn: TimerCallback, ms?: number, ...args: unknown[]) => TimerHandle = real.setTimeout;
const realClearTimeout: (h: ClearArg) => void = real.clearTimeout;
const realSetInterval: (fn: TimerCallback, ms?: number, ...args: unknown[]) => TimerHandle = real.setInterval;
const realClearInterval: (h: ClearArg) => void = real.clearInterval;
const sleep: (ms: number) => Promise<void> = real.sleep;
export {
  now, realSetTimeout as setTimeout, realClearTimeout as clearTimeout, realSetInterval as setInterval,
  realClearInterval as clearInterval, sleep, real, createFake,
};
export type { Clock, FakeClock, TimerHandle, TimerCallback };
