// Tests for lib/room-claude.ts: the spawn argv and clean env, the job record, needsSpawn, and the reaper's steps
// and timing. `claude` is a stub (SUB_HUMAN_CLAUDE) that records each call; nothing real is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn as sp } from 'node:child_process';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as roomClaude from '../lib/room-claude.ts';
import * as cc from '../lib/cc/bg.ts';
import * as env from '../lib/env.ts';
import * as room from '../lib/room.ts';
import * as tasks from '../lib/tasks.ts';
import type { AgentJob } from '../lib/cc/bg.ts';
import { rc, sn } from './support/brands.ts';
import type { RoomCode } from '../lib/brand.ts';
import { must } from './support/must.ts';

/** One call the stub claude recorded. */
interface StubCall { argv: string[]; env: Record<string, string>; cwd: string }

/** A stub claude: appends {argv, env, cwd} to calls.jsonl; `--bg` prints the backgrounded line; `agents --json`
 * prints `agents` (a JSON array) when given, else nothing (cc.jobs() then fails and the parsed id is used);
 * `before`, when given, is what it prints until the first `--bg`, and for `late` more `agents` calls after it (a
 * daemon that lists a fresh job only after a moment). */
function stubClaude({ out = 'backgrounded · 0b500131 · claude.x', agents = null, before = null, late = 0 }:
  { out?: string; agents?: object[] | null; before?: object[] | null; late?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  const bg = path.join(dir, 'bg');
  // after --bg, the bg file counts the agents calls: `before` while fewer than `late` were made
  const after = `(() => { const f = require('fs'); if (!f.existsSync(${JSON.stringify(bg)})) return false; const n = f.readFileSync(${JSON.stringify(bg)}, 'utf8').length; f.appendFileSync(${JSON.stringify(bg)}, '.'); return n >= ${late}; })()`;
  fs.writeFileSync(bin, `#!${process.execPath}\n` +
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}) + '\\n');\n` +
    `if (process.argv.includes('--bg')) { require('fs').writeFileSync(${JSON.stringify(bg)}, ''); console.log(${JSON.stringify(out)}); }\n` +
    (agents ? `if (process.argv[2] === 'agents') console.log(${before ? `${after} ? ${JSON.stringify(JSON.stringify(agents))} : ${JSON.stringify(JSON.stringify(before))}` : JSON.stringify(JSON.stringify(agents))});\n` : ''));
  fs.chmodSync(bin, 0o755);
  const calls = (): StubCall[] => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as StubCall); } catch { return []; } };
  return { bin, calls, dir };
}

/** `claude agents` rows as a test lists them: only the fields it sets, the rest absent. */
const rows = (...js: Partial<AgentJob>[]) => js as AgentJob[];

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r: T;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r instanceof Promise) return r.finally(restore) as T;
  restore();
  return r;
}

test('room-claude: spawnPlan argv, --settings env, clean env (no member session keys from the parent), joiner cwd', () => {
  h.freshHome();
  const code = h.newRoom();
  const parent = { HOME: '/Users/a', USER: 'a', PATH: '/bin:/a b/c', TERM: 'xterm', CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', OTHER: 'x', LANG: 'C' };
  const p = withEnv({ SUB_HUMAN_PLUGIN_DIR: '/p/sub-human' }, () => roomClaude.spawnPlan({ code, cwd: '/work', env: parent }));
  assert.equal(p.cwd, '/work');
  assert.deepEqual(Object.keys(p.env).sort(), ['HOME', 'LANG', 'LOGNAME', 'OTHER', 'PATH', 'TERM', 'USER']);
  assert.ok(Object.keys(p.env).every(k => !k.startsWith('CLAUDE')), 'no CLAUDE_PID, session id or CLAUDECODE from the parent');
  assert.equal(p.env.LOGNAME, 'a');
  const a = p.args;
  assert.deepEqual(a.slice(0, 3), ['--bg', '-n', `claude.${code}`]);
  assert.deepEqual(a.slice(3, 5), ['--plugin-dir', '/p/sub-human']);
  assert.deepEqual(a.slice(5, 9), ['--agent', 'sub-human:room-claude', '--permission-mode', 'plan']);
  assert.equal(a[9], '--settings');
  assert.deepEqual(JSON.parse(must(a[10])), {
    env: { SUB_HUMAN_HOME: identity.home(), SUB_HUMAN_ROOM: code, CLAUDE_CODE_TASK_LIST_ID: `sh-${code}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    crossSessionInbound: 'refuse',
  });
  assert.equal(a.at(-1), '/sub-human');
  assert.ok(!a.includes('--model'), 'no model is prescribed: the room\'s Claude uses the user\'s default');
  assert.equal(withEnv({ SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawnPlan({ code, env: parent })).args.includes('--plugin-dir'), false);
  assert.match(roomClaude.command(p), /^cd \/work && env -i .*PATH='\/bin:\/a b\/c'.* --settings '\{"env":/);
  // @ts-expect-error: not a room code, refused at run time
  assert.throws(() => roomClaude.spawnPlan({ code: '../x' }), /invalid room code/);
});

test('room-claude: the spawner\'s SUB_HUMAN_*_MS overrides go through --settings env, so the room\'s Claude\'s watchdog honours them', () => {
  h.freshHome();
  const code = h.newRoom();
  const parent = { HOME: '/Users/a', USER: 'a', PATH: '/bin', SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS: '5000', SUB_HUMAN_REAP_GRACE_MS: '0',
    SUB_HUMAN_SETTLE_MS: 'soon', SUB_HUMAN_LEAVE_MS: '', SUB_HUMAN_PLUGIN_DIR: '/x', SUB_HUMAN_CLAUDE: '/bin/claude' };
  const p = withEnv({ SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawnPlan({ code, env: parent }));
  const { env } = JSON.parse(must(p.args[p.args.indexOf('--settings') + 1])) as { env: Record<string, string> };
  // numeric timing keys only: not a malformed or empty one, not the binary or plugin-dir knobs
  assert.deepEqual(Object.keys(env).filter(k => k.endsWith('_MS')).sort(), ['SUB_HUMAN_REAP_GRACE_MS', 'SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS']);
  assert.equal(env.SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS, '5000');
  assert.equal(env.SUB_HUMAN_REAP_GRACE_MS, '0');
  assert.equal(env.SUB_HUMAN_HOME, identity.home(), 'an override never replaces the room\'s own keys');
  assert.ok(!('SUB_HUMAN_CLAUDE' in env) && !('SUB_HUMAN_PLUGIN_DIR' in env));
  assert.ok(Object.keys(p.env).every(k => !k.startsWith('SUB_HUMAN')), 'the client env stays clean');
});

test('env: every override read through envMs matches the pattern the room\'s Claude forwards', () => {
  const root = path.join(h.LIB, '..');
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (!['test', 'node_modules'].includes(f.name)) walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(f.name) && f.name !== 'sub-human') continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/envMs\(\s*['"]([A-Z0-9_]+)['"]/g)) names.add(must(m[1]));
    }
  };
  walk(root);
  assert.ok(names.size >= 20, `found ${names.size}`);
  for (const n of names) assert.match(n, env.TIMING_ENV_RE, n);
});

test('room-claude: an installed plugin gets no --plugin-dir; a directory plugin does', () => {
  withEnv({ SUB_HUMAN_PLUGIN_DIR: undefined }, () => {
    assert.equal(roomClaude.pluginDirFor(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'm', 'sub-human', '1.0.0')), null);
    assert.equal(roomClaude.pluginDirFor('/tmp/dev/plugin/sub-human'), '/tmp/dev/plugin/sub-human');
  });
});

test('room-claude: spawn runs the stub, records members.json claude {job, spawned_at}; no file under ~/.claude', () => {
  h.freshHome();
  const code = h.newRoom();
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-'));
  const s = stubClaude({ out: `backgrounded · 0b500131 · claude.${code}` });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cwd-')));
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '', HOME: userHome, CLAUDE_PID: '77' }, () => roomClaude.spawn({ code, cwd }));
  assert.deepEqual(r, { ok: true, job: '0b500131' });
  const call = must(s.calls()[0]);
  assert.equal(call.cwd, cwd);
  assert.equal(call.env.CLAUDE_PID, undefined);
  assert.equal(call.argv[0], '--bg');
  const o = must(identity.readMembers(code).claude);
  assert.equal(o.job, '0b500131');
  assert.equal(o.pid, null);
  assert.ok(o.spawned_at);
  assert.equal(fs.existsSync(path.join(userHome, '.claude')), false, 'no sentinel file');
  assert.equal(roomClaude.needsSpawn(code), false, 'spawned, not yet bound');
  identity.join({ code, name: sn('claude'), role: 'claude', pid: process.pid, session_id: 'so' });
  assert.equal(roomClaude.needsSpawn(code), false);
  identity.leave(code, sn('claude'));
  assert.equal(roomClaude.needsSpawn(code), true, 'claude left');
  const bad = stubClaude({ out: 'Workspace not trusted. Run claude in /x once' });
  const r2 = withEnv({ SUB_HUMAN_CLAUDE: bad.bin }, () => roomClaude.spawn({ code, cwd }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /not trusted/);
});

test('room-claude: needsSpawn with no record, a dead bound pid, or a spawn that never bound', async () => {
  h.freshHome();
  const code = h.newRoom();
  assert.equal(roomClaude.needsSpawn(code), true);
  identity.updateRoomClaude(code, () => ({ job: 'j1', spawned_at: new Date(Date.now() - 5 * 60_000).toISOString() }));
  assert.equal(roomClaude.needsSpawn(code), true, 'never bound in 2 min');
  const dead = await h.deadPid();
  identity.updateRoomClaude(code, () => ({ pid: dead }));
  assert.equal(roomClaude.needsSpawn(code), true, 'bound pid died');
});

test('room-claude: reap waits the grace, marks closing, completes the room task itself (no model), then stops the job', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const list = path.join(cfg, 'tasks', `sh-${code}`);
  const s = stubClaude();
  const o = h.spawnSleeper();
  identity.updateRoomClaude(code, () => ({ job: 'cafe1234' }));
  identity.join({ code, name: sn('claude'), role: 'claude', pid: o.pid, session_id: 'so' });
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg, SUB_HUMAN_REAP_STOP_MS: '100' }, async () => {
    roomClaude.openTaskList(code);
    tasks.openRoomTask(room.open(code).store);
    assert.equal(must(identity.readMembers(code).claude).tasks_dir, list, 'the room session\'s list, recorded');
    const file = () => JSON.parse(fs.readFileSync(path.join(list, '1.json'), 'utf8')) as { status: string; owner: string };
    assert.deepEqual([file().status, file().owner], ['in_progress', 'room'], 'the room task, written before the session starts');
    const p = roomClaude.reap(code, { graceMs: 150 });
    await h.sleep(60);
    assert.equal(identity.roomClosing(code), false, 'not closing during the grace');
    assert.equal(await p, 'stopped');
    const R = room.open(code);
    const done = must(R.readAll().find(e => e.kind === 'task' && e.status === 'completed'));
    assert.deepEqual([done.from, done.via, done.owner], ['room', 'system', 'room'], 'the reaper\'s own entry');
    assert.equal(file().status, 'completed');
    assert.ok(!R.readAll().some(e => e.kind === 'status' && e.to === 'claude'), 'nothing asked of a model');
    assert.deepEqual(s.calls().map(c => c.argv), [['stop', 'cafe1234'], ['agents', '--json', '--all']], 'then looks for strays');
    assert.equal(must(s.calls()[0]).env.CLAUDE_PID, undefined, 'clean env for stop');
    assert.equal(must(s.calls()[0]).env.CLAUDE_CONFIG_DIR, cfg, 'stop reaches the same daemon (CLAUDE_CONFIG_DIR is passed)');
    const rec = must(identity.readMembers(code).claude);
    assert.ok(rec.left_at && rec.stopped_at && rec.closing);
    // item 16: the stub's `claude stop` left the room Claude's process up (as the daemon did live): the reaper ended it
    assert.equal(identity.isAlive(o.pid), false, 'the bound process is gone before stopped_at is written');
    assert.ok(fs.existsSync(list), 'never deletes the task list');
    // stage 8e I.1: closed for good, it is off the open-rooms index at once (no look at the open rooms needed)
    const idx = (JSON.parse(fs.readFileSync(path.join(identity.home(), 'open-rooms.json'), 'utf8')) as { rooms: Record<string, unknown> }).rooms;
    assert.equal(idx[code], undefined, JSON.stringify(idx));
    assert.deepEqual(identity.openRooms(), []);
  });
  o.kill();
});

test('room-claude: a rejoin in the grace cancels; a second reaper backs off', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const s = stubClaude();
  identity.updateRoomClaude(code, () => ({ job: 'beef0001' }));
  const alice = h.spawnSleeper();
  identity.join({ code, name: sn('alice'), role: 'member', pid: alice.pid, session_id: 'sa' });
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg }, async () => {
    assert.equal(await roomClaude.reap(code, { graceMs: 20 }), 'cancelled', 'a live member');
    assert.equal(identity.roomClosing(code), false);
    identity.leave(code, sn('alice'));
    const [a, b] = await Promise.all([roomClaude.reap(code, { graceMs: 20 }), roomClaude.reap(code, { graceMs: 120 })]);
    assert.deepEqual([a, b], ['stopped', 'no-claude']);
    assert.deepEqual(s.calls().map(c => c.argv).filter(a => a[0] === 'stop'), [['stop', 'beef0001']]);
  });
  alice.kill();
});

test('room-claude: the CLI prints the manual command and refuses a bad code', () => {
  h.freshHome();
  const code = h.newRoom();
  const r = spawnSync(process.execPath, [path.join(h.LIB, 'room-claude.ts'), 'cmd', code], { env: h.childEnv({ SUB_HUMAN_PLUGIN_DIR: '' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`env -i .* claude --bg -n claude\\.${code} --agent sub-human:room-claude --permission-mode plan --settings `));
  const bad = spawnSync(process.execPath, [path.join(h.LIB, 'room-claude.ts'), 'reap', '../x'], { env: h.childEnv(), encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// ---------- spawn env, claim, job lookup, respawn, watchdog ----------

test('room-claude: the spawn env is the spawner\'s minus the member session\'s keys (cc.CLIENT_ENV_DENY) and SUB_HUMAN_*', () => {
  h.freshHome();
  const code = h.newRoom();
  const parent: Record<string, string> = {
    HOME: '/Users/a', USER: 'a', PATH: '/bin', TERM: 'xterm', SHELL: '/bin/zsh', TMPDIR: '/t', LANG: 'C',
    CLAUDE_CONFIG_DIR: '/cfg', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'p', ANTHROPIC_MODEL: 'm',
    CLAUDE_CODE_DISABLE_PROACTIVITY: '1', CLAUDE_CODE_SOME_FUTURE_KEY: '1', // a key a later release adds to its allowlist: no list to keep
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '', // an env-level login: kept though empty
    CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', CLAUDE_CODE_TASK_LIST_ID: 'x', SUB_HUMAN_HOME: '/h',
    CLAUDE_CODE_MESSAGING_SOCKET: '/sock', TMUX: '/tmux',
  };
  const env = roomClaude.spawnPlan({ code, env: parent }).env;
  for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_PROACTIVITY',
    'CLAUDE_CODE_SOME_FUTURE_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'SHELL', 'TMPDIR']) assert.equal(env[k], parent[k], k);
  for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_TASK_LIST_ID', 'SUB_HUMAN_HOME', 'CLAUDE_CODE_MESSAGING_SOCKET', 'TMUX']) assert.equal(env[k], undefined, k);
  for (const k of Object.keys(env)) assert.ok(!cc.CLIENT_ENV_DENY.includes(k) && !k.startsWith('SUB_HUMAN_'), k);
});

test('room-claude: claimSpawn: one claim wins, the second sees it; a stale pending claim expires; closing rooms are not claimed', () => {
  h.freshHome();
  const code = h.newRoom();
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  const a = roomClaude.claimSpawn(code, { now: t0, by: 'alice' });
  assert.ok(a && a.claim, 'first claim');
  assert.equal(a.prevJob, null);
  assert.equal(roomClaude.claimSpawn(code, { now: t0 + 1000, by: 'bob' }), null, 'second join sees the claim');
  const o = must(identity.readMembers(code).claude);
  assert.deepEqual([o.job, o.by, o.claim], ['pending', 'alice', a.claim]);
  assert.equal(roomClaude.needsSpawn(code, t0 + 1000), false);
  const later = t0 + 91_000;
  assert.equal(roomClaude.needsSpawn(code, later), true, 'pending claim older than ROOM_CLAUDE_CLAIM_MS');
  const b = roomClaude.claimSpawn(code, { now: later, by: 'bob' });
  assert.ok(b && b.claim && b.claim !== a.claim);
  assert.equal(b.prevJob, null, 'a pending claim has no job to stop');
  identity.updateRoomClaude(code, () => ({ closing: new Date(later).toISOString() }));
  assert.equal(roomClaude.claimSpawn(code, { now: later + 200_000 }), null, 'closing');
});

test('room-claude: concurrent claims from separate processes: exactly one wins', async () => {
  h.freshHome();
  const code = h.newRoom();
  const src = `const o=require(${JSON.stringify(path.join(h.LIB, 'room-claude.ts'))});process.stdout.write(JSON.stringify(o.claimSpawn(process.argv[1],{by:process.argv[2]})))`;
  const run = (by: string) => new Promise(res => { let out = ''; const p = sp(process.execPath, ['-e', src, code, by], { env: h.childEnv({ SUB_HUMAN_HOME: identity.home() }) }); p.stdout.on('data', d => { out += d; }); p.on('close', () => res(JSON.parse(out || 'null'))); });
  const rs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(run));
  assert.equal(rs.filter(Boolean).length, 1, JSON.stringify(rs));
});

test('room-claude: spawn with a claim stops the previous job first, finds the job in `claude agents --json`, records it', () => {
  h.freshHome();
  const code = h.newRoom();
  const agents = [
    { id: 'aaaa0000', kind: 'background', name: `claude.${code}`, state: 'stopped', startedAt: 1, sessionId: 'old' },
    { id: 'bbbb1111', kind: 'background', name: `claude.${code}`, state: 'working', startedAt: 2, sessionId: 'bbbb1111-full' },
    { pid: 5, kind: 'interactive', name: `claude.${code}`, sessionId: 'i' },
  ];
  // before the launch: the old job and a stray the record lost (done, its process alive); bbbb1111 comes with --bg
  const before = [
    { id: 'dead0001', kind: 'background', name: `claude.${code}`, state: 'working', startedAt: 0 },
    { id: 'cccc2222', pid: 7, kind: 'background', name: `claude.${code}`, state: 'done', status: 'idle', startedAt: 0 },
    { id: 'eeee3333', kind: 'background', name: `claude.${code}`, state: 'failed', startedAt: 0 },
    { id: 'ffff4444', pid: 8, kind: 'background', name: 'claude.other-0000', state: 'working', startedAt: 0 },
  ];
  const s = stubClaude({ out: 'something else entirely', agents, before });
  // a room Claude that was spawned long ago and never bound: needs a respawn, and its job must be stopped
  identity.updateRoomClaude(code, () => ({ job: 'dead0001', spawned_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  const c = roomClaude.claimSpawn(code, { by: 'alice' });
  assert.ok(c);
  assert.equal(c.prevJob, 'dead0001');
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.deepEqual(r, { ok: true, job: 'bbbb1111' }, 'no backgrounded line: the job comes from agents --json');
  const argv = s.calls().map(x => x.argv[0]);
  assert.deepEqual(argv, ['stop', 'agents', 'stop', '--bg', 'agents'], 'stop the old job and the stray before the respawn');
  assert.deepEqual(must(s.calls()[0]).argv, ['stop', 'dead0001']);
  assert.deepEqual(must(s.calls()[2]).argv, ['stop', 'cccc2222'], 'the live stray only: not prevJob again, an ended job or another room');
  const o = must(identity.readMembers(code).claude);
  assert.deepEqual([o.job, o.job_session, o.claim, o.by], ['bbbb1111', 'bbbb1111-full', undefined, 'alice']);
});

test('room-claude: the job comes from `claude agents --json` by its name, asked again while the daemon registers it; the dispatch line is a hint', () => {
  h.freshHome();
  const code = h.newRoom();
  const agents = [{ id: 'abcd0001', kind: 'background', name: `claude.${code}`, state: 'working', startedAt: 5, sessionId: 'abcd0001-full' }];
  // listed only on the third look; no dispatch line at all
  const s = stubClaude({ out: '', agents, before: [], late: 2 });
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir() }));
  assert.deepEqual(r, { ok: true, job: 'abcd0001' });
  assert.deepEqual(s.calls().map(x => x.argv[0]), ['--bg', 'agents', 'agents', 'agents']);
  assert.equal(must(identity.readMembers(code).claude).job_session, 'abcd0001-full');
  // a dispatch line naming another id than the one listed: the listed job by its name wins
  const s2 = stubClaude({ out: `backgrounded · ffff9999 · claude.${code}`, agents });
  assert.deepEqual(withEnv({ SUB_HUMAN_CLAUDE: s2.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir() })), { ok: true, job: 'abcd0001' });
  // never listed and no dispatch line: no job, after a bounded number of looks
  const s3 = stubClaude({ out: 'started', agents: [], before: [] });
  const r3 = withEnv({ SUB_HUMAN_CLAUDE: s3.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir() }));
  assert.equal(r3.ok, false);
  assert.equal(s3.calls().filter(x => x.argv[0] === 'agents').length, 4);
});

test('room-claude: a superseded claim stops the job it made; a failed start records spawn_error and clears the claim', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = stubClaude({ out: `backgrounded · 0b500131 · claude.${code}` });
  const c = roomClaude.claimSpawn(code, {});
  identity.updateRoomClaude(code, () => ({ claim: 'someone-else' }));
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.equal(r.ok, false);
  assert.deepEqual(s.calls().map(x => x.argv).filter(a => a[0] === 'stop'), [['stop', '0b500131']]);
  const bad = stubClaude({ out: 'Workspace not trusted' });
  identity.updateRoomClaude(code, () => ({ job: 'pending', claim: 'k2', spawned_at: new Date().toISOString() }));
  const r2 = withEnv({ SUB_HUMAN_CLAUDE: bad.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir(), claim: 'k2' }));
  assert.equal(r2.ok, false);
  const o = must(identity.readMembers(code).claude);
  assert.equal(o.job, null);
  assert.equal(o.claim, undefined);
  assert.match(must(o.spawn_error), /not trusted/);
  assert.equal(roomClaude.needsSpawn(code), true, 'the next join retries');
});

test('room-claude: watchStart: a job the bg daemon failed records spawn_error, clears the job, tells the room once', async () => {
  h.freshHome();
  const code = h.newRoom();
  const notices = () => room.open(code).readAll().filter(e => e.kind === 'status' && /did not start/.test(e.text || ''));
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', spawned_at: new Date().toISOString() }));
  let n = 0;
  const jobs = () => rows({ id: 'cafe0001', state: ++n < 3 ? 'working' : 'failed' });
  const stopped: string[] = [];
  assert.equal(await roomClaude.watchStart(code, 'cafe0001', { pollMs: 5, bindMs: 5000, jobs, stop: j => stopped.push(j) }), 'failed');
  assert.deepEqual(stopped, ['cafe0001']);
  const o = must(identity.readMembers(code).claude);
  assert.equal(o.job, null);
  assert.equal(o.spawn_error, 'job cafe0001 failed');
  assert.equal(notices().length, 1);
  const e = must(notices()[0]);
  assert.deepEqual([e.via, e.to], ['system', 'room'], 'to everyone');
  assert.match(must(e.text), /^the room's Claude did not start: job cafe0001 failed\. Run \/sub-human doctor; \/sub-human in the room starts it again$/);
  assert.equal(roomClaude.needsSpawn(code), true, 'the next join retries');
});

test('room-claude: watchStart: a job done without binding (its process alive) is stopped, cleared and named as such', async () => {
  h.freshHome();
  const code = h.newRoom();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0009', spawned_at: new Date().toISOString() }));
  const stopped: string[] = [];
  const jobs = () => rows({ id: 'cafe0009', pid: 4242, state: 'done', status: 'idle' });
  assert.equal(await roomClaude.watchStart(code, 'cafe0009', { pollMs: 5, bindMs: 5000, jobs, stop: j => stopped.push(j) }), 'failed');
  assert.deepEqual(stopped, ['cafe0009'], 'stopped before the record forgets it');
  const o = must(identity.readMembers(code).claude);
  assert.deepEqual([o.job, o.spawn_error], [null, 'job cafe0009 ended without taking its seat']);
  const e = room.open(code).readAll().filter(x => x.kind === 'status' && /did not start/.test(x.text || ''));
  assert.equal(e.length, 1);
  assert.match(must(e[0]?.text), /^the room's Claude did not start: job cafe0009 ended without taking its seat\. Run \/sub-human doctor/);
  // a bound room Claude idling between turns also lists as done: it is never stopped
  identity.updateRoomClaude(code, () => ({ job: 'cafe0010', spawned_at: new Date().toISOString() }));
  identity.join({ code, name: sn('claude'), role: 'claude', pid: process.pid, session_id: 'so' });
  assert.equal(await roomClaude.watchStart(code, 'cafe0010', { pollMs: 5, bindMs: 50, jobs: () => rows({ id: 'cafe0010', state: 'done' }), stop: j => stopped.push(j) }), 'bound');
  assert.deepEqual(stopped, ['cafe0009']);
});

test('room-claude: stopStrays stops every live claude.CODE job but the kept ones', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = stubClaude();
  const list = rows(
    { id: 'aaaa0001', pid: 1, kind: 'background', name: `claude.${code}`, state: 'done', status: 'idle' },
    { id: 'aaaa0002', kind: 'background', name: `claude.${code}`, state: 'blocked' },
    { id: 'aaaa0003', kind: 'background', name: `claude.${code}`, state: 'stopped' },
    { id: 'aaaa0004', pid: 2, kind: 'background', name: `claude.${code}`, state: 'working' },
    { id: 'aaaa0005', pid: 3, kind: 'interactive', name: `claude.${code}` },
    { id: 'aaaa0006', pid: 4, kind: 'background', name: 'claude.other-0001', state: 'working' },
  );
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin }, () => roomClaude.stopStrays(code, ['aaaa0004'], list));
  assert.deepEqual(r, ['aaaa0001', 'aaaa0002']);
  assert.deepEqual(s.calls().map(c => c.argv), [['stop', 'aaaa0001'], ['stop', 'aaaa0002']]);
  assert.deepEqual(withEnv({ SUB_HUMAN_CLAUDE: s.bin }, () => roomClaude.stopStrays(code, [], null)), [], 'no listing: nothing');
});

test('room-claude: watchStart: no seat by the bind deadline records spawn_error, keeps the job (the next claim stops it)', async () => {
  h.freshHome();
  const code = h.newRoom();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0002', spawned_at: new Date().toISOString() }));
  const r = await roomClaude.watchStart(code, 'cafe0002', { pollMs: 5, bindMs: 50, jobs: () => rows({ id: 'cafe0002', state: 'working' }) });
  assert.equal(r, 'timeout');
  const o = must(identity.readMembers(code).claude);
  assert.equal(o.job, 'cafe0002');
  assert.equal(o.spawn_error, 'did not take its seat in 0 s (job cafe0002: working)');
  assert.equal(room.open(code).readAll().filter(e => e.kind === 'status' && /did not start/.test(e.text || '')).length, 1);
  assert.equal(roomClaude.needsSpawn(code, Date.now() + 120_001), true);
  assert.equal(must(roomClaude.claimSpawn(code, { now: Date.now() + 120_001 })).prevJob, 'cafe0002', 'stopped as prevJob');
});

test('room-claude: watchStart stays quiet when the room\'s Claude binds, the start is superseded, or the room closes', async () => {
  h.freshHome();
  const code = h.newRoom();
  const notices = () => room.open(code).readAll().filter(e => e.kind === 'status' && /did not start/.test(e.text || ''));
  const jobs = () => rows({ id: 'cafe0003', state: 'working' });
  identity.updateRoomClaude(code, () => ({ job: 'cafe0003', spawned_at: new Date().toISOString() }));
  const bound = roomClaude.watchStart(code, 'cafe0003', { pollMs: 5, bindMs: 2000, jobs });
  await h.sleep(30);
  identity.join({ code, name: sn('claude'), role: 'claude', pid: process.pid, session_id: 'so' });
  assert.equal(await bound, 'bound');
  identity.updateRoomClaude(code, () => ({ job: 'cafe0004', pid: null, spawned_at: new Date().toISOString() }));
  const superseded = roomClaude.watchStart(code, 'cafe0004', { pollMs: 5, bindMs: 2000, jobs });
  await h.sleep(30);
  identity.updateRoomClaude(code, () => ({ job: 'cafe0005' }));
  assert.equal(await superseded, 'gone');
  identity.updateRoomClaude(code, () => ({ closing: new Date().toISOString() }));
  assert.equal(await roomClaude.watchStart(code, 'cafe0005', { pollMs: 5, bindMs: 50, jobs: () => rows({ id: 'cafe0005', state: 'failed' }) }), 'gone');
  assert.equal(notices().length, 0);
  assert.equal(must(identity.readMembers(code).claude).spawn_error, undefined);
});

test('room-claude: a claim after a just-stopped job (dead pid, fresh lease) lets the new job take the seat', async () => {
  h.freshHome();
  const code = h.newRoom();
  // the previous job stopped seconds ago: its pid is dead, its seen_at still inside the seat lease
  const dead = await h.deadPid();
  identity.updateRoomClaude(code, () => ({ job: 'old', pid: dead, seen_at: new Date().toISOString() }));
  assert.equal(roomClaude.needsSpawn(code), true);
  assert.ok(roomClaude.claimSpawn(code, {}));
  const r = identity.join({ code, name: sn('claude'), role: 'claude', pid: process.pid, session_id: 'new' });
  assert.ok(r && r.ok !== false, `the new job binds (${r && r.error})`);
  assert.equal(must(identity.readMembers(code).claude).pid, process.pid);
});

test('room-claude: the room\'s Claude binding before its starter records the job keeps the claim; the record then lands', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = stubClaude({ out: `backgrounded · 0b500131 · claude.${code}` });
  const c = roomClaude.claimSpawn(code, {});
  identity.join({ code, name: sn('claude'), role: 'claude', pid: process.pid, session_id: 'so' });
  assert.equal(roomClaude.needsSpawn(code), false, 'bound');
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => roomClaude.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.deepEqual(r, { ok: true, job: '0b500131' });
  const o = must(identity.readMembers(code).claude);
  assert.deepEqual([o.pid, o.job], [process.pid, '0b500131']);
});

test('room-claude: watchdog with an injected clock and liveness: live, waiting, then reaping once (idempotent)', () => {
  h.freshHome();
  const code = h.newRoom();
  const o = h.spawnSleeper();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001' }));
  identity.join({ code, name: sn('claude'), role: 'claude', pid: o.pid });
  identity.join({ code, name: sn('alice'), role: 'member', pid: process.pid });
  const reaped: [string, { claimed: boolean }][] = [];
  const reaper = (c: string, opts: { claimed: boolean }) => reaped.push([c, opts]);
  let up = true;
  const alive = () => up;
  const t0 = Date.now() + 1000; // after the joins (a join newer than the observation restarts it)
  assert.equal(roomClaude.watchdog(code, { now: t0, alive, reaper }), 'live');
  up = false;
  assert.equal(roomClaude.watchdog(code, { now: t0 + 1000, alive, reaper }), 'waiting');
  assert.equal(must(identity.readMembers(code).claude).orphan_since, new Date(t0 + 1000).toISOString());
  assert.equal(roomClaude.watchdog(code, { now: t0 + 30_000, alive, reaper }), 'waiting');
  up = true;
  assert.equal(roomClaude.watchdog(code, { now: t0 + 40_000, alive, reaper }), 'live', 'a member came back');
  assert.equal(must(identity.readMembers(code).claude).orphan_since, undefined);
  up = false;
  assert.equal(roomClaude.watchdog(code, { now: t0 + 50_000, alive, reaper }), 'waiting', 'the clock restarts');
  assert.equal(roomClaude.watchdog(code, { now: t0 + 109_000, alive, reaper }), 'waiting');
  assert.deepEqual(reaped, []);
  assert.equal(roomClaude.watchdog(code, { now: t0 + 110_000, alive, reaper }), 'reaping');
  assert.deepEqual(reaped, [[code, { claimed: true }]]);
  assert.ok(identity.roomClosing(code));
  assert.equal(roomClaude.watchdog(code, { now: t0 + 200_000, alive, reaper }), 'closing');
  assert.equal(reaped.length, 1, 'idempotent');
  o.kill();
});

test('room-claude: watchdog: members who all left cleanly count from their latest left_at', () => {
  h.freshHome();
  const code = h.newRoom();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0002' }));
  identity.join({ code, name: sn('alice'), role: 'member', pid: process.pid });
  identity.leave(code, sn('alice'));
  const left = Date.parse(must(identity.readMembers(code).alice?.left_at));
  const reaped: string[] = [];
  assert.equal(roomClaude.watchdog(code, { now: left + 59_000, reaper: c => reaped.push(c) }), 'waiting');
  assert.equal(roomClaude.watchdog(code, { now: left + 60_000, reaper: c => reaped.push(c) }), 'reaping');
  assert.deepEqual(reaped, [code]);
  assert.equal(roomClaude.watchdog(rc('nope-0000')), 'no-room');
});

test('room-claude: crash-all-members (SIGKILL) -> the watchdog reaps the room\'s Claude (real detached reaper, stub claude)', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const s = stubClaude();
  const o = h.spawnSleeper();
  const a = h.spawnSleeper();
  const b = h.spawnSleeper();
  identity.updateRoomClaude(code, () => ({ job: 'dead00ff' }));
  identity.join({ code, name: sn('claude'), role: 'claude', pid: o.pid });
  identity.join({ code, name: sn('alice'), role: 'member', pid: a.pid });
  identity.join({ code, name: sn('bob'), role: 'member', pid: b.pid });
  a.kill('SIGKILL'); b.kill('SIGKILL');
  await h.until(() => !identity.isAlive(a.pid) && !identity.isAlive(b.pid), 3000);
  assert.deepEqual(identity.liveMembers(code), []);
  assert.deepEqual(identity.openRooms(), [], 'claude-only room is not open');
  assert.deepEqual(identity.orphanRooms(), [code]);
  const t0 = Date.now();
  // The real detached reaper (reapDetached), whose pid is kept so the test waits for it to exit: a fixed 5 s
  // deadline on its result failed when two node starts (reaper, stub claude) took longer under load.
  let reaperPid: number | null | undefined = null;
  const reaper = (c: RoomCode, o: { claimed: boolean }) => { reaperPid = roomClaude.reapDetached(c, o); };
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg }, async () => {
    assert.equal(roomClaude.watchdog(code, { now: t0, reaper }), 'waiting', 'no SessionEnd ran: the first observation starts the clock');
    assert.equal(roomClaude.watchdog(code, { now: t0 + 60_000, reaper }), 'reaping');
    assert.ok(reaperPid, 'the reaper was started');
    assert.ok(await h.until(() => !identity.isAlive(must(reaperPid)), 120_000), 'the reaper exited');
    assert.ok(must(identity.readMembers(code).claude).stopped_at, 'reaper finished');
  });
  assert.deepEqual(s.calls().map(c => c.argv).filter(a => a[0] === 'stop'), [['stop', 'dead00ff']]);
  const rec = must(identity.readMembers(code).claude);
  assert.ok(rec.closing && rec.left_at);
  assert.deepEqual(identity.orphanRooms(), []);
  o.kill();
});

test('room-claude: a room whose room Claude never started (spawn_error, no job) and whose members all crashed is swept and closed', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const s = stubClaude();
  const a = h.spawnSleeper();
  identity.join({ code, name: sn('alice'), role: 'member', pid: a.pid });
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg }, async () => {
    roomClaude.openTaskList(code);
    tasks.openRoomTask(room.open(code).store);
    // the hard failure spawn records: no job, why
    identity.updateRoomClaude(code, () => ({ job: null, spawn_error: 'Workspace not trusted' }));
    assert.deepEqual(identity.orphanRooms(), [], 'alice is live');
    a.kill('SIGKILL');
    await h.until(() => !identity.isAlive(a.pid), 3000);
    assert.deepEqual(identity.orphanRooms(), [code], 'stranded: swept like any orphan');
    const reaped: RoomCode[] = [];
    const t0 = Date.now();
    assert.equal(roomClaude.watchdog(code, { now: t0, reaper: c => reaped.push(c) }), 'waiting');
    assert.equal(roomClaude.watchdog(code, { now: t0 + 60_000, reaper: c => reaped.push(c) }), 'reaping');
    assert.deepEqual(reaped, [code]);
    assert.equal(await roomClaude.reap(code, { claimed: true }), 'stopped', 'the reaper copes with no job');
  });
  const rec = must(identity.readMembers(code).claude);
  assert.ok(rec.stopped_at && rec.left_at);
  assert.ok(!s.calls().some(c => c.argv[0] === 'stop'), 'no job to stop');
  assert.ok(room.open(code).readAll().some(e => e.kind === 'task' && e.status === 'completed'), 'the room task completed');
  assert.deepEqual(identity.orphanRooms(), []);
});

test('room-claude: the watchdog CLI entry prints its state', () => {
  h.freshHome();
  const code = h.newRoom();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0003' }));
  identity.join({ code, name: sn('alice'), role: 'member', pid: process.pid });
  const r = spawnSync(process.execPath, [path.join(h.LIB, 'room-claude.ts'), 'watchdog', code], { env: h.childEnv({ SUB_HUMAN_HOME: identity.home() }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'live');
});
