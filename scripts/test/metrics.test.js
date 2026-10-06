'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trigger, seatTranscriptMetrics } = require('../metrics.js');

const mon = id => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<task-notification><summary>Monitor event: "sub-human room notices"</summary><event>#${id}</event></task-notification>` } });
const rowDone = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><task-id>a1</task-id><output-file>/x</output-file></task-notification>' } };
const rewake = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><summary>sub-human: restoring rows</summary></task-notification> sub-human: this session was resumed and its rows did not survive it.' } };
const human = { type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } };
const asst = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
const toolRes = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } };

test('trigger: monitor, rewake, peer; row completions and humans are not room wakes', () => {
  assert.equal(trigger(mon(1)), 'monitor');
  assert.equal(trigger(rewake), 'rewake');
  assert.equal(trigger({ type: 'user', origin: { kind: 'peer' }, message: { content: 'x' } }), 'peer');
  assert.equal(trigger(rowDone), null);
  assert.equal(trigger(human), null);
  assert.equal(trigger(toolRes), null);
});

test('wakes: adjacent notices that start one turn count once; a notice absorbed by a human prompt is no wake', () => {
  const es = [human, asst, mon(1), mon(2), asst, toolRes, asst, mon(3), human, asst, rowDone, rewake, asst,
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptExpansion', content: ['abcd'] } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit', content: ['xy'] } }];
  const m = seatTranscriptMetrics([{ es }]);
  assert.equal(m.wakes.turns, 2);
  assert.equal(m.wakes.notices, 3);
  assert.equal(m.wakes.rewake, 1);
  assert.equal(m.wakes.rowNotifications, 1);
  assert.deepEqual([m.injected.join, m.injected.total], [4, 6]);
});
