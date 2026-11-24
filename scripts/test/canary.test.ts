// scripts/canary.ts: its pure parts (arguments, the typings diff, the verdict and its summary), and the binary in an npm
// install (scripts/lib/claude-bin.ts), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs, typingsDiff, verdict, summary } from '../canary.ts';
import { platformKey, binaryFor } from '../lib/claude-bin.ts';
import type { Steps } from '../canary.ts';
import { report } from '../probe-cc.ts';
import { parseContract } from '../../plugin/sub-human/core/cc/contract.js';

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

test('typingsDiff: the lines only one side has, the version line aside', () => {
  const before = { 'claude-code': '// Written by Claude Code 2.1.330.\na\nb\n', 'claude-code-mcp': null };
  const after = { 'claude-code': '// Written by Claude Code 2.1.400.\na\nc\nd\n', 'claude-code-mcp': 'x\n' };
  assert.deepEqual(typingsDiff(before, after), [
    { root: 'claude-code', same: false, added: 2, removed: 1 },
    { root: 'claude-code-mcp', same: false, added: 1, removed: 0 },
  ]);
  assert.deepEqual(typingsDiff({ r: '// Written by Claude Code 1.0.0.\na\n' }, { r: '// Written by Claude Code 2.0.0.\na\n' }),
    [{ root: 'r', same: true, added: 0, removed: 0 }]);
});

const contract = (() => {
  const r = parseContract({ note: 'n', probed: '2.1.330', entries: [
    { id: 'w', kind: 'api', feature: 'wake', surface: 's', checked: [], note: 'n', typings: ['submit('] },
    { id: 'g', kind: 'internal', feature: 'tasks-bridge', surface: 's', checked: [], note: 'n', search: ['ENABLE_TASKS'], reason: 'r', fallback: 'f', request: 'q' },
  ] });
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value;
})();
const ok = { ok: true, status: 0, tail: '' };
const steps = (over: Partial<Steps> = {}): Steps => ({
  install: { ...ok, tail: '/x/claude' },
  typings: { ok: true, roots: [{ root: 'claude-code', same: false, added: 3, removed: 1 }] },
  probe: report(contract, '/x/claude', { typings: 'submit(', binary: 'VERSION:"2.1.400" ENABLE_TASKS' }, null),
  module: { ...ok, tail: '1 pass' }, validate: ok, ...over,
});

test('verdict: every step must have run and passed; a typings diff alone is no failure', () => {
  assert.equal(verdict(steps()), true);
  assert.equal(verdict(steps({ validate: { ...ok, ok: false } })), false);
  assert.equal(verdict(steps({ module: { ok: false, status: 1, tail: 'claude plugin test: hooks modules are turned off here' } })), false, 'modules off fails');
  assert.equal(verdict(steps({ typings: { ok: false, error: 'no bundled declarations in the binary', roots: [] } })), false);
  assert.equal(verdict(steps({ probe: report(contract, '/x/claude', { typings: 'submit(', binary: 'VERSION:"2.1.400"' }, null) })), false);
  assert.equal(verdict({ install: { ok: false, status: 1, tail: 'E404' }, typings: null, probe: null, module: null, validate: null }), false);
});

test('summary: a line a step, and a failed feature names the SUB_HUMAN_CC_OFF value that turns it off', () => {
  const pass = summary('latest', steps());
  assert.equal(pass[0], 'canary latest = claude 2.1.400: PASS');
  assert.ok(pass.some(l => /PASS {2}typings {3}changed: claude-code \+3 -1/.test(l)));
  const fail = summary('next', steps({ probe: report(contract, '/x/claude', { typings: 'submit(', binary: 'VERSION:"2.1.401"' }, null) }));
  assert.equal(fail[0], 'canary next = claude 2.1.401: FAIL');
  assert.ok(fail.some(l => /FAIL {2}probe {5}1\/2 pass, 0 skipped/.test(l)));
  assert.deepEqual(fail.filter(l => /SUB_HUMAN_CC_OFF/.test(l)).map(l => l.trim()), ['tasks-bridge: g failed; off with SUB_HUMAN_CC_OFF=tasks-bridge']);
});
