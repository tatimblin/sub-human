'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, hso } = require('./helpers.js');

const expand = args => ({ ...fixture('user-prompt-expansion'), command_args: args, prompt: `/sub-human:sub-human ${args}`.trim() });

test('no args creates a room, joins as orch, prints the code and injects the role text', () => {
  const w = new World({}, { room: false });
  w.pid.me = process.pid; w.sid.me = 'aaaaaaaa-0000-4000-8000-000000000001';
  const r = w.hook('join', expand(''), { as: 'me' });
  assert.equal(r.code, 0, r.stderr);
  const m = /sub-human room ([a-z]+-\d{4})\. Others join with: \/sub-human NAME \1/.exec(r.json.systemMessage);
  assert.ok(m, r.json.systemMessage);
  const code = m[1];
  assert.equal(r.json.decision, undefined);
  const c = hso(r).additionalContext;
  assert.equal(hso(r).hookEventName, 'UserPromptExpansion');
  assert.ok(c.startsWith(`SUB-HUMAN role=orch name=orch room=${code}`), c.slice(0, 80));
  const orchMd = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'sub-human', 'orchestrator.md'), 'utf8').trim();
  assert.ok(c.includes(orchMd.slice(0, 200)), 'role text injected');
  assert.match(c, /ROSTER\n- orch \(orchestrator\)/);
  assert.match(c, /ROOM DIGEST/);
  w.code = code;
  assert.equal(w.members().orch.pid, process.pid);
  assert.equal(w.members().orch.role, 'orch');

  // already orch: re-print the same code, no new room
  const r2 = w.hook('join', expand(''), { as: 'me' });
  assert.match(r2.json.systemMessage, new RegExp(`room ${code}\\.`));
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
    [`bob`, /usage/],
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
});

test('a joined member cannot create or join another room from the same session', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  let r = w.hook('join', expand(''), { as: 'alice' });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /already alice/);
  r = w.hook('join', expand(`alice ${w.code}`), { as: 'alice' });
  assert.equal(r.json.decision, undefined, 'same name and room: idempotent');
});
