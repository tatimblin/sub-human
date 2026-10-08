'use strict';
/**
 * plugin/sub-human/lib/remote/transports/memory.js: the in-process transport, a connected pair over a
 * MessageChannel, so the two ends may live on different threads (the store contract's remote backend runs the
 * server on a worker: a thread that makes synchronous bridge calls must never host the server). Test and
 * contract use; no network. Frames cross as encoded lines, as on a pipe. PR4 of docs/archive/REMOTE-PLAN.md.
 *
 *   pair() -> [Transport, Transport]   two connected ends (./index.js documents Transport)
 *   over(port) -> Transport            one end over a MessagePort handed to another thread (workerData)
 */

const { MessageChannel } = require('node:worker_threads');
const { lineTransport } = require('./index.js');

/** @returns {[object, object]} */
function pair() {
  const { port1, port2 } = new MessageChannel();
  return [over(port1), over(port2)];
}

/**
 * @param {import('node:worker_threads').MessagePort} port
 * @returns {object}
 */
function over(port) {
  const { transport, receive, end } = lineTransport({ write: line => port.postMessage(line), shut: () => port.close() });
  port.on('message', receive);
  port.on('close', end); // either end closed the channel
  return transport;
}

module.exports = { pair, over };
