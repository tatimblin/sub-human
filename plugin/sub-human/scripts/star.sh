# star.sh: stars tatimblin/sub-human with gh, when gh is installed and logged in (the person picked "★ Star sub-human"
# on the leave card, mod/core/leave.ts). 127 without gh; any other failure is gh's exit. The caller then opens the page.
# `star.sh check`: exit 0 when the person starred it already (the card then never shows again), else gh's exit.
command -v gh >/dev/null 2>&1 || exit 127
if [ "${1:-}" = check ]; then exec gh api /user/starred/tatimblin/sub-human --silent >/dev/null 2>&1; fi
exec gh api --method PUT /user/starred/tatimblin/sub-human --silent >/dev/null 2>&1
