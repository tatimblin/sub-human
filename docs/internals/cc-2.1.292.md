# Claude Code 2.1.292: what changed for sub-human

Source: `/opt/homebrew/Caskroom/claude-code@latest/2.1.292/claude` (`VERSION:"2.1.292"`), read as text with `strings -n 8` plus a regex context extractor. This note is a delta against [`cc-2.1.281.md`](cc-2.1.281.md); the § numbers below are that note's sections, and everything not listed here still reads as it does there.

On 2.1.292, 20 of the 64 `lib/cc.ts` CONTRACT entries failed the probe. 18 were renamed minified identifiers (the code is the same), and 2 changed behaviour. Neither change needed a plugin code change beyond `cc.DAEMON_ENV_ALLOW`.

> (Moved: `lib/cc.ts` is now `lib/cc/`, the entries `lib/cc/contract.json`.)

## The probe change: shapes instead of minified names

Each failing search string had a minified name in it (`cr.status`, `Mk()`, `aP`, `eYn`, `Wpe`, `Zde` …), and those names change on every build. CONTRACT entries now have two kinds of check:

- `search`: literal text only (string constants, `.describe()` text, env and property names).
- `shape` (optional): a code fragment where `~` stands for one minified identifier (`[\w$]+`) and the rest is literal. The fragment matches the structure the plugin relies on, such as a fallback order, a numeric default or a field copy, and names no identifier from the build. `cc.shapeRe` turns a shape into a RegExp, and `scripts/probe-cc.js` tests the shapes against a latin1 view of the binary. Each shape costs about 40 ms, and the full probe takes about 5 s.

`test/cc.test.js` requires a shape to keep 16 or more literal characters. The test also checks that a mutated shape fails, alongside the existing check for a mutated search string. Every shape below matches 1 or 2 places in 2.1.292.

## Per entry

**(a)** = same behaviour, only minified names or formatting moved; **(b)** = behaviour changed; **(c)** = removed.

| Entry | § | Class | Evidence in 2.1.292 | New anchors |
|---|---|---|---|---|
| `hook-exit2-blocks` | 1 | a | `if(Vo.status===2&&!zs.blockingError)zs.blockingError={blockingError:` `` `[${…}]: ${Vo.stderr\|\|"No stderr output"}…` ``. New on the next line: exit 2 with incomplete stdio also sets `suppressOriginalPrompt` (not used by us). | `"No stderr output"` + shape |
| `hook-json-block` | 1 | a | `case"block":z.permissionBehavior="deny",z.blockingError={blockingError:e.reason\|\|"Blocked by hook",command:n}` | `Valid types are: approve, block` + shape |
| `env-plugin-mcp` | 2 | a | the stdio branch of the plugin MCP config: `{CLAUDE_PLUGIN_ROOT:n.path,CLAUDE_PLUGIN_DATA:qHe(n.source),...ke.env\|\|{}}`. The LSP sibling adds `CLAUDE_PROJECT_DIR` between them, so the shape matches only the MCP site. | `.path,CLAUDE_PLUGIN_DATA:` + shape |
| `plan-mode-attachment` | 3 | a | `type:"plan_mode",reminderType:he,isSubAgent:!!r.agentId,planFilePath:h,planExists:b!==null,customInstructions:…,workshopDocPath:w,…`. A second builder (`reminderType:"full"`) adds `workshopActiveDocPath`. `planFilePath` is unchanged. | `type:"plan_mode",reminderType:` + shape |
| `exitplan-strip` | 3 | a | `var iRt=new Map([[Mu,new Set(["plan","planFilePath"])]]);function FW(e,n){…}`, still applied before the tool runs (`else st=FW(e.name,st)`). | `,new Set(["plan","planFilePath"])]])` |
| `plan-reject-dialog` | 3 | a | `if(h==="no"){if(!he&&!be)return null;return{behavior:"deny",feedback:he\|\|(be?"(See attached image)":void 0),contentBlocks:…}}`. An image-only rejection carries the note `(See attached image)`. | `"(See attached image)"` + shape |
| `plan-reject-user-feedback` | 3 | a | `cancelAndAbort(b,k,E,x){…return{behavior:"ask",…,...x?.feedbackIsFromUser&&b&&{userFeedback:b}}}`; the tool_result message is built with `userFeedback:hn.behavior==="ask"?hn.userFeedback:void 0`; the message serializer writes `…toolDenialUnanswered:Te,userFeedback:Ce,toolResultRemedy:xe,mcpMeta:Pe…` (the `toolDenialUnanswered` field is new). The ExitPlanMode reject still goes through the generic dialog `deny` case → `cancelAndAbort(v.feedback,…,{feedbackIsFromUser:!0})` (only the account-memory dialog has its own `declineMessage`). `cc.planFeedback` needs no change. | `?.feedbackIsFromUser&&` + 2 shapes |
| `task-list-id` | 4 | a | `function xw(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID;let e=cA();if(e)return e.teamName;return El()\|\|Di().taskList.leaderTeamName\|\|K()}`: same fallback order. | `CLAUDE_CODE_TASK_LIST_ID)return ` + shape |
| `task-path` | 4 | a | `function PR(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}function pD(e){return re(we(),"tasks",PR(e))}function z(e,n){return re(pD(e),`${PR(n)}.json`)}` | sanitizer literal + shape covering the path |
| `daemon-env-filter` | 5 | a | `let{env:a,reattachEnv:h}=n.data;return{ok:!0,dispatch:{...n.data,env:t1e(a,qRr),reattachEnv:h&&t1e(h,hdt)}}`; `t1e` is an exact, case-sensitive key pick. Also new: `bor`/`DIn` drop entries with an invalid name, a non-string value or a NUL in the value (with a log line). | `daemon_bg_dispatch_ingest` + shape |
| `daemon-env-allowlist` | 5 | **b** | The allowlist grew; nothing was removed. See [below](#daemon-env-allowlist-b). | JSON of `cc.ts`'s own key arrays + 2 shapes |
| `monitor-arm-gates` | 6 | a, one gate added | `async function iZ(…){if(Gr("pluginMonitors"))return;if(!gG())return;if(Ee())return;…}` with `function gG(){return C("tengu_amber_sentinel",!1)}`. The per-monitor arm (`ESt`) now also returns early when managed `policySettings.disableAllHooks` is true (`Vb()`), and still skips an untrusted workspace (`Skipping plugin monitor … - workspace trust not accepted`). Either early return deletes the dedupe key. A monitor that exits still never re-arms (`monitor-not-rearmed`). | `: failed to arm: `, `"tengu_amber_sentinel",!1)}`, `Skipping plugin monitor ` + shape |
| `hook-timeout-default` | 7 | a | `var td=600000,eVe=30000,…`; used as `e.timeout?e.timeout*1000:td` (sync and `asyncTimeout`). | `asyncTimeout:e.timeout?e.timeout*1000:` + shape `var ~=600000,~=30000,` |
| `stop-additional-context` | 7 | a | `case"Stop":case"SubagentStop":z.additionalContext=e.hookSpecificOutput.additionalContext`; the Stop loop: `let pe=s.agentId?"SubagentStop":"Stop",ge=rn({type:"hook_additional_context",content:ce.additionalContexts,…})` and the turn continues. A block still renders `${e} hook error: ${n.blockingError}` and `Stop hook error occurred`. | `{type:"hook_additional_context",content:` + 2 shapes |
| `session-end-budget` | 7 | a | `function hEe(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;if(e!==void 0)return e;…for(let h of g.hooks)if(h.timeout&&h.timeout*1000>n)n=h.timeout*1000;return Math.max(Nqo,Math.min(n,Mpr))}` with `var Nqo=1500,Mpr=60000`. The hook list it scans is settings plus plugin SessionEnd hooks (plugin hooks are left out under managed-only hooks). | env literal + 2 shapes |
| `peer-origin` | 8 | a | `u({kind:R("peer"),from:o(),fromMode:W(["bypass","prompting"]).optional().describe("The SENDING session's permission class …")})` | the new `.describe()` text + shape |
| `harbor-kite-gate` | 8 | a | `function vi(){let e=a.CLAUDE_CODE_HARBOR_KITE;if(e!==void 0)return Le(e);if(O()==="windows"&&!C("tengu_harbor_kite_win",!0))return!1;return C("tengu_harbor_kite",!0)}`: still on by default. A sibling flag `tengu_cuddly_willow` gates the claude.ai projects/bridge relay, not local peers. | `"tengu_harbor_kite",!0)` + shape |
| `plugin-settings-allowlist` | 9 | a | `var dYr=["agent","subagentStatusLine"]`; plugin settings now parse through `u(Object.fromEntries(dYr.map((e)=>[e,Yye(e)])))`, a zod object that strips unknown keys. This replaces `JSONSchema.pick(Wpe).strip()` with the same effect. It still reads `settings.json` first, then manifest `settings` (`Loaded settings from settings.json/manifest for plugin …`). | `=["agent","subagentStatusLine"];` + both log lines |
| `subagent-statusline-precedence` | 9 | a | `R_r(e){…e.store.isLoadingFromDisk=!0;try{let s=e.store.pluginBase,r={};if(s)r=mU(r,s,pK);…}` then every settings source overlays it. Reads go through `vXt("subagentStatusLine")` (merged), or policy only under managed-only. | `settings_load_started` + shape |
| `hooks-modules` | 10 | **b** | Gating changed: default on for installed plugins. An installed plugin names its module in `hooks.json` `modules`. See [below](#hooks-modules-b) and [Function hooks](#function-hooks). | rollout flag name, its log line, `"hooks/register.ts"`, `"ui.focus","agent.offer","agent.spawn"` |

### daemon-env-allowlist (b)

2.1.292 builds the dispatch allowlist as `qRr = new Set([...zWe, ...dWn, <extras>])`:

- `zWe` = `CLAUDE_CONFIG_DIR`, `CLAUDE_INTERNAL_FC_OVERRIDES`, `...V8r` (model keys `oit` + custom model keys `vLn` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`), **`CLAUDE_CODE_CLIENT_DATA_URL`** (new), `...O6` (provider selectors), then the AWS/GCP keys.
- `oit` gained **`CLAUDE_CODE_3P_PROBE_WROTE_HAIKU_DEFAULT`, `CLAUDE_CODE_3P_SEEDED_SONNET_DEFAULT`, `CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT`**.
- `dWn` = `PATH`, `CLAUDE_CODE_EXTRA_BODY`, `CLAUDE_CODE_HOST_CREDS_FILE`, `...ILe` (the endpoints and companions of `Mqe`; unchanged).
- The extras gained **`CLAUDE_CODE_DISABLE_PROACTIVITY`, `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`, `CLAUDE_CODE_AUTO_MODE_TIER`, `CLAUDE_BG_AUTO_MEMORY_OFF`**: `"CLAUDE_CODE_DISABLE_PROACTIVITY","CLAUDE_CODE_AUTO_MODE_SERVER","CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS","CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS","CLAUDE_CODE_AUTO_MODE_TIER","CLAUDE_BG_ISOLATION","CLAUDE_BG_SESSION_PERMISSION_RULES","CLAUDE_BG_MEMORY_TOGGLED_OFF","CLAUDE_BG_AUTO_MEMORY_OFF","CLAUDE_CODE_RESUME_SOURCE_ALIVE","CLAUDE_CODE_PLUGIN_DIRS"`.
- The persisted `providerEnv` filter is still `zWe`. It now also drops `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and `CLAUDE_CODE_HOST_GATEWAY_LINEAGE` unless their value is truthy (`z8r`).

Still not on the list: `HOME`, `USER`, `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, any `SUB_HUMAN_*`, and auth secrets. The room's Claude therefore still has to get its list id from `--settings` env, as it does now.

**Fix.** `cc.DAEMON_ENV_ALLOW` now copies the 2.1.292 list: `EXTRA_KEYS` is a new array, and `MODEL_KEYS` and the `zWe` part have the new keys. `room Claude.cleanEnv` (the room's Claude spawn's `KEEP_ENV`: the login basics plus `cc.daemonEnv`) now forwards those keys from the joiner's env, so a user who sets, for example, `CLAUDE_CODE_DISABLE_PROACTIVITY` gets it in the room's Claude too, as the daemon would. The CONTRACT entry now searches for `JSON.stringify` of `cc.ts`'s own arrays, so any key the binary adds, drops or reorders fails the probe instead of passing silently. The derived `daemon-env-names` check still covers the endpoint keys. Tests: `cc.test.js` (the new keys are in the allowlist) and `room-claude.test.js` (a new key reaches the spawn env).

### hooks-modules (b)

2.1.281 gated hooks modules behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` or GrowthBook, and logged `hooks modules are not turned on for installed plugins`. That message is gone in 2.1.292. The gate is now:

```js
var _P="tengu_plugin_hooks_modules"; … var cD=!0;            // rollout flag, default ON
function kor(){let e=C(_P,cD),o=e!==cD,r=o&&E();if(o)JWe();return r?cD:e}
var SP=()=>!mt()&&!D()&&kor();                               // not diskless, not a tool-server daemon
var Tzt=()=>SP()&&!Gr("hooks")&&!Rr();                       // not hooks-disabled by policy, not safe mode
var Cor=()=>Tzt()&&!Vb()&&!Dy();                             // not managed disableAllHooks / allowManagedHooksOnly
function brr(){if(SP())return!1;return t(`installed plugins' hooks modules not loaded: rollout flag (${_P}) is off, `+…),!0}
```

- When the flag comes back off from a disk cache or payload, it can be held or loaded late (`installed plugins' hooks modules held …ms for the rollout flag` / `load late`).
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` now appears only in two env-name lists. Nothing reads it as a gate.
- `hooks/register.ts` (`` var ye="hooks/register.ts";var Yo=(e)=>`builtin:${e}/${ye}` ``) is the **built-in** plugins' fixed module path. An installed or `--plugin-dir` plugin names its one module in `hooks/hooks.json` under `modules` (`modules:b.modules??[]`), relative to that file; a file named `hooks/register.*` that hooks.json does not name is not loaded. (An earlier version of this note said installed plugins load `hooks/register.ts`; that was wrong.)
- Built-in plugins load regardless, and `--bare`, safe mode and managed policy switch modules off for installed plugins.
- The event and cap names (`"ui.focus","agent.offer","agent.spawn"` …) are still there.

**Effect on sub-human.** None until a module ships. The plugin's `hooks.json` has no `modules`, so nothing new loads. `cc.test.js` ("the plugin ships at most one hooks module, at the path hooks.json names") checks that `modules` has at most one entry, that the named file exists, and that no stray `hooks/register.*` sits beside it. Adopting modules was planned in [`docs/archive/MODS-PLAN.md`](../archive/MODS-PLAN.md); what W0 measured is in [Function hooks](#function-hooks).

## Currently passing entries: re-checked

The 44 entries that still passed were read again at their 2.1.292 sites. They mean what the 2.1.281 note says:

- TaskUpdate's completed path still returns `success:!1,updatedFields:[]` before `cae(…)` (the write).
- TaskCreate still deletes the task and throws on a block.
- TaskCompleted input is unchanged apart from a deprecated `team_name`.
- The matcher query still returns nothing for TaskCreated, TaskCompleted and TeammateIdle.
- `aWe` (was `M0e`) still sets `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`.
- MCP stdio env is unchanged, and so are /clear's `process.env.CLAUDE_CODE_SESSION_ID` update, the nested-claude strip, the pkill guard, the ExitPlanMode schemas and the `plan-reject-text` prose.
- PermissionDenied still fires only for auto-mode classifier denials.
- v5 task storage is still off by default (`C("tengu_hover_rest",!1)`).
- `MW()` still gates Task tools on old models, bg sessions or `CLAUDE_CODE_ENABLE_TODO_TOOLS`.
- `--bg` stdout, `agents --json` fields, `stop` and `logs` are unchanged. `stop` gained a `kill` alias, `logs` takes `<id|name>`, and there is a new `respawn` command.
- Monitors: the schema, the location and `armedMonitorKeys` are unchanged.
- Hooks: the matcher rule, `if` and `async`/`asyncRewake` are unchanged.
- The envelope order and the held prefix are unchanged.
- UserPromptSubmit `source` gained `loop_wakeup`, `schedule_wakeup` and `poll_event`; `system` still means peer, channel, notification and auto-continuation.
- `crossSessionInbound` is unchanged, and so are the plugin-settings override log and the `subagentStatusLine` exec env (`{...ss(),...aWe(…),CLAUDE_PROJECT_DIR}`, with no `CLAUDE_PLUGIN_ROOT`/`DATA`).
- The hook event list has the same 33 events.

Some of these passing searches still named minified identifiers. They were rewritten the same way (literal plus shape): `task-completed-input`, `env-mcp-session`, `env-nested-strip`, `todo-tools-gate`, `monitor-location` and `plugin-setting-override-log`. `hook-events` now searches for a run (`"Setup","TeammateIdle",…`) that only the full event list has, because the old run also matched an unrelated `mcp_tool` event set.

## Function hooks

What the [mods plan](../archive/MODS-PLAN.md) W0 spikes measured on 2.1.292 (2026-10-07). Method: a throwaway plugin (`hooks.json` with a command `UserPromptSubmit` + `SessionStart` hook and `"modules": ["./register.mjs"]`, the entry importing `../mod/x.mjs`) under `$TMPDIR/sh-mods-spike/`, loaded with `--plugin-dir` in `-p` runs, one `--bg` job and two interactive tmux sessions. Each hook appended a JSON line to a log file. The CONTRACT entries are in `lib/cc.ts` §10 (and `prompt-origin-composer` in §8).

> (Moved: the entries are in `lib/cc/contract.json`.)

| # | Question | Answer | Evidence | CONTRACT |
|---|---|---|---|---|
| S1 | Command hooks and a module in one `hooks.json`; both fire? | **Yes** | `claude plugin validate --strict` passes; the log has `cmd.SessionStart` + `mod.session.start` and `mod.classic.UPS` + `cmd.UserPromptSubmit`. A module `classic.UserPromptSubmit` that answers without `next` skips the command hook (no `cmd.*` line). | `hooks-json-modules`, `classic-chain-order`, `module-dollar-local` |
| S2 | Modules in a `--bg` worker and in `-p`? | **Yes, both** | The `--bg` job logged `mod.session.start` (`isInteractive:true`, parent `claude`), `prompt.submit`, `classic.UPS`, `classic.Stop`. `-p` logs the same with `isInteractive:false`. The `--bg` dispatch prompt's origin is `composer`; `-p` is `sdk`. | `modules-headless`, `prompt-origin-composer` |
| S3 | Env and ppid of a `$.process.run` child | ppid = the claude pid; **no `CLAUDE_PID` / `CLAUDE_CODE_SESSION_ID` of this session**, no `CLAUDE_PLUGIN_ROOT` | `PPID=<claude pid>`, `CLAUDE_PID=unset SID=unset ROOT=unset` from a clean env. Run from inside another Claude session, the child had the *outer* session's `CLAUDE_PID` and session id (host env, `extendEnv:!1` over `{...hostEnv,...init.env}`). Shims must pass the payload `session_id` and `CLAUDE_PLUGIN_ROOT` and must not trust an inherited `CLAUDE_PID`. | `process-run-stdin` |
| S4 | `$.session.append` notice drawn, kept on `--resume`; user row wakes? | **Partly.** Stored and kept on resume, but **not drawn in the default view**: level `"info"` shows only in ctrl+o. A user row (isMeta) does **not** wake an idle session. `$.ui.log` **is** drawn (dim, `"<plugin>: <text>"`, level `"notice"`), is stored, and is redrawn after `--resume`. | JSONL rows `type:"system",subtype:"informational",level:"info"` vs `level:"notice"` for `$.ui.log`; default pane shows only the `ui.log` line; ctrl+o shows both; four appends started no turn. | `session-append-note`, `session-append-notice-hidden`, `ui-log-notice` |
| S5 | `classic.Stop` → `{additionalContext}` continues; `classic.UserPromptSubmit` → `{preventContinuation, stopReason}` draws "✓ sent"? | **Yes, both** | `-p` "reply OK" + Stop context "reply CONTINUED" → result `CONTINUED`, two `classic.Stop` (`stop_hook_active` false, then true). Interactive: `❯ SPIKE_SENT hi` / `⏺ Operation stopped by hook: ✓ sent`, as the command hook draws it, no model call. | `classic-chain-order` (+ existing `stop-additional-context`) |
| S6 | Order; `prompt.submit` for a peer mid-turn? | `prompt.submit` → `classic.UserPromptSubmit` (module) → command hook. **Yes** mid-turn: origin `peer`, `turnId` set, delivered at the running tool's end, same chain. | Log order per prompt; a `$.session.send` from another session while B ran a 20 s Bash: `prompt.submit` `{kind:"peer"}` with `turnId`. `$.session.send` arrives as `peer` (not `peer-send-message`). | `prompt-submit-ups-order` |
| S7 | `tool.call` for a subagent's calls, with `agentId`? | **Yes** | `{tool:"Agent",agentId:null}` then `{tool:"Bash",agentId:"a3449b83ebdc7e9ee"}`. | (d.ts `AgentLoop.agentId`) |
| S8 | `claude plugin test` with Node 24 on PATH; a "modules off" gate? | **Yes** | Node v24.15.0: `1 pass … Ran 1 test across 1 file` (exit 0), exit 1 on a failing test. With modules off (a throwaway `CLAUDE_CONFIG_DIR` whose settings set `disableAllHooks`) it prints `claude plugin test: hooks modules are turned off here (…)` and exits 1, which `npm test` can read as a skip. `CLAUDE_INTERNAL_FC_OVERRIDES` is ignored in this build (`getEnvironmentOverrides(){return null}`). | `plugin-test-discovery`, `plugin-test-off` |
| S9 | Latency of a `$.process.run` node child vs the same command hook (20 runs) | `$.process.run`: median **26 ms** (min 25, p90 34). Command hook (measured as the module's `await next(e)` around it): median **35 ms** (min 32, p90 41). | `performance.now()` in the module, 20 `-p` runs, no model call (the hook stopped each prompt). | — |

Other findings:

- **`$` never crosses an import.** A module that passes `$` to a function imported from another file does not load (`hooks module did not load: … $ is passed to "note", imported from "../mod/x.mjs": $ is followed only into a function declared in this same file, never across an import`), and the prompt then runs unhooked. So `mod/core/*.ts` stays pure, and the shim's `$.process.run` call sits in each registering file (a local helper there is fine).
- **The engine writes into a `--plugin-dir` plugin.** Loading a plugin with a module lays `.claude-plugin/types/` (with its own `.gitignore`) and a root `tsconfig.json` (`{"extends": "./.claude-plugin/types/tsconfig.json"}`). The demo loads `plugin/sub-human` with `--plugin-dir`, so W1 had to decide whether to commit or ignore `tsconfig.json`: both are gitignored.
- **Hot reload.** Saving a file in a watched `--plugin-dir` reloads the module (`⏺ <plugin>: reloaded (N hooks: …)`) and re-runs `session.start`.
- **`$.session.send`** goes through `tool.call` `SendMessage` in the sender and resolves `{isDelivered:true}`.
- **`$.ui.log` is one line.** A newline in the text is drawn as U+FFFD (seen live while building delivery), so `mod/deliver.ts` logs a chat batch line by line. CONTRACT `ui-log-notice`.
- **Test kit.** A test answers a `$` call beneath the plugin with `on('process.run', () => ({ value: … }))` (a bare result is refused: "returned neither { value } nor { deny }"), and a classic event with nothing beneath needs `on('classic.<Event>', …)` ("no implementation for classic.UserPromptSubmit").

W1 findings (2026-10-07, while building the module; [mods plan](../archive/MODS-PLAN.md) W1 results):

- **A notification row's text is its summary.** For `origin.kind` `task-notification`, `UserMessage` `props.text` is the `<summary>` (a monitor's reads `Monitor event: "sub-human room"`), not the `<event>` body. The engine parses the body itself and draws its first line as the row's headline (`monitorEvent:re===h?Ae:null`), so a hook that rewrites the text loses that headline and still has no chat lines to draw. sub-human leaves those rows to the engine. CONTRACT `usermessage-notification-summary`.
- **`$.state` needs a types contract.** `claude plugin validate` refuses a `$.state` read or write the plugin's own contract does not declare (`… is not declared: the manifest's types contract must name it in interface PluginState { … }`). The contract is a self-contained `.d.ts` named by `plugin.json` `"types"`. CONTRACT `plugin-types-state`.
- **Validate lists gates.** Its `--json` report has `gatingHooks: [{module, pattern, hook, hasCatch}]`; `classic.*` hooks count as gates too. The `hooks:` note lists each registered hook with its matcher, which `test/mod-core.test.js` compares with `mod/register.ts` `HOOKS`.
- **Test kit.** The test's `$` has no `state` noun (read a value through the behaviour that depends on it). Every `on(...)` beneath must be registered before the test's first `$` call. A deny from a plugin's `tool.call` reaches the test's `$.tool.call` as `{ deny }`. `$.fs.stat`, `$.session.id`, `$.session.cwd` and `ui.render` need an answer beneath (`{ value }` or `{ deny }`), or they fail with "no implementation".
- **Live (`-p`, `--plugin-dir`, throwaway home).** The module loaded, `session.start` ran `mod-hello.ts` (lease written, 0600), and `tool.call` denied `cat ~/.sub-human/…` before the permission check (`--allowedTools Bash`): the model read the ROOM-GUARD reason as the tool's error.

## Review spikes R0

What the [review plan](../archive/REVIEW-PLAN.md) R0 spikes found on 2.1.292 (2026-10-07). S-skip is a live run; S-title and S-mcp are binary reading (`/tmp/cc292/bin.txt`, `VERSION:"2.1.292"`). Hit counts are for a latin1 view of the binary; a shape uses `~` as in `cc.shapeRe`. R2 C1 turned the strings below into CONTRACT entries (`classic-chain-order` rewritten; `mcp-stdio-ppid`, `mcp-progress-resets-idle-timeout`, `mcp-server-shared-by-subagents` and `session-title-address` added, the last with the name-uniqueness strings folded in), each with a mutated-string test in `test/cc.test.js`.

### S-skip: what a module's `classic.PreToolUse` answer without `next` skips (review M5)

Method: four throwaway plugins under `$TMPDIR/sh-review-spike/`, each with a `PreToolUse` command hook on `Bash` that appends a line to `spike.log`. `spike-skip` adds a module whose `classic.PreToolUse` `{tool:'Bash'}` hook logs and answers `{}` without `next` (as `mod/consent.ts` does on the room tools). `spike-pass` and `spike-otherpass` have the same hook calling `next(e)`. `spike-other` has the command hook only. A user-level `PreToolUse` `Bash` command hook sat in a throwaway `CLAUDE_CONFIG_DIR` (`$TMPDIR/sh-review-spike/cfg/settings.json`). Auth came from the real keychain entry without touching `~/.claude`: `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` makes the secure-storage lookup use `~/.claude` while everything else uses `CLAUDE_CONFIG_DIR` (`function rw(){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(e!==void 0)return(e||u(o(),".claude"))…`). Each run was `claude -p "Run … echo spike-<run> … reply DONE" --allowedTools Bash --plugin-dir …` from a clean env (`env -i`), cwd `/private/tmp/sh-review-spike-cwd`. Every run's transcript has the Bash result, so the tool ran each time.

| Run | `--plugin-dir` order | Hooks that ran on the Bash call |
|---|---|---|
| control | `spike-pass`, `spike-other` | `spike-pass` module (before), `spike-other` cmd, `spike-pass` cmd, user cmd, `spike-pass` module (after) |
| skipAB | `spike-skip`, `spike-other` | `spike-skip` module **only** |
| skipBA | `spike-other`, `spike-skip` | `spike-skip` module **only** |
| modAB | `spike-skip`, `spike-otherpass` | `spike-skip` module **only** (`spike-otherpass`'s module never ran) |
| modBA | `spike-otherpass`, `spike-skip` | `spike-otherpass` module (before), `spike-skip` module, `spike-otherpass` module (after); no command hook |

**Answer.** A module that answers `classic.PreToolUse` without `next` skips **every non-managed settings hook** for that call: its own plugin's command hooks, **every other plugin's command hooks**, and **the user's (and project's) settings hooks**. Command-hook skipping does not depend on load order. Other plugins' **modules** do: a module loaded before sub-human's sits above it and still runs; one loaded after sits beneath and is skipped. With `--plugin-dir`, the first directory given is the outermost. Managed (policy) hooks are not skipped: they run above every module.

Why, in the binary: the PreToolUse chain is `[managed, ...modules in load order, core]`, and `core` is one handler that runs all the other settings hooks.

- Chain: shape `{managed:~,pass:~,covers:~}=~(~,~),{core:~,runs:~}=~(~,~),~=await ~(~(~.tool_name,~.tool_use_id,~),[~,...~("classic.PreToolUse",~),~]` (1 hit; `…[b,...cO("classic.PreToolUse",g),G]`). The shorter shape `[~,...~("classic.PreToolUse",~),~]` also has 1 hit.
- Core handler: shape `{name:"core",isCore:!0,budgetMs:0,async run(~){let ~=~(~),~=await ~(~(~,{managedHooksExcluded:~(~)}),~.tool)` (1 hit). This means every settings hook except the managed ones.
- Managed handler: literal `isManaged:!0,budgetMs:0,async run(` (4 hits). It runs `{managedHooksOnly:!0}` first and calls the chain beneath it.
- Module order: `cO` → `BZe`, which walks `lt().loadedModules` in order (shape `(~??~().loadedModules).flatMap((~)=>{if(!~.hooks(~)||~.name!==(~??~.name))return[]`, 1 hit).
- The d.ts says the same: "The chain is [managed settings hooks, ...hooks modules, the other settings hooks as core], so a managed block ends it above every module" (`ClassicEventOf`).

So the `classic-chain-order` CONTRACT note ("the plugin's own command hooks") understates it. Today `mod/consent.ts` skips other plugins' and the user's `PreToolUse` hooks on `mcp__plugin_sub-human_room__*` while no review is open. Only hooks whose matcher covers those tools are affected, such as `.*`, `mcp__.*` or `*` (plan Q4).

### S-title: how `SendMessage` and `ListAgents` reach a session by its title (review M4)

**Answer.** A hook's `sessionTitle` renames the session itself, and that name is the address.

1. A `UserPromptSubmit` (or `SessionStart`) hook's `hookSpecificOutput.sessionTitle` is applied by `Jyt`. It returns early in a teammate (`gc()`) and when the title already equals the current one. It then logs `Hook sessionTitle applied (N chars)` and calls the rename with source `"hook"`. Search: literal `Hook sessionTitle applied (` (2 hits); shape ``Hook sessionTitle applied (${[...~].length} chars)`),await ~(~,"hook",~,!1,!1,~)`` (1 hit).
2. The rename (`X2t` → `iEe`) writes the transcript title and then the **session registry record** (`Qj`: `hn({name,nameSource,formerNames,nameSince,…})`, the pid file other sessions read). Its failure path logs literal `applied locally but the session registry record was not updated` (1 hit). The `"hook"` source is kept as `"hook"` (`peer` and `collision` also map to it). Shape: `return ~==="collision"||~==="peer"?"hook":~}` (1 hit).
3. `ListAgents` lists other local sessions from that registry (`listAllPeers`: `transport:"uds"`) by their `name`. Its description: literal `Names are the address: send with` (1 hit). `SendMessage` resolves `to` by exact name match against live agents and sessions. Its description: literal `the name IS the address; there is no separate address syntax` (1 hit). An in-process agent with the same name wins over a session.
4. **Names are unique among live sessions** (GrowthBook `tengu_session_name_uniqueness`, default on: literal `"tengu_session_name_uniqueness",!0)`, 1 hit). If another live session already holds the name, this session takes a suffixed one (`NAME-word-word`) and logs `[session-name] "<name>" is held by live pid <pid>; this session takes "<new>"` (literal `" is held by live pid `, 2 hits). Two seats with the same `NAME.CODE` would therefore not share an address. The second one gets a name that `SendMessage` "NAME.CODE" does not reach.

### S-mcp: the room MCP server's process, timeout and sharing (review M3)

**(a) A stdio server is a direct child of the claude process: yes, unless the user sets `CLAUDE_CODE_SHELL_PREFIX`.** The MCP SDK's stdio transport spawns the command with `shell:!1` (literal `stdio:["pipe","pipe",this._serverParams.stderr??"inherit"],shell:!1`, 2 hits, one per bundled SDK copy). Claude Code's connect passes `command` and `args` as configured: shape `let ~=~.CLAUDE_CODE_SHELL_PREFIX||~.command,` (2 hits). With `CLAUDE_CODE_SHELL_PREFIX` set, the prefix is spawned with the quoted command line, so `process.ppid` is the prefix process, not claude. The Linux tool-cgroup wrapper keeps the pid, because it ends in `exec`: literal `{ echo 0 > "$0"/cgroup.procs; } 2>/dev/null; exec "$@"` (2 hits). The server's env also carries `CLAUDE_CODE_SESSION_ID` as it was at spawn: shape `CLAUDE_CODE_SESSION_ID:~(),CLAUDECODE:"1",...~.env` (2 hits). It goes stale after `/clear`, so the ppid lookup stays the right identity.

**(b) `notifications/progress` resets the tool *idle* timeout: yes; it does not extend the wall-clock limit.** A `tools/call` has two timers:
- An **idle watchdog**, checked every 30 s, that aborts after no response or progress. Its default is 30 min for stdio and 5 min for other transports, and IDE/SDK servers are exempt. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` overrides it (0 turns it off), and a larger per-server `timeout` raises it. Each progress notification sets its clock to now: shape `onprogress:(~)=>{if(~.armedAt=0,~=Date.now(),` (2 hits). Defaults: shape `var ~=300000,~=1800000,~=new Set(["sse-ide","ws-ide","sdk"])` (2 hits) and shape `~.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT??(~==="stdio"?~:~)` (2 hits). Error texts: literals `aborting: no response or progress notification for ` (3 hits) and `sent no response or progress for ` (3 hits).
- A **wall-clock limit**: `MCP_TOOL_TIMEOUT`, or else `1e8` ms (about 27.8 h), or the per-server `timeout`. Progress does not extend it, and Claude Code does not pass the SDK's `resetTimeoutOnProgress`. Shape `.MCP_TOOL_TIMEOUT??~;return Math.min(Math.max(~,1000),~)}` (2 hits; `~` = `Pr`, `var … Pr=1e8` in the same chunk). Literal `Hard wall-clock limit per call; progress notifications do not extend it.` (2 hits).

`mcp/hold.ts`'s 20 s progress beat (`HOLD_BEAT_MS`) therefore keeps the idle watchdog from firing. A hold still ends at the wall-clock limit (about 27.8 h by default, sooner if the user sets `MCP_TOOL_TIMEOUT`).

**(c) One server instance serves the main thread and its subagents: yes.** A subagent whose definition has no `mcpServers` gets the parent's clients as they are: shape `if(!~.mcpServers?.length)return{clients:~,agentClients:[],tools:[],cleanup:async()=>{}}` (1 hit). A subagent whose definition lists `mcpServers` gets the parent's clients plus its own: shape `return{clients:[...~,...~],agentClients:~,tools:~,cleanup:~}` (1 hit). sub-human's agents (`room Claude`, `room`, `participant`) name the room tools in `tools:` and have no `mcpServers`, so their room calls reach the same server process as the main thread's. In that process, `process.ppid` is the main claude pid.

### Search strings (now in the CONTRACT)

| CONTRACT id (proposed) | `search` (literal) | `shape` |
|---|---|---|
| `classic-chain-order` (rewrite the note) | `function-hook chain\`` (kept), `isManaged:!0,budgetMs:0,async run(` | `[~,...~("classic.PreToolUse",~),~]`; `{name:"core",isCore:!0,budgetMs:0,async run(~){let ~=~(~),~=await ~(~(~,{managedHooksExcluded:~(~)}),~.tool)` |
| `session-title-address` | `Hook sessionTitle applied (`, `Names are the address: send with`, `the name IS the address; there is no separate address syntax`, `applied locally but the session registry record was not updated` | ``Hook sessionTitle applied (${[...~].length} chars)`),await ~(~,"hook",~,!1,!1,~)`` |
| `session-name-unique` (informational, or a note on the entry above) | `"tengu_session_name_uniqueness",!0)`, `" is held by live pid ` | — |
| `mcp-stdio-ppid` | `stdio:["pipe","pipe",this._serverParams.stderr??"inherit"],shell:!1`, `{ echo 0 > "$0"/cgroup.procs; } 2>/dev/null; exec "$@"` | `let ~=~.CLAUDE_CODE_SHELL_PREFIX||~.command,` |
| `mcp-progress-resets-idle-timeout` (renamed from `mcp-progress-resets-timeout`: only the idle timer resets) | `aborting: no response or progress notification for `, `Hard wall-clock limit per call; progress notifications do not extend it.` | `onprogress:(~)=>{if(~.armedAt=0,~=Date.now(),`; `~.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT??(~==="stdio"?~:~)` |
| `mcp-server-shared-by-subagents` | — (no stable literal) | `if(!~.mcpServers?.length)return{clients:~,agentClients:[],tools:[],cleanup:async()=>{}}`; `return{clients:[...~,...~],agentClients:~,tools:~,cleanup:~}` |

Every shape above keeps 16 or more literal characters. The `mcp-server-shared-by-subagents` entry has no literal in its own code. For a `search` it could use `Skipping frontmatter MCP servers: blocked by ` (2 hits, the same function) if C1 wants one.

## Out of the CONTRACT (review R2)

The CONTRACT now lists only what plugin code relies on. These entries came out on 2026-10-07 (all passed the 2.1.292 probe when removed).

**Informational: still true, but no code cites them.** Kept here with their search strings so they can be re-checked by hand (`grep -c` on a latin1 view of the binary).

| Former id | § (2.1.281 note) | Search | What it says |
|---|---|---|---|
| `hook-missing-script` | 1 | `Hook script appears to be missing` | Stop, SubagentStop, TaskCompleted, TeammateIdle (and a plugin UserPromptSubmit): exit 2 with empty stdout and a "no such file" / "can't open" stderr is non-blocking. |
| `task-completed-teammate-stop` | 1 | `TaskCompleted hook prevented continuation` | Agent teams: a teammate's Stop fires TaskCompleted for each in_progress task it owns. |
| `task-created-block-deletes` | 1 | `TaskCreated hooks cancelled (control stream closed)` | A TaskCreated block deletes the task and throws. |
| `pkill-guard` | 2 | `pkill: refusing to run` | The Bash pkill wrapper refuses a pattern that matches CLAUDE_PID. |
| `plugin-setting-override-log` | 9 | `overrides setting "${`, `" (previously set by another plugin)` | The last plugin loaded wins a setting two plugins set. |
| (none: native text) | 3 | `to update hooks`, `if(t?.startsWith("plugin"))return"plugin hooks.json"` | A hook `ask` dialog (our plan-view review: Pre(ExitPlanMode) `ask`) prints the hook's reason, then a dim config hint `${source} to update hooks`. The source is the hook's `hookSource`: "plugin…" gives "plugin hooks.json", none gives "settings.json". Our command hook's ask comes with no hookSource, so the plan view shows a stray `settings.json to update hooks` line under our hint (live runs 2026-10-08). It is Claude Code's text; the plugin cannot change it. |

**Removed with their test-only code.**

- `peer-envelope` (`from-session="`, `hop-chain="`, `(?: from-name="([^"<>\n\r]+)")?(?: from-mode="(`): the `<cross-session-message>` attribute order. `cc.parseEnvelope`, `ENVELOPE_RE` and `ATTR` went with it; nothing parsed envelopes.
- `hook-timeout-default` (`asyncTimeout:e.timeout?e.timeout*1000:`, shape `var ~=600000,~=30000,`): the 600 s default hook timeout. `cc.HOOK_TIMEOUT_DEFAULT_MS` went.
- `session-end-budget` (`.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;if(e!==void 0)return e;`, shapes `if(~.timeout&&~.timeout*1000>~)~=~.timeout*1000;return Math.max(~,Math.min(~,~))}` and `var ~=1500,~=60000,`): SessionEnd's budget, the env override else the largest hook timeout clamped to [1500, 60000] ms. `cc.sessionEndBudgetMs` and `SESSION_END_*` went.
- `cc.logsCmd` (the `bg-logs` entry stays: the demo's room Claude view runs `claude logs`), and the unused `cc.ENV` keys `ENABLE_TODO_TOOLS`, `SESSION_END_TIMEOUT`, `PLUGIN_ROOT`, `PLUGIN_DATA` and `PROJECT_DIR`.

## Command replies (0.5.0-beta.7)

Read from the 2.1.292 binary for the message pass (`docs/next/COMMANDS-REVIEW.md`, "Messages: 5 rules"): how can `/sub-human` show the person its answer without "blocked by hook", and keep a PIN away from the model? CONTRACT `command-run-every-command`, `command-run-empty-answer`, `expansion-block-frame`, `modules-switch-cache`.

| Output | How it is drawn | Does the model read it? |
|---|---|---|
| UserPromptExpansion `decision:"block"` | a warning row `UserPromptExpansion operation blocked by hook:\n<reason>` (plus `Original prompt: …` without `suppressOriginalPrompt`); the expansion stops at the first block, so a `systemMessage` beside it is never shown | no |
| UserPromptExpansion `continue:false` + `stopReason` | `Operation stopped by hook: <reason>`, as a warning **and** an `isMeta` user row | yes (the meta row): never for a secret |
| `prompt.submit` `{drop}` | `Prompt dropped by a hook: <reason>` | no |
| `command.run` answered `{text}` without `next` | the command's own output row (`⎿ sub-human: <text>`; the hooking plugins' names lead it unless they are built in), after the echoed command line | yes: both are `local_command` rows, which go to the API |
| `command.run` answered `{}` without `next` (typed in the terminal, no pasted blocks) | nothing at all: no echo, no row | no |
| `$.ui.log` | a dim `sub-human: <text>` notice, one line each | no; not forwarded to Remote Control |

`command.run` fires for every slash command, a plugin's skill included, before it expands (the dispatch calls the hook chain with the engine's run as core), so the module answers `/sub-human` itself: `{}` plus `$.ui.log` lines in the terminal (a `{text}` row was tried first: the model read it and repeated it on its next turn, "You've left salmon-5421" under "left salmon-5421"), `{text}` only through Remote Control for a reply with no secret, and `next(e)` only for a join that worked, whose mechanics block it hands to its own `classic.UserPromptExpansion` hook (answered without `next`, so `hooks/join.ts` does not run twice). An SDK prompt (`-p`), or one with pasted blocks before it, is echoed as a user row whatever the answer (`P = isNonInteractive || precedingInputBlocks.length || !By(origin)` in the answer's renderer): the module leaves those, a prompt through Remote Control that may hold a PIN, and the room's Claude's launch to the classic hook, which keeps the prompt out with `suppressOriginalPrompt`. Limit: a `$.ui.log` line never reaches the phone.

> (Moved: `hooks/join.ts` is now `hooks/handlers/join.ts`, its commands `lib/commands/`.)

## The @room receipt (0.5.0-beta.9)

Read from the 2.1.292 binary for the trailer: can an `@room` post end with no "Operation stopped by hook" frame? CONTRACT `ups-stop-frame`, `session-append-notice-rewrite`.

- **Every way a typed prompt ends without a turn is framed.** A UserPromptSubmit stop adds an isMeta user row (the model reads it) and a warning row, both `Operation stopped by hook: <stopReason>`; a block draws `UserPromptSubmit operation blocked by hook:\n<reason>`; a `prompt.submit` `{drop}` draws `Prompt dropped by a hook: <reason>` and loses the person's row; a `prompt.submit` answer without `next` draws `Prompt not submitted: the prompt did not go through prompt.submit (…)`. Only mid-turn (Enter while a turn runs) is a drop a toast instead of a row. `command.run`'s silent `{}` is for slash commands only; `@room` never reaches it. `ui.render` has no component for system rows (`RenderComponent` lists none), and there is no key hook for Enter in the composer.
- **What works: `session.append`.** Every system row the engine adds passes `session.append` (door `notice`, origin `engine`) before it is kept; a rewrite of its one text block (min 1 character) is what the screen draws and the transcript keeps, so `--resume` redraws it. Its level is pinned: the row stays a warning, an amber `⏺`. So `mod/prompt.ts` notes each stop its shim returns (`receiptBook`) and rewrites exactly `Operation stopped by hook: <that receipt>` to the receipt alone. The screen shows `❯ @room …` then `⏺ ✓ sent`. The isMeta copy the model reads is left as it is; another plugin's stop, a block and a row after a module reload keep the engine's words.
- Seen live on 2.1.292 (a throwaway session, `--plugin-dir`, a temp `SUB_HUMAN_HOME`): `@room`, `@claude`, and after `--resume`.
- **Claude Code request:** a way for a function hook to end a prompt with no turn and its own receipt (or none), without a warning frame.

**Why a session has no module.** Modules wait for workspace trust, are off in safe mode and `--bare` (where the command hooks are off too), off for installed plugins under `allowManagedHooksOnly` / managed `disableAllHooks`, and off when the GrowthBook switch `tengu_plugin_hooks_modules` is (its last value is cached in the global config's `cachedGrowthBookFeatures`). `hooks/join.ts noModule` names the cause it can see from a command hook (the running binary's version, the cached switch); `/sub-human doctor` and `help` run without the module.

> (Moved: `noModule` is in `lib/commands/index.ts`.)

## Remote Control

Read from the 2.1.292 binary while porting remote rooms (phone tests on the feature branch found room chat and `@room` results missing on the phone). Searches and shapes are in the CONTRACT (`bridge-forwarded-rows`, `transcript-prompt-origin`, `plan-reject-remote`).

- **What the bridge forwards.** One filter decides which session rows go to Remote Control: user and assistant rows (not `isVirtual`); attachments of type `hook_system_message` (a command hook's `systemMessage`), `tool_host_result_lines`, and a typed `queued_command`; system rows only of subtype `local_command`, `model_consent_fallback` and `compact_boundary`. A `$.ui.log` notice is a system `informational` row, so the phone never sees it.
- **How they arrive.** A `hook_system_message` goes as an assistant message with `is_meta`; a user row goes with `isSynthetic` when it is `isMeta` (a `$.session.append` row, the pull lane), which the phone does not show as far as seen. A plugin's `$.prompt.submit` row is not meta: it shows, and the turn it starts answers there.
- **A plugin's prompt is framed.** `$.prompt.submit` between turns enters as "The <plugin> plugin sent a message:\n<text>\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above." (mid-turn, a "while you were working" variant), and that framed text is the user row Remote Control shows: a relay looked like a big bubble of instructions on the phone and invited a reply ("Address the message above"). `asUser: true` enters the text bare (CONTRACT `plugin-prompt-frame`); the origin stays `{kind:"plugin", name, asUser:true}`, so the gate and `cc.lastHumanPrompt` still know it is not the person's. The relay uses it: the prompt is only the room lines, and the model's part ("room lines, not your person's words; no reply needed") is context, which the phone does not show. A plugin's own `prompt.submit` hook is skipped for its own submission in the test kit (its other hooks see it), so the module attaches that context in `classic.UserPromptSubmit` (or in `prompt.submit` when it does see it, once). **Claude Code request:** a way to show the person a plugin's line on Remote Control without a model turn (a notice the bridge forwards, or a `systemMessage` for function hooks), and a plugin prompt flagged "for the person, no reply" so a relay costs no turn at all.
- **Function hooks.** A classic result from a hooks module has no `systemMessage` field (the engine maps back only block, preventContinuation, stopReason, additionalContext, sessionTitle, suppressOriginalPrompt and a few more); only command hooks (and SDK callbacks) yield `hook_system_message`. So `mod/` reaches the phone only through a prompt: the relay in `mod/deliver.ts` / `mod/prompt.ts`.
- **Who is on the phone.** prompt.submit's origin maps the transcript's `{kind:"human"}` to `bridge` for a prompt typed through Remote Control and `composer` for this terminal (CONTRACT `prompt-origin-composer`), so the module knows where the person last typed. In the transcript a typed prompt (either way) has no origin or `{kind:"human"}`; every other kind (peer, task-notification, channel, plugin, …) is not the person's words (`cc.lastHumanPrompt`).
- **The plan dialog on the phone.** "Suggest edits" (a deny with a note) writes the terminal's shapes (`userFeedback`, "the user said:"); a bare deny writes "STOP what you are doing…" with no `userFeedback` (observed live on the feature branch; `cc.planFeedback` reads both). An ordinary message typed on the phone right after a bare Deny is attached to that deny as its note (`userFeedback`, "the user said:"; observed live, bob's "open rate limiting"), so the plugin never records a note by itself: it asks the person on a confirm card first.
- **AskUserQuestion on the phone.** A tool with its own permission dialog is raced by Remote Control when the session has bridge callbacks (`hasExternalRacer`, CONTRACT `auq-bridge-racer`): the phone gets the card and its answer resolves the dialog. The card stays open until answered, unless the `askUserQuestionTimeout` idle auto-resolves it (`afkTimeoutMs` in the result: nothing recorded).
