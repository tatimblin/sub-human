'use strict';
// lib/room/link-state.ts (the link's state for the room row, the statusline and doctor) and its segment on the room
// row (lib/rows.ts rowText) and in the agent statusline (statusline/segments.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const links = require(path.join(h.LIB, 'room', 'links.ts'));
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const ls = require(path.join(h.LIB, 'room', 'link-state.ts'));
const rows = require(path.join(h.LIB, 'rows.ts'));

const CODE = 'vole-4321';
function linked(t) {
  h.freshHome(t);
  links.set(CODE, { code: CODE, transport: { kind: 'pipe', home: '/elsewhere' }, token: 't', created_at: 'now' });
  store.createRoom(CODE);
}
const writeState = st => fs.writeFileSync(ls.stateFile(CODE), JSON.stringify(st));
const setDoc = doc => store.open(CODE).kv.set('link', doc);

test('link-state: null for a room hosted here (no link); the state file wins, read defensively', t => {
  h.freshHome(t);
  const code = h.newRoom();
  assert.equal(ls.read(code), null);
  assert.equal(ls.read('not a code'), null);
  linked(t);
  setDoc({ pid: process.pid, state: 'online', since: 'x' });
  writeState({ state: 'connecting', since: '2026-01-01T00:00:00.000Z', attempt: 3, lastError: 'ECONNREFUSED', rttMs: null, queued: 2, extra: 1 });
  assert.deepEqual(ls.read(CODE), { state: 'connecting', since: '2026-01-01T00:00:00.000Z', attempt: 3, lastError: 'ECONNREFUSED', queued: 2, source: 'state-file' });
  fs.writeFileSync(ls.stateFile(CODE), '{not json');
  assert.equal(ls.read(CODE).source, 'link-doc', 'an unreadable state file falls back to the link document');
  writeState({ state: 'sideways' });
  assert.equal(ls.read(CODE).state, 'online', 'an unknown state too');
});

test('link-state: without the state file, the link document says it in the same words (online/connecting/offline/stopped/fork)', t => {
  linked(t);
  assert.deepEqual(ls.read(CODE), { state: 'offline', lastError: 'the link daemon is not running', dead: true, source: 'link-doc' }, 'no document: no daemon');
  const map = { online: 'online', connecting: 'connecting', offline: 'offline', stopped: 'stopped', fork: 'fork', sideways: 'offline' };
  for (const [doc, want] of Object.entries(map)) {
    setDoc({ pid: process.pid, state: doc, since: '2026-01-01T00:00:00.000Z', reason: doc === 'offline' ? 'no route' : undefined });
    assert.equal(ls.read(CODE).state, want, doc);
  }
  setDoc({ pid: process.pid, state: 'offline', reason: 'no route' });
  assert.equal(ls.read(CODE).lastError, 'no route');
});

test('link-state: a daemon that died reads offline, whatever its last record said (a fork stays a fork)', async t => {
  linked(t);
  const dead = await h.deadPid();
  setDoc({ pid: dead, state: 'online' });
  assert.deepEqual([ls.read(CODE).state, ls.read(CODE).lastError], ['offline', 'the link daemon is not running']);
  writeState({ state: 'online', rttMs: 12 });
  assert.equal(ls.read(CODE).state, 'offline');
  writeState({ state: 'fork' });
  assert.equal(ls.read(CODE).state, 'fork');
});

test('link-state: the daemon\'s record as lib/remote/link.ts writes it (links.writeState): its own pid and detail decide', async t => {
  linked(t);
  const at = new Date().toISOString();
  links.writeState(CODE, { state: 'online', since: at, attempt: 0, lastError: null, rttMs: 12, queued: 0, pid: process.pid, detail: 'online', at });
  assert.deepEqual(ls.read(CODE), { state: 'online', since: at, attempt: 0, rttMs: 12, queued: 0, pid: process.pid, detail: 'online', source: 'state-file' });
  const dead = await h.deadPid();
  links.writeState(CODE, { state: 'online', since: at, attempt: 0, lastError: null, rttMs: 12, queued: 1, pid: dead, detail: 'online', at });
  assert.deepEqual([ls.read(CODE).state, ls.read(CODE).lastError, ls.read(CODE).dead], ['offline', 'the link daemon is not running', true]);
  links.writeState(CODE, { state: 'fork', since: at, attempt: 0, lastError: 'the host log was reset', pid: dead, detail: 'fork', at });
  assert.equal(ls.read(CODE).state, 'fork', 'a fork is a fork, daemon or not');
  links.writeState(CODE, { state: 'stopped', since: at, attempt: 0, lastError: 'AUTH: unknown token', pid: dead, detail: 'stopped', at });
  assert.deepEqual([ls.read(CODE).state, ls.read(CODE).lastError], ['stopped', 'AUTH: unknown token'], 'stopped is for good, daemon or not');
});

test('link-state: a record written before 0.4.1 (up / down, detail fork or stopped) reads in the one vocabulary', async t => {
  linked(t);
  const at = new Date().toISOString();
  links.writeState(CODE, { state: 'up', since: at, attempt: 0, rttMs: 12, queued: 0, pid: process.pid, detail: 'online', at });
  assert.equal(ls.read(CODE).state, 'online');
  links.writeState(CODE, { state: 'down', since: at, attempt: 2, lastError: 'no route', pid: process.pid, detail: 'offline', at });
  assert.deepEqual([ls.read(CODE).state, ls.read(CODE).lastError], ['offline', 'no route']);
  links.writeState(CODE, { state: 'down', since: at, lastError: 'the host log was reset', pid: process.pid, detail: 'fork', at });
  assert.equal(ls.read(CODE).state, 'fork');
  links.writeState(CODE, { state: 'down', since: at, lastError: 'AUTH: unknown token', pid: process.pid, detail: 'stopped', at });
  assert.equal(ls.read(CODE).state, 'stopped');
  assert.deepEqual(['up', 'down', 'online', 'connecting', 'offline', 'fork', 'stopped', 'x'].map(s => ls.normalize(s)),
    ['online', 'offline', 'online', 'connecting', 'offline', 'fork', 'stopped', 'offline']);
  assert.equal(ls.indicator({ state: 'up' }), '⇄ online', 'the row reads an old record in the new words');
  assert.equal(ls.isDown({ state: 'down', detail: 'stopped' }), true);
});

test('link-state: indicator wording', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const since = '2026-01-01T00:08:00.000Z';
  assert.equal(ls.indicator(null), '');
  assert.equal(ls.indicator({ state: 'online', rttMs: 40 }), '⇄ online');
  assert.equal(ls.indicator({ state: 'connecting' }), '… connecting');
  assert.equal(ls.indicator({ state: 'connecting', attempt: 1 }), '… connecting');
  assert.equal(ls.indicator({ state: 'connecting', attempt: 3 }), '… connecting (3)');
  assert.equal(ls.indicator({ state: 'offline', since, queued: 2 }, { now }), '✕ offline 2m · 2 queued');
  assert.equal(ls.indicator({ state: 'offline' }, { now }), '✕ offline');
  assert.equal(ls.indicator({ state: 'stopped', queued: 1 }), '✕ stopped · 1 queued');
  assert.equal(ls.indicator({ state: 'fork' }), '✕ out of step: /sub-human doctor');
  assert.deepEqual([{ state: 'online' }, { state: 'connecting', attempt: 1 }, { state: 'connecting', attempt: 2 }, { state: 'offline' }, { state: 'fork' }, { state: 'stopped' }].map(ls.isDown),
    [false, false, true, true, true, true]);
});

test('room row: the link leads while offline or connecting again and closes the row while online; none for a room hosted here', t => {
  const code = 'vole-0001';
  const o = link => ({ entries: [], members: { alice: { role: 'member' }, bob: { role: 'member' } }, taskSummary: 'tasks 1 open', link });
  assert.equal(rows.rowText(code, code, 'alice', o(null)), '2 here · tasks 1 open');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'online' })), '2 here · tasks 1 open · ⇄ online');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'connecting', attempt: 3 })), '… connecting (3) · 2 here · tasks 1 open');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'offline', queued: 2 })), '✕ offline · 2 queued · 2 here · tasks 1 open');
  assert.match(rows.rowText(code, code, 'alice', { ...o({ state: 'offline' }), color: true }), /^\x1b\[33m✕ offline\x1b\[0m/, 'offline is a warning');
  // read from the home when not given
  linked(t);
  writeState({ state: 'offline', queued: 1 });
  assert.equal(rows.rowText(CODE, CODE, 'alice', { entries: [], members: {}, taskSummary: '' }), '✕ offline · 1 queued · 0 here');
});

test('agent statusline: the room row carries the link state', t => {
  h.freshHome(t);
  const { code } = h.register('alice', 'member', process.pid);
  // a seat in a mirror needs a running daemon; the link state is what this test is about, so stub its read
  const real = ls.read;
  ls.read = c => (c === code ? { state: 'connecting', attempt: 2 } : null);
  t.after(() => { ls.read = real; });
  const { agentStatusline } = require(path.join(h.PLUGIN, 'statusline', 'segments.ts'));
  const out = agentStatusline({ tasks: [{ id: 'a1', description: code, status: 'running' }] }, { env: { NO_COLOR: '1' } });
  const [line] = out.split('\n').map(l => JSON.parse(l));
  assert.equal(line.id, 'a1');
  assert.match(line.content, new RegExp(`^${code}  … connecting \\(2\\)`));
});
