#!/usr/bin/env node
/**
 * checks: compute docs/rebuild/checks.json from the evidence a scripts/demo.sh run (slim build) left behind.
 *
 *   node scripts/checks.ts [--screens DIR] [--out FILE] [--home DIR] [--home2 DIR] [--room CODE] [--note TEXT]
 *
 * Evidence only, nothing assumed: the room log ($SUB_HUMAN_HOME/rooms/CODE/log.jsonl), members.json, tasks.json,
 * plans/, the per-step state demo.sh saved (screens/state/SCENE/N: members.json, rows/, tasks.json,
 * `claude agents --json`, `sub-human tasks`, the room Claude's native task files; S6/gate-bob.json, S9/synthetic-prompt.json,
 * S11/: carol's mirror log, link status and file shape, both machine ids), S11's second home (--home2, default the
 * home's sibling home2),
 * the pane captures (screens/index.json + *.txt; the room Claude's pane is `claude logs <job>`) and the seats' Claude Code
 * transcripts (read-only; the room Claude's is the file named after its session id). A check whose evidence is missing
 * fails and says so.
 *
 * The checks live in scripts/checks/*.ts, one module per scene ({scene, run(ctx, {det, beh}, thresholds)}; ctx from
 * scripts/checks/context.ts). Each check is one of two kinds:
 *   deterministic  log, chain, files, panes: a failure fails the run (exit 1)
 *   behavioural    model-call counts, wakes, noise: a value against a threshold (scripts/baselines.json); over it
 *                  is a warning, reported and summarised apart, never a failure
 *
 * A partial run (screens/run.json, written by demo.sh: {scenes, partial}) skips the checks of the scenes it did not
 * plan: they are listed in _meta.skipped and counted nowhere. A planned scene with no evidence still fails.
 *
 * Output: {SCENE: [{check, kind, pass, status: pass|fail|warn, evidence, value?, threshold?}],
 *          _meta: {cost, run, note, summary, skipped?}, _metrics: {run, baseline, phase0, prev, target}}.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './lib/paths.ts';
import { clip, readJson } from './lib/io.ts';
import { context } from './checks/context.ts';
import { BASELINES } from './metrics.ts';
import type { Ctx, SceneModule, RunJson } from './checks/context.ts';
import type { Thresholds } from './metrics.ts';
import * as s01 from './checks/s01-open.ts';
import * as s02 from './checks/s02-join.ts';
import * as s03 from './checks/s03-pairing.ts';
import * as s04 from './checks/s04-plan.ts';
import * as s05 from './checks/s05-consent.ts';
import * as s06 from './checks/s06-tasks.ts';
import * as s06b from './checks/s06b-build.ts';
import * as s07 from './checks/s07-row-view.ts';
import * as s08 from './checks/s08-resilience.ts';
import * as s09 from './checks/s09-claude-typing.ts';
import * as s09b from './checks/s09b-multiline.ts';
import * as s11 from './checks/s11-remote.ts';
import * as s10 from './checks/s10-leave.ts';
import * as runMetrics from './checks/run-metrics.ts';

export { panelRows, statusLine } from './lib/panes.ts'; // kept for callers of the old exports

export const SCENES: readonly SceneModule[] = [s01, s02, s03, s04, s05, s06, s06b, s07, s08, s09, s09b, s11, s10, runMetrics];
export const ORDER = ['Metrics', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S6b', 'S7', 'S8', 'S9', 'S9b', 'S11', 'S10'];

/** One check's verdict in checks.json. */
export interface CheckResult {
  check: string;
  kind: 'deterministic' | 'behavioural';
  pass: boolean;
  status: 'pass' | 'fail' | 'warn';
  evidence: string;
  value?: number | null;
  threshold?: number;
}
/** The checks per scene. */
export type Results = Record<string, CheckResult[]>;
/** The counts by kind. */
export type Summary = Record<CheckResult['kind'], Record<string, number>>;

function args(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

/** Run every scene module over ctx: {SCENE: [check…]} (a module that throws records one failed check). */
export function runChecks(ctx: Ctx, { scenes = SCENES, thresholds = BASELINES.thresholds, planned = null }: { scenes?: readonly SceneModule[], thresholds?: Partial<Thresholds>, planned?: readonly string[] | null } = {}): Results {
  const C: Results = {};
  for (const mod of scenes) {
    if (planned && mod.scene !== 'Metrics' && !planned.includes(mod.scene)) continue; // not in this (partial) run
    const list = (C[mod.scene] = C[mod.scene] || []);
    const det = (check: string, pass: unknown, evidence: unknown): number => list.push({ check, kind: 'deterministic', pass: !!pass, status: pass ? 'pass' : 'fail', evidence: clip(evidence, 420) });
    const beh = (check: string, value: number | null | undefined, threshold: number, evidence: unknown): void => {
      const pass = value != null && Number.isFinite(+value) && +value <= threshold;
      list.push({ check, kind: 'behavioural', pass, status: pass ? 'pass' : 'warn', value: value == null ? null : value, threshold, evidence: clip(evidence, 420) });
    };
    // a test passes only the thresholds its checks read
    try { mod.run(ctx, { det, beh }, { ...BASELINES.thresholds, ...thresholds }); } catch (e) { det(`${mod.scene} checks ran`, false, `scene module threw: ${String(e instanceof Error ? e.stack : e).split('\n').slice(0, 2).join(' ')}`); }
  }
  const res: Results = {};
  for (const k of [...ORDER, ...Object.keys(C).filter(k => !ORDER.includes(k))]) if (C[k] && C[k].length) res[k] = C[k];
  return res;
}

/** The scenes a run planned (screens/run.json from demo.sh), or null: no plan saved, every scene is checked. */
export function plannedScenes(screens: string): string[] | null {
  const r = readJson<RunJson | null>(path.join(screens, 'run.json'), null);
  return r && Array.isArray(r.scenes) ? r.scenes.map(String) : null;
}

/** Counts by kind: {deterministic: {pass, fail}, behavioural: {pass, warn}}. */
export function summarise(res: Results): Summary {
  const s: Summary = { deterministic: { pass: 0, fail: 0 }, behavioural: { pass: 0, warn: 0 } };
  for (const [k, cs] of Object.entries(res)) if (!k.startsWith('_')) for (const c of cs) s[c.kind][c.status]++;
  return s;
}

function main() {
  const o = args(process.argv.slice(2));
  const screens = path.resolve(o.screens || path.join(paths.REPO, 'docs/rebuild/screens'));
  const out = path.resolve(o.out || path.join(paths.REPO, 'docs/rebuild/checks.json'));
  const home = path.resolve(o.home || paths.demoHome());
  const ctx: Ctx = context({ screens, home, room: o.room, ...(o.home2 ? { home2: path.resolve(o.home2) } : {}) });
  const planned = plannedScenes(screens);
  const res = runChecks(ctx, { planned });
  const summary = summarise(res);
  const skipped = planned ? ORDER.filter(k => k !== 'Metrics' && !planned.includes(k)) : [];
  const meta = { cost: ctx.cost(), run: `room ${ctx.code}, ${ctx.log.length} log entries, ${ctx.index.length} captures, claude job ${ctx.job}${skipped.length ? `; partial run: ${(planned || []).join(', ')}` : ''}`, note: o.note || '', summary, ...(skipped.length ? { skipped } : {}) };
  const M = ctx.metrics;
  const run = (name: keyof typeof BASELINES.compare) => { const { note, ...r } = BASELINES.runs[BASELINES.compare[name]]; void note; return r; };
  const metrics = M && !('error' in M)
    ? { _metrics: { run: { room: ctx.code, ...M }, baseline: run('baseline'), phase0: run('phase0'), prev: run('prev'), target: BASELINES.thresholds } }
    : {};
  fs.writeFileSync(out, JSON.stringify({ ...res, _meta: meta, ...metrics }, null, 1) + '\n');

  const lines: string[] = [], warns: string[] = [];
  for (const k of ORDER) for (const c of res[k] || []) {
    if (c.status === 'warn') warns.push(`WARN ${k} ${c.check} — ${c.value} > ${c.threshold}: ${c.evidence}`);
    else lines.push(`${c.status === 'pass' ? 'PASS' : 'FAIL'} ${k} ${c.check}${c.pass ? '' : ' — ' + c.evidence}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  if (warns.length) process.stdout.write(`\nbehavioural (warnings, not failures):\n${warns.join('\n')}\n`);
  if (skipped.length) process.stdout.write(`\nskipped (not in this partial run): ${skipped.join(', ')}\n`);
  const d = summary.deterministic, b = summary.behavioural;
  process.stdout.write(`\nchecks: deterministic ${d.pass} pass / ${d.fail} fail; behavioural ${b.pass} within threshold / ${b.warn} warn -> ${path.relative(process.cwd(), out)} (${meta.cost})\n`);
  return d.fail ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
