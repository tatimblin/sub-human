'use strict';
/**
 * plugin/sub-human/lib/room/link-state.js: how this machine's link to a room hosted elsewhere is doing, for the
 * room row (lib/rows.js), the agent statusline (statusline/segments.js), `sub-human doctor` (lib/cli/doctor.js) and
 * the tail's link line (lib/tail.js linkLine). Read only, never throws. Zero dependencies beyond lib/io.js,
 * lib/room/links.js and (lazily) lib/remote/link.js.
 *
 * One vocabulary, STATES, everywhere a link's state is written or shown (the daemon's state record and its document
 * `link`, the row, doctor, the tail):
 *   online      connected; hooks' writes cross now
 *   connecting  dialling: the first connection, or a redial (after a failure, a wake, a network change)
 *   offline     not connected, retrying on its own (or its daemon is not running: the join hook restarts it)
 *   fork        for good: this copy no longer matches the host's log (`sub-human link --reset CODE`)
 *   stopped     for good: refused (AUTH, PROTOCOL), revoked, the room closed or moved with no way to follow
 * Older records said up / down (state file, before 0.4.1): LEGACY maps them (down with detail fork or stopped reads
 * as that).
 *
 * Sources, best first:
 *   links.readState(code)            the link daemon's record <home>/links/<code>.state.json {state, since, attempt,
 *                                    lastError, rttMs, queued, pid, detail, at} (lib/room/links.js). Read defensively:
 *                                    any field may be absent
 *   the mirror's document `link`     {pid, state, since, reason?, code?} (lib/remote/link.js status)
 * A record whose daemon is gone (its pid, else the document's, is not alive) reads 'offline' with lastError "the link
 * daemon is not running" and dead: true; fork and stopped stay what they are.
 *
 *   read(code) -> State | null       null when this machine has no link to CODE (a room hosted here, or none)
 *       State = {state: STATES, since?, attempt?, lastError?, rttMs?, queued?, pid?, detail?, dead?,
 *                source: 'state-file'|'link-doc'}
 *   normalize(state, detail?) -> STATES member   an old or new word to the vocabulary (unknown: 'offline')
 *   indicator(st, {now}?) -> string  the compact segment: "⇄ online", "… connecting", "… connecting (3)",
 *       "✕ offline 2m · 2 queued", "✕ stopped", "✕ FORK: sub-human link --reset"; '' for null
 *   isDown(st) -> bool               connecting after a first failure, offline, fork or stopped: worth leading a row with
 *   stateFile(code) -> string        <home>/links/<code>.state.json
 *   STATES                           Set of the five words
 */
const { isAlive } = require('../io.js');
const links = require('./links.js');

const STATES = new Set(['online', 'connecting', 'offline', 'fork', 'stopped']);
const LEGACY = { up: 'online', down: 'offline' };
const FOR_GOOD = new Set(['fork', 'stopped']);

const stateFile = code => links.stateFile(code);

const num = x => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : undefined);
const str = x => (typeof x === 'string' && x ? x : undefined);
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function normalize(state, detail) {
  if (FOR_GOOD.has(detail)) return detail;
  const s = LEGACY[state] || state;
  return STATES.has(s) ? s : 'offline';
}

/** The mirror's `link` document (lib/remote/link.js status), or null when it cannot be read. */
function linkDoc(code) {
  try { return require('../remote/link.js').status(code); } catch { return null; }
}

const NOT_RUNNING = 'the link daemon is not running';

function read(code) {
  try {
    if (!links.get(code)) return null;
  } catch { return null; }
  const doc = linkDoc(code);
  let f = null;
  try { f = links.readState(code); } catch { f = null; }
  if (f && typeof f === 'object' && (STATES.has(f.state) || f.state in LEGACY)) {
    const pid = num(f.pid);
    const dead = pid ? !isAlive(pid) : !!(doc && doc.pid && !doc.running);
    const st = clean({
      state: normalize(f.state, f.detail), since: str(f.since), attempt: num(f.attempt), lastError: str(f.lastError),
      rttMs: num(f.rttMs), queued: num(f.queued), pid, detail: str(f.detail), source: 'state-file',
    });
    if (dead && !FOR_GOOD.has(st.state)) return { ...st, state: 'offline', lastError: st.lastError || NOT_RUNNING, dead: true };
    return st;
  }
  if (!doc || !doc.state) return { state: 'offline', lastError: NOT_RUNNING, dead: true, source: 'link-doc' };
  const dead = !!(doc.pid && !doc.running);
  const state = normalize(doc.state);
  const lastError = str(doc.reason) || (dead ? NOT_RUNNING : undefined);
  return clean({ state: dead && !FOR_GOOD.has(state) ? 'offline' : state, since: str(doc.since), lastError, ...(dead ? { dead: true } : {}), source: 'link-doc' });
}

function ago(iso, now) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function indicator(st, { now = Date.now() } = {}) {
  if (!st) return '';
  const state = normalize(st.state, st.detail);
  const queued = st.queued > 0 ? ` · ${st.queued} queued` : '';
  if (state === 'online') return '⇄ online';
  if (state === 'fork') return '✕ FORK: sub-human link --reset';
  if (state === 'stopped') return `✕ stopped${queued}`;
  if (state === 'connecting') return st.attempt > 1 ? `… connecting (${st.attempt})${queued}` : `… connecting${queued}`;
  const t = st.since ? ago(st.since, now) : '';
  return `✕ offline${t ? ` ${t}` : ''}${queued}`;
}

function isDown(st) {
  if (!st) return false;
  const state = normalize(st.state, st.detail);
  return state === 'offline' || FOR_GOOD.has(state) || (state === 'connecting' && st.attempt > 1);
}

module.exports = { read, normalize, indicator, isDown, stateFile, STATES };
