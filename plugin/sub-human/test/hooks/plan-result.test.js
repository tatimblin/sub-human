'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { World, fixture, room, roomPlan } = require('./helpers.js');

const postExit = (planText, extra = {}, mode = 'default') => {
  const b = fixture('post-exitplan');
  return { ...b, permission_mode: mode, tool_response: { ...b.tool_response, plan: planText, ...extra } };
};
test('orch: decision once per hash with refs to the sign-offs; otherwise a status', () => {
  const w = new World({ orch: 'act', alice: 'sleep', bob: 'sleep' });
  const text = roomPlan(w.code, ['alice', 'bob']);
  const h = w.publish(text, ['alice', 'bob']);
  // not yet signed: status
  w.hook('plan-result', postExit(text), { as: 'orch' });
  let e = w.entries().at(-1);
  assert.equal(e.kind, 'status');
  assert.match(e.text, /lacks sign-off from alice and bob/);

  const a = w.sign('alice', h), b = w.sign('bob', h);
  let r = w.hook('plan-result', postExit(text), { as: 'orch' });
  e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.via, e.plan_hash, e.refs], ['decision', 'system', h, [a.id, b.id]]);
  // The hook hands over the next step directly; the orch must not wait for its own decision notice.
  const ctx = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  assert.match(ctx, new RegExp(`Decision #${e.id} .*Post the assignments`));
  const n = w.entries().length;
  r = w.hook('plan-result', postExit(text), { as: 'orch' });
  assert.equal(w.entries().length, n, 'at most one decision per hash');
  assert.match(r.json.hookSpecificOutput.additionalContext, new RegExp(`Decision #${e.id} `), 'a repeat exit still names the existing decision');
  assert.ok(w.lib(() => room.decided(h)));

  w.hook('plan-result', postExit('# other\n'), { as: 'orch' });
  assert.match(w.entries().at(-1).text, /does not match the current plan_rev/);
});

test('member: no opinion and nothing logged, even on a room plan', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  const text = roomPlan(w.code, ['alice']);
  const h = w.publish(text, ['alice']);
  for (const t of ['# my plan\n', text]) {
    const r = w.hook('plan-result', postExit(t), { as: 'alice' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
  assert.equal(w.entries().length, 1);
  assert.equal(w.lib(() => room.signoffMatrix(h)).complete, false);
});
