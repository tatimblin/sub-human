'use strict';
// Shared plumbing for the sub-human hooks. Ported from demo/hooks/common.js (seat helpers removed).
//
// Hooks are trusted code run by Claude Code itself, never by a model. Identity is resolved by the
// hook payload's session_id first, then by CLAUDE_PID (validated as an ancestor by the lib), because
// /clear changes the session_id but not the claude process.

const fs = require('node:fs');
const os = require('node:os');
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
/** Joined, not-left, non-orchestrator members: every one must be a plan approver. */
const activeMembers = code => members(code).filter(m => m.role !== 'orch' && !hasLeft(m)).map(m => m.name);

/**
 * Resolve who this hook runs for: {code, name, role, pid, ...} or null.
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
  const rec = (identity.readMembers(me.code) || {})[me.name] || {};
  return { ...me, pid: me.pid || rec.pid, session_id: rec.session_id || null };
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

/** pending_review: set by the member plan-gate, read by plan-result / stop-feedback. */
const readPending = me => readState(me, 'pending_review');
const writePending = (me, v) => writeState(me, 'pending_review', v);
const clearPending = me => clearState(me, 'pending_review');

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

function contextBlock(me, lead) {
  const who = me.role === 'orch'
    ? `You are the ORCHESTRATOR of sub-human room ${me.code}. Members join with: /sub-human NAME ${me.code}`
    : `You are ${me.name}'s Claude in sub-human room ${me.code}. Your human is ${me.name}.`;
  const head = `SUB-HUMAN role=${me.role === 'orch' ? 'orch' : 'member'} name=${me.name} room=${me.code}${lead ? ` (${lead})` : ''}`;
  const parts = [head, who];
  const role = roleText(me.role);
  if (role) parts.push(role);
  parts.push(`ROSTER\n${roster(me.code)}`);
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

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const plansRoot = () => path.join(claudeConfigDir(), 'plans');

/** True when showClearContextOnPlanAccept is on in any settings layer (user, project, local). */
function clearContextOnAccept(cwd) {
  const files = [path.join(claudeConfigDir(), 'settings.json')];
  const proj = process.env.CLAUDE_PROJECT_DIR || cwd;
  if (proj) files.push(path.join(proj, '.claude', 'settings.json'), path.join(proj, '.claude', 'settings.local.json'));
  if (cwd && cwd !== proj) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files.some(f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).showClearContextOnPlanAccept === true; } catch { return false; }
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

module.exports = {
  identity, room, plan, PLUGIN_ROOT, CAP,
  readInput, out, pre, deny, context, run, names,
  members, hasLeft, activeMembers, whoami,
  memberDir, readState, writeState, clearState, readPending, writePending, clearPending,
  roleText, roster, safeDigest, clip, contextBlock,
  isUnder, realish, claudeConfigDir, plansRoot, clearContextOnAccept, stamp,
};
