/**
 * plugin/sub-human/lib/seats.ts: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.ts, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (room Claude spawn, the
 * reaper) do nothing where the room's store is not the host's (lib/room-claude.ts). In a
 * room hosted elsewhere (a mirror, lib/room/store-mirror.ts) the seat op is all there is: the host's server runs
 * the rest of the sequence for it.
 *
 *   enter({code, name, role?, machine?, account?, pid?, session_id?, cwd?, pubkey}) -> {ok, rejoin?, error?, code?, note?}
 *       identity.join (members.join, a named op of lib/room/store.ts; then this machine's session indexes) →
 *       on the host: the room's working directory, the first time (a local seat's cwd: where the room's Claude runs, also
 *       when a seat on another machine starts it) → member_joined via system with pubkey and machine (the key is
 *       pinned at first sight, lib/room/envelope.ts; a key other than the pinned one is refused and the seat given
 *       back: {ok: false, error, code: 'AUTH'}) → ensureRoomClaude.
 *       role: member (default). machine: this one (default); pid, session_id and cwd belong to a seat of this
 *       machine and stay out of what the host streams (lib/room/members.ts publicView). account: the person behind
 *       the seat (the remote server's, for a login link: the host's machine id); a seat on the host itself defaults
 *       to the host's machine id, so the host account's seat here and its seats over login links are one approver
 *       (on the host, only the seat of the person who opened the room: several people may share it; the first
 *       person's seat here is marked owner, lib/room/members.ts join; lib/proposal.ts sameOf). An invite's
 *       seat has none: it is its own person, even from the same machine.
 *   ensureRoomClaude(code, cwd?, by) -> string   start the room's Claude (detached) when it has none running: lib/room-claude.ts
 *       claimSpawn (host only) + startDetached in cwd, else the room's working directory. '' or the short
 *       systemMessage suffix the join hook shows.
 *   exit(code, name, reason, {deadlineMs}?) -> bool
 *       identity.leave (members.leave) → on the host: when no live member is left, the reaper (lib/room-claude.ts
 *       reapDetached) → member_left via system "NAME left (reason)". The seat is left and the reaper started
 *       before the append, the only step that can wait on a lock (SessionEnd has seconds; deadlineMs bounds a
 *       mirror's op). Idempotent: a seat absent or already left returns false and writes nothing. In a room
 *       hosted elsewhere a leave the link can't carry (offline, timed out) returns false: the seat lapses there.
 *   sweep(code, {now?, name?}) -> [name]   on the host (elsewhere: []), the seats that ended with no leave: a local
 *       seat whose pid died exits ("session ended"); any other seat whose lease is SEAT_LEASE_MS + LEAVE_SETTLE_MS old
 *       (name: only that seat, as soon as it is not seatAlive) gets lapsed_at, and the one caller that set it logs
 *       member_left "NAME left (connection lost)". A lapsed seat stays seated: its next beat renews it (lib/remote/link.ts
 *       keepSeats) and back() logs it. The room's Claude, left seats and lapsed ones are not swept; a lapsed seat
 *       whose lease is fresh again (a beat that did not run back) is given back. Returns the names it ended.
 *   back(code, name) -> bool   on the host: clears lapsed_at and, when it was set, logs member_joined "NAME rejoined"
 *       (the remote server runs it after each beat). false when the seat had not lapsed.
 *   take(want, {pid, session_id, cwd, cur, pubkey}) -> Taken   the /sub-human join's seat (lib/commands/join.ts): NAME in
 *       ROOM (code null: the one open room, sweeping orphans first, else a new one; several open is a refusal). In a room
 *       hosted elsewhere the link is started first (lib/remote/joining.ts ensureLinked). The same seat again is "already
 *       joined" (unless a re-pointed link must rebind it); another seat of this session leaves first ("switched rooms");
 *       pubkey(code, name) is the seat key's public half (hooks/seat-key.ts, which only the join hook loads). Taken:
 *       {ok: true, me, lead, msg} (lead: the mechanics block's last line; msg: the line for the person) or
 *       {ok: false, text, refused} (a refusal, or where a join not let in yet stands)
 *   withWhom(code, name) -> string   "with bob, carol", "4 others here" or "nobody else here yet" (the people only)
 */

import * as identity from './identity.ts';
import * as room from './room.ts';
import * as roomClaude from './room-claude.ts';
import * as config from './config.ts';
import { validPid } from './io.ts';
import * as links from './room/links.ts';
import { roomClaudePresence } from './room/members.ts';
import { createRequire } from 'node:module';
import type { JoinResult, Member } from './room/types.ts';
import type { Identity } from './identity.ts';
import type { Wanted } from './remote/joining.ts';

const require = createRequire(import.meta.url);
// loaded only by take(): the session-end hook and the remote server never need the link or the listener
const joining = (): typeof import('./remote/joining.ts') => require('./remote/joining.ts');

/** enter()'s seat: the join hook's, or the remote server's for a seat on another machine. */
interface EnterOpts {
  code: string;
  name: string;
  role?: string;
  machine?: string | null;
  account?: string;
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

function enter({ code, name, role = 'member', machine = identity.machineId(), account, pid, session_id, cwd, pubkey }: EnterOpts): EnterResult {
  // the seat's earlier record ended with no leave: its "left" line goes before this join's "rejoined"
  if (identity.isHost(code)) sweep(code, { name });
  // a seat on the host is the host account's (elsewhere the host's server decides: a mirror's join sends no account)
  if (account === undefined && machine && machine === identity.machineId() && identity.isHost(code)) account = machine;
  const r: EnterResult = identity.join({ code, name, role, machine, account, pid, session_id, cwd });
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

const isLocal = (m: Member): boolean => validPid(m.pid) && (m.machine || identity.machineId()) === identity.machineId();

function sweep(code: string, { now = Date.now(), name }: { now?: number; name?: string } = {}): string[] {
  const s = room.open(code).store;
  if (!s || !s.isHost) return [];
  const after = config.SEAT_LEASE_MS + config.envMs('SUB_HUMAN_LEAVE_MS', config.LEAVE_SETTLE_MS);
  // lapsed: the lease is past the settle (a named seat: not alive), and the seat is still neither left nor lapsed
  const lapsed = (m: Member | undefined): m is Member => !!m && !m.left_at && !m.lapsed_at && !identity.seatAlive(m)
    && (name !== undefined || !(now - Date.parse(String(m.seen_at)) < after));
  const out: string[] = [];
  for (const m of Object.values(s.members.read())) {
    if (!m || !m.name || m.role === 'claude' || m.left_at || (name !== undefined && m.name !== name)) continue;
    if (m.lapsed_at) { if (identity.seatAlive(m)) back(code, m.name); continue; }
    if (identity.seatAlive(m)) continue;
    if (isLocal(m)) { if (exit(code, m.name, 'session ended')) out.push(m.name); continue; }
    let set = false;
    s.members.update(ms => {
      set = false; // update may run fn more than once
      if (!lapsed(ms[m.name])) return null;
      ms[m.name].lapsed_at = new Date(now).toISOString();
      set = true;
      return ms;
    });
    if (!set) continue;
    room.open(code).append({ kind: 'member_left', text: `${m.name} left (connection lost)` }, asSystem(m.name));
    out.push(m.name);
  }
  return out;
}

function back(code: string, name: string): boolean {
  const s = room.open(code).store;
  if (!s || !s.isHost) return false;
  let was = false;
  s.members.update(ms => {
    was = false;
    const m = ms[name];
    if (!m || m.left_at || !m.lapsed_at) return null;
    delete m.lapsed_at;
    was = true;
    return ms;
  });
  if (was) room.open(code).append({ kind: 'member_joined', text: `${name} rejoined` }, asSystem(name));
  return was;
}

/** take()'s answer: a seat taken (the mechanics block's lead line, the person's line), or a refusal / where it stands. */
export type Taken = { ok: true; me: Identity; lead: string; msg: string } | { ok: false; text: string; refused: boolean };
/** take()'s process: the seat's claude pid and session, the seat this session holds now, and its key's public half. */
interface TakeCtx { pid: number; session_id: string | undefined; cwd: string; cur: Identity | null; pubkey(code: string, name: string): string }

const no = (text: string, refused = true): Taken => ({ ok: false, text, refused });
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Who else is in the room, live (the room's Claude only while it runs). */
function others(code: string, name: string): string[] {
  return Object.values<Member>(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at
    && (m.role !== 'claude' || roomClaudePresence(m) === 'live')).map(m => m.name);
}

function withWhom(code: string, name: string): string {
  const names = others(code, name).filter(n => n !== identity.ROOM_CLAUDE);
  if (!names.length) return 'nobody else here yet';
  return names.length > 3 ? `${names.length} others here` : `with ${names.join(', ')}`;
}

/** Close rooms where only the room's Claude is left once they have been orphaned long enough (best effort; host only). */
function sweepOrphans(): void {
  try { identity.pruneModLeases(); } catch { /* the next join retries */ }
  for (const c of identity.orphanRooms()) { try { roomClaude.watchdog(c); } catch { /* next join retries */ } }
}

function take({ name, code, isDefault = false }: Wanted, { pid, session_id, cwd, cur, pubkey }: TakeCtx): Taken {
  let created = false;
  if (!code) {
    sweepOrphans();
    const open: string[] = identity.openRooms();
    if (open.length > 1) return no(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human NAME ROOM.`);
    code = open[0] || null;
  }
  if (!code) {
    // Check the name before making a room for it.
    if (!identity.NAME_RE.test(name)) return no(`"${name}" isn't a name (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(name.toLowerCase())) return no(`"${name}" is reserved; pick another name`);
    code = identity.newCode();
    created = true;
  } else {
    if (!identity.roomExists(code)) return no(`there's no room ${code} on this machine. Check the name, or type /sub-human to open a new room.`);
    if (identity.roomClosing(code)) return no(`room ${code} is closing; type /sub-human to open a new room.`);
    const step = joining().ensureLinked(code, name);
    if (step && step.kind === 'say') return no(step.text, step.refused);
  }
  const host = identity.isHost(code);
  const same = !!cur && cur.code === code && cur.name === name;
  // a link whose credentials a re-point replaced (lib/handoff.ts): the seat joins again over it, even if seated
  const rebind = !host && !!(links.get(code) || {}).rebind;
  if (cur && same && !rebind) {
    joining().dropJoinAs(code);
    return { ok: true, me: cur, lead: 'already joined', msg: `you're already in ${cur.code} as ${name}, ${withWhom(code, name)}${ensureRoomClaude(code, cwd, name)}` };
  }
  // The seat's key: via=human posts and answers are signed with it, and the log pins it.
  let key: string;
  try { key = pubkey(code, name); } catch (e) { return no(`could not make ${name}'s signing key (${msgOf(e)}). Run /sub-human doctor.`); }
  if (cur && !same) exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  const r = enter({ code, name, pid, session_id, cwd, pubkey: key });
  if (!r.ok) {
    if (isDefault && /^name taken/.test(r.error || '')) return no(`"${name}" is taken in room ${code}; pick another: /sub-human NAME${created ? '' : ` ${code}`}`);
    return no(`could not join ${code} as ${name}: ${r.error || 'unknown error'}`);
  }
  if (rebind) { const { rebind: _done, ...l } = links.get(code)!; links.set(code, l); } // rebind: read from it
  joining().dropJoinAs(code);
  if (host) {
    try { (require('./remote/webhost.ts') as typeof import('./remote/webhost.ts')).ensure(code); } catch { /* best effort */ } // the listener after a reboot
    try { (require('./remote/shim.ts') as typeof import('./remote/shim.ts')).refresh(); } catch { /* best effort */ } // the serve shim a login link runs
  }
  const me: Identity = { code, name, role: 'member', pid, session_id: session_id || null, address: identity.address(name, code) };
  const msg = created
    ? `opened room ${code} as ${name} · on this machine others join with /sub-human; another machine: /sub-human invite`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}, ${withWhom(code, name)} · @room to talk, @claude to ask the room's Claude`;
  return { ok: true, me, lead: created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', msg: `${msg}${r.note}` };
}

/** Test seam: the room's Claude starts through this object, which a test may stub (test/seats.node-test.ts); an ES
 * module's own exports are read-only. */
const seam = { startDetached: (o: Parameters<typeof roomClaude.startDetached>[0]) => roomClaude.startDetached(o) };

export { enter, exit, sweep, back, ensureRoomClaude, seam, take, withWhom };
