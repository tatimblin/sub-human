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

// ---------- the mechanics block the join / restore hooks inject (<= BLOCK_MAX chars with 5 members) ----------
const BLOCK_MAX = 900;
const TEMPLATE_FILES = { member: 'member.md', orch: 'orchestrator.md' };
/** Used only when a role file is missing or has no {CODE} placeholder. */
const DEFAULT_TEMPLATES = {
  member: 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (with {OTHERS}). {NAME} types here.\n'
    + 'Room notices are a group chat: output their chat lines exactly as given and nothing else. Never show room ids.\n'
    + 'Reach a session now: SendMessage to {ADDR_EXAMPLE}. Only a person\'s own card records agreement.',
  orch: 'SUB-HUMAN: you are the headless helper of room {CODE} (members: {OTHERS}). Nobody types here.\n'
    + 'Reach a member now: SendMessage to {ADDR_EXAMPLE}. To facilitate: read {PLUGIN}/skills/sub-human/facilitate.md.',
};

const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

/** D's template for the role (skills/sub-human/member.md | orchestrator.md), with placeholders unfilled. */
function template(role) {
  const r = role === 'orch' ? 'orch' : 'member';
  let t = '';
  try { t = fs.readFileSync(path.join(pluginRoot(), 'skills', 'sub-human', TEMPLATE_FILES[r]), 'utf8').trim(); } catch { /* default */ }
  return t.includes('{CODE}') ? t : DEFAULT_TEMPLATES[r];
}

/** The placeholder values: {NAME} {CODE} {OTHERS} {ADDR_EXAMPLE} {PLUGIN}. */
function fillVars(me, ms = members(me.code)) {
  const live = ms.filter(m => !hasLeft(m) && m.name !== me.name);
  const humans = live.filter(m => m.role !== 'orch').map(m => m.name);
  const others = me.role === 'orch' ? humans : [...humans, 'orch'];
  const ex = humans[0] || (me.role === 'orch' ? 'NAME' : 'orch');
  return { NAME: me.name, CODE: me.code, OTHERS: others.length ? others.join(', ') : 'nobody yet', ADDR_EXAMPLE: identity.address(ex, me.code), PLUGIN: pluginRoot() };
}
const fill = (t, vars) => t.replace(/\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/g, (_, k) => vars[k]);

const roleText = (role, me) => (me ? fill(template(role), fillVars(me)) : template(role));

function clip(s, n = CAP) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * lib/rows.js rowCalls() (owned by the rows module); '' when it is missing or fails. Lists only the rows with
 * no live hold in this seat's hold server (rows/holds-NAME.json): rows survive /clear, compaction and a
 * re-run of /sub-human, and a second spawn would duplicate them. After --resume the server is new, so all.
 */
function rowCalls(me) {
  try {
    const rows = require(path.join(LIB, 'rows.js'));
    const ms = identity.readMembers(me.code);
    const held = rows.readHolds(me.code, me.name);
    const only = held ? rows.rowsNeeded(me.code, me, { members: ms, held }) : null;
    return String(rows.rowCalls(me, ms, { only }) || '').trim();
  } catch (e) {
    process.stderr.write(`sub-human: rows unavailable: ${e && e.message}\n`);
    return '';
  }
}

/**
 * rowCalls() cut to its Agent(...) lines when the full text would overflow the block. Several participant
 * calls (the orch) become one call pattern plus the names, so the block stays inside the budget with 5 members.
 */
function compactRows(text, me) {
  const calls = text.split('\n').map(l => l.trim()).filter(l => /^Agent\(\{.*\}\)$/.test(l));
  const tail = me.role === 'orch' ? '\nOn member_joined, follow its "row:" note.' : '';
  if (!calls.length) return `Your rows are running; make no Agent call for them.${tail}`;
  const who = calls.map(c => /subagent_type: "sub-human:participant", description: "([^"]+)"/.exec(c)).filter(Boolean).map(m => m[1]);
  if (who.length > 1 && who.length === calls.length) {
    const pattern = calls[0].split(`"${who[0]}"`).join('"NAME"').split(` ${who[0]}"`).join(' NAME"');
    return `Make one Agent call per name, all in one message, now; write nothing about them:\n${pattern}\nNAME = ${who.join(', ')}${tail}`;
  }
  return `Make ${calls.length === 1 ? 'this Agent call' : 'these Agent calls, in one message,'} now, exactly as written; write nothing about it:\n${calls.join('\n')}${tail}`;
}

/** The seat as a session title: its native address "alice.vole-8126" (SendMessage / ListAgents reach it by it). */
const seatTitle = me => identity.address(me.name, me.code);

/**
 * The context the join / restore hooks inject: D's template filled for this seat, then ROWS (rowCalls, cut
 * to the bare calls when the whole block would pass BLOCK_MAX). lead (e.g. "restored after clear") is a
 * short last line. No roster or digest: others' words arrive by the monitor and the per-prompt digest.
 */
function contextBlock(me, lead, { rowsLead = '', rowsText = null } = {}) {
  const text = roleText(me.role, me);
  const tail = lead ? `\n(${lead})` : '';
  let rows = rowsText != null ? rowsText : rowCalls(me);
  if (rows && rowsText == null) {
    const full = `${rowsLead}${rows}`;
    rows = `${text}\n\nROWS\n${full}${tail}`.length <= BLOCK_MAX ? full : compactRows(rows, me);
  }
  return clip(`${text}${rows ? `\n\nROWS\n${rows}` : ''}${tail}`);
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
  identity, room, PLUGIN_ROOT, CAP, BLOCK_MAX,
  readInput, out, pre, deny, context, run, names,
  members, hasLeft, activeMembers, whoami, presence,
  memberDir, readState, writeState, clearState,
  template, fillVars, roleText, clip, rowCalls, compactRows, seatTitle, contextBlock,
  isUnder, realish, stamp,
};
