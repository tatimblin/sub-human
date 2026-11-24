#!/usr/bin/env node
/**
 * probe-cc: npm run probe. Checks a Claude Code binary and the typings against plugin/sub-human/core/cc/contract.json
 * with core/cc/contract.ts's matcher: api entries against the typings, internal ones against the binary.
 *
 *   npm run probe [-- --bin PATH] [--typings DIR] [--no-typings] [--json]
 *   npm run --silent probe -- --print-bin     the binary it would probe (installing it), for CI
 *
 * It loads plugin code, so node runs it with --import ./plugin/sub-human/resolve-ts.ts (as the npm script does).
 *
 * The binary is --bin, else the pinned one for contract.json `probed` (scripts/lib/claude-bin.ts, installed on first
 * use). The typings are DIR's type roots, by default the committed snapshot typings/, whose claude-code must also be
 * written by `probed` (refresh with npm run typings); --no-typings skips only that version check, as the canary does
 * for a newer binary. Prints one line per entry and per failed feature; exits 1 on a failure, 2 when the arguments,
 * the contract or the binary cannot be read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, REPO } from './lib/paths.ts';
import { ROOTS, TARGET, writtenBy } from './typings.ts';
import { claudeBin } from './lib/claude-bin.ts';
import { parseContract, probe, byFeature, binaryVersion } from '../plugin/sub-human/core/cc/contract.js';
import type { Contract, Check } from '../plugin/sub-human/core/cc/contract.js';
import { err } from '../plugin/sub-human/core/result.js';
import type { Result } from '../plugin/sub-human/core/result.js';

export const CONTRACT: string = path.join(PLUGIN, 'core', 'cc', 'contract.json');
export const TYPINGS: string = path.join(TARGET, 'claude-code', 'index.d.ts');

/** The probe's arguments. */
export interface ProbeArgs { bin?: string, typings: string, versionCheck: boolean, json: boolean, printBin: boolean }

export function parseArgs(argv: readonly string[]): ProbeArgs | { error: string } {
  const out: ProbeArgs = { typings: TARGET, versionCheck: true, json: false, printBin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bin' || a === '--typings') {
      const val = argv[++i];
      if (!val) return { error: `${a} needs a path` };
      if (a === '--bin') out.bin = path.resolve(val); else out.typings = path.resolve(val);
    } else if (a === '--no-typings') out.versionCheck = false;
    else if (a === '--json') out.json = true;
    else if (a === '--print-bin') out.printBin = true;
    else return { error: `unknown argument ${a ?? ''}` };
  }
  return out;
}

/** Whether the declarations file was written by the probed Claude Code. */
export function typingsCheck(file: string, probed: string): { ok: boolean, version: string | null, probed: string } {
  let version: string | null = null;
  try { version = writtenBy(fs.readFileSync(file, 'utf8')); } catch { /* missing: version stays null */ }
  return { ok: version === probed, version, probed };
}

/** The declarations the api entries are matched in: each type root's index.d.ts under dir, joined; null when none. */
export function readTypings(dir: string): string | null {
  const parts: string[] = [];
  for (const r of ROOTS) { try { parts.push(fs.readFileSync(path.join(dir, r, 'index.d.ts'), 'utf8')); } catch { /* left out */ } }
  return parts.length ? parts.join('\n') : null;
}

export function readContract(file: string = CONTRACT): Result<Contract> {
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return err(`${file}: ${e instanceof Error ? e.message : String(e)}`); }
  const r = parseContract(json);
  return r.ok ? r : err(`${path.relative(REPO, file)}: ${r.error}`);
}

/** The probe's report, as --json prints it and the canary reads it. */
export interface Report {
  ok: boolean, bin: string, version: string | null, probed: string,
  typings: { ok: boolean, version: string | null, probed: string } | null,
  results: Check[], features: ReturnType<typeof byFeature>,
}

export function report(c: Contract, bin: string, hay: { typings: string | null, binary: string }, typings: Report['typings']): Report {
  const results = probe(c, hay);
  const ok = results.every(r => r.status !== 'fail') && (typings?.ok ?? true);
  return { ok, bin, version: binaryVersion(hay.binary), probed: c.probed, typings, results, features: byFeature(results) };
}

const row = (status: string, id: string, rest: string): string => `${status.toUpperCase().padEnd(4)}  ${id.padEnd(22)} ${rest}`;

/** The report as lines: one per entry, then one per failed feature naming the SUB_HUMAN_CC_OFF value for it. */
export function lines(r: Report): string[] {
  const out = [`claude ${r.version ?? '(unknown version)'}  ${r.bin}  (contract probed on ${r.probed})`];
  for (const x of r.results) {
    out.push(row(x.status, x.id, `${x.kind.padEnd(8)} ${x.feature}${x.why ? `  ${x.why}` : ''}`));
    for (const m of x.missing) out.push(`      missing: ${JSON.stringify(m).slice(0, 160)}`);
  }
  const t = r.typings;
  out.push(t === null ? row('skip', 'typings', '--no-typings')
    : t.ok ? row('pass', 'typings', `typings/claude-code written by ${t.probed}`)
    : row('fail', 'typings', `typings/claude-code written by ${t.version ?? '(unreadable)'}, contract probed ${t.probed}: npm run typings`));
  for (const [f, g] of Object.entries(r.features)) {
    if (g.failed.length) out.push(`${f}: ${g.failed.length}/${g.total} failed (${g.failed.join(', ')}); off with SUB_HUMAN_CC_OFF=${f}`);
  }
  const count = (s: Check['status']): number => r.results.filter(x => x.status === s).length;
  out.push(`${count('pass')}/${r.results.length} pass, ${count('skip')} skipped: ${r.ok ? 'PASS' : 'FAIL'}`);
  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) { process.stderr.write(`probe-cc: ${args.error}\n`); return 2; }
  const read = readContract();
  if (!read.ok) { process.stderr.write(`probe-cc: ${read.error}\n`); return 2; }
  const c = read.value;
  const found = args.bin !== undefined ? { bin: args.bin } : claudeBin(c.probed);
  if ('error' in found) { process.stderr.write(`probe-cc: ${found.error}\n`); return 2; }
  if (args.printBin) { process.stdout.write(`${found.bin}\n`); return 0; }
  let binary: string;
  try { binary = fs.readFileSync(found.bin).toString('latin1'); } catch (e) { process.stderr.write(`probe-cc: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  const versionCheck = args.versionCheck ? typingsCheck(path.join(args.typings, 'claude-code', 'index.d.ts'), c.probed) : null;
  const r = report(c, found.bin, { typings: readTypings(args.typings), binary }, versionCheck);
  process.stdout.write(args.json ? `${JSON.stringify(r, null, 1)}\n` : `${lines(r).join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
