'use strict';
/**
 * plugin/sub-human/lib/room/store-mirror.js: MirrorRoomStore, the RoomStore of a room hosted on another machine:
 * an FsRoomStore directory kept byte-identical to the host's log by the link daemon (lib/remote/link.js), so
 * every reader (readView, log.idx, tailer, verifyChain, rows, digests) works unchanged. Only writes cross the
 * wire, as named ops through lib/remote/bridge.js (a sync call from the hook's thread, with a deadline).
 * store.open(code) returns one for a code that lib/room/links.js knows. Stub: filled in by PR5 of
 * docs/next/REMOTE-PLAN.md.
 *
 * Reads: the parent's, over the mirror directory.
 * Writes (RoomError codes in lib/remote/protocol.js CODES):
 *   append(entry, opts)      sign here (the hook's signer, via=human) → op `append` → the placed entry, returned
 *                            once applyLine has written it to the mirror (read-your-writes). OFFLINE past the
 *                            deadline: nothing is queued.
 *   members.join(rec), members.leave(name), members.beat(name, {presence?})   ops
 *   members.update(fn)       HOST_ONLY (orch bookkeeping never runs here)
 *   blobs.put(name, bytes)   op `blob.put`; blobs.get(ref): the mirror's file, else op `blob.get`;
 *   blobs.localPath(ref)     the mirror's file (the daemon prefetches every proposal's plan)
 *   kv.*                     local (rows/*, members/NAME/*, cursors, notices: session-local documents); set/update/
 *                            delete of a streamed document (members, presence/*, tasks) is HOST_ONLY
 *   isHost = false
 * The daemon's writes (lib/remote/link.js only):
 *   applyLine(line)          append one host line verbatim; its prev must hash-chain to the mirror's last line,
 *                            else RoomError FORK and nothing is written
 *   applyDoc(key, value)     write a streamed document (members, presence/NAME, tasks) as the host sent it
 */

const { FsRoomStore } = require('./store.js');

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR5)`); };

class MirrorRoomStore extends FsRoomStore {
  /**
   * @param {string} code
   * @param {{dir?: string, link: object, bridge: {call(op: string, params: object, opts?: object): any}}} opts
   *   link: lib/room/links.js record; bridge: lib/remote/bridge.js createBridge()
   */
  constructor(code, { dir, link, bridge } = {}) {
    super(code, { dir });
    this.link = link || null;
    this.bridge = bridge || null;
    this.isHost = false;
  }

  /** @override sign locally, place on the host, return the placed entry once the mirror holds it. */
  append(entry, opts = {}) { return todo(`MirrorRoomStore.append(${entry && entry.kind}, via ${opts.via})`); }

  /**
   * One verbatim host line into the mirror log (the daemon's subscribe stream).
   * @param {string} line
   * @returns {object} the parsed entry
   */
  applyLine(line) { return todo(`MirrorRoomStore.applyLine(${typeof line})`); }

  /**
   * One streamed document into the mirror's kv (members, presence/NAME, tasks).
   * @param {string} key
   * @param {*} value
   */
  applyDoc(key, value) { return todo(`MirrorRoomStore.applyDoc(${key}, ${typeof value})`); }
}

module.exports = { MirrorRoomStore };
