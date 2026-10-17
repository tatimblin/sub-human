// lib/rows.ts: rowCalls text, spawn parsing, the row map, and deterministic row text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rows from '../lib/rows.ts';
import * as roomLib from '../lib/room.ts';
import * as session from '../lib/room/session.ts';
import type { Identity } from '../lib/identity.ts';
import type { Entry, Member, Members } from '../lib/room/types.ts';
import type { Task } from '../lib/types-app.ts';
import { rc, sn, sid, eid } from './support/brands.ts';
import { must } from './support/must.ts';

/** A seat as rows reads it. */
type Seat = Pick<Identity, 'code' | 'name' | 'role'>;
const me = (m: Seat): Seat => m;
type RowOpts = NonNullable<Parameters<typeof rows.rowText>[1]>;

/** A room written by hand (members.json + log.jsonl), independent of the identity / room writers. */
function makeRoom(members: (Pick<Member, 'name'> & Partial<Member>)[], entries: object[] = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rows-'));
  process.env.SUB_HUMAN_HOME = home;
  const code = rc('marmot-2509');
  const dir = path.join(home, 'rooms', code);
  fs.mkdirSync(dir, { recursive: true });
  const ms: Members = {};
  for (const m of members) ms[m.name] = { role: m.name === 'claude' ? 'claude' : 'member', joined_at: new Date(0).toISOString(), ...m };
  fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  const log = entries.map((e, i) => JSON.stringify({ id: i + 1, at: new Date(Date.now() - (entries.length - i) * 1000).toISOString(), via: 'agent', to: 'room', text: 'x', ...e }));
  fs.writeFileSync(path.join(dir, 'log.jsonl'), log.join('\n') + (log.length ? '\n' : ''));
  return { home, code, dir, ms };
}
const H = '593da0aaaaaa';

test('rowCalls: claude gets one participant call per active member; none for claude or left members', () => {
  const { ms, code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }, { name: sn('carol'), left_at: 'x' }]);
  const t = rows.rowCalls({ code, name: sn('claude'), role: 'claude' }, ms);
  assert.match(t, /Agent\(\{subagent_type: "sub-human:participant", description: "alice", prompt: "member: alice", run_in_background: true\}\)/);
  assert.match(t, /description: "bob"/);
  assert.doesNotMatch(t, /description: "carol"/);
  assert.doesNotMatch(t, /description: "claude"/);
  assert.match(t, /member_joined NAME/);
  assert.match(t, /only when it says NAME has no row running/);
  const none = rows.rowCalls({ code, name: sn('claude'), role: 'claude' }, { claude: must(ms.claude) });
  assert.match(none, /No members yet/);
});

test('rowCalls: a member gets one room call labelled with the code, listing the other members (not claude, not self)', () => {
  const { ms, code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }, { name: sn('dave') }]);
  const t = rows.rowCalls({ code, name: sn('alice'), role: 'member' }, ms);
  assert.match(t, /subagent_type: "sub-human:room", description: "marmot-2509", prompt: "room: marmot-2509\\nmembers: bob, dave", run_in_background: true/);
  assert.equal((t.match(/Agent\(/g) || []).length, 1);
  // @ts-expect-error -- deliberate: alice, a record without its role
  const solo = rows.rowCalls({ code, name: sn('alice'), role: 'member' }, [{ name: 'claude', role: 'claude' }, { name: 'alice' }]);
  assert.match(solo, /members: \(none\)/);
  assert.equal(rows.rowCalls(null, ms), '');
});

test('parseSpawn: name from the prompt, else the description; room code from prompt or description', () => {
  // @ts-expect-error -- deliberate: empty records: parseSpawn reads only the names
  const ms: Members = { alice: {}, bob: {} };
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'member: bob', description: 'whatever' }, ms), { kind: 'participant', name: 'bob' });
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'hold it', description: 'alice' }, ms), { kind: 'participant', name: 'alice' });
  assert.equal(rows.parseSpawn({ subagent_type: 'sub-human:participant', prompt: 'x', description: 'zed' }, ms), null);
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:room', prompt: 'room: otter-1234\nmembers: bob' }, ms), { kind: 'room', name: rc('otter-1234') });
  assert.deepEqual(rows.parseSpawn({ subagent_type: 'sub-human:room', description: rc('otter-1234') }, ms), { kind: 'room', name: rc('otter-1234') });
  assert.equal(rows.parseSpawn({ subagent_type: 'Explore', description: 'alice' }, ms), null);
});

test('row map: records per session, merges across sessions (/clear), forgets', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }]);
  rows.recordRow(code, 'sess-1', 'a1', { kind: 'participant', name: 'alice', parent: null });
  rows.recordRow(code, 'sess-1', 'a2', { kind: 'room', name: code, parent: null });
  rows.recordRow(code, 'sess-2', 'a3', { kind: 'participant', name: 'bob', parent: 'a2' });
  const m = rows.readRowMap(code);
  assert.deepEqual(Object.keys(m).sort(), ['a1', 'a2', 'a3']);
  assert.equal(must(m.a3).parent, 'a2');
  rows.forgetRow(code, 'a1');
  assert.equal(rows.readRowMap(code).a1, undefined);
  rows.writeHolds(code, sn('claude'), { members: ['alice'] });
  assert.equal(Object.keys(rows.readRowMap(code)).length, 2, 'holds files are not row maps');
});

const prop = (approvers: string[], hash = H, extra: Partial<Entry> = {}) => ({ kind: 'proposal', via: 'human', from: 'alice', hash, approvers, path: `plans/${hash}.md`, ...extra });
const answer = (from: string, kind: string, hash = H, extra: Partial<Entry> = {}) => ({ via: 'human', from, kind, proposal_hash: hash, ...extra });
const decision = (hash = H) => ({ kind: 'decision', via: 'system', from: 'claude', proposal_hash: hash, text: 'agreed by all' });
const fitsRow = (t: string) => assert.ok(Array.from(t.replace(/\x1b\[[0-9;]*m/g, '')).length <= rows.ROW_MAX, `"${t}" over ROW_MAX`);

test('rowText (participant): proposal states from the room\'s Claude view, presence, and the open task', () => {
  const { code, dir } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }], [
    { kind: 'say', from: 'alice', via: 'human' },
    prop(['alice', 'bob']),
    answer('alice', 'signoff'),
  ]);
  const tasks: Task[] = [];
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'claude', tasks }), '✓ agreed 593da0');
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'claude', tasks }), '⚠ reviewing 593da0');
  fs.mkdirSync(path.join(dir, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presence', 'alice.json'), JSON.stringify({ state: 'idle', at: new Date().toISOString() }));
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'claude', tasks }), '✓ agreed 593da0 · idle');
  const list = [
    { id: '1', subject: 'room marmot-2509 open', status: 'in_progress', owner: 'room' },
    { id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob' },
    { id: '3', subject: 'docs', status: 'completed', owner: 'alice' },
  ] as Task[]; // no blockedBy: rowText reads none
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'claude', tasks: list }), '⚠ reviewing 593da0 · ◼ #2 parser tests');
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'claude', tasks: list }), '✓ agreed 593da0 · idle', 'a completed task is not open');
  // default source: <room>/tasks.json (the mirror), when lib/tasks.ts is absent or fails
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(list));
  assert.match(rows.rowText(code, { member: sn('bob'), viewer: 'claude' }), /◼ #2 parser tests$/);
});

test('rowText (participant): objection (no entry id), decided, status after the decision, left, mail', () => {
  const { code, dir } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }, { name: sn('carol'), left_at: 'x' }], [
    prop(['alice', 'bob']),
    answer('bob', 'objection', H, { text: 'no' }),
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
    { kind: 'say', from: 'bob', via: 'agent', to: 'alice' },
  ]);
  const tasks: Task[] = [];
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'claude', tasks }), '✖ objected');
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'alice', tasks }), '✖ objected · ✉ 2 for you');
  assert.equal(rows.rowText(code, { member: sn('carol'), viewer: 'claude', tasks }), 'left');
  assert.equal(rows.rowText(code, { member: sn('zed'), viewer: 'claude', tasks }), 'not in the room');
  const add = (e: object) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: rows.readLog(code).length + 1, at: new Date().toISOString(), to: 'room', ...e }) + '\n');
  add(decision());
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'claude', tasks }), '✖ blocked 593da0', 'bob objected: the closed proposal is blocked, not decided');
  add({ kind: 'status', via: 'agent', from: 'alice', text: 'handler done,\n12/12 tests pass in test/tasks.node-test.ts and more words here' });
  const t = rows.rowText(code, { member: sn('alice'), viewer: 'claude', tasks });
  assert.match(t, /^Claude status: handler done, 12\/12 tests pass/);
  fitsRow(t);
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'claude', tasks }), '✖ blocked 593da0', 'no status from bob yet');
});

test('rowText (participant): a hashless proposal post counts for nothing, an old retract line changes nothing; propose() entries count whatever their via', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }], [
    { kind: 'proposal', via: 'agent', from: 'bob', text: 'how about' },
    prop(['bob'], H, { via: 'agent' }),
    answer('bob', 'signoff'),
    { kind: 'retract', via: 'system', from: 'bob', refs: [3] },
  ]);
  assert.equal(rows.rowText(code, { member: sn('bob'), viewer: 'claude', tasks: [] }), '✓ agreed 593da0');
});

test('rowText (room row): answer needed, agreed, objected, decided, mail and the task summary', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }], [{ kind: 'say', from: 'alice', via: 'human' }]);
  assert.equal(rows.rowText(code, { viewer: 'alice', taskSummary: '' }), '2 here', 'humans only: the room\'s Claude is headless');
  const mk = (list: Partial<Entry>[]): Entry[] => list.map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', to: 'room', ...e }) as Entry); // {} lines: fillers
  const es = mk([prop(['alice', 'bob']), answer('bob', 'signoff'), { kind: 'say', from: 'claude', via: 'agent', to: 'alice' }]);
  const o = (extra?: RowOpts): RowOpts => ({ entries: es, taskSummary: '', ...extra });
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o() }), '⚠ your answer needed 593da0 · ✉ 1 for you');
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o() }), '✓ agreed 593da0 1/2');
  // stage 8e I.3: alice's Claude answered it: read, the count goes
  const replied = [...es, ...mk([{}, {}, {}, { kind: 'say', from: 'alice', via: 'agent', to: 'claude' }]).slice(3)];
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o({ entries: replied }) }), '⚠ your answer needed 593da0');
  es.push(...mk([{}, {}, {}, answer('alice', 'objection')]).slice(3));
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o() }), '✖ objected');
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o() }), '✓ agreed 593da0 1/2 · ✖ 1 objection');
  es.push({ id: eid(5), at: new Date().toISOString(), ...decision() });
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o() }), '✖ blocked 593da0', 'alice objected');
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o({ taskSummary: 'tasks 3 open · #2 you · #4 bob' }) }), '✖ blocked 593da0 · tasks 3 open · #2 you · #4 bob');
  const agreedEs = mk([prop(['alice', 'bob']), answer('bob', 'signoff'), answer('alice', 'signoff'), decision()]);
  assert.equal(rows.rowText(code, { viewer: 'bob', entries: agreedEs, taskSummary: '' }), '✔ decided 593da0', 'everyone agreed');
  // a second pending proposal for the viewer
  es.push(...mk([{}, {}, {}, {}, {}, prop(['alice'], 'abcdef000000'), prop(['alice', 'bob'], '3fa2c1000000')]).slice(5));
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o() }), '⚠ your answer needed 3fa2c1 +1');
  const colored = rows.rowText(code, { viewer: 'alice', ...o({ color: true }) });
  assert.match(colored, /\x1b\[33m⚠ your answer needed 3fa2c1 \+1\x1b\[0m/);
});

test('rowText: every fixture stays within ROW_MAX; segments that do not fit are dropped whole', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }]);
  const long = 'tasks 12 open · #2 you · #4 bob · #7 carol · #9 dave · #11 erin · #13 frank';
  const es = [prop(['alice', 'bob']), { kind: 'say', from: 'claude', via: 'agent', to: 'alice' }].map((e, i): Entry => ({ id: eid(i + 1), at: new Date().toISOString(), text: 'x', ...e }));
  const room = rows.rowText(code, { viewer: 'alice', entries: es, taskSummary: long });
  assert.equal(room, '⚠ your answer needed 593da0 · ✉ 1 for you', 'the summary does not fit: dropped, not cut');
  fitsRow(room);
  const tasks = [{ id: '22', subject: 'a very long subject line about the parser and its many tests', status: 'pending', owner: 'bob' }] as Task[]; // no blockedBy
  const p = rows.rowText(code, { member: sn('bob'), viewer: 'alice', entries: es, tasks });
  assert.equal(p, '⚠ reviewing 593da0 · ◼ #22 a very long subject line ab…');
  fitsRow(p);
  for (const viewer of ['alice', 'bob', 'claude']) for (const name of [code, 'alice', 'bob']) {
    fitsRow(rows.rowText(code, { member: name === code ? null : sn(name), viewer: viewer, entries: es, tasks, taskSummary: long }));
    fitsRow(rows.rowText(code, { member: name === code ? null : sn(name), viewer: viewer, entries: es, tasks, taskSummary: long, color: true }));
  }
  assert.equal(rows.fit(['x'.repeat(80)]).length, rows.ROW_MAX);
});

test('rowText (room row): lib/tasks.ts summary(code, viewer) is used', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }]);
  roomLib.open(code).store.kv.set('tasks', [
    { id: '2', subject: 'parser tests', status: 'in_progress', owner: 'alice' },
    { id: '4', subject: 'docs', status: 'pending', owner: 'bob' },
    { id: '5', subject: 'old', status: 'completed', owner: 'bob' },
  ]);
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: [] }), '1 here · tasks 2 open · #2 you · #4 bob');
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'bob', entries: [] }), '◼ #2 parser tests', 'participant row: tasks.mine()');
});

test('missingRows: claude lists members without a live hold after the grace period; member checks its room row', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob'), joined_at: new Date().toISOString() }]);
  assert.deepEqual(rows.missingRows(code, me({ code, name: sn('claude'), role: 'claude' })), ['alice'], 'bob just joined: grace');
  rows.writeHolds(code, sn('claude'), { members: ['alice'] });
  assert.deepEqual(rows.missingRows(code, me({ code, name: sn('claude'), role: 'claude' })), []);
  assert.deepEqual(rows.missingRows(code, me({ code, name: sn('alice'), role: 'member' })), [code]);
  rows.writeHolds(code, sn('alice'), { members: [], room: true });
  assert.deepEqual(rows.missingRows(code, me({ code, name: sn('alice'), role: 'member' })), []);
  session.put(roomLib.open(code).store, 'alice', 'holds', { pid: 999999, at: new Date().toISOString(), members: [], room: true });
  assert.deepEqual(rows.missingRows(code, me({ code, name: sn('alice'), role: 'member' })), [code], 'dead server pid: not live');
});

test('joinNote: a member_joined notice says whether the row already runs here (live holds), so only a missing row is spawned', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }]);
  const roomClaude: Seat = { code, name: sn('claude'), role: 'claude' };
  assert.match(rows.joinNote(roomClaude, 'bob'), /bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  rows.writeHolds(code, sn('claude'), { members: ['bob'] });
  assert.match(rows.joinNote(roomClaude, 'bob'), /bob's row is already running .*make NO Agent call/);
  assert.match(rows.joinNote(roomClaude, 'alice'), /alice has no row running/);
  session.put(roomLib.open(code).store, 'claude', 'holds', { pid: 999999, at: new Date().toISOString(), members: ['bob'], room: false });
  assert.match(rows.joinNote(roomClaude, 'bob'), /no row running/, 'dead hold server: not running');
  const alice: Seat = { code, name: sn('alice'), role: 'member' };
  assert.equal(rows.joinNote(alice, 'bob'), `row: your room row is not running; spawn it now: ${rows.roomCall(code, ['bob'])}`);
  rows.writeHolds(code, sn('alice'), { room: true });
  assert.match(rows.joinNote(alice, 'bob'), /your room row adds bob by itself; make NO Agent call/);
  assert.equal(rows.joinNote(alice, 'alice'), '');
  assert.equal(rows.joinNote(alice, 'claude'), '');
});

test('joinNote (Phase 0 fix): a room hold between its JOINED return and the re-call still counts as running', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }]);
  const alice: Seat = { code, name: sn('alice'), role: 'member' };
  // hold.ts writes room:false + roomUntil while the room agent re-calls hold after "JOINED bob"
  rows.writeHolds(code, sn('alice'), { members: [], room: false, roomUntil: Date.now() + 30_000 });
  assert.equal(must(rows.readHolds(code, sn('alice'))).room, true);
  assert.match(rows.joinNote(alice, 'bob'), /make NO Agent call/);
  assert.doesNotMatch(rows.joinNote(alice, 'bob'), /not running|Agent\(/);
  assert.deepEqual(rows.rowsNeeded(code, alice, { held: rows.readHolds(code, sn('alice')) }), []);
  rows.writeHolds(code, sn('alice'), { members: [], room: false, roomUntil: Date.now() - 1 });
  assert.equal(must(rows.readHolds(code, sn('alice'))).room, false, 'the gap expired: the row really stopped');
  assert.match(rows.joinNote(alice, 'bob'), /not running/);
});

test('claude (headless --bg): rowCalls / rowsNeeded / joinNote ignore members.json\'s claude {job, pid} record', () => {
  const { code, dir } = makeRoom([{ name: sn('alice') }, { name: sn('bob') }, { name: sn('carol'), left_at: 'x' }]);
  const ms = JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8')) as Members;
  ms.claude = { job: 'job-123', pid: process.pid, role: 'claude', name: sn('claude'), session_id: sid('sid-claude') };
  fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  const roomClaude: Seat = { code, name: sn('claude'), role: 'claude' };
  const t = rows.rowCalls(roomClaude, ms);
  assert.equal((t.match(/Agent\(/g) || []).length, 3, 'alice, bob + the NAME template in the join rule');
  assert.doesNotMatch(t, /description: "(claude|carol)"/);
  assert.deepEqual(rows.rowsNeeded(code, roomClaude, { members: ms }), ['alice', 'bob']);
  rows.writeHolds(code, sn('claude'), { members: ['alice'] });
  const held = rows.readHolds(code, sn('claude'));
  assert.deepEqual(rows.rowsNeeded(code, roomClaude, { members: ms, held }), ['bob']);
  const only = rows.rowCalls(roomClaude, ms, { only: ['bob'] });
  assert.match(only, /description: "bob"/);
  assert.doesNotMatch(only, /description: "alice", prompt/);
  assert.match(rows.joinNote(roomClaude, 'bob'), /bob has no row running; spawn it now: Agent sub-human:participant, description "bob"/);
  // the room's Claude\'s own record without a name field (contract: room Claude:{job, pid}) is still not a member
  // @ts-expect-error -- deliberate: no name or role
  ms.claude = { job: 'job-123', pid: process.pid };
  assert.deepEqual(rows.rowsNeeded(code, roomClaude, { members: ms }), ['alice', 'bob']);
  assert.deepEqual(rows.rowsNeeded(code, me({ code, name: sn('alice'), role: 'member' }), { members: ms }), [code]);
  assert.match(rows.rowCalls(me({ code, name: sn('alice'), role: 'member' }), ms), /members: bob"/);
});

test('rowText: a proposal is named by its stored plan\'s title (clipped), not its hash', () => {
  const { code, dir } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }]);
  const h1 = 'c0ffee000001', h2 = 'c0ffee000002';
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plans', `${h1}.md`), '\n## Cursor paging for /users\n\n1. after=\n');
  fs.writeFileSync(path.join(dir, 'plans', `${h2}.md`), '# A very long proposal title that will not fit in a row\n');
  const mk = (list: Partial<Entry>[]): Entry[] => list.map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', to: 'room', ...e }) as Entry); // {} lines: fillers
  const es = mk([prop(['alice', 'bob'], h1), answer('bob', 'signoff', h1)]);
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: es, taskSummary: '' }), '⚠ your answer needed Cursor paging for /users');
  assert.equal(rows.rowText(code, { viewer: 'bob', entries: es, taskSummary: '' }), '✓ agreed Cursor paging for /users 1/2');
  es.push(...mk([{}, {}, answer('alice', 'signoff', h1), decision(h1)]).slice(2));
  assert.equal(rows.rowText(code, { member: sn('alice'), viewer: 'claude', entries: es, tasks: [] }), '✔ decided Cursor paging for /users');
  const long = mk([prop(['alice'], h2)]);
  const t = rows.rowText(code, { viewer: 'alice', entries: long, taskSummary: '' });
  assert.equal(t, '⚠ your answer needed A very long proposal ti…');
  fitsRow(t);
  // No stored plan: the entry's "proposal HASH: title" text, else the short hash.
  const titled = mk([{ ...prop(['alice'], 'c0ffee000003'), text: 'proposal c0ffee000003: rename fetchUser' }]);
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: titled, taskSummary: '' }), '⚠ your answer needed rename fetchUser');
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: mk([prop(['alice'], 'c0ffee000004')]), taskSummary: '' }), '⚠ your answer needed c0ffee');
});

test('rowText (room row): each room plan at a glance, the latest edited first, at most 3 then "+N plans"; a plan the row already names is left out', () => {
  const H = (c: string) => c.repeat(12);
  /** A log line at position i (ids from 1, a second apart, ending now). */
  const at = (i: number, e: Partial<Entry>): Entry => ({ from: 'alice', kind: 'say', via: 'agent', to: 'room', ...e, id: eid(i + 1), at: new Date(Date.now() - (10 - i) * 1000).toISOString() });
  const pl = (name: string, version: number, hash: string, from = 'alice'): Partial<Entry> => ({ kind: 'plan', from, plan: name, version, base: version - 1, hash, path: `plans/${hash}.md`, for: from, text: `plan ${name} v${version}` });
  const es: Entry[] = [pl('paging', 1, H('a')), pl('release', 1, H('b')), pl('api', 1, H('c')), pl('paging', 2, H('d'), 'bob')].map((e, i) => at(i, e));
  const code = rc('marmot-2509');
  const o = { entries: es, taskSummary: '' };
  assert.match(rows.rowText(code, { viewer: 'carol', ...o }), /^\d+ here · paging v2 draft · api v1 draft · release v1 draft$/);
  // a request on release v1, carol asked: it leads the row, and release is not repeated; then agreed by both
  const ask = at(4, { kind: 'proposal', hash: H('b'), approvers: ['alice', 'carol'], plan: 'release', version: 1, text: 'x' });
  const carol = rows.rowText(code, { viewer: 'carol', entries: [...es, ask], taskSummary: '' });
  assert.ok(carol.startsWith('⚠ your answer needed plan release v1 · paging v2 draft'), carol); // the row's width cuts the rest
  assert.doesNotMatch(carol, /release v1 draft/);
  assert.ok(rows.rowText(code, { viewer: 'bob', entries: [...es, ask], taskSummary: '' }).startsWith('proposal plan release v1 0/2 · paging v2 draft'));
  const more = ['a', 'b', 'c', 'd', 'e'].map((n, i) => at(i, pl(n, 1, H(String(i + 1)))));
  assert.match(rows.rowText(code, { viewer: 'carol', entries: more, taskSummary: '' }), /^\d+ here · e v1 draft · d v1 draft · c v1 draft · \+2 plans$/);
});
