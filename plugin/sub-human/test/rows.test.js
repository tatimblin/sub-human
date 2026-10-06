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

const prop = (approvers, hash = H, extra = {}) => ({ kind: 'proposal', via: 'human', from: 'alice', hash, approvers, path: `plans/${hash}.md`, ...extra });
const answer = (from, kind, hash = H, extra = {}) => ({ via: 'human', from, kind, proposal_hash: hash, ...extra });
const decision = (hash = H) => ({ kind: 'decision', via: 'system', from: 'orch', proposal_hash: hash, text: 'agreed by all' });
const fitsRow = t => assert.ok(Array.from(t.replace(/\x1b\[[0-9;]*m/g, '')).length <= rows.ROW_MAX, `"${t}" over ROW_MAX`);

test('rowText (participant): proposal states from the orch view, presence, and the open task', () => {
  const { code, dir } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [
    { kind: 'say', from: 'alice', via: 'human' },
    prop(['alice', 'bob']),
    answer('alice', 'signoff'),
  ]);
  const tasks = [];
  assert.equal(rows.rowText(code, 'alice', 'orch', { tasks }), '✓ agreed 593da0');
  assert.equal(rows.rowText(code, 'bob', 'orch', { tasks }), '⚠ reviewing 593da0');
  fs.mkdirSync(path.join(dir, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presence', 'alice.json'), JSON.stringify({ state: 'idle', at: new Date().toISOString() }));
  assert.equal(rows.rowText(code, 'alice', 'orch', { tasks }), '✓ agreed 593da0 · idle');
  const list = [
    { id: '1', subject: 'room marmot-2509 open', status: 'in_progress', owner: 'room' },
    { id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob' },
    { id: '3', subject: 'docs', status: 'completed', owner: 'alice' },
  ];
  assert.equal(rows.rowText(code, 'bob', 'orch', { tasks: list }), '⚠ reviewing 593da0 · ◼ #2 parser tests');
  assert.equal(rows.rowText(code, 'alice', 'orch', { tasks: list }), '✓ agreed 593da0 · idle', 'a completed task is not open');
  // default source: <room>/tasks.json (the mirror), when lib/tasks.js is absent or fails
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(list));
  assert.match(rows.rowText(code, 'bob', 'orch'), /◼ #2 parser tests$/);
});

test('rowText (participant): objection (no entry id), decided, status after the decision, left, mail', () => {
  const { code, dir } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }, { name: 'carol', left_at: 'x' }], [
    prop(['alice', 'bob']),
    answer('bob', 'objection', H, { text: 'no' }),
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
  ]);
  const tasks = [];
  assert.equal(rows.rowText(code, 'bob', 'orch', { tasks }), '✖ objected');
  assert.equal(rows.rowText(code, 'bob', 'alice', { tasks }), '✖ objected · ✉ 2 for you');
  assert.equal(rows.rowText(code, 'carol', 'orch', { tasks }), 'left');
  assert.equal(rows.rowText(code, 'zed', 'orch', { tasks }), 'not in the room');
  const add = e => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: rows.readLog(code).length + 1, at: new Date().toISOString(), to: 'room', ...e }) + '\n');
  add(decision());
  assert.equal(rows.rowText(code, 'alice', 'orch', { tasks }), '✖ blocked 593da0', 'bob objected: the closed proposal is blocked, not decided');
  add({ kind: 'status', via: 'agent', from: 'alice', text: 'handler done,\n12/12 tests pass in test/tasks.test.js and more words here' });
  const t = rows.rowText(code, 'alice', 'orch', { tasks });
  assert.match(t, /^Claude status: handler done, 12\/12 tests pass/);
  fitsRow(t);
  assert.equal(rows.rowText(code, 'bob', 'orch', { tasks }), '✖ blocked 593da0', 'no status from bob yet');
});

test('rowText (participant): a hashless proposal post or a retracted answer counts for nothing; propose() entries count whatever their via', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [
    { kind: 'proposal', via: 'agent', from: 'bob', text: 'how about' },
    prop(['bob'], H, { via: 'agent' }),
    answer('bob', 'signoff'),
    { kind: 'retract', via: 'system', from: 'bob', refs: [3] },
  ]);
  assert.equal(rows.rowText(code, 'bob', 'orch', { tasks: [] }), '⚠ reviewing 593da0');
});

test('rowText (room row): answer needed, agreed, objected, decided, mail and the task summary', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }], [{ kind: 'say', from: 'alice', via: 'human' }]);
  assert.equal(rows.rowText(code, code, 'alice', { taskSummary: '' }), '2 here', 'humans only: the orch is headless');
  const mk = list => list.map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', to: 'room', ...e }));
  const es = mk([prop(['alice', 'bob']), answer('bob', 'signoff'), { kind: 'say', from: 'orch', via: 'agent', to: 'alice' }]);
  const o = extra => ({ entries: es, taskSummary: '', ...extra });
  assert.equal(rows.rowText(code, code, 'alice', o()), '⚠ your answer needed 593da0 · ✉ 1 for you');
  assert.equal(rows.rowText(code, code, 'bob', o()), '✓ agreed 593da0 1/2');
  es.push(...mk([{}, {}, {}, answer('alice', 'objection')]).slice(3));
  assert.equal(rows.rowText(code, code, 'alice', o()), '✖ objected');
  assert.equal(rows.rowText(code, code, 'bob', o()), '✓ agreed 593da0 1/2 · ✖ 1 objection');
  es.push({ id: 5, at: new Date().toISOString(), ...decision() });
  assert.equal(rows.rowText(code, code, 'bob', o()), '✖ blocked 593da0', 'alice objected');
  assert.equal(rows.rowText(code, code, 'bob', o({ taskSummary: 'tasks 3 open · #2 you · #4 bob' })), '✖ blocked 593da0 · tasks 3 open · #2 you · #4 bob');
  const agreedEs = mk([prop(['alice', 'bob']), answer('bob', 'signoff'), answer('alice', 'signoff'), decision()]);
  assert.equal(rows.rowText(code, code, 'bob', { entries: agreedEs, taskSummary: '' }), '✔ decided 593da0', 'everyone agreed');
  // a second pending proposal for the viewer
  es.push(...mk([{}, {}, {}, {}, {}, prop(['alice'], 'abcdef000000'), prop(['alice', 'bob'], '3fa2c1000000')]).slice(5));
  assert.equal(rows.rowText(code, code, 'alice', o()), '⚠ your answer needed 3fa2c1 +1');
  const colored = rows.rowText(code, code, 'alice', o({ color: true }));
  assert.match(colored, /\x1b\[33m⚠ your answer needed 3fa2c1 \+1\x1b\[0m/);
});

test('rowText: every fixture stays within ROW_MAX; segments that do not fit are dropped whole', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }]);
  const long = 'tasks 12 open · #2 you · #4 bob · #7 carol · #9 dave · #11 erin · #13 frank';
  const es = [prop(['alice', 'bob']), { kind: 'say', from: 'orch', via: 'agent', to: 'alice' }].map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', ...e }));
  const room = rows.rowText(code, code, 'alice', { entries: es, taskSummary: long });
  assert.equal(room, '⚠ your answer needed 593da0 · ✉ 1 for you', 'the summary does not fit: dropped, not cut');
  fitsRow(room);
  const tasks = [{ id: '22', subject: 'a very long subject line about the parser and its many tests', status: 'pending', owner: 'bob' }];
  const p = rows.rowText(code, 'bob', 'alice', { entries: es, tasks });
  assert.equal(p, '⚠ reviewing 593da0 · ◼ #22 a very long subject line ab…');
  fitsRow(p);
  for (const viewer of ['alice', 'bob', 'orch']) for (const name of [code, 'alice', 'bob']) {
    fitsRow(rows.rowText(code, name, viewer, { entries: es, tasks, taskSummary: long }));
    fitsRow(rows.rowText(code, name, viewer, { entries: es, tasks, taskSummary: long, color: true }));
  }
  assert.equal(rows.fit(['x'.repeat(80)]).length, rows.ROW_MAX);
});

test('rowText (room row): lib/tasks.js summary(code, viewer) is used when present; a throwing one is ignored', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }]);
  const file = path.join(PLUGIN, 'lib', 'tasks.js');
  const real = fs.existsSync(file);
  if (real) {
    require(path.join(PLUGIN, 'lib', 'room.js')).open(code).store.kv.set('tasks', [
      { id: '2', subject: 'parser tests', status: 'in_progress', owner: 'alice' },
      { id: '4', subject: 'docs', status: 'pending', owner: 'bob' },
      { id: '5', subject: 'old', status: 'completed', owner: 'bob' },
    ]);
    assert.equal(rows.rowText(code, code, 'alice', { entries: [] }), '1 here · tasks 2 open · #2 you · #4 bob');
    assert.equal(rows.rowText(code, 'alice', 'bob', { entries: [] }), '◼ #2 parser tests', 'participant row: tasks.mine()');
    return;
  }
  const id = require.resolve(path.join(PLUGIN, 'lib', 'rows.js')).replace(/rows\.js$/, 'tasks.js');
  require.cache[id] = { id, filename: id, loaded: true, exports: { summary: (c, v) => `tasks 1 open · #2 ${v}`, list: () => [] } };
  try {
    assert.equal(rows.rowText(code, code, 'alice', { entries: [] }), '1 here · tasks 1 open · #2 alice');
    require.cache[id].exports = { summary: () => { throw new Error('boom'); } };
    assert.equal(rows.rowText(code, code, 'alice', { entries: [] }), '1 here');
  } finally { delete require.cache[id]; }
});

test('missingRows: orch lists members without a live hold after the grace period; member checks its room row', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob', joined_at: new Date().toISOString() }]);
  assert.deepEqual(rows.missingRows(code, { code, name: 'orch', role: 'orch' }), ['alice'], 'bob just joined: grace');
  rows.writeHolds(code, 'orch', { members: ['alice'] });
  assert.deepEqual(rows.missingRows(code, { code, name: 'orch', role: 'orch' }), []);
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), [code]);
  rows.writeHolds(code, 'alice', { members: [], room: true });
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), []);
  require(path.join(PLUGIN, 'lib', 'room.js')).open(code).store.kv.set('rows/holds-alice', { pid: 999999, at: new Date().toISOString(), members: [], room: true });
  assert.deepEqual(rows.missingRows(code, { code, name: 'alice', role: 'member' }), [code], 'dead server pid: not live');
});

test('joinNote: a member_joined notice says whether the row already runs here (live holds), so only a missing row is spawned', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }]);
  const orch = { code, name: 'orch', role: 'orch' };
  assert.match(rows.joinNote(orch, 'bob'), /bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  rows.writeHolds(code, 'orch', { members: ['bob'] });
  assert.match(rows.joinNote(orch, 'bob'), /bob's row is already running .*make NO Agent call/);
  assert.match(rows.joinNote(orch, 'alice'), /alice has no row running/);
  require(path.join(PLUGIN, 'lib', 'room.js')).open(code).store.kv.set('rows/holds-orch', { pid: 999999, at: new Date().toISOString(), members: ['bob'], room: false });
  assert.match(rows.joinNote(orch, 'bob'), /no row running/, 'dead hold server: not running');
  const alice = { code, name: 'alice', role: 'member' };
  assert.equal(rows.joinNote(alice, 'bob'), `row: your room row is not running; spawn it now: ${rows.roomCall(code, ['bob'])}`);
  rows.writeHolds(code, 'alice', { room: true });
  assert.match(rows.joinNote(alice, 'bob'), /your room row adds bob by itself; make NO Agent call/);
  assert.equal(rows.joinNote(alice, 'alice'), '');
  assert.equal(rows.joinNote(alice, 'orch'), '');
});

test('joinNote (Phase 0 fix): a room hold between its JOINED return and the re-call still counts as running', () => {
  const { code } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }]);
  const alice = { code, name: 'alice', role: 'member' };
  // hold.js writes room:false + roomUntil while the room agent re-calls hold after "JOINED bob"
  rows.writeHolds(code, 'alice', { members: [], room: false, roomUntil: Date.now() + 30_000 });
  assert.equal(rows.readHolds(code, 'alice').room, true);
  assert.match(rows.joinNote(alice, 'bob'), /make NO Agent call/);
  assert.doesNotMatch(rows.joinNote(alice, 'bob'), /not running|Agent\(/);
  assert.deepEqual(rows.rowsNeeded(code, alice, { held: rows.readHolds(code, 'alice') }), []);
  rows.writeHolds(code, 'alice', { members: [], room: false, roomUntil: Date.now() - 1 });
  assert.equal(rows.readHolds(code, 'alice').room, false, 'the gap expired: the row really stopped');
  assert.match(rows.joinNote(alice, 'bob'), /not running/);
});

test('orch (headless --bg): rowCalls / rowsNeeded / joinNote ignore members.json\'s orch {job, pid} record', () => {
  const { code, dir } = makeRoom([{ name: 'alice' }, { name: 'bob' }, { name: 'carol', left_at: 'x' }]);
  const ms = JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8'));
  ms.orch = { job: 'job-123', pid: process.pid, role: 'orch', name: 'orch', session_id: 'sid-orch' };
  fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  const orch = { code, name: 'orch', role: 'orch' };
  const t = rows.rowCalls(orch, ms);
  assert.equal((t.match(/Agent\(/g) || []).length, 3, 'alice, bob + the NAME template in the join rule');
  assert.doesNotMatch(t, /description: "(orch|carol)"/);
  assert.deepEqual(rows.rowsNeeded(code, orch, { members: ms }), ['alice', 'bob']);
  rows.writeHolds(code, 'orch', { members: ['alice'] });
  const held = rows.readHolds(code, 'orch');
  assert.deepEqual(rows.rowsNeeded(code, orch, { members: ms, held }), ['bob']);
  const only = rows.rowCalls(orch, ms, { only: ['bob'] });
  assert.match(only, /description: "bob"/);
  assert.doesNotMatch(only, /description: "alice", prompt/);
  assert.match(rows.joinNote(orch, 'bob'), /bob has no row running; spawn it now: Agent sub-human:participant, description "bob"/);
  // the orch\'s own record without a name field (contract: orch:{job, pid}) is still not a member
  ms.orch = { job: 'job-123', pid: process.pid };
  assert.deepEqual(rows.rowsNeeded(code, orch, { members: ms }), ['alice', 'bob']);
  assert.deepEqual(rows.rowsNeeded(code, { code, name: 'alice', role: 'member' }, { members: ms }), [code]);
  assert.match(rows.rowCalls({ code, name: 'alice', role: 'member' }, ms), /members: bob"/);
});

test('rowText: a proposal is named by its stored plan\'s title (clipped), not its hash', () => {
  const { code, dir } = makeRoom([{ name: 'orch' }, { name: 'alice' }, { name: 'bob' }]);
  const h1 = 'c0ffee000001', h2 = 'c0ffee000002';
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plans', `${h1}.md`), '\n## Cursor paging for /users\n\n1. after=\n');
  fs.writeFileSync(path.join(dir, 'plans', `${h2}.md`), '# A very long proposal title that will not fit in a row\n');
  const mk = list => list.map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', to: 'room', ...e }));
  const es = mk([prop(['alice', 'bob'], h1), answer('bob', 'signoff', h1)]);
  assert.equal(rows.rowText(code, code, 'alice', { entries: es, taskSummary: '' }), '⚠ your answer needed Cursor paging for /users');
  assert.equal(rows.rowText(code, code, 'bob', { entries: es, taskSummary: '' }), '✓ agreed Cursor paging for /users 1/2');
  es.push(...mk([{}, {}, answer('alice', 'signoff', h1), decision(h1)]).slice(2));
  assert.equal(rows.rowText(code, 'alice', 'orch', { entries: es, tasks: [] }), '✔ decided Cursor paging for /users');
  const long = mk([prop(['alice'], h2)]);
  const t = rows.rowText(code, code, 'alice', { entries: long, taskSummary: '' });
  assert.equal(t, '⚠ your answer needed A very long proposal ti…');
  fitsRow(t);
  // No stored plan: the entry's "proposal HASH: title" text, else the short hash.
  const titled = mk([{ ...prop(['alice'], 'c0ffee000003'), text: 'proposal c0ffee000003: rename fetchUser' }]);
  assert.equal(rows.rowText(code, code, 'alice', { entries: titled, taskSummary: '' }), '⚠ your answer needed rename fetchUser');
  assert.equal(rows.rowText(code, code, 'alice', { entries: mk([prop(['alice'], 'c0ffee000004')]), taskSummary: '' }), '⚠ your answer needed c0ffee');
});
