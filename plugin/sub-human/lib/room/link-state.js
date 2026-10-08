'use strict';
/**
 * plugin/sub-human/lib/room/link-state.js: how this machine's link to a room hosted elsewhere is doing, for the
 * room row (lib/rows.js), the agent statusline (statusline/segments.js) and `sub-human doctor` (lib/cli/doctor.js).
 * Read only, never throws. Zero dependencies beyond lib/io.js, lib/room/links.js and (lazily) lib/remote/link.js.
 *
 * Sources, best first:
 *   <home>/links/<code>.state.json   the link daemon's state record {state: 'up'|'connecting'|'down', since,
 *                                    attempt, lastError, rttMs, queued}. Read defensively: any field may be absent.
 *   the mirror's document `link`     {pid, state: connecting|online|offline|fork|stopped, since, reason?, code?}
 *                                    (lib/remote/link.js status), what older daemons write.
 * A record whose daemon is known dead (the document's pid is gone) reads 'down': the daemon is not running.
 *
 *   read(code) -> State | null       null when this machine has no link to CODE (a room hosted here, or none)
 *       State = {state: 'up'|'connecting'|'down'|'fork', since?, attempt?, lastError?, rttMs?, queued?,
 *                source: 'state-file'|'link-doc'}
 *   indicator(st, {now}?) -> string  the compact segment: "⇄ linked", "… connecting", "… reconnecting (3)",
 *       "✕ offline 2m · 2 queued", "✕ FORK: sub-human link --reset"; '' for null
 *   isDown(st) -> bool               connecting after a first failure, down or fork: worth leading a row with
 *   stateFile(code) -> string        <home>/links/<code>.state.json
 */
const path = require('node:path');
const { readJson } = require('../io.js');
const links = require('./links.js');

const STATES = new Set(['up', 'connecting', 'down', 'fork']);
const DOC_STATE = { online: 'up', connecting: 'connecting', offline: 'down', stopped: 'down', fork: 'fork' };

const stateFile = code => path.join(links.linksDir(), `${code}.state.json`);

const num = x => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : undefined);
const str = x => (typeof x === 'string' && x ? x : undefined);
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The mirror's `link` document (lib/remote/link.js status), or null when it cannot be read. */
function linkDoc(code) {
  try { return require('../remote/link.js').status(code); } catch { return null; }
}

function read(code) {
  try {
    if (!links.get(code)) return null;
  } catch { return null; }
  const doc = linkDoc(code);
  const dead = !!(doc && doc.pid && !doc.running);
  const f = readJson(stateFile(code));
  if (f && typeof f === 'object' && STATES.has(f.state)) {
    const st = clean({
      state: f.state, since: str(f.since), attempt: num(f.attempt), lastError: str(f.lastError),
      rttMs: num(f.rttMs), queued: num(f.queued), source: 'state-file',
    });
    if (dead && st.state !== 'fork') return { ...st, state: 'down', lastError: st.lastError || 'the link daemon is not running' };
    return st;
  }
  if (!doc || !doc.state) {
    return { state: 'down', lastError: 'the link daemon is not running', source: 'link-doc' };
  }
  const state = DOC_STATE[doc.state] || 'down';
  const lastError = str(doc.reason) || (dead ? 'the link daemon is not running' : undefined);
  return clean({ state: dead && state !== 'fork' ? 'down' : state, since: str(doc.since), lastError, source: 'link-doc' });
}

function ago(iso, now) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function indicator(st, { now = Date.now() } = {}) {
  if (!st) return '';
  const queued = st.queued > 0 ? ` · ${st.queued} queued` : '';
  if (st.state === 'up') return '⇄ linked';
  if (st.state === 'fork') return '✕ FORK: sub-human link --reset';
  if (st.state === 'connecting') return st.attempt > 1 ? `… reconnecting (${st.attempt})${queued}` : `… connecting${queued}`;
  const t = st.since ? ago(st.since, now) : '';
  return `✕ offline${t ? ` ${t}` : ''}${queued}`;
}

const isDown = st => !!st && (st.state === 'down' || st.state === 'fork' || (st.state === 'connecting' && st.attempt > 1));

module.exports = { read, indicator, isDown, stateFile, STATES };
