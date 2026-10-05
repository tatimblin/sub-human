'use strict';
/**
 * plugin/sub-human/lib/rows.js: participant rows in the agent panel (E1, E3, P0).
 * CommonJS, zero dependencies. Reads the room log, members.json and presence files; writes only <room>/rows/.
 *
 * Spawning (text for the model; join.js, session-restore.js and the role text append it, never hand-copy):
 *   rowCalls(me, members, {only}?) -> string
 *       me = {code, name, role}; members = readMembers(code) (object by name) or an array of {name, role, left_at?}.
 *       orch:   one background sub-human:participant per active member, labelled by the member's name,
 *               prompt "member: NAME".
 *       member: one background sub-human:room, labelled by the room code, prompt "room: CODE\nmembers: a, b"
 *               (the other active members except the orch and me). The room agent spawns those children.
 *       only = rowsNeeded(...) limits the calls to the rows that are missing; only = [] says the rows are intact
 *       and lists no calls (a second spawn would duplicate a row).
 *   rowsNeeded(code, me, {members, held}) -> names (orch) or [code] (member): rows with no live hold in `held`
 *       (= readHolds(code, me.name), null = nothing held). No grace period: used by join / restore.
 * Lifecycle: a row lives as long as its viewer is in the room. A participant row does NOT end when its member
 *   leaves; it reads "left" and comes back to life on rejoin (mcp/hold.js keeps holding). One live hold per
 *   (viewer, kind, name): hold.js refuses a second with "STOP: duplicate row", and hooks/row-guard.js
 *   (PreToolUse Agent) denies the spawn itself when the row's hold is already live, so no dead copy appears.
 *   participantCall(name), roomCall(code, names)   the single Agent call lines
 *
 * Row text (deterministic from the log + members.json + <room>/presence/<name>.json {state, at}):
 *   rowText(code, name, viewer, {color, entries, members, now}?) -> string (<= ROW_MAX chars, no label)
 *       name === code (or null): the member's room row, from viewer's seat: plan progress, objections,
 *         "⚠ your sign-off needed", "✉ N for you".
 *       otherwise: NAME's state as viewer sees it, e.g. "✓ signed 593da0 · idle",
 *         "⚠ reviewing 593da0 · ✖ 1 objection (#31)", "left".
 *   rowLine(label, text) -> "label  text"   what a row shows (the row content replaces the whole label)
 *
 * Agent -> row map (<room>/rows/<session_id>.json = {byAgent: {agentId: {kind, name, parent, at}}}):
 *   parseSpawn(toolInput, members, code) -> {kind: 'participant'|'room', name}|null
 *   recordRow(code, sessionId, agentId, rec), forgetRow(code, agentId), readRowMap(code) -> {agentId: rec}
 *       readRowMap merges every session file in the room: /clear changes session_id (P0), agent ids don't.
 *   Hold liveness (written by mcp/hold.js): writeHolds(code, name, {members, room}), readHolds(code, name)
 *       <room>/rows/holds-<name>.json = {pid, at, members: [names], room: bool}
 *   missingRows(code, me, {now}) -> [names]   active members whose row has no live hold (after a grace period)
 *
 * Constants: PARTICIPANT ('sub-human:participant'), ROOM_AGENT ('sub-human:room'), ROW_MAX.
 */

const fs = require('node:fs');
const path = require('node:path');
const identity = require('./identity.js');

const PARTICIPANT = 'sub-human:participant';
const ROOM_AGENT = 'sub-human:room';
const ROW_MAX = 60;
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const CODE_RE = /^[a-z]+-\d{4}$/;
const PRESENCE_STALE_MS = 6 * 60 * 60 * 1000;
const HOLDS_STALE_MS = 90 * 1000;
const MISSING_GRACE_MS = 45 * 1000;

// ---------- small helpers ----------
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
const clip = (s, n = ROW_MAX) => { const a = Array.from(String(s)); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
const h6 = h => String(h || '').slice(0, 6);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isAlive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function roomDir(code) { return identity.roomDir(code); }
function readLog(code) {
  let text = '';
  try { text = fs.readFileSync(path.join(roomDir(code), 'log.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && Number.isInteger(e.id)) out.push(e); } catch { /* torn line */ }
  }
  return out;
}
function memberList(members) {
  if (!members) return [];
  const list = Array.isArray(members) ? members : Object.entries(members).map(([k, v]) => ({ name: k, ...(v || {}) }));
  return list.filter(m => m && typeof m.name === 'string' && NAME_RE.test(m.name));
}
const isActive = m => !!m && !m.left_at;
const isOrch = m => m.role === 'orch' || m.name === 'orch';
function readMembers(code) { try { return identity.readMembers(code) || {}; } catch { return {}; } }

const normKind = e => (e.kind === 'concern' ? 'objection' : e.kind === 'agree' && e.plan_hash ? 'signoff' : e.kind);

// ---------- spawning ----------
const participantCall = name =>
  `Agent({subagent_type: "${PARTICIPANT}", description: "${name}", prompt: "member: ${name}", run_in_background: true})`;
const roomCall = (code, names) =>
  `Agent({subagent_type: "${ROOM_AGENT}", description: "${code}", prompt: "room: ${code}\\nmembers: ${names.length ? names.join(', ') : '(none)'}", run_in_background: true})`;

function rowCalls(me, members, { only = null } = {}) {
  if (!me || !me.code) return '';
  const others = memberList(members).filter(m => isActive(m) && m.name !== me.name);
  const want = Array.isArray(only) ? new Set(only) : null;
  if (me.role === 'orch') {
    const all = others.filter(m => !isOrch(m)).map(m => m.name);
    const names = want ? all.filter(n => want.has(n)) : all;
    const lines = ['PARTICIPANT ROWS (do this now; it costs nothing while they wait):'];
    if (names.length) {
      lines.push(`Make exactly these Agent tool calls, all in ONE message, then carry on (write nothing about them):`);
      for (const n of names) lines.push(participantCall(n));
    } else if (want && all.length) {
      lines.push('Your rows are already running (their holds are live). Make no Agent calls for them now; a second copy would duplicate a row in the panel.');
    } else {
      lines.push('No members yet.');
    }
    lines.push(`When a member_joined NAME entry arrives, make this call for NAME (same message as anything else you do): ${participantCall('NAME')}. If NAME already has a row (a rejoin), the call is refused; that is fine, do not retry.`);
    lines.push('A row stays when its member leaves (it reads "left") and comes back to life when they rejoin; it ends when you leave. Never spawn a row for yourself, and never call the hold tool yourself.');
    return lines.join('\n');
  }
  const names = others.filter(m => !isOrch(m)).map(m => m.name);
  if (want && !want.has(me.code)) {
    return [
      'ROOM ROW: already running (its hold is live). Make no Agent call for it now; a second copy would duplicate the room row in the panel.',
      'It adds and keeps the other members\' rows by itself; never call the hold tool yourself.',
    ].join('\n');
  }
  return [
    `ROOM ROW (do this now; it costs nothing while it waits):`,
    `Make exactly this one Agent tool call, then carry on (write nothing about it):`,
    roomCall(me.code, names),
    `It shows the room as one row labelled ${me.code}, with the other members inside it, and adds new members by itself. Spawn it once per session; never call the hold tool yourself.`,
  ].join('\n');
}

/** Rows this seat should have but `held` (readHolds) shows no live hold for. Orch: names; member: [code]. */
function rowsNeeded(code, me, { members, held = null } = {}) {
  const ms = memberList(members || readMembers(code));
  const h = held || { members: [], room: false };
  if (me.role === 'orch') return ms.filter(m => isActive(m) && !isOrch(m) && m.name !== me.name && !h.members.includes(m.name)).map(m => m.name);
  return h.room ? [] : [code];
}

/** Which row an Agent(...) spawn is: from subagent_type plus the prompt / description / name. */
function parseSpawn(input, members, code) {
  if (!input || typeof input !== 'object') return null;
  const type = String(input.subagent_type || '');
  const known = new Set(memberList(members).map(m => m.name));
  const fields = [input.prompt, input.description, input.name].map(x => (typeof x === 'string' ? x.trim() : ''));
  if (type === PARTICIPANT || type === 'participant') {
    for (const f of fields) {
      const m = /\bmember:\s*([A-Za-z0-9_.-]{1,32})/.exec(f);
      if (m) return { kind: 'participant', name: m[1] };
    }
    for (const f of fields) if (NAME_RE.test(f) && (!known.size || known.has(f))) return { kind: 'participant', name: f };
    return null;
  }
  if (type === ROOM_AGENT || type === 'room') {
    for (const f of fields) {
      const m = /\broom:\s*([a-z]+-\d{4})/.exec(f) || /^([a-z]+-\d{4})$/.exec(f);
      if (m) return { kind: 'room', name: m[1] };
    }
    return code ? { kind: 'room', name: code } : null;
  }
  return null;
}

// ---------- the agent -> row map ----------
const rowsDir = code => path.join(roomDir(code), 'rows');
const SID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const mapFile = (code, sid) => path.join(rowsDir(code), `${SID_SAFE.test(String(sid)) ? sid : 'unknown'}.json`);

function withLock(file, fn) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) break; // proceed unlocked rather than drop the record
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}

function recordRow(code, sessionId, agentId, rec) {
  if (!code || !agentId) return false;
  const file = mapFile(code, sessionId);
  withLock(file, () => {
    const cur = readJson(file, {}) || {};
    const byAgent = cur.byAgent && typeof cur.byAgent === 'object' ? cur.byAgent : {};
    byAgent[agentId] = { ...rec, at: new Date().toISOString() };
    writeJsonAtomic(file, { byAgent });
  });
  return true;
}

function sessionFiles(code) {
  try { return fs.readdirSync(rowsDir(code)).filter(f => f.endsWith('.json') && !f.startsWith('holds-')).map(f => path.join(rowsDir(code), f)); } catch { return []; }
}

function readRowMap(code) {
  const out = {};
  for (const f of sessionFiles(code)) {
    const m = readJson(f, null);
    if (m && m.byAgent && typeof m.byAgent === 'object') Object.assign(out, m.byAgent);
  }
  return out;
}

function forgetRow(code, agentId) {
  for (const f of sessionFiles(code)) {
    withLock(f, () => {
      const m = readJson(f, null);
      if (m && m.byAgent && m.byAgent[agentId]) { delete m.byAgent[agentId]; writeJsonAtomic(f, m); }
    });
  }
}

// ---------- hold liveness (mcp/hold.js writes, the status line reads) ----------
const holdsFile = (code, name) => path.join(rowsDir(code), `holds-${name}.json`);
function writeHolds(code, name, { members = [], room = false } = {}) {
  try { writeJsonAtomic(holdsFile(code, name), { pid: process.pid, at: new Date().toISOString(), members: [...new Set(members)].sort(), room: !!room }); } catch { /* best effort */ }
}
function readHolds(code, name, now = Date.now()) {
  const h = readJson(holdsFile(code, name), null);
  if (!h || !isAlive(h.pid) || now - Date.parse(h.at) > HOLDS_STALE_MS) return null;
  return h;
}

/** Rows this seat should have but holds nothing for. Orch: members. Member: the room row ([code]). */
function missingRows(code, me, { now = Date.now(), members } = {}) {
  const ms = memberList(members || readMembers(code));
  const h = readHolds(code, me.name, now) || { members: [], room: false };
  const old = m => !m.joined_at || now - Date.parse(m.joined_at) > MISSING_GRACE_MS;
  if (me.role === 'orch') return ms.filter(m => isActive(m) && !isOrch(m) && m.name !== me.name && old(m) && !h.members.includes(m.name)).map(m => m.name);
  const self = ms.find(m => m.name === me.name);
  return self && old(self) && !h.room ? [code] : [];
}

// ---------- row text ----------
const ESC = '\x1b[';
const paint = on => (on
  ? { warn: s => `${ESC}33m${s}${ESC}0m`, ok: s => `${ESC}32m${s}${ESC}0m`, dim: s => `${ESC}2m${s}${ESC}0m` }
  : { warn: s => s, ok: s => s, dim: s => s });

function currentPlan(es) {
  let p = null;
  for (const e of es) if (e.kind === 'plan_rev' && e.plan_hash) p = { id: e.id, hash: e.plan_hash, approvers: Array.isArray(e.approvers) ? e.approvers : [] };
  if (!p) return null;
  const verdict = {}; // name -> {kind, id}: latest via=human signoff/objection on this hash
  let decided = false;
  for (const e of es) {
    if (e.kind === 'decision' && e.plan_hash === p.hash) decided = true;
    if (e.via !== 'human' || e.plan_hash !== p.hash) continue;
    const k = normKind(e);
    if (k === 'signoff' || k === 'objection') verdict[e.from] = { kind: k, id: e.id };
  }
  const signed = p.approvers.filter(n => verdict[n] && verdict[n].kind === 'signoff').length;
  const objectors = Object.keys(verdict).filter(n => verdict[n].kind === 'objection');
  return { ...p, verdict, decided, signed, total: p.approvers.length, objectors };
}

function presenceOf(code, name, es, now) {
  const p = readJson(path.join(roomDir(code), 'presence', `${name}.json`), null);
  if (!p || typeof p.state !== 'string') return null;
  const at = Date.parse(p.at);
  if (Number.isFinite(at)) {
    if (now - at > PRESENCE_STALE_MS) return null;
    // Anything they posted after the presence write means they are back at it: the old state is stale.
    const last = es.filter(e => e.from === name).at(-1);
    if (last && Date.parse(last.at) > at) return null;
  }
  const s = p.state.toLowerCase();
  if (s === 'gone' || s === 'left') return null;
  if (s === 'asking' || s === 'prompt' || s === 'permission' || s === 'permission_prompt') return '? prompt';
  if (s === 'idle' || s === 'idle_prompt') return 'idle';
  if (s === 'busy' || s === 'working') return 'working';
  if (s === 'error' || s === 'failed' || s === 'stop_failure') return '✖ error';
  return clip(s, 12);
}

function participantText(code, name, viewer, es, ms, now, c) {
  const m = ms.find(x => x.name === name);
  if (!m) return 'not in the room';
  if (m.left_at) return 'left';
  const parts = [];
  const p = currentPlan(es);
  if (p) {
    const v = p.verdict[name];
    if (p.decided) parts.push(c.ok(`✔ decided ${h6(p.hash)}`));
    else if (v && v.kind === 'signoff') parts.push(c.ok(`✓ signed ${h6(p.hash)}`));
    else if (v && v.kind === 'objection') parts.push(c.warn(`✖ objected ${h6(p.hash)} (#${v.id})`));
    else if (p.approvers.includes(name)) parts.push(c.warn(`⚠ reviewing ${h6(p.hash)}`));
    if (!p.decided && !(v && v.kind === 'objection')) {
      // Their Claude's objections on this plan since their last verdict.
      const since = v ? v.id : 0;
      const objs = es.filter(e => e.from === name && e.id > since && e.plan_hash === p.hash && normKind(e) === 'objection');
      if (objs.length) parts.push(c.warn(`✖ ${plural(objs.length, 'objection')} (#${objs.at(-1).id})`));
    }
  }
  const pres = presenceOf(code, name, es, now);
  if (pres) parts.push(pres === 'idle' ? c.dim(pres) : c.warn(pres));
  if (viewer && viewer !== name) {
    let lastReply = 0;
    for (const e of es) if (e.from === viewer && (e.to === name || e.to === 'room' || !e.to)) lastReply = e.id;
    const mail = es.filter(e => e.from === name && e.to === viewer && e.id > lastReply).length;
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  if (!parts.length || (parts.length === 1 && pres)) {
    const last = es.filter(e => e.from === name && e.kind !== 'member_joined' && e.kind !== 'member_left').at(-1);
    if (last) parts.push(c.dim(`#${last.id} ${last.via === 'agent' ? 'Claude ' : ''}${normKind(last)} ${ago(last.at, now)}`));
    else if (!parts.length) parts.push(c.dim('joined'));
  }
  return parts.join(' · ');
}

function roomText(code, viewer, es, ms, now, c) {
  const parts = [];
  const p = currentPlan(es);
  if (p) {
    const base = `plan ${h6(p.hash)} ${p.signed}/${p.total}`;
    const v = viewer && p.verdict[viewer];
    const needMe = !p.decided && viewer && p.approvers.includes(viewer) && !(v && v.kind === 'signoff');
    if (p.decided) parts.push(c.ok(`${base} ✔`));
    else parts.push(base);
    if (!p.decided && p.objectors.length) parts.push(c.warn(`✖ ${plural(p.objectors.length, 'objection')}`));
    if (needMe) parts.push(c.warn('⚠ your sign-off needed'));
  } else {
    const here = ms.filter(isActive).length;
    parts.push(c.dim(`${here} here`));
  }
  if (viewer) {
    let lastOwn = 0;
    for (const e of es) if (e.from === viewer && e.via === 'human') lastOwn = e.id;
    const mail = es.filter(e => e.id > lastOwn && e.to === viewer && e.from !== viewer).length;
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  return parts.join(' · ');
}

function rowText(code, name, viewer, opts = {}) {
  const now = opts.now || Date.now();
  const es = opts.entries || readLog(code);
  const ms = memberList(opts.members || readMembers(code));
  const c = paint(!!opts.color);
  const raw = name == null || name === code ? roomText(code, viewer, es, ms, now, c) : participantText(code, name, viewer, es, ms, now, c);
  // Clip on the visible text; colored output is short enough by construction (each segment is clipped by
  // the ROW_MAX check below on its plain form).
  if (!opts.color) return clip(raw);
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, '');
  return Array.from(plain).length > ROW_MAX ? clip(plain) : raw;
}

const rowLine = (label, text) => (text ? `${label}  ${text}` : label);

module.exports = {
  PARTICIPANT, ROOM_AGENT, ROW_MAX,
  rowCalls, rowsNeeded, participantCall, roomCall, parseSpawn,
  rowText, rowLine, readLog, currentPlan,
  recordRow, forgetRow, readRowMap, rowsDir, mapFile,
  writeHolds, readHolds, holdsFile, missingRows,
};
