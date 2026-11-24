/**
 * claude-bin: the Claude Code binary the repo's checks run (probe, test:module, validate, typings), pinned to
 * plugin/sub-human/core/cc/contract.json `probed` so they never depend on the global install. It is installed with
 * `npm i --prefix <tmp>/sub-human-claude/<version>` (never global), then the native binary of the platform's optional
 * package; the canary installs its tags with the same steps. Cached: a second call finds it.
 *
 *   SUB_HUMAN_CLAUDE_BIN=/path/to/claude   use that binary instead (a local build or another version)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN } from './paths.ts';

export const PKG = '@anthropic-ai/claude-code';
/** The stub bin/claude.exe is before the postinstall replaces it (install.cjs reads one this small as the stub). */
const STUB_MAX = 4096;

/**
 * The version the contract was probed on, the one v2 targets. Read as plain JSON, not through the plugin's schema,
 * so the scripts that need only the binary load no plugin code.
 */
export function probedVersion(file: string = path.join(PLUGIN, 'core', 'cc', 'contract.json')): string {
  const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = json && typeof json === 'object' && 'probed' in json ? json.probed : undefined;
  if (typeof v !== 'string') throw new Error(`${file}: no "probed" version`);
  return v;
}

/** Where a version is installed; its config/ is the fresh CLAUDE_CONFIG_DIR the checks run with. */
export const prefixFor = (version: string): string => path.join(os.tmpdir(), 'sub-human-claude', version);

/** The platform key of the native package, as the npm package's install.cjs picks it. */
export function platformKey(platform: string, arch: string, musl: boolean): string {
  if (platform === 'linux') return `linux-${arch}${musl ? '-musl' : ''}`;
  return `${platform}-${arch}`;
}

// a glibc build reports its runtime version
const isMusl = (): boolean => {
  if (process.platform !== 'linux') return false;
  const report: unknown = process.report.getReport();
  const header = report && typeof report === 'object' && 'header' in report ? report.header : null;
  return !(header && typeof header === 'object' && 'glibcVersionRuntime' in header);
};

/**
 * The native Claude Code binary in an npm install at prefix: the platform package's own file, else the wrapper's
 * bin/claude.exe once the postinstall has put the binary there (bigger than the stub). null when neither is.
 */
export function binaryFor(prefix: string, key: string, exists: (f: string) => boolean, size: (f: string) => number): string | null {
  const exe = key.startsWith('win32') ? 'claude.exe' : 'claude';
  const native = path.join(prefix, 'node_modules', `${PKG}-${key}`, exe);
  if (exists(native)) return native;
  const wrapped = path.join(prefix, 'node_modules', PKG, 'bin', 'claude.exe');
  return exists(wrapped) && size(wrapped) > STUB_MAX ? wrapped : null;
}

/** This machine's native binary in the install at prefix, or null. */
export const nativeIn = (prefix: string): string | null =>
  binaryFor(prefix, platformKey(process.platform, process.arch, isMusl()), fs.existsSync, f => fs.statSync(f).size);

/** `npm i --prefix prefix @anthropic-ai/claude-code@spec`: the binary, or why there is none. */
export function install(prefix: string, spec: string): { bin: string } | { error: string } {
  fs.mkdirSync(prefix, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['i', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', `${PKG}@${spec}`], { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) return { error: `npm i ${PKG}@${spec} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}` };
  const bin = nativeIn(prefix);
  return bin ? { bin } : { error: `${PKG}@${spec} installed, but no native binary for ${process.platform}-${process.arch}` };
}

/** The pinned binary, installing it on first use, or an error saying why there is none. */
export function claudeBin(version: string = probedVersion()): { bin: string, prefix: string } | { error: string } {
  const prefix = prefixFor(version);
  const own = process.env.SUB_HUMAN_CLAUDE_BIN;
  if (own) return fs.existsSync(own) ? { bin: own, prefix } : { error: `SUB_HUMAN_CLAUDE_BIN: no such file ${own}` };
  const cached = nativeIn(prefix);
  if (cached) return { bin: cached, prefix };
  const r = install(prefix, version);
  return 'error' in r ? r : { bin: r.bin, prefix };
}

/**
 * The env a pinned run gets: a fresh config dir under the prefix, so nothing lands in ~/.claude or ~/.claude.json. A
 * caller that names its own binary (SUB_HUMAN_CLAUDE_BIN) and config dir, as the canary does, keeps that config dir.
 */
export function claudeEnv(prefix: string): NodeJS.ProcessEnv {
  if (process.env.SUB_HUMAN_CLAUDE_BIN && process.env.CLAUDE_CONFIG_DIR) return { ...process.env };
  const config = path.join(prefix, 'config');
  fs.mkdirSync(config, { recursive: true });
  return { ...process.env, CLAUDE_CONFIG_DIR: config };
}
