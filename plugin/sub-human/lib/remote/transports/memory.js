'use strict';
/**
 * plugin/sub-human/lib/remote/transports/memory.js: the in-process transport, a connected pair over a
 * MessageChannel, so the two ends may live on different threads (the store contract's remote backend runs the
 * server on a worker: a thread that makes synchronous bridge calls must never host the server). Test and
 * contract use; no network. Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md.
 *
 *   pair() -> [Transport, Transport]   two connected ends (./index.js documents Transport)
 *   over(port) -> Transport            one end over a MessagePort handed to another thread (workerData)
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

/** @returns {[object, object]} */
function pair() { return todo('transports/memory.pair()'); }

/**
 * @param {import('node:worker_threads').MessagePort} port
 * @returns {object}
 */
function over(port) { return todo(`transports/memory.over(${typeof port})`); }

module.exports = { pair, over };
