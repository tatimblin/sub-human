#!/usr/bin/env node
'use strict';
// PreToolUse(Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__plugin_sub-human_room__.*).
// A plugin can't ship permissions, so this hook stands in for them:
//   - allow the plugin's own room MCP tools for a joined session (no permission prompt);
//   - allow the exact read-only CLI commands `sub-human read [--id N,…] | digest | who | plan [HASH] | watch NAME`
//     (bare `sub-human`, or this plugin's own bin/sub-human by absolute path);
//   - deny Write/Edit/MultiEdit/NotebookEdit/Bash that touch the room store (identity.home(),
//     i.e. ~/.sub-human or $SUB_HUMAN_HOME, by any spelling we can see);
//   - otherwise no opinion.
// Best-effort against accidents, not a hostile local user (the hash chain makes tampering visible).
const os = require('node:os');
const path = require('node:path');
const { identity, run, pre, deny, whoami, isUnder, realish, PLUGIN_ROOT } = require('./common.js');

const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
const READONLY_ARGS = /^(read( --id [0-9,]+)?|digest|who|plan( [0-9a-f]{6,12})?|watch [A-Za-z0-9_.-]{1,32})$/;
const BINS = () => {
  const b = path.join(process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT, 'bin', 'sub-human');
  return new Set(['sub-human', b, `"${b}"`, `'${b}'`, realish(b)]);
};
function readOnly(cmd) {
  const m = cmd.match(/^("[^"]+"|'[^']+'|\S+) (.+)$/);
  return !!m && BINS().has(m[1]) && READONLY_ARGS.test(m[2]);
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MSG = 'ROOM-GUARD: the room store is written only by sub-human itself. Post with the room MCP tools; read with `sub-human read --id N`, `sub-human digest`, `sub-human who`, `sub-human plan` or `sub-human watch NAME`.';

function homeSpellings() {
  const h = path.resolve(identity.home());
  const s = new Set([h, realish(h), '.sub-human', 'SUB_HUMAN_HOME']);
  const hd = os.homedir();
  for (const x of [h, realish(h)]) if (x.startsWith(hd + path.sep)) s.add('~' + x.slice(hd.length));
  return [...s];
}

run(input => {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (tool.startsWith(MCP_PREFIX)) {
    // hold blocks forever: only row subagents (which carry agent_id) may call it, never a main thread.
    if (tool === MCP_PREFIX + 'hold' && !input.agent_id) return deny('sub-human: hold is for row agents only (sub-human:participant / sub-human:room); never call it yourself. Spawn the row agents listed under ROWS instead.');
    if (whoami(input)) pre('allow', 'sub-human: room tool for a joined session.');
    return;
  }
  if (tool === 'Bash') {
    const cmd = String(ti.command || '').trim();
    if (readOnly(cmd)) return pre('allow', 'sub-human: read-only room command.');
    const hit = homeSpellings().find(s => cmd.includes(s));
    if (hit) deny(`${MSG} (Denied: the command references ${hit}.)`);
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
