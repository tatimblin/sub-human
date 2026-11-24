import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from './api.js';
import { nameFrom, newCode } from './join.js';

test('nameFrom: the first word, lowercased, marks dropped; reserved words, -digits names and nothing left are no name', () => {
  for (const [text, want] of [
    ['Tristan Timblin', 'tristan'], ['  Zoë  ', 'zoe'], ['ÅSA-lind', 'asa-lind'], ['o\'brien', 'obrien'], ['__x', 'x'],
    ['room', null], ['help', null], ['', null], ['日本', null], ['a'.repeat(40), 'a'.repeat(32)],
    ['alice-2', null], ['bob-10', null], ['r2-d2', 'r2-d2'], ['agent-x', 'agent-x'], ['b2', 'b2'],
  ] as const) assert.equal(nameFrom(text), want, text);
});

test('newCode is a word and four digits (R2)', () => {
  let x = 0;
  for (let i = 0; i < 50; i++) assert.match(newCode(() => (x = (x + 0.137) % 1)), CODE);
  assert.equal(newCode(() => 0), 'otter-0000');
  assert.equal(newCode(() => 0.99999), 'zebra-9999');
});
