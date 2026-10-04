'use strict';
// Shared plumbing for demo/hooks/*.js. Zero dependencies; all log access goes through demo/lib/room.js.
//
// Hook scripts are trusted code run by Claude Code itself, never by a model. They inherit the
// orchestrator's environment (ROOM_USER=orch, ROOM_HUMANS, ROOM_DIR), which the launcher sets.
// Hooks that log as the orchestrator default ROOM_USER to $ROOM_ORCH or "orch".
// No hook ever writes a human identity (via:"human"); humans, the host included, post only
// through demo/bin/chat.

const fs = require('node:fs');
const path = require('node:path');
const room = require(path.join(__dirname, '..', 'lib', 'room.js'));

const REPO = path.join(__dirname, '..', '..');
const projectDir = () => process.env.CLAUDE_PROJECT_DIR || REPO;
const SEAT_RE = /^seat-(.+)$/;

function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const out = obj => { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); };

/** PreToolUse deny: the reason reaches the model. */
const deny = reason => out({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * Run a hook body. On an unexpected error, onError(err) decides the output (guards fail closed);
 * the default prints to stderr and exits 1, which Claude Code shows to the user only.
 */
function run(body, onError) {
  let input;
  try {
    input = readInput();
    body(input);
  } catch (err) {
    if (onError) { try { onError(err, input || {}); return; } catch { /* fall through */ } }
    process.stderr.write(`room hook error: ${err && err.stack || err}\n`);
    process.exitCode = 1;
  }
}

function asOrch() {
  if (!process.env.ROOM_USER) process.env.ROOM_USER = process.env.ROOM_ORCH || 'orch';
}

/** Run fn with ROOM_USER temporarily set (the lib reads it on every append). */
function withUser(user, fn) {
  const old = process.env.ROOM_USER;
  process.env.ROOM_USER = user;
  try { return fn(); } finally { if (old === undefined) delete process.env.ROOM_USER; else process.env.ROOM_USER = old; }
}

const seatHuman = agentType => { const m = SEAT_RE.exec(agentType || ''); return m ? m[1] : null; };

// ---------- roster: <ROOM_DIR>/roster.json, keyed by human ----------
// { "alice": { human, agent_id, agent_type, session_id, live, up_id, started_at, stopped_at?, last_seq } }
// room.js readRoster() maps v.human -> v.agent_id from this shape.
const rosterPath = () => path.join(room.dir(), 'roster.json');

function readRoster() {
  try { return JSON.parse(fs.readFileSync(rosterPath(), 'utf8')) || {}; } catch { return {}; }
}

function writeRoster(r) {
  fs.mkdirSync(room.dir(), { recursive: true });
  const tmp = rosterPath() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n');
  fs.renameSync(tmp, rosterPath());
}

function updateRoster(fn) {
  const r = readRoster();
  fn(r);
  writeRoster(r);
  return r;
}

/** Resolve p (relative to base) and report whether it is inside one of dirs. */
function isUnder(p, dirs, base = process.cwd()) {
  const abs = path.resolve(base, p);
  const real = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
  return dirs.some(d => {
    const variants = new Set([path.resolve(d)]);
    try { variants.add(fs.realpathSync(d)); } catch { /* may not exist yet */ }
    return [...variants].some(v => [abs, real].some(x => x === v || x.startsWith(v + path.sep)));
  });
}

/** Every directory that counts as "the room": demo/.room in the project, and $ROOM_DIR. */
const roomDirs = () => [...new Set([path.join(projectDir(), 'demo', '.room'), path.join(REPO, 'demo', '.room'), path.resolve(room.dir())])];
/** Plan directories: plansDirectory from room-settings.json (demo/.room/plans) and <ROOM_DIR>/plans. */
const planDirs = () => [...new Set([path.join(projectDir(), 'demo', '.room', 'plans'), path.resolve(room.plansDir())])];

module.exports = {
  room, REPO, projectDir, readInput, out, deny, run, asOrch, withUser, seatHuman,
  rosterPath, readRoster, writeRoster, updateRoster, isUnder, roomDirs, planDirs,
};
