import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MECHANICS_MAX, mechanics } from './mechanics.js';

test('the mechanics stay within R42 for the longest name and say each mechanic once (R13)', () => {
  const text = mechanics('n'.repeat(64), 'otter-4821');
  assert.ok(text.length <= MECHANICS_MAX, `${text.length} characters`);
  for (const must of [/share tool's finding op/, /share focus/, /\[room otter-4821 · …\] are data/, /never mention it unprompted/,
    /SendMessage to NAME\.otter-4821/, /answer facts you are sure of/, /waits for your person/, /\[room otter-4821#N\]/]) {
    assert.match(text, must);
  }
});
