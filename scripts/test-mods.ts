#!/usr/bin/env node
/**
 * test-mods: the hooks module's wiring tests (plugin/sub-human/mod/test/*.test.ts) under `claude plugin test`.
 * npm run test:mods; npm test runs it last.
 *
 * Skips (exit 0, one line on stdout) when no `claude` binary is found, when it is older than 2.1.292 (no function
 * hooks), or when it says hooks modules are turned off here (cc CONTRACT plugin-test-off). Otherwise exits as
 * `claude plugin test` does. That command collects every *.test.ts(x) under the plugin (cc CONTRACT
 * plugin-test-discovery), so the node tests in plugin/sub-human/test are named *.node-test.ts and only mod/test runs
 * here; and the wiring tests live under mod/test/, never where `npm run test:plugin`'s *.node-test.ts glob looks.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN } from './lib/paths.ts';

const MIN = [2, 1, 292];
const skip = (why: string | undefined): number => { process.stdout.write(`test:mods skipped: ${why}\n`); return 0; };

function main(): number {
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (v.error || v.status !== 0) return skip('no claude binary on PATH');
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout || '');
  if (!m) return skip(`unreadable version: ${String(v.stdout).trim()}`);
  const have = m.slice(1, 4).map(Number);
  const older = have.findIndex((x, i) => x !== MIN[i]);
  if (older >= 0 && have[older] < MIN[older]) return skip(`claude ${have.join('.')} has no function hooks (needs ${MIN.join('.')}+)`);
  const r = spawnSync('claude', ['plugin', 'test', path.relative(process.cwd(), PLUGIN) || PLUGIN], { encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/hooks modules are turned off/.test(out)) return skip(out.trim().split('\n').find(l => /turned off/.test(l)));
  process.stdout.write(out);
  if (r.error) { process.stderr.write(`test:mods: ${r.error.message}\n`); return 1; }
  return r.status === 0 ? 0 : 1;
}

process.exitCode = main();
