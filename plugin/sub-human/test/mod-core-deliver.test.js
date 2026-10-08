'use strict';
// mod/core/deliver.mjs in node: its timing constants against lib/config.js, the restart backoff, the notice's
// window, and the turn ledger that decides which wakes are submitted again. The wiring is mod/test/deliver.test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const config = require('../lib/config.js');

const load = rel => import(path.join(__dirname, '..', rel));

// mod/ imports no CommonJS, so it keeps its own copies; each is skipped until lib/config.js names it.
for (const key of ['MOD_RESTART_MS', 'MOD_RESTART_MAX_MS', 'MOD_RESTART_STEADY_MS', 'MOD_DELIVERY_ERROR_LOG_MS']) {
  test(`deliver: ${key} equals lib/config.js`, { skip: !(key in config) && `lib/config.js has no ${key}` }, async () => {
    const d = await load('mod/core/deliver.mjs');
    assert.equal(d[key], config[key]);
  });
}

test('deliver: the backoff doubles from MOD_RESTART_MS to MOD_RESTART_MAX_MS; a long run starts it over', async () => {
  const d = await load('mod/core/deliver.mjs');
  assert.deepEqual([0, 1, 2, 5, 6, 20].map(d.restartDelay), [1000, 2000, 4000, 32_000, 60_000, 60_000]);
  assert.equal(d.restartDelay(-1), d.MOD_RESTART_MS, 'after a reset');
  assert.equal(d.nextFails(2, 10), 3);
  assert.equal(d.nextFails(2, d.MOD_RESTART_STEADY_MS), 3);
  assert.equal(d.nextFails(2, d.MOD_RESTART_STEADY_MS + 1), 0);
  assert.equal(d.nextFails(undefined, 0), 1);
});

test('deliver: the delivery-error notice is due once per window', async () => {
  const d = await load('mod/core/deliver.mjs');
  assert.equal(d.noticeDue(-Infinity, 5), true, 'never told');
  assert.equal(d.noticeDue(1000, 1000 + d.MOD_DELIVERY_ERROR_LOG_MS - 1), false);
  assert.equal(d.noticeDue(1000, 1000 + d.MOD_DELIVERY_ERROR_LOG_MS), true);
  assert.equal(d.DELIVERY_ERROR_NOTICE.includes('\n'), false, 'a notice is one line');
  assert.match(d.DELIVERY_ERROR_NOTICE, /sub-human read/);
});

test('deliver: the tail child gets the env a shimmed hook gets', async () => {
  const d = await load('mod/core/deliver.mjs');
  const { shimEnv } = await load('mod/core/shim.mjs');
  assert.deepEqual(d.tailEnv('sid-1', '/p'), shimEnv({ session_id: 'sid-1' }, '/p'));
  assert.deepEqual(d.tailEnv('', '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '' }, 'no session id: none passed');
  assert.deepEqual(d.tailEnv(null, undefined), { CLAUDE_PLUGIN_ROOT: '', CLAUDE_PID: '' });
});

test('deliver: turn.start, a mid-turn wake, a tool call, turn.complete: only a wake no request carried comes back', async () => {
  const d = await load('mod/core/deliver.mjs');
  const t = d.turnLedger();
  assert.equal(t.running, null);
  assert.equal(t.appended('idle', 1), false, 'no turn runs: the caller submits it');
  assert.deepEqual(t.start('t1'), []);
  assert.equal(t.running, 't1');
  assert.equal(t.appended('read', 100), true);
  t.toolDone(150); // a request followed this tool call, carrying the row
  assert.equal(t.appended('unread', 200), true); // the last request was already out
  assert.deepEqual(t.complete('t-other'), [], 'another turn\'s end checks nothing');
  assert.equal(t.running, 't1');
  assert.deepEqual(t.complete('t1'), ['unread']);
  assert.equal(t.running, null);
  assert.deepEqual(t.complete('t1'), [], 'once');
  // a turn with no tool call at all: nothing it appended was carried
  t.start('t2');
  t.appended('w', 300);
  t.toolDone(300); // the same moment is not after it
  assert.deepEqual(t.complete('t2'), ['w']);
  // a row with no time (the clock failed) reads as unread: submitted again rather than lost
  t.start('t3');
  t.appended('x', Infinity);
  t.toolDone(1e15);
  assert.deepEqual(t.complete('t3'), ['x']);
});

test('deliver: a wake nothing took is held for the next turn.start, newest PENDING_MAX kept', async () => {
  const d = await load('mod/core/deliver.mjs');
  const t = d.turnLedger();
  assert.equal(t.hold('a'), 0);
  assert.equal(t.hold('b'), 0);
  assert.deepEqual(t.start('t1'), ['a', 'b']);
  assert.deepEqual(t.start('t2'), [], 'handed back once');
  let dropped = 0;
  for (let i = 0; i < d.PENDING_MAX + 3; i++) dropped += t.hold(`w${i}`);
  assert.equal(dropped, 3);
  const held = t.start('t3');
  assert.equal(held.length, d.PENDING_MAX);
  assert.equal(held[0], 'w3');
});

test('deliver: typed through Remote Control (remote), chat is relayed as a prompt; mid-turn, a notice now and a relay at the turn\'s end', async () => {
  const d = await load('mod/core/deliver.mjs');
  const chat = { type: 'chat', lines: ['bob: hi', 'carol joined'] };
  assert.deepEqual(d.route(chat), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }]);
  const relay = `${d.RELAY_HEAD}\nbob: hi\ncarol joined`;
  assert.deepEqual(d.route(chat, { remote: true }), [{ do: 'submit', text: relay, seen: ['bob: hi', 'carol joined'] }]);
  assert.deepEqual(d.route(chat, { remote: true, turnRunning: true }), [
    { do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }, { do: 'relay-later', text: relay },
  ]);
  assert.equal(d.relayText('sub-human: ✓ sent'), `${d.RELAY_HEAD}\nsub-human: ✓ sent`);
  assert.equal(d.relayText(''), d.RELAY_HEAD, 'nothing to show: the head alone');
  const { gateVerdict, onRemote } = await load('mod/core/prompt.mjs');
  assert.equal(gateVerdict({ text: relay, origin: { kind: 'plugin', name: 'sub-human' } }), null, 'a relay never reads as a post');
  assert.deepEqual(['bridge', 'composer', 'sdk', 'peer', 'plugin'].map(kind => onRemote({ kind })), [true, false, false, undefined, undefined]);
  assert.equal(onRemote(undefined), undefined);
});
