'use strict';
/**
 * test/support/flaky.js: a transport that misbehaves on purpose, around any real one (lib/remote/transports/*),
 * for the resume, FORK and OFFLINE tests: seeded, so a failing run replays. Test only. Stub: filled in by PR4
 * of docs/next/REMOTE-PLAN.md.
 *
 *   flaky(transport, {seed, drop?, delayMs?, dup?, cutAfter?}) -> Transport
 *       drop     probability a frame is lost (either direction)
 *       delayMs  [min, max] added latency per frame, order kept
 *       dup      probability a frame is delivered twice
 *       cutAfter close the transport after this many frames (the peer sees onClose)
 *   The returned transport also has .stats = {sent, dropped, duplicated, delayedMs}.
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

/**
 * @param {object} transport
 * @param {{seed: number, drop?: number, delayMs?: [number, number], dup?: number, cutAfter?: number}} opts
 * @returns {object}
 */
function flaky(transport, opts) { return todo(`flaky(seed ${opts && opts.seed})`); }

module.exports = { flaky };
