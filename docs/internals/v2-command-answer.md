# A `/room` answer as one plain line (Claude Code 2.1.330)

The owner's first live run drew every command answer inside Claude Code's error frame:

```
⏺ UserPromptExpansion operation blocked by hook:
  sub-human: You opened room heron-2988 as alice. /room invite brings someone from another machine.
```

## What draws that frame

The classic `UserPromptExpansion` hook (hooks.json) answers with `decision: "block"`. In 2.1.330 the expansion
runner (`Mfi` → the command's prompt loader) turns any `blockingError` into a row that starts
`UserPromptExpansion operation blocked by hook:`, whatever `suppressOriginalPrompt` says. No other field of that
hook's output draws a message without the frame, so the classic hook can't answer quietly.

## The surface: the module's `command.run`, answering `{}`

`command.run` fires for every slash command the person runs, a plugin's skill included, before it expands
(`… registered /NAME but no command.run hook answered it …` is in the binary: the event reaches plugin commands). A
hook that answers without `next` runs no command, so no expansion hook runs and the frame never appears.

What the answer looks like decides what else is drawn. The code that builds a command's rows reads, in 2.1.330:

```js
if(e===void 0&&I.length===0&&!V)return{messages:[],shouldQuery:!1,command:n};
return{messages:[V?Me({content:Ane({inputString:Le(n,g),...})}):Xw(Le(n,g)),
  ...e===void 0?[]:[Xw(`<local-command-stdout>${mH(e)}</local-command-stdout>`,{commandRun:…,isDisplayOnly:c})],…
```

`e` is the answer's `text`, `I` its `context`, and `V` is true for a non-interactive session, pasted blocks before the
command, or an origin other than the person's own (`OE`: `human` or `auto-continuation`).

- `{ text }` (even with `isTextDisplayOnly`) adds the typed line `/room join LINE PIN` as a row, then the output
  under "sub-human: ". The line carries an invite's secret, so this is out.
- `{}` from the person's own prompt adds no row at all: nothing echoed, nothing for the model, `shouldQuery` false.

So `module/command.ts` answers `{}` and draws the answer with `$.ui.log`, which the typings define as a dim notice
"not sent to the model". Claude Code puts the plugin's name before a `$.ui.log` line (`oFt(plugin, text)` is
`` `${name}: ${text}` ``), so the line reads `sub-human: You opened room …` and the module drops the `sub-human: ` the
classic hook's reason starts with. The contract entry is `command-run-empty-answer`.

## Running the verbs

The verbs need Node, which the module hasn't. The hook runs the same command hook hooks.json names,
`sh <plugin>/hooks/node.sh expand`, with the expansion's payload (`session_id`, `cwd`, `command_args`) on stdin
(`$.process.run`), and reads the `reason` of its block. One code path answers every verb in both cases. `$.process.run`
drew no permission prompt here; if policy refuses it, the person gets one line saying so.

`news` opens the module's pane and `invite` arms the host's card poll, so status.ts and admit.ts hook `command.run`
for those first; command.ts is registered last.

## Where the frame stays

- Hooks modules off (managed policy, `--bare`): the classic hook answers, inside the frame. That is the C1 fallback, and
  no other surface is available without the module.
- A `/room` from the SDK, the bridge or `-p` (not `composer`): the module passes it on to the classic hook, since
  `{}` would still echo the line there.
- A run that policy refuses, or that never answers: the module passes it on, and the classic hook answers.

## Where the typed line can still be echoed

`V` is also true when pasted blocks come before the command (`precedingInputBlocks`), and `command.run` doesn't say
whether any did. Then even `{}` adds the typed line as a row (`Me({content: Ane({inputString, precedingInputBlocks})})`),
so a join line typed after a pasted image or block lands in the transcript. Nothing reaches the model (no
`shouldQuery`), but the secret is on disk in the transcript.

## Feature request (not yet filed)

A `sensitive` flag for a command's arguments (in `CommandSpec`, or on the `command.run` answer): Claude Code keeps the
typed arguments out of every row, the transcript and the prompt history, whatever the origin or the pasted blocks. An
invite line's secret and PIN are typed as arguments, and today no answer keeps them out on every path.
