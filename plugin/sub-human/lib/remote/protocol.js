'use strict';
/**
 * plugin/sub-human/lib/remote/protocol.js: the wire protocol between a link (lib/remote/client.js, on the
 * machine of a remote member) and a room's server (lib/remote/server.js, on the host): the ops, the frame
 * shapes, the error codes and the line codec. Transport-agnostic (lib/remote/transports/*). Pure, zero
 * dependencies. Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md (the op table is there).
 *
 * Frames, one JSON object per line (as mcp/room-server.js speaks):
 *   request  {id, op, params}        reply {id, result} | {id, error: {code, message}}
 *   event    {id, ev, data}          a subscribe stream: ev 'entry' (data: the host line, verbatim), 'doc'
 *                                    (data: {key, value}: members, presence/NAME, tasks), 'end'
 *   VERSION = 1                      hello carries {v, caps} both ways; an unknown v is PROTOCOL
 *   OPS                              hello join leave beat append subscribe blob.get blob.put
 *   CODES                            RoomError codes on both ends and on the wire, unchanged:
 *                                    INVALID RATE LOCK NO_ROOM (today's) + OFFLINE HOST_ONLY AUTH FORK PROTOCOL
 *   request(id, op, params), reply(id, result), error(id, code, message), event(id, ev, data) -> frame
 *   encode(frame) -> string          one line, newline-terminated
 *   decoder() -> {push(chunk) -> frame[]}   buffers partial lines; a malformed line is a PROTOCOL error frame
 *   isRequest(f), isReply(f), isEvent(f)
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

const VERSION = 1;
const OPS = ['hello', 'join', 'leave', 'beat', 'append', 'subscribe', 'blob.get', 'blob.put'];
const EVENTS = ['entry', 'doc', 'end'];
const CODES = Object.freeze({
  INVALID: 'INVALID', RATE: 'RATE', LOCK: 'LOCK', NO_ROOM: 'NO_ROOM',
  OFFLINE: 'OFFLINE', HOST_ONLY: 'HOST_ONLY', AUTH: 'AUTH', FORK: 'FORK', PROTOCOL: 'PROTOCOL',
});

/** @returns {{id: number|string, op: string, params: object}} */
function request(id, op, params) { return todo(`protocol.request(${id}, ${op}, ${typeof params})`); }
/** @returns {{id: number|string, result: *}} */
function reply(id, result) { return todo(`protocol.reply(${id}, ${typeof result})`); }
/** @returns {{id: number|string, error: {code: string, message: string}}} */
function error(id, code, message) { return todo(`protocol.error(${id}, ${code}, ${message})`); }
/** @returns {{id: number|string, ev: string, data: *}} */
function event(id, ev, data) { return todo(`protocol.event(${id}, ${ev}, ${typeof data})`); }

/**
 * @param {object} frame
 * @returns {string} one newline-terminated line
 */
function encode(frame) { return todo(`protocol.encode(${frame && (frame.op || frame.ev || 'reply')})`); }

/** @returns {{push(chunk: string|Buffer): object[]}} */
function decoder() { return todo('protocol.decoder()'); }

const isRequest = f => !!f && typeof f.op === 'string';
const isReply = f => !!f && f.op === undefined && f.ev === undefined && ('result' in f || 'error' in f);
const isEvent = f => !!f && typeof f.ev === 'string';

module.exports = { VERSION, OPS, EVENTS, CODES, request, reply, error, event, encode, decoder, isRequest, isReply, isEvent };
