// scripts/kit-fixtures.ts: the kit's copy of the recorded fixtures matches the JSON files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureDir, KIT_FILE, kitText } from '../kit-fixtures.ts';

test('kit-fixtures.ts is what the fixtures give', () => {
  const dir = fixtureDir();
  assert.equal(fs.readFileSync(KIT_FILE, 'utf8'), kitText(dir), 'run node scripts/kit-fixtures.ts');
});

test('a changed fixture changes the text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.json'), '{"x":1}');
  const before = kitText(dir);
  assert.match(before, /"a": \{"x":1\}/);
  fs.writeFileSync(path.join(dir, 'a.json'), '{"x":2}');
  assert.notEqual(kitText(dir), before);
});
