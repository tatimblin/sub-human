# Claude Code 2.1.292: what changed for sub-human

Source: `/opt/homebrew/Caskroom/claude-code@latest/2.1.292/claude` (`VERSION:"2.1.292"`), read as text with `strings -n 8` plus a regex context extractor. This note is a delta against [`cc-2.1.281.md`](cc-2.1.281.md); the § numbers below are that note's sections, and everything not listed here still reads as it does there.

On 2.1.292, 20 of the 64 `lib/cc.js` CONTRACT entries failed the probe. 18 were renamed minified identifiers (the code is the same), and 2 changed behaviour. Neither change needed a plugin code change beyond `cc.DAEMON_ENV_ALLOW`.

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
| `daemon-env-allowlist` | 5 | **b** | The allowlist grew; nothing was removed. See [below](#daemon-env-allowlist-b). | JSON of `cc.js`'s own key arrays + 2 shapes |
| `monitor-arm-gates` | 6 | a, one gate added | `async function iZ(…){if(Gr("pluginMonitors"))return;if(!gG())return;if(Ee())return;…}` with `function gG(){return C("tengu_amber_sentinel",!1)}`. The per-monitor arm (`ESt`) now also returns early when managed `policySettings.disableAllHooks` is true (`Vb()`), and still skips an untrusted workspace (`Skipping plugin monitor … - workspace trust not accepted`). Either early return deletes the dedupe key. A monitor that exits still never re-arms (`monitor-not-rearmed`). | `: failed to arm: `, `"tengu_amber_sentinel",!1)}`, `Skipping plugin monitor ` + shape |
| `hook-timeout-default` | 7 | a | `var td=600000,eVe=30000,…`; used as `e.timeout?e.timeout*1000:td` (sync and `asyncTimeout`). | `asyncTimeout:e.timeout?e.timeout*1000:` + shape `var ~=600000,~=30000,` |
| `stop-additional-context` | 7 | a | `case"Stop":case"SubagentStop":z.additionalContext=e.hookSpecificOutput.additionalContext`; the Stop loop: `let pe=s.agentId?"SubagentStop":"Stop",ge=rn({type:"hook_additional_context",content:ce.additionalContexts,…})` and the turn continues. A block still renders `${e} hook error: ${n.blockingError}` and `Stop hook error occurred`. | `{type:"hook_additional_context",content:` + 2 shapes |
| `session-end-budget` | 7 | a | `function hEe(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;if(e!==void 0)return e;…for(let h of g.hooks)if(h.timeout&&h.timeout*1000>n)n=h.timeout*1000;return Math.max(Nqo,Math.min(n,Mpr))}` with `var Nqo=1500,Mpr=60000`. The hook list it scans is settings plus plugin SessionEnd hooks (plugin hooks are left out under managed-only hooks). | env literal + 2 shapes |
| `peer-origin` | 8 | a | `u({kind:R("peer"),from:o(),fromMode:W(["bypass","prompting"]).optional().describe("The SENDING session's permission class …")})` | the new `.describe()` text + shape |
| `harbor-kite-gate` | 8 | a | `function vi(){let e=a.CLAUDE_CODE_HARBOR_KITE;if(e!==void 0)return Le(e);if(O()==="windows"&&!C("tengu_harbor_kite_win",!0))return!1;return C("tengu_harbor_kite",!0)}`: still on by default. A sibling flag `tengu_cuddly_willow` gates the claude.ai projects/bridge relay, not local peers. | `"tengu_harbor_kite",!0)` + shape |
| `plugin-settings-allowlist` | 9 | a | `var dYr=["agent","subagentStatusLine"]`; plugin settings now parse through `u(Object.fromEntries(dYr.map((e)=>[e,Yye(e)])))`, a zod object that strips unknown keys. This replaces `JSONSchema.pick(Wpe).strip()` with the same effect. It still reads `settings.json` first, then manifest `settings` (`Loaded settings from settings.json/manifest for plugin …`). | `=["agent","subagentStatusLine"];` + both log lines |
| `subagent-statusline-precedence` | 9 | a | `R_r(e){…e.store.isLoadingFromDisk=!0;try{let s=e.store.pluginBase,r={};if(s)r=mU(r,s,pK);…}` then every settings source overlays it. Reads go through `vXt("subagentStatusLine")` (merged), or policy only under managed-only. | `settings_load_started` + shape |
| `hooks-modules` | 10 | **b** | Gating changed: default on for installed plugins. See [below](#hooks-modules-b). | rollout flag name, its log line, `"hooks/register.ts"`, `"ui.focus","agent.offer","agent.spawn"` |

### daemon-env-allowlist (b)

2.1.292 builds the dispatch allowlist as `qRr = new Set([...zWe, ...dWn, <extras>])`:

- `zWe` = `CLAUDE_CONFIG_DIR`, `CLAUDE_INTERNAL_FC_OVERRIDES`, `...V8r` (model keys `oit` + custom model keys `vLn` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`), **`CLAUDE_CODE_CLIENT_DATA_URL`** (new), `...O6` (provider selectors), then the AWS/GCP keys.
- `oit` gained **`CLAUDE_CODE_3P_PROBE_WROTE_HAIKU_DEFAULT`, `CLAUDE_CODE_3P_SEEDED_SONNET_DEFAULT`, `CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT`**.
- `dWn` = `PATH`, `CLAUDE_CODE_EXTRA_BODY`, `CLAUDE_CODE_HOST_CREDS_FILE`, `...ILe` (the endpoints and companions of `Mqe`; unchanged).
- The extras gained **`CLAUDE_CODE_DISABLE_PROACTIVITY`, `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`, `CLAUDE_CODE_AUTO_MODE_TIER`, `CLAUDE_BG_AUTO_MEMORY_OFF`**: `"CLAUDE_CODE_DISABLE_PROACTIVITY","CLAUDE_CODE_AUTO_MODE_SERVER","CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS","CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS","CLAUDE_CODE_AUTO_MODE_TIER","CLAUDE_BG_ISOLATION","CLAUDE_BG_SESSION_PERMISSION_RULES","CLAUDE_BG_MEMORY_TOGGLED_OFF","CLAUDE_BG_AUTO_MEMORY_OFF","CLAUDE_CODE_RESUME_SOURCE_ALIVE","CLAUDE_CODE_PLUGIN_DIRS"`.
- The persisted `providerEnv` filter is still `zWe`. It now also drops `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and `CLAUDE_CODE_HOST_GATEWAY_LINEAGE` unless their value is truthy (`z8r`).

Still not on the list: `HOME`, `USER`, `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, any `SUB_HUMAN_*`, and auth secrets. The orch therefore still has to get its list id from `--settings` env, as it does now.

**Fix.** `cc.DAEMON_ENV_ALLOW` now copies the 2.1.292 list: `EXTRA_KEYS` is a new array, and `MODEL_KEYS` and the `zWe` part have the new keys. `orch.cleanEnv` (the orch spawn's `KEEP_ENV`: the login basics plus `cc.daemonEnv`) now forwards those keys from the joiner's env, so a user who sets, for example, `CLAUDE_CODE_DISABLE_PROACTIVITY` gets it in the orch too, as the daemon would. The CONTRACT entry now searches for `JSON.stringify` of `cc.js`'s own arrays, so any key the binary adds, drops or reorders fails the probe instead of passing silently. The derived `daemon-env-names` check still covers the endpoint keys. Tests: `cc.test.js` (the new keys are in the allowlist) and `orch.test.js` (a new key reaches the spawn env).

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
- A plugin's hooks module is `hooks/register.ts` (`ye="hooks/register.ts"`, `modulePath:Zj(folder,ye)`).
- Built-in plugins load regardless, and `--bare`, safe mode and managed policy switch modules off for installed plugins.
- The event and cap names (`"ui.focus","agent.offer","agent.spawn"` …) are still there.

**Effect on sub-human.** None today. The plugin has only command hooks (`hooks/hooks.json` + `*.js`) and no `hooks/register.ts`, so nothing new loads. A new test (`cc.test.js`: "the plugin ships no hooks module") fails if a `hooks/register.*` file is added, because that file would now load by default for every installed user. Whether to adopt hooks modules (several workarounds in §10 could move to them) is a product decision and is not made here.

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
