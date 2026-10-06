#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit|mcp__plugin_sub-human_room__.*).
// A plugin can't ship permissions, so this hook stands in for them:
//   - allow the plugin's own room MCP tools for a joined session (no permission prompt); `hold` only for row
//     subagents (they carry agent_id), never a main thread;
//   - deny Write/Edit/MultiEdit/NotebookEdit into the room store (identity.home(), i.e. ~/.sub-human or
//     $SUB_HUMAN_HOME, lexically or after realpath);
//   - otherwise no opinion. Bash is not matched: the CLI is read through normal permissions.
// Best-effort against accidents, not a hostile local user (the hash chain makes tampering visible).
const os = require('node:os');
const { identity, run, pre, deny, whoami, isUnder } = require('./common.js');

const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MSG = 'ROOM-GUARD: the room store is written only by sub-human itself. Post with the room MCP tools; read with `sub-human read` or the room read tool.';

run(input => {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (tool.startsWith(MCP_PREFIX)) {
    // hold blocks forever: only row subagents (which carry agent_id) may call it, never a main thread.
    if (tool === MCP_PREFIX + 'hold' && !input.agent_id) return deny('sub-human: hold is for row agents only (sub-human:participant / sub-human:room); never call it yourself. Spawn the row agents listed under ROWS instead.');
    if (whoami(input)) pre('allow', 'sub-human: room tool for a joined session.');
    return;
  }
  if (WRITE_TOOLS.has(tool)) {
    const p = ti.file_path || ti.notebook_path;
    if (typeof p === 'string' && p && isUnder(p.replace(/^~(?=\/|$)/, os.homedir()), identity.home(), input.cwd || process.cwd())) {
      deny(`${MSG} (Denied: ${tool} on ${p}.)`);
    }
  }
}, (err, input) => {
  // Fail closed only when the call plausibly touches the store.
  if (JSON.stringify((input && input.tool_input) || {}).includes('sub-human')) deny(`ROOM-GUARD: guard failed (${err.message}); denied to be safe.`);
});
