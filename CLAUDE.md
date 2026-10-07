# sub-human

A Claude Code plugin for working together from separate sessions on one machine. People join a room with `/sub-human NAME`. `@room` posts their exact words. Claudes talk natively (`SendMessage`, addressed `NAME.CODE`). A headless orch (a `claude --bg` job) keeps the shared task list and helps plan only when asked. User-facing docs: `plugin/sub-human/README.md`.

How it works (processes, store layout, lanes, consent, tasks, the cc contract): `docs/ARCHITECTURE.md`. Its tables are generated: run `npm run docs` after changing hooks.json, MCP tools, `lib/cc.js` CONTRACT or a lib header.

## Layout

- `plugin/sub-human/`: the plugin. `hooks/` (hooks.json + one script per hook, and `register.mjs`, the hooks module's entry; `prompt.js` runs every UserPromptSubmit handler in one process, through the module), `lib/` (`room/` log store, validation, lanes and rendering behind `room.js`; `consent.js` the one proposal fold; `tail.js` the room tail the hooks module runs; `home.js` store location; identity, `lock.js`, `io.js`, `config.js` timings, orch spawn/reap/watchdog, rows, tasks, proposals, `cc.js` internals), `mcp/` (room server, hold, task tool), `agents/` (orchestrator, room row, participant), `mod/` (the hooks module: guard, prompt gate, shims, delivery; `mod/core` pure, `mod/test` wiring tests), `bin/sub-human` (CLI and the tail), `skills/`, `statusline/`, `test/` (`test/support/memory-store.js` + `store-contract.test.js` keep the RoomStore seam honest).
- `scripts/`: demo and evidence tools. `demo.sh` drives the walkthrough in tmux, `demo-lib.js` holds its tmux and log helpers, `snap.js` captures panes, `checks.js` + `checks/*.js` hold the per-scene checks, `metrics.js` the run metrics, and `walkthrough.js` builds the HTML. `baselines.json` holds earlier runs, thresholds and prices. `lib/` has shared helpers: `paths.js` is the only place scripts import plugin paths. `probe-cc.js` checks the internals list. The tests are in `scripts/test/`.
- `demo/app.pristine/`: the small app each demo seat gets a copy of.
- `docs/rebuild/`: the latest walkthrough (`walkthrough.html`, `checks.json`). `screens/` is generated and gitignored.
- `docs/internals/`: Claude Code internals we rely on, per version. `docs/next/AUDIT-PLAN.md`: the current work plan. `docs/archive/`: history (index in its README).

## Commands

- `npm test`: plugin tests and script tests (`node --test`, no dependencies).
- `npm run validate`: `claude plugin validate plugin/sub-human --strict`.
- `npm run probe`: check every Claude Code internal listed in `lib/cc.js` against the installed binary.
- `node --test scripts/test` runs only the script tests. `bash -n scripts/demo.sh` checks the demo's syntax.

## Demo

`scripts/demo.sh` runs scenes S1–S10 live, with real Claude sessions and real cost. It uses detached tmux sessions `sh-alice`, `sh-bob` and `sh-orch` (`claude logs` of the orch job). The home is `SUB_HUMAN_HOME=/tmp/sh-demo/home`, and the seats run in `/tmp/sh-demo/SEAT`.

```
scripts/demo.sh [--windows] [--pause] [--only S6[,S7]] [--from S6] [--to S3] [--member-model MODEL] [--no-reset]
scripts/demo.sh stop                  # kill the sh-* tmux sessions
node scripts/checks.js && node scripts/walkthrough.js
```

- A short run: `--only S1,S2,S4,S5,S9,S9b,S10` (a set with S1 starts fresh). `checks.js` skips the scenes not run (`screens/run.json`).
- A timed-out `need` wait aborts the scene. The run stops and says how to resume with `--from SCENE`.
- `checks.js` exits 1 only when a **deterministic** check fails (log, chain, files, panes).
- **Behavioural** checks (model-call counts, wakes, noise) are compared against `baselines.json` thresholds and only warn.
- Never run the demo or touch `~/.sub-human` or live tmux sessions unless asked.

## Design rules

- **Never pin a model.** Not in agents, the orch spawn, the demo or tests. The user's default applies, and `--member-model` is opt-in.
- **No writes to user settings files** (`settings.json`, `settings.local.json`) and no symlinks into `~/.claude`. The plugin uses its own home and the native task list.
- **The orch takes no typed input.** A typed prompt is refused with a hint. People reach it with `@room @orch …` or through their Claude.
- **Keep the agent-panel rows.** A member's panel shows the room row with the members inside it. The orch's panel lists every human.
- **Consent is native.** A proposal opens in the plan view, with the question card as fallback. Only the human's answer there (`via=human`) records agreement.
- **Unprescriptive.** Planning is optional, there is no required workflow, and the injected text covers mechanics only and stays small.
- **Internals are allowed if listed.** Each undocumented Claude Code behaviour goes in `lib/cc.js` with the binary search string that proves it, and `npm run probe` verifies them. Notes go in `docs/internals/`.
- **Local git only.** No pushes and no remote PRs unless asked.
