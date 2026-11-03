---
name: sub-human
description: "Work with other people's Claude Code sessions in a shared room. /sub-human to join or open one."
argument-hint: "[invite | leave | help]"
arguments: [command]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__plan
  - mcp__plugin_sub-human_room__task
---

The /sub-human hook runs before you. When it took a seat, its result is the context block headed SUB-HUMAN: end your turn without text (the person already sees the join's line, and the room row starts by itself).

If no SUB-HUMAN block is present, the hook did not answer this command (any reply or refusal of its own would have stopped the command before it reached you). Either sub-human's hooks are off in this session (--bare, safe mode, hooks turned off), or the hook failed before it answered, and only the person's terminal shows which (a hook error line). Reply exactly "sub-human did not answer here. If your terminal shows a sub-human hook error above, type /sub-human doctor; if it shows none, its hooks are off in this session: start claude normally (not --bare), then type /sub-human again." and stop. Do not pick a name, role or room code yourself, and do not retry the join.
