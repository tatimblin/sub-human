# sub-human

A Claude Code plugin: several people each work in their own session while what each session learns, decides and
changes reaches the others, and their Claudes, as it happens (live, zero-effort sharing of the work, not a chat). A
room's host machine holds its log; others mirror it over Tailscale (Funnel or Serve) or ssh. 1.0.0 rebuilds the 0.8
proof of concept. User docs: `plugin/sub-human/README.md`.

## Design

- `docs/PRD.md`: requirements (R…), decisions (Q…), success metrics. `docs/ARCHITECTURE.md`: principles (§2),
  dependencies (§2a), layout (§3), data model, the daemon (§5), flows, network, Claude Code surfaces (§9), knobs
  (§10), size budget (§11). `docs/TESTING.md`: layers, the kit pattern, fixtures, the live gate, the requirements
  trace (§12). `docs/internals/`: Claude Code notes (`v2-risks.md`); `docs/archive/`: the 0.8 architecture.

## Layout

- `plugin/sub-human/`: ESM `.ts` run by node 22.18+ or 24.3+ type stripping, no build.
  - `core/` pure rules: entries and schemas, fold, deliver (relevance, wakes, the command/URL rule), plans, tasks,
    activity and the secret filter, brief, the link engine, protocol, the daemon's API (`api.ts`), `result.ts` (the
    one `Result`), `cc/contract.json` (every Claude Code fact relied on).
  - `store/` the `RoomStore` seam: `fs-store.ts` (host), `mirror-store.ts` (a room hosted elsewhere),
    `memory-store.ts` (tests), `lock.ts`, `atomic.ts`.
  - `module/` the hooks module (`register.ts` wires the parts): capture, follow, context, status and news, messages,
    wake, plans (author, review, cards, pending, notes), tasks (tool and native bridge), tools, admit (Let in cards),
    band (the invite row while alone),
    `bridge.ts` (the daemon's socket), `session.ts` (the parts' shared plain data).
  - `commands/` one file per `/room` verb, `hooks.ts` the four command hooks of `hooks/hooks.json`.
  - `net/` the daemon only: `daemon.ts` and `daemon/` (rooms, pointers, the net ops, client), `channel.ts` (Noise
    XK), `pathways/` (tailscale, ssh, pipe), `host.ts`, `link.ts`, `invite.ts`, `proxy-v2.ts`.
  - top level: `cli.ts` (the one node entry; `hooks/node.sh` finds node), `keys.ts`, `home.ts`, `config.ts`,
    `resolve-ts.ts`. `vendor/`: committed ESM builds of valibot, ignore, diff and ws, with `VENDOR.json`.
  - tests beside the code; `test/` holds scenes, net tests, fixtures (`fixtures/cc/2.1.330`) and `support/`.
- `scripts/`: lint, ratchet, directory-lint, budget, trace, probe, canary, typings, vendor, record-fixtures, version
  check, the kit runner; their tests in `scripts/test/*.test.ts`. `typings/`: Claude Code's declarations (2.1.330).

## Commands

- `npm test`: `test:offline` (typecheck, `vendor.ts --check`, `test:node`, `test:scripts`), then `test:module` and
  `validate`. CI runs `test:offline` on every node, the rest against the pinned Claude Code.
- `npm run test:node` (`*.node-test.ts`), `npm run test:scripts`, `npm run test:module` (kit tests, `*.test.ts`,
  through `claude plugin test`; modules off is a failure, never a skip). One file:
  `node --test --import ./plugin/sub-human/resolve-ts.ts --import ./plugin/sub-human/test/helpers.ts FILE`.
- `npm run typecheck`: the plugin, the runtime alone (`isolatedDeclarations`), the scripts.
- `npm run lint`: oxlint type-aware, the type-escape ratchet (`node scripts/ts-ratchet.ts --update` lowers it), then
  `scripts/directory-lint.ts`. `scripts/lint.ts` kills tsgolint above 4 GB (`SUB_HUMAN_LINT_CAP_MB`).
- `npm run validate`, `npm run probe`, `npm run canary -- latest`, `npm run typings`, `npm run vendor [-- --check]`.
  Run at most 2 test processes at once.
- `node scripts/budget.ts [--final]` (ARCHITECTURE §11; `--final`: tests ≤ 1.2 × runtime, `test/support/` apart), `node scripts/trace.ts
  [--check]` (TESTING §12, from `R…` tags in test names), `node scripts/check-version.ts [BASE]`.

## Conventions

- Plugin files import each other as `./x.js`, never `./x.ts` (validate refuses `.ts`; directory-lint rule 6). Every
  node process that loads plugin code starts with `--import plugin/sub-human/resolve-ts.ts`. Scripts import their own
  files as `.ts`.
- **Every write goes through the daemon**: one detached node process per home on `<home>/daemon.sock`, reached by
  `$.http.fetch({socketPath})`. The module only reads (`$.fs`, the log by ranges, 4 MiB per read). Command hooks
  write through the same socket. A refused fetch or spawn is one line, never a fallback.
- **A `$` never crosses a function or file boundary**: Claude Code refuses a module whose `$` is passed to a helper.
  Edges call `$` in the hook body and hand plain data to `core/`; module parts share `module/session.ts`.
- **Hook matchers**: an event registered twice in the module needs a matcher on each (e.g. `session.start` with
  `{ isInteractive: true }`); a second unmatched registration doesn't load. A `session.send` hook must never throw.
- One `Result<T>` (`core/result.ts`); valibot at every boundary; no `any`, no unchecked `as`, no `!` in runtime.
- Tests: node tests `*.node-test.ts`, kit tests `*.test.ts`; narrow with `assert.ok` or `must()`; temp homes only. A
  test that covers a requirement names it, `… (R12)`. Never delete or weaken a test to fit a budget.
- The `claude` on PATH may be old: scripts use the pinned one (`scripts/lib/claude-bin.ts`, contract `probed`).

## Design rules

- **Never pin a model**: not in agents, spawns, tests or scripts.
- **No writes to user settings files** (`settings.json`, `settings.local.json`) and no symlinks into `~/.claude`.
- **Never touch `~/.sub-human` or live tmux sessions** unless asked. Tests use temp homes.
- **Local git only**: no pushes and no PRs unless asked. Bump `version` in plugin.json with every plugin change.
- **Every Claude Code fact goes in the contract** (`core/cc/contract.json`), marked API or internal; internal
  entries stay at 10 or fewer, each with a reason, a fallback and a probe.
- **Quiet**: one line per event a person needs, in plain words, `sub-human:` the one speaker; receipts and retries go
  to the debug log. Node hooks write nothing to stderr on success.
- **The person keeps every permission decision**: no hook ever answers a permission check with allow.
- **Names are the glossary** (room, code, host, member, invite, update, plan, version, agree, task); engineering
  names (mirror, link, pathway, listener) never appear in copy; no POC nicknames (row, keeper, seat, lane, walk).
- **Small**: pure core, thin edges (about 150 lines each), one way to do each thing, the ARCHITECTURE §11 caps.
