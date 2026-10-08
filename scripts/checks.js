#!/usr/bin/env node
'use strict';
/**
 * checks: compute docs/rebuild/checks.json from the evidence a scripts/demo.sh run (slim build) left behind.
 *
 *   node scripts/checks.js [--screens DIR] [--out FILE] [--home DIR] [--home2 DIR] [--room CODE] [--note TEXT]
 *
 * Evidence only, nothing assumed: the room log ($SUB_HUMAN_HOME/rooms/CODE/log.jsonl), members.json, tasks.json,
 * plans/, the per-step state demo.sh saved (screens/state/SCENE/N: members.json, rows/, tasks.json,
 * `claude agents --json`, `sub-human tasks`, the orch's native task files; S6/gate-bob.json, S9/synthetic-prompt.json,
 * S11/: carol's mirror log, link status and file shape, both machine ids), S11's second home (--home2, default the
 * home's sibling home2),
 * the pane captures (screens/index.json + *.txt; the orch's pane is `claude logs <job>`) and the seats' Claude Code
 * transcripts (read-only; the orch's is the file named after its session id). A check whose evidence is missing
 * fails and says so.
 *
 * The checks live in scripts/checks/*.js, one module per scene ({scene, run(ctx, {det, beh}, thresholds)}; ctx from
 * scripts/checks/context.js). Each check is one of two kinds:
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
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./lib/paths.js');
const { clip, readJson } = require('./lib/io.js');
const { context } = require('./checks/context.js');
const BASELINES = require('./baselines.json');

const SCENES = ['s01-open', 's02-join', 's03-pairing', 's04-plan', 's05-consent', 's06-tasks', 's07-row-view', 's08-resilience', 's09-orch-typing', 's09b-multiline', 's11-remote', 's10-leave', 'run-metrics']
  .map(m => require(`./checks/${m}.js`));
const ORDER = ['Metrics', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S9b', 'S11', 'S10'];

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

/** Run every scene module over ctx: {SCENE: [check…]} (a module that throws records one failed check). */
function runChecks(ctx, { scenes = SCENES, thresholds = BASELINES.thresholds, planned = null } = {}) {
  const C = {};
  for (const mod of scenes) {
    if (planned && mod.scene !== 'Metrics' && !planned.includes(mod.scene)) continue; // not in this (partial) run
    const list = (C[mod.scene] = C[mod.scene] || []);
    const det = (check, pass, evidence) => list.push({ check, kind: 'deterministic', pass: !!pass, status: pass ? 'pass' : 'fail', evidence: clip(evidence, 420) });
    const beh = (check, value, threshold, evidence) => {
      const pass = value != null && Number.isFinite(+value) && +value <= threshold;
      list.push({ check, kind: 'behavioural', pass, status: pass ? 'pass' : 'warn', value: value == null ? null : value, threshold, evidence: clip(evidence, 420) });
    };
    try { mod.run(ctx, { det, beh }, thresholds); } catch (e) { det(`${mod.scene} checks ran`, false, `scene module threw: ${e.stack.split('\n').slice(0, 2).join(' ')}`); }
  }
  const res = {};
  for (const k of [...ORDER, ...Object.keys(C).filter(k => !ORDER.includes(k))]) if (C[k] && C[k].length) res[k] = C[k];
  return res;
}

/** The scenes a run planned (screens/run.json from demo.sh), or null: no plan saved, every scene is checked. */
function plannedScenes(screens) {
  const r = readJson(path.join(screens, 'run.json'), null);
  return r && Array.isArray(r.scenes) ? r.scenes : null;
}

/** Counts by kind: {deterministic: {pass, fail}, behavioural: {pass, warn}}. */
function summarise(res) {
  const s = { deterministic: { pass: 0, fail: 0 }, behavioural: { pass: 0, warn: 0 } };
  for (const [k, cs] of Object.entries(res)) if (!k.startsWith('_')) for (const c of cs) s[c.kind][c.status]++;
  return s;
}

function main() {
  const o = args(process.argv.slice(2));
  const screens = path.resolve(o.screens || path.join(paths.REPO, 'docs/rebuild/screens'));
  const out = path.resolve(o.out || path.join(paths.REPO, 'docs/rebuild/checks.json'));
  const home = path.resolve(o.home || paths.demoHome());
  const ctx = context({ screens, home, room: o.room, ...(o.home2 ? { home2: path.resolve(o.home2) } : {}) });
  const planned = plannedScenes(screens);
  const res = runChecks(ctx, { planned });
  const summary = summarise(res);
  const skipped = planned ? ORDER.filter(k => k !== 'Metrics' && !planned.includes(k)) : [];
  res._meta = { cost: ctx.cost(), run: `room ${ctx.code}, ${ctx.log.length} log entries, ${ctx.index.length} captures, orch job ${ctx.job}${skipped.length ? `; partial run: ${planned.join(', ')}` : ''}`, note: o.note || '', summary };
  if (skipped.length) res._meta.skipped = skipped;
  const M = ctx.metrics;
  if (M && !M.error) {
    const run = name => { const { note, ...r } = BASELINES.runs[BASELINES.compare[name]]; void note; return r; };
    res._metrics = { run: { room: ctx.code, ...M }, baseline: run('baseline'), phase0: run('phase0'), prev: run('prev'), target: BASELINES.thresholds };
  }
  fs.writeFileSync(out, JSON.stringify(res, null, 1) + '\n');

  const lines = [], warns = [];
  for (const k of ORDER) for (const c of res[k] || []) {
    if (c.status === 'warn') warns.push(`WARN ${k} ${c.check} — ${c.value} > ${c.threshold}: ${c.evidence}`);
    else lines.push(`${c.status === 'pass' ? 'PASS' : 'FAIL'} ${k} ${c.check}${c.pass ? '' : ' — ' + c.evidence}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  if (warns.length) process.stdout.write(`\nbehavioural (warnings, not failures):\n${warns.join('\n')}\n`);
  if (skipped.length) process.stdout.write(`\nskipped (not in this partial run): ${skipped.join(', ')}\n`);
  const d = summary.deterministic, b = summary.behavioural;
  process.stdout.write(`\nchecks: deterministic ${d.pass} pass / ${d.fail} fail; behavioural ${b.pass} within threshold / ${b.warn} warn -> ${path.relative(process.cwd(), out)} (${res._meta.cost})\n`);
  return d.fail ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

const { panelRows, statusLine } = require('./lib/panes.js'); // kept for callers of the old exports
module.exports = { runChecks, summarise, plannedScenes, SCENES, ORDER, panelRows, statusLine };
