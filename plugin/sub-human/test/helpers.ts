/**
 * Shared test helpers. Requiring this file:
 *   - strips inherited CLAUDE* env vars from process.env (a test run started inside Claude Code would
 *     otherwise carry the parent's CLAUDE_PID / CLAUDE_CODE_SESSION_ID and confuse identity), and
 *   - gives the process a fresh temp SUB_HUMAN_HOME, and
 *   - sets SUB_HUMAN_TEST=1 (lib/env.ts testMs: the test-only timing overrides).
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
 *   PLUGIN, LIB, BIN, MCP                paths
 *
 * Temp dirs: requiring this file wraps fs.mkdtempSync / fs.mkdtemp / fs.promises.mkdtemp so every dir
 * this process creates under os.tmpdir() (by a helper, a test file or lib code) is tracked, and removes
 * them all when the process exits (also on SIGINT/SIGTERM/SIGHUP). Detached children a test started
 * (the session-end reaper, the room's Claude starter in join) can outlive the test process and write into its
 * home again, so the exit handler also leaves a small detached sweeper that removes the same dirs again
 * after 2 s and 10 s. Dirs live for the whole process, so nothing loses its home mid-run.
 * SUB_HUMAN_KEEP_TMP=1 keeps everything (for debugging a failure).
 *
 * npm run test:plugin preloads this file (--import) into every test process, so the tracking and the CLAUDE*
 * stripping apply per process even to test files that never import it. It loads no lib/ module at import time.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';
import type * as IdentityLib from '../lib/identity.ts';
import type * as SeatKeyLib from '../hooks/seat-key.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn } from './support/brands.ts';

// lib/ is required on first use (createRequire: require(esm) is synchronous), so preloading this file loads none of it
const require = createRequire(import.meta.url);

const PLUGIN = path.join(import.meta.dirname, '..');
const LIB = path.join(PLUGIN, 'lib');
const BIN = path.join(PLUGIN, 'scripts', 'sub-human');
const MCP = path.join(PLUGIN, 'mcp', 'room-server.ts');

// ---- temp-dir tracking ---------------------------------------------------------------------------
/** Tracks the temp dirs this process makes; one per process (the slot survives a second load of this file). */
interface TmpTracking { remove(dir: string): void }
const TRACK = Symbol.for('sub-human.test.tmp');
const slots = globalThis as unknown as Record<symbol, TmpTracking | undefined>;
const tmp: TmpTracking = slots[TRACK] || (slots[TRACK] = installTmpTracking());

function installTmpTracking(): TmpTracking {
  const dirs = new Set<string>();
  const roots = new Set([os.tmpdir()]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* keep the raw one */ }
  const under = (d: string) => { const a = path.resolve(String(d)); for (const r of roots) if (a.startsWith(r)) return true; return false; };
  const note = <T,>(d: T): T => { if (typeof d === 'string' && under(d)) dirs.add(d); return d; };

  // The wrappers forward whatever overload the caller used; the casts only restore fs's overloaded signatures.
  type Fn = (...a: unknown[]) => unknown;
  const mkdtempSync = fs.mkdtempSync as unknown as Fn;
  const mkdtemp = fs.mkdtemp as unknown as Fn;
  const pmkdtemp = fs.promises.mkdtemp as unknown as (...a: unknown[]) => Promise<unknown>;
  fs.mkdtempSync = function (this: unknown, ...a: unknown[]) { return note(mkdtempSync.apply(this, a)); } as typeof fs.mkdtempSync;
  fs.mkdtemp = function (this: unknown, ...a: unknown[]) {
    const cb = a.pop() as (err: Error | null, d?: string) => void;
    return mkdtemp.call(this, ...a, (err: Error | null, d?: string) => { if (!err) note(d); cb(err, d); });
  } as typeof fs.mkdtemp;
  fs.promises.mkdtemp = async function (this: unknown, ...a: unknown[]) { return note(await pmkdtemp.apply(this, a)); } as typeof fs.promises.mkdtemp;
  syncBuiltinESMExports(); // a module that imports { mkdtempSync } from 'node:fs' by name gets the wrapper too

  const keep = () => process.env.SUB_HUMAN_KEEP_TMP === '1';
  const rm = (d: string) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ } };
  const removed = new Set<string>();
  function cleanup() {
    if (keep()) return;
    for (const d of dirs) { rm(d); removed.add(d); }
    dirs.clear();
  }
  function remove(d: string) { if (keep()) return; rm(d); dirs.delete(d); removed.add(d); }

  process.on('exit', () => {
    cleanup();
    if (keep() || !removed.size) return;
    // A detached child may still write into a removed home (mkdir -p recreates it): sweep again later.
    const sweep = `const fs=require('fs'),d=process.argv.slice(1),r=()=>{for(const x of d)try{fs.rmSync(x,{recursive:true,force:true})}catch{}};setTimeout(r,2000);setTimeout(r,10000);`;
    try {
      spawn(process.execPath, ['-e', sweep, ...removed], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH || '' } }).unref();
    } catch { /* best effort */ }
  });
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]] as const) {
    process.once(sig, () => { process.exit(128 + n); }); // exit handlers (cleanup, sleeper kills) still run
  }
  return { remove };
}

/** A tracked temp dir. With a node:test context `t`, it is removed when that test ends. */
function tmpDir(prefix = 'sub-human-test-', t?: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => tmp.remove(dir));
  return dir;
}

// ---- env -----------------------------------------------------------------------------------------
const stripClaude = (env: NodeJS.ProcessEnv) => { for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]; return env; };
stripClaude(process.env);
// the marker lib/env.ts testMs honours: timings that would weaken a guard (the PIN's backoff, the card's wait)
// take their SUB_HUMAN_* overrides only here, in a test process and the children it spawns
process.env.SUB_HUMAN_TEST = '1';
// via=human appends need the seat signer that the hook handlers that sign install (at-room, consent, join:
// hooks/seat-key.ts arm). A test process is trusted the same way; required lazily, so preloading loads no lib/.
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('sub-human.human-signer')] =
  (code: RoomCode, name: string) => (require(path.join(PLUGIN, 'hooks', 'seat-key.ts')) as typeof SeatKeyLib).ensure(code, sn(name));

let identityMod: typeof IdentityLib | null = null;
const identity = () => identityMod || (identityMod = require(path.join(LIB, 'identity.ts')) as typeof IdentityLib);

let current: RoomCode | null = null;

function freshHome(t?: TestContext): string {
  const dir = tmpDir('sub-human-test-', t);
  process.env.SUB_HUMAN_HOME = dir;
  current = null;
  return dir;
}
freshHome();

function newRoom(): RoomCode {
  current = identity().newCode();
  return current;
}

/** A seat this test registered (identity.join). */
interface Registered { code: RoomCode; name: string; role: string; pid: number }

function register(name: string, role = 'member', pid = process.pid, code: RoomCode = current || newRoom()): Registered {
  const r = identity().join({ code, name: sn(name), role, pid, session_id: `sess-${name}-${pid}`, cwd: process.cwd() });
  if (!r.ok) throw new Error(`register ${name}: ${r.error}`);
  return { code, name, role, pid };
}

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = stripClaude({ ...process.env });
  delete env.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

const sleepers = new Set<ChildProcess>();
function spawnSleeper(sec = 60): ChildProcess {
  const c = spawn('sleep', [String(sec)], { stdio: 'ignore' });
  c.unref(); // never keeps the test process alive
  sleepers.add(c);
  c.on('exit', () => sleepers.delete(c));
  return c;
}
process.on('exit', () => { for (const c of sleepers) { try { c.kill(); } catch { /* gone */ } } });

function deadPid(): Promise<number> {
  return new Promise(resolve => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    c.on('exit', () => resolve(c.pid as number));
  });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Polls fn until it returns a truthy value or ms pass; returns its last value. */
async function until<T>(fn: () => T, ms = 5000, step = 50): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await sleep(step);
  }
}

export { PLUGIN, LIB, BIN, MCP, freshHome, newRoom, register, childEnv, spawnSleeper, deadPid, sleep, until,
  tmpDir };