# UserPromptExpansion /sub-human (hooks.json): the join, run at once (it is the first thing a person runs). A script of
# its own, not an inline command: the plugin directory reads a hook's command only when it names one file under
# ${CLAUDE_PLUGIN_ROOT}. The rest of the plugin is beside this file (${0%/*}).
exec sh "${0%/*}/node.sh" --import "${0%/*}/compile-cache.js" "${0%/*}/run.ts" join
