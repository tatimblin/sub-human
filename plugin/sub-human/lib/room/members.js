'use strict';
/**
 * plugin/sub-human/lib/room/members.js: the members document's rules, shared by every RoomStore (as placeAfter is
 * for the log), so a seat is judged the same whichever machine holds the room. Zero dependencies beyond lib/.
 *
 * A seat record: {name, role, machine, joined_at, seen_at, left_at?}, plus the fields only the seat's own machine
 * can use (LOCAL_FIELDS: pid, pid_start, session_id, cwd). The orch record also keeps its bookkeeping
 * (lib/orch.js) across a (re)bind. A record with no machine is from before machine ids: this machine's.
 *
 *   seatAlive(m) -> bool          not left, and: a seat of this machine with a pid: that pid is alive with its start
 *                                 time matching pid_start (a seat with no pid_start, or a pid whose start ps cannot
 *                                 read, counts as matching); any other seat (another machine's, or no pid): its lease
 *   orchPresence(o, now?) -> 'live' | 'starting' | null   the orch record as people are told about it: never listed
 *                                 as present when it never ran or its start failed
 *   leaseFresh(m, now?) -> bool   seen_at younger than SEAT_LEASE_MS
 *   startMatches(m) -> bool       m.pid_start still describes the process now holding m.pid (on this machine)
 *   ops(store) -> {join, leave, beat}   the store's named ops over its members.update (atomic) and kv:
 *     join(rec) -> {ok, rejoin?, error?}   rec = {name, role, machine, ...LOCAL_FIELDS}. A name held by a live seat
 *                                 of another holder (another machine, or another pid) is "name taken"; otherwise
 *                                 the seat is (re)bound: rec, joined_at = seen_at = now, the orch's bookkeeping kept.
 *     leave(name) -> bool         sets left_at and deletes presence/<name> (a mirror gets the deletion); false when
 *                                 there is no such seat or it left already
 *     beat(name, {presence?, now?}) -> bool   renews seen_at (at most every SEAT_BEAT_MS) and, with presence
 *                                 {state, detail?}, writes the document presence/<name> = {state, at, detail?}
 *                                 (RoomError INVALID for another state). false, writing nothing, for a seat that is
 *                                 absent or left. now: tests only (the host's clock otherwise).
 *   publicView(members) -> members   the document as other machines see it: LOCAL_FIELDS stripped
 *   PRESENCE_STATES, LOCAL_FIELDS
 */

const { isAlive } = require('../io.js');
const { pidStart } = require('../lock.js');
const { machineId } = require('../home.js');
const { PRESENCE_DETAIL_MAX, PID_START_SLACK_S, SEAT_BEAT_MS, SEAT_LEASE_MS, ORCH_BIND_MS, ORCH_CLAIM_MS, envMs } = require('../config.js');
const { RoomError } = require('./validate.js');

const PRESENCE_STATES = ['working', 'idle', 'permission', 'error'];
const LOCAL_FIELDS = ['pid', 'pid_start', 'session_id', 'cwd'];
const ORCH_FIELDS = ['job', 'spawned_at', 'closing', 'by', 'job_session', 'claim']; // kept across the orch's (re)bind

const validPid = pid => Number.isInteger(pid) && pid > 0;
const machineOf = m => m.machine || machineId();

/** The stored start time still describes the process now holding m.pid (tolerates legacy / unreadable). */
function startMatches(m) {
  if (m.pid_start == null) return true;
  const s = pidStart(m.pid);
  return s == null || Math.abs(s - Number(m.pid_start)) <= PID_START_SLACK_S;
}
const leaseFresh = (m, now = Date.now()) => { const t = Date.parse(m && m.seen_at); return Number.isFinite(t) && now - t < SEAT_LEASE_MS; };
function seatAlive(m) { // unary: callers pass it to filter/some
  if (!m || !m.name || m.left_at) return false;
  if (validPid(m.pid) && machineOf(m) === machineId()) return isAlive(m.pid) && startMatches(m);
  return leaseFresh(m);
}

/** rec is the holder of cur: the same machine and the same pid (none, for a seat on another machine). */
const sameHolder = (cur, rec) => machineOf(cur) === rec.machine && (cur.pid ?? null) === (rec.pid ?? null);

function joinFold(ms, rec, code, now) {
  const cur = ms[rec.name];
  if (cur && !sameHolder(cur, rec) && seatAlive(cur)) return { next: null, result: { ok: false, error: `name taken: "${rec.name}" is already in ${code}` } };
  const keep = {};
  if (rec.role === 'orch' && cur) for (const k of ORCH_FIELDS) if (cur[k] != null) keep[k] = cur[k];
  const at = new Date(now).toISOString();
  ms[rec.name] = { ...rec, joined_at: at, seen_at: at, ...keep };
  return { next: ms, result: cur ? { ok: true, rejoin: true } : { ok: true } };
}

function presenceDoc({ state, detail } = {}, now) {
  if (!PRESENCE_STATES.includes(state)) throw new RoomError('INVALID', `invalid presence state "${state}"`);
  const v = { state, at: new Date(now).toISOString() };
  if (detail) v.detail = String(detail).slice(0, PRESENCE_DETAIL_MAX);
  return v;
}

const seated = (ms, name) => !!ms[name] && !ms[name].left_at;

function ops(s) {
  return {
    join(rec) {
      let result;
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
      const stale = ms => seated(ms, name) && !(Date.parse(ms[name].seen_at) > now - SEAT_BEAT_MS);
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

function publicView(members) {
  const out = {};
  for (const [name, m] of Object.entries(members || {})) {
    out[name] = { ...m };
    for (const k of LOCAL_FIELDS) delete out[name][k];
  }
  return out;
}

/**
 * The orch as members see it: 'live' (bound: its pid on this machine alive, else it joined and its lease is fresh),
 * 'starting' (a spawn claim younger than ORCH_CLAIM_MS, or a job not bound within ORCH_BIND_MS), else null (never
 * ran, its start failed, stopped, left or closing). Same rules as lib/orch.js needsSpawn, from any machine.
 */
function orchPresence(o, now = Date.now()) {
  if (!o || o.left_at || o.stopped_at || o.closing) return null;
  if (validPid(o.pid) && machineOf(o) === machineId()) return seatAlive(o) ? 'live' : null;
  if (o.joined_at && o.job !== 'pending' && !o.spawn_error && leaseFresh(o, now)) return 'live';
  const since = now - Date.parse(o.spawned_at || 0);
  if (o.job === 'pending') return since <= envMs('SUB_HUMAN_ORCH_CLAIM_MS', ORCH_CLAIM_MS) ? 'starting' : null;
  if (o.job) return since <= ORCH_BIND_MS ? 'starting' : null;
  return null;
}

module.exports = { PRESENCE_STATES, LOCAL_FIELDS, seatAlive, orchPresence, leaseFresh, startMatches, ops, publicView };
