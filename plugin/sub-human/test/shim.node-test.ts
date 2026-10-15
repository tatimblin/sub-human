// The stable SSH serve shim (lib/remote/shim.ts): refresh() writes <home>/bin/serve and its pointer only on a change
// and refuses a temp root; the shim runs `sub-human serve ARGS` from the recorded root, else the newest version in
// the plugin cache, with the recorded node, else node on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as shim from '../lib/remote/shim.ts';

const ALLOW = { SUB_HUMAN_ALLOW_TMP_ROOT: '1' };

/** A fake plugin version dir whose CLI prints "<tag> <args>". */
function fakeVersion(dir: string, tag: string, sub = 'scripts') {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, sub, 'sub-human'), `console.log(${JSON.stringify(tag)}, process.argv.slice(2).join(' '))\n`);
  return dir;
}
const runShim = (env = {}) => spawnSync('/bin/sh', [shim.shimPath(), '--stdio', 'vole-1234', '--link', 'abcdef012345'],
  { encoding: 'utf8', env: h.childEnv(env) });

test('refresh: the shim (0700) and pointer (0600) in <home>/bin, rewritten only on a change; a temp root is refused', t => {
  h.freshHome(t);
  const root = shim.pluginRoot();
  assert.equal(shim.refresh({ root }), shim.shimPath());
  assert.equal(fs.statSync(shim.shimPath()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(shim.pointerPath()).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(shim.pointerPath(), 'utf8'), `${root}\n${process.execPath}\n\n`);
  const before = fs.statSync(shim.pointerPath()).mtimeMs;
  shim.refresh({ root });
  assert.equal(fs.statSync(shim.pointerPath()).mtimeMs, before, 'unchanged: not rewritten');
  const tmpRoot = h.tmpDir('sh-root-', t);
  assert.equal(shim.refresh({ root: tmpRoot, env: {} }), null);
  assert.ok(fs.readFileSync(shim.pointerPath(), 'utf8').startsWith(root + '\n'), 'a refused root changes nothing');
  assert.equal(shim.refresh({ root: tmpRoot, env: ALLOW }), shim.shimPath());
});

test('cacheDirOf: the versions dir of a plugin cache root, else empty', () => {
  assert.equal(shim.cacheDirOf('/u/.claude/plugins/cache/mkt/sub-human/0.3.0'), '/u/.claude/plugins/cache/mkt/sub-human');
  assert.equal(shim.cacheDirOf('/u/src/sub-human/plugin/sub-human'), '');
});

test('the shim runs serve from the recorded root, else the newest cached version; a gone node falls back to PATH', t => {
  h.freshHome(t);
  const cache = path.join(h.tmpDir('sh-cache-', t), 'plugins', 'cache', 'mkt', 'sub-human');
  const v2 = fakeVersion(path.join(cache, '0.2.0'), 'v0.2.0', 'bin');
  shim.refresh({ root: v2, env: ALLOW });
  let r = runShim();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'v0.2.0 serve --stdio vole-1234 --link abcdef012345\n', 'the recorded root, its bin/ CLI');
  // a plugin update: 0.2.0 removed, 0.10.0 and 0.9.1 installed; a node upgrade removed the recorded node
  fakeVersion(path.join(cache, '0.9.1'), 'v0.9.1');
  fakeVersion(path.join(cache, '0.10.0'), 'v0.10.0');
  fs.rmSync(v2, { recursive: true });
  fs.writeFileSync(shim.pointerPath(), `${v2}\n/nonexistent/v20.0.0/bin/node\n${cache}\n`);
  r = runShim({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'v0.10.0 serve --stdio vole-1234 --link abcdef012345\n', 'the newest version, node from PATH');
  // nothing left to run: 127 and a line on stderr
  fs.rmSync(cache, { recursive: true });
  r = runShim();
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no plugin install/);
});

test('the shim over the real plugin reaches `sub-human serve`', t => {
  h.freshHome(t);
  shim.refresh();
  const r = runShim();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no room "vole-1234"/);
});


test('passive: a dev root newer than the recorded one takes the pointer; an older or equal one leaves it (live: bin/current stayed on an older --plugin-dir)', t => {
  assert.equal(shim.newer('0.5.0-beta.16', '0.5.0-beta.15'), true);
  assert.equal(shim.newer('0.5.0-beta.15', '0.5.0-beta.16'), false);
  assert.equal(shim.newer('0.5.0', '0.5.0-beta.16'), true, 'a release over its prereleases');
  assert.equal(shim.newer('0.5.0-beta.16', '0.5.0'), false);
  assert.equal(shim.newer('0.6.0-beta.1', '0.5.9'), true);
  assert.equal(shim.newer('0.5.0-beta.15', '0.5.0-beta.15'), false);
  assert.equal(shim.newer(null, '0.5.0'), false);
  h.freshHome(t);
  const mk = (v: string) => {
    const r = h.tmpDir('sh-root-', t);
    fs.mkdirSync(path.join(r, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sub-human', version: v }));
    fs.mkdirSync(path.join(r, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(r, 'scripts', 'sub-human'), '#!/bin/sh\n', { mode: 0o755 });
    return r;
  };
  const old = mk('0.5.0-beta.15'), cur = mk('0.5.0-beta.16');
  const env = { ...process.env, SUB_HUMAN_ALLOW_TMP_ROOT: '1' };
  shim.refresh({ root: old, env, force: true });
  assert.equal(shim.passive(cur), true, 'newer: it may write');
  shim.refresh({ root: cur, env });
  assert.equal(fs.readFileSync(shim.pointerPath(), 'utf8').split('\n')[0], path.resolve(cur));
  assert.equal(shim.passive(old), false, 'the older one leaves it');
});
