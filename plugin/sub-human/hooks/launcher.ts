// plugin/sub-human/hooks/handlers/row-launcher.ts: SessionStart (every source): write the launcher the plugin's settings.json `subagentStatusLine` runs.
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
// (lib/remote/shim.ts), so an authorized_keys forced command follows plugin updates and node upgrades; passively,
// so a dev checkout (--plugin-dir) never takes the pointer from the installed plugin while that one exists.
import fs from 'node:fs';
import path from 'node:path';
import * as identity from '../../lib/identity.ts';
import { writeFileAtomic, writeJsonAtomic, readJson } from '../../lib/io.ts';

const LAUNCHER = 'row-status';
const ROOTS = 'roots.json';
const ROOTS_MAX = 8;

const binDir = () => path.join(identity.home(), 'bin');
function launcherPath() { return path.join(binDir(), LAUNCHER); }
const rootsPath = () => path.join(binDir(), ROOTS);

import { isTempPath as isTempRoot, allowTmpRoot as allowTmp } from '../../lib/home.ts';
import * as shim from '../../lib/remote/shim.ts';

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cliOf = (root: string) => path.join(root, 'scripts', 'sub-human');

/** The launcher script for an ordered list of roots: exec the first whose CLI exists, else print nothing. */
function launcherBody(roots: string | string[]): string {
  const list = Array.isArray(roots) ? roots : [roots];
  const lines = list.map(r => `[ -f ${q(cliOf(r))} ] && exec node ${q(cliOf(r))} agent-statusline "$@"`);
  return '#!/bin/sh\n# written by sub-human hooks/row-launcher.ts (SessionStart); the plugin\'s subagentStatusLine runs it.\n'
    + '# Roots in order: outside temp dirs first, newest first (see row-launcher.ts).\n'
    + `${lines.join('\n')}\nexit 0\n`;
}

/** The recorded roots, ordered for the launcher. */
/** roots.json: when each root last started a session, and whether it sits under a temp dir. */
type RootsRec = Record<string, { at?: unknown; temp?: unknown } | null | undefined>;

function orderRoots(rec: RootsRec | null): string[] {
  const xs = Object.entries(rec || {}).map(([root, v]) => ({ root, at: Number(v && v.at) || 0, temp: !!(v && v.temp) }));
  xs.sort((a, b) => (Number(a.temp) - Number(b.temp)) || (b.at - a.at));
  return xs.map(x => x.root);
}

/**
 * Record root and rewrite the launcher. Returns the launcher path, or null when root was refused (a temp root
 * without SUB_HUMAN_ALLOW_TMP_ROOT=1); a refused root changes nothing.
 */
function writeLauncher(root = process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, '..', '..'), { now = Date.now(), env = process.env } = {}) {
  root = path.resolve(root);
  const temp = isTempRoot(root);
  if (temp && !allowTmp(env)) return null;
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  const rec: RootsRec = readJson(rootsPath(), {}) || {};
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

export { launcherBody, isTempRoot };

/** stdin is unused; nothing goes out but stderr. */
export function handle() {
  try {
    if (!writeLauncher()) process.stderr.write('sub-human row-launcher: plugin root is under a temp dir; not used for the row status line (set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow)\n');
  } catch (e) { process.stderr.write(`sub-human row-launcher error: ${e instanceof Error && e.stack || e}\n`); /* rows fall back to their default text */ }
  try { shim.refresh(); } catch (e) { process.stderr.write(`sub-human serve shim error: ${e instanceof Error && e.message || e}\n`); }
}
