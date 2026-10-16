/**
 * plugin/sub-human/lib/identity.ts: where rooms live, who is in them, and which Claude session is asking.
 * Identity is bound at join by a hook and never chosen by the model.
 * Participants are collaborators: there is no process-ancestry proof. A seat is found by a direct lookup of
 * the session id (hooks) or of a registered claude pid (MCP server, CLI). Every seat stores its process start
 * time (pid_start, epoch s, lib/lock.ts pidStart), so a reused pid never keeps a dead seat alive or adopts it.
 * Every seat also stores its machine (machineId), so a pid is only ever checked on the machine it belongs to.
 *
 * Location:
 *   home() -> string                     SUB_HUMAN_HOME, else ~/.sub-human (read on every call; lib/home.ts)
 *   roomDir(code) -> string              <home>/rooms/<code> (lib/home.ts; validates the code)
 *   newCode() -> string                  "otter-4821": a fresh room, created with an exclusive mkdir
 *   roomExists(code) -> bool
 *   openRooms() -> [code]                rooms with >= 1 live member seat (role member) that are not closing,
 *                                        newest first, judged among the rooms the open-rooms index names (lib/room/store.ts
 *                                        indexedRooms: kept at open, join and close), not every room ever made; a room
 *                                        found closed for good (every seat left, its room Claude stopped or never
 *                                        started) leaves the index. The start times of every live local pid it judges come from one
 *                                        ps call (lib/lock.ts pidStarts), not one per seat. No room Claude seat is needed: the first member opens it. A room
 *                                        where only the room's Claude is left is not open (see orphanRooms).
 *   closedForGood(members) -> bool       every person's seat left (one whose session crashed has not) and the room's
 *                                        Claude stopped or never started: only a join reopens it (lib/gc.ts sets aside
 *                                        only such a room)
 *   orphanRooms() -> [code]              rooms not closing whose room Claude is not stopped but which have no live member
 *                                        (join sweeps these through roomClaude.watchdog)
 *   roomOpen(code) -> bool               not closing and has any live seat, the room's Claude included (a resume may
 *                                        rejoin a room whose room Claude is waiting out the reap grace)
 *   roomClosing(code) -> bool            members claude.closing is set (the reaper is shutting the room down)
 *   pruneSessionIndexes(now?, ttlMs?) -> n   by-sid and by-pid index records not written in ttlMs (SESSION_INDEX_TTL_MS)
 *                                        whose pid is not alive with its recorded start time, and EnterPlanMode mode
 *                                        notes (sessions/mode, hooks.json) over a minute old: lib/gc.ts
 *   isHost(code) -> bool                 this machine holds the room (its store's isHost): the room Claude's spawn, reap
 *                                        and watchdog and proposal decisions run only here
 *   machineId() -> string                this machine's id (lib/home.ts), a seat record's `machine`; machineIn(code) its id in
 *                                        a room joined over a link, isMine(id) any of them (lib/home.ts)
 *
 * Members (the room's members document, lib/room/store.ts members; seats change through its named ops join,
 * leave and beat, whose rules are lib/room/members.ts):
 *   readMembers(code) -> {name: {name, role, machine, pid?, pid_start?, session_id?, cwd?, joined_at, seen_at,
 *       left_at?}}   pid, pid_start, session_id and cwd only for a seat of the machine that holds the room
 *       The "claude" record also carries {job, spawned_at, closing?, stopped_at?, claim?, by?, ...} (lib/room-claude.ts);
 *       before the spawned room Claude binds, it is {name:"claude", role:"claude", pid:null, job, spawned_at}, and while a
 *       spawn is in flight job is "pending".
 *   updateRoomClaude(code, fn) -> record|null  under the lock: fn(room Claude record or null, members) returns a patch to
 *                                        merge (the new record is returned) or null to write nothing (null)
 *   seatAlive(m) -> bool                 not left, and: a seat of this machine with a pid: that pid is alive with
 *                                        its start time matching pid_start; any other seat: its lease (seen_at)
 *                                        is fresh (lib/room/members.ts)
 *   normalizeName(text) -> name | null   a name from a person's own name: the first word, lowercased, accents dropped,
 *                                        only NAME_RE's characters; null when nothing is left or it is reserved
 *   defaultName({cwd?, env?}) -> name | null   the name /sub-human uses when none is typed: git's user.name (cwd's
 *                                        repo, else the global one), else the local part of git's user.email, else
 *                                        $USER, each through normalizeName ("Tristan Timblin" -> "tristan")
 *   heartbeat(me, now?) -> bool          renew me's lease, seen_at (members.beat, at most every SEAT_BEAT_MS; the
 *                                        tail's health tick and the hold server); leaseFresh(m, now?)
 *   liveMembers(code) -> [name]          the people's seats (not the room's Claude) that are seatAlive
 *   join({code, name, role, machine?, account?, pid, session_id, cwd}) -> {ok, error?, rejoin?}
 *       role is "claude" (the room's Claude) or "member". NAME_RE; reserved names (RESERVED) claude, room, all,
 *       system, host, and every /sub-human verb (VERBS): only role claude may use
 *       "claude", and role claude must use it. members.join: a name held by a live seat of another holder
 *       (another pid, or another machine) is "name taken"; otherwise the name is (re)bound. The room's Claude record
 *       keeps its job / spawned_at across a (re)bind. machine defaults to this one; a seat of this machine needs
 *       its pid, and after the op: one seat per claude pid (joining elsewhere retires its previous seat), then
 *       the indexes <home>/sessions/by-pid/<pid>.json and <home>/sessions/by-sid/<sid>.json. A seat of another
 *       machine (the remote server) has no pid here and no index.
 *   leave(code, name, {reason, deadlineMs}?) -> bool   members.leave (sets left_at; on a mirror the host's leave
 *                                        op, which logs member_left with the reason), then drops the by-pid index
 *                                        when it still names this seat. The by-sid index stays so lastSeat() can
 *                                        find the seat on --resume.
 *   rebindSession(pid, sid) -> bool      after /clear: point a new session id at the seat registered for pid (on a
 *                                        mirror only the indexes: the host never holds a seat's session)
 *
 * Resolution (each returns the identity record {code, name, role, session_id, pid, address} or null;
 * address = "NAME.CODE", the session title other Claudes reach it by with SendMessage). In a room this machine
 * mirrors (lib/room/store-mirror.ts), whose members document holds no pid, start time or session, a seat of this
 * machine is judged by its index record's:
 *   resolveBySession(sid)                hooks: the payload's session_id
 *   resolveByPid(pid)                    the MCP server: process.ppid, a direct lookup of a registered pid
 *                                        (null when that pid now belongs to a process with another start time)
 *   resolveSelf()                        the CLI and the tail: CLAUDE_CODE_SESSION_ID (set by Claude Code for
 *                                        Bash, hooks and the status line; the mod sets it for its tail child), then CLAUDE_PID (same
 *                                        children), then the nearest ancestor pid with a registration
 *   lastSeat(sid) -> {code, name, role}|null   the seat a session id last held, left or not (for --resume)
 *   forkParent(sid, dir) -> {sid, code, name, role}|null   the seat this session's conversation came from when ← (the
 *                                        agent view) moved it into a bg job under a new id: a seat still held by an
 *                                        older session whose transcript, beside this one's in dir, says it continued
 *                                        in sid (lib/cc/transcript.ts continuedIn; CONTRACT session-fork-continued-in)
 *   adoptFork(from, {pid, session_id, cwd}) -> JoinResult   move that seat to this process and session (no leave, no
 *                                        log line: the person never left); the old session's indexes are dropped
 *   localSeats(code) -> [name]           this machine's seats in code that a live claude process holds, by the
 *                                        session indexes (resolveByPid): what a mirror knows while its link is down
 *   claudePid() -> int|null              CLAUDE_PID from the environment (hooks run with it set; lib/cc/env.ts)
 *   adoptLocalSeats(code) -> [name]      after this machine became the room's host (lib/handoff.ts): its seats' records
 *                                        get back pid, pid_start and session_id from the session indexes (a mirror's
 *                                        members document never held them), so they resolve here as host seats
 *
 * The hooks module's lease, <home>/sessions/mods/<sid>.json (atomic, 0600): this session's function hooks are
 * loaded and have said hello (hooks/handlers/mod-hello.ts writes it, join requires it, session-end deletes it). Fields:
 *   {session_id, pid, pid_start?, at, nonce?}   pid: the claude process the module runs in; pid_start: its
 *                                        start time (epoch s); at: ISO time written; nonce: the module's secret for
 *                                        the session (32 hex), which hooks/handlers/at-room.ts requires beside an origin.
 *                                        Keep it one small flat object.
 *   writeModLease(sid, {pid, nonce}) -> bool
 *   readModLease(sid) -> rec|null;  deleteModLease(sid) -> bool
 *   modLeaseOk(sid, pid, now?) -> bool   the lease is this claude process's (pid alive, start time matching), or
 *                                        was written within MOD_LEASE_FRESH_MS
 *   pruneModLeases(now?) -> n            delete leases whose process is gone (no pid: once past the fresh window)
 *
 * Presence (the room documents presence/<name> = {state, at, detail?}, written by members.beat with the lease):
 *   writePresence(code, name, state, detail?)   state: working (prompt submitted / joined) | idle (idle_prompt)
 *                                               | permission (permission_prompt) | error (StopFailure; detail = code).
 *                                               false for a name with no seat (or a left one)
 *
 * Also: isAlive (lib/io.ts), NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES.
 * Room state (members, presence, the room list) goes through lib/room/store.ts; seats change only through the
 * members ops, the room's Claude record through members.update (atomic). The session indexes (<home>/sessions/, which
 * seat a local pid or session id holds) are this machine's, not the room's, and stay here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readJson, writeJsonAtomic, isAlive, validPid } from './io.ts';
import { home, roomDir, machineId, machineIn, isMine } from './home.ts';
import { pidStart, pidStarts } from './lock.ts';
import { NAME_RE, CODE_RE, SID_SAFE as SID_RE } from './text.ts';
import { sidIndex } from '../mod/core/seat.ts';
import { SEAT_BEAT_MS, MOD_LEASE_FRESH_MS, SESSION_INDEX_TTL_MS } from './config.ts';
import {
  seatAlive, leaseFresh, startMatches, PRESENCE_STATES, ROOM_CLAUDE, LOG_V,
} from './room/members.ts';
import * as cc from './cc/env.ts';
import { continuedIn } from './cc/transcript.ts';
import type { JoinResult, Member, Members, MembersApi, PresenceState, Role, SeatRecord } from './room/types.ts';

/** A resolved seat (resolveBySession, resolveByPid, resolveSelf): address = NAME.CODE, the session title. */
interface Identity {
  code: string;
  name: string;
  role: Role;
  session_id: string | null;
  pid: number | null | undefined;
  address: string;
}

/** A session index record, <home>/sessions/by-pid/<pid>.json and by-sid/<sid>.json: which seat a local pid or session holds. */
interface SeatIndex {
  code: string;
  name: string;
  role: Role;
  pid: number | null | undefined;
  pid_start?: number;
  session_id: string | null;
  address: string;
}

/** The hooks module's lease, <home>/sessions/mods/<sid>.json (see the header). */
interface ModLease {
  session_id: string;
  pid: number | null;
  pid_start?: number;
  at?: string;
  nonce?: string;
}

/** join()'s argument. */
interface JoinRequest {
  code: string;
  name: string;
  role: string;
  machine?: string | null;
  /** the person behind the seat (lib/seats.ts enter); kept on the record, never sent by a mirror */
  account?: string;
  pid?: number | string | null;
  session_id?: string | null;
  cwd?: string | null;
  /** what log a remote seat's code reads, as its join said (lib/remote/server.ts join; a local seat's is this code's) */
  log_v?: number;
}

/** The room's Claude's record as updateRoomClaude patches it: undefined deletes a field. */
type RoomClaudePatch = { [K in keyof Member]?: Member[K] | undefined };
// MOD_LEASE_FRESH_MS only covers a module whose $.process parent is not claude itself: a resumed session id whose
// lease is older than this, from a process that is gone, cannot join.
// the room's own names, then every /sub-human verb, so `/sub-human doctor` is never a person called doctor
const VERBS: readonly string[] = ['invite', 'join', 'kick', 'leave', 'doctor', 'help', 'admit', 'handoff', 'promote', 'demote'];
const RESERVED: readonly string[] = [ROOM_CLAUDE, 'room', 'all', 'system', 'host', ...VERBS];
const ROLES: readonly string[] = [ROOM_CLAUDE, 'member'];
const ANIMALS = [
  'otter', 'badger', 'beaver', 'bison', 'camel', 'cheetah', 'condor', 'coyote',
  'crane', 'dingo', 'dolphin', 'eagle', 'egret', 'falcon', 'ferret', 'finch',
  'gecko', 'gibbon', 'gopher', 'heron', 'hippo', 'husky', 'ibex', 'iguana',
  'jackal', 'jaguar', 'koala', 'lemur', 'leopard', 'llama', 'lynx', 'macaw',
  'marmot', 'marten', 'mink', 'moose', 'narwhal', 'newt', 'ocelot', 'orca',
  'osprey', 'panda', 'parrot', 'pelican', 'penguin', 'puffin', 'quail', 'rabbit',
  'raven', 'salmon', 'seal', 'shrew', 'sloth', 'stoat', 'swan', 'tapir',
  'tiger', 'toucan', 'turtle', 'vole', 'walrus', 'weasel', 'wombat', 'zebra',
];

// ---------- the default name ----------
function normalizeName(text: unknown): string | null {
  const first = String(text || '').trim().split(/\s+/)[0] || '';
  const n = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').replace(/^[._-]+/, '').slice(0, 32);
  return n && NAME_RE.test(n) && !RESERVED.includes(n) ? n : null;
}

function defaultName({ cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const git = (key: string): string => {
    try {
      const r = spawnSync('git', ['config', '--get', key], { cwd, env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? String(r.stdout || '').trim() : '';
    } catch { return ''; }
  };
  for (const pick of [() => git('user.name'), () => git('user.email').split('@')[0], () => env.USER || env.LOGNAME || '']) {
    const n = normalizeName(pick());
    if (n) return n;
  }
  return null;
}

// ---------- location ----------
import * as store from './room/store.ts';
const roomExists = (code: unknown): boolean => store.roomExists(code);
const byPidDir = (): string => path.join(home(), 'sessions', 'by-pid');
const byPidFile = (pid: unknown): string => path.join(byPidDir(), `${Number(pid)}.json`);
// the path is mod/core/seat.ts sidIndex's: the hooks module checks it for a seat without node
const bySidFile = (sid: string): string => sidIndex(path.resolve(home()), sid) || path.join(home(), 'sessions', 'by-sid', `${sid}.json`);
const modLeaseFile = (sid: string): string => path.join(home(), 'sessions', 'mods', `${sid}.json`);
const address = (name: string, code: string): string => `${name}.${code}`;
/** The room's members document (lib/room/store.ts members: read(), the ops join/leave/beat, update(fn) atomic). */
const membersOf = (code: string): MembersApi => store.open(code).members;
const isHost = (code: string): boolean => store.open(code).isHost;

function newCode(): string {
  for (let i = 0; i < 200; i++) {
    const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const code = `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    if (store.createRoom(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

const rm = (file: string): void => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

// ---------- members ----------
function readMembers(code: string): Members {
  try { return membersOf(code).read(); } catch { return {}; }
}

const fail = (error: string): JoinResult => ({ ok: false, error });

/**
 * Renew me's lease (members seen_at), at most every SEAT_BEAT_MS: the tail's health tick and the hold server
 * call it. Only for the seat as me holds it (same pid when me has one; not left). Returns true when written.
 */
function heartbeat(me: { code?: string; name?: string; pid?: number | null } | null | undefined, now = Date.now()): boolean {
  if (!me || !me.code || !me.name || !roomExists(me.code)) return false;
  const m: Member | undefined = readMembers(me.code)[me.name]; // the cheap check, before the op (a mirror's document holds no pid)
  const stale = !!m && !m.left_at && (!validPid(me.pid) || m.pid == null || m.pid === me.pid) && !(Date.parse(String(m.seen_at)) > now - SEAT_BEAT_MS);
  return stale && membersOf(me.code).beat(me.name, { now });
}

/** The session index record of seat m: which seat a local pid or session id holds. */
const indexRec = (code: string, m: Member | SeatRecord): SeatIndex => ({ code, name: m.name, role: m.role, pid: m.pid, ...(m.pid_start != null ? { pid_start: m.pid_start } : {}), session_id: m.session_id || null, address: address(m.name, code) });
function writeIndexes(code: string, m: Member | SeatRecord): void {
  const rec = indexRec(code, m);
  writeJsonAtomic(byPidFile(m.pid), rec);
  if (m.session_id) writeJsonAtomic(bySidFile(m.session_id), rec);
}

/** One seat per claude process: the seat pid held before this join (another name or room) is left. */
function retirePrevious(code: string, name: string, pid: number): void {
  const prev: SeatIndex | null = readJson(byPidFile(pid));
  if (!prev || (prev.code === code && prev.name === name)) return;
  try {
    const m = indexedSeat(prev);
    if (m && m.pid === pid && !m.left_at) membersOf(prev.code).leave(prev.name, { reason: 'joined another room' });
  } catch { /* old room gone */ }
}

/** The record members.join stores for a seat of this machine: its pid, start time, session and cwd too. */
function localSeat({ name, role, machine, pid, session_id, cwd }: { name: string; role: Role; machine: string | null; pid: number; session_id?: string | null; cwd?: string | null }): SeatRecord {
  const start = pidStart(pid);
  return { name, role, machine, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, cwd: cwd || null };
}

function join({ code, name, role, machine = machineIn(code), account, pid: pidArg, session_id, cwd, log_v }: JoinRequest = {} as JoinRequest): JoinResult {
  if (!roomExists(code)) return fail(`no room "${code}"`);
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (!ROLES.includes(role)) return fail(`invalid role "${role}"`);
  if (RESERVED.includes(name.toLowerCase()) && !(name === ROOM_CLAUDE && role === ROOM_CLAUDE)) return fail(`"${name}" is reserved`);
  if (role === ROOM_CLAUDE && name !== ROOM_CLAUDE) return fail(`the room's Claude joins as "${ROOM_CLAUDE}"`);
  const local = isMine(machine);
  const pid = Number(pidArg);
  if (local && !validPid(pid)) return fail(`invalid pid "${pid}"`);
  if (session_id != null && (typeof session_id !== 'string' || !SID_RE.test(session_id))) return fail('invalid session_id');

  const seatRole = role as Role; // one of ROLES
  // log_v: what this code reads (a seat of this machine), or what a remote seat's join said (lib/room/members.ts
  // holdsRotation: a seat without it holds the log's rotation on its machine)
  const reads = local ? LOG_V : typeof log_v === 'number' && Number.isInteger(log_v) && log_v > 0 && log_v < 100 ? log_v : undefined;
  const rec: SeatRecord = { ...(local ? localSeat({ name, role: seatRole, machine, pid, session_id, cwd }) : { name, role: seatRole, machine }), ...(account ? { account } : {}), ...(reads ? { log_v: reads } : {}) };
  const r = membersOf(code).join(rec);
  if (r.ok) store.indexRoom(code); // it may be open from here on (lib/room/registry.ts)
  if (r.ok && local) {
    retirePrevious(code, name, pid);
    writeIndexes(code, rec);
  }
  return r;
}

function leave(code: string, name: string, opts?: { reason?: string; deadlineMs?: number }): boolean {
  if (!roomExists(code)) return false;
  if (!membersOf(code).leave(name, opts)) return false;
  const m = readMembers(code)[name];
  if (m && m.left_at && validPid(m.pid)) {
    const p: SeatIndex | null = readJson(byPidFile(m.pid));
    if (p && p.code === code && p.name === name) rm(byPidFile(m.pid));
  }
  return true;
}

function rebindSession(pid: unknown, sid: unknown): boolean {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  const who = resolveByPid(pid);
  if (!who) return false;
  const swap = (m: Member): void => {
    if (m.session_id && m.session_id !== sid) rm(bySidFile(m.session_id));
    m.session_id = sid;
    writeIndexes(who.code, m);
  };
  if (!isHost(who.code)) { swap(indexedSeat(readJson(byPidFile(pid)))!); return true; } // resolveByPid found this seat
  let ok = false;
  membersOf(who.code).update(members => {
    const m = members[who.name];
    if (!m) return null;
    swap(m);
    ok = true;
    return members;
  });
  return ok;
}

// ---------- resolution ----------
const seat = (code: string, m: Member): Identity => ({ code, name: m.name, role: m.role, session_id: m.session_id || null, pid: m.pid, address: address(m.name, code) });

/**
 * The members record of the seat index record idx names. On a mirror, whose document holds no pid, start time or
 * session, a seat of this machine gets them from idx.
 */
function indexedSeat(idx: SeatIndex): Member | undefined {
  const m = readMembers(idx.code)[idx.name];
  if (!m || isHost(idx.code) || !isMine(m.machine || machineId())) return m;
  return { ...m, pid: idx.pid, pid_start: idx.pid_start, session_id: idx.session_id };
}

function resolveByPid(pidArg: unknown): Identity | null {
  const pid = Number(pidArg);
  if (!validPid(pid)) return null;
  const rec: SeatIndex | null = readJson(byPidFile(pid));
  if (!rec || !roomExists(rec.code)) return null;
  const m = indexedSeat(rec);
  if (!m || m.left_at || m.pid !== pid || !startMatches(m)) return null;
  return seat(rec.code, m);
}

function resolveBySession(sid: unknown): Identity | null {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const rec: SeatIndex | null = readJson(bySidFile(sid));
  if (!rec || !roomExists(rec.code)) return null;
  const m = indexedSeat(rec);
  if (!m || m.left_at || m.session_id !== sid) return null;
  return seat(rec.code, m);
}

const NONCE_RE = /^[0-9a-f]{32}$/;

function writeModLease(sid: unknown, { pid: pidArg, nonce }: { pid?: unknown; nonce?: unknown } = {}): boolean {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  const pid = Number(pidArg);
  const rec: ModLease = { session_id: sid, pid: validPid(pid) ? pid : null };
  const start = rec.pid ? pidStart(pid) : null;
  if (start != null) rec.pid_start = start;
  rec.at = new Date().toISOString();
  if (typeof nonce === 'string' && NONCE_RE.test(nonce)) rec.nonce = nonce;
  writeJsonAtomic(modLeaseFile(sid), rec);
  return true;
}

function readModLease(sid: unknown): ModLease | null {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  return readJson(modLeaseFile(sid));
}

const leaseYoung = (lease: ModLease | null, now: number): boolean => { const t = Date.parse(String(lease && lease.at)); return Number.isFinite(t) && now - t < MOD_LEASE_FRESH_MS; };
/** The lease's own process is still the one that wrote it (startMatches tolerates an unreadable start). */
const leaseLive = (lease: ModLease | null): boolean => !!lease && validPid(lease.pid) && isAlive(lease.pid) && startMatches(lease);

/**
 * The session's lease lets a join through: written by the module running in this claude process (pid, with
 * its start time, so a reused pid does not count), or recently. Any other lease is a leftover: a session id
 * resumed in a process whose module never said hello (--bare, hooks off) must not inherit the old one.
 */
function modLeaseOk(sid: unknown, pid: unknown, now = Date.now()): boolean {
  const lease = readModLease(sid);
  if (!lease || lease.session_id !== sid) return false;
  if (validPid(Number(pid)) && lease.pid === Number(pid) && leaseLive(lease)) return true;
  return leaseYoung(lease, now);
}

function deleteModLease(sid: unknown): boolean {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  rm(modLeaseFile(sid));
  return true;
}

/** Delete leases whose process is gone; a lease with no pid (or unreadable) once it is past the fresh window. */
function pruneSessionIndexes(now = Date.now(), ttlMs = SESSION_INDEX_TTL_MS): number {
  let n = 0;
  for (const dir of [byPidDir(), path.join(home(), 'sessions', 'by-sid')]) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      let old = false;
      try { old = now - fs.statSync(file).mtimeMs >= ttlMs; } catch { continue; }
      if (!old) continue;
      const rec: SeatIndex | null = readJson(file);
      if (rec && validPid(rec.pid) && seatAlive({ ...rec, machine: machineId() } as Member)) continue; // a live session's
      rm(file);
      n++;
    }
  }
  // the EnterPlanMode mode notes (hooks.json) consent did not take: a minute is long past fresh
  const modes = path.join(home(), 'sessions', 'mode');
  let notes: string[] = [];
  try { notes = fs.readdirSync(modes); } catch { /* none */ }
  for (const f of notes) {
    const file = path.join(modes, f);
    try { if (now - fs.statSync(file).mtimeMs >= 60_000) { rm(file); n++; } } catch { /* gone */ }
  }
  return n;
}

function pruneModLeases(now = Date.now()): number {
  const dir = path.join(home(), 'sessions', 'mods');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    const lease: ModLease | null = readJson(file);
    let gone: boolean;
    if (lease && validPid(lease.pid)) gone = !leaseLive(lease);
    else if (lease) gone = !leaseYoung(lease, now);
    else { try { gone = now - fs.statSync(file).mtimeMs >= MOD_LEASE_FRESH_MS; } catch { gone = false; } }
    if (gone) { rm(file); n++; }
  }
  return n;
}

function localSeats(code: string): string[] {
  let files: string[];
  try { files = fs.readdirSync(byPidDir()); } catch { return []; }
  const names = new Set<string>();
  for (const f of files) {
    const rec: SeatIndex | null = readJson(path.join(byPidDir(), f));
    if (!rec || rec.code !== code || !isAlive(rec.pid)) continue;
    const who = resolveByPid(rec.pid);
    if (who && who.code === code) names.add(who.name);
  }
  return [...names];
}

function adoptLocalSeats(code: string): string[] {
  let files: string[];
  try { files = fs.readdirSync(byPidDir()); } catch { return []; }
  const recs = files.map((f): SeatIndex | null => readJson(path.join(byPidDir(), f))).filter((r): r is SeatIndex & { pid: number } => !!r && r.code === code && validPid(r.pid) && isAlive(r.pid));
  if (!recs.length) return [];
  const names: string[] = [];
  membersOf(code).update(ms => {
    names.length = 0;
    for (const r of recs) {
      const m = ms[r.name];
      if (!m || m.left_at || (m.machine && !isMine(m.machine))) continue;
      ms[r.name] = { ...m, machine: m.machine || machineIn(code), pid: r.pid, ...(r.pid_start != null ? { pid_start: r.pid_start } : {}), session_id: r.session_id || null };
      names.push(r.name);
    }
    return names.length ? ms : null;
  });
  return names;
}

function lastSeat(sid: unknown): { code: string; name: string; role: Role; address: string } | null {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const rec: SeatIndex | null = readJson(bySidFile(sid));
  if (!rec || !roomExists(rec.code) || !NAME_RE.test(String(rec.name))) return null;
  const name = rec.name;
  const role: Role = rec.role === ROOM_CLAUDE ? ROOM_CLAUDE : 'member';
  return { code: rec.code, name, role, address: address(name, rec.code) };
}

type ForkParent = { sid: string; code: string; name: string; role: Role };

function forkParent(sid: unknown, dir: string | null | undefined): ForkParent | null {
  if (typeof sid !== 'string' || !SID_RE.test(sid) || typeof dir !== 'string' || !dir) return null;
  let names: string[];
  try { names = fs.readdirSync(path.dirname(bySidFile(sid))); } catch { return null; }
  for (const f of names) {
    const old = f.replace(/\.json$/, '');
    if (old === sid || !SID_RE.test(old)) continue;
    const transcript = path.join(dir, `${old}.jsonl`);
    if (!fs.existsSync(transcript)) continue; // not a session of this directory
    const rec: SeatIndex | null = readJson(bySidFile(old));
    if (!rec || !roomExists(rec.code) || !NAME_RE.test(String(rec.name))) continue;
    const m = indexedSeat(rec);
    if (!m || m.left_at || m.session_id !== old) continue;
    if (continuedIn(transcript) !== sid) continue;
    return { sid: old, code: rec.code, name: rec.name, role: rec.role === ROOM_CLAUDE ? ROOM_CLAUDE : 'member' };
  }
  return null;
}

function adoptFork(from: ForkParent, { pid: pidArg, session_id, cwd }: { pid: unknown; session_id: string; cwd?: string | null }): JoinResult {
  const pid = Number(pidArg);
  if (!validPid(pid)) return fail(`invalid pid "${pid}"`);
  const before: SeatIndex | null = readJson(bySidFile(from.sid));
  if (isHost(from.code)) {
    // the old process still runs (as the agent view), so its pid is alive: the seat is handed over, not taken
    let moved = false;
    membersOf(from.code).update(ms => {
      moved = false;
      const m = ms[from.name];
      if (!m || m.left_at || m.session_id !== from.sid) return null;
      m.pid = pid;
      const st = pidStart(pid);
      if (st != null) m.pid_start = st; else delete m.pid_start;
      moved = true;
      return ms;
    });
    if (!moved) return fail(`the seat ${from.name} in ${from.code} is no longer the old session's`);
  }
  const r = join({ code: from.code, name: from.name, role: from.role, pid, session_id, cwd });
  if (r.ok) {
    rm(bySidFile(from.sid));
    const oldPid = before && validPid(before.pid) ? before.pid : null;
    if (oldPid && oldPid !== pid) {
      const p: SeatIndex | null = readJson(byPidFile(oldPid));
      if (p && p.code === from.code && p.name === from.name) rm(byPidFile(oldPid));
    }
  }
  return r;
}

const claudePid = () => cc.claudePid();

function parentTable(): Map<number, number> {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 << 20 });
  const t = new Map<number, number>();
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (m) t.set(Number(m[1]), Number(m[2]));
  }
  return t;
}

function resolveSelf(): Identity | null {
  const bySid = resolveBySession(cc.sessionId());
  if (bySid) return bySid;
  const env = claudePid();
  if (env) { const r = resolveByPid(env); if (r) return r; }
  // Fallback: the nearest ancestor that has a registration (only registered pids are looked up).
  let table: Map<number, number> | null = null;
  let pid = process.pid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    if (fs.existsSync(byPidFile(pid))) { const r = resolveByPid(pid); if (r) return r; }
    if (!table) table = parentTable();
    const pp = pid === process.pid ? process.ppid : table.get(pid);
    if (!pp) break;
    pid = pp;
  }
  return null;
}

// ---------- rooms ----------
const isMember = (m: Member | null | undefined): m is Member => !!m && m.role !== 'claude';
const liveMembers = (code: string): string[] => Object.values(readMembers(code)).filter(m => isMember(m) && seatAlive(m)).map(m => m.name);
const roomClosing = (code: string): boolean => { const o = readMembers(code).claude; return !!(o && o.closing); };

/** Closed for good: no person's seat that has not left, and no room Claude that may still run. Only a join reopens it. */
const closedForGood = (ms: Members): boolean => !Object.values(ms).some(m => !!m && (isMember(m) ? !m.left_at : roomClaudeActive(m)));

/**
 * The indexed rooms' members documents, with the start times of their live local pids read by one ps call. A room
 * closed for good, or whose directory and link are gone, leaves the index.
 */
function allMembers(): { code: string; ms: Members }[] {
  const all = store.indexedRooms().filter(roomExists).map(code => ({ code, ms: readMembers(code) }));
  const gone = store.indexedRooms().filter(c => !roomExists(c)).concat(all.filter(r => closedForGood(r.ms)).map(r => r.code));
  if (gone.length) { try { store.unindexRooms(gone); } catch { /* the next look drops them */ } }
  const open = all.filter(r => !closedForGood(r.ms));
  pidStarts(open.flatMap(({ ms }) => Object.values(ms)).filter(m => m && !m.left_at && validPid(m.pid) && (!m.machine || isMine(m.machine)) && isAlive(m.pid)).map(m => m.pid as number));
  return open;
}

function openRooms(): string[] {
  const open: { code: string; at: string }[] = [];
  for (const { code, ms } of allMembers()) {
    if (ms.claude && ms.claude.closing) continue;
    const live = Object.values(ms).filter(m => isMember(m) && seatAlive(m));
    if (live.length) open.push({ code, at: live.map(m => m.joined_at || '').sort().at(-1)! }); // live is not empty
  }
  return open.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(r => r.code);
}

/** The room's Claude record still owns a job or a live seat (not stopped, not left). */
const roomClaudeActive = (o: Member | null | undefined): boolean => !!o && !o.stopped_at && (seatAlive(o) || (!o.left_at && !!o.job));

function orphanRooms(): string[] {
  const out: string[] = [];
  for (const { code, ms } of allMembers()) {
    const o = ms.claude;
    if (!o || o.closing || !roomClaudeActive(o)) continue;
    if (!Object.values(ms).some(m => isMember(m) && seatAlive(m))) out.push(code);
  }
  return out;
}

function roomOpen(code: string): boolean {
  if (!roomExists(code)) return false;
  const ms = readMembers(code);
  if (ms.claude && ms.claude.closing) return false;
  return Object.values(ms).some(seatAlive);
}

function updateRoomClaude(code: string, fn: (current: Member | null, members: Members) => RoomClaudePatch | null | undefined): Member | null {
  if (!roomExists(code)) throw new Error(`no room "${code}"`);
  let rec: Member | null = null;
  membersOf(code).update(members => {
    rec = null;
    const patch = fn(members.claude || null, members);
    if (!patch) return null;
    const next = { name: ROOM_CLAUDE, role: ROOM_CLAUDE, pid: null, ...(members.claude || {}) as Partial<Member>, ...patch } as Member; // a patch keeps name and role
    for (const k of Object.keys(next) as (keyof Member)[]) if (next[k] === undefined) delete next[k];
    members.claude = rec = next;
    return members;
  });
  return rec;
}


// ---------- presence ----------
function writePresence(code: string, name: string, state: string, detail?: string | null): boolean {
  if (!NAME_RE.test(String(name)) || !PRESENCE_STATES.includes(state as PresenceState)) return false;
  try { return membersOf(code).beat(name, { presence: { state, detail } }); } catch { return false; }
}

export {
  NAME_RE, CODE_RE, RESERVED, VERBS, ROOM_CLAUDE, ANIMALS, PRESENCE_STATES, normalizeName, defaultName, home,
  roomDir, machineId, machineIn, isMine, newCode, roomExists, isHost, openRooms, closedForGood, orphanRooms, roomOpen, roomClosing, address,
  readMembers, join, leave, rebindSession, updateRoomClaude, liveMembers, seatAlive, heartbeat,
  leaseFresh, isAlive, claudePid, resolveByPid, resolveBySession, resolveSelf, lastSeat, forkParent, adoptFork, localSeats, adoptLocalSeats,
  MOD_LEASE_FRESH_MS, writeModLease, readModLease, modLeaseOk, deleteModLease, pruneModLeases, pruneSessionIndexes, writePresence,
};
export type { Identity, SeatIndex, ModLease, JoinRequest, RoomClaudePatch, ForkParent };
