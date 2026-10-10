# Claude Code 2.1.281 internals relevant to sub-human

Source: `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`, read as text with `strings -n 8 > bin.txt` plus a Python regex context extractor (`ctx.py <regex> <before> <after> <max>` in this tmp dir). Minified identifiers such as `nZe` or `Kz` only hold within this build. The **search strings** below are literal text: string constants, schema `.describe()` text and env names, so they should still find the same code in later builds.

Stability scale:
- **API**: documented hook or settings schema, a `.describe()` string, or an exported name.
- **Env/flag**: a named env var or GrowthBook flag.
- **Incidental**: behavior that follows from how the code is written and is not named anywhere.

---

## 1. TaskCompleted / TaskUpdate / TaskCreate

**Evidence (TaskUpdate.call).** Search `TaskCompleted hooks cancelled (control stream closed)`:
```js
if(h==="completed"){let W=[],L=e.runTaskHooks(nZe,r,U.subject,U.description,Fm(),Qi(),void 0,v);
 try{for await(let F of L)if(F.blockingError)W.push(cvt(F.blockingError))}catch(F){...}
 if(W.length>0)return{data:{success:!1,taskId:r,updatedFields:[],error:W.join(`\n`)}}}
A.status=h,H.push("status")} ... if(Object.keys(A).length>0)await Wwe(q,r,A,D);
```
- The TaskCompleted hook's block decision is **honored** when the TaskUpdate tool triggers it. A `blockingError` makes TaskUpdate return `success:false` and `updatedFields:[]`, with `error` set to `"TaskCompleted hook feedback:\n<msg>"`. The return happens **before** `Wwe` (the write), so **every field in that same call is discarded**, including subject, metadata and owner, not only the status.
- Two things produce a `blockingError`:
  - **Exit 2.** The message is stderr. Search `if(cr.status===2&&!di.blockingError)di.blockingError`.
  - **JSON `{"decision":"block","reason":...}`.** Search `case"block":U.permissionBehavior="deny",U.blockingError={blockingError:e.reason||"Blocked by hook"`.
- **Gotcha.** `exitTwoMeansMissingScript`: for Stop, SubagentStop, TaskCompleted and TeammateIdle (and UserPromptSubmit when the hook comes from a plugin), an exit 2 with **empty stdout** whose stderr matches `/no such file|can't open/i` is treated as a missing script and becomes a **non-blocking** error. Search `Hook script appears to be missing`.
- **Timing.** The hook runs before the status is written to disk. A hook that reads `~/.claude/tasks/<list>/<id>.json` still sees the old status.
- **Input.** Search `hook_event_name:R("TaskCompleted"),task_id:o(),task_subject:o(),task_description:o().optional(),teammate_name`. The input carries **no metadata, owner or status**, so a hook must read the task file to see metadata. `permission_mode` is also absent, because TaskUpdate passes `void 0` for it.
- **Matcher.** None: the matcher query returns `undefined` for TaskCreated and TaskCompleted, so every TaskCompleted hook fires. Search `case"TeammateIdle":case"TaskCreated":case"TaskCompleted":return;`.
- **Second trigger (agent teams only).** In the teammate Stop path (`$a()`), TaskCompleted fires for each `in_progress` task the teammate owns. A block there is injected as a meta message and prevents the stop. Search `TaskCompleted hook prevented continuation`.
- **TaskCreated.** It runs after the task file is written. On a block, TaskCreate **deletes the task and throws**. Search `TaskCreated hooks cancelled (control stream closed)`.

**PreToolUse deny on TaskUpdate.** No tool exemption exists. `executePreToolHooks` (`Nje`) builds `{hook_event_name:"PreToolUse",tool_name,tool_input,tool_use_id}` for every tool, and TaskUpdate is an ordinary tool (`name:zE`, `var zE="TaskUpdate"`). A `permissionDecision:"deny"` therefore works. The `if` field cannot express `status:"completed"`, because TaskUpdate has no `preparePermissionMatcher`. The script has to inspect `tool_input.status` itself.

**Input schemas.** Search `Metadata keys to merge into the task. Set a key to null to delete it.`
- **TaskUpdate**: `taskId` (required), plus optional `subject`, `description`, `activeForm`, `status` (pending, in_progress, completed or deleted), `addBlocks[]`, `addBlockedBy[]`, `owner`, `metadata: record<string, any>`. `metadata` is merged, and setting a key to `null` deletes it.
- **TaskUpdate output**: `{success, taskId, updatedFields[], error?, statusChange?{from,to}}`.
- **TaskCreate**: `subject`, `description`, optional `activeForm`, optional `metadata` ("Arbitrary metadata to attach to the task"). Search `Arbitrary metadata to attach to the task`.
- Stability: **API**. `metadata` is the supported place to carry a request id. Two cautions: a hook that blocks discards any metadata sent in the same call, and the TaskCompleted input does not include metadata.

## 2. CLAUDE_PID / CLAUDE_CODE_SESSION_ID

**Evidence.** Search `CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED`:
```js
function M0e(e){let n={CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,CLAUDE_CODE_CHILD_SESSION:"1",
 CLAUDE_CODE_SESSION_ATTENDED:..., CLAUDE_PID:String(process.pid)}; if(e.source==="agent")n.AI_AGENT=...; CLAUDE_EFFORT, TRACEPARENT}
```

Who calls `M0e`, and so receives `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`:

| Child | Evidence | Session id value |
|---|---|---|
| Bash/PowerShell tool | `kcr({shellType...})` calls `M0e({sessionId:K(),...,source:"agent"})` | the current id (`K()`) at spawn time |
| Hook commands | `ln={...Ps(),...ve,...M0e(g),CLAUDE_PROJECT_DIR:...}`, then `CLAUDE_PLUGIN_ROOT`, plus `CLAUDE_PLUGIN_DATA` when the plugin has a source | the hook's session |
| statusLine / subagentStatusLine | `We={...Ps(),...M0e(koe(Re)),CLAUDE_PROJECT_DIR}` | the session id from the input |
| Plugin monitors | run through `jre` (the shared shell exec), which uses `kcr` | the id at **arm time**; it goes stale after /clear |

- **MCP stdio servers.** Search `CLAUDE_CODE_SESSION_ID:K(),CLAUDECODE:"1",...n.env`. They get `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE` and `CLAUDE_PROJECT_DIR`, but **not `CLAUDE_PID`**, and `CLAUDE_CODE_CHILD_SESSION` is stripped. The values are fixed when the server spawns. Plugin MCP servers also get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. Search `CLAUDE_PLUGIN_ROOT:n.path,CLAUDE_PLUGIN_DATA:GEe(n.source),...ve.env`.
- **/clear.** On conversation reset, `if(a.CLAUDE_CODE_SESSION_ID)process.env.CLAUDE_CODE_SESSION_ID=K()`. Search `conversation_reset",newConversationId`. Children spawned later see the new id. Monitors and MCP servers that are already running keep the old one.
- **Nested `claude`.** It removes `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE` and `CHILD_SESSION` from its env. Search `delete e.CLAUDECODE,delete e.CLAUDE_CODE_SESSION_ID`.
- **Hook-input equivalents** (common `P()` schema). Search `Subagent identifier. Present only when the hook fires from within a subagent`. The fields are `session_id`, `transcript_path`, `cwd`, `prompt_id?`, `permission_mode?`, `agent_id?` (subagent only), `agent_type?` and `effort?`, plus `scratchpad_dir` (from `rc()`). **No pid field exists in hook input**, so `CLAUDE_PID` is the only process identity.
- **pkill guard.** The Bash tool installs a `pkill` wrapper that refuses patterns matching `CLAUDE_PID`. Search `pkill: refusing to run`.
- Stability: env var names are named constants (`CLAUDE_PID` is listed in `mMn` with the other spawn env keys), so moderately stable. `CLAUDE_PID` is undocumented. `session_id` in hook input is **API**.

## 3. Plan mode, ExitPlanMode and the reject note

- **Attachment.** Search `type:"plan_mode",reminderType:ge,isSubAgent:!!r.agentId,planFilePath:h,planExists`. The transcript entry `{type:"attachment",attachment:{type:"plan_mode",reminderType:"full"|"sparse",isSubAgent,planFilePath,planExists,customInstructions?,workshopDocPath?...}}`. Two siblings exist: `plan_mode_exit` `{planFilePath,planExists}` and `plan_mode_reentry`. Stability: incidental. The transcript format is internal.
- **ExitPlanMode input.** Search `The plan content (injected by normalizeToolInput from disk)`. The model sends `{allowedPrompts?}` (passthrough). `normalizeToolInput` injects `plan` and `planFilePath`, read from disk. So PreToolUse and PermissionRequest hooks see `tool_input.plan` and `tool_input.planFilePath`. Those keys are stripped again before the tool runs and before the transcript or API copy is written. Search `Iit=new Map([[Ou,new Set(["plan","planFilePath"])]])` and `We=ZW(e.name,We)`.
- **ExitPlanMode output** (`tool_response`): `{plan:string|null, isAgent:boolean, filePath?, hasTaskTool?...}`. Search `The file path where the plan was saved`. A PostToolUse hook fires **only on approval**, because the tool runs only then.
- **Reject with "No, keep planning".** The dialog returns `{behavior:"deny",feedback}`. Search `if(h==="no"){if(!be&&!we)return null;return{behavior:"deny",feedback:`. The permission layer then calls `cancelAndAbort(feedback, …, {feedbackIsFromUser:true})`:
  ```js
  cancelAndAbort(k,P,I,F){... R=k?`${M?I5:$x}${k}`:...; return{behavior:"ask",message:U,contentBlocks:I,...F?.feedbackIsFromUser&&k&&{userFeedback:k}}}
  ```
  `$x` = `"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"`. A subagent gets the `I5` variant instead, `"...The user said:\n"`.
  - The resulting tool_result user message is created with `toolDenialKind`, `toolDenialEndsTurn`, **`userFeedback`** (the raw note) and `toolResultRemedy`. These are top-level fields on the message object, and the serializer includes them. Search `toolDenialKind:_e,toolDenialEndsTurn:ve,userFeedback:Ee`. The transcript JSONL line for the rejection therefore carries **`"userFeedback": "<raw text>"`**, so parsing the `the user said:` prose is unnecessary. Stability: incidental, since it is a transcript field, but it is cleaner than matching the text.
  - **No hook event carries the note.** PermissionDenied fires **only for auto-mode classifier denials**. Search `decisionReason.classifier==="auto-mode"` (the longer form quoted earlier had an elision and was not literal). User rejections do not fire PostToolUse or PostToolUseFailure. A hook can only *make* the decision itself: a PermissionRequest hook on ExitPlanMode can return deny with a message, but then the user never sees the native card.

## 4. Task store

Search `function Mk(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID`:
```js
function Mk(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID;let e=cv();if(e)return e.teamName;
 return Qi()||Xs().taskList.leaderTeamName||K()}
function aP(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
function kD(e){return J(we(),"tasks",aP(e))}  function U(e,n){return J(kD(e),`${aP(n)}.json`)}
```
- **Path.** `<configHome>/tasks/<sanitized listId>/<sanitized id>.json`. `we()` is `CLAUDE_CONFIG_DIR || ~/.claude` (NFC-normalized), so **CLAUDE_CONFIG_DIR is respected**. The list id falls back in this order: env var, then team name, then teammate team, then leader team, then the **session id**. A session-id list therefore changes on /clear. A high-water-mark file also sits in the directory.
- **v5 storage backend (experimental).** When it is active (`CLAUDE_CODE_HOVER_REST` / `tengu_hover_rest`), tasks go through a key-value store (`Te.task(listId,id)`) rather than JSON files. The default is off ("this process keeps today's direct file access"). Search `where the v5 storage backend was built at start-up`.
- **Tool enablement.** Search `a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0`. The rule is `E5() = Hw() && b$()`:
  - `Hw()` is false only when `CLAUDE_CODE_ENABLE_TASKS===false`.
  - `b$()` is true for any of these:
    - a bg or job session (`jl()`);
    - a launch option set because `--tools`/`--allowedTools` names a Task tool (`JMr(OTn.some(X))`);
    - a main model that is unknown, an inference profile, or one of the **older models listed in `eHo`** (claude-3*, opus-4-0…4-7, sonnet-4-0…4-6, haiku-4-5);
    - `CLAUDE_CODE_ENABLE_TODO_TOOLS` truthy.
  - So **newer models (Opus 5.x, Fable) have no Task tools unless they opt in**. Background (`--bg`) sessions get them automatically.
- Stability: the env var names are named constants. The path layout is incidental but long-standing.

## 5. `claude --bg`, `stop`, `logs`, `agents --json`

- **Dispatch output.** Search `backgrounded \xB7 ` (the source keeps `\xB7` escaped, so a literal `·` does not match), `list sessions` or `open in this terminal`. The hint lines are built as `ue.dim("  "+cmd.padEnd(26)+desc)`, so `claude agents  list sessions` is not literal:
  ```js
  function hTe(e,r,o){...return[`backgrounded \xB7 ${ue.cyan(e)}${o?` \xB7 ${o}`:""}${r?ue.dim(` ${r}`):""}`, "  claude agents  list sessions", `  claude attach ${e}`..., `  claude logs ${e}`..., `  claude stop ${e}`...].join("\n")}
  ... process.stdout.write(hTe(g.short,g.idle?qIe:void 0,g.name)+"\n")
  ```
  - It goes to **stdout**. Line 1 is `backgrounded · <short> · <name>`, where `<short>` is the first 8 characters of the session id. Colors come from chalk, which normally turns them off when stdout is not a TTY. Errors go to stderr with exit code 1.
  - **There is no `--json` for `--bg`.** Stability: incidental, since it is display text. `room-claude.ts`'s `JOB_RE` relies on it.
- **Machine-readable list.** Search `isAgentsJsonInvocation`. `claude agents --json [--all]` prints an array of `{pid?, id(short), cwd, kind:"background"|"interactive", startedAt, sessionId, name?, status:"idle"|"waiting"|"busy", waitingFor?, state:"working"|"blocked"|"done"|"failed"|"stopped"}`. Without `--all`, finished bg jobs are filtered out. Search `pass its full session id (lowercase, as \`claude agents --json\` prints it)`. Stability: an advertised machine-readable interface (the non-TTY error suggests it), so prefer it over parsing.
- **`claude stop <id>`.** Search `Stop a background session. Its conversation is kept`. It prints `stopped <id>`, plus worktree notes, or `couldn't confirm …`.
- **`claude logs <id>`.** Search `Print the background session's recent terminal output.`. It replays recent PTY output and has no JSON form.
- **Env inheritance (important).** The daemon ingests a dispatch with `env:sRe(a,eYn)`, which keeps only allowlisted keys. Search `let{env:a,reattachEnv:h}=n.data;return{ok:!0,dispatch:{...n.data,env:sRe(a,eYn)`.
  - `eYn = new Set([...p0e, ...Ghn, "CLAUDE_CODE_AUTO_MODE_SERVER", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_BG_ISOLATION", "CLAUDE_BG_SESSION_PERMISSION_RULES", "CLAUDE_BG_MEMORY_TOGGLED_OFF", "CLAUDE_CODE_RESUME_SOURCE_ALIVE", "CLAUDE_CODE_PLUGIN_DIRS"])`. It is an exact list, **not** a `CLAUDE_BG_*` wildcard.
    - `p0e` = `CLAUDE_CONFIG_DIR`, `CLAUDE_INTERNAL_FC_OVERRIDES`, the model keys (`Qqe`: ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_{FABLE,HAIKU,OPUS,SONNET}_MODEL[_DESCRIPTION|_NAME|_SUPPORTED_CAPABILITIES], ANTHROPIC_SMALL_FAST_MODEL[_AWS_REGION], CLAUDE_CODE_SUBAGENT_MODEL, two CLAUDE_CODE_3P_PROBE_WROTE_* keys), the ANTHROPIC_CUSTOM_MODEL_OPTION* keys, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, the provider selectors (`a4`: CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD,MANTLE,GATEWAY} and their project/region keys, CLOUD_ML_REGION) and the AWS/GCP region, profile and credential-file keys.
    - `Ghn` = `PATH`, `CLAUDE_CODE_EXTRA_BODY`, `CLAUDE_CODE_HOST_CREDS_FILE`, plus every endpoint and companion from `lMe` (ANTHROPIC_BASE_URL, ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY,AWS,GOOGLE_CLOUD,BEDROCK_MANTLE}_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, the CLAUDE_CODE_SKIP_*_AUTH keys, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).
    - Not in it: `HOME`, `USER`, auth secrets (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN …), any `SUB_HUMAN_*`. The full expanded list is `DAEMON_ENV_ALLOW` in `plugin/sub-human/lib/cc.js`; `scripts/probe-cc.js` checks each name is still in the binary.
    - Literal searches: `"CLAUDE_CODE_RESUME_SOURCE_ALIVE","CLAUDE_CODE_PLUGIN_DIRS"]`, `["PATH","CLAUDE_CODE_EXTRA_BODY","CLAUDE_CODE_HOST_CREDS_FILE",`, `new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",`.
  - Workers and spares are spawned with `Vt()`, which is the **daemon's own `process.env`** (sanitized) plus that filtered env. Search `CLAUDE_CODE_SESSION_KIND:"bg",CLAUDE_BG_BACKEND:"daemon",FORCE_COLOR`.
  - The persisted `providerEnv` is filtered through the same `p0e` set. Search `stripped disallowed providerEnv key(s)`.
  - **So `CLAUDE_CODE_TASK_LIST_ID` and `CLAUDE_CODE_ENABLE_TODO_TOOLS` set in the caller's env are not forwarded** to a daemon-backed bg job. They reach the job only if the daemon itself happened to inherit them, which can happen when the caller's process cold-started a transient daemon. ENABLE_TODO_TOOLS is moot anyway, because bg sessions enable Task tools themselves.
  - Fix: pass the list id another way. One option is argv, for example `--settings '{"env":{...}}'`, which needs verifying. Another is a fallback the plugin controls.
  - Stability: allowlist constants (named sets).

## 6. Monitors

- **Schema.** Search `Arm trigger. "always" arms at session start and on plugin reload.`. `when` is `"always"` (the default) or `"on-skill-invoke:<skill>"`. `name` must be unique within the plugin, because it is the dedupe key. The command gets substitutions for `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${user_config.*}` (rejected for monitors) and `${ENV}`. Those are string substitutions only: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are **not exported as env** to the monitor. The monitor does get the shell env (`CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`).
- **Location.** It reads `manifest.experimental?.monitors ?? manifest.monitors`, falling back to `monitors/monitors.json`. Search `n.experimental?.monitors??n.monitors`. Both keys are accepted.
- **Gates.** Search `async function y4(` or `plugin monitor ${Pe}: failed to arm`. Arming is skipped when any of these holds:
  - `Gr("pluginMonitors")` (policy);
  - `!Z$()`, where `Z$()` reads GrowthBook `tengu_amber_sentinel` (default false; it is the same gate as the Monitor tool);
  - `Ae()`, a non-interactive (`-p`) session;
  - `Bw()`, or workspace trust not yet accepted.
- **Arm logic.** `S4` arms `when==="always"` on mount, and `on-skill-invoke:X` when the `skillInvoked` event fires. Dedupe uses `ct().armedMonitorKeys` (a per-process Set of `plugin:name`). A key is removed **only when arming fails**, never when the monitor exits. Consequences:
  - A fresh `claude --resume` process **does** arm always-monitors.
  - In-process /resume and /clear do not re-arm.
  - A monitor that died or was killed is **not re-armed until the process restarts**, even after plugin reload.
  - Stability: incidental.

## 7. Hook matcher, `if`, async, timeouts

Search `Invalid regex pattern in hook matcher`:
```js
function BRe(e,n,r,...){if(!n||n==="*")return!0;let _=Zho(n,r,s) ...; if(_!==void 0)return _.includes(e)||aliases...;
 try{let D=new RegExp(n);if(D.test(e))return!0; ...aliases...}catch{...return!1}}
function Zho(e,n,r){if(!(n?/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/).test(e))return;return e.split(n?/[|,]/:"|")...}
```
- An empty matcher or `*` matches everything.
- If the matcher contains only `[A-Za-z0-9_|]`, it is an **exact-name list** split on `|`. For tool events the allowed set is `[A-Za-z0-9_|, -]` and the split is on `|` or `,` (each name trimmed; a space is allowed but is not a separator). So `"Agent|Task"` means exactly Agent or Task and does **not** match TaskCreate.
- Any other matcher is a **`new RegExp(m).test(name)`: unanchored**. In `"Write|Edit|MultiEdit|NotebookEdit|mcp__plugin_sub-human_room__.*"`, `Edit` also matches any MCP tool whose name contains "Edit" or "Write". Anchor it: `^(Write|Edit|MultiEdit|NotebookEdit)$|^mcp__plugin_sub-human_room__`.
- Matching also tries tool aliases.
- **Match query per event.** SessionStart uses `source`, Notification uses `notification_type`, SubagentStart and SubagentStop use `agent_type`, UserPromptExpansion uses the command name, and TaskCreated, TaskCompleted and TeammateIdle have none.
- **`if`.** Search `Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)")`. It uses permission-rule syntax and applies only to tool events (Pre/PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied). Rule content needs the tool's `preparePermissionMatcher`. Task tools have none, so `if` can only filter on the bare tool name.
- **Per-hook fields.** Search `If true, hook runs in background and wakes the model on exit code 2`. The fields are `timeout` (seconds), `statusMessage`, `once`, `async`, `asyncRewake`, plus `rewakeMessage` and `rewakeSummary` (marked @internal).
- **Timeouts.** The default hook timeout is `Ua=600000` ms (10 min); search `var Ua=600000,Ghe=30000`. SessionEnd defaults to **1500 ms**. Its budget is the largest SessionEnd hook `timeout`, floored at 1500 ms and capped at 60000 ms, and `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides it. Search `function Zde(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` and `jeo=1500,Hho=60000`.
- **Stop `additionalContext`.** Search `case"Stop":case"SubagentStop":U.additionalContext=e.hookSpecificOutput.additionalContext`. A Stop hook that returns `hookSpecificOutput: {hookEventName:"Stop", additionalContext}` adds a `hook_additional_context` attachment and the turn continues, as with a block. A block (`decision:"block"` or exit 2) instead renders `Stop hook error: <reason>` in red (`${e} hook error: ${n.blockingError}`) and raises the "Stop hook error occurred" notification. `hooks/consent.ts` uses additionalContext for the open-review nudge. Stability: incidental.
- Stability: **API** (documented semantics).

## 8. Cross-session messaging

- **Envelope.** Search `from-session="` or `hop-chain="`:
  `<cross-session-message from="<addr>" from-session="<id>" hop-chain="a,b" from-name="<name>" from-mode="bypass|prompting" from-plugin="<p>">\n<body>\n</cross-session-message>`
  All attributes are optional and must appear in that order, because the parser regex is strict (search `(?: from-name="([^"<>\n\r]+)")?(?: from-mode="(`). A `[SendFile: …]` prefix may be spliced in after the open tag.
- **Held / mid-turn deliveries** start `Another Claude session sent a message` instead of the envelope.
- **Pastes.** A long paste arrives as `<pasted_content id="N">…</pasted_content id="N">`; search `<pasted_content id="`. Monitor and background notices arrive as prompts starting `<task-notification>`.
- **Origin.** `{kind:"peer", from, fromMode?, inbound_origin, plugin?}`. Search `kind:R("peer"),from:o(),fromMode:z(["bypass","prompting"])`.
- **UserPromptSubmit.** These messages arrive with `source:"system"`; search `\`system\` = other machine-injected turns (peer/channel messages`. Hook output can set `hookSpecificOutput.sessionTitle`. SessionStart and UserPromptSubmit inputs carry `session_title`.
- **`crossSessionInbound`.** Search `Inbound cross-session peer messages (SendMessage from your other sessions)`. Values are `accept`, `hold` and `refuse`. When unset, mode parity applies: a sender in the same permission class delivers automatically, and a mismatched sender is held. A repo can tighten the setting but not loosen it, and managed settings win.
- **Feature gate.** `CLAUDE_CODE_HARBOR_KITE` env, else GrowthBook `tengu_harbor_kite` (default true; `tengu_harbor_kite_win` on Windows). Search `function Os(){let e=a.CLAUDE_CODE_HARBOR_KITE`.
- Stability: the setting is **API**. The envelope is an internal but strict format.

## 9. subagentStatusLine, plugin settings, plugin env

- **Plugin `settings.json` allowlist.** Only `["agent","subagentStatusLine"]` are kept, via `JSONSchema.pick(Wpe).strip()`. Search `var Wpe=["agent","subagentStatusLine"]`. The loader reads `settings.json` first, then falls back to manifest `settings`.
- **Precedence.** `tWn` starts from `store.pluginBase` and then overlays **every** settings source: user, project, local, flag and policy. **Any user, project, local or flag `subagentStatusLine` overrides the plugin's.** Search `let s=e.store.pluginBase,r={};if(s)r=eF(r,s,sz);`. `Sne()` reads the merged value. Under `rh()` (managed-only), only policy settings count. If several plugins set the same key, the last loaded wins, with a log line. Search `overrides setting "${s}" (previously set by another plugin)`.
- **`${CLAUDE_PLUGIN_ROOT}` is not substituted** in the plugin settings `subagentStatusLine.command`.
  - It is run raw: `Ge(ee,[],{shell:!0,...})` with env `{...process.env, ...M0e, CLAUDE_PROJECT_DIR}`. **No CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA is set in its env either.** Search `Skipping subagentStatusLine execution - workspace trust not accepted`.
  - A `${CLAUDE_PLUGIN_ROOT}` there would expand to an empty string in the shell.
  - The current approach, `${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status`, is correct.
- **`CLAUDE_PLUGIN_DATA` export.**
  - Hooks: exported (only when the plugin has a source id). The plugin's command string also gets `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` substitution.
  - Plugin MCP stdio servers: exported in env.
  - LSP: exported, plus `CLAUDE_PROJECT_DIR`.
  - Monitors: string substitution only.
  - subagentStatusLine: no.
- Stability: the allowlist is a named constant. The missing substitution is incidental.

## 10. Official events and fields that could replace hacks

- **Full hook event list.** Search `"TaskCreated","TaskCompleted","Elicitation"`:
  > PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay.
- **SubagentStart** `{agent_id, agent_type}`. **SubagentStop** adds `agent_transcript_path` and `last_assistant_message`, plus `background_tasks[]` and `session_crons[]`. **Stop** has the same extras.
- **TaskCreated** exists and blocks: the task is deleted and TaskCreate throws.
- **PostToolBatch** fires once per batch with `tool_calls[]`.
- **SessionStart** source is `startup|resume|clear|compact|fork`. It also carries `session_title`, `model`, `agent_type`, `seconds_since_last_response` and more.
- **`permission_mode`** is present in the common hook input (optional), but TaskCreate and TaskUpdate pass undefined for it.
- **No PlanApproved or plan-reject hook event exists.** Plan approval is only visible through:
  - PostToolUse(ExitPlanMode), which fires only on approval;
  - a `plan_mode_exit` attachment;
  - a mode change (no dedicated event);
  - the rejected tool_result's `userFeedback` field in the transcript.
- **PermissionDenied** fires for auto-mode classifier denials only.
- **Early-access "hooks modules"** (function hooks). Gated by `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` or GrowthBook; search `hooks modules are not turned on for installed plugins`. Events include `agent.spawn`, `session.receive`, `session.send`, `prompt.submit`, `tool.check`, `turn.complete` and `classic.<HookEvent>`, with caps such as `store.*`, `ui.status` and `session.id`. Search `"ui.focus","agent.offer","agent.spawn"`. This would eventually replace several workarounds, but it is unstable today.

## Contract and probe

Every assumption above is an entry in `CONTRACT` in `plugin/sub-human/lib/cc.js` (id, literal search string(s), stability, note), and each export there carries `@cc <search>` and `@stability`. `node scripts/probe-cc.js [--json]` finds the installed binary (`CLAUDE_BIN`, then `claude` on PATH with symlinks resolved, then the Homebrew Caskroom), greps it for every search string and exits 1 on any miss. Search strings that embed minified names (`Mk`, `aP`, `eYn` …) are build-specific: on a new build, a FAIL there means "re-read this spot", not necessarily "the behavior changed".

## Observed: Monitor strips leading whitespace from event lines

Seen in live run penguin-3531 and confirmed with a probe Monitor: an event line `"  │ x"` reaches the model as `"│ x"`. There is no binary search string for this yet, so it is not in `lib/cc.ts` CONTRACT. Effect on the plugin: a nested chat line is marked by the `│` glyph, not by CHAT_NEST's leading spaces. Never rely on leading indentation in monitor output.
