# A command hook's stdin, kept as ../log/hook-EVENT-PID.json beside the plugin's copy. It answers nothing.
dir="${CLAUDE_PLUGIN_ROOT}/../log"
mkdir -p "$dir"
cat > "$dir/hook-$1-$$.json"
