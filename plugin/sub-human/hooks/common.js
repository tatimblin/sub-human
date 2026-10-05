'use strict';
// Shared plumbing for the sub-human hooks.
//
// Hooks are trusted code run by Claude Code itself, never by a model. Identity is resolved from the
// hook payload's session_id first, then from CLAUDE_PID (Claude Code sets it for every hook it runs)
// by a direct lookup of the registered pid: /clear changes the session_id but not the claude process.

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const LIB = path.join(PLUGIN_ROOT, 'lib');
const identity = require(path.join(LIB, 'identity.js'));
const room = require(path.join(LIB, 'room.js'));
const plan = require(path.join(LIB, 'plan.js'));

const CAP = 9500; // the CLI caps SessionStart / prompt context at 10k

function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const out = obj => { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); };

/** PreToolUse decisions; the reason reaches the model. */
const pre = (decision, reason, extra = {}) => out({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra },
});
const deny = reason => pre('deny', reason);

/** additionalContext for any event that supports it. */
const context = (event, text, top = {}) => out({ ...top, hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/**
 * Run a hook body. On an unexpected error, onError(err, input) decides the output (gates fail
 * closed); otherwise print to stderr and exit 1, which Claude Code shows to the user only.
 */
function run(body, onError) {
  let input;
  try {
    input = readInput();
    body(input);
  } catch (err) {
    if (onError) { try { onError(err, input || {}); return; } catch { /* fall through */ } }
    process.stderr.write(`sub-human hook error: ${err && err.stack || err}\n`);
    process.exitCode = 1;
  }
}

const names = list => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

/** readMembers() ({name: record}) as an array, in join order. */
const members = code => Object.values(identity.readMembers(code) || {}).filter(m => m && m.name);
const hasLeft = m => !!m.left_at;
/** Joined, not-left, non-orchestrator members: the people the orchestrator may choose approvers from. */
const activeMembers = code => members(code).filter(m => m.role !== 'orch' && !hasLeft(m)).map(m => m.name);

/**
 * Resolve who this hook runs for: {code, name, role, session_id, pid} or null.
 * session_id first, then CLAUDE_PID. Binds room.js to the member's room.
 */
function whoami(input = {}) {
  let me = null;
  if (input.session_id) { try { me = identity.resolveBySession(input.session_id); } catch { me = null; } }
  if (!me) {
    const pid = identity.claudePid();
    if (pid) { try { me = identity.resolveByPid(pid); } catch { me = null; } }
  }
  if (!me || !me.code || !me.name) return null;
  room.bind(me.code);
  return me;
}

/** Best-effort presence write for the resolved member. */
function presence(me, state, detail) {
  try { if (me) identity.writePresence(me.code, me.name, state, detail); } catch { /* best-effort */ }
}

// ---------- per-member state under rooms/<code>/members/<name>/ ----------
const memberDir = me => path.join(identity.roomDir(me.code), 'members', me.name);
const statePath = (me, key) => path.join(memberDir(me), key + '.json');

function readState(me, key) {
  try { return JSON.parse(fs.readFileSync(statePath(me, key), 'utf8')); } catch { return null; }
}
function writeState(me, key, value) {
  fs.mkdirSync(memberDir(me), { recursive: true });
  const p = statePath(me, key);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
  fs.renameSync(tmp, p);
}
function clearState(me, key) { try { fs.unlinkSync(statePath(me, key)); } catch { /* absent */ } }

// ---------- role text and the context block the join / restore hooks inject ----------
function roleText(role) {
  const root = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;
  const f = path.join(root, 'skills', 'sub-human', role === 'orch' ? 'orchestrator.md' : 'member.md');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; }
}

function roster(code) {
  const ms = members(code);
  if (!ms.length) return '(nobody yet)';
  return ms.map(m => `- ${m.name}${m.role === 'orch' ? ' (orchestrator)' : ''}${hasLeft(m) ? ' (left)' : ''}`).join('\n');
}

function safeDigest() {
  try { return String(room.digest() || ''); } catch (e) { return `(digest unavailable: ${e.message})`; }
}

function clip(s, n = CAP) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * lib/rows.js rowCalls() (owned by the rows module); '' when it is missing or fails. Lists only the rows with
 * no live hold in this seat's hold server (rows/holds-NAME.json): rows survive /clear, compaction and a
 * re-run of /sub-human, and a second spawn would duplicate them. After --resume the server is new, so all.
 */
function rowCalls(me) {
  try {
    const rows = require(path.join(LIB, 'rows.js'));
    const members = identity.readMembers(me.code);
    const held = rows.readHolds(me.code, me.name);
    const only = held ? rows.rowsNeeded(me.code, me, { members, held }) : null;
    return String(rows.rowCalls(me, members, { only }) || '').trim();
  } catch (e) {
    process.stderr.write(`sub-human: rows unavailable: ${e && e.message}\n`);
    return '';
  }
}

/** The seat as a session title: "⬡ marmot-2509 · alice". */
const seatTitle = me => `⬡ ${me.code} · ${me.name}`;

/**
 * The context the join / restore hooks inject: head, who you are, role text, ROWS (rowCalls), roster,
 * digest. The ROWS section and the roster survive the cap; the role text and then the digest are clipped.
 */
function contextBlock(me, lead, { rowsLead = '', rowsText = null } = {}) {
  const role = me.role === 'orch' ? 'orch' : 'member';
  const who = role === 'orch'
    ? `You are the ORCHESTRATOR of sub-human room ${me.code}. Members join with: /sub-human NAME (or /sub-human NAME ${me.code})`
    : `You are ${me.name}'s Claude in sub-human room ${me.code}. Your human is ${me.name}.`;
  const head = `SUB-HUMAN role=${role} name=${me.name} room=${me.code}${lead ? ` (${lead})` : ''}`;
  const calls = rowsText == null ? rowCalls(me) : '';
  const rowsPart = rowsText != null ? `ROWS\n${rowsText}` : calls ? `ROWS\n${rowsLead}${calls}` : '';
  const rosterPart = `ROSTER\n${roster(me.code)}`;
  const text = roleText(role);
  const fixed = [head, who, rowsPart, rosterPart].join('\n\n').length + 8;
  const parts = [head, who];
  if (text) parts.push(clip(text, Math.max(500, CAP - fixed - 300)));
  if (rowsPart) parts.push(rowsPart);
  parts.push(rosterPart);
  parts.push(`DIGEST\n${safeDigest()}`);
  return clip(parts.join('\n\n'));
}

// ---------- paths ----------
function realish(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/** Resolve p (relative to base) and report whether it is inside dir (lexically or after realpath). */
function isUnder(p, dir, base = process.cwd()) {
  const abs = path.resolve(base, p);
  const cands = new Set([abs, realish(abs)]);
  // a not-yet-existing file: realpath its parent
  cands.add(path.join(realish(path.dirname(abs)), path.basename(abs)));
  const roots = new Set([path.resolve(dir), realish(dir)]);
  for (const x of cands) for (const r of roots) if (x === r || x.startsWith(r + path.sep)) return true;
  return false;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

module.exports = {
  identity, room, plan, PLUGIN_ROOT, CAP,
  readInput, out, pre, deny, context, run, names,
  members, hasLeft, activeMembers, whoami, presence,
  memberDir, readState, writeState, clearState,
  roleText, roster, safeDigest, clip, rowCalls, seatTitle, contextBlock,
  isUnder, realish, stamp,
};
