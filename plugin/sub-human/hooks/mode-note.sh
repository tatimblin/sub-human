# PreToolUse EnterPlanMode (hooks.json): for a seated session (its index under <home>/sessions/by-sid), notes the
# call's permission_mode in <home>/sessions/mode/SESSION, so a room review can put the mode back. Shell only, no node;
# it answers nothing (exit 0, no output). A script of its own, not an inline command: the plugin directory follows
# a hook's command only when it names a file under ${CLAUDE_PLUGIN_ROOT}.
h="${SUB_HUMAN_HOME:-$HOME/.sub-human}/sessions"; s="$CLAUDE_CODE_SESSION_ID"; case "$s" in ""|*/*|.*) cat >/dev/null; exit 0;; esac; [ -e "$h/by-sid/$s.json" ] || { cat >/dev/null; exit 0; }; m=$(tr -d '\n' | sed -n 's/.*"permission_mode": *"\([A-Za-z]*\)".*/\1/p'); [ -n "$m" ] || exit 0; umask 077; mkdir -p "$h/mode" 2>/dev/null && printf '%s\n' "$m" > "$h/mode/$s" 2>/dev/null; exit 0
