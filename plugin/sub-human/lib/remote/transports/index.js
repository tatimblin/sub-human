'use strict';
/**
 * plugin/sub-human/lib/remote/transports/index.js: the transport contract and the registry of kinds. A transport
 * carries protocol frames (lib/remote/protocol.js) between a client and a server and knows nothing about
 * them. Built in: memory (./memory.js, a pair in one process or across worker threads), pipe (./pipe.js, a
 * child's stdio or this process's), ssh (./ssh.js, the pipe kind with an `ssh` command in front), and wss / ws
 * (./ws.js, a Noise_NK channel to the host's listener inside a WebSocket, through a TLS front such as Tailscale Serve).
 *
 *   Transport = {send(frame), onFrame(fn), onClose(fn), close()}
 *       send after close is a no-op; onClose fires once, also when the peer ends
 *   Spec = {kind, ...}   what a kind needs to connect. An invite's locator `KIND:REST` parses to one, and a link
 *       file (lib/room/links.js `transport`) keeps it: {kind: 'pipe', home} | {kind: 'ssh', user, host, port?, via?}.
 *       memory ({kind: 'memory', port}) and a plain pipe ({kind: 'pipe', cmd: [bin, ...args], env?, cwd?}) are
 *       for tests and have no locator.
 *
 *   register(kind, {open, parse?, describe?})   add a kind (a kind registered twice is an error):
 *       open(spec, ctx) -> Transport | Promise<Transport>   connect; ctx = {code} when the link daemon connects
 *           to room CODE (lib/remote/link.js connectLink), else {}. May be async: a transport that connects
 *           (a socket, a WebSocket, a handshake) resolves once it can carry frames; client.connect then says hello
 *       parse(rest) -> Spec | null    the Spec for locator `kind:rest`, null when rest is not acceptable. Without
 *           parse the kind has no locator (an invite cannot name it). Invites are untrusted: accept only plain values
 *       describe(spec) -> string      a short human line ("ssh me@far:2222") for logs and diagnostics
 *   kinds() -> string[]               the registered kinds, in registration order; KINDS is the same, read live
 *   get(kind) -> entry | null
 *   parse(locator) -> Spec | null     by the kind before the first ":"; null for an unknown kind or a refused rest
 *   open(spec, ctx = {}) -> Promise<Transport>   rejects RoomError INVALID for an unknown kind, else as the kind's open
 *   describe(spec) -> string          the kind's describe, else its kind
 *   lineTransport({write, shut}) -> {transport, receive(chunk), end()}   the shared half of every kind: write(line)
 *       sends one encoded frame, shut() releases the kind's resources at close(); the kind feeds what arrives
 *       to receive() (decoded, protocol.decoder) and calls end() when the other side is gone
 *   fromDuplex(stream, {readable?}?) -> Transport   frames over any node stream pair: written to stream, read from
 *       readable (default stream itself: a net.Socket, a tls socket, a stream from a WebSocket). Its end, close or
 *       error closes the transport; close() ends and destroys both. A new socket kind is then:
 *         register('tcp', { parse: rest => …, open: spec => new Promise((ok, no) => {
 *           const s = net.connect(spec.port, spec.host, () => ok(fromDuplex(s))); s.once('error', no); }) });
 */

const protocol = require('../protocol.js');
const { RoomError } = require('../../room/validate.js');

const registry = new Map(); // kind -> {open, parse?, describe?}

const KIND_RE = /^[a-z][a-z0-9-]{0,15}$/;

function register(kind, entry) {
  if (!KIND_RE.test(String(kind))) throw new Error(`transport kind "${kind}" is not a short lower-case name`);
  if (registry.has(kind)) throw new Error(`transport kind "${kind}" is registered already`);
  if (!entry || typeof entry.open !== 'function') throw new Error(`transport kind "${kind}" needs open(spec, ctx)`);
  registry.set(kind, { open: entry.open, parse: entry.parse || null, describe: entry.describe || null });
}

const kinds = () => [...registry.keys()];
const get = kind => registry.get(kind) || null;

/**
 * @param {string} locator
 * @returns {object | null}
 */
function parse(locator) {
  const s = String(locator);
  const i = s.indexOf(':');
  const e = i > 0 && get(s.slice(0, i));
  if (!e || !e.parse) return null;
  const spec = e.parse(s.slice(i + 1));
  return spec ? { ...spec, kind: s.slice(0, i) } : null;
}

/**
 * @param {{kind: string}} spec
 * @param {{code?: string}} [ctx]
 * @returns {Promise<{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}>}
 */
async function open(spec, ctx = {}) {
  const e = get(spec && spec.kind);
  if (!e) throw new RoomError('INVALID', `unknown transport "${spec && spec.kind}" (${kinds().join(', ')})`);
  return e.open(spec, ctx);
}

function describe(spec) {
  const e = get(spec && spec.kind);
  return e && e.describe ? e.describe(spec) : String(spec && spec.kind);
}

function lineTransport({ write, shut }) {
  const frameFns = [], closeFns = [];
  const dec = protocol.decoder();
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  const transport = {
    send(frame) { if (!closed) write(protocol.encode(frame)); },
    onFrame(fn) { frameFns.push(fn); },
    onClose(fn) { closeFns.push(fn); },
    close() { if (!closed) { shut(); end(); } },
  };
  const receive = chunk => { for (const f of dec.push(chunk)) for (const fn of frameFns) fn(f); };
  return { transport, receive, end };
}

function fromDuplex(stream, { readable = stream } = {}) {
  const { transport, receive, end } = lineTransport({
    write: line => stream.write(line),
    shut: () => { stream.end(); stream.destroy(); if (readable !== stream) readable.destroy(); },
  });
  readable.on('data', receive);
  for (const s of new Set([stream, readable])) { s.on('end', end); s.on('close', end); s.on('error', end); }
  return transport;
}

module.exports = {
  register, kinds, get, parse, open, describe, lineTransport, fromDuplex,
  get KINDS() { return kinds(); },
};

// ---------- the built-in kinds ----------
// Their modules require this one (lineTransport), so each loads on first use, through its `kind` export.
const lazy = file => ({
  open: (spec, ctx) => require(file).kind.open(spec, ctx),
  parse: rest => require(file).kind.parse(rest),
  describe: spec => require(file).kind.describe(spec),
});
register('memory', { open: spec => require('./memory.js').over(spec.port), describe: () => 'memory' });
register('pipe', lazy('./pipe.js'));
register('ssh', lazy('./ssh.js'));
register('wss', lazy('./ws.js')); // ./ws.js: a Noise channel in a WebSocket, through a TLS front
register('ws', lazy('./ws.js'));
