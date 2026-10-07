'use strict';
/**
 * plugin/sub-human/lib/remote/link.js: the link daemon, one per machine and room (`bin/sub-human link CODE`,
 * started detached by the join hook, like the orch starter). It holds the one connection to the host
 * (lib/remote/client.js over the transport in the link file, lib/room/links.js), keeps the mirror
 * (lib/room/store-mirror.js applyLine / applyDoc) byte-identical to the host's log, prefetches every
 * proposal's plan blob, and serves the hooks of this machine on a unix socket: a hook's bridge worker
 * (lib/remote/bridge.js, handler = this file's handle) forwards one op and gets one reply. It never loads
 * the signer. Stub: filled in by PR5 of docs/next/REMOTE-PLAN.md.
 *
 *   run({code, home?, log?}) -> Promise<void>
 *       connect with the link's token; subscribe {after, hash} from link.last (FORK: stop, log loudly, leave
 *       the mirror as it is; `sub-human link --reset CODE` re-mirrors); apply the stream; advance link.last;
 *       listen on socketPath(home); forward ops; an `append` reply is sent to the hook only after the placed
 *       entry has been applied to the mirror (read-your-writes). Exits LINK_IDLE_MS after the last local seat
 *       of this room left, or when the transport ends and reconnects keep failing.
 *   socketPath(home) -> string      <os.tmpdir()>/sh-<hash8(home)>/link.sock (macOS caps a socket path at 104 bytes)
 *   handle(method, params) -> Promise<result>   the bridge handler: one op over the socket; OFFLINE when the
 *                                                daemon is not listening (nothing is started from a hook's call)
 *   status(code, home?) -> {running, last, offline_since?}   for the tail's one-line notices
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR5)`); };

/**
 * @param {{code: string, home?: string, log?: (...a: any[]) => void}} opts
 * @returns {Promise<void>}
 */
async function run(opts) { return todo(`link.run(${opts && opts.code})`); }

/**
 * @param {string} [home]
 * @returns {string}
 */
function socketPath(home) { return todo(`link.socketPath(${typeof home})`); }

/**
 * @param {string} method
 * @param {object} params
 * @returns {Promise<*>}
 */
async function handle(method, params) { return todo(`link.handle(${method}, ${typeof params})`); }

/**
 * @param {string} code
 * @param {string} [home]
 * @returns {{running: boolean, last: {id: number, hash: string} | null, offline_since?: string}}
 */
function status(code, home) { return todo(`link.status(${code}, ${typeof home})`); }

module.exports = { run, socketPath, handle, status };
