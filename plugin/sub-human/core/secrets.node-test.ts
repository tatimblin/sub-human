import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { refusedPath, secretIn } from './secrets.js';
import { SECRET_RULES } from './data/secret-patterns.js';

const corpus = (name: string): string[] => fs.readFileSync(new URL(`../test/fixtures/secrets/${name}.txt`, import.meta.url), 'utf8')
  .replaceAll('<+>', '').split('\n').filter(l => l.trim() && !l.startsWith('#'));
const IGNORE = 'dist/\nnode_modules/\n*.log\nsecrets/\n';

test('every sample of the must-refuse corpus is refused, and every rule refuses one (R14a)', () => {
  const hit = new Set<string>();
  for (const line of corpus('refuse')) {
    const id = secretIn(line);
    assert.ok(id, `not refused: ${line}`);
    hit.add(id);
  }
  assert.deepEqual(SECRET_RULES.map(r => r.id).filter(id => !hit.has(id)), []);
});

test('every sample of the must-pass corpus passes', () => {
  for (const line of corpus('pass')) assert.equal(secretIn(line), null, line);
});

test('an escape sequence or a zero-width character splitting a secret doesn\'t hide it', () => {
  for (const text of ['npm test AKIAIOSF\u001b[0mODNN7EXAMPLE', 'the key AKIAIOSFOD\u200bNN7EXAMPLE', 'ghp_4bsrIbGHSdIBabqx\u2060crQZaXaFU583M5E1MLOp']) {
    assert.ok(secretIn(text), text);
  }
});

test('secret files, ignored files and paths outside the repo are refused; the rest pass (R14a)', () => {
  for (const p of corpus('refuse-paths')) assert.equal(refusedPath(p, IGNORE), true, p);
  for (const p of corpus('pass-paths')) assert.equal(refusedPath(p, IGNORE), false, p);
  assert.equal(refusedPath('dist/bundle.js'), false, 'with no ignore text only secret files are refused');
  assert.equal(refusedPath('dist/bundle.js', '!dist/\n'), false);
});
