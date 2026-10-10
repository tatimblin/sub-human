/**
 * A tiny injectable clock, so code that waits (the `sub-human tail` settle and poll loops) can be tested
 * without real sleeps. Production code takes a clock (default: `real`) and calls only these methods:
 *
 *   now() -> ms                          Date.now()
 *   setTimeout(fn, ms, ...args) / clearTimeout(h)
 *   setInterval(fn, ms, ...args) / clearInterval(h)
 *   sleep(ms) -> Promise                 resolves after ms
 *
 * The module itself is the real clock (require(...).now() etc.); `.real` is the same object to pass around.
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

const real = {
  now: () => Date.now(),
  setTimeout: (fn, ms, ...a) => setTimeout(fn, ms, ...a),
  clearTimeout: h => clearTimeout(h),
  setInterval: (fn, ms, ...a) => setInterval(fn, ms, ...a),
  clearInterval: h => clearInterval(h),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

function createFake({ now: start = 0 } = {}) {
  let now = start;
  let seq = 0;
  const timers = new Map(); // id -> timer

  class Handle {
    constructor(t) { this.id = t.id; this._t = t; }
    ref() { return this; }
    unref() { return this; }
    hasRef() { return true; }
    refresh() { const t = this._t; t.due = now + t.ms; t.seq = ++seq; timers.set(t.id, t); return this; }
    [Symbol.toPrimitive]() { return this.id; }
  }

  function add(fn, ms, args, repeat) {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function');
    ms = Math.max(1, Number(ms) || 0); // Node clamps 0 to 1 ms
    const t = { id: ++seq, seq, fn, args, ms, due: now + ms, repeat };
    timers.set(t.id, t);
    return new Handle(t);
  }
  const clear = h => { if (h != null) timers.delete(typeof h === 'object' ? h.id : h); };

  function next(until) {
    let best = null;
    for (const t of timers.values()) {
      if (t.due > until) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  }
  function fire(t) {
    now = Math.max(now, t.due);
    if (t.repeat) { t.due += t.ms; t.seq = ++seq; } else timers.delete(t.id);
    t.fn(...t.args);
  }

  const flush = () => new Promise(r => setImmediate(r));

  const clock = {
    now: () => now,
    setTimeout: (fn, ms, ...a) => add(fn, ms, a, false),
    clearTimeout: clear,
    setInterval: (fn, ms, ...a) => add(fn, ms, a, true),
    clearInterval: clear,
    sleep: ms => new Promise(r => add(r, ms, [], false)),

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
        fire(next(Infinity));
      }
    },
    pending: () => timers.size,
    set(ms) { now = Number(ms); },
  };
  return clock;
}

module.exports = { ...real, real, createFake };
