'use strict';
/**
 * plugin/sub-human/lib/seats.js: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.js, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (orch spawn, the
 * reaper) do nothing where the room's store is not the host's (lib/orch.js). In a
 * room hosted elsewhere (a mirror, lib/room/store-mirror.js) the seat op is all there is: the host's server runs
 * the rest of the sequence for it.
 *
 *   enter({code, name, role?, machine?, pid?, session_id?, cwd?, pubkey}) -> {ok, rejoin?, error?, code?, note?}
 *       identity.join (members.join, a named op of lib/room/store.js; then this machine's session indexes) →
 *       on the host: the room's working directory, the first time (a local seat's cwd: where the orch runs, also
 *       when a seat on another machine starts it) → member_joined via system with pubkey and machine (the key is
 *       pinned at first sight, lib/room/envelope.js; a key other than the pinned one is refused and the seat given
 *       back: {ok: false, error, code: 'AUTH'}) → ensureOrch.
 *       role: member (default). machine: this one (default); pid, session_id and cwd belong to a seat of this
 *       machine and stay out of what the host streams (lib/room/members.js publicView).
 *   ensureOrch(code, cwd?, by) -> string   start the room's orch (detached) when it has none running: lib/orch.js
 *       claimSpawn (host only) + startDetached in cwd, else the room's working directory. '' or the short
 *       systemMessage suffix the join hook shows.
 *   exit(code, name, reason, {deadlineMs}?) -> bool
 *       identity.leave (members.leave) → on the host: when no live member is left, the reaper (lib/orch.js
 *       reapDetached) → member_left via system "NAME left (reason)". The seat is left and the reaper started
 *       before the append, the only step that can wait on a lock (SessionEnd has seconds; deadlineMs bounds a
 *       mirror's op). Idempotent: a seat absent or already left returns false and writes nothing.
 */

const identity = require('./identity.js');
const room = require('./room.js');
const orch = require('./orch.js');

const asSystem = name => ({ via: 'system', from: name, system: true });
const WORKDIR = 'workdir'; // the room's working directory: {cwd}

/** The first local seat's cwd becomes the room's working directory, where the orch runs. */
function keepWorkdir(code, cwd) {
  const kv = room.open(code).store.kv;
  if (cwd && !kv.get(WORKDIR)) kv.set(WORKDIR, { cwd });
}

function ensureOrch(code, cwd, by) {
  let last = null;
  try {
    last = identity.readMembers(code).orch || null;
    const c = orch.claimSpawn(code, { by });
    if (!c) return '';
    orch.startDetached({ code, cwd: cwd || (room.open(code).store.kv.get(WORKDIR) || {}).cwd, ...c });
  } catch (e) {
    return ` · no orch (${String(e.message || e).slice(0, 200)}); /sub-human still works, but there is no room task list`;
  }
  const failed = last && last.spawn_error ? ` (the last start failed: ${last.spawn_error})` : '';
  return ` · starting the orch…${failed}`;
}

function enter({ code, name, role = 'member', machine = identity.machineId(), pid, session_id, cwd, pubkey }) {
  const r = identity.join({ code, name, role, machine, pid, session_id, cwd });
  if (!r.ok) return r;
  if (!identity.isHost(code)) return { ...r, note: '' };
  keepWorkdir(code, cwd);
  try {
    room.open(code).append({ kind: 'member_joined', text: `${name} ${r.rejoin ? 'rejoined' : 'joined'}`, pubkey, machine }, asSystem(name));
  } catch (e) {
    if (e.code !== 'AUTH') throw e;
    identity.leave(code, name);
    return { ok: false, error: e.message, code: 'AUTH' };
  }
  return { ...r, note: ensureOrch(code, cwd, name) };
}

function exit(code, name, reason, { deadlineMs } = {}) {
  if (!identity.leave(code, name, { reason, deadlineMs })) return false;
  if (!identity.isHost(code)) return true;
  try { if (!identity.liveMembers(code).length) orch.reapDetached(code); } catch { /* the orch's watchdog closes it */ }
  room.open(code).append({ kind: 'member_left', text: `${name} left (${reason})` }, asSystem(name));
  return true;
}

module.exports = { enter, exit, ensureOrch };
