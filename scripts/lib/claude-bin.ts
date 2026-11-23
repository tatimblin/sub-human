/**
 * claude-bin: the Claude Code binary the repo's checks run (test:module, typings), pinned so they never depend on the
 * global install. It is installed as the canary does: `npm i --prefix <tmp>/sub-human-claude/<version>` of
 * @anthropic-ai/claude-code, then the native binary of the platform's optional package. Cached: a second call finds it.
 *
 *   SUB_HUMAN_CLAUDE_BIN=/path/to/claude   use that binary instead (a local build or another version)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { binaryFor, platformKey } from '../canary.ts';

/** The Claude Code version v2 targets (docs/ARCHITECTURE.md §9). */
export const CLAUDE_VERSION = '2.1.330';
const PKG = '@anthropic-ai/claude-code';

/** Where a version is installed; its config/ is the fresh CLAUDE_CONFIG_DIR the checks run with. */
export const prefixFor = (version: string): string => path.join(os.tmpdir(), 'sub-human-claude', version);

// as the canary's: a glibc build reports its runtime version
const isMusl = (): boolean => {
  if (process.platform !== 'linux') return false;
  const report: unknown = process.report.getReport();
  const header = report && typeof report === 'object' && 'header' in report ? report.header : null;
  return !(header && typeof header === 'object' && 'glibcVersionRuntime' in header);
};

const nativeIn = (prefix: string): string | null =>
  binaryFor(prefix, platformKey(process.platform, process.arch, isMusl()), fs.existsSync, f => fs.statSync(f).size);

/** The pinned binary, installing it on first use, or an error saying why there is none. */
export function claudeBin(version = CLAUDE_VERSION): { bin: string, prefix: string } | { error: string } {
  const prefix = prefixFor(version);
  const own = process.env.SUB_HUMAN_CLAUDE_BIN;
  if (own) return fs.existsSync(own) ? { bin: own, prefix } : { error: `SUB_HUMAN_CLAUDE_BIN: no such file ${own}` };
  const cached = nativeIn(prefix);
  if (cached) return { bin: cached, prefix };
  fs.mkdirSync(prefix, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['i', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', `${PKG}@${version}`], { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) return { error: `npm i ${PKG}@${version} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}` };
  const bin = nativeIn(prefix);
  return bin ? { bin, prefix } : { error: `${PKG}@${version} installed, but no native binary for ${process.platform}-${process.arch}` };
}

/** The env a pinned run gets: a fresh config dir under the prefix, so nothing lands in ~/.claude or ~/.claude.json. */
export function claudeEnv(prefix: string): NodeJS.ProcessEnv {
  const config = path.join(prefix, 'config');
  fs.mkdirSync(config, { recursive: true });
  return { ...process.env, CLAUDE_CONFIG_DIR: config };
}
