'use strict';
/**
 * plugin/sub-human/lib/rows.js: participant rows in the agent panel.
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
 *   joinNote(me, name, {held}?) -> "row: …" suffix for a member_joined notice (bin/sub-human tail): running (no
 *       call) or the call to make. For a member it is about the ROOM row (which adds NAME by itself), so a join
 *       never invites a room-row call while that row is live; row-guard.js stays the backstop.
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
 *       No entry ids (people never see them); task ids ("#2") are the room task list's numbers.
 *       Proposals: lib/consent.js fold (the same state stateLine and the consent gate read). A proposal is named
 *       by its title (the stored plan's first line, clipped to ROW_TITLE_MAX; the 6-char hash when there is
 *       none): rows are for people, and no tool call is made from them. Segments that do not fit are dropped.
 *       name === code (or null): the member's room row, from viewer's seat: first a join / settled leave of the
 *         last 2 min ("+bob joined", "−bob left"; lib/notices.js rowSegment), then "⚠ your answer needed Cursor paging",
 *         "✓ agreed Cursor paging 1/2", "✖ objected", "✔ decided Cursor paging" ("✖ blocked …" when someone objected),
 *         "proposal Cursor paging 0/2", else "N here";
 *         then "✉ N for you", then lib/tasks.js summary(code, viewer) ("tasks 3 open · #2 you · #4 bob").
 *       otherwise: NAME's state as viewer sees it: "✓ agreed Cursor paging", "✖ objected", "⚠ reviewing …",
 *         "✔ decided …" (after it, their latest status: "Claude status: handler done"), then their
 *         open task on the room list ("◼ #2 parser tests"), presence, mail; "left".
 *   rowLine(label, text) -> "label  text"   what a row shows (the row content replaces the whole label)
 *
 * Agent -> row map (<room>/rows/<session_id>.json = {byAgent: {agentId: {kind, name, parent, at}}}):
 *   parseSpawn(toolInput, members, code) -> {kind: 'participant'|'room', name}|null
 *   recordRow(code, sessionId, agentId, rec), forgetRow(code, agentId), readRowMap(code) -> {agentId: rec}
 *       readRowMap merges every session file in the room: /clear changes session_id, agent ids don't.
 *   Hold liveness (written by mcp/hold.js): writeHolds(code, name, {members, room, roomUntil}), readHolds(code, name)
 *       <room>/rows/holds-<name>.json = {pid, at, members: [names], room: bool, roomUntil?}; readHolds folds
 *       roomUntil into room (a room hold between its JOINED return and the re-call is still running).
 *   missingRows(code, me, {now}) -> [names]   active members whose row has no live hold (after a grace period)
 *
 * Constants: PARTICIPANT ('sub-human:participant'), ROOM_AGENT ('sub-human:room'), ROW_MAX.
 */

const fs = require('node:fs');
const path = require('node:path');
const identity = require('./identity.js');
const room = require('./room.js');
const tasks = require('./tasks.js');
const notices = require('./notices.js');
const { readJson, writeJsonAtomic, isAlive } = require('./io.js');
const { withLock } = require('./lock.js');
const text = require('./text.js');
const { fold } = require('./consent.js');
const proposal = require('./proposal.js');
const { ROW_MAX, ROW_TITLE_MAX, PRESENCE_STALE_MS, HOLDS_STALE_MS, MISSING_GRACE_MS, ROWS_LOCK_TIMEOUT_MS, ROWS_LOCK_STALE_MS } = require('./config.js');

const PARTICIPANT = 'sub-human:participant';
const ROOM_AGENT = 'sub-human:room';
const { NAME_RE, SID_SAFE, oneLine } = text;

// ---------- small helpers ----------
const clip = (s, n = ROW_MAX) => text.clip(s, n);
const h6 = h => String(h || '').slice(0, 6);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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

const normKind = e => room.normalize(e).kind;

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
    lines.push(`Each member_joined NAME notice ends with "row: …", read from your live rows: make ${participantCall('NAME')} only when it says NAME has no row running (same message as anything else you do). When it says the row is already running (a rejoin), make NO Agent call.`);
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

/**
 * What a member_joined notice (bin/sub-human tail) tells this seat about NAME's row, from the live holds file:
 * spawn only when the row is not running. A spawn of a running row is denied by hooks/row-guard.js, which
 * Claude Code renders as a red error, so the notice prevents the attempt. '' for my own join.
 */
function joinNote(me, name, { held } = {}) {
  if (!me || !me.code || !name || name === me.name || name === 'orch') return '';
  const h = held === undefined ? readHolds(me.code, me.name) : held;
  if (me.role === 'orch') {
    return h && h.members.includes(name)
      ? `row: ${name}'s row is already running (it shows the rejoin by itself); make NO Agent call`
      : `row: ${name} has no row running; spawn it now: Agent sub-human:participant, description "${name}", prompt "member: ${name}", run_in_background`;
  }
  if (h && h.room) return `row: your room row adds ${name} by itself; make NO Agent call`;
  const names = memberList(readMembers(me.code)).filter(m => isActive(m) && !isOrch(m) && m.name !== me.name).map(m => m.name);
  if (!names.includes(name)) names.push(name);
  return `row: your room row is not running; spawn it now: ${roomCall(me.code, names)}`;
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
const mapFile = (code, sid) => path.join(rowsDir(code), `${SID_SAFE.test(String(sid)) ? sid : 'unknown'}.json`);

/** The row map's lock: wait up to ROWS_LOCK_TIMEOUT_MS, then throw (the hook logs it); never write unlocked. */
const lockFile = (file, fn) => withLock(file + '.lock', fn, { timeoutMs: ROWS_LOCK_TIMEOUT_MS, staleMs: ROWS_LOCK_STALE_MS });

function recordRow(code, sessionId, agentId, rec) {
  if (!code || !agentId) return false;
  const file = mapFile(code, sessionId);
  lockFile(file, () => {
    const cur = readJson(file, {}) || {};
    const byAgent = cur.byAgent && typeof cur.byAgent === 'object' ? cur.byAgent : {};
    byAgent[agentId] = { ...rec, at: new Date().toISOString() };
    writeJsonAtomic(file, { byAgent }, { compact: true });
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
    lockFile(f, () => {
      const m = readJson(f, null);
      if (m && m.byAgent && m.byAgent[agentId]) { delete m.byAgent[agentId]; writeJsonAtomic(f, m, { compact: true }); }
    });
  }
}

// ---------- hold liveness (mcp/hold.js writes, the status line reads) ----------
const holdsFile = (code, name) => path.join(rowsDir(code), `holds-${name}.json`);
function writeHolds(code, name, { members = [], room = false, roomUntil = 0 } = {}) {
  const rec = { pid: process.pid, at: new Date().toISOString(), members: [...new Set(members)].sort(), room: !!room };
  if (!room && roomUntil) rec.roomUntil = new Date(roomUntil).toISOString();
  try { writeJsonAtomic(holdsFile(code, name), rec, { compact: true }); } catch { /* best effort */ }
}
/**
 * The live holds of NAME's hold server, or null. `room` stays true until `roomUntil`: a room hold that just
 * returned JOINED/RESPAWN is being re-called by its row agent, so the room row is still running (a join
 * notice read in that gap would invite a second room-row spawn, which row-guard then denies in red).
 */
function readHolds(code, name, now = Date.now()) {
  const h = readJson(holdsFile(code, name), null);
  if (!h || !isAlive(h.pid) || now - Date.parse(h.at) > HOLDS_STALE_MS) return null;
  const members = Array.isArray(h.members) ? h.members : [];
  return { ...h, members, room: !!h.room || (!!h.roomUntil && now < Date.parse(h.roomUntil)) };
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
const plainLen = s => Array.from(String(s).replace(/\x1b\[[0-9;]*m/g, '')).length;
const SEP = ' · ';

/** Join segments with " · ", keeping whole segments while they fit in ROW_MAX; a lone first one is clipped. */
function fit(parts) {
  const ps = parts.filter(Boolean);
  if (!ps.length) return '';
  let out = ps[0], len = plainLen(ps[0]);
  if (len > ROW_MAX) return clip(ps[0].replace(/\x1b\[[0-9;]*m/g, ''));
  for (const p of ps.slice(1)) {
    const l = plainLen(p);
    if (len + SEP.length + l > ROW_MAX) break;
    out += SEP + p; len += SEP.length + l;
  }
  return out;
}

/**
 * Proposals in log order (of their latest entry), from lib/consent.js fold: {id, hash, approvers, verdict: {name:
 * {kind, id}} (approvers' current answers), decided (decision id or 0), agreed (count), objectors, name (title)}.
 */
function proposals(es, code) {
  const f = fold(es);
  return [...f.proposals.values()].map(fp => {
    const m = f.matrix(fp.hash);
    const verdict = {};
    for (const n of fp.approvers) if (m.answers[n]) verdict[n] = m.answers[n];
    const d = f.decisions.get(fp.hash);
    return { id: fp.id, hash: fp.hash, from: fp.from, approvers: fp.approvers, verdict, decided: d ? d.id : 0,
      agreed: m.agreed.length, objectors: m.objected, name: label(code, fp) };
  });
}
/** What a row calls a proposal: its title (lib/proposal.js title), clipped; the short hash when it has none. */
function label(code, fp) {
  let t = '';
  try { t = code ? oneLine(proposal.title(code, fp.hash, fp.entry)) : ''; } catch { /* unreadable: the hash */ }
  return t ? clip(t, ROW_TITLE_MAX) : h6(fp.hash);
}
/** A closed proposal: "✔ decided TITLE" when everyone agreed, "✖ blocked TITLE" when someone objected. */
const decidedText = (p, c) => (p.objectors.length ? c.warn(`✖ blocked ${p.name}`) : c.ok(`✔ decided ${p.name}`));
/** Undecided proposals that name `name` and that `name` has not answered (newest last). */
const awaiting = (ps, name) => ps.filter(p => !p.decided && p.approvers.includes(name) && !p.verdict[name]);
/** The proposal a row reports for `name`: the newest that names them, else the newest. */
const latestFor = (ps, name) => ps.filter(p => p.approvers.includes(name)).at(-1) || ps.at(-1) || null;

// ---------- tasks (lib/tasks.js: the mirror of the orch's native list) ----------
const taskSummary = (code, viewer) => oneLine(tasks.summary(code, viewer) || '');
/** NAME's open task on the room list: in progress first, else the first pending. */
function openTask(list, name) {
  const mine = list.filter(t => t && t.owner === name && t.status !== 'completed' && t.status !== 'deleted' && !(t.metadata && t.metadata._internal));
  return mine.find(t => t.status === 'in_progress') || mine[0] || null;
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

function participantText(code, name, viewer, es, ms, now, c, taskList) {
  const m = ms.find(x => x.name === name);
  if (!m) return 'not in the room';
  if (m.left_at) return 'left';
  const parts = [];
  const p = latestFor(proposals(es, code), name);
  if (p) {
    const v = p.verdict[name];
    // Build phase: their latest status after the decision replaces "decided".
    const st = p.decided ? es.filter(e => e.from === name && e.id > p.decided && e.kind === 'status').at(-1) : null;
    if (st) parts.push(`${st.via === 'agent' ? 'Claude ' : ''}status: ${oneLine(st.text)}`);
    else if (p.decided) parts.push(decidedText(p, c));
    else if (v && v.kind === 'signoff') parts.push(c.ok(`✓ agreed ${p.name}`));
    else if (v && v.kind === 'objection') parts.push(c.warn('✖ objected'));
    else if (p.approvers.includes(name)) parts.push(c.warn(`⚠ reviewing ${p.name}`));
  }
  const t = openTask(taskList, name);
  if (t) parts.push(`◼ #${t.id} ${clip(oneLine(t.subject), 28)}`);
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
    if (last) parts.push(c.dim(`${last.via === 'agent' ? 'Claude ' : ''}${normKind(last)} ${ago(last.at, now)}`));
    else if (!parts.length) parts.push(c.dim('joined'));
  }
  return fit(parts);
}

function roomText(code, viewer, es, ms, now, c, summary) {
  const parts = [];
  // a join or (settled) leave of the last 2 minutes leads the row: "+bob joined", "−bob left" (lib/notices.js)
  const move = notices.rowSegment(es, viewer, { now });
  if (move) parts.push(c.dim(move));
  const ps = proposals(es, code);
  const need = viewer ? awaiting(ps, viewer) : [];
  const p = viewer ? latestFor(ps, viewer) : ps.at(-1);
  if (need.length) {
    parts.push(c.warn(`⚠ your answer needed ${need.at(-1).name}${need.length > 1 ? ` +${need.length - 1}` : ''}`));
  } else if (p) {
    const v = viewer && p.verdict[viewer];
    const n = `${p.agreed}/${p.approvers.length}`;
    if (p.decided) parts.push(decidedText(p, c));
    else if (v && v.kind === 'signoff') parts.push(c.ok(`✓ agreed ${p.name} ${n}`));
    else if (v && v.kind === 'objection') parts.push(c.warn('✖ objected'));
    else parts.push(`proposal ${p.name} ${n}`);
    if (!p.decided && p.objectors.some(x => x !== viewer)) parts.push(c.warn(`✖ ${plural(p.objectors.filter(x => x !== viewer).length, 'objection')}`));
  } else {
    parts.push(c.dim(`${ms.filter(m => isActive(m) && !isOrch(m)).length} here`));
  }
  if (viewer) {
    let lastOwn = 0;
    for (const e of es) if (e.from === viewer && e.via === 'human') lastOwn = e.id;
    const mail = es.filter(e => e.id > lastOwn && e.to === viewer && e.from !== viewer).length;
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  if (summary) parts.push(summary);
  return fit(parts);
}

/**
 * opts: {color, entries, members, now, tasks (list; default lib/tasks.js mine(code, name)),
 *        taskSummary (string, default tasks.summary(code, viewer))}.
 */
function rowText(code, name, viewer, opts = {}) {
  const now = opts.now || Date.now();
  const es = opts.entries || readLog(code);
  const ms = memberList(opts.members || readMembers(code));
  const c = paint(!!opts.color);
  if (name == null || name === code) {
    const summary = opts.taskSummary != null ? oneLine(opts.taskSummary) : taskSummary(code, viewer);
    return roomText(code, viewer, es, ms, now, c, summary);
  }
  return participantText(code, name, viewer, es, ms, now, c, Array.isArray(opts.tasks) ? opts.tasks : tasks.mine(code, name));
}

const rowLine = (label, text) => (text ? `${label}  ${text}` : label);

module.exports = {
  PARTICIPANT, ROOM_AGENT, ROW_MAX,
  rowCalls, rowsNeeded, joinNote, participantCall, roomCall, parseSpawn,
  rowText, rowLine, readLog, fit,
  recordRow, forgetRow, readRowMap, rowsDir, mapFile,
  writeHolds, readHolds, holdsFile, missingRows,
};
