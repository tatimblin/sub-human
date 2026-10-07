'use strict';
/**
 * plugin/sub-human/lib/seats.js: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.js, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (orch spawn, the
 * reaper) run when the room's store isHost (docs/next/REMOTE-PLAN.md rule 2). Stub: filled in by PR2.
 *
 *   enter({code, name, role, machine, pid?, session_id?, cwd?, pubkey}) -> {ok, rejoin?, error?, note?}
 *       members.join (lib/room/store.js, a named op) → member_joined via system with pubkey and machine (the
 *       key is pinned at first sight, lib/room/envelope.js) → on the host, ensure the orch (lib/orch.js
 *       claimSpawn + startDetached; note = the short systemMessage suffix join.js shows today). pid and
 *       session_id are this machine's and stay in its session indexes (lib/identity.js), never in what the
 *       host streams.
 *   exit(code, name, reason) -> bool
 *       members.leave → member_left via system → on the host, reap when no live member is left (lib/orch.js
 *       reapDetached). Idempotent: a seat already left returns false and writes nothing.
 *   switchRooms(me, code) -> void        exit(me.code, me.name, 'switched rooms') when me is elsewhere
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR2)`); };

/**
 * @param {{code: string, name: string, role: 'member'|'orch', machine: string, pid?: number, session_id?: string, cwd?: string, pubkey?: string}} seat
 * @returns {{ok: boolean, rejoin?: boolean, error?: string, note?: string}}
 */
function enter(seat) { return todo(`seats.enter(${seat && seat.name}@${seat && seat.code})`); }

/**
 * @param {string} code
 * @param {string} name
 * @param {string} reason   "session ended", "switched rooms", a SessionEnd reason, …
 * @returns {boolean}
 */
function exit(code, name, reason) { return todo(`seats.exit(${name}@${code}, ${reason})`); }

/**
 * @param {{code: string, name: string}} me
 * @param {string} code   the room me is moving to
 */
function switchRooms(me, code) { return todo(`seats.switchRooms(${me && me.name}, ${code})`); }

module.exports = { enter, exit, switchRooms };
