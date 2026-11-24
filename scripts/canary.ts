#!/usr/bin/env node
/**
 * canary: the early warning (docs/TESTING.md §7). Install a newer Claude Code from npm and run what would break on it,
 * before anyone updates. No model calls.
 *
 *   npm run canary [-- latest|next|stable|X.Y.Z] [--config-dir DIR]
 *
 * 1. install   `npm i --prefix <tmp>/sub-human-canary/<TAG>` of @anthropic-ai/claude-code@TAG (never global). The
 *              package's bin/claude.exe is a stub its postinstall replaces with the platform package's native binary;
 *              scripts/lib/claude-bin.ts install takes that binary itself, as it does for the pinned one.
 * 2. typings   the binary's declarations (scripts/typings.ts extractTypings) diffed against the snapshot typings/.
 *              A diff is reported, not failed: the probe below is what judges it.
 * 3. probe     core/cc/contract.json: api entries against the new typings, internal ones against the new binary
 *              (scripts/probe-cc.ts, without its snapshot version check).
 * 4. module    npm run test:module with this binary (SUB_HUMAN_CLAUDE_BIN); modules off fails it.
 * 5. validate  `claude plugin validate plugin/sub-human --strict`.
 *
 * Steps 4 and 5 write Claude Code's global config, never ~/.claude: both get a fresh CLAUDE_CONFIG_DIR,
 * <prefix>/config (a fresh config has hooks modules on), or --config-dir DIR (claude-bin.ts claudeEnv keeps it). Writes scripts/canary/last.json (gitignored), prints a step a
 * line and a line per failed feature with the SUB_HUMAN_CC_OFF value that turns it off; exits 1 on a failure, 2 on bad
 * arguments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, REPO } from './lib/paths.ts';
import { ROOTS, TARGET, extractTypings } from './typings.ts';
import { readContract, readTypings, report } from './probe-cc.ts';
import type { Report } from './probe-cc.ts';
import { PKG, install } from './lib/claude-bin.ts';
import { binaryVersion } from '../plugin/sub-human/core/cc/contract.js';

export const LAST: string = path.join(REPO, 'scripts', 'canary', 'last.json');

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

/** One type root against the snapshot: lines only one side has (the "Written by" line aside). */
export interface RootDiff { root: string, same: boolean, added: number, removed: number }

export function typingsDiff(before: Readonly<Record<string, string | null>>, after: Readonly<Record<string, string>>): RootDiff[] {
  const body = (s: string): string[] => s.split('\n').filter(l => !l.startsWith('// Written by Claude Code '));
  return Object.entries(after).map(([root, text]) => {
    const a = body(before[root] ?? ''), b = body(text);
    const had = new Set(a), has = new Set(b);
    const added = b.filter(l => !had.has(l)).length, removed = a.filter(l => !has.has(l)).length;
    return { root, same: added === 0 && removed === 0 && a.length === b.length, added, removed };
  });
}

/** A step that ran a command: its exit and the tail of its output. */
export interface Step { ok: boolean, status: number | null, tail: string }
/** Every step the canary ran; a step that could not run is null. */
export interface Steps { install: Step, typings: { ok: boolean, error?: string, roots: RootDiff[] } | null, probe: Report | null, module: Step | null, validate: Step | null }

/** Every step ran and passed. */
export const verdict = (s: Steps): boolean => s.install.ok && !!s.typings?.ok && !!s.probe?.ok && !!s.module?.ok && !!s.validate?.ok;

/** The summary: a line a step, then a line per failed feature naming its SUB_HUMAN_CC_OFF value. */
export function summary(tag: string, s: Steps): string[] {
  const mark = (ok: boolean | undefined): string => (ok ? 'PASS' : 'FAIL');
  const indent = (t: string): string => t.split('\n').join('\n                ');
  const out = [`canary ${tag}${s.probe?.version ? ` = claude ${s.probe.version}` : ''}: ${mark(verdict(s))}`];
  out.push(`  ${mark(s.install.ok)}  install   ${indent(s.install.tail)}`);
  if (s.typings) {
    const changed = s.typings.roots.filter(r => !r.same).map(r => `${r.root} +${r.added} -${r.removed}`);
    out.push(`  ${mark(s.typings.ok)}  typings   ${s.typings.error ?? (changed.length ? `changed: ${changed.join(', ')}` : 'same as typings/')}`);
  }
  if (s.probe) {
    const count = (st: string): number => s.probe?.results.filter(r => r.status === st).length ?? 0;
    out.push(`  ${mark(s.probe.ok)}  probe     ${count('pass')}/${s.probe.results.length} pass, ${count('skip')} skipped`);
    for (const [f, g] of Object.entries(s.probe.features)) {
      if (g.failed.length) out.push(`            ${f}: ${g.failed.join(', ')} failed; off with SUB_HUMAN_CC_OFF=${f}`);
    }
  }
  if (s.module) out.push(`  ${mark(s.module.ok)}  module    ${indent(s.module.tail)}`);
  if (s.validate) out.push(`  ${mark(s.validate.ok)}  validate  ${s.validate.ok ? 'plugin validate --strict passed' : indent(s.validate.tail)}`);
  return out;
}

const tail = (s: string, n = 6): string => s.trim().split('\n').slice(-n).join('\n');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Step {
  const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  const status = r.error ? null : r.status;
  return { ok: status === 0, status, tail: tail(out) };
}

/** Steps 2 and 3 over the installed binary. */
function inspect(bin: string, prefix: string): Pick<Steps, 'typings' | 'probe'> {
  const found = readContract();
  if (!found.ok) return { typings: { ok: false, error: found.error, roots: [] }, probe: null };
  const contract = found.value;
  const buf = fs.readFileSync(bin);
  const binary = buf.toString('latin1');
  const dir = path.join(prefix, 'typings');
  fs.rmSync(dir, { recursive: true, force: true });
  const version = binaryVersion(binary);
  const why = version === null ? 'no VERSION literal in the binary' : extractTypings(buf, version, dir);
  const read = (d: string, r: string): string | null => { try { return fs.readFileSync(path.join(d, r, 'index.d.ts'), 'utf8'); } catch { return null; } };
  const typings = why !== null ? { ok: false, error: why, roots: [] }
    : { ok: true, roots: typingsDiff(Object.fromEntries(ROOTS.map(r => [r, read(TARGET, r)])), Object.fromEntries(ROOTS.map(r => [r, read(dir, r) ?? '']))) };
  return { typings, probe: report(contract, bin, { typings: why === null ? readTypings(dir) : null, binary }, null) };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) { process.stderr.write(`canary: ${args.error}\n`); return 2; }
  const prefix = path.join(os.tmpdir(), 'sub-human-canary', args.tag);
  const configDir = args.configDir ?? path.join(prefix, 'config');
  if (!args.configDir) fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });

  process.stdout.write(`canary: installing ${PKG}@${args.tag} into ${prefix}\n`);
  const inst = install(prefix, args.tag);
  const bin = 'bin' in inst ? inst.bin : null;
  const steps: Steps = {
    install: { ok: bin !== null, status: bin === null ? 1 : 0, tail: 'bin' in inst ? inst.bin : inst.error },
    typings: null, probe: null, module: null, validate: null,
  };
  if (bin) {
    Object.assign(steps, inspect(bin, prefix));
    const env: NodeJS.ProcessEnv = { ...process.env, SUB_HUMAN_CLAUDE_BIN: bin, CLAUDE_CONFIG_DIR: configDir };
    steps.module = run(process.execPath, [path.join(REPO, 'scripts', 'test-mods.ts')], env, 600_000);
    steps.validate = run(bin, ['plugin', 'validate', PLUGIN, '--strict'], env, 120_000);
  }

  const ok = verdict(steps);
  fs.mkdirSync(path.dirname(LAST), { recursive: true });
  fs.writeFileSync(LAST, `${JSON.stringify({ ok, tag: args.tag, bin, configDir, at: new Date().toISOString(), ...steps }, null, 1)}\n`);
  process.stdout.write(`${[...summary(args.tag, steps), `  ${path.relative(REPO, LAST)}`].join('\n')}\n`);
  return ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
