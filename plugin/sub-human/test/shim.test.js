'use strict';
// The stable SSH serve shim (lib/remote/shim.ts): refresh() writes <home>/bin/serve and its pointer only on a change
// and refuses a temp root; the shim runs `sub-human serve ARGS` from the recorded root, else the newest version in
// the plugin cache, with the recorded node, else node on PATH; migrateLines() rewrites what an older `authorize`
// wrote for this home; `authorize --file` does that rewrite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const shim = require(path.join(h.LIB, 'remote', 'shim.ts'));

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv2YxFcmD0qVf1aW0gk1oQfWb3m9e1bJ1l3xq3fQnHk';
const ALLOW = { SUB_HUMAN_ALLOW_TMP_ROOT: '1' };

/** A fake plugin version dir whose CLI prints "<tag> <args>". */
function fakeVersion(dir, tag, sub = 'scripts') {
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

test('migrateLines rewrites this home\'s old forced commands to the shim; other lines are kept', () => {
  const home = '/h/.sub-human';
  const old = `command="SUB_HUMAN_HOME=${home} /u/.nvm/versions/node/v24.15.0/bin/node /u/.claude/plugins/cache/m/sub-human/0.2.0/bin/sub-human serve --stdio vole-1234 --link abcdef012345",restrict ${KEY} sub-human:vole-1234:abcdef012345`;
  const other = old.replace(`=${home} `, '=/elsewhere ');
  const text = ['# mine', 'ssh-ed25519 AAAAx me@laptop', old, other, ''].join('\n');
  const { text: out, migrated } = shim.migrateLines(text, home);
  assert.equal(migrated, 1);
  assert.deepEqual(out.split('\n'), ['# mine', 'ssh-ed25519 AAAAx me@laptop', shim.authorizedLine('vole-1234', 'abcdef012345', KEY, home), other, '']);
  assert.equal(shim.migrateLines(out, home).migrated, 0, 'idempotent');
});

test('cli: doctor --fix rewrites an older line for this home to run the shim; other lines stay', t => {
  h.freshHome(t);
  const code = h.newRoom();
  h.register('alice', 'member');
  const run = args => spawnSync(process.execPath, [h.BIN, ...args], { env: h.childEnv(), encoding: 'utf8' });
  const id = 'a1b2c3d4e5f6';
  const home = path.resolve(process.env.SUB_HUMAN_HOME);
  const ak = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  const old = `command="SUB_HUMAN_HOME=${home} ${process.execPath} ${h.BIN} serve --stdio ${code} --link ${id}",restrict ${KEY} sub-human:${code}:${id}`;
  fs.writeFileSync(ak, `ssh-rsa AAAAB3 me\n${old}\n`, { mode: 0o600 });
  const r = run(['doctor', '--fix', '--quick', '--authorized-keys', ak]);
  assert.match(r.stdout, /fixed: rewrote 1 older sub-human line/, r.stderr);
  assert.equal(fs.readFileSync(ak, 'utf8'), `ssh-rsa AAAAB3 me\n${shim.authorizedLine(code, id, KEY, home)}\n`);
  assert.equal(fs.statSync(ak).mode & 0o777, 0o600);
});
