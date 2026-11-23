# v2 risks: checked on Claude Code 2.1.330 (U6, 2026-11-22)

Two design choices in `docs/ARCHITECTURE.md` rest on behaviour the typings don't fully promise. Both were checked
against the pinned 2.1.330 binary (`scripts/lib/claude-bin.ts`), never the global `claude`.

| Risk | Verdict |
|---|---|
| 1. A `session.send` hook answers `{ isDelivered: true }` without `next` (§6 "Claude-to-Claude") | **HONOURED** |
| 2. A node child started with `$.process.spawn` outlives the session (§5, §9 "Node work") | **DETACHES** (only with a grandchild; the spawned child itself is KILLED) |

Neither needs a redesign.

## Risk 1: `session.send` answered without `next`

**Typings.** `on('session.send', ($, e, next) => …)` with `e: SessionSendInput` `{ to: string, text, origin: { kind:
'model' } | { kind: 'plugin', name }, agentId? }`. The result is `SessionSendResult`: `{ isDelivered: true }` or
`{ isDelivered: false, reason }`. The typings say that a `false` answer without `next` refuses the send, and that
"a name nobody carries is refused after the hooks". They don't say what a `true` answer without `next` does.

**Kit test** (`plugin/sub-human/module/risk/session-send.test.ts`, 4 tests). An inline plugin catches `*.TESTROOM`.
- `$.session.send({ to: 'bob.TESTROOM' })` resolves `{ isDelivered: true }`, and the test's bottom hook is never reached.
- Any other address goes on with `next`.
- A hook that throws is skipped, and the send falls through to what is beneath it.
- The kit can't settle this risk. It has no engine core (the test's own `on` is the bottom), and a SendMessage
  `$.tool.call` rejects with `no implementation for tool.call`, so the kit never routes that tool to `session.send`.
  Inline plugins are loaded from source, so `register` can't close over test variables.

**Real check** (`node scripts/risk-send.ts`). A temp plugin's module records each `session.send` to a file. For
`*.TESTROOM` it answers `{ isDelivered: true }` without `next`. Any other address goes on with `next` (the control).
- **Model-free** (`--model-free`, `claude -p /cost`, $0): at `session.start` the module calls `$.session.send` and
  `$.tool.call` of SendMessage. This is the real engine's SendMessage tool.
- **One model run** (default model, $0.097): the prompt asks for SendMessage to `bob.TESTROOM`, then to
  `carol.ELSEWHERE`.

Evidence from the model run, trimmed:

```
hook  {"to":"bob.TESTROOM","text":"hello","origin":{"kind":"model"},"answer":"isDelivered:true without next"}
hook  {"to":"carol.ELSEWHERE","origin":{"kind":"model"},"answer":"next",
       "result":{"isDelivered":false,"reason":"No agent named 'carol.ELSEWHERE' is reachable.\n…"}}
debug session.send to bob.TESTROOM (model): a hook delivered it itself; hooked by risk-send; nothing sent
debug risk-send (user) answered session.send without next() …; nothing beneath it ran for this dispatch
tool result the model read (bob):   {"success":true,"message":"Delivered by a plugin hook; nothing else was sent."}
tool result the model read (carol): {"success":false,"message":"No agent named 'carol.ELSEWHERE' is reachable.…"}
model reply: both lines verbatim
```

The model-free probes gave the same result, with `origin {kind:'plugin', name:'risk-send'}`: `$.session.send` resolved
`{ isDelivered: true }`, and the tool call's text was the same success line. They cover the plugin origin only. The
model-origin case (`origin {kind:'model'}`) and the control address come from the model run alone.

**Verdict: HONOURED.**
- The hook ran for the model's own SendMessage.
- Nothing was delivered natively: the engine logs "nothing sent", and the control address shows that a name nobody
  carries fails natively.
- The model read a success.

**Notes for the build:**
- The tool result's wording is the engine's own ("Delivered by a plugin hook; nothing else was sent."). It's internal,
  so it belongs in `lib/cc/contract.json` as the search string that proves this behaviour (M1).
- A `session.send` hook that throws is skipped, so the send goes native. For a `NAME.CODE` nobody carries, that
  natively fails "not reachable". `module/messages.ts` should therefore catch its own errors and answer
  `{ isDelivered: false, reason }`, rather than let the send fall through.
- In a `-p` session SendMessage is a deferred tool: the model loaded it with ToolSearch first.

## Risk 2: node children outliving the module

**Typings.** `$.process.spawn({ argv, cwd?, env?, input? })` has no detach option. "The loop is the child's life:
leaving it, `return()` on the stream, `next.signal` aborting or the module unloading kills the child." So a child
can't detach itself through the API. It has to start its own grandchild.

**Method** (`node scripts/risk-detach.ts`). At `session.start` a temp plugin's module starts three children.
- **detached**: a starter that spawns `node heart.mjs` with `detached: true` (setsid), `stdio: 'ignore'` and
  `unref()`, then exits.
- **orphan**: the same starter, without `detached`.
- **direct**: `heart.mjs` itself, as the spawned child, its stream loop left running.

Each heart writes its pid, rewrites a heartbeat file every 250 ms, and exits by itself after 60 s. The script then
runs `claude -p "say ok"` (default model) and waits for it to exit. It reads each heartbeat at 1 s and again at 6 s,
and kills every heart, but only a pid whose beat file is fresh. Both scripts then remove their temp dir and the empty
projects folder the run caused under `~/.claude/projects`.

Cost: $0.057 a run, the cold minimum for one turn on the default model. The first run had a $0.05 cap, so it ended
`error_max_budget_usd` after the turn ("ok"). It was rerun with a $0.10 cap: a normal exit (code 0, `success`, "ok"),
with the same three verdicts (detached and orphan beating +5.9 s after exit, direct killed −0.6 s, by SIGTERM).

Evidence from the first run, trimmed:

```
debug $.process.spawn (risk-detach): node with 4 args … (pid 44567)   ended (0) in 36ms     # detached starter
debug $.process.spawn (risk-detach): node with 4 args … (pid 44570)   ended (0) in 35ms     # orphan starter
debug $.process.spawn (risk-detach): node with 2 args … (pid 44574)                         # direct heart
debug $.process.spawn (risk-detach): node ended (SIGTERM) in 2222ms                         # at session exit
detached  pid 44568  alive 6 s after exit  heartbeat advanced  last beat +5827 ms   DETACHES
orphan    pid 44573  alive 6 s after exit  heartbeat advanced  last beat +5857 ms   DETACHES
direct    pid 44574  dead                  no beat after exit (last −689 ms)        KILLED
leftovers after cleanup: none
```

**Verdict: DETACHES.** A grandchild started by a short-lived starter keeps running after the session exits. The
module's own spawned child gets SIGTERM when the module unloads.

The non-detached orphan survived too, because the engine signals only its direct child, not the process group. The
listener and link daemon should still start with `detached: true`. That puts them in their own session and process
group, so a terminal hangup on an interactive session can't reach them. The hangup case was not tested here, because
`-p` has no terminal.

**Notes for the build:**
- The module has no `node` of its own. The test passed node's absolute path (`process.execPath`) as `argv[0]`. The
  shipped module must resolve node the way the 0.8 `hooks/node.sh` did, or take the path from a command hook.
- Each daemon must exit by itself when no local session is left (ARCHITECTURE §5). Nothing else ends it.
