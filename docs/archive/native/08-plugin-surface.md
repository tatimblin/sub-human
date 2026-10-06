# 08: Plugin packaging and presentation

Lens: manifest (`userConfig`, `channels`), skills vs commands, skill frontmatter, monitors, output
styles, plugin `settings.json`, `${CLAUDE_PLUGIN_DATA}`, marketplaces/scopes, `claude plugin eval`.
Claude Code 2.1.281. Probes ran in `/tmp/native-08/p1` (a throwaway `probe` plugin), on Haiku, with
`-p` or an own tmux session `native08`. Everything was killed afterwards. The probe-created
`~/.claude/plugins/data/probe-inline` was removed.

## 1. Capability

- **Plugin `settings.json`** (or the manifest key `settings`). Only `agent` and `subagentStatusLine` take effect. Everything else is dropped, and plugin values are the lowest settings layer. [verified-by-source: `var Wpe=["agent","subagentStatusLine"]`; docs plugins/components#default-settings]
  - `agent` runs a plugin agent as the **main thread** of every session where the plugin is enabled. [verified-by-probe: `settings.json {"agent":"orch"}` → `-p "say hi"` replied `ORCH-ACTIVE`]
  - `claude --agent probe:orch` does the same for one launch, without the setting. [verified-by-probe] Hooks then receive `"agent_type":"probe:orch"`. [verified-by-probe: UserPromptSubmit stdin `…"permission_mode":"default","agent_type":"probe:orch"…`]
  - `subagentStatusLine` from a plugin does replace agent-panel rows. [verified-by-probe: the row rendered `◯ ROOM otter-4 · alice, bob · plan pending`]
    - Its stdin is `{session_id, cwd, columns, tasks:[{id,name,type,status,label,model,tokenCount,…}]}`.
    - It prints one JSON line `{id, content}` per row it overrides. [verified-by-source: `bt[wt.data.id]={content:…}`]
    - `${CLAUDE_PLUGIN_ROOT}` is **not** substituted or exported there. [verified-by-probe: `echo "${CLAUDE_PLUGIN_ROOT}"` wrote an empty line]
    - A bare `bin/` command was not found under `--plugin-dir`. [verified-by-probe: no output]
    - An absolute path works.
- **`userConfig`**: options are prompted at enable time, by `/plugin configure`, or by `claude plugin install --config KEY=VALUE`. Non-sensitive values go to user `settings.json` `pluginConfigs` and appear as `/config` rows. [documented: plugins/manifest-reference#user-configuration; CLI `--config` help]
  - They reach hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`. [verified-by-probe: `CLAUDE_PLUGIN_OPTION_MEMBER_NAME=alice` via `--settings '{"pluginConfigs":{"probe@inline":{"options":{"member_name":"alice"}}}}'`]
  - They are also substituted into skill and agent bodies. [verified-by-probe: `NAME=alice CODE=otter-1`]
  - They do **not** reach monitor commands, through `${user_config.*}` or through the environment. [documented]
- **`channels`**: a manifest entry binds one of the plugin's MCP servers as a push channel, with its own `userConfig`. It is still the research-preview channel mechanism (`--channels`, allowlist, or `--dangerously-load-development-channels`). [documented; see docs/research/03-mcp-push-verbatim.md §1]
- **Monitors `when`**: `"always"` (the default) or `"on-skill-invoke:<skill>"`, which arms the first time that skill is dispatched. Monitors run only in interactive sessions, keep running if the plugin is disabled mid-session, and stop at session end. [documented; verified-by-source: Zod `when` schema]
  - **The skill name must be plugin-qualified.** [verified-by-probe: three monitors, one per variant]
    - `always` armed at start.
    - `on-skill-invoke:probe:whoami` armed when `/probe:whoami` ran.
    - `on-skill-invoke:whoami` **never armed**, yet `claude plugin validate` passed it.
  - An `on-skill-invoke` monitor also did not arm for a `context: fork` skill. [verified-by-probe, unqualified name only]
- **Skill frontmatter**: `arguments`, `context: fork` + `agent` + `background`, `hooks`, `paths`, `user-invocable`, `disallowed-tools`, `model` and `effort`. [documented: /docs/en/skills]
  - Skills supersede commands, and only skills take `paths` and `name`.
  - A `context: fork` skill whose `agent` is a plugin agent showed as its own background row. [verified-by-probe: `◯ probe-feed /probe:feed`]
  - Skill-frontmatter hooks get `${CLAUDE_PLUGIN_ROOT}` but not `${CLAUDE_PLUGIN_DATA}`. [verified-by-source: "only ${CLAUDE_PLUGIN_ROOT} is available for skill hooks (${CLAUDE_PLUGIN_DATA} is plugin-only)"]
- **Plugin agent frontmatter** ignores `permissionMode`, `hooks`, `mcpServers` and `initialPrompt`. [documented: plugins/components#agents]
- **Output styles**: a plugin's `output-styles/*.md` appears in `/output-style` as `<plugin>:<name>`. A plugin cannot select one by default, because `outputStyle` is not a plugin setting. [documented; verified-by-source: `Wpe`]
- **`${CLAUDE_PLUGIN_DATA}`** = `~/.claude/plugins/data/<id>/`, where `<id>` is the sanitised `name@marketplace`. It survives updates and is deleted on the last uninstall unless `--keep-data`. Under `--plugin-dir` the id is `probe-inline`. [documented; verified-by-probe: `DATA=/Users/…/plugins/data/probe-inline`]
- **Install scopes**: `claude plugin install -s user|project|local`. The `project` scope writes `enabledPlugins` into the repo's `.claude/settings.json`. [verified-by-source: `claude plugin install --help`]
- **`claude plugin eval`** runs cases (`case.yaml` or `prompt.md` + graders such as `regex`, `tool_used` and `llm`) as fresh **non-interactive** sessions with only the plugin loaded. [documented: /docs/en/plugin-evals]
  - Runs use a temp `HOME`, mocked MCP servers by default, and an optional `scaffold_script` and `history_file`.
  - Plugin hooks run. Results include a no-plugin baseline delta.

## 2. Mapping to "humans join like subagents"

- **Joining and role.** The orchestrator would launch as `claude --agent sub-human:orchestrator`.
  - `orchestrator.md` becomes that agent's system prompt instead of injected context.
  - Its `tools:` allowlist (post/read/plan, ExitPlanMode, no Bash/Write) enforces "never uses Bash" natively.
  - The join hook reads `agent_type == "sub-human:orchestrator"` to bind the orch role, so the model cannot fake it.
  - Members stay normal sessions. **Do not** ship `settings.json {"agent":…}`: it would make every session, members included, an orchestrator.
- **Identity.** `userConfig.member_name` only gives a **default** name: `/sub-human CODE` could join as `$CLAUDE_PLUGIN_OPTION_MEMBER_NAME`, read in the join hook. It cannot be identity in today's same-machine model, because `pluginConfigs` lives in one user `settings.json` that every session on the machine shares. Process ancestry stays the binding.
  - Keep `${user_config.*}` out of skill bodies. When the value was unset, Haiku invented a name (`NAME=Tristan Timblin`). [verified-by-probe]
- **Presence and visibility.** Ship `subagentStatusLine` in the plugin, so the room feed row shows `ROOM code · members · plan state` with no `--settings` step. Rows for other agents pass through, because the script prints nothing for ids it does not own.
  - The main `statusLine` still has to come from the user. [verified-by-source]
  - A `context: fork` skill `/sub-human:feed` with `agent: sub-human:room` would let the human reopen the feed in one keystroke, without the model choosing to spawn it.
- **Waking.** Change the monitor to `"when": "on-skill-invoke:sub-human:sub-human"`. Today `always` starts `sub-human tail` in every interactive session in every project where the plugin is enabled.
- **Consent and approval.** Unchanged. The native ExitPlanMode path stays. Skill-scoped `hooks:` could register the plan gate, plan-result and guard hooks only after `/sub-human` runs, instead of spawning `node` on every Bash/Write/Edit in every session.
- **Distribution.** A team repo can commit `enabledPlugins` (`-s project`) plus its marketplace, so collaborators get `/sub-human` on clone. `claude plugin install sub-human@sub-human --config member_name=alice` makes onboarding a single command.

## 3. Replaces / simplifies

| Custom piece today | Native replacement | Still needed |
|---|---|---|
| README `--settings` file for `subagentStatusLine` | plugin `settings.json` | an absolute-path shim (below); the main `statusLine` still comes from the user |
| `skills/sub-human/orchestrator.md` context injection plus "never Bash" by instruction | `--agent sub-human:orchestrator` with a `tools:` allowlist | plan mode via `--permission-mode plan` (agent `permissionMode` is ignored); the join hook still creates the room |
| Monitor running in every session | `on-skill-invoke:sub-human:sub-human` | the resume path (below) |
| Global PreToolUse guard/plan hooks | skill-frontmatter `hooks:` | behaviour across `/clear` and resume is unverified |
| Ad-hoc demo checks of model behaviour | `claude plugin eval` with a scaffolded room log and a mocked `room` server | multi-human, monitor and dialog flows stay in the tmux demo |

Shim for the status line: a SessionStart hook writes `${CLAUDE_PLUGIN_DATA}/agent-statusline`
(`exec node "<root>/bin/sub-human" agent-statusline`). The plugin `settings.json` then calls
`"$HOME/.claude/plugins/data/sub-human-sub-human/agent-statusline"`. The command runs through a
shell, so `$HOME` expands. That path is fixed per install id, but not across `--plugin-dir` (`-inline`). [inferred]

## 4. Limits and risks

- **Main-thread `agent` is all-or-nothing per enabled plugin.** A user's own `agent` overrides it, and two plugins conflict (the last loaded wins). [documented] Use the `--agent` flag only.
- **No `${CLAUDE_PLUGIN_ROOT}` in plugin `subagentStatusLine`.** [verified-by-probe] The workaround depends on the install id. Workspace trust is required ("Skipping subagentStatusLine execution - workspace trust not accepted"). [verified-by-source]
- **`on-skill-invoke` re-arming is unclear.** It probably does not re-arm on `claude --resume` or after `/clear`, until `/sub-human` is typed again. [inferred] A wrong unqualified name fails silently. [verified-by-probe] Monitors never run under `-p` or `plugin eval`. [documented]
- **`userConfig` is per OS user, not per session or per human**, and the `/plugin` dialog is interactive-only. [documented]
- **Don't move rooms to `${CLAUDE_PLUGIN_DATA}`.** The id differs between `--plugin-dir` (`sub-human-inline`) and a marketplace install (`sub-human-sub-human`), so mixed sessions would not see each other's rooms. Uninstalling also deletes the data. Keep `~/.sub-human`, and use DATA only for shims and caches.
- **Channels** remain a research preview behind flags and an allowlist. Declaring them changes nothing without `--channels`.
- **Plugin eval** is single-session and non-interactive. It cannot show two humans or the plan dialog.

## 5. Recommendation

- **Adopt now:**
  - plugin `settings.json` `subagentStatusLine`, with the DATA shim; drop it from the README `--settings`;
  - the monitor `when: "on-skill-invoke:sub-human:sub-human"`;
  - `claude plugin eval` for member and orchestrator *behaviour* cases.
  - Also fix the README claim that "a plugin can't set … the agent-panel rows".
- **Adopt next:** `claude --agent sub-human:orchestrator`, with a `tools:` allowlist and `agent_type` role binding in `join.js`. Add `userConfig.member_name` as a default name only, read in hooks.
- **Don't adopt:**
  - plugin `agent` in `settings.json`;
  - output styles, which can't be defaulted and add nothing over an agent prompt;
  - rooms in `${CLAUDE_PLUGIN_DATA}`;
  - `channels` until the preview opens.
- **Settling experiment:** in tmux, start a session with the monitor on `on-skill-invoke:sub-human:sub-human`. Run `/sub-human alice CODE`, post from another session, then `/exit` and `claude --resume`, and post again. If the resumed session wakes, `on-skill-invoke` is safe. If not, the SessionStart restore hook must tell the human to retype `/sub-human`, or the monitor stays `always` with a cheap no-room idle.
