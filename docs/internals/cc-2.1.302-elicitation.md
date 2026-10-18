# MCP elicitation as the sign-off fallback (2.1.296, 2.1.302)

Checked 2026-10-17, live, on 2.1.296 (the installed binary) and 2.1.302 (the canary prefix's), with a throwaway plugin whose stdio MCP server has one tool that sends `elicitation/create` mid call and returns the client's answer as its result. Scratch cwd and session under `/tmp/sh-spike-elicit`, tmux session `sh-spike-elicit`. Contract entry: `mcp-elicitation` (feature `sign-off`).

## What happened

| Case | Result |
|---|---|
| `initialize` | Claude Code advertises `capabilities.elicitation = {form: {}, url: {}}` (also in the 2026-07-28 `server/discover` probe) |
| interactive, auto mode (2.1.296) | the call is held; Claude Code draws "MCP server "plugin:spike-elicit:spike" requests your input", the message, one row per schema property (an `enum` is a pick list, a `string` a text field), Accept / Decline. Picked agree, Accept: the server got `{action: "accept", content: {answer: "agree"}}` |
| interactive, bypassPermissions (2.1.296) | the same dialog: no mode answers it. Esc: `{action: "cancel"}` |
| interactive, bypassPermissions (2.1.302) | the same dialog. Picked object, typed a note, Accept: `{action: "accept", content: {answer: "object", note: "max page size first"}}` |
| `claude -p` (2.1.296) | no dialog, `{action: "cancel"}` at once |
| a plugin with an `Elicitation` command hook answering `{hookSpecificOutput: {hookEventName: "Elicitation", action: "accept", content: {answer: "agree"}}}` | no dialog; the server got `{action: "accept", content: {answer: "agree"}}`, the same as a person's. The hook's input carries the server name, the message and the schema |

The model never sees the form: neither the message nor the answer is in the transcript; the model reads only the tool's own result (what the server chose to return).

## In the binary (2.1.296; the same in 2.1.302)

- The handler (`Received elicitation request: `): a hosted desktop server's request is cancelled; else the `Elicitation` hooks run first (`Elicitation resolved by hook: `), and a hook's answer is returned with no dialog; else the dialog (`requestDialog`), then the `ElicitationResult` hooks, which may rewrite the person's answer. No permission mode appears on this path: nothing auto-accepts.
- Headless / SDK (`handleElicitation`): `if(!this.hostAnswersElicitations)return{action:"cancel"}`; a host that answers elicitations gets a `subtype: "elicitation"` control request (the host program answers, as it answers permission dialogs).
- The hook output schema: "Hook-specific output for the Elicitation event. Return this to programmatically accept or decline an MCP elicitation request."

## Is the answer the person's?

As far as the plan view's is. The model cannot answer the dialog, and no permission mode, `-p` or `--bg` session accepts it. What can answer without the person is a hook: an `Elicitation` (or `ElicitationResult`) hook in the person's settings, a project's settings or any installed plugin. The server cannot tell such an answer from the person's. The plan view has the same exposure (a `PermissionRequest` hook on ExitPlanMode), so this adds no new trust: hooks are the person's configuration. A copy of the room server the model starts itself (past the Bash guard) could answer its own question, so `signoff` asks only when its parent process is the seat's Claude Code (`process.ppid` is the seat's pid: `mcp-stdio-ppid`; with `CLAUDE_CODE_SHELL_PREFIX` set it is not, and signoff refuses).

## How sub-human uses it

`mcp/room-server.ts` plan op `signoff` {name, version?}: only while the plan view cannot take a sign-off (`lib/cc/verdict.ts` off `sign-off`, or `SUB_HUMAN_CC_OFF`), else refused with the plan view's call. One form question (agree / object, a note), the plan's text in the message (up to 1,500 characters). Only an `accept` whose `answer` is `agree` or `object` records anything, as the person's answer (`via=human`), signed with the seat key armed for that one append (`hooks/seat-key.ts` signing). The consent hook meanwhile opens no review: a call meant to open one is denied with signoff as the next step.

Why not the question card (`lib/consent/card.ts`) as the fallback: the card is the model's AskUserQuestion call, rewritten by the consent hook at PreToolUse and read at PostToolUse, so it needs the same hook plumbing a broken plan view may share; the elicitation is the room server's own request and answer, with no hook of ours in the path.

## Live in a room (2.1.296, `SUB_HUMAN_CC_OFF=sign-off`, scratch home)

`/sub-human`, then "write a short room plan and ask me to sign off": the model's `plan edit` got the put answer (plan-edit is off with sign-off), stored v1 with `put`, asked, and called `signoff`; the dialog showed, agree recorded `via=human`, the row read "room v1 agreed". Two things the first run showed, both fixed in the server's words:

- The dialog shows only the message's first lines ("… (+3 more lines)", no way to expand), so the question and where to read the plan come first, and the `ask` reply tells the model to show the plan before calling signoff.
- The model never sees the question, so a bare "recorded tristan's answer" read to it as an answer made in the person's name, and it told the person so. The reply now says the person answered in the question Claude Code showed them. On the second run an objection with a note was recorded and relayed as theirs.
