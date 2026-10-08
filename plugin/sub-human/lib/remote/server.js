'use strict';
/**
 * plugin/sub-human/lib/remote/server.js: one connection to a hosted room. `bin/sub-human serve --stdio CODE`
 * runs one per connection on the host (spawned by the client's pipe transport now, by an SSH forced command
 * later); the store contract test runs one on a worker thread over the memory transport. It serves the host's
 * FsRoomStore (isHost) and shares the room's file locks with the host's own hooks, which never go through it.
 * It never loads the signer (test/hooks/security.test.js): a via=human payload arrives signed by the remote
 * hook and is verified against the key pinned in the log (lib/room/envelope.js), then placed (store.place).
 *
 *   serve(transport, {store, log?}) -> {close()}
 *       A Session over one transport (lib/remote/transports/*): unauthenticated until hello {token | invite}
 *       (lib/remote/auth.js); every other op before that is AUTH. store is the room's store as store.open(code)
 *       gives it in this process: seats and decide reach the room through that too. Ops:
 *         hello      version check (protocol.VERSION, else PROTOCOL); verifyToken or redeemInvite (the token is
 *                    returned once); neither: answered, but the session stays unauthenticated
 *         join       {name, role: 'member', pubkey, proof}: auth.checkSeatProof, then lib/seats.js enter() with
 *                    machine = the link's (no pid: the seat lives by its lease); a key other than the pinned one
 *                    is AUTH; bindSeat
 *         leave      seats.exit(), own seat only
 *         beat       store.members.beat(name, {presence?}), own seat only
 *         append     own `from` only; store.place() (validate, rate, replay, verify against the pinned key); a
 *                    signoff or objection is followed by lib/proposal.js decide() (host only, idempotent). A system
 *                    kind from a link is AUTH (the host writes those)
 *         subscribe  {after, hash}: hash12 of the host's line `after` must equal hash (store.lineHash), else
 *                    FORK; then event 'entry' per line in id order (store.tailer({after}), verbatim), event
 *                    'doc' for members (lib/room/members.js publicView), presence/NAME and tasks when they
 *                    change (all three at the start), 'end' {reason: 'closed'} when the room's orch is stopped
 *                    or {reason: 'FORK'} when the host log is reset. Polls every FOLLOW_POLL_MS until the
 *                    transport closes
 *         blob.get   store.blobs.get(ref), base64;  blob.put  {name, bytes}: name must be plans/<hash12>.md of
 *                    the bytes (content-addressed, at most PROPOSAL_FILE_MAX), written once
 *       An op that throws a RoomError (a protocol CODES code) answers {error: {code, message}} with the same
 *       code; any other error is INVALID with the message and is logged. A frame that is not a request is
 *       answered PROTOCOL. close() ends the streams and the transport.
 */

const protocol = require('./protocol.js');
const auth = require('./auth.js');
const seats = require('../seats.js');
const proposal = require('../proposal.js');
const members = require('../room/members.js');
const envelope = require('../room/envelope.js');
const { RoomError, hash12 } = require('../room/store.js');
const { FOLLOW_POLL_MS, PROPOSAL_FILE_MAX } = require('../config.js');

const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWERS = new Set(['signoff', 'objection']);
const WIRE_CODES = new Set(Object.values(protocol.CODES));
const authError = msg => new RoomError('AUTH', msg);
const invalid = msg => new RoomError('INVALID', msg);

function own(s, name) {
  if (!auth.mayWriteAs(s.link, name)) throw authError(`${name} has not joined over this link`);
}

function redeem(store, invite, machine) {
  const inv = auth.parseInvite(invite);
  if (!inv || inv.code !== store.code) throw authError(`not an invite to room ${store.code}`);
  return auth.redeemInvite(store, inv.secret, { machine });
}

function known(store, token) {
  const link = auth.verifyToken(store, token);
  if (!link) throw authError('unknown link token; ask the host for a new invite');
  return { link };
}

// ---------- the subscribe stream ----------
/** The host documents a mirror holds, as other machines may see them: key -> value. */
function docsOf(store) {
  const docs = new Map([['members', members.publicView(store.members.read())], ['tasks', store.kv.get('tasks')]]);
  for (const k of store.kv.list('presence/')) docs.set(k, store.kv.get(k));
  return docs;
}
const stopped = ms => !!(ms.orch && ms.orch.stopped_at);

/** Stream subscribe request `id`'s events from the line after `after`. Returns stop(). */
function stream(s, id, after) {
  const tailer = s.store.tailer({ after });
  const sent = new Map(); // doc key -> the JSON last sent
  let wasStopped = stopped(s.store.members.read());
  const send = (ev, data) => s.transport.send(protocol.event(id, ev, data));
  const end = reason => { send('end', { reason }); stop(); };

  function sendDocs(docs) {
    for (const key of new Set([...sent.keys(), ...docs.keys()])) {
      const value = docs.has(key) ? docs.get(key) : null;
      const json = JSON.stringify(value);
      if (sent.get(key) !== json) { sent.set(key, json); send('doc', { key, value }); }
    }
  }
  function tick() {
    const { lines, reset } = tailer.poll();
    if (reset) return end('FORK');
    for (const line of lines) send('entry', line);
    const docs = docsOf(s.store);
    sendDocs(docs);
    const now = stopped(docs.get('members'));
    if (now && !wasStopped) return end('closed');
    wasStopped = now;
  }
  const safeTick = () => { try { tick(); } catch (e) { s.log(`sub-human serve: subscribe: ${e && e.stack || e}`); } };
  const first = setImmediate(safeTick); // after the subscribe reply
  const timer = setInterval(safeTick, FOLLOW_POLL_MS);
  function stop() { clearImmediate(first); clearInterval(timer); s.streams.delete(stop); }
  return stop;
}

// ---------- ops ----------
const OPS = {
  hello(s, { v, machine, token, invite }) {
    if (v !== protocol.VERSION) throw new RoomError('PROTOCOL', `protocol v${v} is not served here (v${protocol.VERSION})`);
    if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) throw invalid('hello needs this machine\'s id');
    s.link = null;
    const r = invite !== undefined ? redeem(s.store, invite, machine) : token !== undefined ? known(s.store, token) : { link: null };
    s.link = r.link;
    const out = { v: protocol.VERSION, caps: protocol.CAPS, room: s.store.code, link: r.link ? r.link.id : null };
    if (r.token) out.token = r.token;
    return out;
  },

  join(s, { name, role = 'member', pubkey, proof }) {
    if (role !== 'member') throw invalid('a link joins members only');
    if (!envelope.parseKey(pubkey)) throw invalid('join needs the seat\'s public key (Ed25519 SPKI PEM)');
    auth.checkSeatProof(proof, { room: s.store.code, name, pubkey });
    const r = seats.enter({ code: s.store.code, name, machine: s.link.machine, pubkey });
    if (!r.ok) throw new RoomError(r.code || 'INVALID', r.error);
    s.link = auth.bindSeat(s.store, s.link.id, name);
    return r.rejoin ? { ok: true, rejoin: true } : { ok: true };
  },

  leave(s, { name, reason = 'left' }) {
    own(s, name);
    if (typeof reason !== 'string') throw invalid('reason must be a string');
    return { ok: seats.exit(s.store.code, name, reason) };
  },

  beat(s, { name, presence }) {
    own(s, name);
    return { ok: s.store.members.beat(name, { presence }) };
  },

  append(s, { payload }) {
    if (!payload || typeof payload !== 'object') throw invalid('append needs {payload}');
    own(s, payload.from);
    if (payload.via === 'system') throw authError('a link never writes via "system"; the host writes the room\'s own entries');
    const entry = s.store.place(payload);
    if (ANSWERS.has(entry.kind)) {
      try { proposal.decide(s.store.code, entry.proposal_hash); } catch (e) { s.log(`sub-human serve: decide: ${e && e.stack || e}`); }
    }
    return { entry };
  },

  subscribe(s, { after, hash }, id) {
    if (!Number.isInteger(after) || after < 0) throw invalid('subscribe needs {after: id, hash}');
    if (s.store.lineHash(after) !== hash) {
      throw new RoomError('FORK', `the host's line ${after} is not the mirror's; re-mirror with sub-human link --reset ${s.store.code}`);
    }
    s.streams.add(stream(s, id, after));
    return { ok: true };
  },

  'blob.get'(s, { ref }) {
    const b = s.store.blobs.get(ref);
    return { bytes: b ? b.toString('base64') : null };
  },

  'blob.put'(s, { name, bytes }) {
    if (typeof bytes !== 'string') throw invalid('blob.put needs {name, bytes: base64}');
    const buf = Buffer.from(bytes, 'base64');
    if (buf.length > PROPOSAL_FILE_MAX) throw invalid(`a blob is at most ${PROPOSAL_FILE_MAX} bytes`);
    if (name !== `plans/${hash12(buf)}.md`) throw invalid('a blob is named by its content: plans/<hash12 of the bytes>.md');
    if (!s.store.blobs.has(name)) s.store.blobs.put(name, buf);
    return { ref: name };
  },
};

// ---------- the session ----------
class Session {
  constructor(transport, store, log) {
    this.transport = transport;
    this.store = store;
    this.log = log;
    this.link = null;
    this.streams = new Set(); // stop functions
    transport.onFrame(f => this.receive(f));
    transport.onClose(() => this.stop());
  }

  receive(f) {
    if (!protocol.isRequest(f)) {
      return this.transport.send(protocol.error(f.id ?? null, 'PROTOCOL', f.error ? f.error.message : 'expected a request {id, op, params}'));
    }
    let out;
    try { out = protocol.reply(f.id, this.run(f)); } catch (e) { out = this.failure(f, e); }
    this.transport.send(out);
  }

  run({ id, op, params }) {
    if (!Object.hasOwn(OPS, op)) throw new RoomError('PROTOCOL', `unknown op "${op}"`);
    if (op !== 'hello' && !this.link) throw authError('say hello with this link\'s token first');
    return OPS[op](this, params && typeof params === 'object' ? params : {}, id);
  }

  failure(f, e) {
    if (e && WIRE_CODES.has(e.code)) return protocol.error(f.id, e.code, e.message);
    this.log(`sub-human serve: ${f.op}: ${e && e.stack || e}`);
    return protocol.error(f.id, 'INVALID', (e && e.message) || String(e));
  }

  stop() { for (const stop of [...this.streams]) stop(); }
}

/**
 * @param {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}} transport
 * @param {{store: import('../room/store.js').FsRoomStore, log?: (...a: any[]) => void}} ctx
 * @returns {{close(): void}}
 */
function serve(transport, { store, log = () => {} }) {
  const session = new Session(transport, store, log);
  return { close() { session.stop(); transport.close(); } };
}

module.exports = { serve };
