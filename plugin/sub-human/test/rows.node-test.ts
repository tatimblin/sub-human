// lib/rows.ts: the room row's deterministic text, and the sweep of the row maps older versions kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as rows from '../lib/rows.ts';
import * as roomLib from '../lib/room.ts';
import type { Entry, Member, Members } from '../lib/room/types.ts';
import { rc, sn, eid } from './support/brands.ts';

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

const prop = (approvers: string[], hash = H, extra: Partial<Entry> = {}) => ({ kind: 'proposal', via: 'human', from: 'alice', hash, approvers, path: `plans/${hash}.md`, ...extra });
const answer = (from: string, kind: string, hash = H, extra: Partial<Entry> = {}) => ({ via: 'human', from, kind, proposal_hash: hash, ...extra });
const decision = (hash = H) => ({ kind: 'decision', via: 'system', from: 'claude', proposal_hash: hash, text: 'agreed by all' });
const fitsRow = (t: string) => assert.ok(Array.from(t.replace(/\x1b\[[0-9;]*m/g, '')).length <= rows.ROW_MAX, `"${t}" over ROW_MAX`);

test('rowText (room row): answer needed, agreed, objected, decided, mail and the task summary', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }], [{ kind: 'say', from: 'alice', via: 'human' }]);
  assert.equal(rows.rowText(code, { viewer: 'alice', taskSummary: '' }), 'bob here', 'the others by name, humans only: the room\'s Claude is headless');
  const mk = (list: Partial<Entry>[]): Entry[] => list.map((e, i) => ({ id: i + 1, at: new Date().toISOString(), text: 'x', to: 'room', ...e }) as Entry); // {} lines: fillers
  const es = mk([prop(['alice', 'bob']), answer('bob', 'signoff'), { kind: 'say', from: 'claude', via: 'agent', to: 'alice' }]);
  const o = (extra?: RowOpts): RowOpts => ({ entries: es, taskSummary: '', ...extra });
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o() }), '⚠ your answer needed 593da0 · ✉ 1 for you');
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o() }), 'proposal 593da0 1/2 agreed (✓ you)', 'a count, not a decided look');
  // stage 8e I.3: alice's Claude answered it: read, the count goes
  const replied = [...es, ...mk([{}, {}, {}, { kind: 'say', from: 'alice', via: 'agent', to: 'claude' }]).slice(3)];
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o({ entries: replied }) }), '⚠ your answer needed 593da0');
  es.push(...mk([{}, {}, {}, answer('alice', 'objection')]).slice(3));
  assert.equal(rows.rowText(code, { viewer: 'alice', ...o() }), '✖ objected');
  assert.equal(rows.rowText(code, { viewer: 'bob', ...o() }), 'proposal 593da0 1/2 agreed (✓ you) · ✖ 1 objection');
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
  for (const viewer of ['alice', 'bob', 'claude']) {
    fitsRow(rows.rowText(code, { viewer, entries: es, taskSummary: long }));
    fitsRow(rows.rowText(code, { viewer, entries: es, taskSummary: long, color: true }));
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
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: [] }), 'only you · tasks 2 open · #2 you · #4 bob');
});

test('rowText (room row, one row): it names who else is here, at most three then "+N"; left and lapsed members and the room\'s Claude are not here', () => {
  const { code } = makeRoom([{ name: sn('claude') }, { name: sn('alice') }, { name: sn('bob') }, { name: sn('carol') }, { name: sn('dave') }, { name: sn('erin') },
    { name: sn('fred'), left_at: 'x' }, { name: sn('gus'), lapsed_at: 'x' }]);
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: [], taskSummary: '' }), 'bob, carol, dave +1 here');
  assert.equal(rows.rowText(code, { viewer: 'erin', entries: [], taskSummary: '' }), 'alice, bob, carol +1 here');
  const solo = makeRoom([{ name: sn('claude') }, { name: sn('alice') }]);
  assert.equal(rows.rowText(solo.code, { viewer: 'alice', entries: [], taskSummary: '' }), 'only you');
});

test('pruneRowMaps: an older version\'s row map whose session holds no seat and whose rows are old goes; a fresh one stays', () => {
  const { code } = makeRoom([{ name: sn('alice') }]);
  const kv = roomLib.open(code).store.kv;
  const old = new Date(Date.now() - 400 * 24 * 3600_000).toISOString();
  kv.set('rows/sess-old', { byAgent: { a1: { kind: 'participant', name: 'bob', at: old } } });
  kv.set('rows/sess-new', { byAgent: { a2: { kind: 'room', name: code, at: new Date().toISOString() } } });
  assert.equal(rows.pruneRowMaps(code), 1);
  assert.deepEqual(kv.list('rows/'), ['rows/sess-new']);
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
  assert.equal(rows.rowText(code, { viewer: 'bob', entries: es, taskSummary: '' }), 'proposal Cursor paging for /users 1/2 agreed (✓ you)');
  es.push(...mk([{}, {}, answer('alice', 'signoff', h1), decision(h1)]).slice(2));
  assert.equal(rows.rowText(code, { viewer: 'alice', entries: es, taskSummary: '' }), '✔ decided Cursor paging for /users');
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
  assert.match(rows.rowText(code, { viewer: 'carol', ...o }), /^alice, bob here · paging v2 draft · api v1 draft · \+1 plan$/);
  // a request on release v1, carol asked: it leads the row, and release is not repeated; then agreed by both
  const ask = at(4, { kind: 'proposal', hash: H('b'), approvers: ['alice', 'carol'], plan: 'release', version: 1, text: 'x' });
  const carol = rows.rowText(code, { viewer: 'carol', entries: [...es, ask], taskSummary: '' });
  assert.equal(carol, '⚠ your answer needed plan release v1 · +2 plans', 'the plans that do not fit are counted, never cut silently');
  assert.doesNotMatch(carol, /release v1 draft/);
  const bob = rows.rowText(code, { viewer: 'bob', entries: [...es, ask], taskSummary: '' });
  assert.match(bob, /^[^·]+ here · paging v2 draft · api v1 draft · \+1 plan$/, 'not asked: the plans, latest edited first');
  const more = ['a', 'b', 'c', 'd', 'e'].map((n, i) => at(i, pl(n, 1, H(String(i + 1)))));
  assert.match(rows.rowText(code, { viewer: 'carol', entries: more, taskSummary: '' }), /^alice, bob here · e v1 draft · d v1 draft · \+3 plans$/);
});

test('rowText (room-plan live): each plan at its current version; a decision on an older one never reads as current, a half-agreed request is a count, the current draft survives fitting', () => {
  const Hx = (c: string) => c.repeat(12);
  const at = (i: number, e: Partial<Entry>): Entry => ({ from: 'alice', kind: 'say', via: 'agent', to: 'room', ...e, id: eid(i + 1), at: new Date(Date.now() - (30 - i) * 1000).toISOString() });
  const pl = (name: string, version: number, hash: string): Partial<Entry> => ({ kind: 'plan', from: 'alice', plan: name, version, base: version - 1, hash, path: `plans/${hash}.md`, for: 'alice', text: `plan ${name} v${version}` });
  const ask = (name: string, version: number, hash: string): Partial<Entry> => ({ kind: 'proposal', via: 'agent', from: 'alice', hash, approvers: ['alice', 'bob'], plan: name, version, text: `plan ${name} v${version}` });
  const { code } = makeRoom([{ name: sn('alice') }, { name: sn('bob') }]);
  // room v1 asked and decided, then edited on to v6 with no request; paging v3 asked, alice agreed; release v1
  const es: Entry[] = [
    pl('room', 1, Hx('1')), ask('room', 1, Hx('1')), answer('alice', 'signoff', Hx('1')), answer('bob', 'signoff', Hx('1')), decision(Hx('1')),
    pl('release', 1, Hx('7')),
    ...[2, 3, 4, 5].map(v => pl('room', v, Hx(String(v)))),
    pl('paging', 1, Hx('a')), pl('paging', 2, Hx('b')), pl('paging', 3, Hx('c')), ask('paging', 3, Hx('c')), answer('alice', 'signoff', Hx('c')),
    pl('room', 6, Hx('6')),
  ].map((e, i) => at(i, e));
  const alice = rows.rowText(code, { viewer: 'alice', entries: es, taskSummary: 'tasks 2 open · #1 you' });
  fitsRow(alice);
  assert.doesNotMatch(alice, /decided|v1 agreed|✓ agreed/, alice);
  assert.match(alice, /room v6 draft · \+2 plans/, 'the newest plan leads; the ones that do not fit are counted');
  // with room enough, the half-agreed request reads as a count
  const paging = rows.rowText(code, { viewer: 'alice', entries: es.slice(0, -1), taskSummary: '' });
  assert.match(paging, /paging v3 1\/2 agreed, waiting on bob/, paging);
  assert.doesNotMatch(paging, /decided|✓ agreed/, paging);
  // bob is asked on paging v3: his answer leads; the other plans are counted
  assert.equal(rows.rowText(code, { viewer: 'bob', entries: es, taskSummary: '' }), '⚠ your answer needed plan paging v3 · +2 plans');
  assert.doesNotMatch(rows.rowText(code, { viewer: 'alice', entries: es.slice(0, 10), taskSummary: '' }), /decided/, 'room v5 is current: the v1 decision is history');
});

test('rowText (room-plan live): the join marker shows only who came after the viewer, never who was here before', () => {
  const { code } = makeRoom([{ name: sn('alice') }, { name: sn('bob') }, { name: sn('carol') }]);
  const at = (i: number, e: Partial<Entry>): Entry => ({ from: 'alice', kind: 'say', via: 'system', to: 'room', text: 'x', ...e, id: eid(i + 1), at: new Date(Date.now() - (5 - i) * 1000).toISOString() });
  const es = [at(0, { kind: 'member_joined', from: 'alice' }), at(1, { kind: 'member_joined', from: 'bob' })];
  assert.doesNotMatch(rows.rowText(code, { viewer: 'bob', entries: es, taskSummary: '' }), /alice joined/, 'alice was here when bob came');
  assert.match(rows.rowText(code, { viewer: 'alice', entries: es, taskSummary: '' }), /^\+bob joined/);
  es.push(at(2, { kind: 'member_joined', from: 'carol' }));
  assert.match(rows.rowText(code, { viewer: 'bob', entries: es, taskSummary: '' }), /^\+carol joined/, 'one after him still shows');
});
