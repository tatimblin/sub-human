# clip.sh NAME: the invite line on stdin to one clipboard tool (mod/core/copy.ts clipboardCommands names them in the
# order to try). 127 when the tool is not installed, so the next is tried; its output is dropped, so a tool that forks
# to keep the selection (xclip, wl-copy) does not hold the run open. The line is never in the argv.
case "$1" in
  pbcopy) command -v pbcopy >/dev/null 2>&1 || exit 127; exec pbcopy >/dev/null 2>&1 ;;
  wl-copy) command -v wl-copy >/dev/null 2>&1 || exit 127; exec wl-copy >/dev/null 2>&1 ;;
  xclip) command -v xclip >/dev/null 2>&1 || exit 127; exec xclip -selection clipboard >/dev/null 2>&1 ;;
  clip.exe) command -v clip.exe >/dev/null 2>&1 || exit 127; exec clip.exe >/dev/null 2>&1 ;;
  *) exit 2 ;;
esac
