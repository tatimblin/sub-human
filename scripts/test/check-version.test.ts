// scripts/check-version.ts: a plugin change since the last version bump (or BASE) fails without a newer version.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, newer } from '../check-version.ts';

const MANIFEST = 'plugin/sub-human/.claude-plugin/plugin.json';

function repo(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' });
  const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const version = (v: string) => write(MANIFEST, JSON.stringify({ name: 'sub-human', version: v }) + '\n');
  const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); };
  git('init', '-q');
  version('0.1.0');
  write('plugin/sub-human/lib/a.js', '1');
  commit('first');
  return { dir, write, version, commit, git };
}

test('newer: numeric per part, a release beats its pre-release', () => {
  assert.equal(newer('0.10.0', '0.9.1'), true);
  assert.equal(newer('0.3.0', '0.3.0'), false);
  assert.equal(newer('0.2.9', '0.3.0'), false);
  assert.equal(newer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(newer('1.0.0-rc.2', '1.0.0-rc.1'), true);
  assert.equal(newer('0.5.0-beta.10', '0.5.0-beta.2'), true, 'numeric pre-release parts compare as numbers');
  assert.equal(newer('0.5.0-beta.2', '0.5.0-beta.10'), false);
  assert.equal(newer('0.5.0-beta.1', '0.4.5'), true);
  assert.equal(newer('0.5.0', '0.5.0-beta.3'), true);
  assert.equal(newer('0.5.0-beta', '0.5.0-alpha.9'), true);
  assert.equal(newer('0.5.0-beta.1', '0.5.0-beta'), true, 'more parts is newer');
});

test('check: plugin changes need a bump since the last bump; tests and files outside the plugin do not', t => {
  const r = repo(t);
  assert.equal(check({ cwd: r.dir }).ok, true, 'nothing changed since the first version');
  r.write('plugin/sub-human/test/x.test.js', '1');
  r.write('docs/x.md', '1');
  r.commit('tests and docs');
  assert.equal(check({ cwd: r.dir }).ok, true);
  r.write('plugin/sub-human/lib/a.js', '2');
  let c = check({ cwd: r.dir });
  assert.equal(c.ok, false, 'an uncommitted plugin change counts');
  assert.deepEqual(c.changed, ['plugin/sub-human/lib/a.js']);
  r.commit('change');
  r.write('plugin/sub-human/lib/new.js', '1');
  c = check({ cwd: r.dir });
  assert.deepEqual([c.ok, c.changed], [false, ['plugin/sub-human/lib/a.js', 'plugin/sub-human/lib/new.js']], 'an untracked file too');
  r.version('0.0.9');
  assert.equal(check({ cwd: r.dir }).ok, false, 'a lower version is no bump');
  r.version('0.2.0');
  assert.equal(check({ cwd: r.dir }).ok, true);
  r.commit('release 0.2.0');
  assert.equal(check({ cwd: r.dir }).why, `no plugin change since ${check({ cwd: r.dir }).base}`, 'the bump commit is the new base');
  // an explicit BASE, and the newest tag
  assert.equal(check({ cwd: r.dir, base: 'HEAD~2' }).ok, true);
  r.git('tag', 'v0.2.0');
  r.write('plugin/sub-human/lib/a.js', '3');
  r.commit('after the tag');
  assert.deepEqual([check({ cwd: r.dir }).ok, check({ cwd: r.dir }).base], [false, 'v0.2.0']);
});
