#!/usr/bin/env node
'use strict';
/**
 * scripts/probe-cc.js: check the installed Claude Code binary against plugin/sub-human/lib/cc.js CONTRACT.
 *
 *   node scripts/probe-cc.js [--json] [--bin PATH] [--extra FILE.json] [--only id,id,...]
 *
 * Finds the binary (cc.locateBinary: --bin, else $CLAUDE_BIN, else `claude` on PATH with symlinks resolved, else
 * the newest /opt/homebrew/Caskroom/claude-code*\/<version>/claude), reads it once and checks it with cc.probe:
 * every literal `search` string and every `shape` (cc.shapeRe: literal code where `~` stands for one minified
 * identifier). Prints the version and PASS/FAIL per entry; exits 1 on any FAIL, 2 when no binary is found.
 * Extra entries ({id, search, shape?, stability?, note?}[]) come from --extra FILE or $CC_PROBE_EXTRA (JSON text);
 * the tests use that to feed a mutated string and expect a failure. --only limits the run to those CONTRACT ids
 * (extras always run; the derived `daemon-env-names` check runs only when named). --json also reports `ms` (wall)
 * and `cpuMs` (this process's CPU time, what the probe costs whatever else the machine runs).
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const cc = require('./lib/paths.js').pluginLib('cc.js');

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
  const entries = [...cc.CONTRACT.filter(e => pick(e.id)), ...extras()];
  const results = cc.probe(buf, { entries, envNames: pick('daemon-env-names') });
  const failed = results.filter(r => !r.ok);
  const ms = Date.now() - t0;
  const cpu = process.cpuUsage();
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, bin, version: ver, ms, cpuMs, results }, null, 1) + '\n');
  } else {
    process.stdout.write(`claude ${ver}  ${bin}\n`);
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(34)} ${r.stability}\n`);
      for (const m of r.missing) process.stdout.write(`      missing: ${JSON.stringify(m).slice(0, 160)}\n`);
    }
    process.stdout.write(`${results.length - failed.length}/${results.length} pass in ${ms} ms\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
