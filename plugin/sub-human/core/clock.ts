// The daemon's time, injected so tests run it on a fake clock (ARCHITECTURE §2, principle 4). Each user takes the part it
// needs; no timer of REAL_CLOCK keeps the process alive by itself.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Calls fn once after ms, until the returned cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Calls fn every ms until the returned stop. */
  every(ms: number, fn: () => void): () => void;
}

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => { setTimeout(r, ms); }),
  after: (ms, fn) => { const t = setTimeout(fn, ms); t.unref(); return () => { clearTimeout(t); }; },
  every: (ms, fn) => { const t = setInterval(fn, ms); t.unref(); return () => { clearInterval(t); }; },
};
