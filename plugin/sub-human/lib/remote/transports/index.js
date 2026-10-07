'use strict';
/**
 * plugin/sub-human/lib/remote/transports/index.js: the transport contract and the lookup by kind. A transport
 * carries protocol frames (lib/remote/protocol.js) between a client and a server and knows nothing about
 * them. Kinds here: memory (./memory.js, a pair in one process or across worker threads) and pipe (./pipe.js,
 * a child's stdio or this process's). SSH is the pipe kind with an `ssh` command in front, later. Stub: filled
 * in by PR4 of docs/next/REMOTE-PLAN.md.
 *
 *   Transport = {send(frame), onFrame(fn), onClose(fn), close()}
 *       send after close is a no-op; onClose fires once, also when the peer ends
 *   open(spec) -> Transport           spec = {kind: 'pipe', cmd: [bin, ...args], env?} | {kind: 'memory', port}
 *   KINDS                             ['memory', 'pipe']
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

const KINDS = ['memory', 'pipe'];

/**
 * @param {{kind: string}} spec
 * @returns {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}}
 */
function open(spec) { return todo(`transports.open(${spec && spec.kind})`); }

module.exports = { KINDS, open };
