'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, decision, PLUGIN } = require('./helpers.js');

const BIN = path.join(PLUGIN, 'bin', 'sub-human');

const pre = (tool_name, tool_input) => ({ ...fixture('pre-mcp'), tool_name, tool_input, mcp_server: undefined });

test('guard table', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const H = w.home;
  const real = fs.realpathSync(H);
  const T = [
    // [tool, input, as, expected decision]
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__read', { ids: [1] }, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__plan', {}, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, null, undefined], // not joined: no opinion
    ['Bash', { command: 'sub-human read' }, null, 'allow'],
    ['Bash', { command: 'sub-human read --id 3,4' }, 'alice', 'allow'],
    ['Bash', { command: 'sub-human digest' }, 'alice', 'allow'],
    ['Bash', { command: 'sub-human who' }, 'alice', 'allow'],
    ['Bash', { command: 'sub-human plan' }, 'alice', 'allow'],
    ['Bash', { command: 'sub-human plan abcdef012345' }, 'alice', 'allow'],
    ['Bash', { command: 'sub-human watch bob' }, 'alice', 'allow'],
    ['Bash', { command: `${BIN} digest` }, 'alice', 'allow'],
    ['Bash', { command: `"${BIN}" watch bob` }, 'alice', 'allow'],
    ['Bash', { command: '/tmp/evil/bin/sub-human digest' }, 'alice', undefined],
    ['Bash', { command: 'sub-human watch bob; rm x' }, 'alice', undefined],
    ['Bash', { command: 'sub-human plan $(rm x)' }, 'alice', undefined],
    ['mcp__plugin_sub-human_room__hold', { member: 'bob' }, 'alice', 'deny'], // main thread: never
    ['mcp__plugin_sub-human_room__review', {}, 'alice', 'allow'],
    ['mcp__plugin_sub-human_room__watch', {}, 'alice', 'allow'],
    ['Bash', { command: 'sub-human read --id 3; rm -rf /' }, 'alice', undefined],
    ['Bash', { command: 'sub-human post hi' }, 'alice', undefined],
    ['Bash', { command: 'sub-human who && echo x' }, 'alice', undefined],
    ['Bash', { command: 'ls' }, 'alice', undefined],
    ['Bash', { command: 'npm test' }, null, undefined],
    ['Bash', { command: `echo x >> ${H}/rooms/log.jsonl` }, 'alice', 'deny'],
    ['Bash', { command: `cat ${real}/rooms/x` }, 'alice', 'deny'],
    ['Bash', { command: 'echo hi >> ~/.sub-human/rooms/otter-1/log.jsonl' }, 'alice', 'deny'],
    ['Bash', { command: 'SUB_HUMAN_HOME=/tmp/x sub-human who' }, 'alice', 'deny'],
    ['Write', { file_path: path.join(H, 'rooms', w.code, 'log.jsonl'), content: 'x' }, 'alice', 'deny'],
    ['Write', { file_path: path.join(real, 'rooms', 'new.json'), content: 'x' }, null, 'deny'],
    ['Edit', { file_path: path.join(H, 'rooms', w.code, 'members.json'), old_string: 'a', new_string: 'b' }, 'alice', 'deny'],
    ['MultiEdit', { file_path: path.join(H, 'sessions', 'x.json'), edits: [] }, 'alice', 'deny'],
    ['NotebookEdit', { notebook_path: path.join(H, 'n.ipynb'), new_source: '' }, 'alice', 'deny'],
    ['Write', { file_path: path.join(w.cwd, 'app.js'), content: 'x' }, 'alice', undefined],
    ['Write', { file_path: path.join(w.cwd, '.sub-human-notes.md'), content: 'x' }, 'alice', undefined],
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
