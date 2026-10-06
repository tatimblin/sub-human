'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, decision } = require('./helpers.js');


const pre = (tool_name, tool_input) => ({ ...fixture('pre-mcp'), tool_name, tool_input, mcp_server: undefined });

test('guard table', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const H = w.home;
  const real = fs.realpathSync(H);
  const T = [
    // [tool, input, as, expected decision]
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__read', { ids: [1] }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__propose', { text: 'x' }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, null, undefined], // not joined: no opinion
    ['mcp__plugin_sub-human_room__hold', { member: 'bob' }, 'alice', 'deny'], // main thread: never
    ['mcp__plugin_sub-human_room__task', { op: 'add', subject: 'x' }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__read', {}, 'alice', 'allow'],
    ['Write', { file_path: path.join(H, 'rooms', w.code, 'log.jsonl'), content: 'x' }, 'alice', 'deny'],
    ['Write', { file_path: path.join(real, 'rooms', 'new.json'), content: 'x' }, null, 'deny'],
    ['Edit', { file_path: path.join(H, 'rooms', w.code, 'members.json'), old_string: 'a', new_string: 'b' }, 'alice', 'deny'],
    ['MultiEdit', { file_path: path.join(H, 'sessions', 'x.json'), edits: [] }, 'alice', 'deny'],
    ['NotebookEdit', { notebook_path: path.join(H, 'n.ipynb'), new_source: '' }, 'alice', 'deny'],
    ['Write', { file_path: path.join(w.cwd, 'app.js'), content: 'x' }, 'alice', undefined],
    ['Write', { file_path: path.join(w.cwd, '.sub-human-notes.md'), content: 'x' }, 'alice', undefined],
    ['Bash', { command: `echo x >> ${H}/rooms/log.jsonl` }, 'alice', undefined], // Bash is not guarded any more
    ['Bash', { command: 'sub-human read' }, 'alice', undefined],
  ];
  for (const [tool, input, as, want] of T) {
    const r = w.hook('guard', pre(tool, input), as ? { as } : {});
    assert.equal(r.code, 0, r.stderr);
    assert.equal(decision(r), want, `${tool} ${JSON.stringify(input)} as ${as}`);
  }
});

test('guard: the default home ~/.sub-human is protected too', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('guard', pre('Write', { file_path: '~/.sub-human/rooms/x', content: 'x' }), { as: 'alice', env: { SUB_HUMAN_HOME: undefined } });
  assert.equal(decision(r), 'deny');
  const r2 = w.hook('guard', pre('Write', { file_path: path.join(w.userHome, '.sub-human', 'rooms', 'x'), content: 'x' }), { env: { SUB_HUMAN_HOME: undefined } });
  assert.equal(decision(r2), 'deny');
});

test('guard: hold is allowed for row subagents only', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const r = w.hook('guard', { ...pre('mcp__plugin_sub-human_room__hold', { room: w.code }), agent_id: 'a1', agent_type: 'sub-human:room' }, { as: 'alice' });
  assert.equal(decision(r), 'allow');
});
