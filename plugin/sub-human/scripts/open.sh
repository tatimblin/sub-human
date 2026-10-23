# open.sh NAME: the URL on stdin to one browser opener (mod/core/leave.ts openCommands names them in the order to try).
# Only this plugin's own GitHub pages are opened. 127 when the opener is not there (open off macOS: Linux has an
# unrelated `open`), so the next is tried; its output is dropped.
read -r url || [ -n "$url" ] || exit 2
case "$url" in
  https://github.com/tatimblin/sub-human|https://github.com/tatimblin/sub-human/*) ;;
  *) exit 2 ;;
esac
case "$1" in
  open) [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1 || exit 127; exec open "$url" >/dev/null 2>&1 ;;
  wslview) command -v wslview >/dev/null 2>&1 || exit 127; exec wslview "$url" >/dev/null 2>&1 ;;
  xdg-open) command -v xdg-open >/dev/null 2>&1 || exit 127; exec xdg-open "$url" >/dev/null 2>&1 ;;
  *) exit 2 ;;
esac
