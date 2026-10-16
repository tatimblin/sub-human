// scripts/typings.ts copies Claude Code's generated declarations into typings/; scripts/probe-cc.ts fails while the
// snapshot was written by another version than contract.json `probed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writtenBy, copyTypings, ROOTS } from '../typings.ts';
import { typingsCheck, TYPINGS } from '../probe-cc.ts';

test('writtenBy: the version on the first line only', () => {
  assert.equal(writtenBy('// Written by Claude Code 2.1.296.\n// more'), '2.1.296');
  assert.equal(writtenBy('// Written by Claude Code 2.2.0-beta.1.\n'), '2.2.0-beta.1');
  assert.equal(writtenBy('// other\n// Written by Claude Code 2.1.296.'), null);
  assert.equal(writtenBy(''), null);
});

test('copyTypings: every type root copied, or an error naming the missing ones', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-typings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'types'), to = path.join(dir, 'typings');
  const missing = copyTypings(from, to);
  assert.ok('error' in missing && /claude-code, claude-code-tools, claude-code-mcp/.test(missing.error));
  for (const r of ROOTS) {
    fs.mkdirSync(path.join(from, r), { recursive: true });
    fs.writeFileSync(path.join(from, r, 'index.d.ts'), r === 'claude-code' ? '// Written by Claude Code 9.9.9.\n' : `// ${r}\n`);
  }
  const r = copyTypings(from, to);
  assert.deepEqual(r, { version: '9.9.9', copied: ROOTS.map(x => `${x}/index.d.ts`) });
  assert.equal(fs.readFileSync(path.join(to, 'claude-code-mcp', 'index.d.ts'), 'utf8'), '// claude-code-mcp\n');
});

test('typingsCheck: the committed snapshot matches contract.json probed; another version fails', t => {
  assert.deepEqual(typingsCheck().ok, true, `typings/claude-code was written by ${typingsCheck().version}, contract.json probed ${typingsCheck().probed}: npm run typings`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-typings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'index.d.ts');
  fs.writeFileSync(f, fs.readFileSync(TYPINGS, 'utf8').replace(/^\/\/ Written by Claude Code [^\n]*/, '// Written by Claude Code 0.0.1.'));
  assert.deepEqual(typingsCheck(f, '2.1.296'), { ok: false, version: '0.0.1', probed: '2.1.296' });
  assert.equal(typingsCheck(path.join(dir, 'none.d.ts')).ok, false, 'a missing snapshot fails');
});
