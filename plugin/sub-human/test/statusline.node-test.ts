// statusline/index.ts (agentStatusline) and statusline/segments.ts: the agent-panel rows. The main status
// line is gone (Phase 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import * as segments from '../statusline/segments.ts';
import * as index from '../statusline/index.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

const PLUGIN = path.join(import.meta.dirname, '..');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];
const { agentStatusline } = index;

const H = 'b7ca39aa0011';
const sleepers: ChildProcess[] = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

/** A fresh home and room; seats join through identity (session ids sid-<name>); the log is written by hand. */
function world(names: string[], { selfName }: { selfName?: string } = {}) {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-sl-'));
  const code = identity.newCode();
  for (const name of names) {
    const r = identity.join({ code, name: sn(name), role: name === 'claude' ? 'claude' : 'member', pid: name === selfName ? process.pid : sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  const file = path.join(identity.roomDir(code), 'log.jsonl');
  let id = 0;
  const add = (from: string, kind: string, extra: Record<string, unknown> = {}) => {
    id++;
    fs.appendFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), from, via: 'human', kind, text: 'x', to: 'room', ...extra }) + '\n');
    return id;
  };
  return { code, add, sys: (kind: string, extra?: Record<string, unknown>) => add('claude', kind, { via: 'system', ...extra }) };
}
const env = { NO_COLOR: '1' };

const prop = (approvers: string[]) => ({ via: 'human', hash: H, approvers, path: `plans/${H}.md` });
/** A statusline output line, parsed: a row's id and its label. */
const rowOf = (l: string) => JSON.parse(l) as { id: string; content: string };

test('statusline: only the agent-panel rows remain (no main status line)', () => {
  assert.deepEqual(Object.keys(index), ['agentStatusline']);
  // the removed exports, looked up by name to prove they are gone
  assert.equal((segments as Record<string, unknown>).statusline, undefined);
  assert.equal((segments as Record<string, unknown>).state, undefined);
});

test('agentStatusline: the one room row, found by its description (the room code), names who else is here; other tasks untouched; a killed room row', () => {
  const { code, add } = world(['claude', 'alice', 'bob', 'carol']);
  add('carol', 'proposal', prop(['alice', 'bob']));
  add('bob', 'objection', { proposal_hash: H });
  const tasks = [
    { id: 'r1', type: 'local_agent', status: 'running', description: code },
    { id: 'a2', type: 'local_agent', status: 'running', description: 'bob' },
    { id: 'a3', type: 'local_agent', status: 'running', description: 'run tests' },
    { id: 'r2', type: 'local_agent', status: 'killed', description: code },
  ];
  const out = agentStatusline({ session_id: 'sid-alice', tasks }, { env }).split('\n').map(rowOf);
  assert.deepEqual(out.map(o => o.id), ['r1', 'r2'], 'the room row only: an agent named after a member is not a row');
  assert.match(must(out[0]).content, new RegExp(`^${code}  ⚠ your answer needed b7ca39`));
  assert.equal(must(out[1]).content, `${code}  ⚠ room row stopped`);
  for (const o of out) assert.ok(Array.from(o.content).length <= code.length + 2 + rows.ROW_MAX);
  assert.equal(agentStatusline({ session_id: 'sid-alice', tasks: [tasks[2]] }, { env }), '', 'no row tasks: nothing');
  assert.equal(agentStatusline({ session_id: 'sid-nobody', tasks }, { env }), '');
  assert.equal(agentStatusline({}, { env }), '');
  const colored = rowOf(agentStatusline({ session_id: 'sid-alice', tasks: [{ id: 'r1', status: 'running', description: code }] }, { env: {} })).content;
  assert.match(colored, /\x1b\[33m⚠ your answer needed b7ca39\x1b\[0m/);
  const quiet = world(['claude', 'alice', 'bob', 'carol']);
  assert.equal(rowOf(agentStatusline({ session_id: 'sid-alice', tasks: [{ id: 'r1', status: 'running', description: quiet.code }] }, { env })).content,
    `${quiet.code}  bob, carol here`, 'who else is here, by name');
});

test('stage 8e I.7 (live verify, remote/16a): after this session left, its room row still gets a label ("you left"), never the row agent\'s own activity', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  identity.leave(code, sn('alice'));
  const tasks = [{ id: 'r1', status: 'running', description: code }];
  const out = agentStatusline({ session_id: 'sid-alice', tasks }, { env }).split('\n').filter(Boolean).map(rowOf);
  assert.deepEqual(out, [{ id: 'r1', content: `${code}  you left · /sub-human joins again` }]);
  assert.equal(agentStatusline({ session_id: 'sid-never', tasks }, { env }), '', 'a session that held no seat: nothing');
});

test('agentStatusline: falls back to process ancestry in a child process', () => {
  const { code, add } = world(['claude', 'alice'], { selfName: 'alice' });
  add('claude', 'proposal', { ...prop(['alice']), via: 'system' });
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(PLUGIN, 'statusline', 'index.ts'))}).agentStatusline({tasks: [{id: 'x', status: 'running', description: ${JSON.stringify(code)}}]}, {env: {NO_COLOR: '1'}}))`],
    { env: { ...process.env }, encoding: 'utf8' });
  assert.match(rowOf(r.stdout).content, new RegExp(`^${code}  ⚠ your answer needed b7ca39`));
});
