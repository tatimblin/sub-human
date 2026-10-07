'use strict';
// The store guard's verdicts (mod/core/guard.mjs), against a real temp home on disk. The hooks that apply them
// in-process (mod/guard.mjs) are tested under `npm run test:mods` (mod/test/guard.test.ts); `decide` below does
// what they do, with node's realpath standing in for $.fs.stat's realPath. test/hooks/security.test.js has the
// full Bash table.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN } = require('./helpers.js');

let g;
test.before(async () => { g = await import(path.join(PLUGIN, 'mod', 'core', 'guard.mjs')); });

const real = p => { try { return fs.realpathSync(p); } catch { return undefined; } };
/** What mod/guard.mjs decides for one call: 'allow' | 'deny' | undefined (no opinion). */
function decide(tool, input, { w, seated = false, hello = true, agentId } = {}) {
  const ctx = hello ? { home: w.home, realHome: real(w.home), userHome: w.userHome, pluginRoot: PLUGIN } : {};
  if (tool.startsWith(g.MCP_PREFIX)) { const v = g.roomToolVerdict({ tool, agentId }, seated); return v ? v.decision : undefined; }
  if (tool === 'Bash') return g.bashVerdict(input.command, { ...ctx, cwd: w.cwd, realCwd: real(w.cwd) }) ? 'deny' : undefined;
  if (g.WRITE_TOOLS.includes(tool)) {
    const p = g.writeTarget(input);
    const abs = g.absTarget(p, { cwd: w.cwd, userHome: ctx.userHome });
    let placed;
    for (const a of abs ? g.ancestors(abs) : []) { const r = real(a); if (r) { placed = path.join(r, abs.slice(a.length)); break; } }
    return g.writeVerdict(abs ? [abs, placed] : [], ctx, p) ? 'deny' : undefined;
  }
  return undefined;
}

test('guard table', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const H = w.home;
  const realH = fs.realpathSync(H);
  const T = [
    // [tool, input, seated, expected decision]
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, true, 'allow'],
    ['mcp__plugin_sub-human_room__read', { ids: [1] }, true, 'allow'],
    ['mcp__plugin_sub-human_room__propose', { text: 'x' }, true, 'allow'],
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, false, undefined], // not joined: no opinion
    ['mcp__plugin_sub-human_room__hold', { member: 'bob' }, true, 'deny'], // main thread: never
    ['mcp__plugin_sub-human_room__task', { op: 'add', subject: 'x' }, true, 'allow'],
    ['Write', { file_path: path.join(H, 'rooms', w.code, 'log.jsonl'), content: 'x' }, true, 'deny'],
    ['Write', { file_path: path.join(realH, 'rooms', 'new.json'), content: 'x' }, false, 'deny'],
    ['Edit', { file_path: path.join(H, 'rooms', w.code, 'members.json'), old_string: 'a', new_string: 'b' }, true, 'deny'],
    ['MultiEdit', { file_path: path.join(H, 'sessions', 'x.json'), edits: [] }, true, 'deny'],
    ['NotebookEdit', { notebook_path: path.join(H, 'n.ipynb'), new_source: '' }, true, 'deny'],
    ['Write', { file_path: path.join(w.cwd, 'app.js'), content: 'x' }, true, undefined],
    ['Write', { file_path: 'app.js', content: 'x' }, true, undefined],
    ['Write', { file_path: path.join(w.cwd, '.sub-human-notes.md'), content: 'x' }, true, undefined],
    ['Bash', { command: `echo x >> ${H}/rooms/log.jsonl` }, true, 'deny'],
    ['Bash', { command: `node -e "require('${path.join(H, '..')}/x/sub-human/lib/room.js')"` }, true, 'deny'],
    ['Bash', { command: 'sub-human read' }, true, undefined],
    ['Bash', { command: 'npm test' }, false, undefined],
  ];
  for (const [tool, input, seated, want] of T) assert.equal(decide(tool, input, { w, seated }), want, `${tool} ${JSON.stringify(input)} seated=${seated}`);
});

test('guard: a write through a symlink into the home is denied, also into a directory not made yet', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const link = path.join(w.cwd, 'innocent');
  fs.symlinkSync(w.home, link);
  assert.equal(decide('Write', { file_path: path.join(link, 'rooms', w.code, 'log.jsonl'), content: 'x' }, { w }), 'deny');
  assert.equal(decide('Write', { file_path: path.join(link, 'new-dir', 'deeper', 'x.json'), content: 'x' }, { w }), 'deny');
  assert.equal(decide('Write', { file_path: 'innocent/x.json', content: 'x' }, { w }), 'deny');
});

test('guard: the default home ~/.sub-human is protected, by its path and before mod-hello by its spelling', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const dflt = { ...w, home: path.join(w.userHome, '.sub-human'), userHome: w.userHome, cwd: w.cwd };
  assert.equal(decide('Write', { file_path: '~/.sub-human/rooms/x', content: 'x' }, { w: dflt }), 'deny');
  assert.equal(decide('Write', { file_path: path.join(w.userHome, '.sub-human', 'rooms', 'x'), content: 'x' }, { w: dflt }), 'deny');
  assert.equal(decide('Write', { file_path: '~/.sub-human/rooms/x', content: 'x' }, { w, hello: false }), 'deny');
  assert.equal(decide('Bash', { command: 'cat ~/.sub-human/rooms/x/log.jsonl' }, { w, hello: false }), 'deny');
});

test('guard: hold is allowed for row subagents only', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  assert.equal(decide('mcp__plugin_sub-human_room__hold', { room: w.code }, { w, seated: true, agentId: 'a1' }), 'allow');
  assert.equal(decide('mcp__plugin_sub-human_room__hold', { room: w.code }, { w, seated: false }), 'deny');
});
