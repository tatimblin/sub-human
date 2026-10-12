# sub-human trailer

Remotion compositions that replay a real demo take: captured terminal frames (`tmux capture-pane -ep`), cut and
re-timed by an edit decision list, with captions, callouts, camera moves and an end card. Self-contained: its own
`package.json` and lockfile; nothing here is part of the plugin.

## Render a take

```
npm ci
npx remotion render Trailer --props='{"take":"<take-id>"}'
```

`<take-id>` is a folder under `capture/` holding `capture.jsonl` or `capture.jsonl.gz`, the take that
`scripts/demo.sh --film --take <take-id>` records: `meta`, `frame` and `marker` lines. The default is `take5`, a real
run of the whole story the cuts are timed to; `take4` is the one before it; `synthetic` is a generated one for
development. The MP4 lands in `out/`.

The compositions follow `STORYBOARD.md` (v2): `Trailer` (1920×1080, ~68 s), `TrailerSquare` (1080×1080, the same cut
stacked), `Social15` (1080×1350, 15 s) and `ReadmeLoop` (1280×720, ~9 s, loops; no captions). Same `--props`.
The README GIF: `ffmpeg -i out/ReadmeLoop-take5.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" out/ReadmeLoop-take5.gif`.
The take4-era cuts are still there as `edit: "trailer-v1"` and `"readme-v1"`. `npm run dev` opens Remotion Studio.

Props (all optional): `take`, `edit` (`trailer`, `social`, `readme`, `trailer-v1`, `readme-v1`), `music` (a URL or a path under `public/`, faded in and out), `musicVolume`,
`keyClicks` (a soft click per typed key; off), `scrubWords` (extra words to replace: a username, a hostname),
`dropRows` (screen rows to remove, by text), `compact` (stacked panes drop blank rows; on for `ReadmeLoop`),
`seats` (default `["alice","bob"]`).

## How it works

- `src/lib/capture.ts` loads a take (`public/capture` links to `capture/`); `src/lib/scrub.ts` scrubs every frame (`/tmp/sh-demo/<seat>`
  → `~/app`, `/Users/<name>` and `/home/<name>` → `~`, `user@host.local` → `you@devbox`, `*.local` → `devbox`,
  the banner's model and plan, a model name in a commit trailer, a Claude's scratchpad path, plus `scrubWords`; the
  room code stays). It blanks rows in place: the login-expiry warning, Claude Code's tips, and the `/` and `@`
  completion menus (they list the machine's own skills, MCP servers and other sessions), and clears the prompt's
  dim suggestion (it reads as typed text). It drops the update nag,
  and answers "session S's screen at time t" (its latest frame with `t' <= t`).
- `src/lib/ansi.ts` is a port of `../scripts/ansi-svg.js` (same palette, cell widths and SGR handling).
  `npm run check:ansi [capture.jsonl | screen.ansi …]` proves the two read every screen identically.
- `src/components/Terminal.tsx` draws a screen on a fixed cell grid in bundled JetBrains Mono, with Noto Sans
  Symbols for the glyphs it lacks (⏺ ⎿ ⏵ ✻ …). Runs that might not advance one cell are pinned to their cells.
- `src/edits/trailer.ts`, `social.ts` and `readme.ts` are the v2 cuts: ordered segments `[from, to)` keyed off
  markers (`"plan"`, `"proposal+2s"`) or "the first frame where a pane shows X". Each plays at `speed`, is squeezed
  to `fit` seconds, or (`hold`) freezes a frame. Model time is marked `model`, and only there does the clock badge
  show. A segment names its caption, each pane's own camera (`views`: `zoom`, `find` a row, or `anchor` to the
  bottom bar), the pane it is about (`focus`), `marks` (a box round some rows, in a person's colour, with a label)
  and `tags`: a message crossing between panes, flown as a card in the sender's colour from one row to another,
  landing when the receiving pane shows it (`arrive`). `src/components/SplitReplay.tsx` draws them: both panes always
  on screen, zooming within their halves, with name plates and the room's Claude's plate between them
  (`design.ts` `PEOPLE`: one name and one colour each). `src/edits/v1/` holds the take4-era cuts (one stage camera,
  `components/Replay.tsx`).

The cuts use the beats `demo.sh --film` marks: `open`, `join`, `panel`, `talk`, `reply`, `claudes`, `plan`, `proposal`,
`answers`, `revision`, `agreed`, `split`, `build`, `subagent`, `claimed`, `handler`, `tested`, `tests` and `pass`
(`subagent` lands when the row shows, so it can come before `claimed`). Inside a beat
they anchor on what a pane shows: demo.sh's own waits (`alice: bob, can you take the parser tests`,
`must 400, not 500`) and Claude Code's lines (`You've joined room`, `☐ Consent`, `Write(test/`, `ℹ pass`). Typed
input sits after `❯` and a no-break space, so anchor on the typed text itself (`@ro`, `ask al`), not on `❯ `. If a take lacks a segment's anchors, the segment is skipped with an `[edl]` warning. The
resolved cut prints as a `[cut]` line, with each segment's start frame and speed, whenever a composition is
measured:

```
npx remotion compositions --log=verbose | grep '\[cut\]'
```

## Checking a take

```
npm run stills -- --take <take-id>                  # out/stills/: ~70% into every segment, the end card
npm run stills -- --comp Social15,ReadmeLoop --only ask-fly,plan-open,end --at 0.3,0.8
npm run stills -- --frames 600,756                  # exact frames (a tag in flight)
npx remotion still Trailer out/f.png --frame=1048   # one frame
node scripts/prescrub.mjs --take <take-id>          # write the pre-scrubbed capture.jsonl.gz, audit what is left
npm run lint
```

`prescrub.mjs` bundles `src/lib/scrub.ts` (the loader's scrub, without Remotion) and checks every distinct screen
line for a home path, the account's name, an email, the model or plan, a login warning, the machine's skills, MCP
servers or sessions; it exits 1 on a hit. `--audit` only checks; `--lines` prints every line to read through.

## Files

- `capture/take5/` is the take the cuts are timed to (2026-10-11, Claude Code 2.1.292, 120×36 seats; it adds the
  agent-panel beats `panel` and `subagent`), `capture/take4/` the one before. Git keeps `capture.jsonl.gz` +
  `run.json` only (`git add -f`; `capture/*` is ignored), and that gzip is pre-scrubbed (`scripts/prescrub.mjs`):
  every frame already went through the loader's scrub and row blanking, so no home path, account or skill list is
  in git. The raw `capture.jsonl` stays local; the loader prefers it when present and renders the same.
- `capture/synthetic/` is generated by `npm run fixture` (`scripts/make-fixture.mjs`) and gzipped (the 3.7 MB of
  screens compress to 40 KB). It follows demo.sh's story and beats and imitates Claude Code 2.1.292's screens,
  with colours taken from real captures. The plan view is approximate. It includes a home path and a `user@host`
  so the scrub step has something to remove. `capture/fixture/` is the capture tooling's small hand-made
  sample.
- `public/sfx/key-click.wav` is synthesised by `npm run sfx`.
- `src/fonts/`: JetBrains Mono, Inter and Noto Sans Symbols/Symbols 2/Math, all SIL OFL 1.1 (licences alongside).
  The Noto and Inter files are subsets: `pyftsubset <font> --unicodes=… --flavor=woff2`; the ranges are in
  `src/fonts/fonts.ts`'s header.
- `.claude/skills/remotion-best-practices` holds Remotion's agent skills (`npx skills add remotion-dev/skills`;
  `skills-lock.json` pins them).
