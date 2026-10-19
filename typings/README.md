# typings/

These are the TypeScript declarations Claude Code writes beside a plugin's hooks module
(`plugin/sub-human/.claude-plugin/types/`), copied here by `npm run typings` so that `npm run typecheck` can run
without a Claude Code session. Each `index.d.ts` names the Claude Code version that wrote it on its first line.

They are Claude Code's, © Anthropic PBC, and are **not** covered by this repository's MIT license. They are kept
only to type-check the plugin. When Anthropic publishes these declarations as a package, this folder is replaced by
that package.
