// scripts/canary.ts: its pure parts (arguments, the binary in an npm install, the probe's summary, the verdict), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs, platformKey, binaryFor, summarizeProbe, judgeMods, verdict } from '../canary.ts';
import type { ProbeJson } from '../canary.ts';

test('parseArgs: latest by default, a tag or a version, --config-dir; anything else is an error', () => {
  assert.deepEqual(parseArgs([]), { tag: 'latest' });
  assert.deepEqual(parseArgs(['next']), { tag: 'next' });
  assert.deepEqual(parseArgs(['2.1.302']), { tag: '2.1.302' });
  assert.deepEqual(parseArgs(['2.2.0-beta.1']), { tag: '2.2.0-beta.1' });
  assert.deepEqual(parseArgs(['latest', '--config-dir', '/tmp/cfg']), { tag: 'latest', configDir: path.resolve('/tmp/cfg') });
  assert.ok('error' in parseArgs(['--config-dir']));
  assert.ok('error' in parseArgs(['latest', 'next']));
  assert.ok('error' in parseArgs(['--global']));
  assert.ok('error' in parseArgs(['2.1']));
  assert.ok('error' in parseArgs(['latest; rm -rf /']));
});

test('platformKey: as the package install.cjs names its optional dependencies', () => {
  assert.equal(platformKey('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(platformKey('linux', 'x64', false), 'linux-x64');
  assert.equal(platformKey('linux', 'arm64', true), 'linux-arm64-musl');
  assert.equal(platformKey('win32', 'x64', false), 'win32-x64');
});

test('binaryFor: the platform package binary, else bin/claude.exe once it is no longer the stub', () => {
  const p = '/x';
  const native = path.join(p, 'node_modules', '@anthropic-ai/claude-code-linux-x64', 'claude');
  const wrapped = path.join(p, 'node_modules', '@anthropic-ai/claude-code', 'bin', 'claude.exe');
  const files = (m: Record<string, number>) => [(f: string) => f in m, (f: string) => m[f] ?? 0] as const;
  assert.equal(binaryFor(p, 'linux-x64', ...files({ [native]: 2e8, [wrapped]: 2e8 })), native);
  assert.equal(binaryFor(p, 'linux-x64', ...files({ [wrapped]: 2e8 })), wrapped);
  assert.equal(binaryFor(p, 'linux-x64', ...files({ [wrapped]: 500 })), null, 'the stub is not a binary');
  assert.equal(binaryFor(p, 'linux-x64', ...files({})), null);
  assert.equal(binaryFor(p, 'win32-x64', ...files({ [path.join(p, 'node_modules', '@anthropic-ai/claude-code-win32-x64', 'claude.exe')]: 2e8 })),
    path.join(p, 'node_modules', '@anthropic-ai/claude-code-win32-x64', 'claude.exe'));
});

test('summarizeProbe: failures grouped by feature, else by section, else other', () => {
  const entries = [{ id: 'a', section: 1, feature: 'core' }, { id: 'b', section: 1 }, { id: 'c', section: 2, feature: 'core' }, { id: 'd' }];
  const p: ProbeJson = {
    ok: false, version: '2.1.400',
    results: [{ id: 'a', ok: true, missing: [] }, { id: 'b', ok: false, missing: ['x'] }, { id: 'c', ok: false, missing: ['y'] }, { id: 'd', ok: true, missing: [] }],
    degraded: [{ id: 'a', issue: 8, note: 'n' }, { id: 'c', note: 'n' }],
  };
  const s = summarizeProbe(p, entries);
  assert.equal(s.ok, false);
  assert.equal(s.version, '2.1.400');
  assert.deepEqual([s.total, s.failed], [4, 2]);
  assert.deepEqual(s.groups, { core: { total: 2, failed: ['c'] }, '§1': { total: 1, failed: ['b'] }, other: { total: 1, failed: [] } });
  assert.deepEqual(s.degraded, ['a (#8)', 'c']);
  const pass = summarizeProbe({ ok: true, version: '2.1.400', results: [{ id: 'a', ok: true, missing: [] }] }, entries);
  assert.equal(pass.ok, true);
});

test('summarizeProbe: no binary, or no results, is a failure', () => {
  const s = summarizeProbe({ ok: false, error: 'probe-cc: no Claude Code binary found (set CLAUDE_BIN)' }, []);
  assert.equal(s.ok, false);
  assert.match(s.error ?? '', /no Claude Code binary/);
  assert.equal(summarizeProbe({ ok: true, results: [] }, []).ok, false, 'an empty probe proves nothing');
});

test('judgeMods: a run that passes passes; a skip (modules off, too old, no claude) or a failing run fails', () => {
  const ran = 'mod/test/x.test.ts:\n(pass) a\n\n 111 pass\n 0 fail\nRan 111 tests across 10 files. [9.58s]\n';
  assert.deepEqual(judgeMods(0, ran), { ok: true, skipped: null, pass: 111, fail: 0, status: 0 });
  const off = judgeMods(0, 'test:mods skipped: claude plugin test: hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)\n');
  assert.equal(off.ok, false);
  assert.match(off.skipped ?? '', /turned off/);
  assert.equal(judgeMods(0, 'test:mods skipped: claude 2.1.200 has no function hooks (needs 2.1.292+)\n').ok, false);
  assert.equal(judgeMods(1, ' 110 pass\n 1 fail\n').ok, false);
  assert.equal(judgeMods(null, '').ok, false, 'a timeout');
});

test('verdict: every step must pass', () => {
  const okCmd = { ok: true, status: 0, tail: '' };
  const probe = summarizeProbe({ ok: true, results: [{ id: 'a', ok: true, missing: [] }] }, []);
  const mods = judgeMods(0, ' 1 pass\n 0 fail\n');
  assert.equal(verdict({ install: okCmd, probe, mods, validate: okCmd }), true);
  assert.equal(verdict({ install: okCmd, probe, mods, validate: { ...okCmd, ok: false } }), false);
  assert.equal(verdict({ install: okCmd, probe, mods: judgeMods(0, 'test:mods skipped: off\n'), validate: okCmd }), false);
  assert.equal(verdict({ install: { ok: false, status: 1, tail: 'E404' }, probe: null, mods: null, validate: null }), false);
});
