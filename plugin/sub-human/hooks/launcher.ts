// plugin/sub-human/hooks/launcher.ts: write <home>/bin/row-status, the launcher a person's own opt-in
// `subagentStatusLine` runs (README "Rows"), whenever a seat is taken or put back (refresh(): hooks/handlers/join.ts
// on a join, session-restore.ts on clear, compact and resume), in that process: a session with no seat has no rows,
// so it writes nothing and starts no node for it. The plugin sets no subagentStatusLine itself and never writes a
// settings file: a plugin's settings.json command gets no ${CLAUDE_PLUGIN_ROOT} (docs/internals/cc-2.1.281.md §9),
// and a path the shell computes is refused by the plugin directory. The person adds, to their user settings,
//   "subagentStatusLine": {"type": "command", "command": "\"${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status\""}
// (a status line command runs through the shell, so the env default expands there). The status line process
// inherits claude's env, so SUB_HUMAN_HOME reaches the CLI unchanged. Without that line the rows show their names.
//
// Which plugin root it runs. Several roots can write the one stable path (an installed plugin, a --plugin-dir
// checkout, a demo copy), and the status line process can't say which one its session loaded. So:
//   - every root that seats a session is recorded in <home>/bin/roots.json ({root: {at, temp}});
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
import * as identity from '../lib/identity.ts';
import { writeFileAtomic, writeJsonAtomic, readJson } from '../lib/io.ts';
import { objAs } from '../lib/decode.ts';

const LAUNCHER = 'row-status';
const ROOTS = 'roots.json';
const ROOTS_MAX = 8;

const binDir = () => path.join(identity.home(), 'bin');
function launcherPath() { return path.join(binDir(), LAUNCHER); }
const rootsPath = () => path.join(binDir(), ROOTS);

import { isTempPath as isTempRoot, allowTmpRoot as allowTmp } from '../lib/home.ts';
import * as shim from '../lib/remote/shim.ts';

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cliOf = (root: string) => path.join(root, 'scripts', 'sub-human');

/** The launcher script for an ordered list of roots: exec the first whose CLI exists, else print nothing. */
function launcherBody(roots: string | string[]): string {
  const list = Array.isArray(roots) ? roots : [roots];
  const lines = list.map(r => `[ -f ${q(cliOf(r))} ] && exec node ${q(cliOf(r))} agent-statusline "$@"`);
  return '#!/bin/sh\n# written by sub-human hooks/launcher.ts (a seat taken or put back); a subagentStatusLine you add runs it.\n'
    + '# Roots in order: outside temp dirs first, newest first (see launcher.ts).\n'
    + `${lines.join('\n')}\nexit 0\n`;
}

/** The recorded roots, ordered for the launcher. */
/** roots.json: when each root last started a session, and whether it sits under a temp dir. */
type RootsRec = Record<string, { at?: unknown; temp?: unknown } | null | undefined>;

function orderRoots(rec: RootsRec | null): string[] {
  const xs = Object.entries(rec ?? {}).map(([root, v]) => ({ root, at: Number(v && v.at) || 0, temp: !!(v && v.temp) }));
  xs.sort((a, b) => (Number(a.temp) - Number(b.temp)) || (b.at - a.at));
  return xs.map(x => x.root);
}

/**
 * Record root and rewrite the launcher. Returns the launcher path, or null when root was refused (a temp root
 * without SUB_HUMAN_ALLOW_TMP_ROOT=1); a refused root changes nothing.
 */
function writeLauncher(root: string = process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, '..'), { now = Date.now(), env = process.env }: { now?: number; env?: NodeJS.ProcessEnv } = {}): string | null {
  root = path.resolve(root);
  const temp = isTempRoot(root);
  if (temp && !allowTmp(env)) return null;
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  const rec = readJson(rootsPath(), objAs<RootsRec>(), {});
  for (const r of Object.keys(rec)) if (!fs.existsSync(cliOf(r)) || (rec[r] && rec[r].temp && !allowTmp(env) && r !== root)) delete rec[r];
  rec[root] = { at: now, temp };
  const ordered = orderRoots(rec).slice(0, ROOTS_MAX);
  const kept = Object.fromEntries(ordered.map(r => [r, rec[r]]));
  writeJsonAtomic(rootsPath(), kept);
  const f = launcherPath();
  const body = launcherBody(ordered);
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
  if (cur !== body) writeFileAtomic(f, body, { mode: 0o700 }); // run as this user only, like everything in the home
  return f;
}

export { launcherBody, isTempRoot, writeLauncher };

/** The launcher and the serve shim, best effort: a failure is a line on stderr (the rows show their names) and never
 * fails the hook it runs in. */
export function refresh(): void {
  try {
    if (!writeLauncher()) process.stderr.write('sub-human row-launcher: plugin root is under a temp dir; not used for the row status line (set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow)\n');
  } catch (e) { process.stderr.write(`sub-human row-launcher error: ${e instanceof Error && e.stack || e}\n`); /* the rows show their names */ }
  try { shim.refresh(); } catch (e) { process.stderr.write(`sub-human serve shim error: ${e instanceof Error && e.message || e}\n`); }
}
