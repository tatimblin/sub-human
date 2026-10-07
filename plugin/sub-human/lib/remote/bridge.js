'use strict';
/**
 * plugin/sub-human/lib/remote/bridge.js: a synchronous call from a hook's thread to asynchronous work on a
 * worker thread, with a deadline. Hooks are short synchronous processes (lib/lock.js) and the store API is
 * synchronous, so a mirror's write (lib/room/store-mirror.js) blocks here while the worker talks to the link
 * daemon's socket (lib/remote/link.js handle). The worker never loads the signer: a via=human payload is
 * signed on the calling thread first. Stub: filled in by PR3 of docs/next/REMOTE-PLAN.md (the proof gate:
 * the hook suites pass over a FsRoomStore proxied through this bridge, test/support/thread-store.js).
 *
 *   createBridge({handler, workerData?, deadlineMs?}) -> {call(method, params, {deadlineMs}?) -> result, close()}
 *       handler: the path of a module exporting handle(method, params) -> Promise<result>, loaded on the
 *       worker. call() posts {id, method, params}, then Atomics.wait()s on a SharedArrayBuffer until the
 *       worker signals and receiveMessageOnPort() has the reply; a rejected handler rethrows as RoomError
 *       (the code the handler gave, else INVALID). Past deadlineMs (LINK_CALL_MS; SessionEnd passes
 *       LINK_CALL_END_MS): RoomError OFFLINE, the call is abandoned, nothing is retried. The worker is unref'd,
 *       so a hook exits when its body returns.
 *   This file is also the worker entry (isMainThread false): it loads workerData.handler and answers calls.
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR3)`); };

/**
 * @param {{handler: string, workerData?: object, deadlineMs?: number}} opts
 * @returns {{call(method: string, params: object, opts?: {deadlineMs?: number}): any, close(): void}}
 */
function createBridge(opts) { return todo(`bridge.createBridge(${opts && opts.handler})`); }

module.exports = { createBridge };
