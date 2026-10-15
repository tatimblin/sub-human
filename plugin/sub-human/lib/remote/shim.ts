/**
 * plugin/sub-human/lib/remote/shim.ts: the stable `<home>/bin/serve` shim that an SSH forced command runs, and the
 * authorized_keys lines that name it. Zero dependencies beyond lib/home.ts and lib/io.ts.
 *
 * Why: the plugin cache is versioned (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/) and node often is
 * too (~/.nvm/versions/node/v24.15.0/bin/node). A forced command that bakes either path silently runs the OLD
 * server after a plugin update and breaks after a node upgrade. So the line names only the shim, and the shim
 * finds the plugin and node at run time:
 *   - <home>/bin/current holds three lines: the plugin root, the node that last ran it, and the plugin cache dir
 *     the root's version sits in (empty outside the cache). refresh() rewrites it (only on a change), so it follows
 *     plugin updates and node upgrades. Forced (force: true) by the commands that make a forced command: `host
 *     --ssh`, `admit`, `authorize` and `doctor --fix`. Passive (every join and restore, hooks/launcher.ts, and
 *     every CLI run, scripts/sub-human): only from an installed plugin (a root under the Claude Code plugin cache),
 *     or when the recorded root is gone or none is recorded, or for the recorded root itself (a new node). So a dev
 *     checkout or a worktree run without SUB_HUMAN_HOME never takes over the pointer of the real home;
 *   - the shim runs the recorded root's CLI (scripts/sub-human, else bin/sub-human); when that is gone it takes
 *     the newest version under the recorded cache dir that has one;
 *   - node: the recorded one if it is still executable, else `node` on PATH, else the usual install places
 *     (Homebrew, /usr/local, /usr/bin, the newest nvm version);
 *   - it runs only `sub-human serve ARGS`, nothing else, and exits 127 with a line on stderr when it finds no CLI
 *     or node.
 * A root under a temp dir is not recorded unless SUB_HUMAN_ALLOW_TMP_ROOT=1 (lib/home.ts isTempPath).
 *
 *   shimPath() -> string             <home>/bin/serve (0700)
 *   pointerPath() -> string          <home>/bin/current (0600)
 *   pluginRoot() -> string           the root of the plugin this module belongs to
 *   cacheDirOf(root) -> string       the versions dir when root is <...>/plugins/cache/<mkt>/<plugin>/<version>, else ''
 *   shimBody() -> string             the shim script (POSIX sh)
 *   refresh({root?, node?, env?, force?}) -> string|null
 *                                    write the pointer and the shim when they differ; the shim path, or null when
 *                                    root was refused (a temp root) and nothing was written. Without force, a root
 *                                    outside the plugin cache leaves an existing pointer to another live install
 *                                    alone (passive(): whether it would write)
 *   passive(root) -> bool            a passive refresh from root may write: root is in the plugin cache, or the
 *                                    pointer is missing, names root, or names a root with no CLI any more
 *   forcedCommand(code, linkId, homeDir?) -> string
 *                                    `SUB_HUMAN_HOME=<home> <home>/bin/serve --stdio CODE --link ID`
 *   authorizedLine(code, linkId, key, homeDir?) -> string
 *                                    command="<forcedCommand>",restrict <key> sub-human:CODE:ID
 *   enrollLine(code, key, homeDir?) -> string
 *                                    command="SUB_HUMAN_HOME=<home> <home>/bin/serve --enroll CODE --kind ssh",restrict <key>
 *                                    sub-human-enroll:CODE: a short code's enrollment door (lib/remote/enroll.ts)
 *   PLAIN_PATH_RE                    a path a forced command can carry plainly (no shell or sshd specials)
 */
import fs from 'node:fs';
import path from 'node:path';
import { home, isTempPath, allowTmpRoot } from '../home.ts';
import { writeFileAtomic } from '../io.ts';

const PLAIN_PATH_RE = /^\/[A-Za-z0-9_\/.@+,:-]+$/;

const binDir = (h: string = home()): string => path.join(path.resolve(h), 'bin');
const shimPath = (h?: string): string => path.join(binDir(h), 'serve');
const pointerPath = (h?: string): string => path.join(binDir(h), 'current');
const pluginRoot = (): string => path.resolve(import.meta.dirname, '..', '..');

const CACHE_RE = /\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+$/;
const cacheDirOf = (root: string): string => (CACHE_RE.test(path.resolve(root)) ? path.dirname(path.resolve(root)) : '');

function shimBody(): string {
  return `#!/bin/sh
# written by sub-human lib/remote/shim.ts; the authorized_keys forced commands the host's admit writes run it.
# Runs \`sub-human serve ARGS\` from the current plugin install with a working node, read from ./current at run time.
cur="$(dirname "$0")/current"
root= node= cache=
[ -f "$cur" ] && { read -r root; read -r node; read -r cache; } < "$cur"
cli() { for c in "$1/scripts/sub-human" "$1/bin/sub-human"; do [ -f "$c" ] && { echo "$c"; return 0; }; done; return 1; }
bin=
[ -n "$root" ] && bin=$(cli "$root")
if [ -z "$bin" ] && [ -n "$cache" ] && [ -d "$cache" ]; then
  for v in $(ls -1 "$cache" | sort -t. -k1,1nr -k2,2nr -k3,3nr); do bin=$(cli "$cache/$v") && break; done
fi
[ -n "$bin" ] || { echo "sub-human: no plugin install recorded in $cur; start Claude Code once on this machine" >&2; exit 127; }
if [ -z "$node" ] || [ ! -x "$node" ]; then
  node=$(command -v node 2>/dev/null)
  [ -n "$node" ] || for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { node=$n; break; }; done
  [ -n "$node" ] || for n in "$HOME"/.nvm/versions/node/v*/bin/node; do [ -x "$n" ] && node=$n; done
fi
[ -n "$node" ] || { echo "sub-human: no node found (recorded: $(sed -n 2p "$cur" 2>/dev/null))" >&2; exit 127; }
exec "$node" "$bin" serve "$@"
`;
}

/** Write path's content when it differs. */
function writeIfChanged(file: string, body: string, mode: number): boolean {
  let cur: string | null = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (cur === body) return false;
  writeFileAtomic(file, body, { mode });
  return true;
}

const hasCli = (root: string): boolean => ['scripts/sub-human', 'bin/sub-human'].some(c => fs.existsSync(path.join(root, c)));

function passive(root: string): boolean {
  root = path.resolve(root);
  if (cacheDirOf(root)) return true;
  let cur;
  try { cur = fs.readFileSync(pointerPath(), 'utf8').split('\n')[0]; } catch { return true; }
  return !cur || path.resolve(cur) === root || !hasCli(cur);
}

function refresh({ root = pluginRoot(), node = process.execPath, env = process.env, force = false }: {
  root?: string; node?: string; env?: NodeJS.ProcessEnv; force?: boolean;
} = {}): string | null {
  root = path.resolve(root);
  if (isTempPath(root) && !allowTmpRoot(env)) return null;
  if (/\n/.test(root + node)) return null;
  if (!force && !passive(root)) return shimPath(); // another live install is recorded: a dev run leaves it alone
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  writeIfChanged(pointerPath(), `${root}\n${node}\n${cacheDirOf(root)}\n`, 0o600);
  writeIfChanged(shimPath(), shimBody(), 0o700);
  return shimPath();
}

const forcedCommand = (code: string, linkId: string, h: string = home()): string =>
  `SUB_HUMAN_HOME=${path.resolve(h)} ${shimPath(h)} --stdio ${code} --link ${linkId}`;
const authorizedLine = (code: string, linkId: string, key: string, h: string = home()): string =>
  `command="${forcedCommand(code, linkId, h)}",restrict ${key} sub-human:${code}:${linkId}`;
/** The short code's enrollment door (lib/remote/enroll.ts): the room's public enrollment key runs only the PAKE. */
const enrollLine = (code: string, key: string, h: string = home()): string =>
  `command="SUB_HUMAN_HOME=${path.resolve(h)} ${shimPath(h)} --enroll ${code} --kind ssh",restrict ${key} sub-human-enroll:${code}`;

export {
  shimPath, pointerPath, pluginRoot, cacheDirOf, shimBody, refresh, passive, forcedCommand, authorizedLine,
  enrollLine, PLAIN_PATH_RE,
};
