#!/usr/bin/env node
'use strict';
// SessionStart (every source): write the launcher the plugin's settings.json `subagentStatusLine` runs.
// ${CLAUDE_PLUGIN_ROOT} is empty in settings.json (docs/internals/cc-2.1.281.md §9), so the setting names a
// fixed path instead:
//   "${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status"
// (a status line command runs through the shell, so the env default expands there). The status line process
// inherits claude's env, so SUB_HUMAN_HOME reaches the CLI unchanged.
//
// Which plugin root it runs. Several roots can write the one stable path (an installed plugin, a --plugin-dir
// checkout, a demo copy), and the status line process can't say which one its session loaded. So:
//   - every root that starts a session is recorded in <home>/bin/roots.json ({root: {at, temp}});
//   - a root under a temp dir (os.tmpdir(), /tmp, /private/tmp, /var/tmp) is refused unless
//     SUB_HUMAN_ALLOW_TMP_ROOT=1 (tests, the demo): a temp path can be deleted and re-created by anything on
//     the machine, and the launcher would then run whatever code sits there on every status line refresh;
//   - the launcher tries the recorded roots in order and execs the first whose CLI still exists: roots outside
//     temp dirs first, most recently started first; allowed temp roots last. A stable install therefore wins
//     over a demo copy, the newest checkout wins among stable roots, and a deleted root is skipped.
// Rewritten only when the content changes.
//
// It also refreshes the stable SSH serve shim, <home>/bin/serve and its pointer <home>/bin/current
// (lib/remote/shim.js), so an authorized_keys forced command follows plugin updates and node upgrades.
const fs = require('node:fs');
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const { writeFileAtomic, writeJsonAtomic, readJson } = require(path.join(__dirname, '..', 'lib', 'io.js'));

const LAUNCHER = 'row-status';
const ROOTS = 'roots.json';
const ROOTS_MAX = 8;

const binDir = () => path.join(identity.home(), 'bin');
function launcherPath() { return path.join(binDir(), LAUNCHER); }
const rootsPath = () => path.join(binDir(), ROOTS);

const { isTempPath: isTempRoot, allowTmpRoot: allowTmp } = require(path.join(__dirname, '..', 'lib', 'home.js'));
const shim = require(path.join(__dirname, '..', 'lib', 'remote', 'shim.js'));

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cliOf = root => path.join(root, 'scripts', 'sub-human');

/** The launcher script for an ordered list of roots: exec the first whose CLI exists, else print nothing. */
function launcherBody(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const lines = list.map(r => `[ -f ${q(cliOf(r))} ] && exec node ${q(cliOf(r))} agent-statusline "$@"`);
  return '#!/bin/sh\n# written by sub-human hooks/row-launcher.js (SessionStart); the plugin\'s subagentStatusLine runs it.\n'
    + '# Roots in order: outside temp dirs first, newest first (see row-launcher.js).\n'
    + `${lines.join('\n')}\nexit 0\n`;
}

/** The recorded roots, ordered for the launcher. */
function orderRoots(rec) {
  const xs = Object.entries(rec || {}).map(([root, v]) => ({ root, at: Number(v && v.at) || 0, temp: !!(v && v.temp) }));
  xs.sort((a, b) => (a.temp - b.temp) || (b.at - a.at));
  return xs.map(x => x.root);
}

/**
 * Record root and rewrite the launcher. Returns the launcher path, or null when root was refused (a temp root
 * without SUB_HUMAN_ALLOW_TMP_ROOT=1); a refused root changes nothing.
 */
function writeLauncher(root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'), { now = Date.now(), env = process.env } = {}) {
  root = path.resolve(root);
  const temp = isTempRoot(root);
  if (temp && !allowTmp(env)) return null;
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  const rec = readJson(rootsPath(), {}) || {};
  for (const r of Object.keys(rec)) if (!fs.existsSync(cliOf(r)) || (rec[r] && rec[r].temp && !allowTmp(env) && r !== root)) delete rec[r];
  rec[root] = { at: now, temp };
  const ordered = orderRoots(rec).slice(0, ROOTS_MAX);
  const kept = Object.fromEntries(ordered.map(r => [r, rec[r]]));
  writeJsonAtomic(rootsPath(), kept);
  const f = launcherPath();
  const body = launcherBody(ordered);
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
  if (cur !== body) writeFileAtomic(f, body, { mode: 0o755 });
  return f;
}

module.exports = { launcherBody, isTempRoot };

if (require.main === module) {
  try { fs.readFileSync(0, 'utf8'); } catch { /* stdin unused */ }
  try {
    if (!writeLauncher()) process.stderr.write('sub-human row-launcher: plugin root is under a temp dir; not used for the row status line (set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow)\n');
  } catch (e) { process.stderr.write(`sub-human row-launcher error: ${e && e.stack || e}\n`); /* rows fall back to their default text */ }
  try { shim.refresh(); } catch (e) { process.stderr.write(`sub-human serve shim error: ${e && e.message || e}\n`); }
}
