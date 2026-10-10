'use strict';
// statusline/index.ts (agentStatusline) and statusline/segments.ts: the agent-panel rows. The main status
// line is gone (Phase 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];
const identity = require(path.join(PLUGIN, 'lib', 'identity.ts'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.ts'));
const segments = require(path.join(PLUGIN, 'statusline', 'segments.ts'));
const index = require(path.join(PLUGIN, 'statusline', 'index.ts'));
const { agentStatusline } = index;

const H = 'b7ca39aa0011';
const sleepers = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

/** A fresh home and room; seats join through identity (session ids sid-<name>); the log is written by hand. */
function world(names, { selfName } = {}) {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-sl-'));
  const code = identity.newCode();
  for (const name of names) {
    const r = identity.join({ code, name, role: name === 'claude' ? 'claude' : 'member', pid: name === selfName ? process.pid : sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  const file = path.join(identity.roomDir(code), 'log.jsonl');
  let id = 0;
  const add = (from, kind, extra = {}) => {
    id++;
    fs.appendFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), from, via: 'human', kind, text: 'x', to: 'room', ...extra }) + '\n');
    return id;
  };
  return { code, add, sys: (kind, extra) => add('claude', kind, { via: 'system', ...extra }) };
}
const env = { NO_COLOR: '1' };

const prop = approvers => ({ via: 'human', hash: H, approvers, path: `plans/${H}.md` });

test('statusline: only the agent-panel rows remain (no main status line)', () => {
  assert.deepEqual(Object.keys(index), ['agentStatusline']);
  assert.equal(segments.statusline, undefined);
  assert.equal(segments.state, undefined);
});

test('agentStatusline: claude rows by the row map, else by description; other tasks untouched; killed rows', () => {
  const { code, add } = world(['claude', 'alice', 'bob']);
  add('alice', 'proposal', prop(['alice', 'bob']));
  add('alice', 'signoff', { proposal_hash: H });
  fs.writeFileSync(path.join(identity.roomDir(code), 'tasks.json'), JSON.stringify([{ id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob' }]));
  rows.recordRow(code, 'sid-claude', 'a1', { kind: 'participant', name: 'alice', parent: null });
  const tasks = [
    { id: 'a1', type: 'local_agent', status: 'running', description: 'alice watcher' },
    { id: 'a2', type: 'local_agent', status: 'running', description: 'bob' },
    { id: 'a3', type: 'local_agent', status: 'running', description: 'run tests' },
    { id: 'a4', type: 'local_agent', status: 'killed', description: 'bob' },
    { id: 'a5', type: 'local_agent', status: 'running', description: 'claude' },
  ];
  const out = agentStatusline({ session_id: 'sid-claude', tasks }, { env }).split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out, [
    { id: 'a1', content: 'alice  ✓ agreed b7ca39' },
    { id: 'a2', content: 'bob  ⚠ reviewing b7ca39 · ◼ #2 parser tests' },
    { id: 'a4', content: 'bob  ⚠ row stopped' },
  ]);
  assert.equal(agentStatusline({ session_id: 'sid-claude', tasks: [tasks[2]] }, { env }), '', 'no row tasks: nothing');
  assert.equal(agentStatusline({ session_id: 'sid-nobody', tasks }, { env }), '');
  assert.equal(agentStatusline({}, { env }), '');
});

test('agentStatusline: a member\'s room row and the nested rows inside it (after /clear changed the session id)', () => {
  const { code, add } = world(['claude', 'alice', 'bob', 'carol']);
  add('carol', 'proposal', prop(['alice', 'bob']));
  add('bob', 'objection', { proposal_hash: H });
  rows.recordRow(code, 'old-session', 'r1', { kind: 'room', name: code, parent: null });
  rows.recordRow(code, 'old-session', 'c1', { kind: 'participant', name: 'bob', parent: 'r1' });
  rows.recordRow(code, 'old-session', 'c2', { kind: 'participant', name: 'carol', parent: 'r1' });
  const tasks = [
    { id: 'r1', status: 'running', description: code },
    { id: 'c1', status: 'running', description: 'bob' },
    { id: 'c2', status: 'killed', description: 'carol' },
  ];
  const out = agentStatusline({ session_id: 'sid-alice', tasks }, { env }).split('\n').map(l => JSON.parse(l));
  assert.match(out[0].content, new RegExp(`^${code}  ⚠ your answer needed b7ca39`));
  assert.deepEqual(out.slice(1), [
    { id: 'c1', content: 'bob  ✖ objected' },
    { id: 'c2', content: 'carol  (reconnecting)' },
  ]);
  for (const o of out) assert.ok(Array.from(o.content).length <= code.length + 2 + rows.ROW_MAX);
  identity.leave(code, 'carol');
  assert.equal(JSON.parse(agentStatusline({ session_id: 'sid-alice', tasks: [tasks[2]] }, { env })).content, 'carol  left');
  const colored = JSON.parse(agentStatusline({ session_id: 'sid-alice', tasks: [tasks[0]] }, { env: {} })).content;
  assert.match(colored, /\x1b\[33m⚠ your answer needed b7ca39\x1b\[0m/);
});

test('agentStatusline: falls back to process ancestry in a child process', () => {
  const { code, add } = world(['claude', 'alice'], { selfName: 'alice' });
  add('claude', 'proposal', { ...prop(['alice']), via: 'system' });
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(PLUGIN, 'statusline', 'index.ts'))}).agentStatusline({tasks: [{id: 'x', status: 'running', description: ${JSON.stringify(code)}}]}, {env: {NO_COLOR: '1'}}))`],
    { env: { ...process.env }, encoding: 'utf8' });
  assert.match(JSON.parse(r.stdout).content, new RegExp(`^${code}  ⚠ your answer needed b7ca39`));
});
