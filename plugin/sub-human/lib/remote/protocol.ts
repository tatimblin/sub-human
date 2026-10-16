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
 *                                    sh2 invite to the new host, private to that link: lib/handoff.ts), 'snapshot'
 *                                    (data: the host log's snapshot, lib/room/snapshot.ts SnapshotWire: its chain head
 *                                    and line, count, non-chat entries, window, pins, host), sent first and only to a
 *                                    subscribe {after: 0, snapshot: true}; the stream's lines then start after its id
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
 *   CAPS                             what this end serves: {ops: OPS, fields: FIELDS, snapshot: true}
 *   snapshot                         a first sync from the host's snapshot instead of every line (additive, gated by
 *                                    caps, not by v): a mirror with an empty log asks subscribe {after: 0, hash,
 *                                    snapshot: true} only of a host whose caps say snapshot: true; such a host with a
 *                                    snapshot that fits a frame sends the 'snapshot' event, then the lines after it
 *                                    (else the whole log, as to anyone). An older peer on either side never asks or
 *                                    never answers, and gets or gives today's replay. The mirror checks the snapshot,
 *                                    and the lines that follow must chain to its head: FORK otherwise
 *   FIELDS                           entry fields this end's validate accepts that an older host refuses (lib/room/validate.ts):
 *                                    'same' (a proposal's seats that are one person). Gated by caps: a mirror writes one
 *                                    only while its host's hello listed it (the link daemon's document `link` fields,
 *                                    lib/proposal.ts create); an old host's hello lists none
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
 *   EVENTS                           the event names a stream carries: entry doc end handoff moved snapshot
 */

import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { LINK_FRAME_MAX_BYTES } from '../config.ts';
import type {
  FrameId, Op, EventName, WireCode, ProtoRange, PeerVersion, OpParams, RequestFrame, AnyRequest, ResultFrame,
  ErrorFrame, EventData, EventFrame, DecodedFrame, Caps, IncomingRequest,
} from './types-core.ts';

const PROTO: Readonly<ProtoRange> = Object.freeze({ min: 1, max: 2 });
const VERSION = PROTO.max;
const PLUGIN_VERSION: string = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '?'); } catch { return '?'; }
})();

const isVersion = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
/** A hello's fields as they arrived: unchecked. */
interface RangeFields { v?: unknown; proto?: { min?: unknown; max?: unknown } | null }
/** @returns {{min: number, max: number} | null} */
function rangeOf({ v, proto }: RangeFields = {}): ProtoRange | null {
  if (proto && isVersion(proto.min) && isVersion(proto.max) && proto.min <= proto.max) return { min: proto.min, max: proto.max };
  return isVersion(v) ? { min: v, max: v } : null;
}
/** @returns {number | null} */
function negotiate(a: ProtoRange, b: ProtoRange): number | null {
  const v = Math.min(a.max, b.max);
  return v >= Math.max(a.min, b.min) ? v : null;
}
const span = (r: ProtoRange): string => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
const runs = (who: string, x: PeerVersion): string => `${who} ${x.version && x.version !== '?' ? `sub-human ${x.version}` : 'an unknown sub-human version'} (protocol ${span(x.proto)})`;
/** @returns {string} */
function skewMessage({ host, joiner }: { host: PeerVersion; joiner: PeerVersion }): string {
  const fix = joiner.proto.max < host.proto.min
    ? 'Update your plugin: /plugin update sub-human'
    : 'The host must update: ask them to run /plugin update sub-human';
  return `${runs('host runs', host)}; ${runs('you run', joiner).replace(/^you run sub-human /, 'you run ')}. ${fix}`;
}
const OPS: Op[] = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put', 'ping', 'handoff.accept', 'handoff.refuse'];
const EVENTS: EventName[] = ['entry', 'doc', 'end', 'handoff', 'moved', 'snapshot'];
const FIELDS: string[] = ['same'];
const CAPS: Readonly<Caps> = Object.freeze({ ops: OPS, fields: FIELDS, snapshot: true });
const CODES: Readonly<{ [C in WireCode]: C }> = Object.freeze({
  INVALID: 'INVALID', RATE: 'RATE', LOCK: 'LOCK', NO_ROOM: 'NO_ROOM',
  OFFLINE: 'OFFLINE', HOST_ONLY: 'HOST_ONLY', AUTH: 'AUTH', FORK: 'FORK', PROTOCOL: 'PROTOCOL', STALE: 'STALE',
});

const UNKNOWN_OUTCOME = 'the outcome is unknown: it went out and may still land';
/** @returns {boolean} */
const unknownOutcome = (e: unknown): boolean => {
  const x = e as { code?: unknown; unknown?: unknown; message?: unknown } | null | undefined; // any thrown value
  return !!x && x.code === CODES.OFFLINE && (x.unknown === true || String(x.message).includes(UNKNOWN_OUTCOME));
};

/** @returns {{id: number|string, op: string, params: object}} */
function request<O extends Op>(id: FrameId, op: O, params?: OpParams[O]): RequestFrame<O>;
function request(id: FrameId, op: string, params?: object): AnyRequest;
function request(id: FrameId, op: string, params: object = {}): AnyRequest { return { id, op, params }; }
/** @returns {{id: number|string, result: *}} */
const reply = <R>(id: FrameId | undefined, result: R): ResultFrame<R> => ({ id, result });
/** @returns {{id: number|string, error: {code: string, message: string}}} */
const error = (id: FrameId | undefined, code: string, message: unknown): ErrorFrame => ({ id, error: { code, message: String(message) } });
/** @returns {{id: number|string, ev: string, data: *}} */
const event = <E extends EventName>(id: FrameId, ev: E, data: EventData[E]): EventFrame<E> => ({ id, ev, data }) as EventFrame<E>;

/**
 * @param {object} frame
 * @returns {string} one newline-terminated line
 */
const encode = (frame: object): string => JSON.stringify(frame) + '\n';

function parseLine(line: string): DecodedFrame | ErrorFrame {
  if (Buffer.byteLength(line, 'utf8') > LINK_FRAME_MAX_BYTES) return error(null, CODES.PROTOCOL, `a frame over ${LINK_FRAME_MAX_BYTES} bytes`);
  let f: unknown;
  try { f = JSON.parse(line); } catch { return error(null, CODES.PROTOCOL, 'a frame that is not JSON'); }
  return f && typeof f === 'object' && !Array.isArray(f) ? f as DecodedFrame : error(null, CODES.PROTOCOL, 'a frame that is not an object');
}

/** @returns {{push(chunk: string|Buffer): object[]}} */
function decoder(): { push(chunk: string | Buffer): (DecodedFrame | ErrorFrame)[] } {
  const utf8 = new StringDecoder('utf8'); // a character split across two chunks stays whole
  let buf = '';
  return {
    push(chunk: string | Buffer) {
      buf += typeof chunk === 'string' ? chunk : utf8.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() as string; // split gives at least one element
      const frames = lines.filter(Boolean).map(parseLine);
      if (Buffer.byteLength(buf, 'utf8') > LINK_FRAME_MAX_BYTES) { frames.push(parseLine(buf)); buf = ''; }
      return frames;
    },
  };
}

/** A decoded frame's fields, read before the guards below say which frame it is. */
type Fields = { op?: unknown; ev?: unknown; id?: unknown } | null | undefined;
/** A request by its shape: op a string (whether this end serves it is the server's check). */
const isRequest = (f: unknown): f is IncomingRequest => !!f && typeof (f as Fields)!.op === 'string';
const isReply = (f: unknown): f is ResultFrame | ErrorFrame => !!f && (f as Fields)!.op === undefined && (f as Fields)!.ev === undefined && ('result' in (f as object) || 'error' in (f as object));
const isEvent = (f: unknown): f is EventFrame => !!f && typeof (f as Fields)!.ev === 'string';

export {
  PROTO, VERSION, PLUGIN_VERSION, rangeOf, negotiate, skewMessage, OPS, EVENTS, FIELDS, CAPS, CODES, UNKNOWN_OUTCOME,
  unknownOutcome, request, reply, error, event, encode, decoder, isRequest, isReply, isEvent,
};
