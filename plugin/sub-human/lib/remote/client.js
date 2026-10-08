'use strict';
/**
 * plugin/sub-human/lib/remote/client.js: the asynchronous side of the protocol, one connection to a room's
 * server over a transport. The link daemon (lib/remote/link.js) holds one per room; the protocol tests drive
 * one directly. Hooks never use it: they call the daemon through lib/remote/bridge.js. It never loads the
 * signer: a via=human payload reaches it already signed. Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md.
 *
 *   connect(transport, {machine, token?, invite?, caps?}) -> Promise<Client>
 *       says hello; resolves once the server answered (the token from a redeemed invite is on client.token)
 *   Client
 *     token, link, room, serverCaps
 *     join({name, role, pubkey}) -> Promise<{ok, rejoin?}>
 *     leave(name, reason) -> Promise<{ok}>
 *     beat(name, {presence?}) -> Promise<{ok}>
 *     append(payload) -> Promise<entry>      (provisional rides in the payload, under the signature)
 *     subscribe(after, hash, onEvent) -> {stop()}     onEvent({ev, data}); a FORK or PROTOCOL error ends it
 *     blobGet(ref) -> Promise<Buffer | null>, blobPut(name, bytes) -> Promise<ref>
 *     close()
 *   A reply with error rejects with RoomError(code, message), the code as the server sent it; a transport
 *   that closed rejects every pending call with OFFLINE.
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

/**
 * @param {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}} transport
 * @param {{machine: string, token?: string, invite?: string, caps?: object}} opts
 * @returns {Promise<object>}
 */
async function connect(transport, opts) { return todo(`client.connect(machine ${opts && opts.machine})`); }

module.exports = { connect };
