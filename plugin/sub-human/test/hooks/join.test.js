'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, hso, identity } = require('./helpers.js');

const expand = args => ({ ...fixture('user-prompt-expansion'), command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });

test('no args creates a room, joins as orch, prints the code and injects the role text', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000001';
  const r = w.hook('join', expand(''), { as: 'me' });
  assert.equal(r.code, 0, r.stderr);
  const m = /^room ([a-z]+-\d{4}) open · others join with: \/sub-human NAME \(or \/sub-human NAME \1\)$/.exec(r.json.systemMessage);
  assert.ok(m, r.json.systemMessage);
  const code = m[1];
  assert.equal(r.json.decision, undefined);
  const c = hso(r).additionalContext;
  assert.equal(hso(r).hookEventName, 'UserPromptExpansion');
  assert.ok(c.startsWith(`SUB-HUMAN role=orch name=orch room=${code}`), c.slice(0, 80));
  const orchMd = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'sub-human', 'orchestrator.md'), 'utf8').trim();
  assert.ok(c.includes(orchMd), 'the whole role text injected, unclipped');
  assert.match(c, /ROSTER\n- orch \(orchestrator\)/);
  assert.doesNotMatch(`${r.json.systemMessage}\n${c.split('\n\n')[1]}`, /watch|observer/i, 'no observer role in the invite');
  assert.match(c, /ROOM DIGEST/);
  w.code = code;
  assert.equal(w.members().orch.pid, process.pid);
  assert.equal(w.members().orch.role, 'orch');

  // already orch: re-print the same code, no new room
  const r2 = w.hook('join', expand(''), { as: 'me' });
  assert.match(r2.json.systemMessage, new RegExp(`room ${code} open`));
  assert.equal(fs.readdirSync(path.join(w.home, 'rooms')).length, 1);
});

test('NAME CODE joins as a member and logs member_joined via system', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000002';
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.systemMessage, new RegExp(`joined room ${w.code} as alice`));
  const c = hso(r).additionalContext;
  assert.ok(c.startsWith(`SUB-HUMAN role=member name=alice room=${w.code}`));
  assert.match(c, /- alice\b/);
  const es = w.entries();
  assert.equal(es.length, 1);
  assert.deepEqual([es[0].kind, es[0].from, es[0].via], ['member_joined', 'alice', 'system']);
  assert.equal(w.members().alice.session_id, w.sid.alice);
});

test('the bare command name "sub-human" is accepted too; other commands are ignored', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000003';
  const r = w.hook('join', { ...expand(`alice ${w.code}`), command_name: 'sub-human' }, { as: 'alice' });
  assert.match(r.json.systemMessage, /joined/);
  const r2 = w.hook('join', { ...expand(`bob ${w.code}`), command_name: 'other:thing' }, { as: 'alice' });
  assert.equal(r2.stdout, '');
});

test('failures block with a reason and log nothing', () => {
  const w = new World({ orch: 'sleep', alice: 'sleep' });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000004';
  const cases = [
    [`alice ${w.code}`, /name taken/],
    ['bob otter-0000', /no room otter-0000/],
    [`bob ${w.code} extra`, /usage/],
    [`bob ${w.code} watch`, /usage/],
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
});

test('a joined member cannot create a room, but joining another room switches to it', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  let r = w.hook('join', expand(''), { as: 'alice' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /already alice/);
  r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  assert.equal(r.json.decision, undefined, 'same name and room: idempotent');

  const oldCode = w.code;
  const newCode = w.lib(() => identity.newCode());
  r = w.hook('join', expand(`alice ${newCode}`), { as: 'alice' });
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.match(r.json.systemMessage, new RegExp(`joined room ${newCode} as alice`));
  const left = w.entries().at(-1);
  assert.deepEqual([left.kind, left.from, left.via], ['member_left', 'alice', 'system'], 'old room logs the departure');
  assert.ok(w.members().alice.left_at, 'old seat marked left');
  w.code = newCode;
  const joined = w.entries().at(-1);
  assert.deepEqual([joined.kind, joined.from], ['member_joined', 'alice'], 'new room logs the arrival');
  assert.ok(!w.members().alice.left_at);
  w.code = oldCode;
});

test('the orchestrator cannot switch rooms', () => {
  const w = new World({ orch: 'act' });
  const other = w.lib(() => identity.newCode());
  const r = w.hook('join', expand(`orchy ${other}`), { as: 'orch' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /orchestrator of room/);
});

test('the invite context carries ROWS from lib/rows.js rowCalls()', () => {
  const w = new World({ orch: 'sleep', bob: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000010';
  const r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  const c = hso(r).additionalContext;
  let rows;
  try { rows = require('../../lib/rows.js'); } catch { rows = null; }
  if (!rows) return; // rows.js (owner B) not written yet: join still works
  const want = String(rows.rowCalls({ code: w.code, name: 'alice', role: 'member' }, w.members()) || '').trim();
  assert.ok(want, 'rowCalls produced text');
  assert.ok(c.includes(`ROWS\n${want}`), c);
  assert.ok(c.indexOf('ROWS\n') < c.indexOf('ROSTER\n'));
});

test('NAME without CODE joins the only open room; 0 or several open rooms is an error listing codes', () => {
  const w = new World({}, { room: false });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000011';
  let r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /no room is open/);
  // A room whose orch is dead or gone is not open.
  const dead = w.lib(() => identity.newCode());
  w.lib(() => identity.join({ code: dead, name: 'orch', role: 'orch', pid: 999999, session_id: 'x' }));
  r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.match(r.json.reason, /no room is open/);
  w.code = w.lib(() => identity.newCode());
  w.join('orch', 'sleep');
  r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.match(r.json.systemMessage, new RegExp(`joined room ${w.code} as alice`));
  assert.equal(w.members().alice.pid, process.pid);
  // again without a code: already seated there, idempotent
  r = w.hook('join', expand('alice'), { as: 'alice' });
  assert.equal(r.json.decision, undefined);
  const first = w.code;
  w.code = w.lib(() => identity.newCode());
  w.join('orch', 'sleep');
  w.pid.bob = require('./helpers.js').sleeper(); w.sid.bob = 'aaaaaaaa-0000-4000-8000-000000000012';
  r = w.hook('join', expand('bob'), { as: 'bob' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /2 rooms are open/);
  assert.ok(r.json.reason.includes(first) && r.json.reason.includes(w.code), r.json.reason);
});

test('agent_type sub-human:orchestrator: /sub-human opens a room as orch; a name is refused', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000013';
  const input = { ...expand(''), agent_type: 'sub-human:orchestrator' };
  const r = w.hook('join', input, { as: 'me' });
  assert.match(r.json.systemMessage, /^room [a-z]+-\d{4} open/);
  assert.ok(hso(r).additionalContext.startsWith('SUB-HUMAN role=orch'));
  const r2 = w.hook('join', { ...expand('alice'), agent_type: 'sub-human:orchestrator' }, { as: 'me' });
  assert.equal(r2.json.decision, 'block');
  assert.match(r2.json.reason, /orchestrator agent/);
});

test('join marks presence "working"', () => {
  const w = new World({ orch: 'sleep' });
  w.pid.alice = process.pid; w.sid.alice = 'aaaaaaaa-0000-4000-8000-000000000014';
  w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  assert.equal(w.lib(() => identity.readPresence(w.code)).alice.state, 'working');
});
