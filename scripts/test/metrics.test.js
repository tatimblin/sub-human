'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trigger, seatTranscriptMetrics } = require('../metrics.js');

const wake = id => ({ type: 'user', origin: { kind: 'plugin', name: 'sub-human' }, message: { content: `sub-human: room entry #${id}` } });
const rowDone = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><task-id>a1</task-id><output-file>/x</output-file></task-notification>' } };
const rewake = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><summary>sub-human: restoring rows</summary></task-notification> sub-human: this session was resumed and its rows did not survive it.' } };
const human = { type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } };
const asst = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
const toolRes = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } };

test('trigger: plugin prompt, rewake, peer; its isMeta copy, row completions and humans are not room wakes', () => {
  assert.equal(trigger(wake(1)), 'plugin');
  assert.equal(trigger({ ...wake(1), isMeta: true }), null);
  assert.equal(trigger(rewake), 'rewake');
  assert.equal(trigger({ type: 'user', origin: { kind: 'peer' }, message: { content: 'x' } }), 'peer');
  assert.equal(trigger(rowDone), null);
  assert.equal(trigger(human), null);
  assert.equal(trigger(toolRes), null);
});

test('wakes: adjacent notices that start one turn count once; a notice absorbed by a human prompt is no wake', () => {
  const es = [human, asst, wake(1), wake(2), asst, toolRes, asst, wake(3), human, asst, rowDone, rewake, asst,
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptExpansion', content: ['abcd'] } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit', content: ['xy'] } }];
  const m = seatTranscriptMetrics([{ es }]);
  assert.equal(m.wakes.turns, 2);
  assert.equal(m.wakes.plugin, 3);
  assert.equal(m.wakes.rewake, 1);
  assert.equal(m.wakes.rowNotifications, 1);
  assert.deepEqual([m.injected.join, m.injected.total], [4, 6]);
});

test('cardTurns: model calls from the waking notice to the card, and after the answer to the end of the turn', () => {
  const { cardTurns } = require('../metrics.js');
  const a = (id, content) => ({ type: 'assistant', timestamp: `t${id}`, message: { id, content } });
  const card = { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'agree?', header: 'proposal 54be84' }] } };
  const es = [wake(1), a('m1', [{ type: 'text', text: 'opening' }]), a('m2', [card]), toolRes, a('m3', [{ type: 'text', text: 'ok' }]), human, a('m4', [{ type: 'text', text: 'x' }]),
    a('m5', [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'pick a color' }] } }])];
  assert.deepEqual(cardTurns(es).map(c => [c.hash, c.toCard, c.after]), [['54be84', 2, 1]], 'an unrelated question is no card');
  // the plan view: ToolSearch, EnterPlanMode, then ExitPlanMode "proposal <hash>"; the exit after an objection counts after
  const tu = (name, input) => ({ type: 'tool_use', name, input });
  const pv = [wake(1), a('p1', [tu('ToolSearch', { query: 'select:EnterPlanMode,ExitPlanMode' })]), toolRes, a('p2', [tu('EnterPlanMode', {})]), toolRes,
    a('p3', [tu('ExitPlanMode', { plan: 'proposal 54be84aa0011' })]), toolRes, a('p4', [tu('ExitPlanMode', {})]), toolRes, a('p5', [{ type: 'text', text: 'ok' }])];
  assert.deepEqual(cardTurns(pv).map(c => [c.hash, c.toCard, c.after]), [['54be84aa0011', 3, 2]]);
});

test('isRed: SGR 31/91, 256-color and truecolor reds; other colors are not', () => {
  const { isRed } = require('../metrics.js');
  assert.ok(isRed('\x1b[31mError\x1b[39m'));
  assert.ok(isRed('\x1b[38;5;196mx'));
  assert.ok(isRed('\x1b[38;2;255;107;128mhook failed'));
  assert.ok(!isRed('\x1b[38;5;220mUpdate available'));
  assert.ok(!isRed('\x1b[38;2;215;119;87mClaude Code'));
  assert.ok(!isRed('plain'));
});

// ---------- W4: the hooks module's delivery (plugin prompts, $.ui.log chat rows, isMeta copies) ----------
const plug = { type: 'user', origin: { kind: 'plugin', name: 'sub-human' }, message: { content: '(for Claude) sub-human room: …\nbob: @alice look' } };
const pull = { type: 'user', isMeta: true, origin: { kind: 'plugin', name: 'sub-human' }, message: { content: 'Room since your last turn (…):\nbob: hi' } };
const note = { type: 'system', subtype: 'informational', level: 'notice', content: 'sub-human: bob: hi' };
const end = { type: 'system', subtype: 'turn_duration' };
const a = id => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'ok' }] } });

test('trigger: a sub-human plugin prompt is a wake; its isMeta copy and another plugin are not', () => {
  assert.equal(trigger(plug), 'plugin');
  assert.equal(trigger(pull), null);
  assert.equal(trigger({ ...plug, origin: { kind: 'plugin', name: 'other' } }), null);
});

test('chat: notices and pulls are counted; a turn that only chat rows started is a chat call, others are not', () => {
  const quiet = seatTranscriptMetrics([{ es: [human, a('m1'), end, note, pull, note, pull, human, a('m2'), end, plug, a('m3'), end] }]);
  assert.deepEqual(quiet.chat, { notices: 2, pulls: 2, turns: 0, calls: 0, callsPerBurst: 0 });
  assert.equal(quiet.wakes.plugin, 1);
  assert.equal(quiet.wakes.turns, 1);
  const noisy = seatTranscriptMetrics([{ es: [human, a('m1'), end, note, pull, a('m2'), a('m2'), a('m3'), end] }]);
  assert.deepEqual(noisy.chat, { notices: 1, pulls: 1, turns: 1, calls: 2, callsPerBurst: 2 });
});

test('chat: Claude Code\'s synthetic "No response requested." and a queued prompt are not chat calls', () => {
  const synth = { type: 'assistant', message: { id: 's1', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } };
  const queued = { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…' };
  const m = seatTranscriptMetrics([{ es: [human, a('m1'), end, note, pull, synth, queued, a('m2'), end] }]);
  assert.deepEqual([m.chat.turns, m.chat.calls], [0, 0]);
});
