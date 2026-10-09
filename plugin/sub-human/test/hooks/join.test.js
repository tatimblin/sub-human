'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { World, fixture, hso, identity, room, sleeper, withHome, PLUGIN } = require('./helpers.js');

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } return null; };
const bgCalls = s => s.calls().filter(c => c.argv.includes('--bg'));
const expand = args => ({ ...fixture('user-prompt-expansion'), command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });

/** A stub claude that records its argv / env / cwd and prints the --bg line. */
function stub(code = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}) + '\\n');\n` +
    `if (process.argv.includes('--bg')) console.log('backgrounded · 0b500131 · orch.' + ${JSON.stringify(code)});\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } } };
}

test('/sub-human NAME with no open room: opens a room, joins as a member, spawns the headless orch (detached) in the joiner\'s cwd', async () => {
  const w = new World({}, { room: false });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000001';
  const s = stub();
  const r = w.hook('join', expand('alice'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: PLUGIN } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.systemMessage, undefined, 'a join that worked shows no (warning-styled) systemMessage');
  const m = /in room ([a-z]+-\d{4})/.exec(hso(r).additionalContext);
  assert.ok(m, hso(r).additionalContext);
  w.code = m[1];
  assert.ok(['pending', '0b500131'].includes(w.members().orch.job), 'claimed before the hook returned');
  assert.ok(await until(() => w.members().orch.job === '0b500131'), 'the detached starter records members.json orch {job}');
  const ms = w.members();
  assert.equal(ms.alice.role, 'member');
  assert.equal(ms.orch.pid, null, 'pid filled when the orch binds');
  assert.equal(ms.orch.by, 'alice');
  const [call] = bgCalls(s);
  assert.equal(call.cwd, fs.realpathSync(w.cwd));
  assert.deepEqual(call.argv.slice(0, 5), ['--bg', '-n', `orch.${w.code}`, '--plugin-dir', PLUGIN]);
  const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]);
  // the joiner's timing overrides (the test env sets the reaper's to 0) ride along for the orch's own reaper
  assert.deepEqual(settings.env, {
    SUB_HUMAN_HOME: w.home, SUB_HUMAN_ROOM: w.code, CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0',
  });
  assert.equal(settings.crossSessionInbound, 'accept');
  assert.equal(Object.keys(call.env).filter(k => k.startsWith('CLAUDE')).length, 0, 'no CLAUDE_* reaches the orch');
  assert.equal(call.env.SUB_HUMAN_HOME, undefined, 'the orch env comes only from --settings');
  assert.equal(fs.existsSync(path.join(w.userHome, '.claude', 'tasks')), false, 'no sentinel file');
  const c = hso(r).additionalContext;
  assert.ok(c.startsWith(`SUB-HUMAN: you are alice's Claude in room ${w.code}`), c.slice(0, 80));
  assert.doesNotMatch(c, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
  assert.match(c, /\nROWS\n/);
  assert.match(c, /subagent_type: "sub-human:room"/);
  const es = w.entries();
  assert.deepEqual([es[0].kind, es[0].from, es[0].via], ['member_joined', 'alice', 'system']);
  // already seated: idempotent, no second room or orch
  const r2 = w.hook('join', expand('alice'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(r2.json.systemMessage, undefined);
  assert.match(hso(r2).additionalContext, /\(already joined\)$/);
  assert.equal(fs.readdirSync(path.join(w.home, 'rooms')).length, 1);
  assert.equal(bgCalls(s).length, 1);
});

test('the orch\'s launch /sub-human binds it (agent_type orchestrator + SUB_HUMAN_ROOM) and keeps the job', () => {
  const w = new World({ alice: 'sleep' });
  w.lib(() => identity.setOrch(w.code, { job: '0b500131', spawned_at: new Date().toISOString() }));
  w.pid.orch = process.pid; w.sid.orch = 'aaaaaaaa-0000-4000-8000-000000000002';
  const input = { ...expand(''), agent_type: 'sub-human:orchestrator', permission_mode: 'plan' };
  const r = w.hook('join', input, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.equal(r.json.systemMessage, undefined);
  const o = w.members().orch;
  assert.deepEqual([o.role, o.pid, o.job, o.session_id], ['orch', process.pid, '0b500131', w.sid.orch]);
  const c = hso(r).additionalContext;
  assert.ok(c.startsWith(`SUB-HUMAN: you are the headless helper of room ${w.code} (members: alice)`), c.slice(0, 100));
  assert.match(c, /subagent_type: "sub-human:participant", description: "alice"/);
  assert.equal(w.entries().length, 0, 'the orch logs no member_joined');
  const again = w.hook('join', input, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(again.json.systemMessage, undefined);
  assert.match(hso(again).additionalContext, /\(room already open\)$/);
  const named = w.hook('join', { ...expand('bob'), agent_type: 'sub-human:orchestrator' }, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(named.json.decision, 'block');
  assert.match(named.json.reason, /orchestrator agent/);
});

test('debug launch: an orchestrator-agent session without SUB_HUMAN_ROOM opens a room, or binds /sub-human CODE', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000003';
  const input = { ...expand(''), agent_type: 'sub-human:orchestrator' };
  const r = w.hook('join', input, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  const m = /headless helper of room ([a-z]+-\d{4})/.exec(hso(r).additionalContext);
  assert.ok(m && r.json.systemMessage === undefined, JSON.stringify(r.json));
  w.code = m[1];
  assert.equal(w.members().orch.pid, process.pid);
  const w2 = new World({ bob: 'sleep' });
  w2.pid.me = process.pid; w2.sid.me = 'aaaaaaaa-0000-4000-8000-000000000004';
  const r2 = w2.hook('join', { ...expand(w2.code), agent_type: 'sub-human:orchestrator' }, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  assert.equal(r2.json.systemMessage, undefined);
  assert.equal(w2.members().orch.pid, process.pid);
});

test('/sub-human with no name in a plain session explains usage; a seated member is told their seat', () => {
  const w = new World({ alice: 'act' });
  w.pid.me = w.pid.alice; // reuse a live pid that has no seat in another world
  const plain = new World({}, { room: false });
  plain.pid.me = process.ppid; plain.sid.me = 'aaaaaaaa-0000-4000-8000-000000000005';
  let r = plain.hook('join', expand(''), { as: 'me' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /usage: \/sub-human NAME \[CODE\].*never launched by hand/);
  assert.equal(fs.existsSync(path.join(plain.home, 'rooms')) ? fs.readdirSync(path.join(plain.home, 'rooms')).length : 0, 0, 'no room created');
  r = w.hook('join', expand(''), { as: 'alice' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, new RegExp(`you are alice in room ${w.code} \\(address alice\\.${w.code}\\)`));
});

test('NAME CODE joins a room whose orch runs: no spawn, no systemMessage; the block lists who is here', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000006';
  const s = stub(w.code);
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.systemMessage, undefined);
  assert.equal(s.calls().length, 0);
  const c = hso(r).additionalContext;
  assert.match(c, new RegExp(`room ${w.code} \\(with alice, orch\\)`));
  assert.ok(c.includes(`alice.${w.code}`), 'ADDR_EXAMPLE');
  assert.equal(w.members().bob.session_id, w.sid.bob);
});

test('joining a room with no live orch restarts it; a failed start is retried by the next join, which says why (a systemMessage)', async () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000007';
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob' }); // SUB_HUMAN_CLAUDE=/usr/bin/false
  assert.equal(r.json.decision, undefined);
  assert.equal(r.json.systemMessage, undefined, 'starting the orch is no trouble');
  assert.ok(await until(() => w.members().orch.spawn_error), 'the starter records the failure');
  assert.equal(w.members().orch.job, null);
  const s = stub(w.code);
  const r2 = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.match(r2.json.systemMessage, new RegExp(`^sub-human: in room ${w.code} as bob · starting the orch… \\(the last start failed: .+\\)$`));
  assert.ok(await until(() => w.members().orch.job === '0b500131'));
  assert.equal(bgCalls(s).length, 1);
  const r3 = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(r3.json.systemMessage, undefined, 'a job that has not bound yet is not restarted');
});

test('two concurrent joins start one orch: the second sees the pending claim', async () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = sleeper(); w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000015';
  w.pid.carol = sleeper(); w.sid.carol = 'aaaaaaaa-0000-4000-8000-000000000016';
  // The stub's dispatch waits for a gate file the test opens only after both hooks returned, so both joins
  // overlap the spawn whatever the load (a fixed 400 ms wait did not guarantee it, and timing bounds failed
  // under load), and every orch starter either join made is still running when they are counted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stub-'));
  const log = path.join(dir, 'calls.jsonl');
  const gate = path.join(dir, 'gate');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    `if (process.argv.includes('--bg')) { const z = new Int32Array(new SharedArrayBuffer(4)); for (let i = 0; i < 1200 && !fs.existsSync(${JSON.stringify(gate)}); i++) Atomics.wait(z, 0, 0, 25); console.log('backgrounded · 0b500131 · orch.x'); }\n`);
  fs.chmodSync(bin, 0o755);
  const starters = () => spawnSync('ps', ['-Ao', 'args'], { encoding: 'utf8' }).stdout.split('\n')
    .filter(l => l.includes(path.join('lib', 'orch.js')) && l.includes(` start ${w.code} `)).length;
  const { spawn: sp, spawnSync } = require('node:child_process');
  const { baseEnv, HOOKS } = require('./helpers.js');
  const run = who => new Promise(res => {
    w.modLease(w.sid[who]);
    const env = baseEnv({ SUB_HUMAN_HOME: w.home, HOME: w.userHome, CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_CLAUDE: bin, SUB_HUMAN_PLUGIN_DIR: '', CLAUDE_PID: String(w.pid[who]) });
    const p = sp(process.execPath, [path.join(HOOKS, 'join.js')], { env, cwd: w.cwd });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => res(JSON.parse(out)));
    p.stdin.end(JSON.stringify({ ...expand(`${who} ${w.code}`), cwd: w.cwd, session_id: w.sid[who] }));
  });
  // Both hooks return while the dispatch is held: they did not wait for the spawn.
  const [a, b] = await Promise.all([run('bob'), run('carol')]);
  assert.deepEqual([a.systemMessage, b.systemMessage], [undefined, undefined]);
  assert.equal(w.members().orch.job, 'pending', 'claimed, not yet recorded');
  // A join starts its starter (detached) before it returns, and the held dispatch keeps every starter running.
  assert.equal(starters(), 1, 'one starter: the second join saw the pending claim');
  fs.writeFileSync(gate, '');
  assert.ok(await until(() => w.members().orch.job === '0b500131', 30_000));
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.filter(c => c.includes('--bg')).length, 1, 'one spawn');
});

test('NAME without CODE ignores a room where only the orch is left, opens a new one, and sweeps the orphan', async () => {
  const w = new World({ orch: 'sleep' });
  const orphan = w.code;
  w.join('dave', 'sleep');
  w.lib(() => {
    // dave crashed long ago (pid dead, no SessionEnd): the orch observed the orphan 2 minutes ago
    const file = path.join(identity.roomDir(orphan), 'members.json');
    const ms = JSON.parse(fs.readFileSync(file, 'utf8'));
    ms.dave.pid = 999999; ms.dave.joined_at = new Date(Date.now() - 600_000).toISOString();
    ms.orch.job = 'feed0001'; ms.orch.orphan_since = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(ms));
  });
  assert.deepEqual(w.lib(() => identity.openRooms()), []);
  w.pid.erin = process.pid; w.sid.erin = 'aaaaaaaa-0000-4000-8000-000000000017';
  const r = w.hook('join', expand('erin'), { as: 'erin' });
  assert.equal(r.json.decision, undefined, r.json.reason);
  const m = /in room ([a-z]+-\d{4})/.exec(hso(r).additionalContext);
  assert.ok(m && m[1] !== orphan, hso(r).additionalContext);
  assert.ok(w.members().orch.closing, 'the orphan room was marked closing by the sweep');
});

test('bypass-permissions mode: the join systemMessage warns', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000008';
  const r = w.hook('join', { ...expand(`alice ${w.code}`), permission_mode: 'bypassPermissions' }, { as: 'alice' });
  assert.match(r.json.systemMessage, /⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog/);
});

test('the bare command name "sub-human" is accepted too; other commands are ignored', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000009';
  const r = w.hook('join', { ...expand(`alice ${w.code}`), command_name: 'sub-human' }, { as: 'alice' });
  assert.match(r.json.hookSpecificOutput.additionalContext, /^SUB-HUMAN: you are alice's Claude in room /);
  const r2 = w.hook('join', { ...expand(`bob ${w.code}`), command_name: 'other:thing' }, { as: 'alice' });
  assert.equal(r2.stdout, '');
});

test('without the hooks module\'s hello lease for the session the join is refused, and nothing is written', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000031';
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.equal(r.json.reason, 'sub-human needs Claude Code 2.1.292+ with function hooks on; not in --bare or safe mode');
  assert.equal(w.members().alice, undefined);
  assert.equal(w.entries().length, 0);
  // another session's lease does not count
  w.modLease('aaaaaaaa-0000-4000-8000-000000000032');
  assert.equal(w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false }).json.decision, 'block');
  // with its own lease it joins
  assert.match(w.hook('join', expand(`alice ${w.code}`), { as: 'alice' }).json.hookSpecificOutput.additionalContext, /^SUB-HUMAN: you are alice's Claude in room /);
});

/** Write sid's hello lease as mod-hello would have, at time `at`, for the claude process pid. */
function leaseAt(w, sid, pid, at) {
  const { pidStart } = require(path.join(PLUGIN, 'lib', 'lock.js'));
  const dir = path.join(w.home, 'sessions', 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const start = pidStart(pid);
  const rec = { session_id: sid, pid, ...(start != null ? { pid_start: start } : {}), at: new Date(at).toISOString(), seat: null };
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(rec));
  return path.join(dir, `${sid}.json`);
}

test('a resumed old session id with a stale lease cannot join; a lease from this claude process can, however old', async () => {
  const w = new World({ orch: 'sleep' });
  const old = Date.now() - 86_400_000; // a day: far past MOD_LEASE_FRESH_MS
  // the session's first process wrote the lease and is gone; `claude --resume SID` with the module off
  w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000041';
  leaseAt(w, w.sid.alice, await require('../helpers.js').deadPid(), old);
  w.pid.alice = sleeper();
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false });
  assert.equal(r.json.decision, 'block');
  assert.equal(r.json.reason, 'sub-human needs Claude Code 2.1.292+ with function hooks on; not in --bare or safe mode');
  assert.equal(w.members().alice, undefined);
  assert.equal(w.entries().length, 0);
  // the lease mod-hello wrote at this process's start, an hour ago
  leaseAt(w, w.sid.alice, w.pid.alice, old);
  assert.match(w.hook('join', expand(`alice ${w.code}`), { as: 'alice', modLease: false }).json.hookSpecificOutput.additionalContext, /^SUB-HUMAN: you are alice's Claude in room /);
});

test('join\'s sweep prunes hello leases whose process is gone', async () => {
  const w = new World({ orch: 'sleep', bob: 'sleep' });
  const live = leaseAt(w, 'aaaaaaaa-0000-4000-8000-000000000051', w.pid.bob, Date.now() - 3_600_000);
  const gone = leaseAt(w, 'aaaaaaaa-0000-4000-8000-000000000052', await require('../helpers.js').deadPid(), Date.now());
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000053';
  assert.match(w.hook('join', expand('alice'), { as: 'alice' }).json.hookSpecificOutput.additionalContext, /^SUB-HUMAN: you are alice's Claude in room /);
  assert.ok(fs.existsSync(live), 'a live process keeps its lease');
  assert.ok(!fs.existsSync(gone), 'a gone process\'s lease is pruned');
  assert.ok(fs.existsSync(path.join(w.home, 'sessions', 'mods', `${w.sid.alice}.json`)), 'the joiner keeps its own');
});

test('failures block with a reason and log nothing', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000010';
  const cases = [
    [`alice ${w.code}`, /name taken/],
    ['bob otter-0000', /no room otter-0000/],
    [`bob ${w.code} extra`, /usage/],
    [`orch ${w.code}`, /reserved/],
    [`b@d ${w.code}`, /invalid name/],
  ];
  for (const [args, re] of cases) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.decision, 'block', args);
    assert.match(r.json.reason, re, args);
  }
  assert.equal(w.entries().length, 0);
  // a closing room is not joined
  w.lib(() => identity.setOrch(w.code, { closing: new Date().toISOString() }));
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'me' });
  assert.match(r.json.reason, /is closing/);
});

test('/sub-human host: an invite to my room, shown to me only (a block), once per call; join NAME INVITE refuses what it cannot link', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000011';
  assert.match(w.hook('join', expand('host'), { as: 'me' }).json.reason, /join a room first/);
  const shown = w.hook('join', expand('host'), { as: 'alice' }).json;
  assert.equal(shown.decision, 'block');
  assert.deepEqual([shown.systemMessage, shown.hookSpecificOutput], [undefined, { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true }]);
  const invite = /sh2\.\S+/.exec(shown.reason)[0];
  assert.match(shown.reason, /\nPIN \d{6} /);
  const auth = require(path.join(PLUGIN, 'lib', 'remote', 'auth.js'));
  assert.deepEqual(auth.parseInvite(invite).code, w.code);
  assert.equal(auth.parseInvite(invite).locator, `pipe:${w.home}`, 'this machine, this home');
  assert.match(shown.reason, new RegExp(`/sub-human join NAME ${invite.replace(/[.]/g, '\\.')} PIN`));
  assert.notEqual(/sh2\.\S+/.exec(w.hook('join', expand('host'), { as: 'alice' }).json.reason)[0], invite, 'a new one each time');
  assert.match(w.hook('join', expand('host --frobnicate'), { as: 'alice' }).json.reason, /usage: \/sub-human host/);
  const inv = locator => auth.formatInvite({ code: 'vole-1234', locator, secret: 'x'.repeat(32) });
  const cases = [
    ['join bob', /usage/],
    ['join bob nonsense', /not an invite/],
    [`join bob ${invite} 123456`, /hosted on this machine/],
    [`join bob ${inv('tcp:far:22')}`, /through "tcp", which this machine does not support yet/],
    [`join bob ${inv('ssh:-oProxyCommand=sh@far')}`, /not a plain user@host\[:port\]/],
    [`join bob ${inv('ssh:me@far -oProxyCommand=sh')}`, /not a plain user@host\[:port\]/],
  ];
  for (const [args, re] of cases) assert.match(w.hook('join', expand(args), { as: 'me' }).json.reason, re, args);
  assert.deepEqual(fs.readdirSync(w.home).filter(d => d === 'links'), [], 'no link written');
  assert.equal(w.entries().length, 0);
});

test('a bad name with no open room creates nothing', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000011';
  for (const [args, re] of [['b@d', /invalid name/], ['room', /reserved/]]) {
    const r = w.hook('join', expand(args), { as: 'me' });
    assert.match(r.json.reason, re);
  }
  assert.equal(fs.existsSync(path.join(w.home, 'rooms')) ? fs.readdirSync(path.join(w.home, 'rooms')).length : 0, 0);
});

test('joining another room switches to it; the orch cannot switch rooms', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const oldCode = w.code;
  const newCode = w.lib(() => identity.newCode());
  let r = w.hook('join', expand(`alice ${newCode}`), { as: 'alice' });
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.match(hso(r).additionalContext, new RegExp(`in room ${newCode}`));
  // alice was the old room's last member: its detached reaper (grace 0 in tests) may already have appended its
  // "room closed" status after her departure, so the departure is the last entry that is not the reaper's.
  const orch = require(path.join(PLUGIN, 'lib', 'orch.js'));
  const left = w.entries().filter(e => !(e.kind === 'status' && e.text === orch.CLOSE_TEXT)).at(-1);
  assert.deepEqual([left.kind, left.from, left.via], ['member_left', 'alice', 'system'], 'old room logs the departure');
  assert.ok(w.members().alice.left_at, 'old seat marked left');
  w.code = newCode;
  assert.deepEqual([w.entries().at(-1).kind, w.entries().at(-1).from], ['member_joined', 'alice']);
  w.code = oldCode;

  const w2 = new World({ orch: 'act2' });
  const other = w2.lib(() => identity.newCode());
  r = w2.hook('join', expand(`orchy ${other}`), { as: 'orch' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /orch of room/);
});

test('NAME without CODE joins the only open room (one live seat is enough); several open rooms is an error', () => {
  const w = new World({}, { room: false });
  w.code = w.lib(() => identity.newCode());
  w.join('carol', 'sleep');
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000012';
  let r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.match(hso(r).additionalContext, new RegExp(`room ${w.code} \\(with carol`));
  const first = w.code;
  w.code = w.lib(() => identity.newCode());
  w.join('dave', 'sleep');
  w.pid.bob = sleeper(); w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000013';
  r = w.hook('join', expand('bob'), { as: 'bob' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /2 rooms are open/);
  assert.ok(r.json.reason.includes(first) && r.json.reason.includes(w.code), r.json.reason);
});

test('join marks presence "working"', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000014';
  w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  assert.equal(w.lib(() => room.open(w.code).store.kv.get('presence/alice')).state, 'working');
});

// ---------- the mechanics block (common.js contextBlock) ----------

/** contextBlock in-process, with templates from `root` (a stub plugin root) and a 5-member room. */
function blockFor(role, root) {
  const w = new World({ orch: 'sleep', alice: 'sleep', bob: 'sleep', carol: 'sleep', dave: 'sleep', erin: 'sleep' });
  const old = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) process.env.CLAUDE_PLUGIN_ROOT = root; else delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    return withHome(w.home, () => {
      const common = require('../../hooks/common.js');
      const name = role === 'orch' ? 'orch' : 'alice';
      return { text: common.contextBlock({ code: w.code, name, role }, 'joined'), code: w.code, common };
    });
  } finally { if (old === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = old; }
}

const STUB = {
  // the §2 example texts (~690 / ~720 chars), as templates
  'member.md': 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (members: {OTHERS}). {NAME} is the person typing here.\n'
    + 'Room lines are exact: `#12 bob [human]` is bob\'s own words, `[claude]` a Claude\'s. Quote them, cite #id.\n'
    + '{NAME}\'s prompts that start `@room` are posted as their words by a hook; nothing else can post as {NAME}.\n'
    + 'To reach a session now: SendMessage to {ADDR_EXAMPLE}; those come from Claudes.\n'
    + 'propose(text|path): asks named people to agree on a card. Never say {NAME} agrees.\n'
    + 'task(op): the room\'s task list (`{PLUGIN}/scripts/sub-human tasks`).',
  'orchestrator.md': 'SUB-HUMAN: you are the headless helper of room {CODE} (members: {OTHERS}). Nobody types here.\n'
    + 'Reach a member now: SendMessage to {ADDR_EXAMPLE}; post is a note read on their next turn.\n'
    + 'Facilitate only when asked: read {PLUGIN}/skills/sub-human/facilitate.md.',
};
function stubRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plugin-'));
  fs.mkdirSync(path.join(root, 'skills', 'sub-human'), { recursive: true });
  for (const [f, t] of Object.entries(STUB)) fs.writeFileSync(path.join(root, 'skills', 'sub-human', f), t);
  return root;
}

test('block: <= 900 chars with 5 members (stub templates), placeholders filled, ROWS carries the row call(s)', () => {
  const root = stubRoot();
  for (const role of ['member', 'orch']) {
    const { text, code, common } = blockFor(role, root);
    assert.ok(text.length <= common.BLOCK_MAX, `${role} block is ${text.length} chars:\n${text}`);
    assert.doesNotMatch(text, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
    assert.ok(text.includes(root), '{PLUGIN} filled');
    const calls = text.match(/^Agent\(\{.*\}\)$/gm) || [];
    if (role === 'member') {
      assert.match(text, new RegExp(`members: bob, carol, dave, erin, orch\\)`));
      assert.ok(text.includes(`bob.${code}`), 'ADDR_EXAMPLE = the first other human');
      assert.equal(calls.length, 1);
      assert.match(calls[0], /sub-human:room.*members: bob, carol, dave, erin/);
    } else {
      assert.match(text, /members: alice, bob, carol, dave, erin\)/);
      assert.match(text, /^Agent\(\{subagent_type: "sub-human:participant", description: "NAME", prompt: "member: NAME", run_in_background: true\}\)$/m);
      assert.match(text, /^NAME = alice, bob, carol, dave, erin$/m);
    }
  }
});

/**
 * The budget is about the template, not this checkout: the fill carries {PLUGIN} (this checkout's path, ~50 chars
 * on master, ~95 in a worktree) and {CODE} (a random animal of 4-7 letters). Measured raw, the same template passed
 * or failed with the path and the dice. So measure the worst case a user meets: the longest code and a marketplace
 * install path.
 */
const REF_PLUGIN = '/Users/someone/.claude/plugins/cache/sub-human/sub-human/1.0.0';
const LONGEST_CODE = `${identity.ANIMALS.reduce((a, b) => (b.length > a.length ? b : a))}-0000`;
const atReference = (text, code) => text.split(PLUGIN).join(REF_PLUGIN).split(code).join(LONGEST_CODE);

test('block: no template file (or one without placeholders) falls back to the built-in text; the shipped templates fill cleanly', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plugin-'));
  for (const role of ['member', 'orch']) {
    const { text, common } = blockFor(role, empty);
    assert.ok(text.startsWith('SUB-HUMAN: you are'), text.slice(0, 60));
    assert.ok(text.length <= common.BLOCK_MAX, `${role} default block is ${text.length}`);
    const got = blockFor(role, PLUGIN);
    const shipped = atReference(got.text, got.code);
    assert.doesNotMatch(shipped, /\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/);
    assert.match(shipped, /\nROWS\n/);
    // D's budget: the template fill <= 900 with 5 members, the whole block (with ROWS) <= 1,200
    assert.ok(shipped.split('\n\nROWS\n')[0].length <= 900, `${role} fill ${shipped.split('\n\nROWS\n')[0].length}`);
    assert.ok(shipped.length <= 1200, `${role} shipped block ${shipped.length}`);
  }
});

test('seatTitle is the native address NAME.CODE', () => {
  const common = require('../../hooks/common.js');
  assert.equal(common.seatTitle({ code: 'vole-8126', name: 'alice' }), 'alice.vole-8126');
});

test('a refused join is also the systemMessage (Remote Control shows that, not a block reason); an invite is the block reason only', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('join', expand('a b c'), { as: 'alice' });
  assert.equal(r.json.decision, 'block');
  assert.equal(r.json.systemMessage, r.json.reason);
  assert.match(r.json.reason, /usage: \/sub-human NAME/);
  const inv = w.hook('join', expand('host'), { as: 'alice' });
  assert.equal(inv.json.decision, 'block');
  assert.match(inv.json.reason, /invite to room /);
  assert.equal(inv.json.systemMessage, undefined, 'the invite stays off Remote Control');
});

test('the block lists the orch only while it runs or is starting: never one that never ran or whose start failed', () => {
  const w = new World({ alice: 'sleep', bob: 'sleep' });
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const others = rec => withHome(w.home, () => require('../../lib/room/members.js').orchPresence({ name: 'orch', role: 'orch', ...rec }, now));
  // the rule (lib/room/members.js orchPresence), from any machine
  assert.equal(others({ job: null, spawn_error: 'exit 1' }), null, 'a failed start (the harness stub)');
  assert.equal(others({}), null, 'never spawned');
  assert.equal(others({ job: 'pending', spawned_at: iso(now - 1000) }), 'starting');
  assert.equal(others({ job: 'pending', spawned_at: iso(now - 10 * 60_000) }), null, 'a stale claim');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 1000) }), 'starting', 'spawned, not bound yet');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 10 * 60_000), joined_at: iso(now - 9 * 60_000), seen_at: iso(now - 1000), machine: 'm-host' }), 'live', 'another machine\'s orch: its lease');
  assert.equal(others({ job: 'j1', spawned_at: iso(now - 10 * 60_000), joined_at: iso(now - 9 * 60_000), seen_at: iso(now - 5 * 60_000), machine: 'm-host' }), null, 'its lease ran out');
  assert.equal(others({ job: 'j1', closing: true, seen_at: iso(now), joined_at: iso(now) }), null);
  // the block itself: a room whose orch failed to start does not say "with … orch"
  withHome(w.home, () => identity.updateOrch(w.code, () => ({ name: 'orch', role: 'orch', job: null, spawn_error: 'exit 1', pid: null })));
  const text = withHome(w.home, () => require('../../hooks/common.js').contextBlock({ code: w.code, name: 'alice', role: 'member' }, 'rejoined'));
  assert.match(text, new RegExp(`room ${w.code} \\(with bob\\)`), text.slice(0, 120));
});
