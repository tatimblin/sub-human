---
name: sub-human
description: Join a sub-human room as NAME (add CODE when more than one room is open; the room's orch runs it bare). The join hook binds identity and role; the model never picks them.
argument-hint: "[NAME [CODE]]"
arguments: [name, code]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__propose
  - mcp__plugin_sub-human_room__task
  - mcp__plugin_sub-human_room__hold
---

The /sub-human hook already ran. Its result is the context block headed SUB-HUMAN. Your first action is the Agent call(s) under its ROWS line, exactly as written (when it lists any); then reply in one short line.

If no SUB-HUMAN block is present, reply "join failed — check the message above" and stop. Do not pick a name, role or room code yourself, and do not retry the join.
