/**
 * plugin/sub-human/lib/remote/protocol.ts: the wire protocol between a link (lib/remote/client.ts, on the
 * machine of a remote member) and a room's server (lib/remote/server.ts, on the host): the ops, the frame
 * shapes, the error codes and the line codec. Transport-agnostic (lib/remote/transports/*). Zero
 * dependencies beyond node:string_decoder and lib/config.ts.
 *
 * Frames, one JSON object per line (as mcp/room-server.ts speaks):
 *   request  {id, op, params}        reply {id, result} | {id, error: {code, message}}
 *   event    {id, ev, data}          a subscribe stream (id: the subscribe request's): ev 'entry' (data: the host
 *                                    line, verbatim), 'doc' (data: {key, value}: members, presence/NAME, tasks;
 *                                    value null for a document that is gone), 'end' (data: {reason}: 'closed',
 *                                    the room's Claude was stopped; 'FORK', the host log was reset under the stream;
 *                                    'moved', the room moved to another host: a 'moved' event came first),
 *                                    'handoff' (data: the host's ask that one of this link's seats host the room:
 *                                    {id, from, to, epoch, locator?, expires_at}; private to that link, never in the
 *                                    log), 'moved' (data: {epoch, host, machine, locator, invite | null}: the room
 *                                    moved, after its host_changed line; invite is this link's machine's single-use
 *                                    sh2 invite to the new host, private to that link: lib/handoff.ts)
 *   epoch                            hello and append may carry the mirror's host epoch (lib/handoff.ts); the hello
 *                                    reply carries the server's. A hello from a later epoch, or an append from another,
 *                                    is STALE (a host the room moved away from, or a copy not caught up)
 *   PROTO = {min: 1, max: 2}         the protocol versions this end speaks. hello carries {v, proto, client, caps}:
 *                                    v the version the client needs at least (1, or 2 for an sh2 invite: a host
 *                                    before 0.4 checks v === 1 and has no proto), proto its range, client its plugin
 *                                    version. The server answers {v, proto, server, caps, time}: time its clock (ms; additive,
 *                                    for the skew sub-human doctor reports), v = negotiate() of the two
 *                                    ranges (a hello without proto is the range [v, v]); no overlap is PROTOCOL with
 *                                    skewMessage(), which names the side that must update. v2: the sh2 invite and its PIN
 *   VERSION = PROTO.max              (kept for callers that name one version)
 *   PLUGIN_VERSION                   this plugin's version (.claude-plugin/plugin.json), '?' when unreadable
 *   negotiate(a, b) -> v | null      the highest version in both ranges {min, max}, null when they do not overlap
 *   rangeOf(params) -> {min, max} | null   a hello's range: its proto when well formed, else [v, v]
 *   skewMessage({host, joiner}) -> string   {version, proto} each: "host runs sub-human 0.4.0 (protocol 3–4); you run
 *                                    0.3.0 (protocol 2). Update your plugin: /plugin update sub-human" (or "The host
 *                                    must update …" when the joiner is the newer side)
 *   CAPS                             what this end serves: {ops: OPS}
 *   OPS                              hello join leave beat append subscribe blob.get blob.put ping handoff.accept
 *                                    handoff.refuse (caps-gated: a target sends them only to a server that lists them)
 *   ping                             the app-level heartbeat: request {op: 'ping'} -> reply {pong: <host ms>} (the
 *                                    pong). Gated by caps, not by v: a client pings only a server whose caps.ops
 *                                    lists 'ping', and says hello with caps {ping: true} when it pings, so the
 *                                    server may close a session that then goes silent (LINK_SILENT_MS). An old
 *                                    peer on either side never sees one
 *   CODES                            RoomError codes on both ends and on the wire, unchanged:
 *                                    INVALID RATE LOCK NO_ROOM (today's) + OFFLINE HOST_ONLY AUTH FORK PROTOCOL
 *                                    STALE (a write or hello from another host epoch than the server's)
 *   UNKNOWN_OUTCOME, unknownOutcome(err) -> bool   an OFFLINE whose request went out but got no answer in time (a slow
 *                                    link, a deadline): it may still land, so it is never "nothing was sent". The
 *                                    phrase rides in the message, so it survives the bridge and the daemon's socket
 *   request(id, op, params), reply(id, result), error(id, code, message), event(id, ev, data) -> frame
 *   encode(frame) -> string          one line, newline-terminated
 *   decoder() -> {push(chunk) -> frame[]}   buffers partial lines; a malformed line, or one longer than
 *                                    LINK_FRAME_MAX_BYTES, is a PROTOCOL error frame (id null) in its place
 *   isRequest(f), isReply(f), isEvent(f)
 *   EVENTS                           the event names a stream carries: entry doc end handoff moved
 */

import { StringDecoder } from 'node:string_decoder';
import { LINK_FRAME_MAX_BYTES } from '../config.ts';

const PROTO = Object.freeze({ min: 1, max: 2 });
const VERSION = PROTO.max;
const PLUGIN_VERSION = (() => {
  try { return String(require('../../.claude-plugin/plugin.json').version || '?'); } catch { return '?'; }
})();

const isVersion = n => Number.isInteger(n) && n >= 1 && n <= 1000;
/** @returns {{min: number, max: number} | null} */
function rangeOf({ v, proto } = {}) {
  if (proto && isVersion(proto.min) && isVersion(proto.max) && proto.min <= proto.max) return { min: proto.min, max: proto.max };
  return isVersion(v) ? { min: v, max: v } : null;
}
/** @returns {number | null} */
function negotiate(a, b) {
  const v = Math.min(a.max, b.max);
  return v >= Math.max(a.min, b.min) ? v : null;
}
const span = r => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
const runs = (who, x) => `${who} ${x.version && x.version !== '?' ? `sub-human ${x.version}` : 'an unknown sub-human version'} (protocol ${span(x.proto)})`;
/** @returns {string} */
function skewMessage({ host, joiner }) {
  const fix = joiner.proto.max < host.proto.min
    ? 'Update your plugin: /plugin update sub-human'
    : 'The host must update: ask them to run /plugin update sub-human';
  return `${runs('host runs', host)}; ${runs('you run', joiner).replace(/^you run sub-human /, 'you run ')}. ${fix}`;
}
const OPS = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put', 'ping', 'handoff.accept', 'handoff.refuse'];
const EVENTS = ['entry', 'doc', 'end', 'handoff', 'moved'];
const CAPS = Object.freeze({ ops: OPS });
const CODES = Object.freeze({
  INVALID: 'INVALID', RATE: 'RATE', LOCK: 'LOCK', NO_ROOM: 'NO_ROOM',
  OFFLINE: 'OFFLINE', HOST_ONLY: 'HOST_ONLY', AUTH: 'AUTH', FORK: 'FORK', PROTOCOL: 'PROTOCOL', STALE: 'STALE',
});

const UNKNOWN_OUTCOME = 'the outcome is unknown: it went out and may still land';
/** @returns {boolean} */
const unknownOutcome = e => !!e && e.code === CODES.OFFLINE && (e.unknown === true || String(e.message).includes(UNKNOWN_OUTCOME));

/** @returns {{id: number|string, op: string, params: object}} */
const request = (id, op, params = {}) => ({ id, op, params });
/** @returns {{id: number|string, result: *}} */
const reply = (id, result) => ({ id, result });
/** @returns {{id: number|string, error: {code: string, message: string}}} */
const error = (id, code, message) => ({ id, error: { code, message: String(message) } });
/** @returns {{id: number|string, ev: string, data: *}} */
const event = (id, ev, data) => ({ id, ev, data });

/**
 * @param {object} frame
 * @returns {string} one newline-terminated line
 */
const encode = frame => JSON.stringify(frame) + '\n';

function parseLine(line) {
  if (Buffer.byteLength(line, 'utf8') > LINK_FRAME_MAX_BYTES) return error(null, CODES.PROTOCOL, `a frame over ${LINK_FRAME_MAX_BYTES} bytes`);
  let f;
  try { f = JSON.parse(line); } catch { return error(null, CODES.PROTOCOL, 'a frame that is not JSON'); }
  return f && typeof f === 'object' && !Array.isArray(f) ? f : error(null, CODES.PROTOCOL, 'a frame that is not an object');
}

/** @returns {{push(chunk: string|Buffer): object[]}} */
function decoder() {
  const utf8 = new StringDecoder('utf8'); // a character split across two chunks stays whole
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : utf8.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop();
      const frames = lines.filter(Boolean).map(parseLine);
      if (Buffer.byteLength(buf, 'utf8') > LINK_FRAME_MAX_BYTES) { frames.push(parseLine(buf)); buf = ''; }
      return frames;
    },
  };
}

const isRequest = f => !!f && typeof f.op === 'string';
const isReply = f => !!f && f.op === undefined && f.ev === undefined && ('result' in f || 'error' in f);
const isEvent = f => !!f && typeof f.ev === 'string';

export {
  PROTO, VERSION, PLUGIN_VERSION, rangeOf, negotiate, skewMessage, OPS, EVENTS, CAPS, CODES, UNKNOWN_OUTCOME,
  unknownOutcome, request, reply, error, event, encode, decoder, isRequest, isReply, isEvent,
};
