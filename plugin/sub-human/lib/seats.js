'use strict';
/**
 * plugin/sub-human/lib/seats.js: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.js, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (orch spawn, the
 * reaper) do nothing where the room's store is not the host's (lib/orch.js; docs/next/REMOTE-PLAN.md rule 2).
 *
 *   enter({code, name, role?, machine?, pid?, session_id?, cwd?, pubkey}) -> {ok, rejoin?, error?, note?}
 *       identity.join (members.join, a named op of lib/room/store.js; then this machine's session indexes) →
 *       member_joined via system with pubkey and machine (the key is pinned at first sight, lib/room/envelope.js;
 *       a key other than the pinned one is refused and the seat given back: {ok: false, error, code: 'AUTH'}) →
 *       ensureOrch.
 *       role: member (default). machine: this one (default); pid, session_id and cwd belong to a seat of this
 *       machine and stay out of what the host streams (lib/room/members.js publicView).
 *   ensureOrch(code, cwd, by) -> string   start the room's orch (detached) when it has none running: lib/orch.js
 *       claimSpawn (host only) + startDetached. '' or the short systemMessage suffix the join hook shows.
 *   exit(code, name, reason) -> bool
 *       identity.leave (members.leave) → when no live member is left, the reaper (lib/orch.js reapDetached, host
 *       only) → member_left via system "NAME left (reason)". The seat is left and the reaper started before the
 *       append, the only step that can wait on a lock (SessionEnd has seconds). Idempotent: a seat absent or
 *       already left returns false and writes nothing.
 */

const identity = require('./identity.js');
const room = require('./room.js');
const orch = require('./orch.js');

const asSystem = name => ({ via: 'system', from: name, system: true });

function ensureOrch(code, cwd, by) {
  let last = null;
  try {
    last = identity.readMembers(code).orch || null;
    const c = orch.claimSpawn(code, { by });
    if (!c) return '';
    orch.startDetached({ code, cwd, ...c });
  } catch (e) {
    return ` · no orch (${String(e.message || e).slice(0, 200)}); /sub-human still works, but there is no room task list`;
  }
  const failed = last && last.spawn_error ? ` (the last start failed: ${last.spawn_error})` : '';
  return ` · starting the orch…${failed}`;
}

function enter({ code, name, role = 'member', machine = identity.machineId(), pid, session_id, cwd, pubkey }) {
  const r = identity.join({ code, name, role, machine, pid, session_id, cwd });
  if (!r.ok) return r;
  try {
    room.open(code).append({ kind: 'member_joined', text: `${name} ${r.rejoin ? 'rejoined' : 'joined'}`, pubkey, machine }, asSystem(name));
  } catch (e) {
    if (e.code !== 'AUTH') throw e;
    identity.leave(code, name);
    return { ok: false, error: e.message, code: 'AUTH' };
  }
  return { ...r, note: ensureOrch(code, cwd, name) };
}

function exit(code, name, reason) {
  if (!identity.leave(code, name)) return false;
  try { if (!identity.liveMembers(code).length) orch.reapDetached(code); } catch { /* the orch's watchdog closes it */ }
  room.open(code).append({ kind: 'member_left', text: `${name} left (${reason})` }, asSystem(name));
  return true;
}

module.exports = { enter, exit, ensureOrch };
