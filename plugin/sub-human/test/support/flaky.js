'use strict';
/**
 * test/support/flaky.js: a transport that misbehaves on purpose, around any real one (lib/remote/transports/*),
 * for the resume, FORK and OFFLINE tests: seeded, so a failing run replays. Test only.
 *
 *   flaky(transport, {seed, drop?, delayMs?, dup?, cutAfter?}) -> Transport
 *       drop     probability a frame is lost (either direction)
 *       delayMs  [min, max] added latency per frame, order kept (per direction)
 *       dup      probability a frame is delivered twice
 *       cutAfter close the transport after this many frames (the peer sees onClose)
 *   The returned transport also has .stats = {sent, dropped, duplicated, delayedMs}.
 */

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} transport
 * @param {{seed: number, drop?: number, delayMs?: [number, number], dup?: number, cutAfter?: number}} opts
 * @returns {object}
 */
function flaky(transport, { seed, drop = 0, delayMs = [0, 0], dup = 0, cutAfter = Infinity }) {
  const rand = prng(seed);
  const stats = { sent: 0, dropped: 0, duplicated: 0, delayedMs: 0 };
  const frameFns = [];

  /** A queue that keeps order: each job runs no earlier than the one before it, after its own random delay. */
  function lane() {
    let last = 0;
    return job => {
      const wait = delayMs[0] + rand() * (delayMs[1] - delayMs[0]);
      stats.delayedMs += wait;
      last = Math.max(last, Date.now() + wait);
      setTimeout(job, last - Date.now());
    };
  }
  /** One direction: count, then drop, duplicate or deliver the frame in order; close after the cutAfter-th. */
  function misbehave(deliver) {
    const later = lane();
    return frame => {
      if (stats.sent >= cutAfter) return;
      stats.sent++;
      if (rand() < drop) stats.dropped++;
      else {
        later(() => deliver(frame));
        if (rand() < dup) { stats.duplicated++; later(() => deliver(frame)); }
      }
      if (stats.sent === cutAfter) later(() => transport.close());
    };
  }

  const outgoing = misbehave(frame => transport.send(frame));
  transport.onFrame(misbehave(frame => { for (const fn of frameFns) fn(frame); }));
  return {
    stats,
    send: outgoing,
    onFrame(fn) { frameFns.push(fn); },
    onClose: fn => transport.onClose(fn),
    close: () => transport.close(),
  };
}

module.exports = { flaky };
