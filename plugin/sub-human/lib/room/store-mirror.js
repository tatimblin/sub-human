'use strict';
/**
 * plugin/sub-human/lib/room/store-mirror.js: MirrorRoomStore, the RoomStore of a room hosted on another machine:
 * an FsRoomStore directory kept byte-identical to the host's log by the link daemon (lib/remote/link.js), so
 * every reader (readView, log.idx, tailer, verifyChain, rows, digests) works unchanged. Only writes cross the
 * wire, as named ops through lib/remote/bridge.js (a sync call from the hook's thread, with a deadline) to the
 * daemon's socket. The bridge (a worker thread) starts at the process's first op, so a hook that only reads
 * starts none. store.open(code) returns one for a code that lib/room/links.js knows.
 *
 * Reads: the parent's, over the mirror directory.
 * Writes (RoomError codes in lib/remote/protocol.js CODES; OFFLINE: the daemon or the host is unreachable, and
 * nothing was sent or queued but an @room post (append, opts.queue); a daemon that stopped for good gives its own
 * reason and code, from its document `link`, e.g. AUTH for a refused invite; a deadline that passed after the op
 * went out is OFFLINE with unknown: true (protocol.unknownOutcome): it may still land, and retrying is safe):
 *   append(entry, opts) = place(toPayload(...))   signed here (the hook's signer, via=human), placed by the host:
 *                            op `append`. The placed entry is returned once the mirror holds it (the host streams
 *                            a write's lines before its reply: read-your-writes). A via=system payload is refused
 *                            by the host (AUTH): the host writes the room's own entries. opts.queue (hooks/at-room.js
 *                            only): with the link down the daemon queues an @room post instead of refusing it
 *                            (lib/remote/outbox.js); the signed payload is returned with queued: n and no id. Online, a post the host
 *                            has not answered in time comes back queued: n, slow: true (in flight, kept under
 *                            its nonce: the late copy is the post).
 *   members.join(rec)        op `join` with the seat's public key and a proof (lib/remote/auth.js proveSeat), both
 *                            from the hook's signer; the host logs member_joined. Any RoomError comes back as
 *                            {ok: false, error, code}
 *   members.leave(name, {reason, deadlineMs}?)   op `leave`; the host logs "NAME left (reason)"
 *   members.beat(name, {presence?})   op `beat`, skipped (true) while the lease is younger than SEAT_BEAT_MS and
 *                            presence is unchanged
 *   members.update(fn)       HOST_ONLY (orch bookkeeping never runs here)
 *   blobs.put(name, bytes)   op `blob.put`, then the mirror's copy; blobs.get(ref): the mirror's file, else op
 *                            `blob.get`; has, localPath: the mirror's file (the daemon prefetches every proposal's plan)
 *   kv.*                     local (rows/*, members/NAME/*, cursors, notices, link: session-local documents);
 *                            set/update/delete of a streamed document (members, presence/*, tasks) is HOST_ONLY
 *   request(op, params, {deadlineMs}?)   any other op the daemon relays (lib/remote/link.js RELAY): the planned
 *                            handoff's handoff.accept and handoff.refuse (lib/handoff.js)
 *   isHost = false
 * The daemon's writes (lib/remote/link.js only; it is the mirror's one writer):
 *   applyLine(line)          append one host line verbatim; its prev must hash-chain to the mirror's last line
 *                            and its id follow it, else RoomError FORK and nothing is written
 *   applyDoc(key, value)     write a streamed document (members, presence/NAME, tasks) as the host sent it
 *                            (value null: the document is gone)
 *   applyBlob(ref, bytes)    the mirror's copy of a plan
 *   reset()                  forget everything synced (the log, its checkpoint, the streamed documents), for
 *                            `sub-human link --reset CODE`; session-local documents and plans stay
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { FsRoomStore, RoomError, tag, blobRef, humanKey } = require('./store.js');
const { createBridge } = require('../remote/bridge.js');
const { proveSeat } = require('../remote/auth.js');
const { socketPaths, stopReason } = require('../remote/link.js');
const { unknownOutcome, UNKNOWN_OUTCOME } = require('../remote/protocol.js');
const { SEAT_BEAT_MS } = require('../config.js');

const HANDLER = path.join(__dirname, '..', 'remote', 'link.js');
const streamed = key => key === 'members' || key === 'tasks' || /^presence\/[^/]+$/.test(key);
const hostOnly = what => new RoomError('HOST_ONLY', `${what} runs only on the room's host`);

let bridge = null; // one per process, started by its first op

class MirrorRoomStore extends FsRoomStore {
  /** code: the room code; dir: the mirror's directory (default <home>/rooms/<code>). */
  constructor(code, { dir } = {}) {
    super(code, { dir });
    this.isHost = false;
    const { members, blobs, kv } = this;
    this.members = {
      read: members.read,
      update: () => { throw hostOnly('members.update'); },
      join: rec => this._join(rec),
      leave: (name, { reason = 'left', deadlineMs } = {}) => this._call('leave', { name, reason }, { deadlineMs }).ok,
      beat: (name, { presence } = {}) => this._beat(name, presence),
    };
    this.blobs = {
      ...blobs,
      put: (name, bytes) => this._blobPut(this._call('blob.put', { name, bytes: Buffer.from(bytes).toString('base64') }).ref, bytes),
      get: ref => blobs.get(ref) || this._fetch(ref),
    };
    const local = (what, fn) => (key, ...a) => { if (streamed(key)) throw hostOnly(`${what}("${key}")`); return fn(key, ...a); };
    this.kv = { ...kv, set: local('kv.set', kv.set), update: local('kv.update', kv.update), delete: local('kv.delete', kv.delete) };
  }

  /** @override the host places it: op `append`. opts.queue (an @room post): while the link is down the daemon may
   * queue it (lib/remote/outbox.js); the payload comes back with `queued: n` (the posts waiting) and no id. */
  place(payload, { queue } = {}) {
    const r = this._call('append', queue ? { payload, queue: true } : { payload });
    return r.queued ? { ...payload, queued: r.queued, ...(r.slow ? { slow: true } : {}) } : tag(r.entry, this);
  }

  /** An op the daemon relays to the host as it is (lib/handoff.js: handoff.accept, handoff.refuse). */
  request(op, params, opts) { return this._call(op, params, opts); }

  /** The daemon's document `link` (its socket path first: lib/remote/link.js socketPaths), null when unreadable. */
  _linkDoc() { try { return this.kv.get('link'); } catch { return null; } }

  /** One op over the bridge to this room's link daemon (the socket it recorded, then the computed paths). */
  _call(op, params, { deadlineMs } = {}) {
    bridge = bridge || createBridge({ handler: HANDLER });
    try {
      return bridge.call(op, { socket: socketPaths(this.dir, this._linkDoc()), params }, { deadlineMs });
    } catch (e) {
      if (e.code !== 'OFFLINE') throw e;
      if (unknownOutcome(e)) { // it went out: never "nothing was sent" (a slow link lands it later)
        throw Object.assign(new RoomError('OFFLINE', `room ${this.code}: no answer from the host in time (a slow link); ${UNKNOWN_OUTCOME}`), { unknown: true });
      }
      const why = stopReason(this.kv.get('link')); // the daemon stopped for good (an invite refused, a fork): say why
      if (why) throw new RoomError(why.code, `the link to room ${this.code} stopped: ${why.reason}; nothing was sent`);
      throw new RoomError('OFFLINE', `room ${this.code} is offline (${e.message}); nothing was sent`);
    }
  }

  _join({ name, role }) {
    const key = humanKey(this.code, name);
    const pubkey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
    try {
      return this._call('join', { name, role, pubkey, proof: proveSeat(key, { room: this.code, name, pubkey }) });
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      return { ok: false, error: e.message, code: e.code };
    }
  }

  _beat(name, presence) {
    const m = this.members.read()[name];
    if (!m || m.left_at) return false;
    const fresh = Date.parse(m.seen_at) > Date.now() - SEAT_BEAT_MS;
    const cur = presence && this.kv.get(`presence/${name}`);
    if (fresh && (!presence || (cur && cur.state === presence.state && (cur.detail || null) === (presence.detail || null)))) return true;
    return this._call('beat', { name, presence }).ok;
  }

  _fetch(ref) {
    const r = blobRef(ref);
    if (!r) return null;
    const { bytes } = this._call('blob.get', { ref: r });
    return bytes == null ? null : Buffer.from(bytes, 'base64');
  }

  /**
   * One verbatim host line into the mirror log (the daemon's subscribe stream).
   * @param {string} line
   * @returns {object} the parsed entry
   */
  applyLine(line) {
    let e;
    try { e = JSON.parse(line); } catch { throw new RoomError('PROTOCOL', 'the host sent a log line that is not JSON'); }
    const last = this.lastId();
    if (!(e.id > last) || (e.prev !== undefined && e.prev !== this.lineHash(last))) {
      throw new RoomError('FORK', `the host's line ${e.id} does not follow this mirror's line ${last}; re-mirror with sub-human link --reset ${this.code}`);
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.logFile, line + '\n', { mode: 0o600 });
    return tag(e, this);
  }

  /**
   * One streamed document into the mirror (members, presence/NAME, tasks).
   * @param {string} key
   * @param {*} value
   */
  applyDoc(key, value) {
    if (!streamed(key)) throw new RoomError('PROTOCOL', `the host streamed "${key}", which is not a room document`);
    if (key === 'members') return this._updateMembers(() => value || {});
    if (value === null) return fs.rmSync(this._kvFile(key), { force: true });
    return this._kvSet(key, value);
  }

  /**
   * The mirror's copy of a plan (the daemon's prefetch).
   * @param {string} ref
   * @param {Buffer} bytes
   */
  applyBlob(ref, bytes) { return this._blobPut(ref, bytes); }

  reset() {
    for (const f of [this.logFile, this._idxPath, this._membersFile]) fs.rmSync(f, { force: true });
    for (const key of ['tasks', ...this.kv.list('presence/')]) fs.rmSync(this._kvFile(key), { force: true });
  }
}

module.exports = { MirrorRoomStore };
