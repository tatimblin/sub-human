'use strict';
/**
 * plugin/sub-human/lib/remote/transports/index.js: the transport contract and the lookup by kind. A transport
 * carries protocol frames (lib/remote/protocol.js) between a client and a server and knows nothing about
 * them. Kinds here: memory (./memory.js, a pair in one process or across worker threads) and pipe (./pipe.js,
 * a child's stdio or this process's). SSH is the pipe kind with an `ssh` command in front, later. PR4 of
 * docs/archive/REMOTE-PLAN.md.
 *
 *   Transport = {send(frame), onFrame(fn), onClose(fn), close()}
 *       send after close is a no-op; onClose fires once, also when the peer ends
 *   open(spec) -> Transport           spec = {kind: 'pipe', cmd: [bin, ...args], env?, cwd?} | {kind: 'memory', port}
 *   KINDS                             ['memory', 'pipe']
 *   lineTransport({write, shut}) -> {transport, receive(chunk), end()}   the shared half of every kind: write(line)
 *       sends one encoded frame, shut() releases the kind's resources at close(); the kind feeds what arrives
 *       to receive() (decoded, protocol.decoder) and calls end() when the other side is gone
 */

const protocol = require('../protocol.js');
const { RoomError } = require('../../room/validate.js');

const KINDS = ['memory', 'pipe'];

function lineTransport({ write, shut }) {
  const frameFns = [], closeFns = [];
  const dec = protocol.decoder();
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  const transport = {
    send(frame) { if (!closed) write(protocol.encode(frame)); },
    onFrame(fn) { frameFns.push(fn); },
    onClose(fn) { closeFns.push(fn); },
    close() { if (!closed) { shut(); end(); } },
  };
  const receive = chunk => { for (const f of dec.push(chunk)) for (const fn of frameFns) fn(f); };
  return { transport, receive, end };
}

/**
 * @param {{kind: string, cmd?: string[], env?: object, cwd?: string, port?: import('node:worker_threads').MessagePort}} spec
 * @returns {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}}
 */
function open(spec) {
  const kind = spec && spec.kind;
  if (kind === 'pipe') return require('./pipe.js').spawn(spec.cmd[0], spec.cmd.slice(1), { env: spec.env, cwd: spec.cwd });
  if (kind === 'memory') return require('./memory.js').over(spec.port);
  throw new RoomError('INVALID', `unknown transport "${kind}" (${KINDS.join(', ')})`);
}

module.exports = { KINDS, open, lineTransport };
