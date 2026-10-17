/**
 * plugin/sub-human/lib/seats.ts: entering and leaving a room, the one sequence the join hook, the session-end
 * hook and the remote server (lib/remote/server.ts, for a seat on another machine) all run. The hooks keep
 * only argument parsing and output; the server keeps only the protocol. The host-only steps (room Claude spawn, the
 * reaper) do nothing where the room's store is not the host's (lib/room-claude.ts). In a
 * room hosted elsewhere (a mirror, lib/room/store-mirror.ts) the seat op is all there is: the host's server runs
 * the rest of the sequence for it.
 *
 * enter: identity.join → on the host, the first local seat's cwd becomes the room's working directory (where the
 *   room's Claude runs, also when a seat on another machine starts it) → member_joined via system with pubkey and
 *   machine (the key is pinned at first sight, lib/room/envelope.ts; another key is refused with code 'AUTH' and the
 *   seat given back) → ensureRoomClaude. pid, session_id and cwd stay out of what the host streams
 *   (lib/room/members.ts publicView). account: the person behind the seat. A seat on the host defaults to the host's
 *   machine id, so the host account's seat and its seats over login links are one approver (on the host only the
 *   room owner's seat counts: several people may share it; lib/proposal.ts sameOf). An invite's seat has none: it
 *   is its own person, even from the same machine.
 * exit: identity.leave → on the host, the reaper when no live member is left → member_left. The seat is left and the
 *   reaper started before the append, the only step that can wait on a lock (SessionEnd has seconds; deadlineMs
 *   bounds a mirror's op). Idempotent. In a room hosted elsewhere a leave the link can't carry returns false: the
 *   seat lapses there.
 * sweep (host only): a local seat whose pid died exits ("session ended"); any other seat whose lease is
 *   SEAT_LEASE_MS + LEAVE_SETTLE_MS old gets lapsed_at, and the one caller that set it logs "NAME left (connection
 *   lost)". A lapsed seat stays seated: its next beat renews it (lib/remote/link.ts keepSeats) and back() logs
 *   "NAME rejoined". A seat of another machine that no host link names (revoked: no beat can renew it) exits
 *   instead. The room's Claude, left seats and lapsed ones are not swept.
 * take: the /sub-human join's seat (lib/commands/join.ts). code null: the one open room (orphans swept first), else
 *   a new one; several open is a refusal. In a room hosted elsewhere the link is started first (lib/remote/joining.ts
 *   ensureLinked). Another seat of this session is left only once the new one is taken ("switched rooms"), never on
 *   a refused join. Every take first runs lib/gc.ts sweep (at most every GC_EVERY_MS, within GC_BUDGET_MS), and a
 *   seat taken sweeps its room's row maps of ended sessions.
 */

import * as identity from './identity.ts';
import * as room from './room.ts';
import * as roomClaude from './room-claude.ts';
import * as config from './config.ts';
import { envMs } from './env.ts';
import { validPid, lazy } from './io.ts';
import { pidStarts } from './lock.ts';
import * as links from './room/links.ts';
import { roomClaudePresence } from './room/members.ts';
import type { JoinOutcome, Member } from './room/types.ts';
import type { Identity } from './identity.ts';
import type { Wanted } from './remote/joining.ts';
import { errCode, msgOf } from './errors.ts';
import type { RoomCode, SeatName, MachineId } from './brand.ts';
import type * as JoiningMod from './remote/joining.ts';
import type * as GcMod from './gc.ts';
import type * as WebhostMod from './remote/webhost.ts';
import type * as ShimMod from './remote/shim.ts';

// Loaded at first use (start cost: every hook that seats or unseats loads this file); joining.ts imports this one.
const webhostLib = lazy<typeof WebhostMod>(import.meta.url, './remote/webhost.ts');
const shimLib = lazy<typeof ShimMod>(import.meta.url, './remote/shim.ts');
// loaded only by take(): the session-end hook and the remote server never need the link or the listener
const joining = lazy<typeof JoiningMod>(import.meta.url, './remote/joining.ts');
const gc = lazy<typeof GcMod>(import.meta.url, './gc.ts');

/** enter()'s seat: the join hook's, or the remote server's for a seat on another machine. */
interface EnterOpts {
  code: RoomCode;
  name: SeatName;
  role?: string | undefined;
  machine?: MachineId | null | undefined;
  account?: string | undefined;
  pid?: number | null | undefined;
  session_id?: string | null | undefined;
  cwd?: string | null | undefined;
  pubkey?: string | undefined;
  /** take leaves the seat this pid held before itself, after this join worked (identity.join keepPrevious) */
  keepPrevious?: boolean | undefined;
}
/** identity.join's answer; note: what the join line adds (the room's Claude starting, or why it could not). */
type EnterResult = JoinOutcome & { note?: string };

const asSystem = (name: string) => ({ via: 'system', from: name, system: true });
const WORKDIR = 'workdir'; // the room's working directory: {cwd}

/** The first local seat's cwd becomes the room's working directory, where the room's Claude runs. */
function keepWorkdir(code: RoomCode, cwd: string | null | undefined): void {
  const kv = room.open(code).store.kv;
  if (cwd && !kv.get(WORKDIR)) kv.set(WORKDIR, { cwd });
}

/** Start the room's Claude (detached; claimSpawn is host only) in cwd, else the room's working directory, when none
 * runs. '' or the short systemMessage suffix the join hook shows. */
function ensureRoomClaude(code: RoomCode, cwd: string | null | undefined, by: string): string {
  let last: Member | null = null;
  try {
    last = identity.readMembers(code).claude ?? null;
    const c = roomClaude.claimSpawn(code, { by });
    if (!c) return '';
    // the room's task list and its room task, before the room session's task view first reads the directory
    try { roomClaude.openTaskList(code); } catch { /* the room session's tail repairs it (lib/tasks.ts repair) */ }
    seam.startDetached({ code, cwd: cwd || (room.open(code).store.kv.get<{ cwd?: string }>(WORKDIR) ?? {}).cwd, ...c });
  } catch (e) {
    return ` · the room's Claude could not start (${(msgOf(e) || String(e)).slice(0, 200)}); /sub-human still works, but there is no room task list`;
  }
  const failed = last && last.spawn_error ? ` (the last start failed: ${last.spawn_error})` : '';
  return ` · starting the room's Claude…${failed}`;
}

function enter({ code, name, role = 'member', machine = identity.machineIn(code), account, pid, session_id, cwd, pubkey, keepPrevious }: EnterOpts): EnterResult {
  // the seat's earlier record ended with no leave: its "left" line goes before this join's "rejoined"
  if (identity.isHost(code)) sweep(code, { name });
  // a seat on the host is the host account's (elsewhere the host's server decides: a mirror's join sends no account)
  if (account === undefined && machine && machine === identity.machineIn(code) && identity.isHost(code)) account = machine;
  const r: EnterResult = identity.join({ code, name, role, machine, account, pid, session_id, cwd, keepPrevious });
  if (!r.ok) return r;
  if (!identity.isHost(code)) return { ...r, note: '' };
  keepWorkdir(code, cwd);
  try {
    // machine null: this machine's id could not be read; the seat joins without one (validate refuses a null machine)
    room.open(code).append({ kind: 'member_joined', text: `${name} ${r.rejoin ? 'rejoined' : 'joined'}`, pubkey, ...(machine ? { machine } : {}) }, asSystem(name));
  } catch (e) {
    if (errCode(e) !== 'AUTH') throw e;
    identity.leave(code, name, {});
    return { ok: false, error: msgOf(e), code: 'AUTH' };
  }
  return { ...r, note: ensureRoomClaude(code, cwd, name) };
}

function exit(code: RoomCode, name: SeatName, reason: string, { deadlineMs }: { deadlineMs?: number | undefined } = {}): boolean {
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
  // Claude Code's SessionEnd token ("prompt_input_exit", "logout", "other") is written in words, as render reads it
  const why = CC_END_REASONS.has(reason) || /^[a-z]+(?:_[a-z]+)+$/.test(reason) ? 'session ended' : reason;
  // `/sub-human leave` (reason "left") is the person's own leave: nothing to add ("fresh left (left)" read oddly)
  room.open(code).append({ kind: 'member_left', text: why === 'left' ? `${name} left` : `${name} left (${why})` }, asSystem(name));
  return true;
}

/** Claude Code's SessionEnd reasons (hooks/handlers/session-end.ts passes them): a leave's line says "session ended". */
const CC_END_REASONS: ReadonlySet<string> = new Set(['prompt_input_exit', 'logout', 'other', 'clear', 'resume', 'bypass_permissions_disabled']);
/** Some link the host records names this seat (lib/remote/host-links.ts LINKS_KEY; read, not imported). */
function linked(s: { kv: { get<T>(key: string, dflt?: T): T | null } }, name: string): boolean {
  const recs = s.kv.get<Record<string, { seats?: unknown } | null>>('remote/links') ?? {};
  return Object.values(recs).some(l => !!l && Array.isArray(l.seats) && l.seats.includes(name));
}
const isLocal = (m: Member): boolean => validPid(m.pid) && identity.isMine(m.machine || identity.machineId());

function sweep(code: RoomCode, { now = Date.now(), name }: { now?: number; name?: string } = {}): string[] {
  const s = room.open(code).store;
  if (!s || !s.isHost) return [];
  const after = config.SEAT_LEASE_MS + envMs('SUB_HUMAN_LEAVE_MS');
  // lapsed: the lease is past the settle (a named seat: not alive), and the seat is still neither left nor lapsed
  const lapsed = (m: Member | undefined): m is Member => !!m && !m.left_at && !m.lapsed_at && !identity.seatAlive(m)
    && (name !== undefined || !(now - Date.parse(String(m.seen_at)) < after));
  const out: string[] = [];
  const all = Object.values(s.members.read());
  // one ps for every local seat whose start time is not known yet (lib/lock.ts keeps it while the pid lives)
  pidStarts(all.filter((m): m is Member => !!m && !m.left_at && isLocal(m)).map(m => m.pid as number));
  for (const m of all) {
    if (!m || !m.name || m.role === 'claude' || m.left_at || (name !== undefined && m.name !== name)) continue;
    if (m.lapsed_at && identity.seatAlive(m)) { back(code, m.name); continue; }
    if (!m.lapsed_at && identity.seatAlive(m)) continue;
    if (isLocal(m)) { if (exit(code, m.name, 'session ended')) out.push(m.name); continue; }
    // a seat of another machine that no link of the host names (its link was revoked, or a join a kick raced left
    // it behind): no beat can ever renew it, so it leaves instead of lapsing, and the room can close for good
    if (!identity.isMine(m.machine || identity.machineId()) && (m.lapsed_at || lapsed(m)) && !linked(s, m.name)) {
      if (exit(code, m.name, 'its connection was ended')) out.push(m.name);
      continue;
    }
    if (m.lapsed_at) continue;
    let set = false;
    s.members.update(ms => {
      set = false; // update may run fn more than once
      const seat = ms[m.name];
      if (!lapsed(seat)) return null;
      seat.lapsed_at = new Date(now).toISOString();
      set = true;
      return ms;
    });
    if (!set) continue;
    room.open(code).append({ kind: 'member_left', text: `${m.name} left (connection lost)` }, asSystem(m.name));
    out.push(m.name);
  }
  return out;
}

function back(code: RoomCode, name: SeatName): boolean {
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
interface TakeCtx { pid: number; session_id: string | undefined; cwd: string; cur: Identity | null; pubkey(code: RoomCode, name: SeatName): string }

const no = (text: string, refused = true): Taken => ({ ok: false, text, refused });

/** Who else is in the room, live (the room's Claude only while it runs). */
function others(code: RoomCode, name: SeatName): string[] {
  return Object.values<Member>(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at
    && (m.role !== 'claude' || roomClaudePresence(m) === 'live')).map(m => m.name);
}

function withWhom(code: RoomCode, name: SeatName): string {
  const names = others(code, name).filter(n => n !== identity.ROOM_CLAUDE);
  if (!names.length) return 'nobody else here yet';
  return names.length > 3 ? `${names.length} others here` : `with ${names.join(', ')}`;
}

/** An open room where name's seat is live and was taken from cwd (another session of this folder holds it): a bare
 * /sub-human opens no second room for that person. */
function liveSeatHere(cwd: string, name: string): RoomCode | null {
  try {
    for (const c of identity.openRooms()) {
      const m = identity.readMembers(c)[name];
      if (m && m.role !== 'claude' && m.cwd === cwd && identity.seatAlive(m)) return c;
    }
  } catch { /* unknown: no refusal */ }
  return null;
}

/** Close rooms where only the room's Claude is left once they have been orphaned long enough (best effort; host only). */
function sweepOrphans(): void {
  try { identity.pruneModLeases(); } catch { /* the next join retries */ }
  for (const c of identity.orphanRooms()) { try { roomClaude.watchdog(c); } catch { /* next join retries */ } }
}

/**
 * Why /sub-human opens no room in a fork of a session whose sub-human folder this process does not have (also after a
 * leave): where it sat, and how to get back. `claude --resume` refuses a session that runs in the background, so the way back stops it first.
 */
function forkedText(f: Pick<identity.ForkedAway, 'title' | 'home'>, sid: string | null | undefined): string {
  const id = sid || 'SESSION';
  const seated = /^[A-Za-z0-9_.-]+\.[a-z]+-\d{4}$/.test(f.title) ? `seated as ${f.title} ` : '';
  const from = f.home ? `a session ${seated}in sub-human folder ${f.home}` : `a session ${seated}in another sub-human folder`;
  return `the agent view moved this conversation here from ${from}, but this session's folder is ${identity.home()}: `
    + `SUB_HUMAN_HOME was set only in your shell, and Claude Code's background job does not get it. /sub-human opens or joins no room here. `
    + `To go back, in a terminal: claude stop ${id.slice(0, 8)}, then SUB_HUMAN_HOME=${f.home || '<that folder>'} claude --resume ${id}, and type /sub-human there. `
    + `For next time, set SUB_HUMAN_HOME in your Claude Code settings "env".`;
}

function take({ name, code, isDefault = false }: Wanted, { pid, session_id, cwd, cur, pubkey }: TakeCtx): Taken {
  let created = false;
  // a fork of a session whose folder is not this one: no room opened here, none joined that this folder does not have
  if (!cur && (!code || !identity.roomExists(code))) { const f = identity.forkedOf(session_id); if (f) return no(forkedText(f, session_id)); }
  try { gc().sweep({ keep: code }); } catch { /* the next join sweeps (lib/gc.ts: at most every GC_EVERY_MS, within GC_BUDGET_MS) */ }
  if (!code) {
    sweepOrphans();
    const open: RoomCode[] = identity.openRooms();
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
  // a link whose credentials a new join replaced (lib/remote/joining.ts): the seat joins again over it, even if seated
  const rebind = !host && !!(links.get(code) ?? {}).rebind;
  if (cur && same && !rebind) {
    joining().dropJoinAs(code);
    return { ok: true, me: cur, lead: 'already joined', msg: `you're already in ${cur.code} as ${name}, ${withWhom(code, name)}${ensureRoomClaude(code, cwd, name)}` };
  }
  // The seat's key: via=human posts and answers are signed with it, and the log pins it.
  let key: string;
  try { key = pubkey(code, name); } catch (e) { return no(`could not make ${name}'s signing key (${msgOf(e)}). Run /sub-human doctor.`); }
  // the seat this session holds now is left only once the new one is taken: a refused join changes nothing
  const r = enter({ code, name, pid, session_id, cwd, pubkey: key, keepPrevious: !!cur && !same });
  if (!r.ok) {
    if (isDefault && /^name taken/.test(r.error || '')) return no(`"${name}" is taken in room ${code}; pick another: /sub-human NAME${created ? '' : ` ${code}`}`);
    // the name sits in the room with a key made elsewhere (a new home or machine); a key never moves
    if (/pinned to another key/.test(r.error || '')) {
      const bound = !host && !!(links.get(code) ?? {}).token;
      return no(`could not join ${code} as ${name}: ${name} is in this room with a key from another machine or sub-human folder, and a seat's key never moves. ${bound ? 'This connection is bound to that name: ask the host for a new invite; their card lets this machine in under a new name' : `Join under another name: /sub-human NAME ${code}`}`);
    }
    return no(`could not join ${code} as ${name}: ${r.error || 'unknown error'}${cur && !same ? `; you're still ${cur.name} in room ${cur.code}` : ''}`);
  }
  if (cur && !same) exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  const linked = rebind ? links.get(code) : null; // rebind: read from it above
  if (linked) { const { rebind: _done, ...l } = linked; links.set(code, l); }
  joining().dropJoinAs(code);
  try { gc().sweepRows(code); } catch { /* best effort: rows of ended sessions */ }
  if (host) {
    try { webhostLib().ensure(code); } catch { /* best effort */ } // the listener after a reboot
    try { shimLib().refresh(); } catch { /* best effort */ } // the serve shim a login link runs
  }
  const me: Identity = { code, name, role: 'member', pid, session_id: session_id || null, address: identity.address(name, code) };
  const msg = created
    ? `opened room ${code} as ${name} · on this machine others join with /sub-human; another machine: /sub-human invite`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}, ${withWhom(code, name)} · @room to talk, @claude to ask the room's Claude`;
  return { ok: true, me, lead: created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', msg: `${msg}${r.note}` };
}

/** Test seam: the room's Claude starts through this object, which a test may stub (test/seats.node-test.ts); an ES
 * module's own exports are read-only. */
const seam = { startDetached: (o: Parameters<typeof roomClaude.startDetached>[0]): number | undefined => roomClaude.startDetached(o) };

export { enter, exit, sweep, back, ensureRoomClaude, seam, take, withWhom, liveSeatHere, forkedText };
