/**
 * plugin/sub-human/lib/remote/transports/memory.ts: the in-process transport, a connected pair over a
 * MessageChannel, so the two ends may live on different threads (the store contract's remote backend runs the
 * server on a worker: a thread that makes synchronous bridge calls must never host the server). Test and
 * contract use; no network. Frames cross as encoded lines, as on a pipe.
 *
 *   pair() -> [Transport, Transport]   two connected ends (./index.ts documents Transport)
 *   over(port) -> Transport            one end over a MessagePort handed to another thread (workerData)
 */

import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { lineTransport } from './index.ts';
import type { Transport } from '../types-rest.ts';

function pair(): [Transport, Transport] {
  const { port1, port2 } = new MessageChannel();
  return [over(port1), over(port2)];
}

function over(port: MessagePort): Transport {
  const { transport, receive, end } = lineTransport({ write: line => port.postMessage(line), shut: () => port.close() });
  port.on('message', receive);
  port.on('close', end); // either end closed the channel
  return transport;
}

export { pair, over };
