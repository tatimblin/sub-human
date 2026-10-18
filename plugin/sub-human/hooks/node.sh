#!/bin/sh
# plugin/sub-human/hooks/node.sh: `node ARGS` with a node that runs the plugin, for every node command Claude Code
# starts (.mcp.json, hooks.json, mod/core/shim.ts shimArgv, mod/core/deliver.ts tailArgv). The plugin is TypeScript
# run by node's type stripping: 22.18 is the first node that strips with no flag and has import.meta.main (24.3 on
# 24; 23 never). A session whose PATH has no node, or an older one (an IDE, the desktop app, a shell without nvm),
# still runs the plugin; and the room's MCP server, which Claude Code skips in every session on the machine for 15
# minutes after one failed start (cc CONTRACT mcp-failure-cache), does not fail for want of node.
# Order:
#   1. SUB_HUMAN_NODE, a node the person names (in their shell, or their own settings' env), used as given
#   2. the node the plugin last ran with (<home>/bin/current, line 2, which lib/remote/shim.ts refresh records:
#      process.execPath of a run of the plugin, so no version check; a removed version fails -x and is passed over)
#   3. node on PATH, if it runs the plugin
#   4. the newest that does among the places version and package managers install it, each by its own folder
#      variable where it has one (SUB_HUMAN_NODE_ROOT: the tests' stand-in for /)
# None: what to do on stderr, exit 2 (the /sub-human expansion shows it).
ok() {
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}; maj=${v%%.*}; r=${v#*.}; min=${r%%.*}; pat=${r#*.}; pat=${pat%%[!0-9]*}
  case "$maj" in ''|*[!0-9]*) return 1;; esac
  case "$min" in ''|*[!0-9]*) return 1;; esac
  case "$pat" in ''|*[!0-9]*) pat=0;; esac
  # 22.18+, 24.3+, 25 on (23 never had import.meta.main; 24.0-24.2 warn): lib/cli/doctor.ts nodeRuns
  [ "$maj" -ge 25 ] || { [ "$maj" -eq 24 ] && [ "$min" -ge 3 ]; } || { [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; }
}
[ -n "${SUB_HUMAN_NODE:-}" ] && exec "$SUB_HUMAN_NODE" "$@"
cur="${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/current"
n=
[ -f "$cur" ] && { read -r _ || :; read -r n || :; } < "$cur"
case "$n" in /*) [ -x "$n" ] && exec "$n" "$@";; esac
p=$(command -v node 2>/dev/null)
[ -n "$p" ] && ok "$p" && exec "$p" "$@"
R=${SUB_HUMAN_NODE_ROOT:-}
D=${XDG_DATA_HOME:-$HOME/.local/share}
best= bmaj=0 bmin=0 bpat=0
for c in \
  "$R"/opt/homebrew/bin/node "$R"/opt/homebrew/opt/node@24/bin/node "$R"/opt/homebrew/opt/node@22/bin/node \
  "$R"/usr/local/bin/node "$R"/usr/local/opt/node@24/bin/node "$R"/usr/local/opt/node@22/bin/node \
  "${N_PREFIX:-$R/usr/local}"/bin/node \
  "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node "${XDG_CONFIG_HOME:-$HOME/.config}"/nvm/versions/node/v*/bin/node \
  "${FNM_DIR:-$D/fnm}"/node-versions/v*/installation/bin/node "$HOME"/.fnm/node-versions/v*/installation/bin/node \
  "$HOME/Library/Application Support/fnm/node-versions"/v*/installation/bin/node \
  "${MISE_DATA_DIR:-$D/mise}"/installs/node/*/bin/node "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node \
  "${VOLTA_HOME:-$HOME/.volta}"/bin/node "${NODENV_ROOT:-$HOME/.nodenv}"/versions/*/bin/node \
  "$R"/home/linuxbrew/.linuxbrew/bin/node "$HOME"/.nix-profile/bin/node "$R"/run/current-system/sw/bin/node \
  "$R"/snap/bin/node "$R"/opt/local/bin/node "$R"/usr/bin/node; do
  [ -x "$c" ] && ok "$c" || continue
  if [ -z "$best" ] || [ "$maj" -gt "$bmaj" ] || { [ "$maj" -eq "$bmaj" ] && { [ "$min" -gt "$bmin" ] || { [ "$min" -eq "$bmin" ] && [ "$pat" -gt "$bpat" ]; }; }; }; then
    best=$c bmaj=$maj bmin=$min bpat=$pat
  fi
done
[ -n "$best" ] && exec "$best" "$@"
f='none (node: command not found)'
[ -n "$p" ] && f="node $("$p" -v 2>/dev/null) at $p"
echo "sub-human needs Node 22.18+ or 24.3+ (not 23), and found $f. Install it (https://nodejs.org, or nvm, fnm or mise) and restart claude, or name one in SUB_HUMAN_NODE." >&2
exit 2
