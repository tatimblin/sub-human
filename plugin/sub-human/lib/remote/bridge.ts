/**
 * plugin/sub-human/lib/remote/bridge.ts: a synchronous call from a hook's thread to asynchronous work on a
 * worker thread, with a deadline. Hooks are short synchronous processes (lib/lock.ts) and the store API is
 * synchronous, so a mirror's write (lib/room/store-mirror.ts) blocks here while the worker talks to the link
 * daemon's socket (lib/remote/link.ts handle). The worker never loads the signer: a via=human payload is
 * signed on the calling thread first. Its proof gate runs the hook suites
 * over a FsRoomStore proxied through this bridge (test/support/thread-store.ts).
 *
 *   createBridge<A>({handler, deadlineMs?}) -> {call(method, params, {deadlineMs}?) -> result, close()}
 *       A (Api): each method's params and result, as the handler module answers them (lib/room/store-mirror.ts
 *       RelayApi; the test thread store's own)
 *       handler: the absolute path of a module exporting handle(method, params) -> result | Promise<result>,
 *       loaded on the worker at the first call (a load error fails the call). call() posts {id, method, params}, then
 *       Atomics.wait()s on a SharedArrayBuffer counter the worker bumps after each reply, and takes the reply
 *       with receiveMessageOnPort(). Params and results are structured clones. A handler that throws or rejects
 *       rethrows here as RoomError (its code when one of protocol CODES, else INVALID, with its reason and unknown flag). Past deadlineMs
 *       (default LINK_CALL_MS; SessionEnd passes LINK_CALL_END_MS): RoomError OFFLINE, reason UNKNOWN_OUTCOME (the
 *       handler may have sent it on, so its outcome is unknown); the call is abandoned (its late reply is
 *       dropped) and nothing is retried. The worker and its port are unref'd, so a hook exits when its body
 *       returns; close() ends the worker now.
 *   Deadlock rule: the thread that calls never serves the handler's work. While call() waits, the calling
 *   thread runs nothing, so a handler that needs it (a server on the caller's event loop, a reply posted to
 *   the caller's port) cannot finish: the call ends OFFLINE at the deadline. Whatever the handler talks to
 *   lives on the worker, another thread, or another process (test/bridge.node-test.ts checks the deadline holds).
 *   This file is also the worker entry: on a worker started by createBridge it loads the handler and answers.
 */

import { Worker, MessageChannel, isMainThread, workerData, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import * as config from '../config.ts';
import { RoomError } from '../room/validate.ts';
import { isReason, reasonOf } from '../reasons.ts';
import { errCode, msgOf } from '../errors.ts';
import { isWireCode } from './protocol.ts';
import { createRequire } from 'node:module';

// The worker loads its handler by path (createRequire: require(esm) is synchronous and caches like an import).
const require = createRequire(import.meta.url);

const ENTRY = 'sub-human.bridge';

/** What crosses the port: a call, and its reply. Params and results are structured clones. */
interface Call {
  id: number;
  method: string;
  params: unknown;
}
interface BridgeReply {
  id: number;
  result?: unknown;
  error?: { code: string | undefined; message: string; reason?: string; unknown?: boolean };
}
/** A handler module: handle(method, params) -> result | Promise<result>. */
type Handle = (method: string, params: unknown) => unknown;

/** A handler module's methods: each one's params and result (structured clones across the port). */
export type Api = Record<string, { params: unknown; result: unknown }>;

export interface Bridge<A extends Api> {
  call<M extends keyof A & string>(method: M, params: A[M]['params'], opts?: { deadlineMs?: number }): A[M]['result'];
  close(): void;
}

function createBridge<A extends Api>({ handler, deadlineMs = config.LINK_CALL_MS }: { handler: string; deadlineMs?: number }): Bridge<A> {
  const replies = new Int32Array(new SharedArrayBuffer(4));
  const { port1: port, port2 } = new MessageChannel();
  const worker = new Worker(import.meta.filename, { workerData: { [ENTRY]: true, handler, replies, port: port2 }, transferList: [port2] });
  worker.unref();
  port.unref();
  let seq = 0;

  function call(method: string, params: unknown, { deadlineMs: ms = deadlineMs }: { deadlineMs?: number } = {}): unknown {
    const id = ++seq;
    const until = Date.now() + ms;
    port.postMessage({ id, method, params });
    for (;;) {
      const seen = Atomics.load(replies, 0);
      const got = receiveMessageOnPort(port) as { message: BridgeReply } | undefined;
      if (got) { if (got.message.id === id) return settle(got.message); continue; } // an abandoned call's reply
      const left = until - Date.now();
      if (left <= 0) throw new RoomError('OFFLINE', `${method}: no answer within ${ms} ms`, 'UNKNOWN_OUTCOME'); // sent, or not
      Atomics.wait(replies, 0, seen, left);
    }
  }

  // the handler module answers each method as A says (the one place a reply is read as its type)
  return { call: call as Bridge<A>['call'], close() { port.close(); worker.terminate(); } };
}

function settle({ result, error }: BridgeReply): unknown {
  if (error) {
    const e = new RoomError(isWireCode(error.code) ? error.code : 'INVALID', error.message, isReason(error.reason) ? error.reason : null);
    if (error.unknown === true) e.unknown = true;
    throw e;
  }
  return result;
}

// ---------- the worker ----------
const failure = (id: number, err: unknown): BridgeReply => {
  const reason = reasonOf(err);
  return { id, error: {
    code: errCode(err), message: msgOf(err) || String(err),
    ...(reason ? { reason } : {}), ...(err instanceof RoomError && err.unknown === true ? { unknown: true } : {}),
  } };
};

function serve({ handler, replies, port }: { handler: string; replies: Int32Array; port: MessagePort }): void {
  let handle: Handle | null = null;
  port.on('message', async ({ id, method, params }: Call) => {
    let reply: BridgeReply;
    try {
      handle = handle || (require(handler) as { handle: Handle }).handle; // at the first call: a preload may be requiring this file
      reply = { id, result: await handle(method, params) };
    } catch (e) { reply = failure(id, e); }
    try { port.postMessage(reply); } catch (e) { port.postMessage(failure(id, e)); } // a result that does not clone
    Atomics.add(replies, 0, 1);
    Atomics.notify(replies, 0);
  });
}

if (!isMainThread && workerData && workerData[ENTRY]) serve(workerData);

export { createBridge };
