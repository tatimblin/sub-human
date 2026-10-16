// No test and no dev run touches the real ~/.sub-human. Every test process runs under a temp SUB_HUMAN_HOME
// (helpers.ts, preloaded by test/index.js) that its children inherit. And a CLI run or a SessionStart from a dev
// checkout or worktree without SUB_HUMAN_HOME (so on the real home) never takes over <home>/bin/current from the
// installed plugin: lib/remote/shim.ts refreshes passively there, forced only by host --ssh, admit, authorize and
// doctor --fix. Here the "real home" is a fake user's (HOME), so nothing real is touched either.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as shim from '../lib/remote/shim.ts';
import { isTempPath } from '../lib/home.ts';

test('guard: every test process has a temp SUB_HUMAN_HOME, never the real one, and its children inherit it', () => {
  const real = path.join(os.homedir(), '.sub-human');
  assert.ok(process.env.SUB_HUMAN_HOME, 'helpers.ts sets it');
  assert.notEqual(path.resolve(process.env.SUB_HUMAN_HOME), path.resolve(real));
  assert.ok(isTempPath(process.env.SUB_HUMAN_HOME), process.env.SUB_HUMAN_HOME);
  assert.equal(h.childEnv().SUB_HUMAN_HOME, process.env.SUB_HUMAN_HOME);
  const seen = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(h.LIB, 'home.ts'))}).home())`],
    { env: h.childEnv(), encoding: 'utf8' }).stdout;
  assert.equal(seen, process.env.SUB_HUMAN_HOME, 'a child resolves the temp home');
});

/** A fake user whose ~/.sub-human records an installed plugin (a root under the plugin cache, with a CLI). */
function fakeUser(t: TestContext) {
  const user = h.tmpDir('sh-user-', t);
  const installed = path.join(user, '.claude', 'plugins', 'cache', 'mkt', 'sub-human', '0.3.9');
  fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'scripts', 'sub-human'), '');
  const bin = path.join(user, '.sub-human', 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const pointer = path.join(bin, 'current');
  const body = `${installed}\n/usr/bin/node\n${path.dirname(installed)}\n`;
  fs.writeFileSync(pointer, body, { mode: 0o600 });
  const env = h.childEnv({ HOME: user, SUB_HUMAN_HOME: undefined, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  return { user, installed, pointer, body, env };
}

test('guard: a dev-checkout CLI run and a seat taken on the real home leave the installed plugin\'s pointer alone', t => {
  const u = fakeUser(t);
  const before = fs.statSync(u.pointer).mtimeMs;
  for (const args of [['who'], ['tasks', '--json']]) spawnSync(process.execPath, [h.BIN, ...args], { env: u.env, encoding: 'utf8', timeout: 20_000 });
  // what a join or a restore runs (hooks/launcher.ts refresh)
  const url = pathToFileURL(path.join(h.PLUGIN, 'hooks', 'launcher.ts')).href;
  spawnSync(process.execPath, ['--input-type=module', '-e', `(await import(${JSON.stringify(url)})).refresh()`], { env: u.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(fs.readFileSync(u.pointer, 'utf8'), u.body, 'still the installed plugin');
  assert.equal(fs.statSync(u.pointer).mtimeMs, before, 'not even rewritten');
  assert.equal(fs.existsSync(path.join(u.user, '.sub-human', 'bin', 'serve')), false, 'no shim written either');

  // the recorded install is gone (a deleted worktree, an uninstall): then any run repairs the pointer
  fs.rmSync(u.installed, { recursive: true });
  spawnSync(process.execPath, [h.BIN, 'who'], { env: u.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(fs.readFileSync(u.pointer, 'utf8').split('\n')[0], shim.pluginRoot(), 'a gone root is replaced');
});

test('shim: passive() writes only from the plugin cache, for a missing or gone pointer, or the recorded root itself; force always', t => {
  h.freshHome(t);
  const dev = path.join(h.tmpDir('sh-dev-', t), 'plugin');
  fs.mkdirSync(path.join(dev, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'scripts', 'sub-human'), '');
  const cache = path.join(h.tmpDir('sh-c-', t), 'plugins', 'cache', 'm', 'sub-human', '1.0.0');
  fs.mkdirSync(path.join(cache, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'scripts', 'sub-human'), '');
  const ALLOW = { SUB_HUMAN_ALLOW_TMP_ROOT: '1' };
  const root = () => fs.readFileSync(shim.pointerPath(), 'utf8').split('\n')[0];
  assert.equal(shim.passive(dev), true, 'nothing recorded yet');
  shim.refresh({ root: cache, env: ALLOW });
  assert.equal(root(), cache);
  assert.equal(shim.passive(dev), false);
  assert.equal(shim.refresh({ root: dev, env: ALLOW }), shim.shimPath(), 'a passive dev run: the shim path, nothing written');
  assert.equal(root(), cache);
  assert.equal(shim.passive(cache), true, 'the recorded root itself (a node upgrade)');
  shim.refresh({ root: dev, env: ALLOW, force: true });
  assert.equal(root(), dev, 'forced: host --ssh, admit, authorize, doctor --fix');
  assert.equal(shim.passive(cache), true, 'an installed plugin always may');
  fs.rmSync(dev, { recursive: true });
  assert.equal(shim.passive(path.join(os.tmpdir(), 'elsewhere')), true, 'the recorded root is gone');
});
