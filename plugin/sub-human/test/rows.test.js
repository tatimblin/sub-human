'use strict';
// lib/rows.js: rowCalls text, spawn parsing, the row map, and deterministic row text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..');
const rows = require(path.join(PLUGIN, 'lib', 'rows.js'));

/** A room written by hand (members.json + log.jsonl), independent of the identity / room writers. */
function makeRoom(members, entries = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rows-'));
  process.env.SUB_HUMAN_HOME = home;
  const code = 'marmot-2509';
  const dir = path.join(home, 'rooms', code);
  fs.mkdirSync(dir, { recursive: true });
  const ms = {};
  for (const m of members) ms[m.name] = { role: m.name === 'orch' ? 'orch' : 'member', joined_at: new Date(0).toISOString(), ...m };
  fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  const log = entries.map((e, i) => JSON.stringify({ id: i + 1, at: new Date(Date.now() - (entries.length - i) * 1000).toISOString(), via: 'agent', to: 'room', text: 'x', ...e }));
  fs.writeFileSync(path.join(dir, 'log.jsonl'), log.join('\n') + (log.length ? '\n' : ''));
  return { home, code, dir, ms };
}
const H = '593da0aaaaaa';
const plan = (approvers, hash = H) => ({ kind: 'plan_rev', via: 'system', from: 'orch', plan_hash: hash, approvers });
const human = (from, kind, extra = {}) => ({ via: 'human', from, kind, plan_hash: H, ...extra });

test('rowCalls: orch gets one participant call per active member; none for orch or left members', () => {
  const { ms, code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }, { name: 'carol', left_at: 'x' }]);
  const t = rows.rowCalls({ code, name: 'orch', role: 'orch' }, ms);
  assert.match(t, /Agent\(\{subagent_type: "sub-human:participant", description: "alice", prompt: "member: alice", run_in_background: true\}\)/);
  assert.match(t, /description: "bob"/);
  assert.doesNotMatch(t, /description: "carol"/);
  assert.doesNotMatch(t, /description: "orch"/);
  assert.match(t, /member_joined NAME/);
  assert.match(t, /only when it says NAME has no row running/);
  const none = rows.rowCalls({ code, name: 'orch', role: 'orch' }, { orch: ms.orch });
  assert.match(none, /No members yet/);
});

test('rowCalls: a member gets one room call labelled with the code, listing the other members (not orch, not self)', () => {
  const { ms, code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }, { name: 'dave' }]);
  const t = rows.rowCalls({ code, name: 'alice', role: 'member' }, ms);
  assert.match(t, /subagent_type: "sub-human:room", description: "marmot-2509", prompt: "room: marmot-2509\\nmembers: bob, dave", run_in_background: true/);
  assert.equal((t.match(/Agent\(/g) || []).length, 1);
  const solo = rows.rowCalls({ code, name: 'alice', role: 'member' }, [{ name: 'orch', role: 'orch' }, { name: 'alice' }]);
  assert.match(solo, /members: \(none\)/);
  assert.equal(rows.rowCalls(null, ms), '');
});

test('parseSpawn: name from the prompt, else the description; room code from prompt or description', () => {
  const ms = { alice: {}, bob: {} };
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'member: bob', description: 'whatever' }, ms), { kind: 'participant', name: 'bob' });
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'hold it', description: 'alice' }, ms), { kind: 'participant', name: 'alice' });
  assert.equal(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'x', description: 'zed' }, ms), null);
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:room', prompt: 'room: otter-1234\nmembers: bob' }, ms), { kind: 'room', name: 'otter-1234' });
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:room', description: 'otter-1234' }, ms), { kind: 'room', name: 'otter-1234' });
  assert.equal(rows.parseSpawn({ subagent_type: 'Explore', description: 'alice' }, ms), null);
});

test('row map: records per session, merges across sessions (/clear), forgets', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }]);
  rows.recordRow(code, 'sess-1', 'a1', { kind: 'participant', name: 'alice', parent: null });
  rows.recordRow(code, 'sess-1', 'a2', { kind: 'room', name: code, parent: null });
  rows.recordRow(code, 'sess-2', 'a3', { kind: 'participant', name: 'bob', parent: 'a2' });
  const m = rows.readRowMap(code);
  assert.deepEqual(Object.keys(m).sort(), ['a1', 'a2', 'a3']);
  assert.equal(m.a3.parent, 'a2');
  rows.forgetRow(code, 'a1');
  assert.equal(rows.readRowMap(code).a1, undefined);
  rows.writeHolds(code, 'orch', { members: ['alice'] });
  assert.equal(Object.keys(rows.readRowMap(code)).length, 2, 'holds files are not row maps');
});

test('rowText: orch view of members through a plan', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [
    { kind: 'say', from: 'alice', via: 'human' },
    plan(['alice', 'bob']),
    human('alice', 'signoff'),
    { kind: 'objection', from: 'bob', via: 'agent', plan_hash: H },
  ]);
  assert.equal(rows.rowText(code, 'alice', 'orch'), '✓ signed 593da0');
  assert.equal(rows.rowText(code, 'bob', 'orch'), '⚠ reviewing 593da0 · ✖ 1 objection (#4)');
  fs.mkdirSync(path.join(rows.rowsDir(code), '..', 'presence'), { recursive: true });
  fs.writeFileSync(path.join(rows.rowsDir(code), '..', 'presence', 'alice.json'), JSON.stringify({ state: 'idle', at: new Date().toISOString() }));
  assert.equal(rows.rowText(code, 'alice', 'orch'), '✓ signed 593da0 · idle');
  fs.writeFileSync(path.join(rows.rowsDir(code), '..', 'presence', 'bob.json'), JSON.stringify({ state: 'asking', at: new Date().toISOString() }));
  assert.equal(rows.rowText(code, 'bob', 'orch'), '⚠ reviewing 593da0 · ✖ 1 objection (#4) · ? prompt');
});

test('rowText: human objection, stale presence ignored, decided, left, mail for the viewer', () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const { code, dir } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }, { name: 'carol', left_at: 'x' }], [
    plan(['alice', 'bob']),
    human('bob', 'objection', { text: 'no' }),
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
  ]);
  fs.mkdirSync(path.join(dir, 'presence'));
  fs.writeFileSync(path.join(dir, 'presence', 'bob.json'), JSON.stringify({ state: 'idle', at: old }));
  assert.equal(rows.rowText(code, 'bob', 'orch'), '✖ objected 593da0 (#2)', 'bob posted after the idle write: presence dropped');
  assert.equal(rows.rowText(code, 'bob', 'alice'), '✖ objected 593da0 (#2) · ✉ 2 for you');
  assert.equal(rows.rowText(code, 'carol', 'orch'), 'left');
  assert.equal(rows.rowText(code, 'zed', 'orch'), 'not in the room');
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: 5, at: new Date().toISOString(), kind: 'decision', via: 'system', from: 'orch', plan_hash: H, text: 'go' }) + '\n');
  assert.match(rows.rowText(code, 'alice', 'orch'), /^✔ decided 593da0/);
  // build phase: the latest status after the decision (with its evidence) replaces "decided"
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: 6, at: new Date().toISOString(), kind: 'status', via: 'agent', from: 'alice', to: 'room', text: 'starting the handler' }) + '\n');
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: 7, at: new Date().toISOString(), kind: 'status', via: 'agent', from: 'alice', to: 'room', text: 'handler done,\n12/12 tests pass in test/tasks.test.js' }) + '\n');
  const t = rows.rowText(code, 'alice', 'orch');
  assert.match(t, /^#7 Claude status: handler done, 12\/12 tests pass/);
  assert.ok(Array.from(t).length <= rows.ROW_MAX);
  assert.match(rows.rowText(code, 'bob', 'orch'), /^✔ decided 593da0/, 'no status from bob yet');
});

test('rowText: no plan falls back to the last activity; output is clipped to ROW_MAX', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [{ kind: 'say', from: 'alice', via: 'human' }]);
  assert.match(rows.rowText(code, 'alice', 'orch'), /^#1 say \d+s$/);
  assert.equal(rows.rowText(code, 'bob', 'orch'), 'joined');
  const long = rows.rowText(code, 'alice', 'orch', { entries: [plan(['alice']), human('alice', 'objection')].map((e, i) => ({ id: i + 1, at: new Date().toISOString(), ...e, plan_hash: 'f'.repeat(12) })) });
  assert.ok(Array.from(long).length <= rows.ROW_MAX);
});

test('rowText: the room row carries plan progress and the viewer\'s alerts', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [
    { kind: 'say', from: 'alice', via: 'human' },
  ]);
  assert.equal(rows.rowText(code, code, 'alice'), '3 here');
  const es = [plan(['alice', 'bob']), human('bob', 'signoff'), { kind: 'say', from: 'orch', via: 'agent', to: 'alice' }]
    .map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', ...e }));
  assert.equal(rows.rowText(code, code, 'alice', { entries: es }), 'plan 593da0 1/2 · ⚠ your sign-off needed · ✉ 1 for you');
  assert.equal(rows.rowText(code, code, 'bob', { entries: es }), 'plan 593da0 1/2');
  es.push({ id: 4, at: new Date().toISOString(), kind: 'objection', via: 'human', from: 'alice', plan_hash: H });
  assert.equal(rows.rowText(code, code, 'bob', { entries: es }), 'plan 593da0 1/2 · ✖ 1 objection');
  assert.equal(rows.rowText(code, null, 'bob', { entries: es }), 'plan 593da0 1/2 · ✖ 1 objection');
  const colored = rows.rowText(code, code, 'alice', { entries: es.slice(0, 3), color: true });
  assert.match(colored, /\x1b\[33m⚠ your sign-off needed\x1b\[0m/);
});

test('missingRows: orch lists members without a live hold after the grace period; member checks its room row', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob', joined_at: new Date().toISOString() }]);
  assert.deepEqual(rows.missingRows(code, { code, name: 'orch', role: 'orch' }), ['alice'], 'bob just joined: grace');
  rows.writeHolds(code, 'orch', { members: ['alice'] });
  assert.deepEqual(rows.missingRows(code, { code, name: 'orch', role: 'orch' }), []);
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), [code]);
  rows.writeHolds(code, 'alice', { members: [], room: true });
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), []);
  fs.writeFileSync(rows.holdsFile(code, 'alice'), JSON.stringify({ pid: 999999, at: new Date().toISOString(), members: [], room: true }));
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), [code], 'dead server pid: not live');
});

test('joinNote: a member_joined notice says whether the row already runs here (live holds), so only a missing row is spawned', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }]);
  const orch = { code, name: 'orch', role: 'orch' };
  assert.match(rows.joinNote(orch, 'bob'), /bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  rows.writeHolds(code, 'orch', { members: ['bob'] });
  assert.match(rows.joinNote(orch, 'bob'), /bob's row is already running .*make NO Agent call/);
  assert.match(rows.joinNote(orch, 'alice'), /alice has no row running/);
  fs.writeFileSync(rows.holdsFile(code, 'orch'), JSON.stringify({ pid: 999999, at: new Date().toISOString(), members: ['bob'], room: false }));
  assert.match(rows.joinNote(orch, 'bob'), /no row running/, 'dead hold server: not running');
  const alice = { code, name: 'alice', role: 'member' };
  assert.match(rows.joinNote(alice, 'bob'), /room row is not running/);
  rows.writeHolds(code, 'alice', { room: true });
  assert.match(rows.joinNote(alice, 'bob'), /your room row adds bob by itself; make NO Agent call/);
  assert.equal(rows.joinNote(alice, 'alice'), '');
  assert.equal(rows.joinNote(alice, 'orch'), '');
});
