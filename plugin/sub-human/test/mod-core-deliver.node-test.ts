// mod/core/deliver.ts in node: its timing constants against lib/config.ts, the restart backoff, the notice's
// window, and the turn ledger that decides which wakes are submitted again. The wiring is mod/test/deliver.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { TailEvent } from '../mod/core/types.ts';
import type * as deliverMod from '../mod/core/deliver.ts';
import type * as shimMod from '../mod/core/shim.ts';
import type * as promptMod from '../mod/core/prompt.ts';
import type * as constantsMod from '../mod/core/constants.ts';
import { must } from './support/must.ts';

interface Core {
  'mod/core/deliver.ts': typeof deliverMod;
  'mod/core/shim.ts': typeof shimMod;
  'mod/core/prompt.ts': typeof promptMod;
}
const load = <K extends keyof Core>(rel: K): Promise<Core[K]> => import(path.join(import.meta.dirname, '..', rel));

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
  assert.deepEqual(d.tailEnv('sid-1', '/p'), { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: 'sid-1' }, 'a hook\'s env, without SUB_HUMAN_VIA');
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
  const chat: TailEvent = { type: 'chat', lines: ['bob: hi', 'carol joined'] };
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
  assert.equal(gateVerdict({ text: relay.split('\n').slice(1).join('\n'), origin: { kind: 'plugin', name: 'sub-human' } }, undefined), null);
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

test('deliver: the tail\'s invites event (the host\'s open invite refs) is one invites action; a malformed one is nothing', async () => {
  const d = await import('../mod/core/deliver.ts');
  const ev = d.parseEvent(JSON.stringify({ type: 'invites', open: ['abcdef012345', 3] }));
  assert.deepEqual(ev, { type: 'invites', open: ['abcdef012345'] });
  assert.deepEqual(d.route(ev), [{ do: 'invites', open: ['abcdef012345'] }]);
  assert.equal(d.parseEvent(JSON.stringify({ type: 'invites' })), null);
});

test('deliver (item 5): a member\'s wake goes as its lines for the person, bare, and its "(for Claude)" lines as context; one with none goes framed', async () => {
  const d = await import('../mod/core/deliver.ts');
  const wake = `${d.WAKE_HEAD}\nalice: @bob just say ok\n  │ please\n(for Claude) room now: proposal a1 waiting on bob`;
  const p = must(d.wakeParts(wake));
  assert.equal(p.shown, 'alice: @bob just say ok\n  │ please');
  assert.deepEqual(p.context.split('\n'), [d.WAKE_CONTEXT, d.WAKE_HEAD, '(for Claude) room now: proposal a1 waiting on bob']);
  assert.equal(d.wakeParts(`${d.WAKE_HEAD}\n(for Claude) only for the model`), null);
});

test('stage 8e B: the room context is held for the next prompt: events merge, the newest kept under PULL_CAP, and a prompt clears only what it carried', async () => {
  const d = await load('mod/core/deliver.ts');
  const { PULL_HEAD, PULL_END } = await import(path.join(import.meta.dirname, '..', 'mod/core/constants.ts')) as typeof constantsMod; // a dynamic import, typed
  let held = d.holdPull(null, [PULL_HEAD, 'bob joined', PULL_END].join('\n'));
  held = d.holdPull(held, [PULL_HEAD, '(2 earlier lines not shown: the room read tool has them)', 'bob: hi', PULL_END].join('\n'));
  const ctx = must(d.pullContext(held));
  assert.deepEqual(ctx.text.split('\n'), [PULL_HEAD, '(2 earlier lines not shown: the room read tool has them)', 'bob joined', 'bob: hi', PULL_END]);
  assert.equal(ctx.upTo, 2);
  // a third arrives after the prompt took its context: clearing what it carried keeps the third
  const more = d.holdPull(held, `${PULL_HEAD}\ncarol joined\n${PULL_END}`);
  assert.deepEqual(must(d.pullContext(d.clearPulls(more, ctx.upTo))).text.split('\n'), [PULL_HEAD, 'carol joined', PULL_END]);
  assert.equal(d.clearPulls(held, ctx.upTo), null);
  assert.equal(d.pullContext(null), null);
  // a session that never prompts again holds at most the cap, the oldest lines counted as left out
  let big = null;
  for (let i = 0; i < 100; i++) big = d.holdPull(big, `${PULL_HEAD}\nline ${i} ${'x'.repeat(40)}\n${PULL_END}`, 500);
  const text = must(d.pullContext(big)).text;
  assert.ok(text.length < 500 + PULL_HEAD.length + PULL_END.length + 80, String(text.length));
  assert.match(text, /\nline 99 /);
  assert.match(text, /^.*\n\(\d+ earlier lines not shown/);
});
