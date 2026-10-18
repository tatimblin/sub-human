#!/bin/sh
# plugin/sub-human/hooks/node.sh: `node ARGS` with a node that runs the plugin, for every node command Claude Code
# starts (.mcp.json, hooks.json, mod/core/shim.ts shimArgv). The plugin is TypeScript run by node's type stripping:
# 22.18 is the first node that strips with no flag and has import.meta.main (24.3 on 24; 23 never). A session whose PATH has no node, or an
# older one (an IDE, the desktop app, a shell without nvm), still runs the plugin; and the room's MCP server, which
# Claude Code skips in every session on the machine for 15 minutes after one failed start (cc CONTRACT
# mcp-failure-cache), does not fail for want of node.
# Order: the node the plugin last ran with (<home>/bin/current, line 2, which lib/remote/shim.ts refresh records:
# process.execPath of a run of the plugin, so no version check), node on PATH, then the usual install places
# (SUB_HUMAN_NODE_ROOT: the tests' stand-in for /).
ok() {
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}; maj=${v%%.*}; r=${v#*.}; min=${r%%.*}
  case "$maj" in ''|*[!0-9]*) return 1;; esac
  case "$min" in ''|*[!0-9]*) return 1;; esac
  # 22.18+, 24.3+, 25 on (23 never had import.meta.main; 24.0-24.2 warn): lib/cli/doctor.ts nodeRuns
  [ "$maj" -ge 25 ] || { [ "$maj" -eq 24 ] && [ "$min" -ge 3 ]; } || { [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; }
}
cur="${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/current"
n=
[ -f "$cur" ] && { read -r _ || :; read -r n || :; } < "$cur"
case "$n" in /*) [ -x "$n" ] && exec "$n" "$@";; esac
p=$(command -v node 2>/dev/null)
[ -n "$p" ] && ok "$p" && exec "$p" "$@"
R=${SUB_HUMAN_NODE_ROOT:-}
for c in "$R"/opt/homebrew/bin/node "$R"/usr/local/bin/node "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node \
  "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node \
  "$HOME/Library/Application Support/fnm/node-versions"/v*/installation/bin/node \
  "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node \
  "$HOME"/.volta/bin/node "$R"/usr/bin/node; do
  [ -x "$c" ] && ok "$c" && exec "$c" "$@"
done
f='none (node: command not found)'
[ -n "$p" ] && f="node $("$p" -v 2>/dev/null) at $p"
echo "sub-human needs Node 22.18+ or 24.3+ (not 23), and found $f. Install it (https://nodejs.org, or nvm, fnm or mise) and restart claude." >&2
exit 2
