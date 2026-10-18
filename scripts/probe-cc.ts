#!/usr/bin/env node
/**
 * scripts/probe-cc.ts: check the installed Claude Code binary against plugin/sub-human/lib/cc/contract.json.
 *
 *   node scripts/probe-cc.ts [--json] [--bin PATH] [--extra FILE.json] [--only id,id,...] [--no-typings]
 *
 * Reads the entries from contract.json itself. Finds the binary (lib/cc/contract.ts locateBinary: --bin, else
 * $CLAUDE_BIN, else `claude` on PATH with symlinks resolved, else the newest
 * /opt/homebrew/Caskroom/claude-code*\/<version>/claude), reads it once and checks it with contract.ts probe, the
 * matcher `sub-human doctor` runs too: every literal `search` string, every `shape` (shapeRe: literal code where `~`
 * stands for one minified identifier) and every `contains` group (the array at that place holds those names).
 * Prints the version and PASS/FAIL per entry, and the entries reported degraded on that version; exits 1 on any
 * FAIL, 2 when no binary is found.
 * It also fails (a FAIL `typings` line; `typings` in --json) when the committed typings snapshot,
 * typings/claude-code/index.d.ts, was written by another Claude Code than contract.json `probed`: refresh it with
 * `npm run typings` (scripts/typings.ts) after a session has loaded the plugin on the probed version. --no-typings
 * skips that check (a SKIP line; `typings: null` in --json): scripts/canary.ts probes a newer binary than `probed`.
 * Extra entries ({id, search, shape?, stability?, note?}[]) come from --extra FILE or $CC_PROBE_EXTRA (JSON text);
 * the tests use that to feed a mutated string and expect a failure. --only limits the run to those CONTRACT ids
 * (extras always run). --json also reports `ms` (wall)
 * and `cpuMs` (this process's CPU time, what the probe costs whatever else the machine runs).
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PLUGIN, REPO, pluginLib } from './lib/paths.ts';
import { writtenBy } from './typings.ts';
import { parseJson } from './lib/io.ts';
import type { ContractEntry } from '../plugin/sub-human/lib/cc/contract.ts';

const CONTRACT_JSON = path.join(PLUGIN, 'lib', 'cc', 'contract.json');
const contract = parseJson<{ probed: string, entries: ContractEntry[] }>(fs.readFileSync(CONTRACT_JSON, 'utf8'));
const cc = pluginLib('cc/contract.ts');
export const TYPINGS = path.join(REPO, 'typings', 'claude-code', 'index.d.ts');

/** Whether the typings snapshot was written by the probed Claude Code. */
export function typingsCheck(file = TYPINGS, probed = contract.probed): { ok: boolean, version: string | null, probed: string } {
  let version: string | null = null;
  try { version = writtenBy(fs.readFileSync(file, 'utf8')); } catch { /* missing: version stays null */ }
  return { ok: version === probed, version, probed };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function version(buf: Buffer, bin: string): string {
  const v = cc.binaryVersion(buf);
  if (v) return v;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m?.[1] ?? 'unknown';
}

/** An extra entry as --extra and $CC_PROBE_EXTRA give it: stability and note may be left out. */
type Extra = Omit<ContractEntry, 'stability' | 'note'> & Partial<Pick<ContractEntry, 'stability' | 'note'>>;

function extras(): ContractEntry[] {
  let text = process.env.CC_PROBE_EXTRA || '';
  const f = arg('--extra');
  if (f) text = fs.readFileSync(f, 'utf8');
  if (!text) return [];
  const x = parseJson<Extra | Extra[]>(text);
  return (Array.isArray(x) ? x : [x]).map(e => ({ stability: 'test', note: '', ...e }));
}

function main(): never {
  const json = process.argv.includes('--json');
  const t0 = Date.now();
  const binArg = arg('--bin');
  const bin = cc.locateBinary(binArg === undefined ? {} : { bin: binArg });
  if (!bin) {
    const msg = 'probe-cc: no Claude Code binary found (set CLAUDE_BIN)';
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n'); else process.stderr.write(msg + '\n');
    process.exit(2);
  }
  const buf = fs.readFileSync(bin);
  const ver = version(buf, bin);
  const onlyArg = arg('--only');
  const only = onlyArg !== undefined ? new Set(onlyArg.split(',').filter(Boolean)) : null;
  const pick = (id: string): boolean => !only || only.has(id);
  const entries = [...contract.entries.filter(e => pick(e.id)), ...extras()];
  const results = cc.probe(buf, { entries });
  const degraded = cc.degradedOn(ver, contract.entries);
  const failed = results.filter(r => !r.ok);
  const typings = process.argv.includes('--no-typings') ? null : typingsCheck();
  const ok = failed.length === 0 && (typings?.ok ?? true);
  const ms = Date.now() - t0;
  const cpu = process.cpuUsage();
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  if (json) {
    process.stdout.write(JSON.stringify({ ok, bin, version: ver, probed: contract.probed, typings, ms, cpuMs, results, degraded }, null, 1) + '\n');
  } else {
    process.stdout.write(`claude ${ver}  ${bin}\n`);
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(34)} ${r.stability}\n`);
      for (const m of r.missing) process.stdout.write(`      missing: ${JSON.stringify(m).slice(0, 160)}\n`);
    }
    for (const d of degraded) process.stdout.write(`NOTE  ${d.id.padEnd(34)} reported changed on ${ver}${d.issue ? ` (#${d.issue})` : ''}: ${d.note}\n`);
    process.stdout.write(!typings
      ? `SKIP  ${'typings'.padEnd(34)} --no-typings\n`
      : typings.ok
      ? `PASS  ${'typings'.padEnd(34)} typings/claude-code written by ${typings.version}\n`
      : `FAIL  ${'typings'.padEnd(34)} typings/claude-code written by ${typings.version ?? '(unreadable)'}, contract.json probed ${typings.probed}: npm run typings\n`);
    process.stdout.write(`${results.length - failed.length}/${results.length} pass in ${ms} ms\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) main();
