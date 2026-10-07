'use strict';
// mod/core/prompt.mjs in node: the session title, the origin hand-off, the fail-closed @room refusal and the
// "working" presence rule. The wiring is in mod/test/prompt.test.ts (npm run test:mods).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..');
const load = () => import(path.join(PLUGIN, 'mod', 'core', 'prompt.mjs'));
const seat = (code = 'otter-4821', role = 'member') => ({ name: 'alice', code, role, addr: `alice.${code}` });

test('prompt: titleFor titles once per session id and address, so a room switch sets the new title', async () => {
  const { titleFor } = await load();
  const a = { sid: 's1', seat: seat() };
  assert.equal(titleFor(a, 's1', undefined), 'alice.otter-4821');
  assert.equal(titleFor(a, 's1', { sid: 's1', addr: 'alice.otter-4821' }), null, 'already titled');
  const b = { sid: 's1', seat: seat('badger-2971') };
  assert.equal(titleFor(b, 's1', { sid: 's1', addr: 'alice.otter-4821' }), 'alice.badger-2971', 'switched rooms');
  assert.equal(titleFor(a, 's2', { sid: 's1', addr: 'alice.otter-4821' }), null, 'not this session\'s hello');
  assert.equal(titleFor({ sid: 's2', seat: seat() }, 's2', { sid: 's1', addr: 'alice.otter-4821' }), 'alice.otter-4821', 'after /clear');
  assert.equal(titleFor(a, 's1', 's1'), 'alice.otter-4821', 'a sid-only mark (older module state) titles once more');
  assert.equal(titleFor({ sid: 's1', seat: seat('otter-4821', 'orch') }, 's1'), null, 'the orch keeps its launch name');
  assert.equal(titleFor({ sid: 's1', seat: null }, 's1'), null);
  assert.equal(titleFor(null, 's1'), null);
});

test('prompt: the origin hand-off gives a kind only to the prompt whose text it was pushed with', async () => {
  const { originQueue } = await load();
  const q = originQueue();
  const item = q.push('@room hi', 'composer');
  assert.equal(q.take('@room hi'), 'composer');
  assert.equal(q.take('@room something else'), null, 'the only one waiting is not handed to another text');
  q.drop(item);
  assert.equal(q.take('@room hi'), null);
  q.push('one', 'peer');
  q.push('@room two', 'composer');
  assert.equal(q.take('@room two'), 'composer');
});

test('prompt: an @room the shim could not handle is refused, never let through; one wording with at-room\'s', async () => {
  const p = await load();
  const atRoom = require('../hooks/at-room.js');
  assert.equal(p.GATE_FAILED, atRoom.NO_ORIGIN);
  assert.deepEqual(p.failClosed('@room ship it'), { block: p.GATE_FAILED, suppressOriginalPrompt: true });
  assert.deepEqual(p.failClosed('room:ship it'), { block: p.GATE_FAILED, suppressOriginalPrompt: true });
  assert.equal(p.failClosed('ship it'), null);
  assert.equal(p.failClosed(undefined), null);
  // only exit 0 (an answer) and 2 (a block) count as the hook having handled it
  for (const exitCode of [1, 124, null, undefined]) assert.equal(p.shimFailed({ exitCode }), true, String(exitCode));
  for (const exitCode of [0, 2]) assert.equal(p.shimFailed({ exitCode }), false, String(exitCode));
});

test('prompt: the mod writes "working" for a typed prompt of a member (or an unknown seat), once', async () => {
  const { writesWorking } = await load();
  const hello = { sid: 's1', seat: seat() };
  assert.equal(writesWorking({ kind: 'composer' }, hello, null), true);
  assert.equal(writesWorking({ kind: 'bridge' }, null, 'idle_prompt'), true, 'unknown seat: presence.js decides');
  assert.equal(writesWorking({ kind: 'composer' }, hello, 'working'), false, 'already working');
  assert.equal(writesWorking({ kind: 'peer' }, hello, null), false, 'not typed');
  assert.equal(writesWorking(undefined, hello, null), false);
  assert.equal(writesWorking({ kind: 'composer' }, { sid: 's1', seat: null }, null), false, 'no seat');
  const orch = { sid: 's1', seat: seat('otter-4821', 'orch') };
  assert.equal(writesWorking({ kind: 'composer' }, orch, null), false, 'the orch refuses typed prompts');
});
