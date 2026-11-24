#!/bin/sh
# Every command hook in hooks.json: `sh "${CLAUDE_PLUGIN_ROOT}/hooks/node.sh" HOOK`. The plugin directory reads a
# hook's command only when it names one plugin file, so the rest is found from here. It runs `cli.ts hook HOOK` under a
# node that strips types (22.18+, or 24.3+; 23 never): node on PATH when it does, else the newest such node where version
# and package managers install it (an IDE or the desktop app often starts claude with no nvm on PATH).
case "$0" in */*) d=${0%/*};; *) d=.;; esac
d=$(cd -P -- "$d" >/dev/null && pwd -P)
runs() {
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}; maj=${v%%.*}; r=${v#*.}; min=${r%%.*}
  case "$maj$min" in ''|*[!0-9]*) return 1;; esac
  [ "$maj" -ge 25 ] || { [ "$maj" -eq 24 ] && [ "$min" -ge 3 ]; } || { [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; }
}
n=$(command -v node 2>/dev/null)
if ! { [ -n "$n" ] && runs "$n"; }; then
  n= bmaj=0 bmin=0
  x=${XDG_DATA_HOME:-$HOME/.local/share}
  for c in /opt/homebrew/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node \
    /usr/local/bin/node /usr/local/opt/node@24/bin/node /usr/local/opt/node@22/bin/node /usr/bin/node \
    "${N_PREFIX:-/usr/local}"/bin/node "${N_PREFIX:-/usr/local}"/n/versions/node/*/bin/node \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/node "$x"/nvm/versions/node/v*/bin/node \
    "${FNM_DIR:-$x/fnm}"/node-versions/v*/installation/bin/node "$HOME"/.fnm/node-versions/v*/installation/bin/node \
    "$HOME/Library/Application Support/fnm/node-versions"/v*/installation/bin/node \
    "${MISE_DATA_DIR:-$x/mise}"/installs/node/*/bin/node \
    "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node \
    "${NODENV_ROOT:-$HOME/.nodenv}"/versions/*/bin/node \
    "${VOLTA_HOME:-$HOME/.volta}"/bin/node; do
    [ -x "$c" ] && runs "$c" || continue
    if [ -z "$n" ] || [ "$maj" -gt "$bmaj" ] || { [ "$maj" -eq "$bmaj" ] && [ "$min" -gt "$bmin" ]; }; then
      n=$c bmaj=$maj bmin=$min
    fi
  done
fi
if [ -z "$n" ]; then
  echo "sub-human: nothing ran, because it needs Node 22.18+ or 24.3+. Install one (nodejs.org, nvm, fnm or mise) and restart claude." >&2
  exit 2
fi
exec "$n" --import "$d/../resolve-ts.ts" "$d/../cli.ts" hook "$@"
