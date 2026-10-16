/**
 * plugin/sub-human/lib/room/members.ts: the members document's rules, shared by every RoomStore (as placeAfter is
 * for the log), so a seat is judged the same whichever machine holds the room. Zero dependencies beyond lib/.
 *
 * A seat record: {name, role, machine, joined_at, seen_at, left_at?, lapsed_at?}, plus the fields only the seat's own machine
 * can use (LOCAL_FIELDS: pid, pid_start, session_id, cwd). The room's Claude record also keeps its bookkeeping
 * (lib/room-claude.ts) across a (re)bind. A record with no machine is from before machine ids: this machine's.
 *
 *   seatAlive(m) -> bool          not left, and: a seat of this machine with a pid: that pid is alive with its start
 *                                 time matching pid_start (a seat with no pid_start, or a pid whose start ps cannot
 *                                 read, counts as matching); any other seat (another machine's, or no pid): its lease
 *                                 (a lapsed seat, lapsed_at: lib/seats.ts sweep, is past its lease; a beat renews it)
 *   roomClaudePresence(o, now?) -> 'live' | 'starting' | null   the room's Claude record as people are told about it: never listed
 *                                 as present when it never ran or its start failed
 *   leaseFresh(m, now?) -> bool   seen_at younger than SEAT_LEASE_MS
 *   startMatches(m) -> bool       m.pid_start still describes the process now holding m.pid (on this machine)
 *   ops(store) -> {join, leave, beat}   the store's named ops over its members.update (atomic) and kv:
 *     join(rec) -> {ok, rejoin?, error?}   rec = {name, role, machine, ...LOCAL_FIELDS}. A name held by a live seat
 *                                 of another holder (another machine, or another pid) is "name taken"; otherwise
 *                                 the seat is (re)bound: rec, joined_at = seen_at = now, the room Claude's bookkeeping kept.
 *                                 owner: the first person's seat on the host (account = machine) in a room with no
 *                                 other person's seat yet, the one who opened it; kept across that seat's rebind on
 *                                 the host (lib/proposal.ts sameOf: a login link's seats are that person's)
 *     leave(name) -> bool         sets left_at and deletes presence/<name> (a mirror gets the deletion); false when
 *                                 there is no such seat or it left already
 *     beat(name, {presence?, now?}) -> bool   renews seen_at (at most every SEAT_BEAT_MS) and, with presence
 *                                 {state, detail?}, writes the document presence/<name> = {state, at, detail?}
 *                                 (RoomError INVALID for another state). false, writing nothing, for a seat that is
 *                                 absent or left. now: tests only (the host's clock otherwise).
 *   publicView(members) -> members   the document as other machines see it: LOCAL_FIELDS stripped
 *   ROOM_CLAUDE ("claude"), PRESENCE_STATES (the source of PresenceState) and isPresenceState, LOCAL_FIELDS
 *   LOG_V (2)                     what a seat's code reads: 2, the log in segments with a snapshot (lib/room/log-io.ts).
 *                                 A seat records it at join (log_v; the room's Claude's record at spawn too); a seat
 *                                 without it runs an older plugin (0.5.0-beta.15 or before), which reads one log.jsonl
 *   readsSegments(m) -> bool      m.log_v >= LOG_V
 *   holdsRotation(m) -> bool      a seat of this machine that may still run and reads only one log.jsonl: while one
 *                                 does, the room's log does not rotate (fs-store.ts rotationOk)
 */

import { isAlive, validPid } from '../io.ts';
import { pidStart } from '../lock.ts';
import { machineId, isMine } from '../home.ts';
import {
  PRESENCE_DETAIL_MAX, PID_START_SLACK_S, SEAT_BEAT_MS, SEAT_LEASE_MS, ROOM_CLAUDE_BIND_MS, ROOM_CLAUDE_CLAIM_MS,
} from '../config.ts';
import { RoomError } from './validate.ts';
import { namedSeat } from '../../mod/core/seat.ts';
import type { JoinOutcome, KvApi, Member, Members, MembersApi, Presence, PresenceInput, PresenceState, SeatRecord } from './types.ts';
import type { RoomCode, SeatName } from '../brand.ts';

/** What ops() needs of its store: the members document's read and update, its kv, and the room code. */
interface OpsStore {
  code: RoomCode;
  members: Pick<MembersApi, 'read' | 'update'>;
  kv: Pick<KvApi, 'set' | 'delete'>;
}
/** What seatAlive and friends read of a record: a seat, the room's Claude's, or a session index's (lib/identity.ts). */
type SeatLike = Partial<Member>;

/** The presence states, the source of PresenceState (lib/room/types.ts). */
const PRESENCE_STATES = ['working', 'idle', 'permission', 'error'] as const;
const PRESENCE_SET: ReadonlySet<unknown> = new Set(PRESENCE_STATES);
const isPresenceState = (s: unknown): s is PresenceState => PRESENCE_SET.has(s);
/** The room's Claude: its member name, role and SendMessage name (claude.CODE). */
const ROOM_CLAUDE: 'claude' & SeatName = namedSeat('claude');
const LOCAL_FIELDS = ['pid', 'pid_start', 'session_id', 'cwd'] as const;
const ROOM_CLAUDE_FIELDS = ['job', 'spawned_at', 'closing', 'by', 'job_session', 'claim'] as const; // kept across the room Claude's (re)bind

const machineOf = (m: SeatLike): string | null => m.machine || machineId();

const LOG_V = 2;
const readsSegments = (m: SeatLike): boolean => typeof m.log_v === 'number' && m.log_v >= LOG_V;
/** A seat of this machine (a person's, or the room's Claude's while its job may run) whose code reads one log.jsonl. */
function holdsRotation(m: SeatLike | null | undefined): boolean {
  if (!m || readsSegments(m) || m.left_at || !isMine(machineOf(m) || '')) return false;
  if (m.role === ROOM_CLAUDE) return !m.stopped_at && (seatAlive(m) || !!m.job);
  return seatAlive(m);
}

/** The stored start time still describes the process now holding m.pid (tolerates legacy / unreadable). */
function startMatches(m: SeatLike): boolean {
  if (m.pid_start == null) return true;
  const s = pidStart(m.pid);
  return s == null || Math.abs(s - Number(m.pid_start)) <= PID_START_SLACK_S;
}
const leaseFresh = (m: SeatLike | null | undefined, now: number = Date.now()): boolean => { const t = Date.parse(String(m && m.seen_at)); return Number.isFinite(t) && now - t < SEAT_LEASE_MS; };
function seatAlive(m: SeatLike | null | undefined): boolean { // unary: callers pass it to filter/some
  if (!m || !m.name || m.left_at) return false;
  if (validPid(m.pid) && isMine(machineOf(m))) return isAlive(m.pid) && startMatches(m);
  return leaseFresh(m);
}

/** rec is the holder of cur: the same machine and the same pid (none, for a seat on another machine). */
const sameHolder = (cur: Member, rec: SeatRecord): boolean => machineOf(cur) === rec.machine && (cur.pid ?? null) === (rec.pid ?? null);

function joinFold(ms: Members, rec: SeatRecord, code: RoomCode, now: number): { next: Members | null; result: JoinOutcome } {
  const cur = ms[rec.name];
  if (cur && !sameHolder(cur, rec) && seatAlive(cur)) return { next: null, result: { ok: false, error: `name taken: "${rec.name}" is already in ${code}` } };
  const keep: Partial<Member> = {};
  if (rec.role === 'claude' && cur) for (const k of ROOM_CLAUDE_FIELDS) if (cur[k] != null) Object.assign(keep, { [k]: cur[k] });
  // the room's opener: its seat on the host, the first person's (a room from before this field has none)
  const onHost = rec.role !== 'claude' && !!rec.account && rec.machine === rec.account;
  if (onHost && (cur ? cur.owner && cur.account === rec.account : !Object.values(ms).some(m => m && m.role !== 'claude'))) keep.owner = true;
  const at = new Date(now).toISOString();
  ms[rec.name] = { ...rec, joined_at: at, seen_at: at, ...keep };
  return { next: ms, result: cur ? { ok: true, rejoin: true } : { ok: true } };
}

function presenceDoc({ state, detail }: Partial<PresenceInput> = {}, now: number): Presence {
  if (!isPresenceState(state)) throw new RoomError('INVALID', `invalid presence state "${state}"`);
  const v: Presence = { state, at: new Date(now).toISOString() };
  if (detail) v.detail = String(detail).slice(0, PRESENCE_DETAIL_MAX);
  return v;
}

const seated = (ms: Members, name: string): boolean => !!ms[name] && !ms[name].left_at;

function ops(s: OpsStore): Pick<MembersApi, 'join' | 'leave' | 'beat'> {
  return {
    join(rec) {
      let result!: JoinOutcome; // set by the fold: update runs fn at least once
      s.members.update(ms => { const r = joinFold(ms, rec, s.code, Date.now()); result = r.result; return r.next; });
      return result;
    },
    leave(name) {
      const left = s.members.update(ms => {
        if (!seated(ms, name)) return null;
        ms[name].left_at = new Date().toISOString();
        return ms;
      }) != null;
      // their last presence ("permission", "working") is not theirs any more: rows and mirrors drop it
      if (left) { try { s.kv.delete(`presence/${name}`); } catch { /* best effort: rows ignore a left seat's */ } }
      return left;
    },
    beat(name, { presence, now = Date.now() } = {}) {
      const doc = presence === undefined ? null : presenceDoc(presence, now);
      const stale = (ms: Members) => seated(ms, name) && !(Date.parse(String(ms[name].seen_at)) > now - SEAT_BEAT_MS);
      if (!seated(s.members.read(), name)) return false;
      s.members.update(ms => {
        if (!stale(ms)) return null;
        ms[name].seen_at = new Date(now).toISOString();
        return ms;
      });
      if (doc) s.kv.set(`presence/${name}`, doc);
      return true;
    },
  };
}

function publicView(members: Members | null | undefined): Members {
  const out: Members = {};
  for (const [name, m] of Object.entries(members || {})) {
    out[name] = { ...m };
    for (const k of LOCAL_FIELDS) delete out[name][k];
  }
  return out;
}

/**
 * The room's Claude as members see it: 'live' (bound: its pid on this machine alive, else it joined and its lease is fresh),
 * 'starting' (a spawn claim younger than ROOM_CLAUDE_CLAIM_MS, or a job not bound within ROOM_CLAUDE_BIND_MS), else null (never
 * ran, its start failed, stopped, left or closing). Same rules as lib/room-claude.ts needsSpawn, from any machine.
 */
function roomClaudePresence(o: SeatLike | null | undefined, now: number = Date.now()): 'live' | 'starting' | null {
  if (!o || o.left_at || o.stopped_at || o.closing) return null;
  if (validPid(o.pid) && isMine(machineOf(o))) return seatAlive(o) ? 'live' : null;
  if (o.joined_at && o.job !== 'pending' && !o.spawn_error && leaseFresh(o, now)) return 'live';
  const since = now - Date.parse(String(o.spawned_at || 0));
  if (o.job === 'pending') return since <= ROOM_CLAUDE_CLAIM_MS ? 'starting' : null;
  if (o.job) return since <= ROOM_CLAUDE_BIND_MS ? 'starting' : null;
  return null;
}

export {
  PRESENCE_STATES, isPresenceState, LOCAL_FIELDS, ROOM_CLAUDE, LOG_V, readsSegments, holdsRotation, seatAlive,
  roomClaudePresence, leaseFresh, startMatches, ops, publicView,
};
