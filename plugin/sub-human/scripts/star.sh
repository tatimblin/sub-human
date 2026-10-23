# star.sh: stars tatimblin/sub-human with gh, when gh is installed and logged in (the person picked "Star on GitHub" on
# the leave card, mod/core/leave.ts). 127 without gh; any other failure is gh's exit. The caller then opens the page.
command -v gh >/dev/null 2>&1 || exit 127
exec gh api --method PUT /user/starred/tatimblin/sub-human --silent >/dev/null 2>&1
