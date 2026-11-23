// test/helpers.ts: temp homes for every test process, and REAL CONFIG TOUCHED for a write into the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, touches } from './helpers.ts';

const HELPERS = path.join(import.meta.dirname, 'helpers.ts');

test('the process runs in temp homes with no inherited CLAUDE* variable', () => {
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'SUB_HUMAN_HOME']) assert.ok(process.env[k]?.startsWith(ROOT), k);
  assert.deepEqual(Object.keys(process.env).filter(k => k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR'), []);
});

test('touches: a guarded place and what is under it, nothing beside it', () => {
  const g = ['/u/.sub-human', '/u/.claude'];
  assert.equal(touches('/u/.sub-human', g), true);
  assert.equal(touches('/u/.claude/tasks/x.json', g), true);
  assert.equal(touches('/u/.claude-other/x', g), false);
  assert.equal(touches('/u/project/.sub-human', g), false);
});

// a child whose "real" home is a temp dir: its writes there are refused, and the file fails
function child(home: string, code: string): { status: number | null, stderr: string } {
  const r = spawnSync(process.execPath, ['--import', HELPERS, '--input-type=module', '-e', code], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, SUB_HUMAN_HOME: path.join(home, 'sh'), CLAUDE_CONFIG_DIR: path.join(home, 'cfg') },
  });
  return { status: r.status, stderr: r.stderr };
}

test('a write into the real homes fails the process, even when the test catches it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cases: [string, string][] = [
    ['writeFileSync', `import { writeFileSync } from 'node:fs'; try { writeFileSync(${JSON.stringify(path.join(home, 'sh', 'x'))}, '') } catch {}`],
    ['fs/promises', `import { mkdir } from 'node:fs/promises'; await mkdir(${JSON.stringify(path.join(home, 'cfg', 'tasks'))}, { recursive: true }).catch(() => {})`],
    ['~/.claude.json', `import fs from 'node:fs'; try { fs.openSync(${JSON.stringify(path.join(home, '.claude.json'))}, 'w') } catch {}`],
  ];
  for (const [what, code] of cases) {
    const r = child(home, code);
    assert.equal(r.status, 1, what);
    assert.match(r.stderr, /REAL CONFIG TOUCHED/, what);
  }
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written');
  const ok = child(home, `import fs from 'node:fs'; fs.writeFileSync(process.env.SUB_HUMAN_HOME + '/x', ''); fs.readFileSync(${JSON.stringify(HELPERS)})`);
  assert.deepEqual(ok, { status: 0, stderr: '' }, 'the temp homes and reads are fine');
});

test("a child's write into a real home, of a directory the run also made in its temp home, fails the process", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'sh', 'rooms'), { recursive: true }); // there before the run: not reported
  await new Promise(r => setTimeout(r, 100));
  // the grandchild runs without the preload, as any child process the code under test starts
  const grandchild = (dirs: string[]): string => `import { spawnSync } from 'node:child_process';
    const dirs = ${JSON.stringify(dirs)}.map(d => d.replace('TEMP', process.env.SUB_HUMAN_HOME));
    spawnSync(process.execPath, ['-e', 'for (const d of process.argv.slice(1)) require("fs").mkdirSync(d, { recursive: true })', ...dirs]);`;
  const leak = child(home, grandchild(['TEMP/rooms/otter-4821', path.join(home, 'sh', 'rooms', 'otter-4821')]));
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /REAL CONFIG TOUCHED: .*otter-4821/);
  const beside = child(home, grandchild(['TEMP/rooms/lark-1111', path.join(home, 'sh', 'rooms', 'someone-else')]));
  assert.deepEqual(beside, { status: 0, stderr: '' }, "a name the run didn't make (a live session beside it) is not reported");
});
