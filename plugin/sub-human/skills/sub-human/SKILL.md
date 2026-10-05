---
name: sub-human
description: Open a sub-human planning room (no arguments, from the sub-human:orchestrator agent) or join one as a member (NAME, plus CODE when more than one room is open). Identity and role are bound by the join hook, never by the model.
argument-hint: "[NAME [CODE]]"
arguments: [name, code]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__plan
  - mcp__plugin_sub-human_room__review
  - mcp__plugin_sub-human_room__hold
---

The /sub-human hook already ran. Its result is in the context block headed SUB-HUMAN. Follow it exactly, starting with the row calls it lists.

If no SUB-HUMAN block is present, reply "join failed — check the message above" and stop. Do not pick a role, a name or a room code yourself, and do not retry the join.
