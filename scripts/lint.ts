#!/usr/bin/env node
/**
 * lint: npm run lint. Three parts, and it fails when any does:
 *   1. oxlint with its type-aware rules (oxlint-tsgolint, built on tsgo) over the repo (.oxlintrc.json). On the plugin
 *      and the scripts the type-safety rules are errors (no-explicit-any, no-non-null-assertion, the no-unsafe-*
 *      family, the promise rules, consistent-type-imports, ...): one fails the run. no-unsafe-type-assertion and
 *      prefer-nullish-coalescing, and the correctness category, warn.
 *   2. the ratchet (scripts/ts-ratchet.ts): the type escapes per directory may not rise above scripts/ts-ratchet.json.
 *      Lint bans `any` and `!` but not a cast, and allows a reasoned disable; the ratchet caps all three.
 *   3. directory-lint (scripts/directory-lint.ts): the plugin directory's review rules this plugin has tripped
 *      (permission answers a reviewer cannot read, computed command paths, inline programs, invisible characters,
 *      the checklist limits), over plugin/sub-human.
 *
 * tsgolint types each file by the nearest tsconfig.json whose project holds it, and takes no tsconfig of ours
 * (oxlint's --tsconfig is only for import resolution). Claude Code writes its own plugin/sub-human/tsconfig.json
 * (gitignored; it extends .claude-plugin/types/tsconfig.json, which holds hooks/ under bundler resolution and no node
 * types), which would win for hooks/ here and not in CI. So for the run that file is moved aside and put back.
 *
 * The memory guard: tsgolint 7.0.2004-7.0.2006 grows without bound (tens of GB in seconds) running
 * no-misused-promises' checksVoidReturn.arguments over a call to Claude Code's generic `On` (fixed in 7.0.2007), so
 * .oxlintrc.json turns that one check off in the files that call `on(...)`. And the run watches tsgolint's memory
 * (macOS footprint, which counts the compressed pages ps leaves out; elsewhere ps RSS) and stops it above
 * SUB_HUMAN_LINT_CAP_MB (default 4096), failing lint with one line.
 *
 *   node scripts/lint.ts [oxlint args...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const GENERATED = path.join(REPO, 'plugin', 'sub-human', 'tsconfig.json');
const ASIDE = `${GENERATED}.lint-aside`;
const CAP_MB = 4096;
const POLL_MS = 200;

export type Sample = { pid: number, mb: number };

/** The cap in MB: SUB_HUMAN_LINT_CAP_MB when it is a positive number, else 4096. */
export function capMb(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SUB_HUMAN_LINT_CAP_MB);
  return Number.isFinite(n) && n > 0 ? n : CAP_MB;
}

/** The MB in `footprint PID`'s "Footprint: 1.2 GB" line, or 0 when it has none. */
export function footprintMb(text: string): number {
  const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'MB' ? 1 : 1 / 1024);
}

type Proc = { pid: number, ppid: number, comm: string };

/** The processes under `root` (parents before children), from `ps -A -o pid=,ppid=,comm=`. */
export function descendants(ps: string, root: number): Proc[] {
  const rows = ps.trim().split('\n').map(l => l.trim().split(/\s+/))
    .map(([pid, ppid, ...comm]): Proc => ({ pid: Number(pid), ppid: Number(ppid), comm: comm.join(' ') }));
  const under: Proc[] = [];
  const seen = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); under.push(r); grew = true; }
  }
  return under;
}

/** The tsgolint binaries among them (its node shim's comm is node, not counted). */
export function tsgolintPids(procs: Proc[]): number[] {
  return procs.filter(r => path.basename(r.comm) === 'tsgolint').map(r => r.pid);
}

/** The sample to stop for: the first above the cap. One is enough, since the growth is GBs a second. */
export function overCap(samples: Sample[], cap: number): Sample | undefined { return samples.find(s => s.mb > cap); }

/** The one line a stopped run prints. */
export function capLine(s: Sample, cap: number): string {
  return `lint: tsgolint passed ${Math.round(s.mb)} MB (cap ${cap} MB, SUB_HUMAN_LINT_CAP_MB) and was stopped`;
}

function memoryMb(pid: number): number {
  try {
    if (process.platform === 'darwin') return footprintMb(execFileSync('footprint', [String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024 || 0;
  } catch { return 0; }
}

function psTable(): string {
  try { return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }); } catch { return ''; }
}

/** Runs oxlint, watching its tsgolint; its exit status, or 1 when the guard stopped it. */
function guarded(bin: string, args: string[], cap: number): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd: REPO, stdio: 'inherit' });
    let stopped: Sample | undefined;
    const timer = setInterval(() => {
      if (child.pid === undefined || stopped) return;
      const procs = descendants(psTable(), child.pid);
      stopped = overCap(tsgolintPids(procs).map(pid => ({ pid, mb: memoryMb(pid) })), cap);
      if (!stopped) return;
      // The whole tree, parents first, so no shim lives to print its child's SIGKILL.
      child.kill('SIGKILL');
      for (const r of procs) try { process.kill(r.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, POLL_MS);
    const done = (status: number): void => {
      clearInterval(timer);
      if (stopped) console.error(capLine(stopped, cap));
      resolve(stopped ? 1 : status);
    };
    child.once('error', () => done(1));
    child.once('exit', code => done(code ?? 1));
  });
}

async function oxlint(args: string[]): Promise<number> {
  const moved = fs.existsSync(GENERATED) && !fs.existsSync(ASIDE);
  const restore = () => { if (moved && fs.existsSync(ASIDE)) fs.renameSync(ASIDE, GENERATED); };
  const onSignal = (sig: NodeJS.Signals): void => { restore(); process.kill(process.pid, sig); };
  if (moved) {
    fs.renameSync(GENERATED, ASIDE);
    process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  }
  try {
    const bin = path.join(REPO, 'node_modules', '.bin', 'oxlint');
    return await guarded(bin, ['--type-aware', ...args], capMb(process.env));
  } finally {
    restore();
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
  }
}

async function main(argv: string[]): Promise<number> {
  const lint = await oxlint(argv);
  const ratchet = spawnSync(process.execPath, [path.join(import.meta.dirname, 'ts-ratchet.ts')], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  const directory = spawnSync(process.execPath, [path.join(import.meta.dirname, 'directory-lint.ts')], { cwd: REPO, stdio: 'inherit' }).status ?? 1;
  return lint || ratchet || directory;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
