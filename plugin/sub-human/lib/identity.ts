/**
 * plugin/sub-human/lib/identity.ts: where rooms live, who is in them, and which Claude session is asking.
 * Identity is bound at join by a hook and never chosen by the model.
 * Participants are collaborators: there is no process-ancestry proof. A seat is found by a direct lookup of
 * the session id (hooks) or of a registered claude pid (MCP server, CLI). Every seat stores its process start
 * time (pid_start, epoch s, lib/lock.ts pidStart), so a reused pid never keeps a dead seat alive or adopts it.
 * Every seat also stores its machine (machineId), so a pid is only ever checked on the machine it belongs to.
 *
 * Rooms. openRooms() judges only the rooms the open-rooms index names (lib/room/store.ts indexedRooms: kept at
 * open, join and close), with one ps call for every live local pid (lib/lock.ts pidStarts). A room is open with
 * >= 1 live member seat and not closing; one where only the room's Claude is left is not (orphanRooms: join sweeps
 * those through roomClaude.watchdog). A room closed for good (every person's seat left, one whose session crashed
 * has not; its room Claude stopped, or never asked for) leaves the index, only a join reopens it, and it is the only
 * kind lib/gc.ts sets aside. roomOpen counts the room's Claude too (a resume may rejoin a room whose room Claude
 * is waiting out the reap grace). isHost: the room Claude's spawn, reap and watchdog and proposal decisions run
 * only on the machine that holds the room.
 *
 * Members (lib/room/store.ts members; seats change only through its ops join, leave and beat, whose rules are
 * lib/room/members.ts, and the room's Claude record through members.update, atomic). pid, pid_start, session_id
 * and cwd are kept only for a seat of the machine that holds the room. The "claude" record also carries job,
 * spawned_at, closing, stopped_at, claim, by (lib/room-claude.ts); before the spawned room Claude binds its pid is
 * null, and while a spawn is in flight job is "pending".
 *   join: reserved names (RESERVED: the room's own names and every /sub-human verb) are refused, except that role
 *   claude must use "claude". A name held by a live seat of another holder (another pid or machine) is "name taken";
 *   otherwise it is (re)bound, the room Claude record keeping its job and spawned_at. A seat of this machine needs
 *   its pid; afterwards one seat per claude pid (its previous seat is left) and the indexes
 *   <home>/sessions/by-pid/<pid>.json and by-sid/<sid>.json are written. A seat of another machine has neither.
 *   leave drops the by-pid index but keeps the by-sid one, so lastSeat() finds the seat on --resume.
 *   rebindSession (after /clear) on a mirror changes only the indexes: the host never holds a seat's session.
 *
 * Resolution returns {code, name, role, session_id, pid, address}, address = "NAME.CODE", the session title other
 * Claudes reach it by with SendMessage. In a room this machine mirrors (lib/room/store-mirror.ts), whose members
 * document holds no pid, start time or session, a seat of this machine is judged by its index record's.
 * resolveSelf (the CLI and the tail) tries CLAUDE_CODE_SESSION_ID (set by Claude Code for Bash, hooks and the
 * status line; the mod sets it for its tail child), then CLAUDE_PID, then the nearest ancestor with a registration.
 * forkParent and forkedAway follow a conversation that ← (the agent view) moved into a bg job under a new id
 * (lib/cc/transcript.ts continuedIn, lastHome, lastTitle; CONTRACT session-fork-continued-in,
 * transcript-home-notice, transcript-custom-title); adoptFork moves the seat with no leave and no log line, since
 * the person never left.
 *
 * The hooks module's lease, <home>/sessions/mods/<sid>.json (atomic, 0600): this session's function hooks are
 * loaded and have said hello (hooks/handlers/mod-hello.ts writes it, join requires it, session-end deletes it).
 * {session_id, pid, pid_start?, at, nonce?, cc_version?}: nonce is the module's secret for the session (32 hex), which
 * hooks/handlers/at-room.ts requires beside an origin; cc_version the Claude Code the session runs on, as the module
 * read it ($.session.version), so a node hook finds its verdict (lib/cc/verdict.ts). Keep it one small flat object.
 *
 * Presence (presence/<name> = {state, at, detail?}, written by members.beat): working | idle | permission |
 * error (StopFailure; detail = code).
 *
 * The session indexes (<home>/sessions/, which seat a local pid or session id holds) are this machine's, not the
 * room's, and stay here; room state goes through lib/room/store.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readJson, writeJsonAtomic, isAlive, validPid } from './io.ts';
import { obj, str, num, opt, nullable, refine, unknown_ } from './decode.ts';
import { home, roomDir, machineId, machineIn, isMine } from './home.ts';
import { pidStart, pidStarts } from './lock.ts';
import { NAME_RE, CODE_RE, isRoomCode, isSeatName, isSessionId } from './text.ts';
import { sidIndex } from '../mod/core/seat.ts';
import { isCcVersion } from '../mod/core/cc.ts';
import { SEAT_BEAT_MS, MOD_LEASE_FRESH_MS, SESSION_INDEX_TTL_MS } from './config.ts';
import {
  seatAlive, leaseFresh, startMatches, PRESENCE_STATES, isPresenceState, ROOM_CLAUDE,
} from './room/members.ts';
import * as cc from './cc/env.ts';
import { continuedIn, lastTitle, lastHome } from './cc/transcript.ts';
import type { JoinOutcome, Member, Members, MembersApi, PresenceInput, Role, SeatRecord } from './room/types.ts';

/** A resolved seat (resolveBySession, resolveByPid, resolveSelf): address = NAME.CODE, the session title. */
interface Identity {
  code: RoomCode;
  name: SeatName;
  role: Role;
  session_id: string | null;
  pid: number | null | undefined;
  address: string;
}

/** A session index record, <home>/sessions/by-pid/<pid>.json and by-sid/<sid>.json: which seat a local pid or session holds. */
interface SeatIndex {
  code: RoomCode;
  name: SeatName;
  /** a Role as written; read as any string (lastSeat and forkParent read anything but "claude" as a member) */
  role?: string | undefined;
  pid?: number | null | undefined;
  pid_start?: number | undefined;
  session_id?: SessionId | null | undefined;
  address?: string | undefined;
}
/** A session index record as read (indexRec): code and name are what every reader needs. */
const SEAT_INDEX = obj({
  code: refine(str, isRoomCode, 'a room code'), name: refine(str, isSeatName, 'a seat name'), role: opt(str), pid: opt(nullable(num)), pid_start: opt(num),
  session_id: opt(nullable(refine(str, isSessionId, 'a session id'))), address: opt(str),
});

/** The hooks module's lease, <home>/sessions/mods/<sid>.json (see the header). */
interface ModLease {
  session_id: SessionId;
  pid?: number | null | undefined;
  pid_start?: number | undefined;
  at?: string | undefined;
  nonce?: string | undefined;
  cc_version?: string | undefined;
}
/** A lease as read (writeModLease). */
const MOD_LEASE = obj({ session_id: refine(str, isSessionId, 'a session id'), pid: opt(nullable(num)), pid_start: opt(num), at: opt(str), nonce: opt(str), cc_version: opt(str) });

/** join()'s argument. */
interface JoinRequest {
  code: RoomCode;
  name: SeatName;
  role: string;
  machine?: MachineId | null | undefined;
  /** the person behind the seat (lib/seats.ts enter); kept on the record, never sent by a mirror */
  account?: string | undefined;
  pid?: number | string | null | undefined;
  session_id?: string | null | undefined;
  cwd?: string | null | undefined;
  /** leave the seat this pid held before to the caller (lib/seats.ts take: it leaves it, logged, once this join
   * worked, so a refused join changes nothing) instead of retiring it here */
  keepPrevious?: boolean | undefined;
}

/** The room's Claude's record as updateRoomClaude patches it: undefined deletes a field. */
type RoomClaudePatch = { [K in keyof Member]?: Member[K] | undefined };
// MOD_LEASE_FRESH_MS only covers a module whose $.process parent is not claude itself: a resumed session id whose
// lease is older than this, from a process that is gone, cannot join.
// the room's own names, then every /sub-human verb, so `/sub-human doctor` is never a person called doctor (handoff,
// promote and demote were verbs until 0.5: still reserved, so an old line fails clearly)
const VERBS: readonly string[] = ['invite', 'join', 'kick', 'leave', 'doctor', 'help', 'admit', 'handoff', 'promote', 'demote'];
const RESERVED: readonly string[] = [ROOM_CLAUDE, 'room', 'all', 'system', 'host', ...VERBS];
const ROLES: readonly string[] = [ROOM_CLAUDE, 'member'];
const ANIMALS: readonly string[] = [
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
/** A name from a person's own: the first word, lowercased, accents dropped; null when nothing is left or it is reserved. */
function normalizeName(text: unknown): SeatName | null {
  const first = String(text || '').trim().split(/\s+/)[0] || '';
  const n = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').replace(/^[._-]+/, '').slice(0, 32);
  return n && isSeatName(n) && !RESERVED.includes(n) ? n : null;
}

/** git's user.name (cwd's repo, else global), else user.email's local part, else $USER ("Tristan Timblin" -> "tristan"). */
function defaultName({ cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): SeatName | null {
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
import type { RoomCode, SeatName, SessionId, MachineId } from './brand.ts';
const roomExists = (code: unknown): code is RoomCode => store.roomExists(code);
const byPidDir = (): string => path.join(home(), 'sessions', 'by-pid');
const byPidFile = (pid: unknown): string => path.join(byPidDir(), `${Number(pid)}.json`);
// the path is mod/core/seat.ts sidIndex's: the hooks module checks it for a seat without node
const bySidFile = (sid: SessionId): string => sidIndex(path.resolve(home()), sid) || path.join(home(), 'sessions', 'by-sid', `${sid}.json`);
const modLeaseFile = (sid: SessionId): string => path.join(home(), 'sessions', 'mods', `${sid}.json`);
const address = (name: string, code: RoomCode): string => `${name}.${code}`;
/** The room's members document (lib/room/store.ts members: read(), the ops join/leave/beat, update(fn) atomic). */
const membersOf = (code: RoomCode): MembersApi => store.open(code).members;
const isHost = (code: RoomCode): boolean => store.open(code).isHost;

function newCode(): RoomCode {
  for (let i = 0; i < 200; i++) {
    const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const code = `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    if (isRoomCode(code) && store.createRoom(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

const rm = (file: string): void => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

// ---------- members ----------
function readMembers(code: RoomCode): Members {
  try { return membersOf(code).read(); } catch { return {}; }
}

const fail = (error: string): JoinOutcome => ({ ok: false, error });

/**
 * Renew me's lease (members seen_at), at most every SEAT_BEAT_MS: the tail's health tick and the hold server
 * call it. Only for the seat as me holds it (same pid when me has one; not left). Returns true when written.
 */
function heartbeat(me: { code?: RoomCode; name?: string; pid?: number | null | undefined } | null | undefined, now: number = Date.now()): boolean {
  if (!me || !me.code || !me.name || !roomExists(me.code)) return false;
  const m: Member | undefined = readMembers(me.code)[me.name]; // the cheap check, before the op (a mirror's document holds no pid)
  const stale = !!m && !m.left_at && (!validPid(me.pid) || m.pid == null || m.pid === me.pid) && !(Date.parse(String(m.seen_at)) > now - SEAT_BEAT_MS);
  return stale && membersOf(me.code).beat(me.name, { now });
}

/** The session index record of seat m: which seat a local pid or session id holds. */
const indexRec = (code: RoomCode, m: Member | SeatRecord): SeatIndex => ({ code, name: m.name, role: m.role, pid: m.pid, ...(m.pid_start != null ? { pid_start: m.pid_start } : {}), session_id: m.session_id || null, address: address(m.name, code) });
function writeIndexes(code: RoomCode, m: Member | SeatRecord): void {
  const rec = indexRec(code, m);
  writeJsonAtomic(byPidFile(m.pid), rec);
  if (m.session_id) writeJsonAtomic(bySidFile(m.session_id), rec);
}

/** One seat per claude process: the seat pid held before this join (another name or room) is left. */
function retirePrevious(code: RoomCode, name: SeatName, pid: number): void {
  const prev = readJson(byPidFile(pid), SEAT_INDEX, null);
  if (!prev || (prev.code === code && prev.name === name)) return;
  try {
    const m = indexedSeat(prev);
    if (m && m.pid === pid && !m.left_at) membersOf(prev.code).leave(prev.name, { reason: 'joined another room' });
  } catch { /* old room gone */ }
}

/** The record members.join stores for a seat of this machine: its pid, start time, session and cwd too. */
function localSeat({ name, role, machine, pid, session_id, cwd }: { name: SeatName; role: Role; machine: MachineId | null; pid: number; session_id?: SessionId | null | undefined; cwd?: string | null | undefined }): SeatRecord {
  const start = pidStart(pid);
  return { name, role, machine, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, cwd: cwd || null };
}

function join({ code, name, role, machine = machineIn(code), account, pid: pidArg, session_id, cwd, keepPrevious = false }: JoinRequest = {} as JoinRequest): JoinOutcome {
  if (!roomExists(code)) return fail(`no room "${code}"`);
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (!ROLES.includes(role)) return fail(`invalid role "${role}"`);
  if (RESERVED.includes(name.toLowerCase()) && !(name === ROOM_CLAUDE && role === ROOM_CLAUDE)) return fail(`"${name}" is reserved`);
  if (role === ROOM_CLAUDE && name !== ROOM_CLAUDE) return fail(`the room's Claude joins as "${ROOM_CLAUDE}"`);
  const local = isMine(machine);
  const pid = Number(pidArg);
  if (local && !validPid(pid)) return fail(`invalid pid "${pid}"`);
  if (session_id != null && !isSessionId(session_id)) return fail('invalid session_id');

  const seatRole = role as Role; // one of ROLES
  const rec: SeatRecord = { ...(local ? localSeat({ name, role: seatRole, machine, pid, session_id, cwd }) : { name, role: seatRole, machine }), ...(account ? { account } : {}) };
  const r = membersOf(code).join(rec);
  if (r.ok) store.indexRoom(code); // it may be open from here on (lib/room/registry.ts)
  if (r.ok && local) {
    if (!keepPrevious) retirePrevious(code, name, pid);
    writeIndexes(code, rec);
  }
  return r;
}

function leave(code: RoomCode, name: SeatName, opts?: { reason?: string; deadlineMs?: number | undefined }): boolean {
  if (!roomExists(code)) return false;
  if (!membersOf(code).leave(name, opts)) return false;
  primeStarts(Object.values(readMembers(code))); // one ps for the liveness checks below and the caller's (seats.exit)
  try { unindexClosed(code); } catch { /* the next look at the open rooms drops it */ }
  const m = readMembers(code)[name];
  if (m && m.left_at && validPid(m.pid)) {
    const p = readJson(byPidFile(m.pid), SEAT_INDEX, null);
    if (p && p.code === code && p.name === name) rm(byPidFile(m.pid));
  }
  return true;
}

function rebindSession(pid: unknown, sid: unknown): boolean {
  if (!isSessionId(sid)) return false;
  const who = resolveByPid(pid);
  if (!who) return false;
  const swap = (m: Member): void => {
    if (m.session_id && m.session_id !== sid) rm(bySidFile(m.session_id));
    m.session_id = sid;
    writeIndexes(who.code, m);
  };
  if (!isHost(who.code)) { // resolveByPid found this seat (unless it went meanwhile)
    const idx = readJson(byPidFile(pid), SEAT_INDEX, null);
    const m = idx && indexedSeat(idx);
    if (!m) return false;
    swap(m);
    return true;
  }
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
const seat = (code: RoomCode, m: Member): Identity => ({ code, name: m.name, role: m.role, session_id: m.session_id || null, pid: m.pid, address: address(m.name, code) });

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
  const rec = readJson(byPidFile(pid), SEAT_INDEX, null);
  if (!rec || !roomExists(rec.code)) return null;
  const m = indexedSeat(rec);
  if (!m || m.left_at || m.pid !== pid || !startMatches(m)) return null;
  return seat(rec.code, m);
}

function resolveBySession(sid: unknown): Identity | null {
  if (!isSessionId(sid)) return null;
  const rec = readJson(bySidFile(sid), SEAT_INDEX, null);
  if (!rec || !roomExists(rec.code)) return null;
  const m = indexedSeat(rec);
  if (!m || m.left_at || m.session_id !== sid) return null;
  return seat(rec.code, m);
}

const NONCE_RE = /^[0-9a-f]{32}$/;

function writeModLease(sid: unknown, { pid: pidArg, nonce, ccVersion }: { pid?: unknown; nonce?: unknown; ccVersion?: unknown } = {}): boolean {
  if (!isSessionId(sid)) return false;
  const pid = Number(pidArg);
  const rec: ModLease = { session_id: sid, pid: validPid(pid) ? pid : null };
  const start = rec.pid ? pidStart(pid) : null;
  if (start != null) rec.pid_start = start;
  rec.at = new Date().toISOString();
  if (typeof nonce === 'string' && NONCE_RE.test(nonce)) rec.nonce = nonce;
  if (isCcVersion(ccVersion)) rec.cc_version = ccVersion;
  writeJsonAtomic(modLeaseFile(sid), rec);
  return true;
}

function readModLease(sid: unknown): ModLease | null {
  if (!isSessionId(sid)) return null;
  return readJson(modLeaseFile(sid), MOD_LEASE, null);
}

const leaseYoung = (lease: ModLease | null, now: number): boolean => { const t = Date.parse(String(lease && lease.at)); return Number.isFinite(t) && now - t < MOD_LEASE_FRESH_MS; };
/** The lease's own process is still the one that wrote it (startMatches tolerates an unreadable start). */
const leaseLive = (lease: ModLease | null): boolean => !!lease && validPid(lease.pid) && isAlive(lease.pid) && startMatches(lease);

/**
 * The session's lease lets a join through: written by the module running in this claude process (pid, with
 * its start time, so a reused pid does not count), or recently. Any other lease is a leftover: a session id
 * resumed in a process whose module never said hello (--bare, hooks off) must not inherit the old one.
 */
function modLeaseOk(sid: unknown, pid: unknown, now: number = Date.now()): boolean {
  const lease = readModLease(sid);
  if (!lease || lease.session_id !== sid) return false;
  // a young lease lets it through on its own: asked first, it spares the ps a live check costs (a loaded machine)
  if (leaseYoung(lease, now)) return true;
  return validPid(Number(pid)) && lease.pid === Number(pid) && leaseLive(lease);
}

function deleteModLease(sid: unknown): boolean {
  if (!isSessionId(sid)) return false;
  rm(modLeaseFile(sid));
  return true;
}

/** Index records older than ttlMs whose pid is not alive with its start time, and EnterPlanMode mode notes over a minute old. */
function pruneSessionIndexes(now: number = Date.now(), ttlMs: number = SESSION_INDEX_TTL_MS): number {
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
      const rec = readJson(file, SEAT_INDEX, null);
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

/** Delete leases whose process is gone; a lease with no pid (or unreadable) once it is past the fresh window. */
function pruneModLeases(now: number = Date.now()): number {
  const dir = path.join(home(), 'sessions', 'mods');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    const lease = readJson(file, MOD_LEASE, null);
    let gone: boolean;
    if (lease && validPid(lease.pid)) gone = !leaseLive(lease);
    else if (lease) gone = !leaseYoung(lease, now);
    else { try { gone = now - fs.statSync(file).mtimeMs >= MOD_LEASE_FRESH_MS; } catch { gone = false; } }
    if (gone) { rm(file); n++; }
  }
  return n;
}

/** This machine's session indexes (by-pid, by-sid) that name room code, removed: `link CODE --forget` ends every
 * local seat there, so a hold server, tail or hook still running for it resolves no seat and writes nothing. */
function dropSeatIndexes(code: RoomCode): number {
  let n = 0;
  for (const dir of [byPidDir(), path.join(home(), 'sessions', 'by-sid')]) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const rec = readJson(path.join(dir, f), SEAT_INDEX, null);
      if (rec && rec.code === code) { rm(path.join(dir, f)); n++; }
    }
  }
  return n;
}

function localSeats(code: RoomCode): string[] {
  let files: string[];
  try { files = fs.readdirSync(byPidDir()); } catch { return []; }
  const names = new Set<string>();
  for (const f of files) {
    const rec = readJson(path.join(byPidDir(), f), SEAT_INDEX, null);
    if (!rec || rec.code !== code || !isAlive(rec.pid)) continue;
    const who = resolveByPid(rec.pid);
    if (who && who.code === code) names.add(who.name);
  }
  return [...names];
}

function lastSeat(sid: unknown): { code: RoomCode; name: SeatName; role: Role; address: string } | null {
  if (!isSessionId(sid)) return null;
  const rec = readJson(bySidFile(sid), SEAT_INDEX, null);
  if (!rec || !roomExists(rec.code)) return null; // SEAT_INDEX checked the name
  const name = rec.name;
  const role: Role = rec.role === ROOM_CLAUDE ? ROOM_CLAUDE : 'member';
  return { code: rec.code, name, role, address: address(name, rec.code) };
}

type ForkParent = { sid: SessionId; code: RoomCode; name: SeatName; role: Role };

function forkParent(sid: unknown, dir: string | null | undefined): ForkParent | null {
  if (!isSessionId(sid) || typeof dir !== 'string' || !dir) return null;
  let names: string[];
  try { names = fs.readdirSync(path.dirname(bySidFile(sid))); } catch { return null; }
  for (const f of names) {
    const old = f.replace(/\.json$/, '');
    if (old === sid || !isSessionId(old)) continue;
    const transcript = path.join(dir, `${old}.jsonl`);
    if (!fs.existsSync(transcript)) continue; // not a session of this directory
    const rec = readJson(bySidFile(old), SEAT_INDEX, null);
    if (!rec || !roomExists(rec.code)) continue; // SEAT_INDEX checked the name
    const m = indexedSeat(rec);
    if (!m || m.left_at || m.session_id !== old) continue;
    if (continuedIn(transcript) !== sid) continue;
    return { sid: old, code: rec.code, name: rec.name, role: rec.role === ROOM_CLAUDE ? ROOM_CLAUDE : 'member' };
  }
  return null;
}

/** A fork that forkParent could not place: a session of this directory that holds a live seat, whose transcript changed
 * within FORK_SCAN_MS and gives no continued-in record (unreadable, or a shape these readers do not know). Its seat's
 * address, or null. The seat stays where it is (never taken on a guess); session-restore tells the person how to get
 * it back. */
function forkUnread(sid: unknown, dir: string | null | undefined, now: number = Date.now()): string | null {
  if (!isSessionId(sid) || typeof dir !== 'string' || !dir) return null;
  let names: string[];
  try { names = fs.readdirSync(path.dirname(bySidFile(sid))); } catch { return null; }
  for (const f of names) {
    const old = f.replace(/\.json$/, '');
    if (old === sid || !isSessionId(old)) continue;
    const transcript = path.join(dir, `${old}.jsonl`);
    try { if (now - fs.statSync(transcript).mtimeMs > FORK_SCAN_MS) continue; } catch { continue; } // not a session of this directory
    const rec = readJson(bySidFile(old), SEAT_INDEX, null);
    if (!rec || !roomExists(rec.code)) continue;
    const m = indexedSeat(rec);
    if (!m || m.left_at || m.session_id !== old) continue;
    if (continuedIn(transcript) !== null) continue; // a record naming another session: another fork's
    return address(rec.name, rec.code);
  }
  return null;
}

/** How recently a transcript must have changed to be the one an agent-view fork continued (its continued-in record is
 * written just after the fork starts): only those are read, however many sessions the folder keeps. */
const FORK_SCAN_MS = 10 * 60_000;
/** title is a seat's address NAME.CODE (the session title a seat sets). */
const isAddress = (title: string): boolean => { const i = title.lastIndexOf('.'); return i > 0 && NAME_RE.test(title.slice(0, i)) && CODE_RE.test(title.slice(i + 1)); };

/** A fork's parent seated in another sub-human folder (its SUB_HUMAN_HOME was only in the shell, which the bg job
 * drops): a transcript beside this one's that continued in sid and names another folder as its seat's (the hooks
 * module's notice), held or not (a leave renames the session, so its title says nothing then); with no notice, a
 * title that was a seat's address NAME.CODE. */
type ForkedAway = { sid: string; title: string; home?: string };
const realish = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
function forkedAway(sid: unknown, dir: string | null | undefined, now: number = Date.now()): ForkedAway | null {
  if (!isSessionId(sid) || typeof dir !== 'string' || !dir) return null;
  let names: string[];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of names) {
    const old = f.slice(0, -'.jsonl'.length);
    if (old === sid || !isSessionId(old)) continue;
    const file = path.join(dir, f);
    try { if (now - fs.statSync(file).mtimeMs > FORK_SCAN_MS) continue; } catch { continue; }
    if (continuedIn(file) !== sid) continue;
    const title = lastTitle(file) || '';
    const was = lastHome(file);
    if (was) return realish(was) !== realish(home()) ? { sid: old, title, home: was } : null;
    // no mark on a seat's transcript: the module marks only a folder other than the default (mod/deliver.ts markHome),
    // so a fork in the default folder is in the same one; elsewhere, which folder it was is not known
    if (!isAddress(title) || realish(home()) === realish(path.join(os.homedir(), '.sub-human'))) return null;
    return { sid: old, title };
  }
  return null;
}
/** A fork record as read (markForked); home is kept only when a string. */
const FORKED = obj({ sid: str, title: str, home: opt(unknown_) });
const forkedFile = (sid: SessionId): string => path.join(home(), 'sessions', 'forked', `${sid}.json`);
/** Record that session sid is such a fork (session-restore), so a bare /sub-human there opens no room (lib/seats.ts). */
function markForked(sid: string, f: ForkedAway): void {
  if (!isSessionId(sid)) return;
  writeJsonAtomic(forkedFile(sid), { ...f, at: new Date().toISOString() });
}
/** The fork record of session sid (markForked), or null. */
function forkedOf(sid: unknown): ForkedAway | null {
  if (!isSessionId(sid)) return null;
  const r = readJson(forkedFile(sid), FORKED, null);
  return r && { sid: r.sid, title: r.title, ...(typeof r.home === 'string' ? { home: r.home } : {}) };
}

function adoptFork(from: ForkParent, { pid: pidArg, session_id, cwd }: { pid: unknown; session_id: string; cwd?: string | null | undefined }
): JoinOutcome {
  const pid = Number(pidArg);
  if (!validPid(pid)) return fail(`invalid pid "${pid}"`);
  const before = readJson(bySidFile(from.sid), SEAT_INDEX, null);
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
      const p = readJson(byPidFile(oldPid), SEAT_INDEX, null);
      if (p && p.code === from.code && p.name === from.name) rm(byPidFile(oldPid));
    }
  }
  return r;
}

const claudePid = (): number | null => cc.claudePid();

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
    table ??= parentTable();
    const pp = pid === process.pid ? process.ppid : table.get(pid);
    if (!pp) break;
    pid = pp;
  }
  return null;
}

// ---------- rooms ----------
const isMember = (m: Member | null | undefined): m is Member => !!m && m.role !== 'claude';
/** The names of code's live people, the start times of their local pids read by one ps call (not one per seat). */
function liveMembers(code: RoomCode): string[] {
  const ms = Object.values(readMembers(code)).filter(m => isMember(m) && !m.left_at);
  primeStarts(ms);
  return ms.filter(m => seatAlive(m)).map(m => m.name);
}
/** The start times of these seats' live local pids, read into lib/lock.ts's cache by one ps call. */
function primeStarts(ms: readonly (Member | null | undefined)[]): void {
  try { pidStarts(ms.filter((m): m is Member => !!m && !m.left_at && validPid(m.pid) && (!m.machine || isMine(m.machine)) && isAlive(m.pid)).map(m => m.pid as number)); } catch { /* each check asks on its own */ }
}
const roomClosing = (code: RoomCode): boolean => { const o = readMembers(code).claude; return !!(o && o.closing); };

/** Closed for good: no person's seat that has not left, and no room Claude that may still run. Only a join reopens it. */
const closedForGood = (ms: Members): boolean => !Object.values(ms).some(m => !!m && (isMember(m) ? !m.left_at : roomClaudeActive(m)));

/**
 * The indexed rooms' members documents, with the start times of their live local pids read by one ps call. A room
 * closed for good, or whose directory and link are gone, leaves the index.
 */
function allMembers(): { code: RoomCode; ms: Members }[] {
  const all = store.indexedRooms().filter(roomExists).map(code => ({ code, ms: readMembers(code) }));
  const gone = store.indexedRooms().filter((c): boolean => !roomExists(c)).concat(all.filter(r => closedForGood(r.ms)).map(r => r.code));
  if (gone.length) { try { store.unindexRooms(gone); } catch { /* the next look drops them */ } }
  const open = all.filter(r => !closedForGood(r.ms));
  pidStarts(open.flatMap(({ ms }) => Object.values(ms)).filter(m => m && !m.left_at && validPid(m.pid) && (!m.machine || isMine(m.machine)) && isAlive(m.pid)).map(m => m.pid as number));
  return open;
}

/** code off the open-rooms index once it is closed for good (the reaper, a leave), not only at the next look. */
function unindexClosed(code: RoomCode): void {
  if (roomExists(code) && closedForGood(readMembers(code))) store.unindexRooms([code]);
}

function openRooms(): RoomCode[] {
  const open: { code: RoomCode; at: string }[] = [];
  for (const { code, ms } of allMembers()) {
    if (ms.claude && ms.claude.closing) continue;
    const live = Object.values(ms).filter(m => isMember(m) && seatAlive(m));
    const at = live.map(m => m.joined_at || '').sort().at(-1);
    if (at !== undefined) open.push({ code, at }); // live is not empty
  }
  return open.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(r => r.code);
}

/** The room's Claude record still owns a job or a live seat (not stopped, not left), or never started (a spawn that
 * failed outright: no job, spawn_error): the reaper still has a room to close (its room task, the open-rooms index),
 * so orphanRooms sweeps it once its members are gone. */
const roomClaudeActive = (o: Member | null | undefined): boolean => !!o && !o.stopped_at
  && (seatAlive(o) || (!o.left_at && (!!o.job || !!o.spawn_error)));

function orphanRooms(): RoomCode[] {
  const out: RoomCode[] = [];
  for (const { code, ms } of allMembers()) {
    const o = ms.claude;
    if (!o || o.closing || !roomClaudeActive(o)) continue;
    if (!Object.values(ms).some(m => isMember(m) && seatAlive(m))) out.push(code);
  }
  return out;
}

function roomOpen(code: RoomCode): boolean {
  if (!roomExists(code)) return false;
  const ms = readMembers(code);
  if (ms.claude && ms.claude.closing) return false;
  return Object.values(ms).some(seatAlive);
}

function updateRoomClaude(code: RoomCode, fn: (current: Member | null, members: Members) => RoomClaudePatch | null | undefined): Member | null {
  if (!roomExists(code)) throw new Error(`no room "${code}"`);
  let rec: Member | null = null;
  membersOf(code).update(members => {
    rec = null;
    const patch = fn(members.claude ?? null, members);
    if (!patch) return null;
    const next = { name: ROOM_CLAUDE, role: ROOM_CLAUDE, pid: null, ...(members.claude ?? {}) as Partial<Member>, ...patch } as Member; // a patch keeps name and role
    for (const k of Object.keys(next) as (keyof Member)[]) if (next[k] === undefined) delete next[k];
    members.claude = rec = next;
    return members;
  });
  return rec;
}


// ---------- presence ----------
function writePresence(code: RoomCode, name: SeatName, { state, detail }: PresenceInput): boolean {
  if (!NAME_RE.test(String(name)) || !isPresenceState(state)) return false;
  try { return membersOf(code).beat(name, { presence: { state, detail } }); } catch { return false; }
}

export {
  NAME_RE, CODE_RE, isRoomCode, isSeatName, isSessionId, RESERVED, VERBS, ROOM_CLAUDE, ANIMALS, PRESENCE_STATES, normalizeName, defaultName, home,
  roomDir, machineId, machineIn, isMine, newCode, roomExists, isHost, openRooms, unindexClosed, closedForGood, orphanRooms, roomOpen, roomClosing, address,
  readMembers, join, leave, rebindSession, updateRoomClaude, liveMembers, seatAlive, heartbeat,
  leaseFresh, isAlive, claudePid, resolveByPid, resolveBySession, resolveSelf, lastSeat, forkParent, forkUnread, forkedAway, markForked, forkedOf, adoptFork, localSeats, dropSeatIndexes,
  MOD_LEASE_FRESH_MS, writeModLease, readModLease, modLeaseOk, deleteModLease, pruneModLeases, pruneSessionIndexes, writePresence,
};
export type { Identity, SeatIndex, ModLease, JoinRequest, RoomClaudePatch, ForkParent, ForkedAway };
