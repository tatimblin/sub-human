'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { World, room } = require('./helpers.js');

const note = type => ({ hook_event_name: 'Notification', notification_type: type, message: 'Claude needs your attention' });

test('presence: Notification idle_prompt / permission_prompt and StopFailure write the member presence file', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const read = () => w.lib(() => room.open(w.code).store.kv.get('presence/alice', null));
  let r = w.hook('presence', note('idle_prompt'), { as: 'alice' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(read().state, 'idle');
  w.hook('presence', note('permission_prompt'), { as: 'alice' });
  assert.equal(read().state, 'permission');
  w.hook('presence', { hook_event_name: 'StopFailure', error: 'rate_limit' }, { as: 'alice' });
  assert.deepEqual([read().state, read().detail], ['error', 'rate_limit']);
  // other notification types change nothing
  w.hook('presence', note('elicitation_dialog'), { as: 'alice' });
  assert.equal(read().state, 'error');
  // the hooks module's "Working" (mod/prompt.mjs on the person's prompt, since at-room no longer runs for each)
  w.hook('presence', { hook_event_name: 'Working' }, { as: 'alice' });
  assert.equal(read().state, 'working');
  assert.equal(w.entries().length, 0, 'presence never touches the log');
});

test('presence: not joined -> nothing written', () => {
  const w = new World({ claude: 'sleep' });
  const r = w.hook('presence', note('idle_prompt'));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.lib(() => room.open(w.code).store.kv.list('presence/')), []);
});
