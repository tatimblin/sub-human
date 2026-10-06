#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/lib/orch.js: the room's headless orchestrator, a `claude --bg` session the join hook starts.
 * CommonJS, zero dependencies. Nobody launches it by hand; for debugging, `node lib/orch.js cmd CODE` prints
 * the exact command and `node lib/orch.js spawn CODE` runs it (both from the cwd the orch should work in).
 *
 *   spawnPlan({code, cwd, home?, pluginDir?, env?}) -> {bin, args, env, cwd}
 *       env is clean (no CLAUDE_* from the parent; only HOME USER LOGNAME SHELL PATH TERM LANG TMPDIR). The
 *       orch's own env comes from the --settings launch flag: SUB_HUMAN_HOME, SUB_HUMAN_ROOM,
 *       CLAUDE_CODE_TASK_LIST_ID=sh-CODE, CLAUDE_CODE_ENABLE_TODO_TOOLS=1, plus crossSessionInbound "accept".
 *       No --model: plan mode runs on Sonnet regardless (S1 F2). cwd is the joiner's: --bg refuses an
 *       untrusted cwd (S1 F3). No file is written into ~/.claude: the orch creates the "room CODE open" task.
 *   spawn({code, cwd, ...}) -> {ok, job?, error?}      runs it, parses "backgrounded · <job> · orch.CODE",
 *       records members.json orch {job, spawned_at} (pid is filled when the orch's /sub-human binds it)
 *   needsSpawn(code) -> bool    no orch record, the orch left, its bound pid died, or it never bound in 2 min
 *   reap(code, {graceMs, waitMs}) -> 'cancelled' | 'stopped' | 'no-orch'   after the last member leaves:
 *       wait graceMs (a quick rejoin cancels); mark members.json orch.closing; append a to=orch status
 *       "room closed: complete task 1" (the orch's monitor wakes it); wait up to waitMs for task 1 to complete
 *       (or the list to be cleaned up); `claude stop <job>`; mark the orch left. Completing every visible task
 *       lets Claude Code clean up the list itself; we never delete anything under ~/.claude.
 *   reapDetached(code)          session-end.js: `node lib/orch.js reap CODE`, detached, output ignored
 *   taskListId(code) -> "sh-CODE", tasksDir(code) -> <claude config>/tasks/sh-CODE (read only)
 * Env: SUB_HUMAN_CLAUDE (the claude binary; tests use a stub), SUB_HUMAN_PLUGIN_DIR (force --plugin-dir; "" = none),
 *   SUB_HUMAN_ORCH_ARGS (a JSON array of extra flags, for probes, e.g. ["--setting-sources","project,local"]),
 *   SUB_HUMAN_REAP_GRACE_MS (default 10 s), SUB_HUMAN_REAP_WAIT_MS (default 20 s).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnChild, spawnSync } = require('node:child_process');
const identity = require('./identity.js');

const PLUGIN_ROOT = path.join(__dirname, '..');
const AGENT = 'sub-human:orchestrator';
const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'LANG', 'TMPDIR'];
const GRACE_MS = 10_000;
const WAIT_MS = 20_000;
const BIND_MS = 120_000;
const CLOSE_TEXT = 'room closed: complete task 1';

const claudeBin = () => process.env.SUB_HUMAN_CLAUDE || 'claude';
const taskListId = code => `sh-${code}`;
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const tasksDir = code => path.join(configDir(), 'tasks', taskListId(code));
const envMs = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 && process.env[k] !== '' ? n : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The parent's env reduced to the login basics (env -i plus these); USER/LOGNAME are needed to stay logged in. */
function cleanEnv(src = process.env) {
  const e = {};
  for (const k of KEEP_ENV) if (src[k]) e[k] = src[k];
  let user = '';
  try { user = os.userInfo().username; } catch { /* none */ }
  e.USER = e.USER || src.LOGNAME || user;
  e.LOGNAME = e.LOGNAME || e.USER;
  e.HOME = e.HOME || os.homedir();
  e.TERM = e.TERM || 'xterm-256color';
  for (const k of Object.keys(e)) if (!e[k]) delete e[k];
  return e;
}

/** --plugin-dir only when the plugin was loaded from a directory (an installed plugin loads by itself). */
function pluginDirFor(root = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT) {
  if (process.env.SUB_HUMAN_PLUGIN_DIR !== undefined) return process.env.SUB_HUMAN_PLUGIN_DIR || null;
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* as given */ }
  const installed = [path.join(configDir(), 'plugins'), path.join(os.homedir(), '.claude', 'plugins')]
    .some(d => real.startsWith(d + path.sep) || root.startsWith(d + path.sep));
  return installed ? null : root;
}

function spawnPlan({ code, cwd, home = identity.home(), pluginDir = pluginDirFor(), env = process.env } = {}) {
  identity.roomDir(code); // validates the code
  const settings = {
    env: {
      SUB_HUMAN_HOME: home,
      SUB_HUMAN_ROOM: code,
      CLAUDE_CODE_TASK_LIST_ID: taskListId(code),
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
    crossSessionInbound: 'accept',
  };
  const args = ['--bg', '-n', `orch.${code}`];
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  try { const x = JSON.parse(process.env.SUB_HUMAN_ORCH_ARGS || '[]'); if (Array.isArray(x)) args.push(...x.map(String)); } catch { /* ignored */ }
  args.push('--agent', AGENT, '--permission-mode', 'plan', '--settings', JSON.stringify(settings), '/sub-human');
  return { bin: claudeBin(), args, env: cleanEnv(env), cwd: cwd || process.cwd() };
}

const shq = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
/** The plan as one shell line (for `orch.js cmd` and debugging). */
function command(plan) {
  const env = Object.entries(plan.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  return `cd ${shq(plan.cwd)} && env -i ${env} ${shq(plan.bin)} ${plan.args.map(shq).join(' ')}`;
}

const JOB_RE = /backgrounded\s*·\s*([0-9a-z]{4,40})\b/i;

function spawn(opts = {}) {
  const plan = spawnPlan(opts);
  const r = spawnSync(plan.bin, plan.args, { cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = JOB_RE.exec(text);
  if (r.error || !m) {
    const why = r.error ? r.error.message : (text.split('\n').map(s => s.trim()).filter(Boolean).find(s => /trust|error|not /i.test(s)) || text.trim().split('\n')[0] || `exit ${r.status}`);
    return { ok: false, error: String(why).slice(0, 300) };
  }
  identity.setOrch(opts.code, { job: m[1], spawned_at: new Date().toISOString(), pid: null, left_at: undefined, closing: undefined, stopped_at: undefined });
  return { ok: true, job: m[1] };
}

function needsSpawn(code, now = Date.now()) {
  const o = identity.readMembers(code).orch;
  if (!o || o.left_at) return true;
  if (o.pid) return !identity.isAlive(o.pid);
  if (!o.job) return true;
  return now - Date.parse(o.spawned_at || 0) > BIND_MS;
}

/** Task 1 completed, or the list cleaned up (every visible task completed). Read only. */
function roomTaskDone(code) {
  const dir = tasksDir(code);
  if (!fs.existsSync(dir)) return true;
  const t = identity.readJson(path.join(dir, '1.json'));
  return !t || t.status === 'completed';
}

function stopJob(job) {
  if (!job) return false;
  const r = spawnSync(claudeBin(), ['stop', String(job)], { env: cleanEnv(), encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

async function reap(code, { graceMs = envMs('SUB_HUMAN_REAP_GRACE_MS', GRACE_MS), waitMs = envMs('SUB_HUMAN_REAP_WAIT_MS', WAIT_MS), pollMs = 500 } = {}) {
  if (!identity.roomExists(code)) return 'no-orch';
  await sleep(graceMs);
  if (identity.liveMembers(code).length) return 'cancelled';
  const o = identity.readMembers(code).orch;
  if (!o || (o.left_at && !o.job) || o.stopped_at || o.closing) return 'no-orch'; // closing: another reaper has it
  identity.setOrch(code, { closing: new Date().toISOString() });
  try {
    const room = require('./room.js');
    room.bind(code);
    room.append({ kind: 'status', text: CLOSE_TEXT, to: 'orch' }, { via: 'system', from: 'room', system: true });
  } catch { /* the stop below still ends it */ }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !roomTaskDone(code)) await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  stopJob(o.job);
  identity.setOrch(code, { stopped_at: new Date().toISOString() });
  try { identity.leave(code, 'orch'); } catch { /* already left */ }
  return 'stopped';
}

function reapDetached(code) {
  identity.roomDir(code);
  const env = { ...process.env, SUB_HUMAN_HOME: identity.home() };
  const p = spawnChild(process.execPath, [__filename, 'reap', code], { detached: true, stdio: 'ignore', env });
  p.unref();
  return p.pid;
}

module.exports = {
  AGENT, CLOSE_TEXT, KEEP_ENV, GRACE_MS, WAIT_MS,
  cleanEnv, pluginDirFor, spawnPlan, command, spawn, needsSpawn, reap, reapDetached, stopJob, roomTaskDone,
  taskListId, tasksDir,
};

if (require.main === module) {
  const [cmd, code] = process.argv.slice(2);
  const die = msg => { process.stderr.write(`orch.js: ${msg}\n`); process.exit(2); };
  if (!cmd || !identity.CODE_RE.test(String(code))) die('usage: node lib/orch.js cmd|spawn|reap CODE');
  if (cmd === 'cmd') process.stdout.write(command(spawnPlan({ code })) + '\n');
  else if (cmd === 'spawn') { const r = spawn({ code }); process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r.ok ? 0 : 1; }
  else if (cmd === 'reap') reap(code).then(r => process.stdout.write(r + '\n'), e => die(e.message));
  else die(`unknown command ${cmd}`);
}
