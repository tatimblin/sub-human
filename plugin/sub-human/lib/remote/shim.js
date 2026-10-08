'use strict';
/**
 * plugin/sub-human/lib/remote/shim.js: the stable `<home>/bin/serve` shim that an SSH forced command runs, and the
 * authorized_keys lines that name it. Zero dependencies beyond lib/home.js and lib/io.js.
 *
 * Why: the plugin cache is versioned (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/) and node often is
 * too (~/.nvm/versions/node/v24.15.0/bin/node). A forced command that bakes either path silently runs the OLD
 * server after a plugin update and breaks after a node upgrade. So the line names only the shim, and the shim
 * finds the plugin and node at run time:
 *   - <home>/bin/current holds three lines: the plugin root, the node that last ran it, and the plugin cache dir
 *     the root's version sits in (empty outside the cache). refresh() rewrites it (only on a change) from every
 *     SessionStart (hooks/row-launcher.js) and every CLI run (scripts/sub-human), so it follows plugin updates and
 *     node upgrades;
 *   - the shim runs the recorded root's CLI (scripts/sub-human, else bin/sub-human); when that is gone it takes
 *     the newest version under the recorded cache dir that has one;
 *   - node: the recorded one if it is still executable, else `node` on PATH, else the usual install places
 *     (Homebrew, /usr/local, /usr/bin, the newest nvm version);
 *   - it runs only `sub-human serve ARGS`, nothing else, and exits 127 with a line on stderr when it finds no CLI
 *     or node.
 * A root under a temp dir is not recorded unless SUB_HUMAN_ALLOW_TMP_ROOT=1 (lib/home.js isTempPath).
 *
 *   shimPath() -> string             <home>/bin/serve (0700)
 *   pointerPath() -> string          <home>/bin/current (0600)
 *   pluginRoot() -> string           the root of the plugin this module belongs to
 *   cacheDirOf(root) -> string       the versions dir when root is <...>/plugins/cache/<mkt>/<plugin>/<version>, else ''
 *   shimBody() -> string             the shim script (POSIX sh)
 *   refresh({root?, node?, env?}) -> string|null
 *                                    write the pointer and the shim when they differ; the shim path, or null when
 *                                    root was refused (a temp root) and nothing was written
 *   forcedCommand(code, linkId, homeDir?) -> string
 *                                    `SUB_HUMAN_HOME=<home> <home>/bin/serve --stdio CODE --link ID`
 *   authorizedLine(code, linkId, key, homeDir?) -> string
 *                                    command="<forcedCommand>",restrict <key> sub-human:CODE:ID
 *   migrateLines(text, homeDir?) -> {text, migrated}
 *                                    rewrite the lines an older `authorize` wrote for this home (node and the
 *                                    versioned CLI baked in) to name the shim; other lines are kept as they are
 *   PLAIN_PATH_RE                    a path a forced command can carry plainly (no shell or sshd specials)
 */
const fs = require('node:fs');
const path = require('node:path');
const { home, isTempPath, allowTmpRoot } = require('../home.js');
const { writeFileAtomic } = require('../io.js');

const PLAIN_PATH_RE = /^\/[A-Za-z0-9_\/.@+,:-]+$/;

const binDir = (h = home()) => path.join(path.resolve(h), 'bin');
const shimPath = (h) => path.join(binDir(h), 'serve');
const pointerPath = (h) => path.join(binDir(h), 'current');
const pluginRoot = () => path.resolve(__dirname, '..', '..');

const CACHE_RE = /\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+$/;
const cacheDirOf = root => (CACHE_RE.test(path.resolve(root)) ? path.dirname(path.resolve(root)) : '');

function shimBody() {
  return `#!/bin/sh
# written by sub-human lib/remote/shim.js; the authorized_keys forced commands \`sub-human authorize\` writes run it.
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
function writeIfChanged(file, body, mode) {
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (cur === body) return false;
  writeFileAtomic(file, body, { mode });
  return true;
}

function refresh({ root = pluginRoot(), node = process.execPath, env = process.env } = {}) {
  root = path.resolve(root);
  if (isTempPath(root) && !allowTmpRoot(env)) return null;
  if (/\n/.test(root + node)) return null;
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  writeIfChanged(pointerPath(), `${root}\n${node}\n${cacheDirOf(root)}\n`, 0o600);
  writeIfChanged(shimPath(), shimBody(), 0o700);
  return shimPath();
}

const forcedCommand = (code, linkId, h = home()) =>
  `SUB_HUMAN_HOME=${path.resolve(h)} ${shimPath(h)} --stdio ${code} --link ${linkId}`;
const authorizedLine = (code, linkId, key, h = home()) =>
  `command="${forcedCommand(code, linkId, h)}",restrict ${key} sub-human:${code}:${linkId}`;

// What an older `authorize` wrote: command="SUB_HUMAN_HOME=<home> <node> <bin> serve --stdio CODE --link ID",restrict <key> sub-human:CODE:ID
const OLD_LINE_RE = /^command="SUB_HUMAN_HOME=(\S+) (\S+) (\S+) serve --stdio (\S+) --link ([0-9a-f]{12})",restrict (\S+ \S+) sub-human:(\S+):(\S+)$/;

function migrateLines(text, h = home()) {
  const want = path.resolve(h);
  let migrated = 0;
  const lines = String(text).split('\n').map(l => {
    const m = OLD_LINE_RE.exec(l);
    if (!m || m[1] !== want || m[4] !== m[7] || m[5] !== m[8]) return l;
    migrated++;
    return authorizedLine(m[4], m[5], m[6], want);
  });
  return { text: lines.join('\n'), migrated };
}

module.exports = {
  shimPath, pointerPath, pluginRoot, cacheDirOf, shimBody, refresh, forcedCommand, authorizedLine, migrateLines, PLAIN_PATH_RE,
};
