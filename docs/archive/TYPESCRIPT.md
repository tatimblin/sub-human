# TypeScript migration plan

Status: **done**, 0.5.0-beta.8 (2026-10-10). Sources: three read-only research passes the same day: Node's type
stripping, the codebase inventory, and TypeScript in Claude Code plugins.

## Outcome

- Phases A, B (six slices) and C are merged. Strict `tsc` went from 4079 errors after A to 0, with `noUnusedLocals`
  on; it runs first in `npm test` and fails CI (Node 24.3.0, 24, 26).
- The types found three bugs: a hold refusal was not marked `isError`; a join or resume crashed when `machine.json`
  could not be read; a log lock timeout lost its message.
- Latency: with the compile-cache preload (`hooks/compile-cache.js`) a hook starts within about 5 ms of the JS build
  (the prompt hook, 36 → 41 ms median); without it, about 50 ms more.
- Still JavaScript: `scripts/sub-human` (frozen path, and node strips nothing in an extensionless file),
  `hooks/compile-cache.js` (a preload that must strip nothing), `lib/vendor/noble` (hash-pinned), and the tests and repo
  scripts (the unchanged safety net).
- Follow-ups: convert the tests to TypeScript; `lib/proposal.ts` `shape()` drops the entry's title; `promote` with an
  unreadable machine id.

## What "TypeScript" means for this plugin

There is no build step, and none will be added. Users install the plugin from git, so what is in git is what runs.
Committing compiled JS would double every change and every review. Two runtimes run the plugin's code, and both can
run `.ts` files directly:

| Code | Runtime | `.ts` support |
|---|---|---|
| Hooks, the MCP server, the CLI, the statusline, `lib/` | `node` (24 or newer) | Node strips the types when it loads the file. Only erasable syntax works, and every import must spell out its `.ts` extension. |
| The hooks module (`mod/`) and its tests (`mod/test/*.test.ts`) | Claude Code's own Bun worker | It transpiles the files fully. The docs say any module file may be `.ts`, and the official mods ship `register.ts`. |

Neither runtime checks the types. Only `tsc --noEmit` in `npm test` and in CI does. It is installed as a
**devDependency of the repo root**, never of `plugin/sub-human`. A plugin-root `package.json` with a lockfile makes
Claude Code run `npm install` on every user's machine.

`require()` of a `.ts` file gives an untyped (`any`) result. Typed imports therefore mean the Node code becomes ESM.

## Decisions

1. **Runtime code becomes ESM `.ts`.** This covers `lib/**` (except `vendor/`), `hooks/*`, `mcp/*`, `statusline/*` and
   `mod/**`, and gives `mod/register.ts`.
   - `plugin/sub-human/package.json` is `{"type":"module","private":true}`, with no dependencies and no lockfile.
   - Imports and exports are named only, with no default export. `require(esm)` from the remaining CommonJS (the tests and
     repo `scripts/`) then sees the same shape as before.
2. **Erasable syntax only** (`erasableSyntaxOnly`). Not allowed: `enum`, `namespace`, parameter properties, decorators,
   `import =` and `<T>x` casts. Imports spell out `.ts` (`allowImportingTsExtensions`), and type-only imports use
   `import type` (`verbatimModuleSyntax`).
3. **Node ≥ 24.3.**
   - 24.0 to 24.2 print an ExperimentalWarning on every `.ts` run, and hooks' stderr reaches users.
   - `engines`, the `hooks.json` node check (it checks the version now, not just presence), `doctor`, the README and CI all
     move to ≥ 24.3.
4. **Frozen paths stay JS.**
   - `scripts/sub-human` is an extensionless shebang file. Node does not strip types there, and every persisted artifact
     (the `bin/serve` shim, `authorized_keys` lines, the row launcher, daemons) reaches plugin code through that path.
     It becomes a thin JS shim that imports `lib/cli/main.ts`.
   - `lib/vendor/noble` stays as is (hash-pinned ESM).
5. **Hook latency.** Each `.ts` hook costs about 35 ms more to start without a compile cache. The hook entries turn on
   `module.enableCompileCache()` before loading their code; measure before and after.
6. **Tests stay JavaScript for this migration.** An unchanged test suite is the safety net. Tests stay CommonJS:
   - `test/package.json` and `mod/test` are `{"type":"commonjs"}` where needed.
   - They `require('../lib/x.ts')`. A few `t.mock.method(namespace, …)` sites need a mockable seam.
   - Node tests must never be named `*.test.ts`, because `claude plugin test` collects those. Repo `scripts/` stay JS.
   - Converting the tests is a later, separate pass.
7. **Types come from Claude Code, not npm.**
   - `import type { … } from 'claude-code'` gives the module API and every hook input type, and is erased at run time.
   - The generated `.claude-plugin/types` folder is gitignored and missing in CI, so the root `tsconfig.json` maps
     `claude-code` to a committed snapshot, `typings/claude-code/`, copied from the generated one. (The probe never
     refreshed it, as first written here; since stage T8 `npm run typings` copies it, with `claude-code-tools` and
     `claude-code-mcp`, and `npm run probe` fails while its "Written by Claude Code X" line is not
     `contract.json` `probed`.)
   - `@types/node` and `typescript` are root devDependencies with a committed root `package-lock.json`.
8. **tsconfig** (at the repo root): `strict`, `noEmit`, `module`/`moduleResolution: nodenext`, `erasableSyntaxOnly`,
   `allowImportingTsExtensions`, `verbatimModuleSyntax`, `skipLibCheck`, `target: es2024`.
   - Include `plugin/sub-human/{lib,hooks,mcp,statusline,mod}`; exclude `vendor` and the tests.
   - The goal is zero errors under `strict`. `any` is allowed only at true boundaries (parsed JSON before validation)
     and is written out explicitly.
9. **Security must not regress.**
   - The Bash guard's `PLUGIN_CODE` pattern (`mod/core/guard.ts`) matches `.ts` (and `.js`, so old paths stay guarded).
   - The test that no code bypasses the store (`store-bypass.test.js`) walks `.ts` files.
   - Hidden prompts, consent and PIN handling keep their tests unchanged.
10. **New check.** Every `${CLAUDE_PLUGIN_ROOT}/…` path in `hooks.json` and the MCP config must exist, because
    `validate` doesn't check them.

## Phases

**A: mechanical conversion, done by one agent on its own branch.** Every rename has to land at once: about 930 import
specifiers across 93 files name files by extension.
- A codemod renames `.js`/`.mjs` to `.ts`.
- `require`/`module.exports` become `import`/`export`, with `.ts` specifiers.
- `__dirname` becomes `import.meta.dirname` and `require.main === module` becomes `import.meta.main`.
- Lazy requires that break the 15-file cycle become static imports where that is safe. Otherwise they become a
  `createRequire` call or an `await import()` kept at the same point.
- Worker and spawn targets are updated.
- Every hardcoded name is updated, in each of these places:
  - `hooks.json`, `.mcp.json`
  - `shimArgv` callers, `register` HOOKS, the guard regex
  - `arch-doc.js`, `scripts/lib/paths.js`
  - the test helpers and the test runner's globs
  - the lab `seat-cli.js` source greps
  - the skills and the README
- Add the root tsconfig, the devDependencies, `npm run typecheck`, the typings snapshot, the CI step and the Node ≥ 24.3
  floor.
- Exit: `npm test`, `npm run test:thread-store`, `npm run validate`, `claude plugin test` and `npm run docs -- --check` all
  pass. `tsc` runs; errors are allowed at this point, and their count is recorded.

**B: types, fanned out.** Each agent works in its own worktree, branched from A, and owns only its files. Shared types
live in a `types.ts` in each slice's own directory. An agent needs zero `tsc` errors in its own paths, all tests passing,
and no behaviour change.
1. Foundation: `lib/{config,io,text,clock,home,lock,cc}`, `cli/args`, `room/{envelope,validate}`,
   `remote/{noise,cpace,ws,protocol,outbox}`.
2. `lib/room/*`, `lib/{identity,room}`.
3. `lib/remote/*` (the rest), `lib/remote/transports/*`.
4. `lib/{handoff,proposal,rows,tasks,tail,seats,room-claude,notices,…}`, `lib/cli/*`.
5. `hooks/*`, `mcp/*`, `statusline/*`.
6. `mod/**`.

**C: integration.** Merge B1 to B6, in order. Then:
- reach zero `tsc` errors overall and make `tsc` part of `npm test`;
- run the full tests, the Docker lab (its images are bumped to Node ≥ 24.3) and the hook-latency measurement;
- update the docs (CLAUDE.md, ARCHITECTURE, README, CHANGELOG);
- bump the version.

Commits stay local; release only when asked.

## Must not regress

- PINs and invites never reach the model.
- Consent is human-only.
- The guard still covers plugin code.
- Nothing is written to user settings.
- `scripts/sub-human` keeps its path.
- The runtime has no dependencies.
- No model is pinned.
