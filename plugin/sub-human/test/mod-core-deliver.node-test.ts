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

test('deliver: chat is notices, whatever the person types from (no Remote Control relay)', async () => {
  const d = await load('mod/core/deliver.ts');
  const chat: TailEvent = { type: 'chat', lines: ['bob: hi', 'carol joined'] };
  assert.deepEqual(d.route(chat), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }]);
  assert.deepEqual(d.route(chat, { turnRunning: true }), [{ do: 'log', text: 'bob: hi' }, { do: 'log', text: 'carol joined' }]);
});

test('deliver: the tail\'s invites event (the host\'s open invite refs) is one invites action; a malformed one is nothing', async () => {
  const d = await import('../mod/core/deliver.ts');
  const ev = d.parseEvent(JSON.stringify({ type: 'invites', open: ['abcdef012345', 3] }));
  assert.deepEqual(ev, { type: 'invites', open: ['abcdef012345'] });
  assert.deepEqual(d.route(ev), [{ do: 'invites', open: ['abcdef012345'] }]);
  assert.equal(d.parseEvent(JSON.stringify({ type: 'invites' })), null);
});

test('deliver (PLAN-JOIN step 3): the tail\'s take is one take action whether a turn runs or not; one with no room code is nothing', async () => {
  const d = await import('../mod/core/deliver.ts');
  const ev = d.parseEvent(JSON.stringify({ type: 'take', code: 'otter-4821', name: 'bob', text: 'type /sub-human', check: 'check 3f9c-2a71' }));
  assert.deepEqual(ev, { type: 'take', code: 'otter-4821', name: 'bob', text: 'type /sub-human', check: 'check 3f9c-2a71' });
  for (const turnRunning of [false, true]) assert.deepEqual(d.route(ev, { turnRunning }), [{ do: 'take', code: 'otter-4821', name: 'bob', text: 'type /sub-human', check: 'check 3f9c-2a71' }]);
  assert.deepEqual(d.parseEvent(JSON.stringify({ type: 'take', code: 'otter-4821' })), { type: 'take', code: 'otter-4821', name: '', text: '' });
  assert.equal(d.parseEvent(JSON.stringify({ type: 'take', code: '../x', name: 'bob' })), null);
  assert.equal(d.takeFallback('otter-4821', ''), 'the host let you in to room otter-4821: type /sub-human to join it');
});

test('deliver (PLAN-JOIN step 3): a taken seat\'s wake is one line for the person (with the check) and the seat\'s block as (for Claude) lines; it holds nothing else', async () => {
  const d = await import('../mod/core/deliver.ts');
  const context = 'SUB-HUMAN: you are bob\'s Claude in room otter-4821 (with alice).\n\nROWS: Agent({…})';
  const w = d.takeWake({ code: 'otter-4821', name: 'bob', check: 'check 3f9c-2a71', context });
  assert.equal(w.shown, 'You\'re in room otter-4821 as bob (check 3f9c-2a71, as the host\'s room line shows)');
  const parts = must(d.wakeParts(w.text), 'a member wake');
  assert.equal(parts.shown, w.shown, 'the person sees the one line');
  assert.deepEqual(parts.context.split('\n').slice(1), [
    `(for Claude) ${d.TAKE_CONTEXT}`,
    '(for Claude) SUB-HUMAN: you are bob\'s Claude in room otter-4821 (with alice).',
    '(for Claude) ROWS: Agent({…})',
  ]);
  assert.equal(d.takeWake({ code: 'otter-4821', name: '', context: '' }).shown, 'You\'re in room otter-4821');
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
