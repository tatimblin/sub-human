// lib/env.ts: one table of every SUB_HUMAN_* knob; nothing else reads process.env.SUB_HUMAN_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import { must } from './support/must.ts';
import * as env from '../lib/env.ts';

/** The runtime's files (what the plugin runs: lib, hooks, mcp, statusline, mod and the CLI shim), not its tests. */
function runtimeFiles(): string[] {
  const root = path.join(h.LIB, '..');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (!['test', 'node_modules', 'vendor'].includes(f.name) && !f.name.startsWith('.')) walk(p); continue; }
      if (/\.(js|ts)$/.test(f.name) || f.name === 'sub-human') out.push(p);
    }
  };
  for (const d of ['lib', 'hooks', 'mcp', 'statusline', 'mod', 'scripts']) walk(path.join(root, d));
  return out;
}

test('env: no runtime file reads process.env.SUB_HUMAN_* but lib/env.ts (and the two that load no lib module)', () => {
  // hooks/run.ts reads SUB_HUMAN_VIA before any handler loads; lib/cache-dir.js is the compile cache's plain-JS preload
  const allowed = new Set(['lib/env.ts', 'hooks/run.ts', 'lib/cache-dir.js']);
  const root = path.join(h.LIB, '..');
  const bad: string[] = [];
  for (const f of runtimeFiles()) {
    const rel = path.relative(root, f);
    if (allowed.has(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:process\.env|env)(?:\.|\[\s*['"])(SUB_HUMAN_[A-Z0-9_]+)/g)) bad.push(`${rel}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('env: every knob a runtime file names in a reader is in the table; the timing pattern is the ms knobs', () => {
  const names = new Set<string>();
  for (const f of runtimeFiles()) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(?:envMs|testMs|envNum|envFlag|envStr)\(\s*['"](SUB_HUMAN_[A-Z0-9_]+)['"]/g)) names.add(must(m[1], 'a knob'));
  }
  assert.ok(names.size >= 40, `found ${names.size}`);
  for (const n of names) assert.ok(Object.hasOwn(env.ENV, n), n);
  for (const [n, k] of Object.entries(env.ENV)) {
    if (k.kind === 'ms') assert.match(n, env.TIMING_ENV_RE, n);
    assert.match(n, /^SUB_HUMAN_[A-Z0-9_]+$/);
  }
  assert.doesNotMatch('SUB_HUMAN_HOME', env.TIMING_ENV_RE);
  assert.doesNotMatch('SUB_HUMAN_SOMETHING_ELSE_MS', env.TIMING_ENV_RE, 'only a knob of the table');
  assert.deepEqual(env.timingEnv({ SUB_HUMAN_POLL_MS: '5', SUB_HUMAN_LEAVE_MS: 'x', SUB_HUMAN_HOME: '/h', SUB_HUMAN_LINK_IDLE_MS: ' ' }), { SUB_HUMAN_POLL_MS: '5' });
});

test('env: readers read the variable when called, from the env given', () => {
  assert.equal(env.envStr('SUB_HUMAN_SSH_OPTS', { SUB_HUMAN_SSH_OPTS: '-v' }), '-v');
  assert.equal(env.envStr('SUB_HUMAN_PLUGIN_DIR', { SUB_HUMAN_PLUGIN_DIR: '' }), '', 'set empty is not unset');
  assert.equal(env.envStr('SUB_HUMAN_PLUGIN_DIR', {}), undefined);
  assert.equal(env.envFlag('SUB_HUMAN_ALLOW_TMP_ROOT', { SUB_HUMAN_ALLOW_TMP_ROOT: '1' }), true);
  assert.equal(env.envFlag('SUB_HUMAN_ALLOW_TMP_ROOT', { SUB_HUMAN_ALLOW_TMP_ROOT: 'true' }), false);
  assert.ok(Number.isNaN(env.envNum('SUB_HUMAN_LISTEN_PORT', {})));
  assert.equal(env.envNum('SUB_HUMAN_LISTEN_PORT', { SUB_HUMAN_LISTEN_PORT: '8443' }), 8443);
  const was = process.env.SUB_HUMAN_SEGMENT_BYTES;
  try {
    process.env.SUB_HUMAN_SEGMENT_BYTES = '100';
    assert.equal(env.segmentMaxBytes(), 1024 * 1024, 'under 256: the default');
    process.env.SUB_HUMAN_SEGMENT_BYTES = '512';
    assert.equal(env.segmentMaxBytes(), 512);
  } finally { if (was === undefined) delete process.env.SUB_HUMAN_SEGMENT_BYTES; else process.env.SUB_HUMAN_SEGMENT_BYTES = was; }
});
