/**
 * plugin/sub-human/lib/seats.ts: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.ts, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (room Claude spawn, the
 * reaper) do nothing where the room's store is not the host's (lib/room-claude.ts). In a
 * room hosted elsewhere (a mirror, lib/room/store-mirror.ts) the seat op is all there is: the host's server runs
 * the rest of the sequence for it.
 *
 *   enter({code, name, role?, machine?, pid?, session_id?, cwd?, pubkey}) -> {ok, rejoin?, error?, code?, note?}
 *       identity.join (members.join, a named op of lib/room/store.ts; then this machine's session indexes) →
 *       on the host: the room's working directory, the first time (a local seat's cwd: where the room's Claude runs, also
 *       when a seat on another machine starts it) → member_joined via system with pubkey and machine (the key is
 *       pinned at first sight, lib/room/envelope.ts; a key other than the pinned one is refused and the seat given
 *       back: {ok: false, error, code: 'AUTH'}) → ensureRoomClaude.
 *       role: member (default). machine: this one (default); pid, session_id and cwd belong to a seat of this
 *       machine and stay out of what the host streams (lib/room/members.ts publicView).
 *   ensureRoomClaude(code, cwd?, by) -> string   start the room's Claude (detached) when it has none running: lib/room-claude.ts
 *       claimSpawn (host only) + startDetached in cwd, else the room's working directory. '' or the short
 *       systemMessage suffix the join hook shows.
 *   exit(code, name, reason, {deadlineMs}?) -> bool
 *       identity.leave (members.leave) → on the host: when no live member is left, the reaper (lib/room-claude.ts
 *       reapDetached) → member_left via system "NAME left (reason)". The seat is left and the reaper started
 *       before the append, the only step that can wait on a lock (SessionEnd has seconds; deadlineMs bounds a
 *       mirror's op). Idempotent: a seat absent or already left returns false and writes nothing. In a room
 *       hosted elsewhere a leave the link can't carry (offline, timed out) returns false: the seat lapses there.
 */

import * as identity from './identity.ts';
import * as room from './room.ts';
import * as roomClaude from './room-claude.ts';
import type { JoinResult, Member } from './room/types.ts';

/** enter()'s seat: the join hook's, or the remote server's for a seat on another machine. */
interface EnterOpts {
  code: string;
  name: string;
  role?: string;
  machine?: string | null;
  pid?: number | null;
  session_id?: string | null;
  cwd?: string | null;
  pubkey?: string;
}
/** identity.join's answer; note: what the join line adds (the room's Claude starting, or why it could not). */
type EnterResult = JoinResult & { note?: string };

const asSystem = (name: string) => ({ via: 'system', from: name, system: true });
const WORKDIR = 'workdir'; // the room's working directory: {cwd}

/** The first local seat's cwd becomes the room's working directory, where the room's Claude runs. */
function keepWorkdir(code: string, cwd: string | null | undefined): void {
  const kv = room.open(code).store.kv;
  if (cwd && !kv.get(WORKDIR)) kv.set(WORKDIR, { cwd });
}

function ensureRoomClaude(code: string, cwd: string | null | undefined, by: string): string {
  let last: Member | null = null;
  try {
    last = identity.readMembers(code).claude || null;
    const c = roomClaude.claimSpawn(code, { by });
    if (!c) return '';
    seam.startDetached({ code, cwd: cwd || (room.open(code).store.kv.get(WORKDIR) as { cwd?: string } | null || {}).cwd, ...c });
  } catch (e) {
    return ` · the room's Claude could not start (${String((e as Error).message || e).slice(0, 200)}); /sub-human still works, but there is no room task list`;
  }
  const failed = last && last.spawn_error ? ` (the last start failed: ${last.spawn_error})` : '';
  return ` · starting the room's Claude…${failed}`;
}

function enter({ code, name, role = 'member', machine = identity.machineId(), pid, session_id, cwd, pubkey }: EnterOpts): EnterResult {
  const r: EnterResult = identity.join({ code, name, role, machine, pid, session_id, cwd });
  if (!r.ok) return r;
  if (!identity.isHost(code)) return { ...r, note: '' };
  keepWorkdir(code, cwd);
  try {
    // machine null: this machine's id could not be read; the seat joins without one (validate refuses a null machine)
    room.open(code).append({ kind: 'member_joined', text: `${name} ${r.rejoin ? 'rejoined' : 'joined'}`, pubkey, ...(machine ? { machine } : {}) }, asSystem(name));
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'AUTH') throw e;
    identity.leave(code, name, {});
    return { ok: false, error: (e as Error).message, code: 'AUTH' };
  }
  return { ...r, note: ensureRoomClaude(code, cwd, name) };
}

function exit(code: string, name: string, reason: string, { deadlineMs }: { deadlineMs?: number } = {}): boolean {
  try {
    if (!identity.leave(code, name, { reason, deadlineMs })) return false;
  } catch (e) {
    // a room hosted elsewhere with its link down (or slow at session end): the host lets the seat lapse with its
    // lease, so leaving here is best effort and never a stack trace on /exit
    if (e instanceof room.RoomError && !identity.isHost(code)) return false;
    throw e;
  }
  if (!identity.isHost(code)) return true;
  try { if (!identity.liveMembers(code).length) roomClaude.reapDetached(code); } catch { /* the room Claude's watchdog closes it */ }
  room.open(code).append({ kind: 'member_left', text: `${name} left (${reason})` }, asSystem(name));
  return true;
}

/** Test seam: the room's Claude starts through this object, which a test may stub (test/seats.test.js); an ES
 * module's own exports are read-only. */
const seam = { startDetached: (o: Parameters<typeof roomClaude.startDetached>[0]) => roomClaude.startDetached(o) };

export { enter, exit, ensureRoomClaude, seam };
