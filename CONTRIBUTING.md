# Contributing

Thanks for trying sub-human. It's a beta, built by one person, so the most useful things right now are:

- **Bug reports**, with the output of `/sub-human doctor` (or `node <plugin root>/scripts/sub-human doctor --bundle`
  in a shell, which redacts secrets). Use the bug template.
- **"Where did you get stuck?"** reports. If installing, inviting someone or joining a room confused you, that's a
  bug too.
- **Ideas** in Discussions.

For a pull request bigger than a small fix, open an issue first so we can agree on the shape before you spend time on
it.

## Working on the code

The plugin is `plugin/sub-human/`: ESM TypeScript that Node 22.18+ or 24.3+ runs directly, with no build and no
runtime dependencies. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it fits together, and
[CLAUDE.md](CLAUDE.md) is the map of the repo (written for Claude Code, readable by people).

```
npm ci              # typescript, @types/node and oxlint, for checking only
npm test            # typecheck, the plugin's tests, the scripts' tests, then the hooks-module tests
npm run lint
npm run validate    # claude plugin validate --strict
```

Try your change in a real session with `claude --plugin-dir plugin/sub-human`. Any change to the plugin needs a newer
`version` in `plugin/sub-human/.claude-plugin/plugin.json` (CI checks), or marketplace users never get it.

sub-human relies on some Claude Code internals. Each one is listed in `plugin/sub-human/lib/cc/contract.json`, and
`npm run probe` checks them against your installed Claude Code. A new one goes in that list.

By contributing you agree that your contribution is licensed under the MIT license.
