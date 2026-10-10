---
name: sub-human
description: "Join or open a shared room with people in other Claude Code sessions: /sub-human (as your git name), /sub-human invite for someone on another machine, /sub-human join HOST ROOM [PIN] to join one there. /sub-human help lists every command."
argument-hint: "[invite | join HOST ROOM [PIN] | help]"
arguments: [command]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__propose
  - mcp__plugin_sub-human_room__task
---

The /sub-human hook already ran. Its result is the context block headed SUB-HUMAN. Your first action is the Agent call(s) under its ROWS line, exactly as written (when it lists any); then reply in one short line.

If no SUB-HUMAN block is present, sub-human's hooks did not run in this session (Claude Code started with --bare, or hooks turned off): reply exactly "sub-human could not run here: its hooks are off in this session. Start claude normally (not --bare), then type /sub-human again." and stop. Do not pick a name, role or room code yourself, and do not retry the join.
