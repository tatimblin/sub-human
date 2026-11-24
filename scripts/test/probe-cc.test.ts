// scripts/probe-cc.ts: its arguments, the committed contract read, and the report's lines. No binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, readContract, report, lines, CONTRACT } from '../probe-cc.ts';
import { TARGET } from '../typings.ts';

test('parseArgs: --bin, --typings, --no-typings, --json, --print-bin; anything else is an error', () => {
  assert.deepEqual(parseArgs([]), { typings: TARGET, versionCheck: true, json: false, printBin: false });
  assert.deepEqual(parseArgs(['--bin', '/x/claude', '--typings', '/t', '--no-typings', '--json']),
    { bin: path.resolve('/x/claude'), typings: path.resolve('/t'), versionCheck: false, json: true, printBin: false });
  assert.deepEqual(parseArgs(['--print-bin']), { typings: TARGET, versionCheck: true, json: false, printBin: true });
  assert.ok('error' in parseArgs(['--bin']));
  assert.ok('error' in parseArgs(['--only', 'x']));
});

test('readContract: the committed contract parses; a broken one says where', t => {
  const read = readContract(CONTRACT);
  assert.ok(read.ok, read.ok ? '' : read.error);
  const c = read.value;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'contract.json');
  fs.writeFileSync(f, JSON.stringify({ ...c, entries: [...c.entries, c.entries[0]] }));
  const bad = readContract(f);
  assert.ok(!bad.ok && /unique/.test(bad.error));
});

test('lines: an entry a line, the typings check, a failed feature with its SUB_HUMAN_CC_OFF value, the verdict', () => {
  const read = readContract(CONTRACT);
  assert.ok(read.ok);
  const c = read.value;
  const r = report(c, '/x/claude', { typings: '', binary: 'VERSION:"2.1.330"' }, { ok: false, version: '2.1.296', probed: c.probed });
  assert.equal(r.ok, false);
  const out = lines(r);
  assert.equal(out[0], `claude 2.1.330  /x/claude  (contract probed on ${c.probed})`);
  assert.equal(out.filter(l => /^(PASS|FAIL|SKIP) /.test(l)).length, c.entries.length + 1);
  assert.ok(out.some(l => /^FAIL {2}typings .*written by 2\.1\.296.*npm run typings$/.test(l)));
  assert.ok(out.includes(`wake: 2/2 failed (wake-submit, wake-frame); off with SUB_HUMAN_CC_OFF=wake`));
  assert.match(out.at(-1) ?? '', /^0\/\d+ pass, 0 skipped: FAIL$/);
});
