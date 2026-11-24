# Contributing

Thanks for trying sub-human. It's built by one person, so the most useful things right now are:

- **Bug reports.** Use the bug template.
- **"Where did you get stuck?"** reports. If installing, inviting someone or joining a room confused you, that's a
  bug too.
- **Ideas** in Discussions.

For a pull request bigger than a small fix, open an issue first so we can agree on the shape before you spend time on
it.

## Working on the code

The plugin is `plugin/sub-human/`: ESM TypeScript that Node 22.18+ or 24.3+ runs directly, with no build; its few
dependencies are vendored under `plugin/sub-human/vendor/`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how
it fits together, [docs/TESTING.md](docs/TESTING.md) how it is tested, and [CLAUDE.md](CLAUDE.md) is the map of the
repo (written for Claude Code, readable by people).

```
npm ci              # typescript, @types/node, oxlint and the vendored packages, for checking only
npm test            # typecheck, vendored files, node and script tests, hooks-module tests, validate
npm run lint
npm run budget      # the line budget (ARCHITECTURE §11)
```

Try your change in a real session with `claude --plugin-dir plugin/sub-human`. Any change to the plugin needs a newer
`version` in `plugin/sub-human/.claude-plugin/plugin.json` (CI checks), or marketplace users never get it.

sub-human relies on a few Claude Code behaviours. Each is listed in `plugin/sub-human/core/cc/contract.json`, marked
API (in the committed typings) or internal, and `npm run probe` checks them against Claude Code. A new one goes in
that list.

A test that covers a requirement of `docs/PRD.md` names it (`… (R12)`); `node scripts/trace.ts` rewrites the trace
table in `docs/TESTING.md` from those names.

By contributing you agree that your contribution is licensed under the MIT license.
