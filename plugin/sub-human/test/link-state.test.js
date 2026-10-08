'use strict';
// lib/room/link-state.js (the link's state for the room row, the statusline and doctor) and its segment on the room
// row (lib/rows.js rowText) and in the agent statusline (statusline/segments.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const links = require(path.join(h.LIB, 'room', 'links.js'));
const store = require(path.join(h.LIB, 'room', 'store.js'));
const ls = require(path.join(h.LIB, 'room', 'link-state.js'));
const rows = require(path.join(h.LIB, 'rows.js'));

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
  assert.equal(ls.read(CODE).state, 'up', 'an unknown state too');
});

test('link-state: without the state file, the link document maps online/connecting/offline/stopped/fork', t => {
  linked(t);
  assert.deepEqual(ls.read(CODE), { state: 'down', lastError: 'the link daemon is not running', source: 'link-doc' }, 'no document: no daemon');
  const map = { online: 'up', connecting: 'connecting', offline: 'down', stopped: 'down', fork: 'fork' };
  for (const [doc, want] of Object.entries(map)) {
    setDoc({ pid: process.pid, state: doc, since: '2026-01-01T00:00:00.000Z', reason: doc === 'offline' ? 'no route' : undefined });
    assert.equal(ls.read(CODE).state, want, doc);
  }
  setDoc({ pid: process.pid, state: 'offline', reason: 'no route' });
  assert.equal(ls.read(CODE).lastError, 'no route');
});

test('link-state: a daemon that died reads down, whatever its last record said (a fork stays a fork)', async t => {
  linked(t);
  const dead = await h.deadPid();
  setDoc({ pid: dead, state: 'online' });
  assert.deepEqual([ls.read(CODE).state, ls.read(CODE).lastError], ['down', 'the link daemon is not running']);
  writeState({ state: 'up', rttMs: 12 });
  assert.equal(ls.read(CODE).state, 'down');
  writeState({ state: 'fork' });
  assert.equal(ls.read(CODE).state, 'fork');
});

test('link-state: indicator wording', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const since = '2026-01-01T00:08:00.000Z';
  assert.equal(ls.indicator(null), '');
  assert.equal(ls.indicator({ state: 'up', rttMs: 40 }), '⇄ linked');
  assert.equal(ls.indicator({ state: 'connecting' }), '… connecting');
  assert.equal(ls.indicator({ state: 'connecting', attempt: 1 }), '… connecting');
  assert.equal(ls.indicator({ state: 'connecting', attempt: 3 }), '… reconnecting (3)');
  assert.equal(ls.indicator({ state: 'down', since, queued: 2 }, { now }), '✕ offline 2m · 2 queued');
  assert.equal(ls.indicator({ state: 'down' }, { now }), '✕ offline');
  assert.equal(ls.indicator({ state: 'fork' }), '✕ FORK: sub-human link --reset');
  assert.deepEqual([{ state: 'up' }, { state: 'connecting', attempt: 1 }, { state: 'connecting', attempt: 2 }, { state: 'down' }, { state: 'fork' }].map(ls.isDown),
    [false, false, true, true, true]);
});

test('room row: the link leads while down or reconnecting and closes the row while up; none for a room hosted here', t => {
  const code = 'vole-0001';
  const o = link => ({ entries: [], members: { alice: { role: 'member' }, bob: { role: 'member' } }, taskSummary: 'tasks 1 open', link });
  assert.equal(rows.rowText(code, code, 'alice', o(null)), '2 here · tasks 1 open');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'up' })), '2 here · tasks 1 open · ⇄ linked');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'connecting', attempt: 3 })), '… reconnecting (3) · 2 here · tasks 1 open');
  assert.equal(rows.rowText(code, code, 'alice', o({ state: 'down', queued: 2 })), '✕ offline · 2 queued · 2 here · tasks 1 open');
  assert.match(rows.rowText(code, code, 'alice', { ...o({ state: 'down' }), color: true }), /^\x1b\[33m✕ offline\x1b\[0m/, 'down is a warning');
  // read from the home when not given
  linked(t);
  writeState({ state: 'down', queued: 1 });
  assert.equal(rows.rowText(CODE, CODE, 'alice', { entries: [], members: {}, taskSummary: '' }), '✕ offline · 1 queued · 0 here');
});

test('agent statusline: the room row carries the link state', t => {
  h.freshHome(t);
  const { code } = h.register('alice', 'member', process.pid);
  // a seat in a mirror needs a running daemon; the link state is what this test is about, so stub its read
  const real = ls.read;
  ls.read = c => (c === code ? { state: 'connecting', attempt: 2 } : null);
  t.after(() => { ls.read = real; });
  const { agentStatusline } = require(path.join(h.PLUGIN, 'statusline', 'segments.js'));
  const out = agentStatusline({ tasks: [{ id: 'a1', description: code, status: 'running' }] }, { env: { NO_COLOR: '1' } });
  const [line] = out.split('\n').map(l => JSON.parse(l));
  assert.equal(line.id, 'a1');
  assert.match(line.content, new RegExp(`^${code}  … reconnecting \\(2\\)`));
});
