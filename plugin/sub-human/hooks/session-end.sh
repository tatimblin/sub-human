# SessionEnd (hooks.json): starts node only when this session may hold a lease or a seat (its files under
# <home>/sessions; or no session id: unsure), so a session that never joined ends with no node. The rest of the
# plugin is beside this file (${0%/*}).
h="${SUB_HUMAN_HOME:-$HOME/.sub-human}/sessions"; s="$CLAUDE_CODE_SESSION_ID"; [ -z "$s" ] || [ -e "$h/mods/$s.json" ] || [ -e "$h/by-sid/$s.json" ] || [ -e "$h/by-pid/$CLAUDE_PID.json" ] || { while IFS= read -r _; do :; done; exit 0; }; exec sh "${0%/*}/node.sh" --import "${0%/*}/compile-cache.js" "${0%/*}/run.ts" session-end
