#!/usr/bin/env node
/**
 * test-mods: the hooks module's kit tests (every *.test.ts under plugin/sub-human) under `claude plugin test`.
 * npm run test:module; npm test runs it last.
 *
 * It runs the pinned Claude Code (scripts/lib/claude-bin.ts: core/cc/contract.json `probed`, installed on first use,
 * or SUB_HUMAN_CLAUDE_BIN), never the global one, with a fresh CLAUDE_CONFIG_DIR under its prefix (a fresh config has
 * hooks modules on), or the caller's when it names its own binary (claude-bin.ts claudeEnv). `claude plugin test` collects every *.test.ts(x) under the plugin, so node tests are named
 * *.node-test.ts. No binary, or modules off, is a failure, never a skip (docs/TESTING.md §4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN } from './lib/paths.ts';
import { claudeBin, claudeEnv } from './lib/claude-bin.ts';

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
  const found = claudeBin();
  if ('error' in found) return fail(found.error);
  const r = spawnSync(found.bin, ['plugin', 'test', path.relative(process.cwd(), PLUGIN) || PLUGIN], { encoding: 'utf8', timeout: 300_000, env: claudeEnv(found.prefix) });
  process.stdout.write(`${r.stdout || ''}${r.stderr || ''}`);
  if (r.error) return fail(r.error.message);
  return r.status === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
