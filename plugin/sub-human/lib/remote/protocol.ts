/**
 * plugin/sub-human/lib/remote/protocol.ts: the wire protocol between a link (lib/remote/client.ts, on the
 * machine of a remote member) and a room's server (lib/remote/server.ts, on the host): the ops, the frame
 * shapes, the error codes and the line codec. Transport-agnostic (lib/remote/transports/*). Zero
 * dependencies beyond node:string_decoder, lib/config.ts, lib/reasons.ts and RoomError.
 *
 * Frames, one JSON object per line (as mcp/room-server.ts speaks): request {id, op, params}, reply {id, result} |
 * {id, error: {code, message, reason?}}, event {id, ev, data} on a subscribe stream (id: the subscribe request's).
 * Events: 'entry' (the host line, verbatim), 'doc' ({key, value}: members, presence/NAME, tasks; null for a document
 * that is gone), 'end' (closed: the room's Claude was stopped; FORK: the host log was reset under the stream),
 * 'snapshot' (sent first and only to a subscribe {after: 0, snapshot: true} when it fits a frame; the lines then
 * start after its id, and must chain to its head: FORK otherwise).
 *
 * hello carries {proto, client, caps}; the server answers with v = negotiate() of the two ranges; no overlap, or no
 * proto, is PROTOCOL (reason SKEW) with skewMessage(), which names the side that must update (need: the version what
 * was asked needs, so ranges that overlap below it still name the side that lacks it). A client that
 * pings says hello with caps {ping: true}, so the server may close a session that then goes silent (LINK_SILENT_MS).
 *
 * A code that is not one of CODES is never sent (the server and the link socket send INVALID) and reads as INVALID
 * (toError). An error reply's reason (lib/reasons.ts) is optional: nothing depends on one arriving. UNKNOWN_OUTCOME:
 * an OFFLINE whose request went out but got no answer in time; it may still land, so it is never "nothing was sent".
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

const PROTO: Readonly<ProtoRange> = Object.freeze({ min: 3, max: 3 });
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
function negotiate(a: ProtoRange, b: ProtoRange): number | null {
  const v = Math.min(a.max, b.max);
  return v >= Math.max(a.min, b.min) ? v : null;
}
const span = (r: ProtoRange): string => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
/** A peer that names no version: older or newer than this one, by its protocol. */
const unnamed = (x: PeerVersion): string => (x.proto.max < PROTO.max ? 'an older sub-human' : x.proto.max > PROTO.max ? 'a newer sub-human' : 'a sub-human of no named version');
const runs = (who: string, x: PeerVersion): string => `${who} ${x.version && x.version !== '?' ? `sub-human ${x.version}` : unnamed(x)} (protocol ${span(x.proto)})`;
function skewMessage({ host, joiner, need }: { host: PeerVersion; joiner: PeerVersion; need?: number }): string {
  const joinerBehind = need !== undefined ? joiner.proto.max < need : joiner.proto.max < host.proto.min;
  const fix = joinerBehind
    ? 'Update your plugin: /plugin update sub-human'
    : 'The host must update: ask them to run /plugin update sub-human';
  const what = need !== undefined ? ` (this needs protocol ${need})` : '';
  return `${runs('host runs', host)}; ${runs('you run', joiner).replace(/^you run sub-human /, 'you run ')}${what}. ${fix}`;
}
/** The ops this end serves, the source of Op (types-core.ts re-exports it; OpParams and OpResults are keyed by it). */
const OPS = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put', 'ping'] as const;
export type Op = typeof OPS[number];
/** The events a stream carries, the source of EventName (types-core.ts EventData is keyed by it). */
const EVENTS = ['entry', 'doc', 'end', 'snapshot'] as const;
export type EventName = typeof EVENTS[number];
const CAPS: Readonly<Caps> = Object.freeze({ ops: OPS, snapshot: true });
/** The RoomError codes, the source of WireCode: on both ends and on the wire. */
const CODE_NAMES = ['INVALID', 'RATE', 'LOCK', 'NO_ROOM', 'OFFLINE', 'HOST_ONLY', 'AUTH', 'FORK', 'PROTOCOL'] as const;
export type WireCode = typeof CODE_NAMES[number];
const CODES: Readonly<{ [C in WireCode]: C }> = Object.freeze(Object.fromEntries(CODE_NAMES.map(c => [c, c])) as { [C in WireCode]: C }); // every name, keyed by itself
const CODE_SET: ReadonlySet<string> = new Set(CODE_NAMES);
const isWireCode = (x: unknown): x is WireCode => typeof x === 'string' && CODE_SET.has(x);

const UNKNOWN_OUTCOME = 'the outcome is unknown: it went out and may still land';
/** An OFFLINE whose op went out (reason UNKNOWN_OUTCOME, or the bridge's unknown flag): never "nothing was sent". */
const unknownOutcome = (e: unknown): boolean => {
  return errCode(e) === CODES.OFFLINE && ((isObj(e) && e.unknown === true) || reasonOf(e) === 'UNKNOWN_OUTCOME');
};

function request<O extends Op>(id: FrameId, op: O, params?: OpParams[O]): RequestFrame<O>;
function request(id: FrameId, op: string, params?: object): AnyRequest;
function request(id: FrameId, op: string, params: object = {}): AnyRequest { return { id, op, params }; }
const reply = <R>(id: FrameId | undefined, result: R): ResultFrame<R> => ({ id, result });
/** An error reply; reason (lib/reasons.ts) rides beside the code when the error has one. */
const error = (id: FrameId | undefined, code: WireCode, message: unknown, reason?: string | null): ErrorFrame => ({ id, error: { code, message: String(message), ...(isReason(reason) ? { reason } : {}) } });
/** The RoomError an error reply stands for, with its reason when it carries one this end knows. A code this end does
 * not know (a newer peer's) reads as INVALID, as this end's own server and link socket send one. */
const toError = (e: { code: unknown; message: unknown; reason?: unknown }): RoomError => new RoomError(isWireCode(e.code) ? e.code : CODES.INVALID, String(e.message), isReason(e.reason) ? e.reason : null);
const event = <E extends EventName>(id: FrameId, ev: E, data: EventData[E]): EventFrame<E> => ({ id, ev, data });

/** One newline-terminated line. */
const encode = (frame: object): string => JSON.stringify(frame) + '\n';

function parseLine(line: string): DecodedFrame | ErrorFrame {
  if (Buffer.byteLength(line, 'utf8') > LINK_FRAME_MAX_BYTES) return error(null, CODES.PROTOCOL, `a frame over ${LINK_FRAME_MAX_BYTES} bytes`);
  let f: unknown;
  try { f = JSON.parse(line); } catch { return error(null, CODES.PROTOCOL, 'a frame that is not JSON'); }
  return f && typeof f === 'object' && !Array.isArray(f) ? f : error(null, CODES.PROTOCOL, 'a frame that is not an object');
}

/** Buffers partial lines; a malformed line, or one over LINK_FRAME_MAX_BYTES, is a PROTOCOL error frame (id null). */
function decoder(): { push(chunk: string | Buffer): (DecodedFrame | ErrorFrame)[] } {
  const utf8 = new StringDecoder('utf8'); // a character split across two chunks stays whole
  let buf = '';
  return {
    push(chunk: string | Buffer) {
      buf += typeof chunk === 'string' ? chunk : utf8.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // split gives at least one element
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
  PROTO, PLUGIN_VERSION, rangeOf, negotiate, skewMessage, OPS, EVENTS, CAPS, CODES, CODE_NAMES, isWireCode, UNKNOWN_OUTCOME,
  unknownOutcome, request, reply, error, toError, event, encode, decoder, isRequest, isReply, isEvent, isOp,
};
