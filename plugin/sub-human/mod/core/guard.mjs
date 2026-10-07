/**
 * plugin/sub-human/mod/core/guard.mjs: the store guard's verdicts as pure functions (no `$`, no node imports),
 * shared by the hooks module (mod/guard.mjs) and the node tests (test/hooks/guard.test.js, security.test.js).
 *
 * Threat model: one machine, one OS user. The goal is that a model (any member's Claude, possibly steered by
 * room text) cannot forge or hide a person's words through its ordinary tools. It is a string check: a
 * determined command (a script file written first, an obfuscated path, a variable built at run time) evades
 * it. What it cannot evade: via=human needs the seat key's signature (lib/room/store.js), readers mark unsigned
 * lines "(unverified)", and the prev-hash chain shows an edited log.
 *
 * ctx (every field optional; an unknown home means only the string rules apply, as before mod-hello answered):
 *   {home, realHome, userHome, pluginRoot, realPluginRoot, cwd, realCwd}
 *
 *   bashVerdict(command, ctx) -> reason | null     a Bash command that names the store or runs the plugin's code
 *   needsCwd(command) -> bool                      bashVerdict reads ctx.cwd / realCwd for this command
 *   writeTarget(input) -> string | null            the path a Write / Edit / MultiEdit / NotebookEdit names
 *   absTarget(p, {cwd, userHome}) -> string | null the path made absolute (~ expanded), or null when it cannot be
 *   ancestors(abs) -> [path]                       abs, then each parent up to "/" (the walk for a realPath)
 *   writeVerdict(candidates, ctx) -> reason | null the candidates (lexical path, resolved paths) under the store
 *   roomToolVerdict({tool, agentId}, seated) -> {decision, reason} | null    the room MCP tools' verdict
 *   failClosed(e) -> bool                          a guard that failed denies only a call that mentions sub-human
 *   denyText(why), WRITE_DENY(tool, p), FAILED     the reasons the model reads
 */

export const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
export const HOLD = MCP_PREFIX + 'hold';
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const MSG = 'ROOM-GUARD: the room store is written only by sub-human itself. Post with the room MCP tools; read with `sub-human read` or the room read tool.';
export const HOLD_DENY = 'sub-human: hold is for row agents only (sub-human:participant / sub-human:room); never call it yourself. Spawn the row agents listed under ROWS instead.';
export const ROOM_ALLOW = 'sub-human: room tool for a joined session.';
export const FAILED = 'ROOM-GUARD: guard failed; denied to be safe.';

// ---------- Bash ----------
/** The read-only CLI, with plain arguments only (no pipes, redirects, substitutions or chained commands). */
const READ_CLI = /^\s*(?:[\w./~-]*\/)?sub-human\s+(?:read|digest|who|tasks|watch)(?:\s+[\w.,:=@-]+)*\s*$/;
const ENV_NAMES = /\bSUB_HUMAN_(?:HOME|TEST_ROOM_DIR)\b/;
/** A dot-dir named .sub-human anywhere (~/.sub-human, $HOME/.sub-human, /Users/x/.sub-human). */
const DOT_HOME = /(?:^|[^\w.-])\.sub-human(?![\w-])/;
/** Something that runs JavaScript. */
const RUNS_JS = /(?:^|[\s;&|(`'"/])(?:node|nodejs|bun|deno|npx|tsx|ts-node)(?=[\s;&|)`'"]|$)/;
/** The plugin's modules that write the store or hold the seat key (test/ files are not matched). */
const PLUGIN_CODE = /(?<!test\/)(?<![\w-])(?:lib\/(?:room|identity|proposal|consent|tasks|rows|notices|orch|io|lock)(?![\w-])|hooks\/[\w-]+\.js\b|hooks\/(?:at-room|prompt|consent|join|seat-key|common|tasks|presence|session-end|session-restore|mod-hello|row-[\w-]+)(?![\w.-])|mcp\/[\w-]+(?:\.js)?(?![\w-]))/;
/** Names the plugin outright, so the cwd need not be read. */
const NAMES_PLUGIN = cmd => /sub-human/.test(cmd) || /lib\/room(?![\w-])/.test(cmd);

/** "/a/b/../c/" -> "/a/c" (POSIX, lexical; "" for a relative path's empty result). */
export function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}

export const isUnder = (x, root) => typeof x === 'string' && typeof root === 'string' && root.length > 1
  && (x === root || x.startsWith(root.endsWith('/') ? root : root + '/'));

/** The literal spellings of the store home a command could use. */
function homeSpellings({ home, realHome, userHome } = {}) {
  const out = new Set();
  for (const raw of [home, realHome]) {
    if (typeof raw !== 'string' || !raw.startsWith('/')) continue;
    const h = normalize(raw);
    if (h.length < 4) continue; // never "/" or similar
    out.add(h);
    const u = typeof userHome === 'string' && userHome.startsWith('/') ? normalize(userHome) : '';
    if (u.length > 1 && (h === u || h.startsWith(u + '/'))) {
      const rel = h.slice(u.length);
      out.add('~' + rel); out.add('$HOME' + rel); out.add('${HOME}' + rel);
    }
  }
  return [...out];
}

export const needsCwd = command => {
  const cmd = typeof command === 'string' ? command : '';
  return RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd) && !NAMES_PLUGIN(cmd);
};

/** 'deny reason' for a Bash command, or null. */
export function bashVerdict(command, ctx = {}) {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return null;
  if (READ_CLI.test(cmd)) return null;
  if (ENV_NAMES.test(cmd)) return 'it names the store location variable (SUB_HUMAN_HOME / SUB_HUMAN_TEST_ROOM_DIR)';
  if (DOT_HOME.test(cmd)) return 'it touches the room store (~/.sub-human)';
  for (const h of homeSpellings(ctx)) {
    for (let i = cmd.indexOf(h); i >= 0; i = cmd.indexOf(h, i + 1)) {
      if (!/[\w.-]/.test(cmd[i + h.length] || '')) return 'it touches the room store'; // not /home2 or .sub-humanoid
    }
  }
  if (RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd)) {
    const roots = [ctx.pluginRoot, ctx.realPluginRoot].filter(r => typeof r === 'string' && r.startsWith('/')).map(normalize);
    const cwds = [ctx.cwd, ctx.realCwd].filter(c => typeof c === 'string' && c.startsWith('/')).map(normalize);
    const inPlugin = NAMES_PLUGIN(cmd) || cwds.some(c => roots.some(r => isUnder(c, r)));
    if (inPlugin) return "it runs sub-human's own modules or hooks (they write the room log and hold the seat keys)";
  }
  return null;
}

export const denyText = why => `${MSG} (Denied: ${why}.) Use \`sub-human read\`, \`sub-human digest\`, \`sub-human who\` or the room MCP tools.`;

// ---------- Write / Edit / MultiEdit / NotebookEdit ----------
export function writeTarget(input = {}) {
  const p = input && (input.file_path || input.notebook_path);
  return typeof p === 'string' && p ? p : null;
}

export function absTarget(p, { cwd, userHome } = {}) {
  if (typeof p !== 'string' || !p) return null;
  let x = p;
  if (/^~(?=\/|$)/.test(x)) {
    if (typeof userHome !== 'string' || !userHome.startsWith('/')) return null;
    x = userHome + x.slice(1);
  }
  if (!x.startsWith('/')) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
    x = cwd + '/' + x;
  }
  return normalize(x);
}

export function ancestors(abs) {
  const out = [];
  for (let x = normalize(abs); ; x = x.slice(0, x.lastIndexOf('/')) || '/') {
    out.push(x);
    if (x === '/') return out;
  }
}

const DOT_SEGMENT = /(?:^|\/)\.sub-human(?:\/|$)/;

/**
 * 'deny reason' for a write whose target is any of candidates (absolute: the lexical path and where it resolves),
 * or null. With the home known, a candidate under home or realHome is the store. Before mod-hello answered,
 * any path through a ".sub-human" directory counts (the default home's spelling), and so does a raw "~/.sub-human".
 */
export function writeVerdict(candidates, ctx = {}, raw = '') {
  const cands = candidates.filter(c => typeof c === 'string' && c);
  const roots = [ctx.home, ctx.realHome].filter(r => typeof r === 'string' && r.startsWith('/')).map(normalize);
  if (roots.length) return cands.some(c => roots.some(r => isUnder(c, r))) ? 'it writes into the room store' : null;
  return [...cands, String(raw || '')].some(c => DOT_SEGMENT.test(c)) ? 'it writes into the room store (~/.sub-human)' : null;
}

export const WRITE_DENY = (tool, p) => `${MSG} (Denied: ${tool} on ${p}.)`;

// ---------- the room MCP tools ----------
/** hold only from a row subagent (agentId), never a main thread; the rest allowed for a seated session. */
export function roomToolVerdict({ tool, agentId } = {}, seated = false) {
  const t = String(tool || '');
  if (!t.startsWith(MCP_PREFIX)) return null;
  if (t === HOLD && !agentId) return { decision: 'deny', reason: HOLD_DENY };
  return seated ? { decision: 'allow', reason: ROOM_ALLOW } : null;
}

/** A guard that failed denies only a call that plausibly touches the store (as hooks/guard.js did). */
export function failClosed(e) {
  try { return JSON.stringify(e).includes('sub-human'); } catch { return true; }
}
