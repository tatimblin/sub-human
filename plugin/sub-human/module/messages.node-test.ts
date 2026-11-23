// messages.ts addressed: which `to` is a member of my room. A throw here would let the send go native, so every input
// answers, whatever the engine hands the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressed } from './messages.js';

test('NAME.CODE of my room is that NAME; any other address is null', () => {
  assert.equal(addressed('bob.otter-4821', 'otter-4821'), 'bob');
  assert.equal(addressed('bob-2.otter-4821', 'otter-4821'), 'bob-2');
  assert.equal(addressed('bob.heron-1111', 'otter-4821'), null);
  assert.equal(addressed('team-lead', 'otter-4821'), null);
  assert.equal(addressed('.otter-4821', 'otter-4821'), null);
});

test('a to that is no string is null, never a throw', () => {
  for (const to of [undefined, null, 42, { name: 'bob.otter-4821' }, ['bob.otter-4821']]) assert.equal(addressed(to, 'otter-4821'), null);
});
