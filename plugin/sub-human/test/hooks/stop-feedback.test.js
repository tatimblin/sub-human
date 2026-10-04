'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, roomPlan } = require('./helpers.js');

const DECLINE_ID = 'toolu_01TPMFGmTb2Mn5x1RBLn3zrG';

function setup(lines, toolUseId = DECLINE_ID) {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const h = w.publish(roomPlan(w.code, ['alice']), ['alice']);
  fs.mkdirSync(w.memberDir('alice'), { recursive: true });
  fs.writeFileSync(path.join(w.memberDir('alice'), 'pending_review.json'), JSON.stringify({ hash: h, pid: process.pid, tool_use_id: toolUseId }));
  const tp = path.join(w.cwd, 'transcript.jsonl');
  fs.writeFileSync(tp, '{"type":"summary"}\n' + lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { w, h, input: { ...fixture('stop'), transcript_path: tp } };
}
const pendingGone = w => !fs.existsSync(path.join(w.memberDir('alice'), 'pending_review.json'));

test('"Tell Claude what to change" feedback becomes a via=human objection; never blocks', () => {
  const { w, h, input } = setup(fixture('transcript-decline'));
  const r = w.hook('stop-feedback', input, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'never blocks the stop');
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via, e.plan_hash, e.text], ['objection', 'alice', 'human', h, 'OBJECT: use 3 retries not 5']);
  assert.ok(pendingGone(w));
  // a second Stop logs nothing more
  w.hook('stop-feedback', input, { as: 'alice' });
  assert.equal(w.entries().length, 2);
});

test('without userFeedback the text is parsed from "the user said:\\n…\\n\\nNote:"', () => {
  const lines = fixture('transcript-decline');
  delete lines[1].userFeedback;
  lines[1].message.content[0].content = [{ type: 'text', text: lines[1].message.content[0].content.replace('OBJECT: use 3 retries not 5', 'multi\nline feedback') }];
  const { w, input } = setup(lines);
  w.hook('stop-feedback', input, { as: 'alice' });
  assert.equal(w.entries().at(-1).text, 'multi\nline feedback');
});

test('a plain Esc decline clears pending_review and logs nothing', () => {
  const { w, input } = setup(fixture('transcript-esc'), 'toolu_esc');
  w.hook('stop-feedback', input, { as: 'alice' });
  assert.equal(w.entries().length, 1);
  assert.ok(pendingGone(w));
});

test('a decline of some other tool call, or no pending review, is ignored', () => {
  const { w, input } = setup(fixture('transcript-decline'), 'toolu_other');
  w.hook('stop-feedback', input, { as: 'alice' });
  assert.equal(w.entries().length, 1);
  assert.equal(pendingGone(w), false);

  const w2 = new World({ orch: 'sleep', alice: 'act' });
  const r = w2.hook('stop-feedback', { ...input }, { as: 'alice' });
  assert.equal(r.stdout, '');
  assert.equal(w2.entries().length, 0);
});

test('an unreadable transcript never fails the stop', () => {
  const { w, input } = setup([]);
  const r = w.hook('stop-feedback', { ...input, transcript_path: '/nonexistent/x.jsonl' }, { as: 'alice' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
