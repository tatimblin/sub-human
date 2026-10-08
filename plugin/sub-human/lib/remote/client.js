'use strict';
/**
 * plugin/sub-human/lib/remote/client.js: the asynchronous side of the protocol, one connection to a room's
 * server over a transport. The link daemon (lib/remote/link.js) holds one per room; the protocol tests drive
 * one directly. Hooks never use it: they call the daemon through lib/remote/bridge.js. It never loads the
 * signer: a via=human payload, and a join's seat proof (lib/remote/auth.js proveSeat), reach it already
 * signed.
 *
 *   connect(transport, {machine, token?, invite?, caps?, deadlineMs?, helloMs?}) -> Promise<Client>
 *       transport may also be a Promise of one (lib/remote/transports/index.js open()). Says hello; resolves once the server answered (the token from a redeemed invite is on client.token).
 *       helloMs (default deadlineMs) bounds the hello alone: a transport such as ssh connects before it answers.
 *       A refused hello closes the transport and rejects.
 *   Client
 *     token, link, room, serverCaps
 *     request(op, params) -> Promise<result>   one op as the wire has it (the link daemon relays its hooks' ops so)
 *     join({name, role?, pubkey, proof}) -> Promise<{ok, rejoin?}>
 *     leave(name, reason) -> Promise<{ok}>
 *     beat(name, {presence?}) -> Promise<{ok}>
 *     append(payload) -> Promise<entry>
 *     subscribe(after, hash, onEvent) -> {ready: Promise, stop()}   onEvent({ev, data}) for every entry, doc and
 *         end event (protocol.js); ready rejects on a refused subscribe (FORK, AUTH, …) and the stream is
 *         dropped. A transport that closes ends it with {ev: 'end', data: {reason: 'OFFLINE'}}. stop() stops
 *         delivering (the server's stream ends with the transport)
 *     blobGet(ref) -> Promise<Buffer | null>, blobPut(name, bytes) -> Promise<ref>
 *     close()
 *   A reply with error rejects with RoomError(code, message), the code as the server sent it. A call with no
 *   reply within deadlineMs (default LINK_CALL_MS) rejects OFFLINE and its late reply is dropped; a transport
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
    this.token = this.link = this.room = this.serverCaps = null;
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(offline(`${op}: no answer within ${ms} ms`)); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(protocol.request(id, op, params));
    });
  }

  request(op, params) { return this._request(op, params); }
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

  close() { this.transport.close(); }
}

/**
 * @param {object | Promise<object>} transport   {send(frame), onFrame(fn), onClose(fn), close()}, or a Promise of one
 * @param {{machine: string, token?: string, invite?: string, caps?: object, deadlineMs?: number, helloMs?: number}} opts
 * @returns {Promise<Client>}
 */
async function connect(transport, { machine, token, invite, caps = {}, deadlineMs = LINK_CALL_MS, helloMs = deadlineMs }) {
  const c = new Client(await transport, { deadlineMs });
  const cred = invite !== undefined ? { invite } : token !== undefined ? { token } : {};
  try {
    const r = await c._request('hello', { v: protocol.VERSION, caps, machine, ...cred }, ++c.seq, helloMs);
    if (r.v !== protocol.VERSION) throw new RoomError('PROTOCOL', `the server speaks protocol v${r.v}, not v${protocol.VERSION}`);
    Object.assign(c, { token: r.token || token || null, link: r.link, room: r.room, serverCaps: r.caps });
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

module.exports = { connect };
