#!/usr/bin/env node
/**
 * plugin/sub-human/lib/room-claude.ts: the room's own Claude (member claude, SendMessage name claude.CODE), a headless
 * `claude --bg` session the join hook starts.
 * CommonJS, zero dependencies. Nobody launches it by hand; for debugging, `node lib/room-claude.ts cmd CODE` prints
 * the exact command and `node lib/room-claude.ts spawn CODE` runs it (both from the cwd the room's Claude should work in).
 *
 *   spawnPlan({code, cwd, home?, pluginDir?, env?}) -> {bin, args, env, cwd}
 *       env is what the `claude` client needs to run and reach the bg daemon: the login basics (HOME USER
 *       LOGNAME SHELL PATH TERM LANG TMPDIR) plus the keys the daemon keeps from a dispatch (cc.daemonEnv:
 *       CLAUDE_CONFIG_DIR, provider, model, endpoint and credential-file keys). Nothing else from the parent
 *       (no CLAUDE_PID / session id, no SUB_HUMAN_*): the daemon would drop it anyway. The room Claude's own env
 *       comes from the --settings launch flag: SUB_HUMAN_HOME, SUB_HUMAN_ROOM, CLAUDE_CODE_TASK_LIST_ID=sh-CODE,
 *       CLAUDE_CODE_ENABLE_TODO_TOOLS=1, the spawner's SUB_HUMAN_*_MS timing overrides (config.timingEnv), plus
 *       crossSessionInbound "accept". No --model: the room's Claude runs on the
 *       user's default model. cwd is the joiner's: --bg refuses an untrusted cwd (a fresh temp dir is never
 *       trusted). No file is written into ~/.claude: the room's Claude creates the "room CODE open" task.
 *
 * Host only (the host decides): claimSpawn, reapDetached and watchdog do nothing on a machine that
 * does not hold the room (identity.isHost false: null, null, 'not-host'), so the room's Claude runs only where it was spawned.
 *
 * Starting (one room Claude per room, even with concurrent joins):
 *   needsSpawn(code, now?) -> bool   no room Claude record, it left or was stopped, its bound pid is dead (pid + start
 *       time), a {job:"pending"} claim older than ROOM_CLAUDE_CLAIM_MS, no job, or a job that never bound in ROOM_CLAUDE_BIND_MS
 *   claimSpawn(code, {now, by}) -> {claim, prevJob}|null   under the members lock: when needsSpawn, write
 *       room Claude {job:"pending", claim, by, spawned_at}; a second joiner then sees the claim and starts nothing.
 *       prevJob is the old job id to stop first (a room Claude that never bound may still be running).
 *   startDetached({code, cwd, claim, prevJob}) -> pid   join.ts: `node lib/room-claude.ts start CODE JSON`, detached,
 *       so the hook returns at once; the helper runs spawn() below.
 *   spawn({code, cwd, claim?, prevJob?}) -> {ok, job?, error?}   stops prevJob (`claude stop`), runs the plan,
 *       finds the job in `claude agents --json` (name claude.CODE; cc.jobs), falling back to the id in the
 *       "backgrounded · <job>" line (cc.parseDispatch), and records room Claude {job, job_session}. With a claim it
 *       records only while the claim is still current and the room is not closing; otherwise it stops the job
 *       it just made. A failure records {job: null, spawn_error} so the next join retries and can say why.
 *
 * Stopping:
 *   reap(code, {graceMs, waitMs, claimed}) -> 'cancelled' | 'stopped' | 'no-claude'   after the last member leaves:
 *       wait graceMs (a quick rejoin cancels); claim members.json claude.closing under the lock (only one reaper
 *       wins); append a to=claude status "room closed: complete task 1" (the room Claude's tail child wakes it); wait up to
 *       waitMs for task 1 to complete (or the list to be cleaned up); `claude stop <job>`; mark the room's Claude left.
 *       claimed: the caller already set closing (watchdog): no grace, no claim. We never delete under ~/.claude.
 *   reapDetached(code, {claimed}?)   `node lib/room-claude.ts reap CODE [--claimed]`, detached, output ignored
 *   releaseDetached(code, job)   `node lib/room-claude.ts release CODE JOB`, detached: `claude stop JOB` and nothing else (a
 *       planned handoff, lib/handoff.ts: the room goes on, its room Claude restarts on the new host; the caller already
 *       marked the room's Claude record left, so no reaper, no "room closed")
 *   watchdog(code, {now, orphanMs, alive, reaper}) -> 'live'|'waiting'|'reaping'|'closing'|'no-claude'|'no-room'|'not-host'
 *       For the room Claude's tail loop (and join's sweep): when the room has had no live member (identity.seatAlive:
 *       pid alive and start time matching) for orphanMs (ROOM_CLAUDE_ORPHAN_MS), claim closing and start the reaper.
 *       Members that crashed leave no SessionEnd, so this is what closes their room. The orphan start is the
 *       latest left_at when every member left cleanly, else the first observation (stored as claude.orphan_since,
 *       cleared once a member is live again). Idempotent: once closing, it does nothing.
 *
 *   taskListId(code) -> "sh-CODE", tasksDir(code) -> <claude config>/tasks/sh-CODE (read only)
 * Env: SUB_HUMAN_CLAUDE (the claude binary; tests use a stub), SUB_HUMAN_PLUGIN_DIR (force --plugin-dir; "" = none),
 *   SUB_HUMAN_ROOM_CLAUDE_ARGS (a JSON array of extra flags, for probes, e.g. ["--setting-sources","project,local"]),
 *   SUB_HUMAN_REAP_GRACE_MS (default 10 s), SUB_HUMAN_REAP_WAIT_MS (default 20 s), SUB_HUMAN_ROOM_CLAUDE_CLAIM_MS,
 *   SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS.
 * CLI: node lib/room-claude.ts cmd|spawn|reap [--claimed]|watchdog|release|start CODE [JSON|JOB]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import * as identity from './identity.ts';
import * as room from './room.ts';
import { readJson } from './io.ts';
import * as config from './config.ts';
import * as clock from './clock.ts';
import * as cc from './cc.ts';
import type { MemberRec, Members, RoomClaudePatch } from './types-app.ts';

/** What spawnPlan builds a launch from. */
interface PlanOpts {
  code: string;
  cwd?: string;
  home?: string;
  pluginDir?: string | null;
  env?: NodeJS.ProcessEnv;
}
/** The `claude --bg` launch: binary, argv, env and cwd. */
interface Plan {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}
interface SpawnOpts extends PlanOpts {
  claim?: string | null;
  prevJob?: string | null;
}
type SpawnResult = { ok: true, job: string } | { ok: false, error: string };
/** A job as `claude agents --json` lists it (lib/cc.ts jobs), the fields read here. */
interface Job {
  id: string | null;
  kind: string | null;
  state: string | null;
  name: string | null;
  sessionId: string | null;
  startedAt?: number;
}
/** A seat check (identity.seatAlive). */
type Alive = (m: MemberRec) => boolean;
type ReapResult = 'cancelled' | 'stopped' | 'no-claude';
type WatchdogState = 'live' | 'waiting' | 'reaping' | 'closing' | 'no-claude' | 'no-room' | 'not-host';

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
const AGENT = 'sub-human:room-claude';
const LOGIN_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'LANG', 'TMPDIR'];
const CLOSE_TEXT = 'room closed: complete task 1';
const PENDING = 'pending';
const ENDED = new Set(['done', 'failed', 'stopped']);

const claudeBin = () => process.env.SUB_HUMAN_CLAUDE || 'claude';
const taskListId = (code: string) => `sh-${code}`;
const tasksDir = (code: string): string => cc.tasksDir(taskListId(code));
const iso = (ms: number) => new Date(ms).toISOString();
const claimMs = () => config.envMs('SUB_HUMAN_ROOM_CLAUDE_CLAIM_MS', config.ROOM_CLAUDE_CLAIM_MS);
const orphanMsDefault = () => config.envMs('SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS', config.ROOM_CLAUDE_ORPHAN_MS);

/** The login basics plus the daemon's dispatch allowlist; USER/LOGNAME are needed to stay logged in. */
function cleanEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of LOGIN_ENV) { const v = src[k]; if (v) e[k] = v; }
  Object.assign(e, cc.daemonEnv(src));
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
function pluginDirFor(root: string = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT): string | null {
  if (process.env.SUB_HUMAN_PLUGIN_DIR !== undefined) return process.env.SUB_HUMAN_PLUGIN_DIR || null;
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* as given */ }
  const installed = [path.join(cc.configDir(), 'plugins'), path.join(os.homedir(), '.claude', 'plugins')]
    .some(d => real.startsWith(d + path.sep) || root.startsWith(d + path.sep));
  return installed ? null : root;
}

function spawnPlan({ code, cwd, home = identity.home(), pluginDir = pluginDirFor(), env = process.env }: PlanOpts): Plan {
  identity.roomDir(code); // validates the code
  const settings = {
    env: {
      // the room creator's timing overrides reach the room Claude's tail child (its watchdog and settle) and its reaper
      ...config.timingEnv(env),
      SUB_HUMAN_HOME: home,
      SUB_HUMAN_ROOM: code,
      CLAUDE_CODE_TASK_LIST_ID: taskListId(code),
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
    crossSessionInbound: 'accept',
  };
  const args = ['--bg', '-n', `claude.${code}`];
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  try {
    const x = JSON.parse(process.env.SUB_HUMAN_ROOM_CLAUDE_ARGS || '[]');
    if (Array.isArray(x)) args.push(...x.map(String));
  } catch { /* ignored */ }
  args.push('--agent', AGENT, '--permission-mode', 'plan', '--settings', JSON.stringify(settings), '/sub-human');
  return { bin: claudeBin(), args, env: cleanEnv(env), cwd: cwd || process.cwd() };
}

const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
/** The plan as one shell line (for `room-claude.ts cmd` and debugging). */
function command(plan: Plan): string {
  const env = Object.entries(plan.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  return `cd ${shq(plan.cwd)} && env -i ${env} ${shq(plan.bin)} ${plan.args.map(shq).join(' ')}`;
}

// ---------- starting ----------

function needsSpawnRec(o: MemberRec | null | undefined, now: number = clock.now()): boolean {
  if (!o || o.left_at || o.stopped_at) return true;
  if (o.pid) return !identity.seatAlive(o); // bound (possibly before its starter recorded the job)
  // Date.parse(0) as before: String(0) parses as the year 2000
  if (o.job === PENDING) return now - Date.parse(o.spawned_at || '0') > claimMs();
  if (!o.job) return true;
  return now - Date.parse(o.spawned_at || '0') > config.ROOM_CLAUDE_BIND_MS;
}
const needsSpawn = (code: string, now: number = clock.now()): boolean => needsSpawnRec((identity.readMembers(code) as Members).claude, now);

/** A claim on the room's Claude's start: prevJob is the old job to stop first. */
interface Claim { claim: string, prevJob: string | null }
function claimSpawn(code: string, { now = clock.now(), by = null }: { now?: number, by?: string | null } = {}): Claim | null {
  if (!identity.isHost(code)) return null;
  let out: Claim | null = null;
  identity.updateRoomClaude(code, (o: MemberRec | null): RoomClaudePatch | null => {
    out = null; // fn may run again (a store that compares and sets): only the attempt that lands claims
    if (o && o.closing) return null;
    if (!needsSpawnRec(o, now)) return null;
    const claim = crypto.randomBytes(6).toString('hex');
    out = { claim, prevJob: o && o.job && o.job !== PENDING && !o.stopped_at ? o.job : null };
    return {
      job: PENDING, claim, by: by || undefined, spawned_at: iso(now),
      // seen_at goes too: an old job's fresh lease would otherwise hold the seat against the new one ("name taken")
      pid: null, pid_start: undefined, seen_at: undefined, left_at: undefined, closing: undefined, stopped_at: undefined,
      spawn_error: undefined, job_session: undefined, orphan_since: undefined,
    };
  });
  return out;
}

/** The job `claude agents --json` lists for this room (name claude.CODE, still running), else the parsed id. */
function findJob(code: string, { parsed = null, env = cleanEnv() }: { parsed?: string | null, env?: Record<string, string> } = {}): { id: string, sessionId?: string | null } | null {
  const list: Job[] | null = cc.jobs({ bin: claudeBin(), env, timeout: config.SPAWN_TIMEOUT_MS });
  const fallback = parsed ? { id: parsed, sessionId: null } : null;
  if (!list) return fallback;
  const name = `claude.${code}`;
  const mine = list.filter((j): j is Job & { id: string } => !!j.id && j.kind !== 'interactive' && !ENDED.has(j.state ?? '')
    && (j.name === name || (!!parsed && j.id === parsed)));
  const pick = mine.find(j => j.id === parsed) || mine.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  return pick ? { id: pick.id, sessionId: pick.sessionId } : fallback;
}

function stopJob(job: string | null | undefined): boolean {
  if (!job || job === PENDING) return false;
  const r = spawnSync(claudeBin(), cc.stopCmd(job), {
    env: cleanEnv(), encoding: 'utf8', timeout: config.SPAWN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

function spawn(opts: SpawnOpts): SpawnResult {
  const { code, claim = null, prevJob = null } = opts;
  const plan = spawnPlan(opts);
  if (prevJob) stopJob(prevJob); // a respawn never leaves the old job running beside the new one
  const r = spawnSync(plan.bin, plan.args, {
    cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: config.SPAWN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const parsed = cc.parseDispatch(text);
  const found = r.error || (r.status !== 0 && !parsed) ? null : findJob(code, { parsed, env: plan.env });
  const mine = (o: MemberRec | null) => !claim || (!!o && o.claim === claim);
  if (!found) {
    const said = text.split('\n').map(s => s.trim()).filter(Boolean).find(s => /trust|error|not /i.test(s));
    const why = r.error ? r.error.message : (said || text.trim().split('\n')[0] || `exit ${r.status}`);
    const error = String(why).slice(0, 300);
    try {
      identity.updateRoomClaude(code, (o: MemberRec | null): RoomClaudePatch | null => (mine(o) && !(o && o.closing) ? { job: null, claim: undefined, spawn_error: error } : null));
    } catch { /* room gone */ }
    return { ok: false, error };
  }
  let rec: MemberRec | null = null;
  try {
    rec = identity.updateRoomClaude(code, (o: MemberRec | null): RoomClaudePatch | null => {
      if (!mine(o) || (o && o.closing)) return null;
      const patch: RoomClaudePatch = { job: found.id, job_session: found.sessionId || undefined, claim: undefined, spawn_error: undefined };
      if (!claim) {
        Object.assign(patch, {
          spawned_at: iso(clock.now()), pid: null, pid_start: undefined, left_at: undefined, closing: undefined, stopped_at: undefined,
        });
      }
      return patch;
    });
  } catch { rec = null; }
  if (!rec) { stopJob(found.id); return { ok: false, error: 'superseded (the room closed or another start took over)' }; }
  return { ok: true, job: found.id };
}

function detached(args: string[], cwd?: string): number | undefined {
  const env = { ...process.env, SUB_HUMAN_HOME: identity.home() };
  let dir: string | undefined;
  try { dir = cwd && fs.statSync(cwd).isDirectory() ? cwd : undefined; } catch { dir = undefined; }
  const p = spawnChild(process.execPath, [import.meta.filename, ...args], { detached: true, stdio: 'ignore', env, cwd: dir });
  p.on('error', () => { /* the claim expires */ });
  p.unref();
  return p.pid;
}

function startDetached({ code, cwd, claim, prevJob = null }: { code: string, cwd?: string, claim?: string, prevJob?: string | null }): number | undefined {
  identity.roomDir(code);
  return detached(['start', code, JSON.stringify({ cwd: cwd || process.cwd(), claim, prevJob })], cwd);
}

// ---------- stopping ----------

/** Task 1 completed, or the list cleaned up (every visible task completed). Read only. */
function roomTaskDone(code: string): boolean {
  const dir = tasksDir(code);
  if (!fs.existsSync(dir)) return true;
  const t: { status?: unknown } | null = readJson(path.join(dir, '1.json'));
  return !t || t.status === 'completed';
}

const hasLiveMember = (members: Members, alive: Alive = identity.seatAlive): boolean =>
  Object.values(members).some(m => !!m && m.role !== 'claude' && alive(m));

/** Set claude.closing unless the room has a live member or is already closing / stopped. */
function claimClose(code: string, now: number = clock.now()): { rec: MemberRec } | { why: ReapResult } {
  let why: ReapResult = 'no-claude';
  const rec: MemberRec | null = identity.updateRoomClaude(code, (o: MemberRec | null, members: Members): RoomClaudePatch | null => {
    if (hasLiveMember(members)) { why = 'cancelled'; return null; }
    if (!o || (o.left_at && !o.job) || o.stopped_at || o.closing) return null; // closing: another reaper has it
    return { closing: iso(now) };
  });
  return rec ? { rec } : { why };
}

async function reap(code: string, {
  graceMs = config.envMs('SUB_HUMAN_REAP_GRACE_MS', config.REAP_GRACE_MS, { allowZero: true }),
  waitMs = config.envMs('SUB_HUMAN_REAP_WAIT_MS', config.REAP_WAIT_MS, { allowZero: true }),
  pollMs = config.REAP_POLL_MS,
  claimed = false,
}: { graceMs?: number, waitMs?: number, pollMs?: number, claimed?: boolean } = {}): Promise<ReapResult> {
  if (!identity.roomExists(code)) return 'no-claude';
  let o: MemberRec | undefined;
  if (claimed) {
    o = (identity.readMembers(code) as Members).claude;
    if (!o || !o.closing || o.stopped_at) return 'no-claude';
  } else {
    await clock.sleep(graceMs);
    const c = claimClose(code);
    if (!('rec' in c)) return c.why;
    o = c.rec;
  }
  try {
    room.open(code).append({ kind: 'status', text: CLOSE_TEXT, to: 'claude' }, { via: 'system', from: 'room', system: true });
  } catch { /* the stop below still ends it */ }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !roomTaskDone(code)) await clock.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  // A start in flight records its job after this; it sees closing and stops that job itself.
  let job = (identity.readMembers(code) as Members).claude?.job || o.job;
  if (job === PENDING && (identity.readMembers(code) as Members).claude?.pid) job = findJob(code)?.id; // bound, starter died
  stopJob(job);
  identity.setRoomClaude(code, { stopped_at: new Date().toISOString() });
  try { identity.leave(code, 'claude', {}); } catch { /* already left */ }
  return 'stopped';
}

function reapDetached(code: string, { claimed = false } = {}): number | null | undefined {
  identity.roomDir(code);
  if (!identity.isHost(code)) return null;
  return detached(claimed ? ['reap', code, '--claimed'] : ['reap', code]);
}

const JOB_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function releaseDetached(code: string, job: string): number | null | undefined {
  identity.roomDir(code);
  if (!JOB_RE.test(String(job))) return null;
  return detached(['release', code, String(job)]);
}

function watchdog(code: string, { now = clock.now(), orphanMs = orphanMsDefault(), alive = identity.seatAlive, reaper = reapDetached }: {
  now?: number, orphanMs?: number, alive?: Alive, reaper?: (code: string, opts: { claimed: boolean }) => unknown,
} = {}): WatchdogState {
  if (!identity.roomExists(code)) return 'no-room';
  if (!identity.isHost(code)) return 'not-host';
  let state = 'no-claude' as WatchdogState; // set inside the update callback, which narrowing does not follow
  identity.updateRoomClaude(code, (o: MemberRec | null, members: Members): RoomClaudePatch | null => {
    if (!o || o.stopped_at || (o.left_at && !o.job)) return null;
    if (o.closing) { state = 'closing'; return null; }
    const ms = Object.values(members).filter((m): m is MemberRec => !!m && !!m.name && m.role !== 'claude');
    if (ms.some(alive)) { state = 'live'; return o.orphan_since ? { orphan_since: undefined } : null; }
    // A member who joined after the stored observation makes it stale.
    const lastJoin = Math.max(0, ...ms.map(m => Date.parse(m.joined_at || '') || 0));
    let since = Date.parse(o.orphan_since || '');
    if (!Number.isFinite(since) || since < lastJoin) since = now;
    if (ms.length && ms.every(m => m.left_at)) since = Math.min(since, Math.max(...ms.map(m => Date.parse(m.left_at || '') || now)));
    if (now - since >= orphanMs) { state = 'reaping'; return { closing: iso(now), orphan_since: iso(since) }; }
    state = 'waiting';
    return o.orphan_since === iso(since) ? null : { orphan_since: iso(since) };
  });
  if (state === 'reaping') reaper(code, { claimed: true });
  return state;
}

export {
  CLOSE_TEXT, PENDING, pluginDirFor, spawnPlan, command, needsSpawn, claimSpawn, spawn, startDetached, reap,
  reapDetached, releaseDetached, watchdog, taskListId, tasksDir,
};

if (import.meta.main) {
  const [cmd, code, extra] = process.argv.slice(2);
  const die = (msg: string): never => { process.stderr.write(`room-claude.ts: ${msg}\n`); process.exit(2); };
  if (!cmd || !identity.CODE_RE.test(String(code))) die('usage: node lib/room-claude.ts cmd|spawn|reap [--claimed]|watchdog|release|start CODE [JSON|JOB]');
  if (cmd === 'cmd') process.stdout.write(command(spawnPlan({ code })) + '\n');
  else if (cmd === 'spawn') { const r = spawn({ code }); process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r.ok ? 0 : 1; }
  else if (cmd === 'start') {
    let o: { cwd?: string, claim?: string, prevJob?: string } = {};
    try { o = JSON.parse(extra || '{}') || {}; } catch { die('start: bad JSON'); }
    const r = spawn({ code, cwd: o.cwd, claim: o.claim || null, prevJob: o.prevJob || null });
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'reap') reap(code, { claimed: extra === '--claimed' }).then(r => process.stdout.write(r + '\n'), e => die(e.message));
  else if (cmd === 'watchdog') process.stdout.write(watchdog(code) + '\n');
  else if (cmd === 'release') process.stdout.write((JOB_RE.test(String(extra)) && stopJob(extra) ? 'stopped' : 'not-stopped') + '\n');
  else die(`unknown command ${cmd}`);
}
