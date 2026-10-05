'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, fixture, identity, ctx, hso, roomPlan } = require('./helpers.js');

test('session-end: logs member_left and marks the member left; reasons clear and resume are skipped', () => {
  const w = new World({ orch: 'sleep', alice: 'act' });
  let r = w.hook('session-end', { ...fixture('session-end'), reason: 'clear' }, { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  w.hook('session-end', { ...fixture('session-end'), reason: 'resume' }, { as: 'alice' });
  assert.equal(w.entries().length, 0);
  assert.equal(w.members().alice.left_at, undefined);

  r = w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.from, e.via], ['member_left', 'alice', 'system']);
  assert.match(e.text, /prompt_input_exit/);
  assert.ok(w.members().alice.left_at);
  // a second end (already left) logs nothing
  w.hook('session-end', fixture('session-end'), { as: 'alice' });
  assert.equal(w.entries().length, 1);
});
