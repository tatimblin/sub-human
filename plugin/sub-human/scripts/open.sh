# open.sh NAME: the URL on stdin to one browser opener (mod/core/leave.ts openCommands names them in the order to try).
# Only this plugin's own GitHub pages are opened (no "..", which a browser would resolve elsewhere). 127 when the opener
# is not there (open off macOS: Linux has an unrelated `open`), so the next is tried; its output is dropped. xdg-open
# may wait for the browser it starts, so it is left running on its own and the run ends at once.
read -r url || [ -n "$url" ] || exit 2
case "$url" in
  *..*) exit 2 ;;
  https://github.com/tatimblin/sub-human|https://github.com/tatimblin/sub-human/*) ;;
  *) exit 2 ;;
esac
case "$1" in
  open) [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1 || exit 127; exec open "$url" >/dev/null 2>&1 ;;
  wslview) command -v wslview >/dev/null 2>&1 || exit 127; exec wslview "$url" >/dev/null 2>&1 ;;
  xdg-open) command -v xdg-open >/dev/null 2>&1 || exit 127; xdg-open "$url" </dev/null >/dev/null 2>&1 & exit 0 ;;
  *) exit 2 ;;
esac
