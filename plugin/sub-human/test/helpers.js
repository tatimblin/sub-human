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
 *   tmpDir(prefix, t?) -> dir            a tracked temp dir; with a node:test context t, removed in t.after
 *   freshHome(t?)                        as above; pass t to remove the home when that test ends
 *   cleanupTmp()                         remove every tracked dir now (also runs on exit)
 *   PLUGIN, LIB, BIN, MCP                paths
 *
 * Temp dirs: requiring this file wraps fs.mkdtempSync / fs.mkdtemp / fs.promises.mkdtemp so every dir
 * this process creates under os.tmpdir() (by a helper, a test file or lib code) is tracked, and removes
 * them all when the process exits (also on SIGINT/SIGTERM/SIGHUP). Detached children a test started
 * (the session-end reaper, the at-room forgery checker) can outlive the test process and write into its
 * home again, so the exit handler also leaves a small detached sweeper that removes the same dirs again
 * after 2 s and 10 s. Dirs live for the whole process, so nothing loses its home mid-run.
 * SUB_HUMAN_KEEP_TMP=1 keeps everything (for debugging a failure).
 *
 * test/index.js preloads this file (--require) into every test process, so the tracking and the
 * CLAUDE* stripping apply per process even to test files that never require it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..');
const LIB = path.join(PLUGIN, 'lib');
const BIN = path.join(PLUGIN, 'bin', 'sub-human');
const MCP = path.join(PLUGIN, 'mcp', 'room-server.js');

// ---- temp-dir tracking ---------------------------------------------------------------------------
const TRACK = Symbol.for('sub-human.test.tmp');
const tmp = global[TRACK] || (global[TRACK] = installTmpTracking());

function installTmpTracking() {
  const dirs = new Set();
  const roots = new Set([os.tmpdir()]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* keep the raw one */ }
  const under = d => { const a = path.resolve(String(d)); for (const r of roots) if (a.startsWith(r)) return true; return false; };
  const note = d => { if (typeof d === 'string' && under(d)) dirs.add(d); return d; };

  const { mkdtempSync, mkdtemp } = fs;
  const pmkdtemp = fs.promises.mkdtemp;
  fs.mkdtempSync = function (...a) { return note(mkdtempSync.apply(this, a)); };
  fs.mkdtemp = function (...a) {
    const cb = a.pop();
    return mkdtemp.call(this, ...a, (err, d) => { if (!err) note(d); cb(err, d); });
  };
  fs.promises.mkdtemp = async function (...a) { return note(await pmkdtemp.apply(this, a)); };

  const keep = () => process.env.SUB_HUMAN_KEEP_TMP === '1';
  const rm = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ } };
  const removed = new Set();
  function cleanup() {
    if (keep()) return;
    for (const d of dirs) { rm(d); removed.add(d); }
    dirs.clear();
  }
  function remove(d) { if (keep()) return; rm(d); dirs.delete(d); removed.add(d); }

  process.on('exit', () => {
    cleanup();
    if (keep() || !removed.size) return;
    // A detached child may still write into a removed home (mkdir -p recreates it): sweep again later.
    const sweep = `const fs=require('fs'),d=process.argv.slice(1),r=()=>{for(const x of d)try{fs.rmSync(x,{recursive:true,force:true})}catch{}};setTimeout(r,2000);setTimeout(r,10000);`;
    try {
      const { spawn: sp } = require('node:child_process');
      sp(process.execPath, ['-e', sweep, ...removed], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH || '' } }).unref();
    } catch { /* best effort */ }
  });
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.once(sig, () => { process.exit(128 + n); }); // exit handlers (cleanup, sleeper kills) still run
  }
  return { dirs, cleanup, remove };
}

/** A tracked temp dir. With a node:test context `t`, it is removed when that test ends. */
function tmpDir(prefix = 'sub-human-test-', t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t && typeof t.after === 'function') t.after(() => tmp.remove(dir));
  return dir;
}

// ---- env -----------------------------------------------------------------------------------------
const stripClaude = env => { for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]; return env; };
stripClaude(process.env);
delete process.env.ROOM_DIR;

let identityMod = null; // loaded on first use, so preloading this file does not load lib/
const identity = () => identityMod || (identityMod = require(path.join(LIB, 'identity.js')));

let current = null;

function freshHome(t) {
  const dir = tmpDir('sub-human-test-', t);
  process.env.SUB_HUMAN_HOME = dir;
  current = null;
  return dir;
}
freshHome();

function newRoom() {
  current = identity().newCode();
  return current;
}

function register(name, role = 'member', pid = process.pid, code = current || newRoom()) {
  const r = identity().join({ code, name, role, pid, session_id: `sess-${name}-${pid}`, cwd: process.cwd() });
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
  tmpDir, cleanupTmp: () => tmp.cleanup(), currentRoom: () => current };
