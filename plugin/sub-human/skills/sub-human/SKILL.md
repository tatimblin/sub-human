---
name: sub-human
description: "Join or open a shared room with people in other Claude Code sessions: /sub-human (as your git name), /sub-human invite for someone on another machine, /sub-human join HOST ROOM SECRET to join one there. /sub-human help lists every command."
argument-hint: "[invite | join HOST ROOM SECRET | join PIN | help]"
arguments: [command]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__propose
  - mcp__plugin_sub-human_room__task
---

The /sub-human hook runs before you. When it took a seat, its result is the context block headed SUB-HUMAN, and your first action is the Agent call(s) under its ROWS line, exactly as written (when it lists any); then reply in one short line.

If no SUB-HUMAN block is present, the hook did not answer this command (any reply or refusal of its own would have stopped the command before it reached you). Either sub-human's hooks are off in this session (--bare, safe mode, hooks turned off), or the hook failed before it answered, and only the person's terminal shows which (a hook error line). Reply exactly "sub-human did not answer here. If your terminal shows a sub-human hook error above, type /sub-human doctor; if it shows none, its hooks are off in this session: start claude normally (not --bare), then type /sub-human again." and stop. Do not pick a name, role or room code yourself, and do not retry the join.
