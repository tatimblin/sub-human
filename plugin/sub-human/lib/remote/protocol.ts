/**
 * plugin/sub-human/lib/remote/protocol.ts: the wire protocol between a link (lib/remote/client.ts, on the
 * machine of a remote member) and a room's server (lib/remote/server.ts, on the host): the ops, the frame
 * shapes, the error codes and the line codec. Transport-agnostic (lib/remote/transports/*). Zero
 * dependencies beyond node:string_decoder, lib/config.ts, lib/reasons.ts and RoomError.
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
 *   PROTO = {min: 1, max: 3}         the protocol versions this end speaks. hello carries {proto, client, caps}: proto
 *                                    its range, client its plugin version (a peer may also send v, the version it needs
 *                                    at least, which the server honours). The server answers {v, proto, server, caps,
 *                                    time}: time its clock (ms, for the skew sub-human doctor reports), v = negotiate()
 *                                    of the two ranges; no overlap, or a hello with no proto, is PROTOCOL (reason SKEW)
 *                                    with skewMessage(), which names the side that must update. v2: the sh2 invite and
 *                                    its PIN. v3: an invite line's SECRET word in hello's invite and its PIN (checked
 *                                    online, lib/remote/invites.ts), as {name, label}, nonce -> the reply's host (the
 *                                    host home's machine key over the nonce), and over the web Noise XK with a key of
 *                                    the link's own (lib/remote/transports/ws.ts). A link made under v2 (a token, NK)
 *                                    keeps working at v2 or v3 until it is invited again or revoked; a v3 invite is
 *                                    refused below v3 (PROTOCOL SKEW)
 *   VERSION = PROTO.max              (kept for callers that name one version)
 *   PLUGIN_VERSION                   this plugin's version (.claude-plugin/plugin.json), '?' when unreadable
 *   negotiate(a, b) -> v | null      the highest version in both ranges {min, max}, null when they do not overlap
 *   rangeOf(params) -> {min, max} | null   a hello's range: its proto when well formed, else null
 *   skewMessage({host, joiner, need?}) -> string   {version, proto} each: "host runs sub-human 0.4.0 (protocol 3–4);
 *                                    you run 0.3.0 (protocol 2). Update your plugin: /plugin update sub-human" (or "The
 *                                    host must update …" when the joiner is the newer side). need: the version what was
 *                                    asked needs (an invite line: 3), so ranges that overlap below it still name the
 *                                    side that lacks it
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
 *   CODES, CODE_NAMES, WireCode      RoomError codes on both ends and on the wire, unchanged (CODE_NAMES is the
 *                                    source of the WireCode union): INVALID RATE LOCK NO_ROOM (today's) + OFFLINE
 *                                    HOST_ONLY AUTH FORK PROTOCOL STALE (a write or hello from another host epoch than
 *                                    the server's). A code that is not one of them is never sent (the server and the
 *                                    link socket send INVALID) and reads as INVALID (toError)
 *   isWireCode(x) -> bool            one of CODES
 *   reasons                          an error reply may carry reason beside its code (lib/reasons.ts: which failure
 *                                    exactly, e.g. PLACED_ALREADY, INVITE_USED, UNKNOWN_OUTCOME); additive, a peer
 *                                    without them sends none, and nothing depends on one arriving
 *   UNKNOWN_OUTCOME, unknownOutcome(err) -> bool   an OFFLINE whose request went out but got no answer in time (a slow
 *                                    link, a deadline): it may still land, so it is never "nothing was sent". reason
 *                                    UNKNOWN_OUTCOME (it survives the bridge and the daemon's socket); the phrase is
 *                                    the message people read
 *   request(id, op, params), reply(id, result), error(id, code, message, reason?), event(id, ev, data) -> frame
 *   toError({code, message, reason?}) -> RoomError   an error reply's error, as thrown on this end
 *   encode(frame) -> string          one line, newline-terminated
 *   decoder() -> {push(chunk) -> frame[]}   buffers partial lines; a malformed line, or one longer than
 *                                    LINK_FRAME_MAX_BYTES, is a PROTOCOL error frame (id null) in its place
 *   isRequest(f), isReply(f), isEvent(f)   a frame's shape; isEvent: an ev in EVENTS (data unchecked)
 *   isOp(op)                         one of OPS: an op this end serves
 *   EVENTS                           the event names a stream carries: entry doc end handoff moved snapshot
 */

import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { LINK_FRAME_MAX_BYTES } from '../config.ts';
import { RoomError } from '../room/validate.ts';
import { isReason, reasonOf } from '../reasons.ts';
import { isObj } from '../decode.ts';
import { errCode } from '../errors.ts';
import type {
  FrameId, ProtoRange, PeerVersion, OpParams, RequestFrame, AnyRequest, ResultFrame,
  ErrorFrame, EventData, EventFrame, DecodedFrame, Caps, IncomingRequest, IncomingEvent,
} from './types-core.ts';

const PROTO: Readonly<ProtoRange> = Object.freeze({ min: 1, max: 3 });
const VERSION = PROTO.max;
const PLUGIN_VERSION: string = (() => {
  let j: unknown;
  try { j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return '?'; }
  const v = j && typeof j === 'object' && 'version' in j ? j.version : undefined;
  return v ? String(v) : '?';
})();

const isVersion = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
/** A hello's fields as they arrived: unchecked. */
interface RangeFields { proto?: unknown }
/** A hello's range, its proto when well formed; null otherwise (a hello with no proto is refused: PROTOCOL SKEW). */
function rangeOf({ proto }: RangeFields = {}): ProtoRange | null {
  return isObj(proto) && isVersion(proto.min) && isVersion(proto.max) && proto.min <= proto.max ? { min: proto.min, max: proto.max } : null;
}
/** @returns {number | null} */
function negotiate(a: ProtoRange, b: ProtoRange): number | null {
  const v = Math.min(a.max, b.max);
  return v >= Math.max(a.min, b.min) ? v : null;
}
const span = (r: ProtoRange): string => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
/** A peer that names no version (0.5.0-beta.15 and before never did): older or newer than this one, by its protocol. */
const unnamed = (x: PeerVersion): string => (x.proto.max < PROTO.max ? 'an older sub-human' : x.proto.max > PROTO.max ? 'a newer sub-human' : 'a sub-human of no named version');
const runs = (who: string, x: PeerVersion): string => `${who} ${x.version && x.version !== '?' ? `sub-human ${x.version}` : unnamed(x)} (protocol ${span(x.proto)})`;
/** @returns {string} */
function skewMessage({ host, joiner, need }: { host: PeerVersion; joiner: PeerVersion; need?: number }): string {
  const joinerBehind = need !== undefined ? joiner.proto.max < need : joiner.proto.max < host.proto.min;
  const fix = joinerBehind
    ? 'Update your plugin: /plugin update sub-human'
    : 'The host must update: ask them to run /plugin update sub-human';
  const what = need !== undefined ? ` (this needs protocol ${need})` : '';
  return `${runs('host runs', host)}; ${runs('you run', joiner).replace(/^you run sub-human /, 'you run ')}${what}. ${fix}`;
}
/** The ops this end serves, the source of Op (types-core.ts re-exports it; OpParams and OpResults are keyed by it). */
const OPS = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put', 'ping', 'handoff.accept', 'handoff.refuse'] as const;
export type Op = typeof OPS[number];
/** The events a stream carries, the source of EventName (types-core.ts EventData is keyed by it). */
const EVENTS = ['entry', 'doc', 'end', 'handoff', 'moved', 'snapshot'] as const;
export type EventName = typeof EVENTS[number];
const FIELDS: string[] = ['same'];
const CAPS: Readonly<Caps> = Object.freeze({ ops: OPS, fields: FIELDS, snapshot: true });
/** The RoomError codes, the source of WireCode: on both ends and on the wire. */
const CODE_NAMES = ['INVALID', 'RATE', 'LOCK', 'NO_ROOM', 'OFFLINE', 'HOST_ONLY', 'AUTH', 'FORK', 'PROTOCOL', 'STALE'] as const;
export type WireCode = typeof CODE_NAMES[number];
const CODES: Readonly<{ [C in WireCode]: C }> = Object.freeze(Object.fromEntries(CODE_NAMES.map(c => [c, c])) as { [C in WireCode]: C }); // every name, keyed by itself
const CODE_SET: ReadonlySet<string> = new Set(CODE_NAMES);
const isWireCode = (x: unknown): x is WireCode => typeof x === 'string' && CODE_SET.has(x);

const UNKNOWN_OUTCOME = 'the outcome is unknown: it went out and may still land';
/** An OFFLINE whose op went out (reason UNKNOWN_OUTCOME, or the bridge's unknown flag): never "nothing was sent". */
const unknownOutcome = (e: unknown): boolean => {
  return errCode(e) === CODES.OFFLINE && ((isObj(e) && e.unknown === true) || reasonOf(e) === 'UNKNOWN_OUTCOME');
};

/** @returns {{id: number|string, op: string, params: object}} */
function request<O extends Op>(id: FrameId, op: O, params?: OpParams[O]): RequestFrame<O>;
function request(id: FrameId, op: string, params?: object): AnyRequest;
function request(id: FrameId, op: string, params: object = {}): AnyRequest { return { id, op, params }; }
/** @returns {{id: number|string, result: *}} */
const reply = <R>(id: FrameId | undefined, result: R): ResultFrame<R> => ({ id, result });
/** An error reply; reason (lib/reasons.ts) rides beside the code when the error has one. */
const error = (id: FrameId | undefined, code: WireCode, message: unknown, reason?: string | null): ErrorFrame => ({ id, error: { code, message: String(message), ...(isReason(reason) ? { reason } : {}) } });
/** The RoomError an error reply stands for, with its reason when it carries one this end knows. A code this end does
 * not know (a newer peer's) reads as INVALID, as this end's own server and link socket send one. */
const toError = (e: { code: unknown; message: unknown; reason?: unknown }): RoomError => new RoomError(isWireCode(e.code) ? e.code : CODES.INVALID, String(e.message), isReason(e.reason) ? e.reason : null);
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

/** A request by its shape: op a string (whether this end serves it is the server's check: isOp). */
const isRequest = (f: unknown): f is IncomingRequest => isObj(f) && typeof f.op === 'string';
const isReply = (f: unknown): f is ResultFrame | ErrorFrame => isObj(f) && f.op === undefined && f.ev === undefined && ('result' in f || 'error' in f);
/** An event this end knows (EVENTS), its data unchecked: the subscriber checks what it reads. */
const isEvent = (f: unknown): f is IncomingEvent => isObj(f) && isEventName(f.ev);
const isEventName = (ev: unknown): ev is EventName => EVENTS.some(e => e === ev);
const isOp = (op: unknown): op is Op => OPS.some(o => o === op);

export {
  PROTO, VERSION, PLUGIN_VERSION, rangeOf, negotiate, skewMessage, OPS, EVENTS, FIELDS, CAPS, CODES, CODE_NAMES, isWireCode, UNKNOWN_OUTCOME,
  unknownOutcome, request, reply, error, toError, event, encode, decoder, isRequest, isReply, isEvent, isOp,
};
