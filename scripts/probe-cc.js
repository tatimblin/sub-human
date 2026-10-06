#!/usr/bin/env node
'use strict';
/**
 * scripts/probe-cc.js: check the installed Claude Code binary against plugin/sub-human/lib/cc.js CONTRACT.
 *
 *   node scripts/probe-cc.js [--json] [--bin PATH] [--extra FILE.json] [--only id,id,...]
 *
 * Finds the binary (--bin, else $CLAUDE_BIN, else `claude` on PATH with symlinks resolved, else the newest
 * /opt/homebrew/Caskroom/claude-code*\/<version>/claude), reads it once and searches it for every literal
 * `search` string. Prints the version and PASS/FAIL per entry; exits 1 on any FAIL, 2 when no binary is found.
 * Extra entries ({id, search, stability?, note?}[]) come from --extra FILE or $CC_PROBE_EXTRA (JSON text);
 * the tests use that to feed a mutated string and expect a failure. --only limits the run to those CONTRACT ids
 * (extras always run; the derived `daemon-env-names` check runs only when named).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cc = require(path.join(__dirname, '..', 'plugin', 'sub-human', 'lib', 'cc.js'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function onPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (isFile(p)) { try { return fs.realpathSync(p); } catch { return p; } }
  }
  return null;
}

function caskroom() {
  const root = '/opt/homebrew/Caskroom';
  let best = null;
  let casks = [];
  try { casks = fs.readdirSync(root).filter(d => d.startsWith('claude-code')); } catch { return null; }
  for (const c of casks) {
    let vs = [];
    try { vs = fs.readdirSync(path.join(root, c)); } catch { continue; }
    for (const v of vs) {
      const p = path.join(root, c, v, 'claude');
      if (!isFile(p)) continue;
      const mt = fs.statSync(p).mtimeMs;
      if (!best || mt > best.mt) best = { p, mt };
    }
  }
  return best && best.p;
}

/** The binary to probe, or null. A JS shim (npm install) is followed to its real file only via realpath. */
function locate() {
  const cands = [arg('--bin'), process.env.CLAUDE_BIN, onPath('claude'), caskroom()].filter(Boolean);
  for (const c of cands) {
    let p = c;
    try { p = fs.realpathSync(c); } catch { continue; }
    if (isFile(p)) return p;
  }
  return null;
}

function version(buf, bin) {
  const i = buf.indexOf('VERSION:"');
  if (i >= 0) {
    const s = buf.toString('latin1', i + 9, i + 40);
    const v = /^(\d+\.\d+\.\d+[^"]*)"/.exec(s);
    if (v) return v[1];
  }
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const v = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return v ? v[1] : 'unknown';
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
  const bin = locate();
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
  const results = entries.map(e => {
    const searches = Array.isArray(e.search) ? e.search : [e.search];
    const missing = searches.filter(s => buf.indexOf(s, 0, 'utf8') < 0);
    return { id: e.id, stability: e.stability, ok: missing.length === 0, missing, note: e.note };
  });
  // Derived check: every DAEMON_ENV_ALLOW name exists as a quoted literal in the binary.
  if (pick('daemon-env-names')) {
    const absent = cc.DAEMON_ENV_ALLOW.filter(k => buf.indexOf(`"${k}"`, 0, 'utf8') < 0);
    results.push({ id: 'daemon-env-names', stability: 'env', ok: absent.length === 0, missing: absent, note: 'every cc.DAEMON_ENV_ALLOW key is a string in the binary' });
  }
  const failed = results.filter(r => !r.ok);
  const ms = Date.now() - t0;
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, bin, version: ver, ms, results }, null, 1) + '\n');
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
