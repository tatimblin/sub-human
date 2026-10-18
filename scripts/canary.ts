#!/usr/bin/env node
/**
 * canary: an early warning. Install a newer Claude Code from npm and run the checks that would break on it, before
 * anyone updates.
 *
 *   npm run canary [-- latest|next|stable|X.Y.Z] [--config-dir DIR]
 *   node scripts/canary.ts [TAG] [--config-dir DIR]
 *
 * 1. Install. `npm i --prefix <tmp>/sub-human-canary/<TAG>` of @anthropic-ai/claude-code@TAG (never global, never
 *    ~/.claude). The npm package is a wrapper: bin/claude.exe is a stub that its postinstall replaces with a hard link
 *    to the native binary of the platform's optional dependency, @anthropic-ai/claude-code-<platform>/claude. The
 *    canary takes that native binary itself (binaryFor), else bin/claude.exe once it is no longer the stub, and links
 *    it as <prefix>/path/claude, the directory it puts first on PATH.
 * 2. The probe. `node scripts/probe-cc.ts --json --no-typings` with CLAUDE_BIN set (the typings snapshot is written by
 *    contract.json `probed`, never by the canary's version); failures grouped by each entry's `feature`, else by its
 *    `section` (summarizeProbe).
 * 3. The wiring tests. `npm run test:mods` (scripts/test-mods.ts) with the binary first on PATH. test-mods skips with
 *    exit 0 when modules are off or the binary is too old; the canary counts that skip as a failure (judgeMods).
 * 4. `claude plugin validate plugin/sub-human --strict` with the binary.
 *
 * Steps 3 and 4 write Claude Code's global config (.claude.json, backups/) into the config dir: the canary gives them a
 * fresh one, <prefix>/config, as CLAUDE_CONFIG_DIR, so nothing lands in ~/.claude or ~/.claude.json. A fresh config has
 * no cached GrowthBook features and the hooks modules switch defaults on (cc CONTRACT hooks-modules), so the wiring
 * tests run there. --config-dir DIR uses DIR instead (a copy of a config whose cached switch you want to test with):
 * the runs may write into it.
 *
 * Writes scripts/canary/last.json (gitignored) and prints a short summary; exits 1 when any step fails, 2 on bad
 * arguments.
 *
 *   parseArgs(argv) -> {tag, configDir?} | {error}
 *   platformKey(platform, arch, musl) -> 'darwin-arm64' | 'linux-x64-musl' | ...   as the package's install.cjs
 *   binaryFor(prefix, key, exists, size) -> path | null    the native binary in an install
 *   summarizeProbe(probeJson, entries) -> ProbeSummary      failures grouped by feature, else section
 *   judgeMods(status, output) -> ModsResult                 a skip is a failure
 *   verdict(steps) -> boolean
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, REPO } from './lib/paths.ts';
import { parseJson } from './lib/io.ts';

const PKG = '@anthropic-ai/claude-code';
export const LAST = path.join(REPO, 'scripts', 'canary', 'last.json');
/** The stub bin/claude.exe is before the postinstall replaces it (install.cjs reads one this small as the stub). */
const STUB_MAX = 4096;

/** The canary's arguments. */
export interface CanaryArgs { tag: string, configDir?: string }

export function parseArgs(argv: readonly string[]): CanaryArgs | { error: string } {
  let tag: string | undefined, configDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--config-dir') {
      const v = argv[++i];
      if (!v) return { error: '--config-dir needs a directory' };
      configDir = path.resolve(v);
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (tag !== undefined) return { error: `one tag only (have ${tag}, got ${a})` };
    else tag = a;
  }
  tag ??= 'latest';
  if (!/^(?:latest|next|stable|\d+\.\d+\.\d+(?:-[\w.]+)?)$/.test(tag)) return { error: `not a tag or version: ${tag} (latest, next, stable or X.Y.Z)` };
  return configDir === undefined ? { tag } : { tag, configDir };
}

/** The platform key of the native package, as the npm package's install.cjs picks it. */
export function platformKey(platform: string, arch: string, musl: boolean): string {
  if (platform === 'linux') return `linux-${arch}${musl ? '-musl' : ''}`;
  return `${platform}-${arch}`;
}

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

/** The parts of a contract entry the summary reads (`feature` when contract.json has it). */
export interface EntryGroup { id: string, section?: number, feature?: string }
/** One probe result, as probe-cc --json prints it. */
interface ProbeRow { id: string, ok: boolean, missing: string[] }
/** probe-cc --json's output. */
export interface ProbeJson { ok: boolean, error?: string, version?: string, results?: ProbeRow[], degraded?: { id: string, issue?: number, note: string }[] }
/** The probe step, summarized. */
export interface ProbeSummary {
  ok: boolean, error?: string, version: string | null, total: number, failed: number,
  /** Per group (feature, else `§section`, else `other`): its entries and the ids that failed. */
  groups: Record<string, { total: number, failed: string[] }>,
  degraded: string[],
}

const groupOf = (e: EntryGroup | undefined): string =>
  e?.feature ?? (e?.section !== undefined ? `§${e.section}` : 'other');

export function summarizeProbe(p: ProbeJson, entries: readonly EntryGroup[]): ProbeSummary {
  const byId = new Map(entries.map(e => [e.id, e]));
  const groups: ProbeSummary['groups'] = {};
  const results = p.results ?? [];
  for (const r of results) {
    const g = (groups[groupOf(byId.get(r.id))] ??= { total: 0, failed: [] });
    g.total++;
    if (!r.ok) g.failed.push(r.id);
  }
  const failed = results.filter(r => !r.ok).length;
  return {
    ok: !p.error && results.length > 0 && p.ok && failed === 0,
    ...(p.error !== undefined ? { error: p.error } : {}),
    version: p.version ?? null, total: results.length, failed, groups,
    degraded: (p.degraded ?? []).map(d => `${d.id}${d.issue !== undefined ? ` (#${d.issue})` : ''}`),
  };
}

/** The wiring tests' step. */
export interface ModsResult { ok: boolean, skipped: string | null, pass: number | null, fail: number | null, status: number | null }

/** test-mods' exit and output: it passes only when it ran and exited 0; its skip line (modules off, too old) fails. */
export function judgeMods(status: number | null, out: string): ModsResult {
  const skipped = /^test:mods skipped: (.*)$/m.exec(out)?.[1] ?? null;
  const n = (re: RegExp): number | null => { const m = re.exec(out); return m ? Number(m[1]) : null; };
  const pass = n(/^\s*(\d+) pass\b/m), fail = n(/^\s*(\d+) fail\b/m);
  return { ok: status === 0 && skipped === null, skipped, pass, fail, status };
}

/** A step that ran a command: its exit and the tail of its output. */
export interface CmdResult { ok: boolean, status: number | null, tail: string }

/** Every step passed. */
export const verdict = (s: { install: CmdResult, probe: ProbeSummary | null, mods: ModsResult | null, validate: CmdResult | null }): boolean =>
  s.install.ok && !!s.probe?.ok && !!s.mods?.ok && !!s.validate?.ok;

const tail = (s: string, n = 12): string => s.trim().split('\n').slice(-n).join('\n');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): { status: number | null, out: string } {
  const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}` };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) { process.stderr.write(`canary: ${args.error}\n`); return 2; }
  const prefix = path.join(os.tmpdir(), 'sub-human-canary', args.tag);
  fs.mkdirSync(prefix, { recursive: true });
  const configDir = args.configDir ?? path.join(prefix, 'config');
  if (!args.configDir) fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });

  process.stdout.write(`canary: installing ${PKG}@${args.tag} into ${prefix}\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const inst = run(npm, ['i', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', `${PKG}@${args.tag}`], process.env, 600_000);
  const bin = inst.status === 0 ? binaryFor(prefix, platformKey(process.platform, process.arch, isMusl()), fs.existsSync, f => fs.statSync(f).size) : null;
  const install: CmdResult = { ok: !!bin, status: inst.status, tail: bin ? bin : tail(inst.out) || 'installed, but no native binary for this platform' };

  let probe: ProbeSummary | null = null, mods: ModsResult | null = null, validate: CmdResult | null = null;
  if (bin) {
    const pathDir = path.join(prefix, 'path');
    fs.rmSync(pathDir, { recursive: true, force: true });
    fs.mkdirSync(pathDir);
    fs.symlinkSync(bin, path.join(pathDir, 'claude'));
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_BIN: bin, CLAUDE_CONFIG_DIR: configDir, PATH: `${pathDir}${path.delimiter}${process.env.PATH ?? ''}` };

    const p = run(process.execPath, [path.join(REPO, 'scripts', 'probe-cc.ts'), '--json', '--no-typings'], env, 300_000);
    let pj: ProbeJson;
    try { pj = parseJson<ProbeJson>(p.out.slice(p.out.indexOf('{'))); } catch { pj = { ok: false, error: `unreadable probe output: ${tail(p.out, 3)}` }; }
    const contract = parseJson<{ entries: EntryGroup[] }>(fs.readFileSync(path.join(PLUGIN, 'lib', 'cc', 'contract.json'), 'utf8'));
    probe = summarizeProbe(pj, contract.entries);

    const m = run(process.execPath, [path.join(REPO, 'scripts', 'test-mods.ts')], env, 600_000);
    mods = judgeMods(m.status, m.out);

    const v = run(bin, ['plugin', 'validate', PLUGIN, '--strict'], env, 120_000);
    validate = { ok: v.status === 0, status: v.status, tail: tail(v.out, 4) };
  }

  const ok = verdict({ install, probe, mods, validate });
  const summary = { ok, tag: args.tag, version: probe?.version ?? null, bin, configDir, at: new Date().toISOString(), install, probe, mods, validate };
  fs.mkdirSync(path.dirname(LAST), { recursive: true });
  fs.writeFileSync(LAST, JSON.stringify(summary, null, 1) + '\n');

  const mark = (x: boolean | undefined): string => (x ? 'PASS' : 'FAIL');
  const out: string[] = [`canary ${args.tag}${probe?.version ? ` = claude ${probe.version}` : ''}: ${ok ? 'PASS' : 'FAIL'}`];
  out.push(`  ${mark(install.ok)}  install   ${install.tail.split('\n').join('\n            ')}`);
  if (probe) {
    out.push(`  ${mark(probe.ok)}  probe     ${probe.error ?? `${probe.total - probe.failed}/${probe.total} entries`}`);
    for (const [g, r] of Object.entries(probe.groups)) if (r.failed.length) out.push(`            ${g}: ${r.failed.length}/${r.total} fail: ${r.failed.join(', ')}`);
    if (probe.degraded.length) out.push(`            reported changed on this version: ${probe.degraded.join(', ')}`);
  }
  if (mods) out.push(`  ${mark(mods.ok)}  test:mods ${mods.skipped !== null ? `skipped: ${mods.skipped}` : `${mods.pass ?? '?'} pass, ${mods.fail ?? '?'} fail (exit ${mods.status ?? 'none'})`}`);
  if (validate) out.push(`  ${mark(validate.ok)}  validate  ${validate.ok ? 'plugin validate --strict passed' : validate.tail.split('\n').join('\n            ')}`);
  out.push(`  ${path.relative(REPO, LAST)}`);
  process.stdout.write(out.join('\n') + '\n');
  return ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
