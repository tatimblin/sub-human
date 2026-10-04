'use strict';
/**
 * Shared test helpers. Requiring this file:
 *   - strips inherited CLAUDE* env vars from process.env (a test run started inside Claude Code would
 *     otherwise carry the parent's CLAUDE_PID / CLAUDE_CODE_SESSION_ID and confuse identity), and
 *   - gives the process a fresh temp SUB_HUMAN_HOME.
 *
 *   freshHome() -> dir                   a new temp SUB_HUMAN_HOME (also set in process.env)
 *   newRoom() -> code                    identity.newCode(); becomes the default room for register()
 *   register(name, role='member', pid=process.pid, code=current room) -> {code, name, role, pid}
 *       joins via identity.join and asserts ok. The test process's own pid is a real ancestor of every
 *       child it spawns, so a child resolves to whatever is registered for process.pid.
 *   childEnv(extra) -> env               process.env minus NODE_TEST_CONTEXT and CLAUDE*, plus extra
 *   spawnSleeper(sec) -> ChildProcess    a live, non-ancestor process (for "other session" pids)
 *   deadPid() -> Promise<int>            the pid of a process that has exited
 *   sleep(ms), until(fn, ms)
 *   PLUGIN, LIB, BIN, MCP                paths
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..');
const LIB = path.join(PLUGIN, 'lib');
const BIN = path.join(PLUGIN, 'bin', 'sub-human');
const MCP = path.join(PLUGIN, 'mcp', 'room-server.js');

const stripClaude = env => { for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]; return env; };
stripClaude(process.env);
delete process.env.ROOM_DIR;

const identity = require(path.join(LIB, 'identity.js'));

let current = null;

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-test-'));
  process.env.SUB_HUMAN_HOME = dir;
  current = null;
  return dir;
}
freshHome();

function newRoom() {
  current = identity.newCode();
  return current;
}

function register(name, role = 'member', pid = process.pid, code = current || newRoom()) {
  const r = identity.join({ code, name, role, pid, session_id: `sess-${name}-${pid}`, cwd: process.cwd() });
  if (!r.ok) throw new Error(`register ${name}: ${r.error}`);
  return { code, name, role, pid };
}

function childEnv(extra = {}) {
  const env = stripClaude({ ...process.env });
  delete env.NODE_TEST_CONTEXT;
  delete env.ROOM_DIR;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

const sleepers = new Set();
function spawnSleeper(sec = 60) {
  const c = spawn('sleep', [String(sec)], { stdio: 'ignore' });
  c.unref(); // never keeps the test process alive
  sleepers.add(c);
  c.on('exit', () => sleepers.delete(c));
  return c;
}
process.on('exit', () => { for (const c of sleepers) { try { c.kill(); } catch { /* gone */ } } });

function deadPid() {
  return new Promise(resolve => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    c.on('exit', () => resolve(c.pid));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 50) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await sleep(step);
  }
}

module.exports = { PLUGIN, LIB, BIN, MCP, freshHome, newRoom, register, childEnv, spawnSleeper, deadPid, sleep, until,
  currentRoom: () => current };
