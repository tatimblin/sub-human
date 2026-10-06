'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { World, fixture, hso, identity, sleeper, withHome, PLUGIN } = require('./helpers.js');

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

test('/sub-human NAME with no open room: opens a room, joins as a member, spawns the headless orch in the joiner\'s cwd', () => {
  const w = new World({}, { room: false });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000001';
  const s = stub();
  const r = w.hook('join', expand('alice'), { as: 'alice', env: { SUB_HUMAN_CLAUDE: s.bin, SUB_HUMAN_PLUGIN_DIR: PLUGIN } });
  assert.equal(r.code, 0, r.stderr);
  const m = /^sub-human: opened room ([a-z]+-\d{4}) as alice · others: \/sub-human NAME$/.exec(r.json.systemMessage);
  assert.ok(m, r.json.systemMessage);
  w.code = m[1];
  const ms = w.members();
  assert.equal(ms.alice.role, 'member');
  assert.equal(ms.orch.job, '0b500131', 'members.json orch {job}');
  assert.equal(ms.orch.pid, null, 'pid filled when the orch binds');
  const [call] = s.calls();
  assert.equal(call.cwd, fs.realpathSync(w.cwd));
  assert.deepEqual(call.argv.slice(0, 5), ['--bg', '-n', `orch.${w.code}`, '--plugin-dir', PLUGIN]);
  const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]);
  assert.deepEqual(settings.env, { SUB_HUMAN_HOME: w.home, SUB_HUMAN_ROOM: w.code, CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
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
  assert.match(r2.json.systemMessage, new RegExp(`in room ${w.code} as alice`));
  assert.equal(fs.readdirSync(path.join(w.home, 'rooms')).length, 1);
  assert.equal(s.calls().length, 1);
});

test('the orch\'s launch /sub-human binds it (agent_type orchestrator + SUB_HUMAN_ROOM) and keeps the job', () => {
  const w = new World({ alice: 'sleep' });
  w.lib(() => identity.setOrch(w.code, { job: '0b500131', spawned_at: new Date().toISOString() }));
  w.pid.orch = process.pid; w.sid.orch = 'aaaaaaaa-0000-4000-8000-000000000002';
  const input = { ...expand(''), agent_type: 'sub-human:orchestrator', permission_mode: 'plan' };
  const r = w.hook('join', input, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.equal(r.json.systemMessage, `sub-human: orch of room ${w.code}`);
  const o = w.members().orch;
  assert.deepEqual([o.role, o.pid, o.job, o.session_id], ['orch', process.pid, '0b500131', w.sid.orch]);
  const c = hso(r).additionalContext;
  assert.ok(c.startsWith(`SUB-HUMAN: you are the headless helper of room ${w.code} (members: alice)`), c.slice(0, 100));
  assert.match(c, /subagent_type: "sub-human:participant", description: "alice"/);
  assert.equal(w.entries().length, 0, 'the orch logs no member_joined');
  const again = w.hook('join', input, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(again.json.systemMessage, `sub-human: orch of room ${w.code}`);
  const named = w.hook('join', { ...expand('bob'), agent_type: 'sub-human:orchestrator' }, { as: 'orch', env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(named.json.decision, 'block');
  assert.match(named.json.reason, /orchestrator agent/);
});

test('debug launch: an orchestrator-agent session without SUB_HUMAN_ROOM opens a room, or binds /sub-human CODE', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000003';
  const input = { ...expand(''), agent_type: 'sub-human:orchestrator' };
  const r = w.hook('join', input, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  const m = /^sub-human: room ([a-z]+-\d{4}) open · others join with: \/sub-human NAME \1$/.exec(r.json.systemMessage);
  assert.ok(m, r.json.systemMessage);
  w.code = m[1];
  assert.equal(w.members().orch.pid, process.pid);
  const w2 = new World({ bob: 'sleep' });
  w2.pid.me = process.pid; w2.sid.me = 'aaaaaaaa-0000-4000-8000-000000000004';
  const r2 = w2.hook('join', { ...expand(w2.code), agent_type: 'sub-human:orchestrator' }, { as: 'me', env: { SUB_HUMAN_ROOM: undefined } });
  assert.equal(r2.json.systemMessage, `sub-human: orch of room ${w2.code}`);
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

test('NAME CODE joins a room whose orch runs: no spawn; the message lists who is here', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000006';
  const s = stub(w.code);
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.systemMessage, `sub-human: joined ${w.code} as bob (orch, alice here)`);
  assert.equal(s.calls().length, 0);
  const c = hso(r).additionalContext;
  assert.match(c, new RegExp(`room ${w.code} \\(with alice, orch\\)`));
  assert.ok(c.includes(`alice.${w.code}`), 'ADDR_EXAMPLE');
  assert.equal(w.members().bob.session_id, w.sid.bob);
});

test('joining a room with no live orch restarts it; a failed spawn still joins and says "no orch"', () => {
  const w = new World({ alice: 'sleep' });
  w.pid.bob = process.pid; w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000007';
  const r = w.hook('join', expand(`bob ${w.code}`), { as: 'bob' }); // SUB_HUMAN_CLAUDE=/usr/bin/false
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /^sub-human: joined [a-z]+-\d{4} as bob \(alice here\) · no orch \(.*\); \/sub-human still works/);
  const s = stub(w.code);
  const r2 = w.hook('join', expand(`bob ${w.code}`), { as: 'bob', env: { SUB_HUMAN_CLAUDE: s.bin } });
  assert.doesNotMatch(r2.json.systemMessage, /no orch/);
  assert.equal(s.calls().length, 1);
  assert.equal(w.members().orch.job, '0b500131');
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
  assert.match(r.json.systemMessage, /joined/);
  const r2 = w.hook('join', { ...expand(`bob ${w.code}`), command_name: 'other:thing' }, { as: 'alice' });
  assert.equal(r2.stdout, '');
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
  assert.match(r.json.systemMessage, new RegExp(`joined ${newCode} as alice`));
  const left = w.entries().at(-1);
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
  assert.match(r.json.systemMessage, new RegExp(`joined ${w.code} as alice \\(carol here\\)`));
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
  assert.equal(w.lib(() => identity.readPresence(w.code)).alice.state, 'working');
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
    + 'task(op): the room\'s task list (`{PLUGIN}/bin/sub-human tasks`).',
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

test('block: no template file (or one without placeholders) falls back to the built-in text; the shipped templates fill cleanly', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-plugin-'));
  for (const role of ['member', 'orch']) {
    const { text, common } = blockFor(role, empty);
    assert.ok(text.startsWith('SUB-HUMAN: you are'), text.slice(0, 60));
    assert.ok(text.length <= common.BLOCK_MAX, `${role} default block is ${text.length}`);
    const shipped = blockFor(role, PLUGIN).text;
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
