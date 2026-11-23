#!/usr/bin/env node
/**
 * validate: npm run validate (npm test runs it after the kit tests). `claude plugin validate plugin/sub-human --strict`
 * with the pinned Claude Code (scripts/lib/claude-bin.ts) and a fresh config dir, never the global one. It
 * type-checks the hooks module, vendored imports included.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN } from './lib/paths.ts';
import { claudeBin, claudeEnv } from './lib/claude-bin.ts';

function main(): number {
  const found = claudeBin();
  if ('error' in found) { process.stderr.write(`validate: ${found.error}\n`); return 1; }
  const r = spawnSync(found.bin, ['plugin', 'validate', path.relative(process.cwd(), PLUGIN) || PLUGIN, '--strict'], { encoding: 'utf8', timeout: 120_000, env: claudeEnv(found.prefix) });
  if (r.status === 0) return 0;
  process.stdout.write(`${r.stdout || ''}${r.stderr || ''}`);
  if (r.error) process.stderr.write(`validate: ${r.error.message}\n`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
