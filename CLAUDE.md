# sub-human

A Claude Code plugin. sub-human lets several people each work in their own Claude Code session (their own terminal,
repo, login and Claude) while what each session learns, decides and changes reaches the others, and their Claudes, as
it happens: live, zero-effort sharing of the work itself, not another chat. A room has one host machine that holds its
log; other machines mirror it over Tailscale or ssh. v2 is a rebuild from the 0.8 proof of concept, in progress.

## Design

- `docs/PRD.md`: requirements (R…), decisions (Q…), success metrics.
- `docs/ARCHITECTURE.md`: code principles (§2), dependencies (§2a), layout (§3), data model, flows, network,
  Claude Code surfaces, configuration (§10), size budget (§11), build order.
- `docs/TESTING.md`: test layers, the test kit pattern, fixtures, the live gate, tests per milestone.
- `docs/archive/` holds the 0.8 architecture; `docs/internals/` notes on Claude Code internals.

## Layout

This is ARCHITECTURE §3's plan: the directories exist, empty, and the build units fill them.

- `plugin/sub-human/`: the plugin, ESM `.ts` run by node 22.18+ type stripping (no build). Plugin files import each
  other as `./x.js` (validate refuses `.ts` paths); every node process loading plugin code starts with
  `node --import plugin/sub-human/resolve-ts.mjs`, which finds the `.ts` (directory-lint rule 6).
  - `core/` (coming) pure rules (folds, delivery, plans, tasks, the link state machine); no I/O, relative imports
    only. The Claude Code contract will be `core/cc/contract.json`.
  - `store/` (coming) the room store interface and its fs, mirror and memory backends.
  - `module/` (coming) the hooks module (Claude Code edge): capture, delivery, status, plans, Claude's tools.
  - `commands/` (coming) one small file per `/sub-human` verb.
  - `net/` (coming) node children only: the Noise channel, `pathways/` (tailscale, ssh, pipe), host, link, invite.
  - `vendor/` committed ESM builds of the dependencies, with `VENDOR.json`; not linted or typechecked.
  - top-level `keys.ts`, `home.ts`, `config.ts` (coming).
- `scripts/`: repo tooling (lint, ratchet, directory-lint, probe, canary, typings, version check, kit test runner),
  tests in `scripts/test/*.test.ts`.
- `typings/`: the committed snapshot of Claude Code's declarations (`npm run typings` refreshes it).

## Commands

- `npm test`: typecheck, `test:node`, `test:scripts`, `test:module`.
- `npm run test:node`: node tests, `plugin/sub-human/**/*.node-test.ts`.
- `npm run test:scripts`: `scripts/test/**/*.test.ts`.
- `npm run test:module`: kit tests (`*.test.ts` under the plugin) through `claude plugin test`; hooks modules off is a
  failure, never a skip.
- `npm run typecheck`: the whole plugin, the runtime alone (`isolatedDeclarations`), then the scripts.
- `npm run lint`: oxlint with type-aware rules, the type-escape ratchet (`scripts/ts-ratchet.json`; counts only go
  down, `node scripts/ts-ratchet.ts --update` lowers them), then `scripts/directory-lint.ts`.
- `npm run validate`: `claude plugin validate plugin/sub-human --strict`.
- `npm run canary`, `npm run typings`. `npm run probe` exits 2 until the contract exists; `npm run vendor` and
  `npm run budget` check `vendor/VENDOR.json` and the ARCHITECTURE §11 line caps.
- `node scripts/check-version.ts [BASE]`: plugin files changed without a newer `version` in plugin.json fails.

## Design rules

- **Never pin a model**: not in agents, spawns, tests or scripts.
- **No writes to user settings files** (`settings.json`, `settings.local.json`) and no symlinks into `~/.claude`.
- **Never touch `~/.sub-human` or live tmux sessions** unless asked. Tests use temp homes.
- **Local git only**: no pushes and no PRs unless asked.
- **Every Claude Code fact goes in the contract** (`core/cc/contract.json`, coming), marked API or internal;
  internal entries stay at 10 or fewer.
- **Quiet**: one line per event a person needs, in plain words; receipts and retries go to the debug log. Node hooks
  write nothing to stderr on success.
- **The person keeps every permission decision**: no hook ever answers a permission check with allow.
- **Tests**: node tests are `*.node-test.ts`, kit tests `*.test.ts`; narrow with `assert.ok`, never `!`.
- **Names are the glossary** (room, code, host, member, invite, update, plan, version, agree, task).
