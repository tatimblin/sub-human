'use strict';
// Tests for lib/orch.js: the spawn argv and clean env, the job record, needsSpawn, and the reaper's steps
// and timing. `claude` is a stub (SUB_HUMAN_CLAUDE) that records each call; nothing real is launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers.js');
const identity = require(path.join(h.LIB, 'identity.js'));
const orch = require(path.join(h.LIB, 'orch.js'));

/** A stub claude: appends {argv, env, cwd} to calls.jsonl; `--bg` prints the backgrounded line; `agents --json`
 * prints `agents` (a JSON array) when given, else nothing (cc.jobs() then fails and the parsed id is used). */
function stubClaude({ out = 'backgrounded · 0b500131 · orch.x', agents = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n` +
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}) + '\\n');\n` +
    `if (process.argv.includes('--bg')) console.log(${JSON.stringify(out)});\n` +
    (agents ? `if (process.argv[2] === 'agents') console.log(${JSON.stringify(JSON.stringify(agents))});\n` : ''));
  fs.chmodSync(bin, 0o755);
  const calls = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { bin, calls, dir };
}

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}

test('orch: spawnPlan argv, --settings env, clean env (no CLAUDE_* from the parent), joiner cwd', () => {
  h.freshHome();
  const code = h.newRoom();
  const parent = { HOME: '/Users/a', USER: 'a', PATH: '/bin:/a b/c', TERM: 'xterm', CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', SECRET: 'x', LANG: 'C' };
  const p = withEnv({ SUB_HUMAN_PLUGIN_DIR: '/p/sub-human' }, () => orch.spawnPlan({ code, cwd: '/work', env: parent }));
  assert.equal(p.cwd, '/work');
  assert.deepEqual(Object.keys(p.env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'TERM', 'USER']);
  assert.ok(Object.keys(p.env).every(k => !k.startsWith('CLAUDE')), 'no CLAUDE_* from the parent');
  assert.equal(p.env.LOGNAME, 'a');
  const a = p.args;
  assert.deepEqual(a.slice(0, 3), ['--bg', '-n', `orch.${code}`]);
  assert.deepEqual(a.slice(3, 5), ['--plugin-dir', '/p/sub-human']);
  assert.deepEqual(a.slice(5, 9), ['--agent', 'sub-human:orchestrator', '--permission-mode', 'plan']);
  assert.equal(a[9], '--settings');
  assert.deepEqual(JSON.parse(a[10]), {
    env: { SUB_HUMAN_HOME: identity.home(), SUB_HUMAN_ROOM: code, CLAUDE_CODE_TASK_LIST_ID: `sh-${code}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    crossSessionInbound: 'accept',
  });
  assert.equal(a.at(-1), '/sub-human');
  assert.ok(!a.includes('--model'), 'no model is prescribed: the orch uses the user\'s default');
  assert.equal(withEnv({ SUB_HUMAN_PLUGIN_DIR: '' }, () => orch.spawnPlan({ code, env: parent })).args.includes('--plugin-dir'), false);
  assert.match(orch.command(p), /^cd \/work && env -i .*PATH='\/bin:\/a b\/c'.* --settings '\{"env":/);
  assert.throws(() => orch.spawnPlan({ code: '../x' }), /invalid room code/);
});

test('orch: an installed plugin gets no --plugin-dir; a directory plugin does', () => {
  withEnv({ SUB_HUMAN_PLUGIN_DIR: undefined }, () => {
    assert.equal(orch.pluginDirFor(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'm', 'sub-human', '1.0.0')), null);
    assert.equal(orch.pluginDirFor('/tmp/dev/plugin/sub-human'), '/tmp/dev/plugin/sub-human');
  });
});

test('orch: spawn runs the stub, records members.json orch {job, spawned_at}; no file under ~/.claude', () => {
  h.freshHome();
  const code = h.newRoom();
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-'));
  const s = stubClaude({ out: `backgrounded · 0b500131 · orch.${code}` });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cwd-')));
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '', HOME: userHome, CLAUDE_PID: '77' }, () => orch.spawn({ code, cwd }));
  assert.deepEqual(r, { ok: true, job: '0b500131' });
  const [call] = s.calls();
  assert.equal(call.cwd, cwd);
  assert.equal(call.env.CLAUDE_PID, undefined);
  assert.equal(call.argv[0], '--bg');
  const o = identity.readMembers(code).orch;
  assert.equal(o.job, '0b500131');
  assert.equal(o.pid, null);
  assert.ok(o.spawned_at);
  assert.equal(fs.existsSync(path.join(userHome, '.claude')), false, 'no sentinel file');
  assert.equal(orch.needsSpawn(code), false, 'spawned, not yet bound');
  identity.join({ code, name: 'orch', role: 'orch', pid: process.pid, session_id: 'so' });
  assert.equal(orch.needsSpawn(code), false);
  identity.leave(code, 'orch');
  assert.equal(orch.needsSpawn(code), true, 'orch left');
  const bad = stubClaude({ out: 'Workspace not trusted. Run claude in /x once' });
  const r2 = withEnv({ SUB_HUMAN_CLAUDE: bad.bin }, () => orch.spawn({ code, cwd }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /not trusted/);
});

test('orch: needsSpawn with no record, a dead bound pid, or a spawn that never bound', async () => {
  h.freshHome();
  const code = h.newRoom();
  assert.equal(orch.needsSpawn(code), true);
  identity.setOrch(code, { job: 'j1', spawned_at: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.equal(orch.needsSpawn(code), true, 'never bound in 2 min');
  const dead = await h.deadPid();
  identity.setOrch(code, { pid: dead });
  assert.equal(orch.needsSpawn(code), true, 'bound pid died');
});

test('orch: reap waits the grace, marks closing, tells the orch, waits for task 1, then stops the job', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const list = path.join(cfg, 'tasks', `sh-${code}`);
  fs.mkdirSync(list, { recursive: true });
  fs.writeFileSync(path.join(list, '1.json'), JSON.stringify({ id: '1', subject: `room ${code} open`, status: 'in_progress', owner: 'room' }));
  const s = stubClaude();
  const o = h.spawnSleeper();
  identity.setOrch(code, { job: 'cafe1234' });
  identity.join({ code, name: 'orch', role: 'orch', pid: o.pid, session_id: 'so' });
  const room = require(path.join(h.LIB, 'room.js'));
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg }, async () => {
    const t0 = Date.now();
    const p = orch.reap(code, { graceMs: 150, waitMs: 3000, pollMs: 50 });
    await h.sleep(60);
    assert.equal(identity.roomClosing(code), false, 'not closing during the grace');
    await h.until(() => identity.roomClosing(code), 2000);
    room.bind(code);
    const e = room.readAll().at(-1);
    assert.deepEqual([e.kind, e.to, e.via, e.text], ['status', 'orch', 'system', orch.CLOSE_TEXT]);
    assert.equal(s.calls().length, 0, 'no stop while task 1 is open');
    await h.sleep(200);
    fs.writeFileSync(path.join(list, '1.json'), JSON.stringify({ id: '1', status: 'completed', owner: 'room' }));
    assert.equal(await p, 'stopped');
    const dt = Date.now() - t0;
    assert.ok(dt < 3000, `stopped once task 1 completed (${dt} ms), not at the 20 s cap`);
    assert.deepEqual(s.calls().map(c => c.argv), [['stop', 'cafe1234']]);
    assert.equal(s.calls()[0].env.CLAUDE_PID, undefined, 'clean env for stop');
    assert.equal(s.calls()[0].env.CLAUDE_CONFIG_DIR, cfg, 'stop reaches the same daemon (CLAUDE_CONFIG_DIR is on the allowlist)');
    const rec = identity.readMembers(code).orch;
    assert.ok(rec.left_at && rec.stopped_at && rec.closing);
    assert.ok(fs.existsSync(list), 'never deletes the task list');
    assert.deepEqual(identity.openRooms(), []);
  });
  o.kill();
});

test('orch: reap stops at the wait cap when task 1 stays open; a rejoin in the grace cancels; a second reaper backs off', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const list = path.join(cfg, 'tasks', `sh-${code}`);
  fs.mkdirSync(list, { recursive: true });
  fs.writeFileSync(path.join(list, '1.json'), JSON.stringify({ id: '1', status: 'in_progress' }));
  const s = stubClaude();
  identity.setOrch(code, { job: 'beef0001' });
  const alice = h.spawnSleeper();
  identity.join({ code, name: 'alice', role: 'member', pid: alice.pid, session_id: 'sa' });
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg }, async () => {
    assert.equal(await orch.reap(code, { graceMs: 20, waitMs: 100 }), 'cancelled', 'a live member');
    assert.equal(identity.roomClosing(code), false);
    identity.leave(code, 'alice');
    const t0 = Date.now();
    const [a, b] = await Promise.all([orch.reap(code, { graceMs: 20, waitMs: 400, pollMs: 50 }), orch.reap(code, { graceMs: 120, waitMs: 400 })]);
    assert.ok(Date.now() - t0 >= 400, 'waited the cap');
    assert.deepEqual([a, b], ['stopped', 'no-orch']);
    assert.deepEqual(s.calls().map(c => c.argv), [['stop', 'beef0001']]);
  });
  alice.kill();
});

test('orch: the CLI prints the manual command and refuses a bad code', () => {
  h.freshHome();
  const code = h.newRoom();
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(h.LIB, 'orch.js'), 'cmd', code], { env: h.childEnv({ SUB_HUMAN_PLUGIN_DIR: '' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`env -i .* claude --bg -n orch\\.${code} --agent sub-human:orchestrator --permission-mode plan --settings `));
  const bad = spawnSync(process.execPath, [path.join(h.LIB, 'orch.js'), 'reap', '../x'], { env: h.childEnv(), encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// ---------- spawn env, claim, job lookup, respawn, watchdog ----------
const cc = require(path.join(h.LIB, 'cc.js'));

test('orch: the spawn env is the login basics plus the daemon allowlist (cc.DAEMON_ENV_ALLOW), nothing else', () => {
  h.freshHome();
  const code = h.newRoom();
  const parent = {
    HOME: '/Users/a', USER: 'a', PATH: '/bin', TERM: 'xterm', SHELL: '/bin/zsh', TMPDIR: '/t', LANG: 'C',
    CLAUDE_CONFIG_DIR: '/cfg', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'p', ANTHROPIC_MODEL: 'm',
    CLAUDE_CODE_DISABLE_PROACTIVITY: '1', // in the daemon allowlist since 2.1.292
    CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', CLAUDE_CODE_TASK_LIST_ID: 'x', SUB_HUMAN_HOME: '/h', SECRET: 'x',
  };
  const env = orch.spawnPlan({ code, env: parent }).env;
  const login = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'LANG', 'TMPDIR'];
  for (const k of Object.keys(env)) assert.ok(login.includes(k) || cc.DAEMON_ENV_ALLOW.includes(k), `${k} is neither login nor allowlisted`);
  for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_PROACTIVITY']) assert.equal(env[k], parent[k], k);
  for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_TASK_LIST_ID', 'SUB_HUMAN_HOME', 'SECRET']) assert.equal(env[k], undefined, k);
});

test('orch: claimSpawn: one claim wins, the second sees it; a stale pending claim expires; closing rooms are not claimed', () => {
  h.freshHome();
  const code = h.newRoom();
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  const a = orch.claimSpawn(code, { now: t0, by: 'alice' });
  assert.ok(a && a.claim, 'first claim');
  assert.equal(a.prevJob, null);
  assert.equal(orch.claimSpawn(code, { now: t0 + 1000, by: 'bob' }), null, 'second join sees the claim');
  const o = identity.readMembers(code).orch;
  assert.deepEqual([o.job, o.by, o.claim], ['pending', 'alice', a.claim]);
  assert.equal(orch.needsSpawn(code, t0 + 1000), false);
  const later = t0 + 91_000;
  assert.equal(orch.needsSpawn(code, later), true, 'pending claim older than ORCH_CLAIM_MS');
  const b = orch.claimSpawn(code, { now: later, by: 'bob' });
  assert.ok(b && b.claim && b.claim !== a.claim);
  assert.equal(b.prevJob, null, 'a pending claim has no job to stop');
  identity.setOrch(code, { closing: new Date(later).toISOString() });
  assert.equal(orch.claimSpawn(code, { now: later + 200_000 }), null, 'closing');
});

test('orch: concurrent claims from separate processes: exactly one wins', async () => {
  h.freshHome();
  const code = h.newRoom();
  const { spawn: sp } = require('node:child_process');
  const src = `const o=require(${JSON.stringify(path.join(h.LIB, 'orch.js'))});process.stdout.write(JSON.stringify(o.claimSpawn(process.argv[1],{by:process.argv[2]})))`;
  const run = by => new Promise(res => { let out = ''; const p = sp(process.execPath, ['-e', src, code, by], { env: h.childEnv({ SUB_HUMAN_HOME: identity.home() }) }); p.stdout.on('data', d => { out += d; }); p.on('close', () => res(JSON.parse(out || 'null'))); });
  const rs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(run));
  assert.equal(rs.filter(Boolean).length, 1, JSON.stringify(rs));
});

test('orch: spawn with a claim stops the previous job first, finds the job in `claude agents --json`, records it', () => {
  h.freshHome();
  const code = h.newRoom();
  const agents = [
    { id: 'aaaa0000', kind: 'background', name: `orch.${code}`, state: 'stopped', startedAt: 1, sessionId: 'old' },
    { id: 'bbbb1111', kind: 'background', name: `orch.${code}`, state: 'working', startedAt: 2, sessionId: 'bbbb1111-full' },
    { pid: 5, kind: 'interactive', name: `orch.${code}`, sessionId: 'i' },
  ];
  const s = stubClaude({ out: 'something else entirely', agents });
  // an orch that was spawned long ago and never bound: needs a respawn, and its job must be stopped
  identity.setOrch(code, { job: 'dead0001', spawned_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  const c = orch.claimSpawn(code, { by: 'alice' });
  assert.equal(c.prevJob, 'dead0001');
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => orch.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.deepEqual(r, { ok: true, job: 'bbbb1111' }, 'no backgrounded line: the job comes from agents --json');
  const argv = s.calls().map(x => x.argv[0]);
  assert.deepEqual(argv, ['stop', '--bg', 'agents'], 'stop the old job before the respawn');
  assert.deepEqual(s.calls()[0].argv, ['stop', 'dead0001']);
  const o = identity.readMembers(code).orch;
  assert.deepEqual([o.job, o.job_session, o.claim, o.by], ['bbbb1111', 'bbbb1111-full', undefined, 'alice']);
});

test('orch: a superseded claim stops the job it made; a failed start records spawn_error and clears the claim', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = stubClaude({ out: `backgrounded · 0b500131 · orch.${code}` });
  const c = orch.claimSpawn(code, {});
  identity.setOrch(code, { claim: 'someone-else' });
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => orch.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.equal(r.ok, false);
  assert.deepEqual(s.calls().map(x => x.argv).filter(a => a[0] === 'stop'), [['stop', '0b500131']]);
  const bad = stubClaude({ out: 'Workspace not trusted' });
  identity.setOrch(code, { job: 'pending', claim: 'k2', spawned_at: new Date().toISOString() });
  const r2 = withEnv({ SUB_HUMAN_CLAUDE: bad.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => orch.spawn({ code, cwd: os.tmpdir(), claim: 'k2' }));
  assert.equal(r2.ok, false);
  const o = identity.readMembers(code).orch;
  assert.equal(o.job, null);
  assert.equal(o.claim, undefined);
  assert.match(o.spawn_error, /not trusted/);
  assert.equal(orch.needsSpawn(code), true, 'the next join retries');
});

test('orch: the orch binding before its starter records the job keeps the claim; the record then lands', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = stubClaude({ out: `backgrounded · 0b500131 · orch.${code}` });
  const c = orch.claimSpawn(code, {});
  identity.join({ code, name: 'orch', role: 'orch', pid: process.pid, session_id: 'so' });
  assert.equal(orch.needsSpawn(code), false, 'bound');
  const r = withEnv({ SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: '' }, () => orch.spawn({ code, cwd: os.tmpdir(), ...c }));
  assert.deepEqual(r, { ok: true, job: '0b500131' });
  const o = identity.readMembers(code).orch;
  assert.deepEqual([o.pid, o.job], [process.pid, '0b500131']);
});

test('orch: watchdog with an injected clock and liveness: live, waiting, then reaping once (idempotent)', () => {
  h.freshHome();
  const code = h.newRoom();
  const o = h.spawnSleeper();
  identity.setOrch(code, { job: 'cafe0001' });
  identity.join({ code, name: 'orch', role: 'orch', pid: o.pid });
  identity.join({ code, name: 'alice', role: 'member', pid: process.pid });
  const reaped = [];
  const reaper = (c, opts) => reaped.push([c, opts]);
  let up = true;
  const alive = () => up;
  const t0 = Date.now() + 1000; // after the joins (a join newer than the observation restarts it)
  assert.equal(orch.watchdog(code, { now: t0, alive, reaper }), 'live');
  up = false;
  assert.equal(orch.watchdog(code, { now: t0 + 1000, alive, reaper }), 'waiting');
  assert.equal(identity.readMembers(code).orch.orphan_since, new Date(t0 + 1000).toISOString());
  assert.equal(orch.watchdog(code, { now: t0 + 30_000, alive, reaper }), 'waiting');
  up = true;
  assert.equal(orch.watchdog(code, { now: t0 + 40_000, alive, reaper }), 'live', 'a member came back');
  assert.equal(identity.readMembers(code).orch.orphan_since, undefined);
  up = false;
  assert.equal(orch.watchdog(code, { now: t0 + 50_000, alive, reaper }), 'waiting', 'the clock restarts');
  assert.equal(orch.watchdog(code, { now: t0 + 109_000, alive, reaper }), 'waiting');
  assert.deepEqual(reaped, []);
  assert.equal(orch.watchdog(code, { now: t0 + 110_000, alive, reaper }), 'reaping');
  assert.deepEqual(reaped, [[code, { claimed: true }]]);
  assert.ok(identity.roomClosing(code));
  assert.equal(orch.watchdog(code, { now: t0 + 200_000, alive, reaper }), 'closing');
  assert.equal(reaped.length, 1, 'idempotent');
  o.kill();
});

test('orch: watchdog: members who all left cleanly count from their latest left_at', () => {
  h.freshHome();
  const code = h.newRoom();
  identity.setOrch(code, { job: 'cafe0002' });
  identity.join({ code, name: 'alice', role: 'member', pid: process.pid });
  identity.leave(code, 'alice');
  const left = Date.parse(identity.readMembers(code).alice.left_at);
  const reaped = [];
  assert.equal(orch.watchdog(code, { now: left + 59_000, reaper: c => reaped.push(c) }), 'waiting');
  assert.equal(orch.watchdog(code, { now: left + 60_000, reaper: c => reaped.push(c) }), 'reaping');
  assert.deepEqual(reaped, [code]);
  assert.equal(orch.watchdog('nope-0000'), 'no-room');
});

test('orch: crash-all-members (SIGKILL) -> the watchdog reaps the orch (real detached reaper, stub claude)', async () => {
  h.freshHome();
  const code = h.newRoom();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cfg-'));
  const s = stubClaude();
  const o = h.spawnSleeper();
  const a = h.spawnSleeper();
  const b = h.spawnSleeper();
  identity.setOrch(code, { job: 'dead00ff' });
  identity.join({ code, name: 'orch', role: 'orch', pid: o.pid });
  identity.join({ code, name: 'alice', role: 'member', pid: a.pid });
  identity.join({ code, name: 'bob', role: 'member', pid: b.pid });
  a.kill('SIGKILL'); b.kill('SIGKILL');
  await h.until(() => !identity.isAlive(a.pid) && !identity.isAlive(b.pid), 3000);
  assert.deepEqual(identity.liveMembers(code), []);
  assert.deepEqual(identity.openRooms(), [], 'orch-only room is not open');
  assert.deepEqual(identity.orphanRooms(), [code]);
  const t0 = Date.now();
  await withEnv({ SUB_HUMAN_CLAUDE: s.bin, CLAUDE_CONFIG_DIR: cfg, SUB_HUMAN_REAP_WAIT_MS: '0' }, async () => {
    assert.equal(orch.watchdog(code, { now: t0 }), 'waiting', 'no SessionEnd ran: the first observation starts the clock');
    assert.equal(orch.watchdog(code, { now: t0 + 60_000 }), 'reaping');
    assert.ok(await h.until(() => identity.readMembers(code).orch.stopped_at, 5000), 'reaper finished');
  });
  assert.deepEqual(s.calls().map(c => c.argv), [['stop', 'dead00ff']]);
  const rec = identity.readMembers(code).orch;
  assert.ok(rec.closing && rec.left_at);
  const room = require(path.join(h.LIB, 'room.js'));
  room.bind(code);
  assert.ok(room.readAll().some(e => e.kind === 'status' && e.text === orch.CLOSE_TEXT));
  assert.deepEqual(identity.orphanRooms(), []);
  o.kill();
});

test('orch: the watchdog CLI entry prints its state', () => {
  h.freshHome();
  const code = h.newRoom();
  identity.setOrch(code, { job: 'cafe0003' });
  identity.join({ code, name: 'alice', role: 'member', pid: process.pid });
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(h.LIB, 'orch.js'), 'watchdog', code], { env: h.childEnv({ SUB_HUMAN_HOME: identity.home() }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'live');
});
