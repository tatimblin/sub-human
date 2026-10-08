'use strict';
/**
 * plugin/sub-human/lib/remote/protocol.js: the wire protocol between a link (lib/remote/client.js, on the
 * machine of a remote member) and a room's server (lib/remote/server.js, on the host): the ops, the frame
 * shapes, the error codes and the line codec. Transport-agnostic (lib/remote/transports/*). Zero
 * dependencies beyond node:string_decoder and lib/config.js. PR4 of docs/next/REMOTE-PLAN.md (the op table is there).
 *
 * Frames, one JSON object per line (as mcp/room-server.js speaks):
 *   request  {id, op, params}        reply {id, result} | {id, error: {code, message}}
 *   event    {id, ev, data}          a subscribe stream (id: the subscribe request's): ev 'entry' (data: the host
 *                                    line, verbatim), 'doc' (data: {key, value}: members, presence/NAME, tasks;
 *                                    value null for a document that is gone), 'end' (data: {reason}: 'closed',
 *                                    the room's orch was stopped; 'FORK', the host log was reset under the stream)
 *   VERSION = 1                      hello carries {v, caps} both ways; an unknown v is PROTOCOL
 *   CAPS                             what this end serves: {ops: OPS}
 *   OPS                              hello join leave beat append subscribe blob.get blob.put
 *   CODES                            RoomError codes on both ends and on the wire, unchanged:
 *                                    INVALID RATE LOCK NO_ROOM (today's) + OFFLINE HOST_ONLY AUTH FORK PROTOCOL
 *   request(id, op, params), reply(id, result), error(id, code, message), event(id, ev, data) -> frame
 *   encode(frame) -> string          one line, newline-terminated
 *   decoder() -> {push(chunk) -> frame[]}   buffers partial lines; a malformed line, or one longer than
 *                                    LINK_FRAME_MAX_BYTES, is a PROTOCOL error frame (id null) in its place
 *   isRequest(f), isReply(f), isEvent(f)
 */

const { StringDecoder } = require('node:string_decoder');
const { LINK_FRAME_MAX_BYTES } = require('../config.js');

const VERSION = 1;
const OPS = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put'];
const EVENTS = ['entry', 'doc', 'end'];
const CAPS = Object.freeze({ ops: OPS });
const CODES = Object.freeze({
  INVALID: 'INVALID', RATE: 'RATE', LOCK: 'LOCK', NO_ROOM: 'NO_ROOM',
  OFFLINE: 'OFFLINE', HOST_ONLY: 'HOST_ONLY', AUTH: 'AUTH', FORK: 'FORK', PROTOCOL: 'PROTOCOL',
});

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

module.exports = { VERSION, OPS, EVENTS, CAPS, CODES, request, reply, error, event, encode, decoder, isRequest, isReply, isEvent };
