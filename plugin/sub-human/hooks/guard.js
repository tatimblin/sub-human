#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit|mcp__plugin_sub-human_room__.*) and PreToolUse(Bash).
// A plugin can't ship permissions, so this hook stands in for them:
//   - allow the plugin's own room MCP tools for a joined session (no permission prompt); `hold` only for row
//     subagents (they carry agent_id), never a main thread;
//   - deny Write/Edit/MultiEdit/NotebookEdit into the room store (identity.home(), i.e. ~/.sub-human or
//     $SUB_HUMAN_HOME, lexically or after realpath);
//   - deny a Bash command (bashVerdict below) that names the store (its path, ~/.sub-human, the seat keys under
//     it), names or sets SUB_HUMAN_HOME / SUB_HUMAN_TEST_ROOM_DIR, or runs the plugin's own code (node / bun /
//     deno / npx with lib/room*, lib/identity, lib/proposal, … , hooks/*.js or mcp/*.js of sub-human): a hook
//     process holds the seat key that signs via=human, and lib/room appends as anyone. The read-only CLI
//     (`sub-human read|digest|who|tasks|watch`) stays allowed, and so does reading the plugin's source;
//   - otherwise no opinion.
// Bash runs on every command, so it takes a fast path that loads only lib/identity.js (about node's own start-up
// time); the other tools load common.js.
// Threat model: one machine, one OS user. The goal is that a model (any member's Claude, possibly steered by
// room text) cannot forge or hide a person's words through its ordinary tools. It is a string check: a
// determined command (a script file written first, an obfuscated path, a variable built at run time) evades
// it. What it cannot evade: via=human needs the seat key's signature (lib/room/store.js), readers mark unsigned
// lines "(unverified)", and the prev-hash chain shows an edited log.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MSG = 'ROOM-GUARD: the room store is written only by sub-human itself. Post with the room MCP tools; read with `sub-human read` or the room read tool.';
const PLUGIN_ROOT = path.join(__dirname, '..');

// ---------- Bash ----------
/** The read-only CLI, with plain arguments only (no pipes, redirects, substitutions or chained commands). */
const READ_CLI = /^\s*(?:[\w./~-]*\/)?sub-human\s+(?:read|digest|who|tasks|watch)(?:\s+[\w.,:=@-]+)*\s*$/;
const ENV_NAMES = /\bSUB_HUMAN_(?:HOME|TEST_ROOM_DIR)\b/;
/** A dot-dir named .sub-human anywhere (~/.sub-human, $HOME/.sub-human, /Users/x/.sub-human). */
const DOT_HOME = /(?:^|[^\w.-])\.sub-human(?![\w-])/;
/** Something that runs JavaScript. */
const RUNS_JS = /(?:^|[\s;&|(`'"/])(?:node|nodejs|bun|deno|npx|tsx|ts-node)(?=[\s;&|)`'"]|$)/;
/** The plugin's modules that write the store or hold the seat key (test/ files are not matched). */
const PLUGIN_CODE = /(?<!test\/)(?<![\w-])(?:lib\/(?:room|identity|proposal|consent|tasks|rows|notices|orch|io|lock)(?![\w-])|hooks\/[\w-]+\.js\b|hooks\/(?:at-room|consent|join|seat-key|common|guard|tasks|presence|session-end|session-restore|row-[\w-]+)(?![\w.-])|mcp\/[\w-]+(?:\.js)?(?![\w-]))/;

const realish = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The literal spellings of the store home a command could use. */
function homeSpellings(home) {
  const out = new Set();
  for (const h of [path.resolve(home), realish(home)]) {
    if (h.length < 4) continue; // never "/" or similar
    out.add(h);
    const u = os.homedir();
    if (u && (h === u || h.startsWith(u + path.sep))) {
      const rel = h.slice(u.length);
      out.add('~' + rel); out.add('$HOME' + rel); out.add('${HOME}' + rel);
    }
  }
  return [...out];
}

/** 'deny reason' for a Bash command, or null. ctx: {home, pluginRoot, cwd}. */
function bashVerdict(command, { home, pluginRoot = PLUGIN_ROOT, cwd = process.cwd() } = {}) {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return null;
  if (READ_CLI.test(cmd)) return null;
  if (ENV_NAMES.test(cmd)) return 'it names the store location variable (SUB_HUMAN_HOME / SUB_HUMAN_TEST_ROOM_DIR)';
  if (DOT_HOME.test(cmd)) return 'it touches the room store (~/.sub-human)';
  for (const h of homeSpellings(home)) {
    for (let i = cmd.indexOf(h); i >= 0; i = cmd.indexOf(h, i + 1)) {
      if (!/[\w.-]/.test(cmd[i + h.length] || '')) return 'it touches the room store'; // not /home2 or .sub-humanoid
    }
  }
  if (RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd)) {
    const inPlugin = /sub-human/.test(cmd) || [path.resolve(pluginRoot), realish(pluginRoot)].some(r => {
      const c = realish(cwd);
      return c === r || c.startsWith(r + path.sep);
    }) || /lib\/room(?![\w-])/.test(cmd);
    if (inPlugin) return "it runs sub-human's own modules or hooks (they write the room log and hold the seat keys)";
  }
  return null;
}

// ---------- the hook ----------
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const denyNow = reason => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** Bash runs on every command: a fast path that loads only lib/identity.js (no common.js, no room). */
function bashHook(input) {
  const ti = input.tool_input || {};
  try {
    const identity = require(path.join(PLUGIN_ROOT, 'lib', 'identity.js'));
    const why = bashVerdict(ti.command, { home: identity.home(), pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT, cwd: input.cwd || process.cwd() });
    if (why) denyNow(`${MSG} (Denied: ${why}.) Use \`sub-human read\`, \`sub-human digest\`, \`sub-human who\` or the room MCP tools.`);
  } catch (err) {
    process.stderr.write(`sub-human guard error: ${err && err.stack || err}\n`);
    if (String(ti.command || '').includes('sub-human')) denyNow(`ROOM-GUARD: guard failed (${err.message}); denied to be safe.`);
  }
}

function otherHook(input) {
  const { identity, pre, deny, whoami, isUnder, logError } = require('./common.js');
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  try {
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
  } catch (err) {
    logError(err);
    // Fail closed only when the call plausibly touches the store.
    if (JSON.stringify(ti).includes('sub-human')) deny(`ROOM-GUARD: guard failed (${err.message}); denied to be safe.`);
  }
}

if (require.main === module) {
  let input = {};
  try { const raw = fs.readFileSync(0, 'utf8'); input = raw.trim() ? JSON.parse(raw) || {} : {}; } catch (e) {
    process.stderr.write(`sub-human guard error: ${e && e.message}\n`); // unreadable payload: no opinion
    input = {};
  }
  if (input.tool_name === 'Bash') bashHook(input);
  else otherHook(input);
}

module.exports = { bashVerdict, homeSpellings };
