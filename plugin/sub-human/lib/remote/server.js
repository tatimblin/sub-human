'use strict';
/**
 * plugin/sub-human/lib/remote/server.js: one connection to a hosted room. `bin/sub-human serve --stdio CODE`
 * runs one per connection on the host (spawned by the client's pipe transport now, by an SSH forced command
 * later); the store contract test runs one on a worker thread over the memory transport. It serves the host's
 * FsRoomStore (isHost) and shares the room's file locks with the host's own hooks, which never go through it.
 * It never loads the signer (test/hooks/security.test.js): a via=human payload arrives signed by the remote
 * hook and is verified against the key pinned in the log (lib/room/envelope.js), then placed (store.place).
 * Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md (the op table and the error codes are there).
 *
 *   serve(transport, {store, machine?, log?}) -> {close()}
 *       A Session over one transport (lib/remote/transports/*): unauthenticated until hello {token | invite}
 *       (lib/remote/auth.js); every other op before that is AUTH. Ops:
 *         hello      version check (protocol.VERSION); verifyToken or redeemInvite (the token is returned once)
 *         join       lib/seats.js enter() with machine = the link's; the key is pinned or AUTH; bindSeat
 *         leave      seats.exit(), own seat only
 *         beat       store.members.beat(name, {presence?}), own seat only
 *         append     own `from` only; validate (lib/room/validate.js), verify + replay bound (envelope),
 *                    rate (both buckets), store.place(); a signoff or objection is followed by
 *                    lib/proposal.js decide() (host only, idempotent). System kinds from a link: retract of
 *                    the link's own entries, nothing else
 *         subscribe  {after, hash}: hash12 of the host's line `after` must equal hash, else FORK; then
 *                    event 'entry' per line in id order (store.tailer()), event 'doc' for members (pid,
 *                    pid_start, session_id and cwd stripped), presence/NAME and tasks when they change, 'end'
 *                    when the room closes or the transport does
 *         blob.get   store.blobs.get(ref), base64;  blob.put  store.blobs.put(name, bytes)
 *       An op that throws RoomError answers {error: {code, message}} with the same code; any other error is
 *       INVALID with the message and is logged. close() ends the stream and the transport.
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

/**
 * @param {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}} transport
 * @param {{store: import('../room/store.js').FsRoomStore, machine?: string, log?: (...a: any[]) => void}} ctx
 * @returns {{close(): void}}
 */
function serve(transport, ctx) { return todo(`server.serve(${ctx && ctx.store && ctx.store.code})`); }

module.exports = { serve };
