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
 *   fromLegacy(members) -> members   0.4.x names read as new ones (every store's members.read runs it)
 *   ROOM_CLAUDE ("claude"), LEGACY_ROOM_CLAUDE ("orch", read only), roomClaudeName(name), PRESENCE_STATES, LOCAL_FIELDS
 */

import { isAlive } from '../io.ts';
import { pidStart } from '../lock.ts';
import { machineId } from '../home.ts';
import {
  PRESENCE_DETAIL_MAX, PID_START_SLACK_S, SEAT_BEAT_MS, SEAT_LEASE_MS, ROOM_CLAUDE_BIND_MS, ROOM_CLAUDE_CLAIM_MS, envMs,
} from '../config.ts';
import { RoomError } from './validate.ts';
import type { JoinResult, KvApi, Member, Members, MembersApi, Presence, PresenceInput, PresenceState, SeatRecord } from './types.ts';

/** What ops() needs of its store: the members document's read and update, its kv, and the room code. */
interface OpsStore {
  code: string;
  members: Pick<MembersApi, 'read' | 'update'>;
  kv: Pick<KvApi, 'set' | 'delete'>;
}
/** What seatAlive and friends read of a record: a seat, the room's Claude's, or a session index's (lib/identity.ts). */
type SeatLike = Partial<Member>;

const PRESENCE_STATES: readonly PresenceState[] = ['working', 'idle', 'permission', 'error'];
/** The room's Claude: its member name, role and SendMessage name (claude.CODE). */
const ROOM_CLAUDE = 'claude';
/** 0.4.x wrote the room's Claude as member and role "orch". Read only (fromLegacy, roomClaudeName); never written. */
const LEGACY_ROOM_CLAUDE = 'orch';
const roomClaudeName = <N,>(n: N): N | typeof ROOM_CLAUDE => (n === LEGACY_ROOM_CLAUDE ? ROOM_CLAUDE : n);

/**
 * A members document as read, with 0.4.x names mapped (in place): the "orch" record becomes "claude" (unless a
 * "claude" record exists) and role "orch" becomes "claude". The next write of the document has only new names.
 */
function fromLegacy<M extends Members | null | undefined>(ms: M): M {
  if (!ms || typeof ms !== 'object') return ms;
  const old: unknown = ms[LEGACY_ROOM_CLAUDE];
  if (old !== undefined) {
    delete ms[LEGACY_ROOM_CLAUDE];
    if (old && typeof old === 'object' && !ms[ROOM_CLAUDE]) ms[ROOM_CLAUDE] = { ...(old as Member), name: ROOM_CLAUDE };
  }
  for (const m of Object.values(ms)) if (m && typeof m === 'object' && (m.role as string) === LEGACY_ROOM_CLAUDE) m.role = ROOM_CLAUDE;
  return ms;
}
const LOCAL_FIELDS = ['pid', 'pid_start', 'session_id', 'cwd'] as const;
const ROOM_CLAUDE_FIELDS = ['job', 'spawned_at', 'closing', 'by', 'job_session', 'claim'] as const; // kept across the room Claude's (re)bind

const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0;
const machineOf = (m: SeatLike): string | null => m.machine || machineId();

/** The stored start time still describes the process now holding m.pid (tolerates legacy / unreadable). */
function startMatches(m: SeatLike): boolean {
  if (m.pid_start == null) return true;
  const s = pidStart(m.pid);
  return s == null || Math.abs(s - Number(m.pid_start)) <= PID_START_SLACK_S;
}
const leaseFresh = (m: SeatLike | null | undefined, now = Date.now()): boolean => { const t = Date.parse(String(m && m.seen_at)); return Number.isFinite(t) && now - t < SEAT_LEASE_MS; };
function seatAlive(m: SeatLike | null | undefined): boolean { // unary: callers pass it to filter/some
  if (!m || !m.name || m.left_at) return false;
  if (validPid(m.pid) && machineOf(m) === machineId()) return isAlive(m.pid) && startMatches(m);
  return leaseFresh(m);
}

/** rec is the holder of cur: the same machine and the same pid (none, for a seat on another machine). */
const sameHolder = (cur: Member, rec: SeatRecord): boolean => machineOf(cur) === rec.machine && (cur.pid ?? null) === (rec.pid ?? null);

function joinFold(ms: Members, rec: SeatRecord, code: string, now: number): { next: Members | null; result: JoinResult } {
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
  if (!PRESENCE_STATES.includes(state as PresenceState)) throw new RoomError('INVALID', `invalid presence state "${state}"`);
  const v: Presence = { state: state as PresenceState, at: new Date(now).toISOString() };
  if (detail) v.detail = String(detail).slice(0, PRESENCE_DETAIL_MAX);
  return v;
}

const seated = (ms: Members, name: string): boolean => !!ms[name] && !ms[name].left_at;

function ops(s: OpsStore): Pick<MembersApi, 'join' | 'leave' | 'beat'> {
  return {
    join(rec) {
      let result!: JoinResult; // set by the fold: update runs fn at least once
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
function roomClaudePresence(o: SeatLike | null | undefined, now = Date.now()): 'live' | 'starting' | null {
  if (!o || o.left_at || o.stopped_at || o.closing) return null;
  if (validPid(o.pid) && machineOf(o) === machineId()) return seatAlive(o) ? 'live' : null;
  if (o.joined_at && o.job !== 'pending' && !o.spawn_error && leaseFresh(o, now)) return 'live';
  const since = now - Date.parse(String(o.spawned_at || 0));
  if (o.job === 'pending') return since <= envMs('SUB_HUMAN_ROOM_CLAUDE_CLAIM_MS', ROOM_CLAUDE_CLAIM_MS) ? 'starting' : null;
  if (o.job) return since <= ROOM_CLAUDE_BIND_MS ? 'starting' : null;
  return null;
}

export {
  PRESENCE_STATES, LOCAL_FIELDS, ROOM_CLAUDE, LEGACY_ROOM_CLAUDE, roomClaudeName, fromLegacy, seatAlive,
  roomClaudePresence, leaseFresh, startMatches, ops, publicView,
};
