# Claude Code 2.1.296: what changed for sub-human

Source: `/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude` (`VERSION:"2.1.296"`), read as latin1 text with `grep -a` plus a context extractor. This note is a delta against [`cc-2.1.292.md`](cc-2.1.292.md), which is itself a delta against [`cc-2.1.281.md`](cc-2.1.281.md); the § numbers are that note's sections, and everything not listed here still reads as 2.1.292 left it.

On 2.1.296, 4 of the 79 probe checks (78 CONTRACT entries plus the derived `daemon-env-names`) failed. 2 were code that moved around a field we do not read, and 2 changed behaviour. None needed a plugin code change beyond `cc.DAEMON_ENV_ALLOW`. With the anchors below the probe passes 79/79, and 81/81 with the two [bg daemon](#the-bg-daemon-daemon-status-daemon-upgrade-exit-new) entries added since.

> (Since: Stage 2 removed `hook-async` (its use, an async hooks.json entry, went), and `daemon-env-names` folded into `daemon-env-allowlist`: the probe counts 79 entries, 79/79 on 2.1.296.)

## Per entry

**(a)** = same behaviour, only minified names or formatting moved; **(b)** = behaviour changed; **(c)** = removed.

| Entry | § | Class | Evidence in 2.1.296 | New anchors |
|---|---|---|---|---|
| `plan-reject-user-feedback` | 3 | a | The serializer now writes `…toolDenialUnanswered:Pe,userFeedback:Me,toolResultRemedy:$e,permissionDecision…`: `mcpMeta` no longer follows `toolResultRemedy`. The tool_result builder is unchanged (`userFeedback:tn.behavior==="ask"?tn.userFeedback:void 0,toolResultRemedy:`, the first shape), and so is `cancelAndAbort`'s `?.feedbackIsFromUser&&`. `cc.planFeedback` needs no change. | `?.feedbackIsFromUser&&` + shape 1 + shape 2 `toolDenialUnanswered:~,userFeedback:~,toolResultRemedy:~,` |
| `daemon-env-allowlist` | 5 | **b** | The allowlist grew by two keys; nothing was removed. See [below](#daemon-env-allowlist-b). | JSON of `cc.ts`'s own key arrays + 2 shapes (unchanged) |
| `bg-provider-env` | 5 | **b** | The log line `stripped disallowed providerEnv key(s)` is gone. The saved job state parses `providerEnv:ue(o(),o()).transform((e)=>{let n=Wrs(oo(e,xT));return n&&sdr(n,"the saved job state (state.json providerEnv)")})`, and `Wrs` drops each key that is not in the base allowlist (`!q6e.has(e)?"not kept for background sessions"`), each `QZr` key (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `CLAUDE_CODE_HOST_GATEWAY_LINEAGE`) whose value is not truthy (`"only kept when set to a true value such as 1"`), and each path-valued key that fails its check, then logs `` `[jobs] ignored these saved environment entries in the job's state.json: ${…}` `` at warn. Same filter as before (`q6e` is 2.1.292's `zWe`), now with a reason per key. | `ignored these saved environment entries in the job's state.json`, `not kept for background sessions` |
| `harbor-kite-gate` | 8 | **b** | `function xi(){if(Zh().messagingBeyondOwnAgentsDisabled)return!1;let e=a.CLAUDE_CODE_HARBOR_KITE;if(e!==void 0)return Ne(e);if(O()==="windows"&&!k("tengu_harbor_kite_win",!0))return!1;return k("tengu_harbor_kite",!0)}`. New first test: the process's restrictions object (the one with `backgroundTasksDisabled`, `backgroundAgentLaunchDisabled`, …) can turn cross-session messaging off before the env var is read. It is unset in a plain CLI session, so the gate is still on by default. | `"tengu_harbor_kite",!0)` + shape `messagingBeyondOwnAgentsDisabled)return!1;let ~=~.CLAUDE_CODE_HARBOR_KITE;if(~!==void 0)return ~(~);` |

### daemon-env-allowlist (b)

2.1.296 builds the dispatch allowlist as `CNr = new Set([...q6e, ...l5n, <extras>])` (2.1.292: `qRr = [zWe, dWn, extras]`):

- `q6e` = `CLAUDE_CONFIG_DIR`, `CLAUDE_INTERNAL_FC_OVERRIDES`, `...ZZr` (model keys `eut` + custom model keys `nWn` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`), `CLAUDE_CODE_CLIENT_DATA_URL`, `...hV` (provider selectors), then the AWS/GCP keys. Same order as 2.1.292.
- `eut` gained **`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`**, right after `CLAUDE_CODE_SUBAGENT_MODEL`.
- `l5n` = `PATH`, `CLAUDE_CODE_EXTRA_BODY`, `CLAUDE_CODE_HOST_CREDS_FILE`, `...uUe` (the endpoints and companions; unchanged).
- The extras gained **`CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`**, right after `CLAUDE_CODE_DISABLE_PROACTIVITY`: `"CLAUDE_CODE_DISABLE_PROACTIVITY","CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG","CLAUDE_CODE_AUTO_MODE_SERVER",…,"CLAUDE_CODE_PLUGIN_DIRS"`.

Still not on the list: `HOME`, `USER`, `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, any `SUB_HUMAN_*`, and auth secrets.

**Fix.** `cc.MODEL_KEYS` and `cc.EXTRA_KEYS` copy the two new keys in the binary's order, so `cc.DAEMON_ENV_ALLOW` (and through `cc.daemonEnv`, the room's Claude spawn env) forwards them as the daemon would. `cc.test.js` checks both are in the allowlist.

> (Moved: the key arrays are now the `contains` groups of `daemon-env-allowlist` in `lib/cc/contract.json`, checked as a shape (each array holds its names, more allowed) rather than as exact JSON, and `DAEMON_ENV_ALLOW` is built from them in `lib/cc/bg.ts`; the derived `daemon-env-names` check folded into that entry.)

## The bg daemon: `daemon-status`, `daemon-upgrade-exit` (new)

Issue #5: a host's bg daemon kept running a `claude` binary that an upgrade had deleted, and crashed every room's Claude it started, while doctor was green. Two new entries (§5) back doctor's `daemon` check:

- `daemon-status`. `claude daemon status` (help: `Show daemon pid, version, uptime`) prints `` K(`pid:     ${y.pid}`),K(`version: ${y.version}`),K(`uptime:  ${L}s`),… `` while the daemon runs; otherwise `K("not running")`, a `bg sessions:` summary, and exit 1 (`de(1)`). It starts nothing. `cc.parseDaemonStatus` reads the two lines, `cc.daemonStatus` runs it (exit status not checked).
- `daemon-upgrade-exit`. The supervisor polls its own binary. When it is gone it logs `` `binary at ${le} was deleted (was ${oe.target}) \u2014 exiting for upgrade` `` (replaced: `… changed (…) \u2014 self-restarting for upgrade`), deferring while workers are busy up to a cap (`busy-worker upgrade defer cap reached`). The poll is skipped in some modes, and when the binary's identity cannot be resolved at start: `` `binary identity unresolvable at ${le}; upgrade polling disabled` ``. A daemon in that state keeps the deleted binary, which is what the issue saw.

`claude daemon stop` takes `--any` (also stop a transient, non-service daemon, which is how `claude agents` starts it) and `--keep-workers` (leave detached sessions running); after a stop it prints ``note: the next `claude agents` or `claude --bg` will start a new one``. Doctor's fix line is that command; `doctor --fix` never runs it.

How doctor tells the executable was deleted (`cc.exeState`): on Linux `/proc/PID/exe` reads `<path> (deleted)`; on macOS `ps -o comm=` gives the path the daemon was started with (`/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude` here), and a missing absolute path means deleted. A bare `claude` (started through PATH) says nothing, so it is not flagged. A daemon whose version differs from `claude --version` but whose binary still exists is a warn.

## The test kit stores a plugin's own `$.session.append`

In 2.1.292 `claude plugin test` had no bottom for a plugin's own `$.session.append` (`no implementation for session.append`), and a test's `on('session.append')` was not reached by it, so `mod/test/deliver.test.ts` was written with every append failing. In 2.1.296 the kit stores the row (the call resolves to `{ message, uuid }`), and a test's `on('session.append', ($, e, next) => …)` sees the module's call (door `note`) and may answer `{ deny }`. Six deliver tests that expected the failure path timed out. Nothing the plugin does at runtime changed, so this is no CONTRACT entry: the tests now pick, per world, whether an append is kept or refused, and cover both paths.

## Currently passing entries

The other 74 CONTRACT entries and `daemon-env-names` pass unchanged at their 2.1.296 sites. `PROBED_VERSION` is now `2.1.296`; `MIN_VERSION` stays `2.1.292` (nothing the plugin needs is newer).

## Live verification (October 2026, stage 8c)

What four live runs on 2.1.296 showed about Claude Code, and what the plugin now does about it (the changelog's "Live verification fixes" lists the fixes):

- **A `$.ui.log` notice is saved.** Each one lands in the session's transcript as a `system`/`informational` row, so a model that can read the transcript can read it. An invite's line and PIN therefore go to `$.ui.status` (the typings: a status line under the prompt that "leaves the transcript and the model untouched", one per plugin) for the invite's life; the notices say where they are. Not yet seen live: that `$.ui.status` is drawn whole at narrow widths.
- **Prompts typed at Claude Code stay in `~/.claude/history.jsonl` and the transcript**, a `/sub-human join PIN` included. The guards deny a model reading either (Read, Grep, and a Bash command that names or globs them).
- **A plugin prompt short enough for its speaker label comes to `ui.render` with `isExpanded: true`**, framed ("The sub-human plugin sent a message: …", CONTRACT `plugin-prompt-frame`). A render hook that passed every expanded row drew every wake raw; `mod/render.ts` now draws a room prompt expanded too, the frame dim.
- **A UserPromptSubmit `decision: block` puts the prompt back in the input** and draws "UserPromptSubmit operation blocked by hook:". Refusals the person types again are a stop (`continue: false`) now, as the `✓ sent` receipt is (CONTRACT `ups-stop-frame`).
- **`/clear` in the room's Claude ran** (its conversation cleared, the seat rebound). `command.run` fires for every slash command, built-ins included (the typings' own example is `compact`); the module answers a typed one there with the refusal. Not yet seen live on `/clear` itself.
- **`idle_prompt` may never come**: every member showed "working" for minutes. The module writes "idle" at the end of a turn a typed prompt started.

## Live verification, round two (stage 8d)

What a second live round on 2.1.296 showed, and what the plugin does about it (the changelog's "Live verification fixes, round two" lists the fixes):

- **← (the agent view) forks the session.** It is `repl_background_fork`: the foreground conversation is started again as a bg job, `claude --resume <transcript> --fork-session …` (a new session id; its SessionStart `source` is `"fork"`, from `r.forkSession…?"fork":"resume"`), and once the job is up the old transcript gets `{"type":"continued-in","continuedInSessionId":NEW}`. The old process stays up as the agent view; the old session's in-process rows end ("Agent … finished" arrives in the fork); no SessionEnd runs for the old session, so its seat stayed live, and the job keeps only the daemon's env allowlist (`SUB_HUMAN_HOME` dropped: the live fork opened its new room in `~/.sub-human`). Before stage 8d the module ran no session-restore for `"fork"` (not a source it knew) and the seat was lost. CONTRACT `session-fork-continued-in`; `session-restore` moves the seat to the session the record names, and a bare `/sub-human` there does the same.
