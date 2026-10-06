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

/** A stub claude: appends {argv, env, cwd} to calls.jsonl; `--bg` prints the backgrounded line. */
function stubClaude({ out = 'backgrounded · 0b500131 · orch.x' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n` +
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}) + '\\n');\n` +
    `if (process.argv.includes('--bg')) console.log(${JSON.stringify(out)});\n`);
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
    assert.equal(s.calls()[0].env.CLAUDE_CONFIG_DIR, undefined, 'clean env for stop');
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
