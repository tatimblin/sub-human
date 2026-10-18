# Claude Code 2.1.302: what changed for sub-human

Checked 2026-10-17 against the npm package `@anthropic-ai/claude-code@2.1.302` (darwin-arm64), installed into a scratch prefix, after a joiner on 2.1.302 lost the room's tools for a whole session. `CLAUDE_BIN=<that binary> node scripts/probe-cc.ts` failed 5 of 88 entries; each was a search string or shape that moved, not a behaviour that changed. `lib/cc/contract.json` now holds strings and shapes common to 2.1.296 and 2.1.302 (89/89 pass on both).

| Entry | What moved in 2.1.302 | Behaviour |
|---|---|---|
| `mcp-stdio-ppid` | the shell prefix is read inside a function (`shellPrefix:`) | unchanged: the configured command is spawned with no shell unless `CLAUDE_CODE_SHELL_PREFIX` is set (the cgroup wrapper is Linux only) |
| `daemon-env-allowlist` | `CLAUDE_CODE_AUTO_MODE_MODEL` added inside the endpoints' array | unchanged for the keys sub-human forwards |
| `module-dollar-local` | the message names a new allowance: `$` is followed into a function declaration imported from the module's own files | a relaxation; sub-human keeps every `$` call local, which loads on both |
| `command-run-empty-answer` | the `<plugins>: <text>` row is built in two steps | unchanged |
| `ups-stop-frame` | the warning row carries a `promptSubmitEnding` field | unchanged: still two rows |

## The MCP failure cache (`mcp-failure-cache`, in 2.1.296 too)

A plugin's stdio MCP server that fails to connect, in any session, is recorded in `<configDir>/mcp-needs-auth-cache.json` as `{"plugin:sub-human:room": {"timestamp": ..., "id": ...}}`. For 15 minutes every session started on that machine skips the server, with the error `Skipping connection (recent failure cached; retries automatically in 15 min, or edit the plugin config to retry now)`. The failure itself is not in the transcript of the session that hits the cache.

That is what the joiner's session showed: `failedMcpServers: [{"name": "plugin:sub-human:room", "error": "Skipping connection (recent failure cached ...)"}]` on its first model turn. The server connects in 176 ms on 2.1.302 here, with or without a seat, so the original failure was in an earlier session on his machine and is not visible.

Without the room server, a member's Claude had no room tools (`post`, `read`, `plan`, `task`), its rows could not start (a participant row's only tool is `hold`: "would be spawned with zero tools — refusing"), and the module's SendMessage relay passed the send on to the engine, which answered "No agent named 'tristan.CODE' is reachable". sub-human now:

- relays a SendMessage to another machine through node (`hooks/handlers/send.ts`, the same rules as the post tool in `lib/agent-post.ts`) when the room server is not connected, and never passes such a send on to the engine;
- says once that the room's tools are not connected (`mod/core/rows.ts` `ROWS_DOWN`) instead of the rows' Agent calls, which would fail again on every prompt;
- shows the cached failure in `sub-human doctor` (`room-tools`, from `lib/cc/env.ts` `mcpFailureLeft`).

Since 0.5.0-beta.21 the start itself is made hard to fail, so the cache is not written in the first place:

- `.mcp.json` starts the server through `hooks/node.sh`, which finds a node that runs the plugin (22.18+ or 24.3+): the one it last ran with, then `PATH`'s, then Homebrew, nvm, fnm, mise, asdf and Volta. A Claude Code started where `PATH` has no node or an older one (an IDE, the desktop app, a shell without nvm) was the likeliest first failure: the joiner's node came from nvm. Every hook and the module's shims and tail go through it too.
- The entry is `mcp/room.ts`: when `mcp/room-server.ts` fails to load (a broken or half-written install), it still answers `initialize`, lists no tools and answers every call with the error and what to do, so the connect succeeds.
- A seat whose server is not connected is told once per time it goes down, as a `$.ui.log` line and as context for Claude (`mod/core/rows.ts` `TOOLS_DOWN`), on its next typed prompt; that prompt's `$.mcp.connect` also connects a server the session has not yet.

`/mcp`, then Reconnect on `plugin:sub-human:room`, brings the tools back in a running session.

## Three internals added to the contract (2026-10-18)

Each was relied on without an entry. All three pass on 2.1.296 (Homebrew) and 2.1.302 (the canary's npm package), with the same strings and shapes; the contract now has 92 entries.

- **`askuserquestion-answers`** (feature `core`). The hooks reference documents the plumbing: a PreToolUse answer of `ask` with `updatedInput` replaces the call's input before the tool's own dialog, and PostToolUse carries `tool_response`. It does not document what AskUserQuestion's `tool_response` holds. The binary's output schema and `call` do: `{questions, answers, response?, annotations?, afkTimeoutMs?, followUp?}`, with `answers` keyed by the exact question text (a multi-select answer comma-joined), `annotations[question].notes` the person's note, `afkTimeoutMs` only when the dialog closed itself after idle ("Absent on every human-resolved path") and `followUp: true` when the person asked for another round. `lib/consent/card.ts` `answerCard` reads exactly these for the fallback consent card, the review note's confirm card and the host's join-request card (Let in / Refuse). Feature `core`, not `sign-off`: the admission card has no other route, and a failed entry should leave the version unverified rather than turn the plan view's sign-off to its fallback.
- **`module-ui-status-untranscribed`** (feature `core`). The engine runs a module's `ui.status` request as `status(plugin, text)`: it removes and re-adds the pinned notification `plugin-status-<plugin>` (`priority: "low", pinned: true`) on the notification bar. In a headless session it becomes a `system`/`ui_status` message on the SDK stream. Nothing on that path appends a row, unlike `$.ui.log` (a stored notice) and `$.session.append`. What the binary cannot prove is that nothing else copies notifications into the transcript. The typings promise "leaves the transcript and the model untouched" only for `ui.toast`, so the entry's note says so. One more place the text goes: the engine's debug log (`$.ui.status (<plugin>): <text>`), when debug logging is on. `mod/deliver.ts` `pinStatus` puts an invite's line (its SECRET) and its PIN there.
- **`agents-json-fields`** (feature `room-session`). `printAgentsJson` builds a background job's row as `{pid?, id, cwd, kind: "background", startedAt, sessionId, name?, status?, waitingFor?, state}`. `state` is `working|blocked|done|failed|stopped` and `status` is `idle|waiting|busy`. A live session with no job gets `{pid, cwd, kind: "interactive"|"background", startedAt, sessionId?, name?, status?, waitingFor?}`, with no `id` and no `state`. Without `--all`, a job with no running worker is listed only while working or blocked. `lib/cc/bg.ts` `parseAgentsJson` and `lib/room-claude.ts` `findJob` (an id, kind not interactive, state not done/failed/stopped, name `claude.CODE`) rely on these field names and values. The `agents-json` entry keeps the command itself.
