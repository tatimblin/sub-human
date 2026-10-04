'use strict';
// Tests for demo/hooks/*.js. Each hook runs as a child process with realistic stdin JSON (shapes
// from docs/research/02) against a temp ROOM_DIR; we assert on stdout JSON, exit code and the log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEMO = path.join(__dirname, '..');
const REPO = path.join(DEMO, '..');
const HOOKS = path.join(DEMO, 'hooks');
const room = require(path.join(DEMO, 'lib', 'room.js'));

const SESSION = '5c0ccc9e-bd0c-4f75-89ef-3937111e9637';
const common = extra => ({
  session_id: SESSION,
  transcript_path: `/Users/x/.claude/projects/p/${SESSION}.jsonl`,
  cwd: REPO,
  permission_mode: 'plan',
  ...extra,
});

function tmpRoom() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'room-hooks-'));
  fs.mkdirSync(path.join(d, 'plans'));
  return d;
}

function hook(name, input, dir, env = {}) {
  const e = { ...process.env, ROOM_DIR: dir, ROOM_USER: 'orch', ROOM_HUMANS: 'alice bob', CLAUDE_PROJECT_DIR: REPO, ...env };
  delete e.NODE_TEST_CONTEXT;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [path.join(HOOKS, name + '.js')], { input: JSON.stringify(input), env: e, encoding: 'utf8', cwd: REPO });
  let json = null;
  if (r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { json = { raw: r.stdout }; } }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

const entries = dir => withEnv({ ROOM_DIR: dir }, () => room.readAll());
const sign = (dir, who, hash, kind = 'signoff') =>
  withEnv({ ROOM_DIR: dir, ROOM_USER: who }, () => room.append({ kind, text: kind, plan_hash: hash }, { via: 'human' }));
const post = (dir, who, entry, opts = { via: 'agent' }) =>
  withEnv({ ROOM_DIR: dir, ROOM_USER: who }, () => room.append(entry, opts));
const decision = r => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const reason = r => r.json.hookSpecificOutput.permissionDecisionReason;

const exitPlan = (plan, planFilePath) => common({
  hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'toolu_01', tool_input: { plan, planFilePath },
});
const postWrite = (file, extra = {}) => common({
  hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_02',
  tool_input: { file_path: file, content: '…' }, tool_response: { type: 'create', filePath: file }, ...extra,
});
function writePlan(dir, text) {
  const f = path.join(dir, 'plans', 'plan-room.md');
  fs.writeFileSync(f, text);
  return f;
}

// ---------- gate-exitplan + plan-publish ----------

test('gate denies when no plan_rev exists, naming every human', () => {
  const dir = tmpRoom();
  const plan = '# Plan\n\n1. do it\n';
  const r = hook('gate-exitplan', exitPlan(plan), dir);
  assert.equal(r.code, 0);
  assert.equal(decision(r), 'deny');
  const h = room.hash12(plan);
  assert.ok(reason(r).startsWith(`ROOM-GATE: plan ${h} lacks sign-off from alice and bob. Stay in plan mode; ask alice and bob by name.`), reason(r));
  assert.match(reason(r), /No plan_rev with that hash exists/);
  assert.equal(entries(dir).length, 0);
});

test('plan-publish appends plan_rev from file bytes, skips unchanged, ignores subagents and other paths', () => {
  const dir = tmpRoom();
  const f = writePlan(dir, '# Plan v1\n');
  let r = hook('plan-publish', postWrite(f), dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.hookSpecificOutput.additionalContext, /Published plan_rev #1/);
  let es = entries(dir);
  assert.equal(es.length, 1);
  assert.deepEqual([es[0].kind, es[0].from, es[0].via, es[0].plan_hash, es[0].text], ['plan_rev', 'orch', 'agent', room.hash12(fs.readFileSync(f)), f]);

  r = hook('plan-publish', postWrite(f), dir); // same bytes
  assert.equal(r.stdout, '');
  assert.equal(entries(dir).length, 1);

  fs.writeFileSync(f, '# Plan v2\n');
  r = hook('plan-publish', postWrite(f, { agent_id: 'a1', agent_type: 'seat-alice' }), dir);
  assert.equal(entries(dir).length, 1, 'subagent writes never publish');

  const other = path.join(dir, 'notes.md');
  fs.writeFileSync(other, 'x');
  hook('plan-publish', postWrite(other), dir);
  assert.equal(entries(dir).length, 1, 'files outside plans/ never publish');

  r = hook('plan-publish', { ...postWrite(f), tool_name: 'Edit', tool_input: { file_path: f, old_string: 'v1', new_string: 'v2' } }, dir);
  es = entries(dir);
  assert.equal(es.length, 2);
  assert.equal(es[1].plan_hash, room.hash12('# Plan v2\n'));
  assert.match(r.json.hookSpecificOutput.additionalContext, /earlier sign-offs no longer count/);
});

test('gate: denies with missing names, denies after a plan edit voids sign-offs, allows when all signed', () => {
  const dir = tmpRoom();
  const v1 = '# Plan\n\n1. add pagination\n';
  const f = writePlan(dir, v1);
  hook('plan-publish', postWrite(f), dir);
  const h1 = room.hash12(v1);

  sign(dir, 'alice', h1);
  let r = hook('gate-exitplan', exitPlan(v1, f), dir);
  assert.equal(decision(r), 'deny');
  assert.ok(reason(r).startsWith(`ROOM-GATE: plan ${h1} lacks sign-off from bob. Stay in plan mode; ask bob by name.`), reason(r));
  assert.doesNotMatch(reason(r), /alice/);

  // an agent-stamped signoff or a stale-hash signoff never counts
  assert.throws(() => post(dir, 'bob', { kind: 'signoff', text: 'x', plan_hash: h1 }), /human/);
  sign(dir, 'bob', 'abcdefabcdef');
  assert.equal(decision(hook('gate-exitplan', exitPlan(v1, f), dir)), 'deny');

  // the orchestrator edits the plan: new hash, every earlier sign-off voided
  const v2 = v1 + '2. and tests\n';
  fs.writeFileSync(f, v2);
  hook('plan-publish', { ...postWrite(f), tool_name: 'Edit' }, dir);
  const h2 = room.hash12(v2);
  sign(dir, 'bob', h1); // bob signs the old hash: does not count
  r = hook('gate-exitplan', exitPlan(v2, f), dir);
  assert.ok(reason(r).startsWith(`ROOM-GATE: plan ${h2} lacks sign-off from alice and bob.`), reason(r));

  // the old plan text is stale even though a plan_rev with its hash exists
  r = hook('gate-exitplan', exitPlan(v1), dir);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), new RegExp(`older plan_rev; the current one is ${h2}`));

  sign(dir, 'alice', h2);
  sign(dir, 'bob', h2);
  sign(dir, 'bob', h2, 'revoke');
  r = hook('gate-exitplan', exitPlan(v2, f), dir);
  assert.ok(reason(r).includes('lacks sign-off from bob.'), 'a revoke removes the sign-off');

  sign(dir, 'bob', h2);
  const before = entries(dir).length;
  r = hook('gate-exitplan', exitPlan(v2, f), dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(decision(r), 'allow', 'a full matrix approves the call itself');
  // allow alone still shows the dialog for ExitPlanMode (requiresUserInteraction); updatedInput skips it
  assert.deepEqual(r.json.hookSpecificOutput.updatedInput, { plan: v2, planFilePath: f });
  assert.match(reason(r), new RegExp(`^ROOM-GATE: plan ${h2} signed by alice and bob in the room \\(matched by tool_input\\.plan\\)`));
  assert.equal(entries(dir).length, before, 'the gate never logs; decision-log does, after the tool ran');

  // the documented fallback: the host clicks the usual dialog
  r = hook('gate-exitplan', exitPlan(v2, f), dir, { ROOM_GATE_CONFIRM: '1' });
  assert.equal(r.stdout, '');
  assert.equal(entries(dir).length, before);
});

test('gate matches by planFilePath when the injected plan text differs, and notes the mismatch', () => {
  const dir = tmpRoom();
  const f = writePlan(dir, '# Plan\r\nbody\r\n');
  hook('plan-publish', postWrite(f), dir);
  const h = room.hash12(fs.readFileSync(f));
  const text = '# Plan\nbody'; // e.g. the CLI normalized line endings
  sign(dir, 'alice', h);
  let r = hook('gate-exitplan', exitPlan(text, f), dir);
  assert.match(reason(r), new RegExp(`plan ${h} lacks sign-off from bob`));
  assert.match(reason(r), /matched by planFilePath/);
  assert.match(reason(r), new RegExp(`tool_input.plan hashes to ${room.hash12(text)}`));
  sign(dir, 'bob', h);
  const before = entries(dir).length;
  r = hook('gate-exitplan', exitPlan(text, f), dir);
  assert.equal(decision(r), 'allow');
  assert.match(reason(r), /matched by planFilePath\)\. \(Note: tool_input\.plan hashes to/);
  assert.equal(entries(dir).length, before);
});

// ---------- decision-log (PostToolUse ExitPlanMode) ----------

// Shape observed live on 2.1.281: tool_input is {} and the plan is in tool_response.
const exitedPlan = (plan, filePath, extra = {}) => common({
  hook_event_name: 'PostToolUse', permission_mode: 'default', tool_name: 'ExitPlanMode', tool_use_id: 'toolu_04',
  tool_input: {}, tool_response: { plan, isAgent: false, filePath }, ...extra,
});

test('decision-log writes kind:decision only after ExitPlanMode ran on the fully signed plan, once', () => {
  const dir = tmpRoom();
  const v1 = '# Plan\n\n1. ship it\n';
  const f = writePlan(dir, v1);
  hook('plan-publish', postWrite(f), dir);
  const h = room.hash12(v1);
  const a = sign(dir, 'alice', h);
  const b = sign(dir, 'bob', h);
  // PreToolUse approves but logs nothing; if the call never runs (dialog declined), no decision exists
  assert.equal(decision(hook('gate-exitplan', exitPlan(v1, f), dir)), 'allow');
  assert.ok(!entries(dir).some(e => e.kind === 'decision'));

  const r = hook('decision-log', exitedPlan(v1, f), dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  const d = entries(dir).at(-1);
  assert.deepEqual([d.kind, d.from, d.via, d.plan_hash, d.refs], ['decision', 'orch', 'agent', h, [a.id, b.id]]);
  assert.match(d.text, /matched by tool_response\.plan/);
  hook('decision-log', exitedPlan(v1, f), dir);
  assert.equal(entries(dir).filter(e => e.kind === 'decision').length, 1, 'one decision per plan_rev');
  hook('decision-log', exitedPlan(v1, f, { agent_id: 'a1', agent_type: 'seat-alice' }), dir);
  assert.equal(entries(dir).length, 4, 'subagents never log decisions');
});

test('decision-log records a status, not a decision, when the exited plan is unsigned or not the current plan', () => {
  const dir = tmpRoom();
  const v1 = '# Plan\n';
  const f = writePlan(dir, v1);
  hook('plan-publish', postWrite(f), dir);
  const h = room.hash12(v1);
  sign(dir, 'alice', h);
  hook('decision-log', exitedPlan(v1, f), dir); // e.g. ROOM_GATE_CONFIRM fallback misused, or hooks off
  let e = entries(dir).at(-1);
  assert.deepEqual([e.kind, e.via], ['status', 'agent']);
  assert.match(e.text, new RegExp(`^Plan mode exited on plan ${h}, but it lacks sign-off from bob\\. Not a room decision\\.$`));
  sign(dir, 'bob', h);
  hook('decision-log', exitedPlan('# Plan, edited in the dialog\n', path.join(dir, 'gone.md')), dir);
  e = entries(dir).at(-1);
  assert.equal(e.kind, 'status');
  assert.match(e.text, new RegExp(`does not match the current plan_rev ${h}`));
  assert.ok(!entries(dir).some(x => x.kind === 'decision'));
});

test('gate fails closed: empty ROOM_HUMANS, missing plan, unreadable log', () => {
  const dir = tmpRoom();
  assert.match(reason(hook('gate-exitplan', exitPlan('x'), dir, { ROOM_HUMANS: '' })), /ROOM_HUMANS is empty/);
  assert.equal(decision(hook('gate-exitplan', exitPlan(undefined), dir)), 'deny');
  fs.mkdirSync(path.join(dir, 'log.jsonl')); // a directory where the log should be
  const r = hook('gate-exitplan', exitPlan('x'), dir);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /gate hook failed/);
});

// ---------- guard-room ----------

const pre = (tool_name, tool_input, extra = {}) => common({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_03', ...extra });
const SEAT = { agent_id: 'a237333bf3b1276ea', agent_type: 'seat-alice' };

test('guard-room denies a seat writing demo/.room/x and allows the main thread', () => {
  const dir = tmpRoom();
  let r = hook('guard-room', pre('Write', { file_path: 'demo/.room/x', content: 'hi' }, SEAT), dir);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /^ROOM-GUARD: subagents may not write the room/);
  r = hook('guard-room', pre('Write', { file_path: 'demo/.room/x', content: 'hi' }), dir);
  assert.equal(r.stdout, '');
  assert.equal(r.code, 0);

  // absolute, traversal, ROOM_DIR, Edit, NotebookEdit, plan file
  for (const [tool, ti] of [
    ['Write', { file_path: path.join(REPO, 'demo', '.room', 'log.jsonl'), content: '' }],
    ['Edit', { file_path: 'demo/app/../.room/plans/p.md', old_string: 'a', new_string: 'b' }],
    ['Edit', { file_path: path.join(dir, 'roster.json'), old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: path.join(dir, 'n.ipynb'), new_source: 'x' }],
  ]) assert.equal(decision(hook('guard-room', pre(tool, ti, SEAT), dir)), 'deny', `${tool} ${JSON.stringify(ti)}`);
  // a seat editing its own files is fine
  assert.equal(hook('guard-room', pre('Edit', { file_path: 'demo/app/src/server.js', old_string: 'a', new_string: 'b' }, SEAT), dir).stdout, '');
});

test('guard-room Bash: denies room writes, room post/done, chat, ROOM_USER; allows read/digest', () => {
  const dir = tmpRoom();
  const denied = [
    'echo hi > demo/.room/x',
    'cat demo/.room/log.jsonl',
    'cd demo && rm -rf .room',
    'demo/bin/room post --kind say hello',
    'node demo/bin/room post hi',
    './room done',
    'demo/bin/room done all green',
    'demo/bin/chat',
    'printf "x\\n" | demo/bin/chat',
    'cd demo/bin; chat',
    'ROOM_USER=bob demo/bin/room read',
    `ls ${dir}`,
  ];
  for (const command of denied) {
    const r = hook('guard-room', pre('Bash', { command, description: 'x' }, SEAT), dir);
    assert.equal(decision(r), 'deny', command);
  }
  const allowed = [
    'demo/bin/room read --id 3',
    'demo/bin/room digest',
    'node demo/bin/room read --id 4,5 --json',
    'cd demo/app && npm test',
    'grep -rn "chat" demo/PROTOCOL.md',
    'cat demo/app/src/server.js',
    'git status',
  ];
  for (const command of allowed) {
    const r = hook('guard-room', pre('Bash', { command, description: 'x' }, SEAT), dir);
    assert.equal(r.stdout, '', command);
  }
  // the main thread may do all of it
  assert.equal(hook('guard-room', pre('Bash', { command: 'demo/bin/room post --kind directive --to alice go' }), dir).stdout, '');
});

// ---------- guard-send ----------

test('guard-send: seats may SendMessage only to main', () => {
  const dir = tmpRoom();
  let r = hook('guard-send', pre('SendMessage', { to: 'a99', message: 'hi bob', summary: 'x' }, SEAT), dir);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /only to "main"/);
  r = hook('guard-send', pre('SendMessage', { to: 'main', message: 'room tools failed' }, SEAT), dir);
  assert.equal(r.stdout, '');
  r = hook('guard-send', pre('SendMessage', { to: 'a237333bf3b1276ea', message: 'x' }), dir); // main thread
  assert.equal(r.stdout, '');
  r = hook('guard-send', pre('SendMessage', { to: 'other' }, { agent_id: 'h1', agent_type: 'general-purpose' }), dir);
  assert.equal(r.stdout, '', 'helpers are not seats');
});

// ---------- seat-register / guard-spawn / seat-park ----------

const spawnSeat = (type, extra = {}) => pre('Agent', { description: 'open seat', prompt: 'run the loop', subagent_type: type, run_in_background: true }, extra);
const start = (agent_id, agent_type, extra = {}) => common({ hook_event_name: 'SubagentStart', agent_id, agent_type, ...extra });
const stop = (agent_id, agent_type, extra = {}) => common({
  hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id, agent_type,
  agent_transcript_path: `/Users/x/.claude/projects/p/${SESSION}/subagents/agent-${agent_id}.jsonl`, last_assistant_message: 'ok', ...extra,
});
const roster = dir => JSON.parse(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8'));

test('seat-register records the roster, posts seat_up, and injects last seq + plan hash', () => {
  const dir = tmpRoom();
  const f = writePlan(dir, '# P\n');
  hook('plan-publish', postWrite(f), dir);
  post(dir, 'alice', { kind: 'proposal', text: 'earlier post by alice\'s Claude' });
  const r = hook('seat-register', start('aaa111', 'seat-alice'), dir);
  assert.equal(r.code, 0, r.stderr);
  const ctx = r.json.hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SubagentStart');
  assert.match(ctx.additionalContext, /Last handled seq: 2\. Call mcp__room__await_human with after_seq=2/);
  assert.match(ctx.additionalContext, new RegExp(`plan_hash=${room.hash12('# P\n')}`));
  const up = entries(dir).at(-1);
  assert.deepEqual([up.kind, up.from, up.via, up.agent_id], ['seat_up', 'alice', 'agent', 'aaa111']);
  const ro = roster(dir);
  assert.deepEqual([ro.alice.agent_id, ro.alice.live, ro.alice.up_id, ro.alice.session_id], ['aaa111', true, up.id, SESSION]);
  // the lib's digest reads this roster shape
  assert.match(withEnv({ ROOM_DIR: dir, ROOM_HUMANS: 'alice bob' }, () => room.digest()), /alice -> seat aaa111/);
  // non-seat subagents are ignored
  assert.equal(hook('seat-register', start('h1', 'general-purpose'), dir).stdout, '');
});

test('guard-spawn: one live seat per subagent_type', () => {
  const dir = tmpRoom();
  assert.equal(hook('guard-spawn', spawnSeat('seat-alice'), dir).stdout, '');
  let r = hook('guard-spawn', spawnSeat('seat-alice'), dir);
  assert.equal(decision(r), 'deny', 'a second spawn while the first is starting');
  assert.equal(hook('guard-spawn', spawnSeat('seat-bob'), dir).stdout, '', 'other seats are independent');
  hook('seat-register', start('aaa111', 'seat-alice'), dir);
  r = hook('guard-spawn', spawnSeat('seat-alice'), dir);
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /already running \(agent_id aaa111\)/);
  assert.equal(hook('guard-spawn', spawnSeat('general-purpose'), dir).stdout, '');
  assert.equal(hook('guard-spawn', spawnSeat('seat-alice', { agent_id: 'aaa111', agent_type: 'seat-alice' }), dir).stdout, '', 'subagent spawns are not checked here');
  // a roster from a crashed earlier session does not block
  assert.equal(hook('guard-spawn', { ...spawnSeat('seat-alice'), session_id: 'new-session' }, dir).stdout, '');
});

test('seat-park blocks, then allows on a shutdown entry or stop_hook_active; guard-spawn then allows a respawn', () => {
  const dir = tmpRoom();
  post(dir, 'orch', { kind: 'shutdown', text: 'old shutdown, before this seat started', to: 'alice' });
  hook('guard-spawn', spawnSeat('seat-alice'), dir);
  hook('seat-register', start('aaa111', 'seat-alice'), dir);
  hook('seat-register', start('bbb222', 'seat-bob'), dir);

  let r = hook('seat-park', stop('aaa111', 'seat-alice'), dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /call mcp__room__await_human again/);
  assert.equal(roster(dir).alice.live, true);

  r = hook('seat-park', stop('bbb222', 'seat-bob', { stop_hook_active: true }), dir);
  assert.equal(r.stdout, '', 'stop_hook_active lets the stop through');
  assert.equal(roster(dir).bob.live, false);

  post(dir, 'orch', { kind: 'shutdown', text: 'room closed', to: 'bob' });
  assert.equal(hook('seat-park', stop('aaa111', 'seat-alice'), dir).json.decision, 'block', 'a shutdown for bob does not stop alice');
  post(dir, 'orch', { kind: 'shutdown', text: 'room closed', to: 'alice' });
  r = hook('seat-park', stop('aaa111', 'seat-alice'), dir);
  assert.equal(r.stdout, '');
  assert.equal(roster(dir).alice.live, false);
  assert.match(roster(dir).alice.stop_reason, /^shutdown #/);

  assert.equal(hook('guard-spawn', spawnSeat('seat-alice'), dir).stdout, '', 'a stopped seat can be respawned');
  assert.equal(hook('seat-park', stop('h1', 'general-purpose'), dir).stdout, '', 'non-seats are never parked');
});

test('a SendMessage resume re-fires SubagentStart: the seat is live again and the old shutdown no longer stops it', () => {
  const dir = tmpRoom();
  hook('seat-register', start('aaa111', 'seat-alice'), dir);
  post(dir, 'orch', { kind: 'shutdown', text: 'room closed', to: 'alice' });
  assert.equal(hook('seat-park', stop('aaa111', 'seat-alice'), dir).stdout, '');
  assert.equal(roster(dir).alice.live, false);

  // resume: same agent_id (observed live on 2.1.281)
  const r = hook('seat-register', start('aaa111', 'seat-alice'), dir);
  assert.equal(r.code, 0, r.stderr);
  const up = entries(dir).at(-1);
  assert.deepEqual([up.kind, up.agent_id, up.text], ['seat_up', 'aaa111', 'seat-alice resumed (agent_id aaa111)']);
  assert.deepEqual([roster(dir).alice.live, roster(dir).alice.up_id], [true, up.id]);
  assert.equal(hook('seat-park', stop('aaa111', 'seat-alice'), dir).json.decision, 'block', 'the pre-resume shutdown is stale');

  // even if the roster was lost, the latest seat_up in the log is the start point
  fs.rmSync(path.join(dir, 'roster.json'));
  assert.equal(hook('seat-park', stop('aaa111', 'seat-alice'), dir).json.decision, 'block');
  post(dir, 'orch', { kind: 'shutdown', text: 'closed again', to: 'all' });
  assert.equal(hook('seat-park', stop('aaa111', 'seat-alice'), dir).stdout, '', 'a newer shutdown still ends it');
});

// ---------- compaction ----------

test('session-digest injects the digest (<= 9,500 chars) as SessionStart additionalContext', () => {
  const dir = tmpRoom();
  for (let i = 0; i < 80; i++) post(dir, 'bob', { kind: 'objection', text: 'y'.repeat(400) + i }, { via: 'human' });
  const r = hook('session-digest', common({ hook_event_name: 'SessionStart', source: 'compact' }), dir);
  assert.equal(r.code, 0, r.stderr);
  const ctx = r.json.hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /^ROOM DIGEST/);
  assert.ok(ctx.additionalContext.length <= 9500, String(ctx.additionalContext.length));
});

test('precompact-note prints plain-text summarizer rules with seat ids and the plan hash', () => {
  const dir = tmpRoom();
  const f = writePlan(dir, '# P\n');
  hook('plan-publish', postWrite(f), dir);
  hook('seat-register', start('aaa111', 'seat-alice'), dir);
  const r = hook('precompact-note', common({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }), dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /alice=aaa111/);
  assert.match(r.stdout, new RegExp(`plan=${room.hash12('# P\n')}`));
  assert.match(r.stdout, /Never paraphrase or re-type quoted human text/);
});

// ---------- settings ----------

test('room-settings.json wires every hook; the project settings carry no hooks', () => {
  const s = JSON.parse(fs.readFileSync(path.join(DEMO, 'room-settings.json'), 'utf8'));
  assert.equal(s.plansDirectory, 'demo/.room/plans');
  const want = {
    PreToolUse: { ExitPlanMode: 'gate-exitplan', 'Write|Edit|NotebookEdit|Bash': 'guard-room', SendMessage: 'guard-send', 'Agent|Task': 'guard-spawn' },
    PostToolUse: { 'Write|Edit': 'plan-publish', ExitPlanMode: 'decision-log' },
    SubagentStart: { 'seat-.*': 'seat-register' },
    SubagentStop: { 'seat-.*': 'seat-park' },
    SessionStart: { compact: 'session-digest' },
    PreCompact: { 'auto|manual': 'precompact-note' },
  };
  for (const [ev, byMatcher] of Object.entries(want)) {
    for (const [matcher, script] of Object.entries(byMatcher)) {
      const g = s.hooks[ev].find(x => x.matcher === matcher);
      assert.ok(g, `${ev} ${matcher}`);
      assert.equal(g.hooks[0].command, `node "$CLAUDE_PROJECT_DIR/demo/hooks/${script}.js"`);
      assert.ok(fs.existsSync(path.join(HOOKS, script + '.js')));
    }
  }
  assert.ok(new RegExp(`^(?:${'seat-.*'})$`).test('seat-alice'));
  assert.equal(s.hooks.UserPromptExpansion, undefined, '/say is gone: the host joins through demo/bin/chat');
  assert.ok(!fs.existsSync(path.join(HOOKS, 'say-post.js')));
  assert.doesNotMatch(fs.readFileSync(path.join(DEMO, 'room-settings.json'), 'utf8'), /ROOM_HOST_USER|say-post/);
  const project = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  assert.equal(project.hooks, undefined, 'hooks must stay out of .claude/settings.json');
});

test('room-settings allowlist: drops the seat prompts, and no rule lets a seat write demo/.room', () => {
  const s = JSON.parse(fs.readFileSync(path.join(DEMO, 'room-settings.json'), 'utf8'));
  const allow = s.permissions.allow;
  assert.equal(s.permissions.defaultMode, undefined, 'no bypassPermissions or other default mode');
  assert.doesNotMatch(JSON.stringify(s), /bypassPermissions|dangerously/i);
  for (const t of ['mcp__room__await_human', 'mcp__room__post', 'mcp__room__read']) assert.ok(allow.includes(t), t);
  for (const c of ['git status', 'git diff', 'git log', 'git show', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
    'node --test', 'npm test', 'npm --prefix demo/app test', 'demo/bin/room']) assert.ok(allow.includes(`Bash(${c}:*)`), c);

  // File rules: only demo/app. A Write/Edit pattern that reaches demo/.room (demo/**, **, .room...) fails.
  const fileRules = allow.filter(r => /^(Write|Edit|NotebookEdit|MultiEdit)\(/.test(r));
  assert.ok(fileRules.length >= 2);
  for (const r of fileRules) assert.match(r, /^(?:Write|Edit)\(demo\/app\/\*\*\)$/, r);
  assert.ok(!allow.some(r => /^(?:Write|Edit|NotebookEdit)$/.test(r)), 'no tool-wide file rule');

  // Bash rules: an exact list of read-only/test/room-CLI prefixes. No interpreters or shells
  // (node -e, sh -c, …), no bare Bash, no writers (tee, cp, mv, rm, echo, printf, sed -i).
  const bash = allow.filter(r => r.startsWith('Bash')).map(r => (/^Bash\((.*):\*\)$/.exec(r) || [])[1]);
  assert.ok(!bash.includes(undefined), 'every Bash rule is a prefix rule');
  const OK = new Set(['git status', 'git diff', 'git log', 'git show', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
    'node --test', 'npm test', 'npm --prefix demo/app test', 'demo/bin/room', 'node demo/bin/room']);
  for (const p of bash) assert.ok(OK.has(p), `unexpected Bash rule ${p}`);
  assert.ok(!allow.some(r => /^Bash\((?:node|sh|bash|zsh|env|npm|npx|git|echo|printf|tee|cp|mv|rm|sed|awk|xargs)(?::\*)?\)$/.test(r)));

  // The only allowed commands that write the room are `room post`/`room done`, and guard-room
  // denies those (and any command naming .room or the log) to every subagent.
  const dir = tmpRoom();
  for (const command of [
    'demo/bin/room post --kind say hi', 'node demo/bin/room post hi', 'demo/bin/room done ok',
    'cat demo/.room/log.jsonl', 'cat > demo/.room/log.jsonl', 'tail -n 5 demo/.room/roster.json', 'find demo/.room -name x',
    'grep -r x demo/.room', 'ls demo/.room/plans',
  ]) assert.equal(decision(hook('guard-room', pre('Bash', { command, description: 'x' }, SEAT), dir)), 'deny', command);
  for (const file_path of ['demo/.room/log.jsonl', 'demo/app/../.room/plans/p.md']) {
    assert.equal(decision(hook('guard-room', pre('Write', { file_path, content: 'x' }, SEAT), dir)), 'deny', file_path);
  }
});
