#!/usr/bin/env node
'use strict';
/**
 * scripts/probe-cc.js: check the installed Claude Code binary against plugin/sub-human/lib/cc/contract.json.
 *
 *   node scripts/probe-cc.js [--json] [--bin PATH] [--extra FILE.json] [--only id,id,...]
 *
 * Reads the entries from contract.json itself. Finds the binary (lib/cc/contract.ts locateBinary: --bin, else
 * $CLAUDE_BIN, else `claude` on PATH with symlinks resolved, else the newest
 * /opt/homebrew/Caskroom/claude-code*\/<version>/claude), reads it once and checks it with contract.ts probe, the
 * matcher `sub-human doctor` runs too: every literal `search` string, every `shape` (shapeRe: literal code where `~`
 * stands for one minified identifier) and every `contains` group (the array at that place holds those names).
 * Prints the version and PASS/FAIL per entry, and the entries reported degraded on that version; exits 1 on any
 * FAIL, 2 when no binary is found.
 * Extra entries ({id, search, shape?, stability?, note?}[]) come from --extra FILE or $CC_PROBE_EXTRA (JSON text);
 * the tests use that to feed a mutated string and expect a failure. --only limits the run to those CONTRACT ids
 * (extras always run). --json also reports `ms` (wall)
 * and `cpuMs` (this process's CPU time, what the probe costs whatever else the machine runs).
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PLUGIN, pluginLib } = require('./lib/paths.js');

const CONTRACT_JSON = path.join(PLUGIN, 'lib', 'cc', 'contract.json');
const contract = JSON.parse(fs.readFileSync(CONTRACT_JSON, 'utf8'));
const cc = pluginLib('cc/contract.ts');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function version(buf, bin) {
  const v = cc.binaryVersion(buf);
  if (v) return v;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}

function extras() {
  let text = process.env.CC_PROBE_EXTRA || '';
  const f = arg('--extra');
  if (f) text = fs.readFileSync(f, 'utf8');
  if (!text) return [];
  const x = JSON.parse(text);
  return (Array.isArray(x) ? x : [x]).map(e => ({ stability: 'test', note: '', ...e }));
}

function main() {
  const json = process.argv.includes('--json');
  const t0 = Date.now();
  const bin = cc.locateBinary({ bin: arg('--bin') });
  if (!bin) {
    const msg = 'probe-cc: no Claude Code binary found (set CLAUDE_BIN)';
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n'); else process.stderr.write(msg + '\n');
    process.exit(2);
  }
  const buf = fs.readFileSync(bin);
  const ver = version(buf, bin);
  const only = arg('--only') !== undefined ? new Set(arg('--only').split(',').filter(Boolean)) : null;
  const pick = id => !only || only.has(id);
  const entries = [...contract.entries.filter(e => pick(e.id)), ...extras()];
  const results = cc.probe(buf, { entries });
  const degraded = cc.degradedOn(ver, contract.entries);
  const failed = results.filter(r => !r.ok);
  const ms = Date.now() - t0;
  const cpu = process.cpuUsage();
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, bin, version: ver, probed: contract.probed, ms, cpuMs, results, degraded }, null, 1) + '\n');
  } else {
    process.stdout.write(`claude ${ver}  ${bin}\n`);
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(34)} ${r.stability}\n`);
      for (const m of r.missing) process.stdout.write(`      missing: ${JSON.stringify(m).slice(0, 160)}\n`);
    }
    for (const d of degraded) process.stdout.write(`NOTE  ${d.id.padEnd(34)} reported changed on ${ver}${d.issue ? ` (#${d.issue})` : ''}: ${d.note}\n`);
    process.stdout.write(`${results.length - failed.length}/${results.length} pass in ${ms} ms\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
