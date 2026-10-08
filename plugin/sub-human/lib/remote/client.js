'use strict';
/**
 * plugin/sub-human/lib/remote/client.js: the asynchronous side of the protocol, one connection to a room's
 * server over a transport. The link daemon (lib/remote/link.js) holds one per room; the protocol tests drive
 * one directly. Hooks never use it: they call the daemon through lib/remote/bridge.js. It never loads the
 * signer: a via=human payload, and a join's seat proof (lib/remote/auth.js proveSeat), reach it already
 * signed.
 *
 *   connect(transport, {machine, token?, invite?, pin?, caps?, deadlineMs?, helloMs?, proto?, version?}) -> Promise<Client>
 *       hello carries {v, proto, client} (lib/remote/protocol.js): the server picks the version; a version outside
 *       this end's range, or a refusal from a host too old or too new, is PROTOCOL with skewMessage (who must update).
 *       pin: an sh2 invite's PIN (checked by the host, never here). proto / version: fakes for the skew tests.
 *       epoch: the mirror's host epoch (lib/handoff.js), sent in the hello; the server's is client.epoch (0 from a
 *       server that sends none).
 *       transport may also be a Promise of one (lib/remote/transports/index.js open()). Says hello; resolves once the server answered (the token from a redeemed invite is on client.token).
 *       helloMs (default deadlineMs) bounds the hello alone: a transport such as ssh connects before it answers.
 *       A refused hello closes the transport and rejects.
 *   Client
 *     token, link, room, serverCaps, v (the version in use), serverVersion (the host's plugin version, null before 0.4)
 *     request(op, params, {ms}?) -> Promise<result>   one op as the wire has it (the link daemon relays its hooks' ops
 *         so); ms: its own deadline instead of deadlineMs (the daemon waits longer for an @room post sent already)
 *     join({name, role?, pubkey, proof}) -> Promise<{ok, rejoin?}>
 *     leave(name, reason) -> Promise<{ok}>
 *     beat(name, {presence?}) -> Promise<{ok}>
 *     append(payload) -> Promise<entry>
 *     subscribe(after, hash, onEvent) -> {ready: Promise, stop()}   onEvent({ev, data}) for every entry, doc and
 *         end event (protocol.js); ready rejects on a refused subscribe (FORK, AUTH, …) and the stream is
 *         dropped. A transport that closes ends it with {ev: 'end', data: {reason: 'OFFLINE'}}. stop() stops
 *         delivering (the server's stream ends with the transport)
 *     blobGet(ref) -> Promise<Buffer | null>, blobPut(name, bytes) -> Promise<ref>
 *     supports(op) -> bool         the server's hello caps list op (an old server's do not list 'ping')
 *     ping(ms?) -> Promise<{pong, rttMs}>   one heartbeat (protocol.js ping); OFFLINE when no pong within ms
 *         (default deadlineMs). The link daemon pings only when supports('ping') and says hello with caps {ping: true}
 *     closed                        true once the transport closed
 *     drain(ms?) -> Promise          resolves once no call waits for a reply (or after ms, default deadlineMs): the
 *         link daemon closes a replaced connection only then, so a hook's op in flight on it is answered
 *     close()
 *   A reply with error rejects with RoomError(code, message), the code as the server sent it. A call with no
 *   reply within deadlineMs (default LINK_CALL_MS) rejects OFFLINE (its message says the outcome is unknown: the frame
 *   went out and may still land) and its late reply is dropped; a transport
 *   that closed rejects every pending call with OFFLINE. Nothing is retried.
 */

const protocol = require('./protocol.js');
const { RoomError } = require('../room/validate.js');
const { LINK_CALL_MS } = require('../config.js');

const offline = msg => new RoomError('OFFLINE', msg);

class Client {
  constructor(transport, { deadlineMs }) {
    this.transport = transport;
    this.deadlineMs = deadlineMs;
    this.seq = 0;
    this.closed = false;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.streams = new Map(); // subscribe id -> onEvent
    this.token = this.link = this.room = this.serverCaps = this.epoch = null;
    transport.onFrame(f => this._receive(f));
    transport.onClose(() => this._closed());
  }

  _receive(f) {
    if (protocol.isEvent(f)) return this._event(f);
    const p = protocol.isReply(f) && this.pending.get(f.id);
    if (!p) return; // abandoned at its deadline, or not ours
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.error) p.reject(new RoomError(f.error.code, f.error.message));
    else p.resolve(f.result);
  }

  _event({ id, ev, data }) {
    const fn = this.streams.get(id);
    if (!fn) return;
    if (ev === 'end') this.streams.delete(id);
    fn({ ev, data });
  }

  _closed() {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(offline('the link closed')); }
    this.pending.clear();
    const fns = [...this.streams.values()];
    this.streams.clear();
    for (const fn of fns) fn({ ev: 'end', data: { reason: 'OFFLINE' } });
  }

  _request(op, params, id = ++this.seq, ms = this.deadlineMs) {
    if (this.closed) return Promise.reject(offline('the link is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(offline(`${op}: no answer within ${ms} ms; ${protocol.UNKNOWN_OUTCOME}`)); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(protocol.request(id, op, params));
    });
  }

  request(op, params, { ms } = {}) { return this._request(op, params, undefined, ms); }
  join({ name, role = 'member', pubkey, proof }) { return this._request('join', { name, role, pubkey, proof }); }
  leave(name, reason) { return this._request('leave', { name, reason }); }
  beat(name, { presence } = {}) { return this._request('beat', { name, presence }); }
  async append(payload) { return (await this._request('append', { payload })).entry; }

  subscribe(after, hash, onEvent) {
    const id = ++this.seq;
    this.streams.set(id, onEvent);
    const ready = this._request('subscribe', { after, hash }, id).catch(e => { this.streams.delete(id); throw e; });
    return { ready, stop: () => { this.streams.delete(id); } };
  }

  async blobGet(ref) {
    const { bytes } = await this._request('blob.get', { ref });
    return bytes == null ? null : Buffer.from(bytes, 'base64');
  }
  async blobPut(name, bytes) { return (await this._request('blob.put', { name, bytes: Buffer.from(bytes).toString('base64') })).ref; }

  drain(ms = this.deadlineMs) {
    const until = Date.now() + ms;
    return new Promise(resolve => {
      const check = () => (this.closed || !this.pending.size || Date.now() >= until ? resolve() : setTimeout(check, 10));
      check();
    });
  }

  supports(op) { return !!this.serverCaps && Array.isArray(this.serverCaps.ops) && this.serverCaps.ops.includes(op); }
  async ping(ms = this.deadlineMs) {
    const t0 = Date.now();
    const r = await this._request('ping', {}, undefined, ms);
    return { pong: r && r.pong, rttMs: Date.now() - t0 };
  }

  close() { this.transport.close(); }
}

/**
 * @param {object | Promise<object>} transport   {send(frame), onFrame(fn), onClose(fn), close()}, or a Promise of one
 * @param {{machine: string, token?: string, invite?: string, pin?: string, caps?: object, deadlineMs?: number, helloMs?: number, proto?: {min: number, max: number}, version?: string}} opts
 * @returns {Promise<Client>}
 */
async function connect(transport, opts) {
  const { machine, token, invite, pin, epoch, caps = {}, deadlineMs = LINK_CALL_MS, helloMs = deadlineMs } = opts;
  const proto = opts.proto || protocol.PROTO, version = opts.version || protocol.PLUGIN_VERSION;
  const c = new Client(await transport, { deadlineMs });
  const cred = invite !== undefined ? { invite, ...(pin !== undefined ? { pin } : {}) } : token !== undefined ? { token } : {};
  // v: what this hello needs at least. An sh2 invite (its PIN) needs 2; anything else asks for the oldest version this
  // end speaks, so a host from before 0.4 (it checks v === 1 and knows no proto) still answers.
  const need = Math.max(proto.min, pin !== undefined ? 2 : 1);
  const me = { version, proto };
  try {
    let r;
    try {
      r = await c._request('hello', { v: need, proto, client: version, caps, machine, ...cred, ...(Number.isInteger(epoch) ? { epoch } : {}) }, ++c.seq, helloMs);
    } catch (e) {
      throw olderHost(e, me) || e;
    }
    const theirs = protocol.rangeOf({ v: r.v, proto: r.proto });
    if (!theirs || r.v < proto.min || r.v > proto.max || r.v < need) {
      throw new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: r.server, proto: theirs || { min: r.v, max: r.v } }, joiner: me }));
    }
    Object.assign(c, { token: r.token || token || null, link: r.link, room: r.room, serverCaps: r.caps, v: r.v, serverVersion: r.server || null, epoch: Number.isInteger(r.epoch) ? r.epoch : 0 });
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

/** A host from before 0.4 refuses another v with "protocol vN is not served here (vM)": say who must update. */
function olderHost(e, me) {
  const m = e && e.code === 'PROTOCOL' && /protocol v(\d+) is not served here \(v(\d+)\)/.exec(e.message);
  if (!m) return null;
  const v = Number(m[2]);
  return new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: null, proto: { min: v, max: v } }, joiner: me }));
}

module.exports = { connect };
