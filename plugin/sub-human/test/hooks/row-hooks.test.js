'use strict';
// hooks/row-map.ts (PostToolUse Agent), hooks/row-hold.ts (SubagentStop), hooks/row-launcher.ts (SessionStart).
// Payload shapes are the ones logged in P0 (Claude Code 2.1.281).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..', '..');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];
const identity = require(path.join(PLUGIN, 'lib', 'identity.ts'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.ts'));

const sleepers = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

function world(names) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rowhooks-'));
  process.env.SUB_HUMAN_HOME = home;
  const code = identity.newCode();
  for (const name of names) {
    const r = identity.join({ code, name, role: name === 'claude' ? 'claude' : 'member', pid: sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  return { home, code };
}
function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE') && k !== 'NODE_TEST_CONTEXT') e[k] = v;
  return { ...e, CLAUDE_PLUGIN_ROOT: PLUGIN, ...extra };
}
function hook(name, input, extra) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', name + '.js')], { input: JSON.stringify(input), env: env(extra), encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}
const launched = (agentId, ti) => ({ isAsync: true, status: 'async_launched', agentId, description: ti.description, prompt: ti.prompt });
const post = (sid, ti, agentId, parent) => ({
  session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: launched(agentId, ti),
  ...(parent ? { agent_id: parent, agent_type: 'sub-human:room' } : {}),
});

test('row-map: claude participant rows (name from the prompt even when the description differs)', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  let r = hook('row-map', post('sid-claude', { subagent_type: 'sub-human:participant', description: 'alice', prompt: 'member: alice', run_in_background: true }, 'a1'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  hook('row-map', post('sid-claude', { subagent_type: 'sub-human:participant', description: 'row for bob', prompt: 'member: bob' }, 'a2'));
  hook('row-map', post('sid-claude', { subagent_type: 'Explore', description: 'alice', prompt: 'x' }, 'a3'));
  hook('row-map', post('sid-claude', { subagent_type: 'sub-human:participant', description: 'alice', prompt: 'member: alice' }, undefined));
  const m = rows.readRowMap(code);
  assert.deepEqual(Object.keys(m).sort(), ['a1', 'a2']);
  assert.deepEqual({ ...m.a1, at: undefined }, { kind: 'participant', name: 'alice', parent: null, at: undefined });
  assert.equal(m.a2.name, 'bob');
  assert.ok(Object.keys(rows.sessionRowMap(code, 'sid-claude')).length, 'the room\'s Claude session has its own map');
});

test('row-map: a member\'s room row and its nested children (parent = the spawning room agent)', () => {
  const { code } = world(['claude', 'alice', 'bob', 'carol']);
  hook('row-map', post('sid-alice', { subagent_type: 'sub-human:room', description: code, prompt: `room: ${code}\nmembers: bob, carol`, run_in_background: true }, 'r1'));
  hook('row-map', post('sid-alice', { subagent_type: 'sub-human:participant', description: 'bob', prompt: 'member: bob' }, 'c1', 'r1'));
  hook('row-map', post('sid-alice', { subagent_type: 'sub-human:participant', description: 'carol', prompt: 'carol' }, 'c2', 'r1'));
  const m = rows.readRowMap(code);
  assert.equal(m.r1.kind, 'room');
  assert.equal(m.r1.name, code);
  assert.equal(m.r1.parent, null);
  assert.deepEqual([m.c1.name, m.c1.parent, m.c2.name, m.c2.parent], ['bob', 'r1', 'carol', 'r1']);
});

test('row-map: not in a room -> nothing written, exit 0', () => {
  const { code } = world(['claude', 'alice']);
  const r = hook('row-map', post('sid-nobody', { subagent_type: 'sub-human:participant', description: 'alice', prompt: 'member: alice' }, 'a1'));
  assert.equal(r.code, 0);
  assert.deepEqual(rows.readRowMap(code), {});
});

test('row-hold: blocks a row agent that stops while its member is present (capped); lets STOP/left through and forgets the row', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  rows.recordRow(code, 'sid-claude', 'a1', { kind: 'participant', name: 'alice', parent: null });
  const stop = (id, last, type = 'sub-human:participant', sid = 'sid-claude') => hook('row-hold', {
    session_id: sid, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, stop_hook_active: false, last_assistant_message: last,
  });
  let r = stop('a1', 'error');
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /Call hold with \{"member": "alice"\} again now/);
  for (let i = 0; i < 4; i++) assert.equal(stop('a1', 'error').json.decision, 'block');
  assert.equal(stop('a1', 'error').json, null, 'capped');
  assert.equal(stop('zz', 'error').json, null, 'unmapped agent');
  assert.equal(stop('a1', 'error', '').json, null, 'AgentSummary forks have no agent_type');
  rows.recordRow(code, 'sid-claude', 'a2', { kind: 'participant', name: 'bob', parent: null });
  assert.equal(stop('a2', 'left').json, null);
  assert.equal(rows.readRowMap(code).a2, undefined, 'a finished row is forgotten');
  // The member left: the row is still wanted (it reads "left" and comes back on rejoin).
  rows.recordRow(code, 'sid-claude', 'a3', { kind: 'participant', name: 'bob', parent: null });
  identity.leave(code, 'bob');
  assert.equal(stop('a3', 'hmm').json.decision, 'block');
  // The viewer left: no block.
  identity.leave(code, 'claude');
  assert.equal(stop('a3', 'hmm').json, null);
  // The room row re-holds with its room code while this seat is in the room.
  rows.recordRow(code, 'sid-alice', 'r1', { kind: 'room', name: code, parent: null });
  r = stop('r1', '', 'sub-human:room', 'sid-alice');
  assert.match(r.json.reason, new RegExp(`Call hold with \\{"room": "${code}"\\}`));
});

test('row-launcher: writes an executable launcher under SUB_HUMAN_HOME/bin that runs this plugin\'s agent-statusline', () => {
  const { home, code } = world(['claude', 'alice']);
  const r = hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.code, 0, r.stderr);
  const f = path.join(home, 'bin', 'row-status');
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.ok(body.includes(`exec node '${path.join(PLUGIN, 'scripts', 'sub-human')}' agent-statusline`));
  assert.ok(fs.statSync(f).mode & 0o100, 'executable');
  const mtime = fs.statSync(f).mtimeMs;
  hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'clear' });
  assert.equal(fs.statSync(f).mtimeMs, mtime, 'unchanged content is not rewritten');
  // and the SSH serve shim with its pointer at this plugin (lib/remote/shim.ts)
  assert.equal(fs.statSync(path.join(home, 'bin', 'serve')).mode & 0o777, 0o700);
  assert.ok(fs.readFileSync(path.join(home, 'bin', 'current'), 'utf8').startsWith(path.resolve(PLUGIN) + '\n'));
  // The plugin settings point at the same place, through the shell's env default.
  const settings = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'settings.json'), 'utf8'));
  assert.equal(settings.subagentStatusLine.type, 'command');
  const cmd = settings.subagentStatusLine.command;
  const resolved = spawnSync('/bin/sh', ['-c', `printf %s ${cmd}`], { env: env({ SUB_HUMAN_HOME: home }), encoding: 'utf8' }).stdout;
  assert.equal(resolved, f);
  const dflt = spawnSync('/bin/sh', ['-c', `printf %s ${cmd}`], { env: { HOME: '/Users/x', PATH: process.env.PATH }, encoding: 'utf8' }).stdout;
  assert.equal(dflt, '/Users/x/.sub-human/bin/row-status');
  // End to end through the shell command, as Claude Code runs it (needs scripts/sub-human's dispatch, owner C).
  rows.recordRow(code, 'sid-claude', 'a1', { kind: 'participant', name: 'alice', parent: null });
  const out = spawnSync('/bin/sh', ['-c', cmd], {
    env: env({ SUB_HUMAN_HOME: home, NO_COLOR: '1' }), encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-claude', tasks: [{ id: 'a1', type: 'local_agent', status: 'running', description: 'alice' }] }),
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^\{"id":"a1","content":"alice {2}joined"\}\n?$/);
});

test('row-launcher: a temp-dir plugin root is refused unless allowed; stable roots run first, newest first, a deleted root is skipped', () => {
  const { home } = world(['claude']);
  const f = path.join(home, 'bin', 'row-status');
  const mkRoot = base => { fs.mkdirSync(path.join(base, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(base, 'scripts', 'sub-human'), ''); return base; };
  const tmpRoot = mkRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-root-')));
  // refused: nothing is written
  let r = hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_ROOT: tmpRoot, SUB_HUMAN_ALLOW_TMP_ROOT: undefined });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /temp dir/);
  assert.ok(!fs.existsSync(f));
  const launcher = require(path.join(PLUGIN, 'hooks', 'row-launcher.ts'));
  assert.equal(launcher.isTempRoot(tmpRoot), true);
  assert.equal(launcher.isTempRoot(PLUGIN), false);
  // allowed (tests, the demo): it is recorded, but after any stable root
  r = hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_ROOT: tmpRoot, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  assert.equal(r.code, 0, r.stderr);
  hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  const body = fs.readFileSync(f, 'utf8');
  const at = s => body.indexOf(`exec node '${path.join(s, 'scripts', 'sub-human')}'`);
  assert.ok(at(PLUGIN) >= 0 && at(tmpRoot) > at(PLUGIN), body);
  // a session that does not allow temp roots drops them
  hook('row-launcher', { session_id: 'x', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_ALLOW_TMP_ROOT: undefined });
  assert.equal(fs.readFileSync(f, 'utf8').indexOf(tmpRoot), -1);
  // the launcher itself skips a root whose CLI is gone and prints nothing
  assert.equal(spawnSync('/bin/sh', [f], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status, 0);
  const gone = launcher.launcherBody(['/nonexistent/root']);
  assert.equal(spawnSync('/bin/sh', ['-c', gone], { encoding: 'utf8' }).stdout, '');
  assert.equal(fs.statSync(path.join(home, 'bin')).mode & 0o777, 0o700);
});

test('row-guard: denies spawning a row whose hold is live in this session; allows the rest', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  const pre = (sid, ti, parent) => hook('row-guard', {
    session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: ti,
    ...(parent ? { agent_id: parent, agent_type: 'sub-human:room' } : {}),
  });
  const bob = { subagent_type: 'sub-human:participant', description: 'bob', prompt: 'member: bob', run_in_background: true };
  const roomRow = { subagent_type: 'sub-human:room', description: code, prompt: `room: ${code}\nmembers: bob`, run_in_background: true };
  assert.equal(pre('sid-alice', roomRow).stdout, '', 'nothing held yet');
  assert.equal(pre('sid-alice', bob, 'room1').stdout, '');
  rows.writeHolds(code, 'alice', { members: ['bob'], room: true }); // this test process = a live hold server
  const d = pre('sid-alice', roomRow).json.hookSpecificOutput;
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /already running/);
  assert.equal(pre('sid-alice', bob, 'room1').json.hookSpecificOutput.permissionDecision, 'deny');
  // The room Claude's rejoin spawn for bob: denied while room Claude's row for bob is live (it survived bob's leave).
  rows.writeHolds(code, 'claude', { members: ['alice'] });
  assert.equal(pre('sid-claude', bob).stdout, '', 'claude holds no bob row: allowed');
  rows.writeHolds(code, 'claude', { members: ['alice', 'bob'] });
  assert.equal(pre('sid-claude', bob).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(pre('sid-claude', { subagent_type: 'Explore', description: 'bob', prompt: 'x' }).stdout, '', 'other agents untouched');
});

test('row-guard: a member never spawns a participant row from main, nor one for itself', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  const pre = (sid, ti, parent) => hook('row-guard', {
    session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: ti,
    ...(parent ? { agent_id: parent, agent_type: 'sub-human:room' } : {}),
  });
  const p = name => ({ subagent_type: 'sub-human:participant', description: name, prompt: name, run_in_background: true });
  assert.equal(pre('sid-bob', p('bob')).json.hookSpecificOutput.permissionDecision, 'deny', 'main, self');
  assert.equal(pre('sid-bob', p('alice')).json.hookSpecificOutput.permissionDecision, 'deny', 'main, other');
  assert.equal(pre('sid-bob', p('bob'), 'room1').json.hookSpecificOutput.permissionDecision, 'deny', 'inside the room row, self');
  assert.equal(pre('sid-bob', p('alice'), 'room1').stdout, '', 'inside the room row: allowed');
  assert.equal(pre('sid-claude', p('alice')).stdout, '', 'the room\'s Claude spawns participant rows from main');
  const roomRow = { subagent_type: 'sub-human:room', description: code, prompt: `room: ${code}\nmembers: alice`, run_in_background: true };
  assert.equal(pre('sid-bob', roomRow).stdout, '', 'the room row itself is allowed');
});

// ---------- row-rewake (SessionStart resume, asyncRewake): exit 2 + calls on stderr wakes the model ----------
const rewake = (sid, extra = {}, source = 'resume') =>
  hook('row-rewake', { session_id: sid, hook_event_name: 'SessionStart', source }, { SUB_HUMAN_REWAKE_WAIT_MS: '0', ...extra });

test('row-rewake: a resumed member with no room row -> exit 2 with the room-row call on stderr', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  const r = rewake('sid-alice');
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(rows.roomCall(code, ['bob'])), r.stderr);
  assert.match(r.stderr, /resumed/);
  assert.match(r.stderr, /Write no text/);
});

test('row-rewake: a resumed claude gets only the missing participant rows', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  rows.writeHolds(code, 'claude', { members: ['alice'] });
  const r = rewake('sid-claude');
  assert.equal(r.code, 2, r.stderr);
  assert.ok(r.stderr.includes(rows.participantCall('bob')), r.stderr);
  assert.ok(!r.stderr.includes(rows.participantCall('alice')), 'a held row is not re-created');
});

test('row-rewake: silent exit 0 when nothing is missing, outside a room, with no members, or not a resume', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  rows.writeHolds(code, 'alice', { members: ['bob'], room: true });
  rows.writeHolds(code, 'claude', { members: ['alice', 'bob'] });
  for (const r of [rewake('sid-alice'), rewake('sid-claude'), rewake('sid-nobody'), rewake('sid-bob', {}, 'startup')]) {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
  }
  world(['claude']);
  const r = rewake('sid-claude');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('row-rewake: registered in hooks.json for SessionStart resume with asyncRewake', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const e = cfg.hooks.SessionStart.find(x => x.hooks.some(h => /row-rewake\.js/.test(h.command)));
  assert.ok(e, 'registered');
  assert.equal(e.matcher, 'resume');
  assert.equal(e.hooks[0].asyncRewake, true);
});

test('row agents: a stray typed message gets the one-line read-only reply, then hold again', () => {
  for (const f of ['room.md', 'participant.md']) {
    const s = fs.readFileSync(path.join(PLUGIN, 'agents', f), 'utf8');
    assert.ok(s.includes('`read-only row — type in main with @room`'), f);
    assert.match(s, /SAME message you call `hold` again/, f);
  }
});

test('row agents: descriptions are at most 125 chars each; no model key (rows inherit the session model), background, hold-only tools', () => {
  for (const f of ['room.md', 'participant.md']) {
    const s = fs.readFileSync(path.join(PLUGIN, 'agents', f), 'utf8');
    const d = /^description: (.*)$/m.exec(s)[1];
    assert.ok(Array.from(d).length <= 125, `${f}: ${d.length}`);
    assert.doesNotMatch(s, /^model:/m, `${f} prescribes no model`);
    assert.match(s, /^background: true$/m);
    assert.match(s, /^tools: .*mcp__plugin_sub-human_room__hold$/m);
  }
});
