#!/usr/bin/env node
/**
 * test-mods: the hooks module's kit tests (every *.test.ts under plugin/sub-human) under `claude plugin test`.
 * npm run test:module; npm test runs it last.
 *
 * `claude plugin test` collects every *.test.ts(x) under the plugin, so node tests are named *.node-test.ts. With no
 * kit test yet it reports nothing to run and exits 0. A missing or too old `claude`, or hooks modules turned off, is a
 * failure, never a skip (docs/TESTING.md §4). Otherwise it exits as `claude plugin test` does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN } from './lib/paths.ts';

const MIN = [2, 1, 292];
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.claude-plugin']);
const fail = (why: string): number => { process.stderr.write(`test:module: ${why}\n`); return 1; };

/** The kit tests under dir: *.test.ts or *.test.tsx, outside vendor/ and node_modules/. */
export function kitTests(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...kitTests(f)); } else if (/\.test\.tsx?$/.test(e.name)) out.push(f);
  }
  return out;
}

function main(): number {
  if (kitTests(PLUGIN).length === 0) { process.stdout.write('test:module: nothing to run (no *.test.ts under plugin/sub-human)\n'); return 0; }
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (v.error || v.status !== 0) return fail('no claude binary on PATH');
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout || '');
  if (!m) return fail(`unreadable version: ${String(v.stdout).trim()}`);
  const have = m.slice(1, 4).map(Number);
  const older = have.findIndex((x, i) => x !== MIN[i]);
  const at = have[older], min = MIN[older]; // both undefined when older is -1
  if (at !== undefined && min !== undefined && at < min) return fail(`claude ${have.join('.')} has no hooks modules (needs ${MIN.join('.')}+)`);
  const r = spawnSync('claude', ['plugin', 'test', path.relative(process.cwd(), PLUGIN) || PLUGIN], { encoding: 'utf8', timeout: 300_000 });
  process.stdout.write(`${r.stdout || ''}${r.stderr || ''}`);
  if (r.error) return fail(r.error.message);
  return r.status === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
