// mod/core/deliver.ts in node: its timing constants against lib/config.ts, the restart backoff, the notice's
// window, and the turn ledger that decides which wakes are submitted again. The wiring is mod/test/deliver.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as config from '../lib/config.ts';

const load = rel => import(path.join(import.meta.dirname, '..', rel));

// mod/ imports no CommonJS, so it keeps its own copies; each is skipped until lib/config.ts names it.
for (const key of ['MOD_RESTART_MS', 'MOD_RESTART_MAX_MS', 'MOD_RESTART_STEADY_MS', 'MOD_DELIVERY_ERROR_LOG_MS']) {
  test(`deliver: ${key} equals lib/config.ts`, { skip: !(key in config) && `lib/config.ts has no ${key}` }, async () => {
    const d = await load('mod/core/deliver.ts');
    assert.equal(d[key], config[key]);
  });
}

test('deliver: the backoff doubles from MOD_RESTART_MS to MOD_RESTART_MAX_MS; a long run starts it over', async () => {
  const d = await load('mod/core/deliver.ts');
  assert.deepEqual([0, 1, 2, 5, 6, 20].map(d.restartDelay), [1000, 2000, 4000, 32_000, 60_000, 60_000]);
  assert.equal(d.restartDelay(-1), d.MOD_RESTART_MS, 'after a reset');
  assert.equal(d.nextFails(2, 10), 3);
  assert.equal(d.nextFails(2, d.MOD_RESTART_STEADY_MS), 3);
  assert.equal(d.nextFails(2, d.MOD_RESTART_STEADY_MS + 1), 0);
  assert.equal(d.nextFails(undefined, 0), 1);
});

test('deliver: the delivery-error notice is due once per window', async () => {
  const d = await load('mod/core/deliver.ts');
  assert.equal(d.noticeDue(-Infinity, 5), true, 'never told');
  assert.equal(d.noticeDue(1000, 1000 + d.MOD_DELIVERY_ERROR_LOG_MS - 1), false);
  assert.equal(d.noticeDue(1000, 1000 + d.MOD_DELIVERY_ERROR_LOG_MS), true);
  assert.equal(d.DELIVERY_ERROR_NOTICE.includes('\n'), false, 'a notice is one line');
  assert.match(d.DELIVERY_ERROR_NOTICE, /^a room message didn't arrive here\. Run \/sub-human doctor\.$/);
});

test('deliver: the tail child gets the env a shimmed hook gets', async () => {
  const d = await load('mod/core/deliver.ts');
  const { shimEnv } = await load('mod/core/shim.ts');
  assert.deepEqual(d.tailEnv('sid-1', '/p'), shimEnv({ session_id: 'sid-1' }, '/p'));
  assert.deepEqual(d.tailEnv('', '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '' }, 'no session id: none passed');
  assert.deepEqual(d.tailEnv(null, undefined), { CLAUDE_PLUGIN_ROOT: '', CLAUDE_PID: '' });
});

test('deliver: turn.start, a mid-turn wake, a tool call, turn.complete: only a wake no request carried comes back', async () => {
  const d = await load('mod/core/deliver.ts');
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
  const d = await load('mod/core/deliver.ts');
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

test('deliver: typed through Remote Control (remote), chat is relayed (queued); mid-turn, a notice now too. A relay is only the room lines', async () => {
  const d = await load('mod/core/deliver.ts');
  const chat = { type: 'chat', lines: ['bob: hi', 'carol joined'] };
  assert.deepEqual(d.route(chat), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }]);
  assert.deepEqual(d.route(chat, { remote: true }), [{ do: 'relay', lines: ['bob: hi', 'carol joined'] }]);
  assert.deepEqual(d.route(chat, { remote: true, turnRunning: true }), [
    { do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }, { do: 'relay', lines: ['bob: hi', 'carol joined'] },
  ]);
  // what the person reads, and nothing else: no "(for Claude)" line in the prompt; the model's part is context
  const relay = d.relayText(['alice: hi', 'room: "Rate limiting" agreed (bob)', '', 'answer needed: "Rate limiting"']);
  assert.equal(relay, 'alice: hi\nroom: "Rate limiting" agreed (bob)\nanswer needed: "Rate limiting"');
  assert.doesNotMatch(relay, /for Claude/);
  assert.equal(d.relayText(''), '');
  assert.match(d.RELAY_CONTEXT, /^\(for Claude\) sub-human: .*Remote Control.*It needs no reply: a few words at most, or none/);
  const { gateVerdict, onRemote } = await load('mod/core/prompt.ts');
  // a relay may start "room:": that is no post (there is no room: tag), whoever submits it
  assert.equal(gateVerdict({ text: relay.split('\n').slice(1).join('\n'), origin: { kind: 'plugin', name: 'sub-human' } }), null);
  assert.deepEqual(['bridge', 'composer', 'sdk', 'peer', 'plugin'].map(kind => onRemote({ kind })), [true, false, false, undefined, undefined]);
  assert.equal(onRemote(undefined), undefined);
});

test('deliver: relayQueue sends every queued line as one relay, at most one per RELAY_GAP_MS', async () => {
  const d = await load('mod/core/deliver.ts');
  const q = d.relayQueue();
  assert.equal(q.take(0), null, 'nothing queued');
  assert.equal(q.add(['', '  ']), false);
  assert.equal(q.wait(0), 0, 'the first may go now');
  assert.ok(q.add(['alice: hi']));
  assert.ok(q.add('sub-human: ✗ not posted: the room is offline'));
  assert.equal(q.size, 2);
  assert.equal(q.take(1000), 'alice: hi\nsub-human: ✗ not posted: the room is offline');
  assert.equal(q.size, 0);
  q.add(['bob: there']);
  q.add(['room: "Rate limiting" agreed (bob)']);
  assert.equal(q.wait(1500), d.RELAY_GAP_MS - 500, 'the next waits out the gap');
  assert.equal(q.wait(1000 + d.RELAY_GAP_MS), 0);
  assert.equal(q.take(1000 + d.RELAY_GAP_MS), 'bob: there\nroom: "Rate limiting" agreed (bob)', 'coalesced');
  assert.ok(d.RELAY_GAP_MS >= 2000 && d.RELAY_GAP_MS <= 10_000, 'a few seconds');
});
