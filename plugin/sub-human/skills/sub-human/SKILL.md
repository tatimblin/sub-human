---
name: sub-human
description: "Join or open a shared room with people in other Claude Code sessions: /sub-human NAME [CODE] (CODE only when more than one room is open). Another machine: /sub-human join NAME USER@HOST CODE over your ssh login, or an invite from /sub-human host."
argument-hint: "[NAME [CODE] | host [--ssh [USER@HOST]] | join NAME USER@HOST CODE | join NAME DEST CODE 482913 | join NAME INVITE PIN | admit [REF] | revoke NAME|INVITE_REF]"
arguments: [name, code]
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_sub-human_room__post
  - mcp__plugin_sub-human_room__read
  - mcp__plugin_sub-human_room__propose
  - mcp__plugin_sub-human_room__task
---

The /sub-human hook already ran. Its result is the context block headed SUB-HUMAN. Your first action is the Agent call(s) under its ROWS line, exactly as written (when it lists any); then reply in one short line.

If no SUB-HUMAN block is present, reply "join failed — check the message above" and stop. Do not pick a name, role or room code yourself, and do not retry the join.
