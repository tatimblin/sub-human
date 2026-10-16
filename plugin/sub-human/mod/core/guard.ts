/**
 * plugin/sub-human/mod/core/guard.ts: the store guard's verdicts as pure functions (no `$`, no node imports),
 * shared by the hooks module (mod/guard.ts) and the node tests (test/hooks/guard.node-test.ts, security.node-test.ts).
 * In: the tool input and ctx {home, realHome, userHome, pluginRoot, realPluginRoot, cwd, realCwd}, every field
 * optional (an unknown home leaves only the string rules). Out: a deny reason the model reads, or null.
 * It is a string check, so a determined command evades it; the seat key's signature on via=human and the log's
 * hash chain are what it cannot evade (lib/room/store.ts).
 */
import type { GuardCtx } from './types.ts';

export const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
export const HOLD = MCP_PREFIX + 'hold';
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const MSG = 'ROOM-GUARD: the room store is reached only through sub-human. Post with the room MCP tools; read with the room MCP read tool.';
export const HOLD_DENY = 'sub-human: hold is for row agents only (sub-human:participant / sub-human:room); never call it yourself. Spawn the row agents listed under ROWS instead.';
export const ROOM_ALLOW = 'sub-human: room tool for a joined session.';
export const FAILED = 'ROOM-GUARD: guard failed; denied to be safe.';

// ---------- Bash ----------
/** The read-only CLI, with plain arguments only (no pipes, redirects, substitutions or chained commands). */
const READ_CLI = /^\s*(?:[\w./~-]*\/)?sub-human\s+(?:read|digest|who|tasks|watch|show)(?:\s+[\w.,:=@-]+)*\s*$/;
/** doctor, read only: no --fix (it rewrites the shim and the home's modes) and no --bundle (it writes a file). */
const READ_DOCTOR = /^\s*(?:[\w./~-]*\/)?sub-human\s+doctor(?:\s+(?:--quick|--json|--timeout\s+\d+))*\s*$/;
/** doctor that changes things: the person runs it. */
const DOCTOR_WRITES = /(?:^|[\s;&|(`'"/])sub-human\s+doctor\b[^;&|\n]*--(?:fix|bundle)(?![\w-])/;
const ENV_NAMES = /\bSUB_HUMAN_HOME\b/;
/** The CLI commands a person runs in their own shell: an invite, letting a machine in or out, the link daemon, the room server, the room's options, moving the room's host, the web listener. */
const PERSON_CLI = /(?:^|[\s;&|(`'"/])sub-human\s+(?:invite|admit|kick|prime|listen|link|serve|options|handoff|promote|demote)(?![\w-])/;
/** The host's serve shim asked to link a machine over an ssh login (`ssh you@host H/bin/serve --stdio CODE --link ID --login`),
 *  under any home path: a person's step (/sub-human join USER@HOST ROOM), as `sub-human serve` is. */
const LOGIN_SERVE = /\bserve\b[^;&|\n]*--stdio\b[^;&|\n]*--login(?![\w-])/;
/** A dot-dir named .sub-human anywhere (~/.sub-human, $HOME/.sub-human, /Users/x/.sub-human). */
const DOT_HOME = /(?:^|[^\w.-])\.sub-human(?![\w-])/;
/** Something that runs JavaScript. */
const RUNS_JS = /(?:^|[\s;&|(`'"/])(?:node|nodejs|bun|deno|npx|tsx|ts-node)(?=[\s;&|)`'"]|$)/;
/** The plugin's modules that write the store or hold the seat key (test/ files are not matched): .ts, and .js: an
 * older version in the plugin cache still holds its hooks under those names, and run with this home they write it. */
const PLUGIN_CODE = /(?<!test\/)(?<![\w-])(?:lib\/(?:room|identity|proposal|consent|tasks|rows|notices|claude|io|lock|seats|remote|handoff|cli)(?![\w-])|hooks\/(?:handlers\/)?[\w-]+\.(?:[cm]?js|ts)\b|hooks\/(?:handlers\/)?(?:run|reply|seat|context|at-room|prompt|consent|join|seat-key|common|tasks|presence|session-end|session-restore|mod-hello|row-[\w-]+)(?![\w.-])|mcp\/[\w-]+(?:\.(?:[cm]?js|ts))?(?![\w-]))/;
/** Names the plugin outright, so the cwd need not be read. */
const NAMES_PLUGIN = (cmd: string) => /sub-human/.test(cmd) || /lib\/room(?![\w-])/.test(cmd);

/** "/a/b/../c/" -> "/a/c" (POSIX, lexical; "" for a relative path's empty result). */
export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}

export const isUnder = (x: unknown, root: unknown): boolean => typeof x === 'string' && typeof root === 'string' && root.length > 1
  && (x === root || x.startsWith(root.endsWith('/') ? root : root + '/'));

/** The literal spellings of the store home a command could use. */
function homeSpellings({ home, realHome, userHome }: GuardCtx = {}): string[] {
  const out = new Set<string>();
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

/** bashVerdict reads ctx.cwd / realCwd for this command. */
export const needsCwd = (command: unknown) => {
  const cmd = typeof command === 'string' ? command : '';
  return RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd) && !NAMES_PLUGIN(cmd);
};

/** 'deny reason' for a Bash command, or null. */
export function bashVerdict(command: unknown, ctx: GuardCtx = {}): string | null {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return null;
  if (READ_CLI.test(cmd) || READ_DOCTOR.test(cmd)) return null;
  if (DOCTOR_WRITES.test(cmd)) return DOCTOR_WHY;
  if (PERSON_CLI.test(cmd) || LOGIN_SERVE.test(cmd)) return 'it makes an invite, lets a machine in or out, or speaks for the room\'s connection: the person does that in their own session (/sub-human invite, admit, kick or handoff) or in a terminal outside Claude Code, never with !, which would put an invite and its PIN into this conversation';
  if (ENV_NAMES.test(cmd)) return 'it names the store location variable (SUB_HUMAN_HOME)';
  if (DOT_HOME.test(cmd)) return 'it touches the room store (~/.sub-human)';
  for (const h of homeSpellings(ctx)) {
    for (let i = cmd.indexOf(h); i >= 0; i = cmd.indexOf(h, i + 1)) {
      if (!/[\w.-]/.test(cmd[i + h.length] || '')) return 'it touches the room store'; // not /home2 or .sub-humanoid
    }
  }
  if (RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd)) {
    const roots = [ctx.pluginRoot, ctx.realPluginRoot].filter((r): r is string => typeof r === 'string' && r.startsWith('/')).map(normalize);
    const cwds = [ctx.cwd, ctx.realCwd].filter((c): c is string => typeof c === 'string' && c.startsWith('/')).map(normalize);
    const inPlugin = NAMES_PLUGIN(cmd) || cwds.some(c => roots.some(r => isUnder(c, r)));
    if (inPlugin) return "it runs sub-human's own modules or hooks (they write the room log and hold the people's signing keys)";
  }
  return null;
}

/** bashVerdict's reason for doctor --fix / --bundle: denyText gives it its own text (the store is not what it is about). */
export const DOCTOR_WHY = 'doctor --fix and --bundle change or write files';

/** The deny text. root (the plugin root, when known): name the read-only CLI by its path; it lives in scripts/, which is
 *  not on the Bash tool's PATH (a top-level bin/ would be, but claude.ai org sync rejects a plugin that has one).
 *  doctor --fix / --bundle: a person's step, run in a terminal (by the same path), never the store's wording. */
export const denyText = (why: string, root: unknown) => {
  const known = typeof root === 'string' && root.startsWith('/');
  if (why === DOCTOR_WHY) {
    return `ROOM-GUARD: sub-human ${why} (the shim, the home's modes, a bundle file), so they are the person's step: ${
      known ? `they run \`node ${root}/scripts/sub-human doctor --bundle\` (or --fix) ` : 'they run it '}in a terminal outside Claude Code. In a session, /sub-human doctor is the read-only check.`;
  }
  return `${MSG} (Denied: ${why}.) Use the room MCP tools${known ? `, or \`${root}/scripts/sub-human read|digest|who|tasks|show\`` : ''}.`;
};

// ---------- Write / Edit / MultiEdit / NotebookEdit ----------
/** The path the tool input names, or null. */
export function writeTarget(input: { file_path?: unknown; notebook_path?: unknown } | null | undefined = {}): string | null {
  const p = input && (input.file_path || input.notebook_path);
  return typeof p === 'string' && p ? p : null;
}

/** The path made absolute (~ expanded), or null when it cannot be. */
export function absTarget(p: unknown, { cwd, userHome }: { cwd?: string | null; userHome?: string | null } = {}): string | null {
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

/** abs, then each parent up to "/": the walk to the nearest existing ancestor for a realPath. */
export function ancestors(abs: string): string[] {
  const out: string[] = [];
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
export function writeVerdict(candidates: unknown[], ctx: GuardCtx = {}, raw: unknown = ''): string | null {
  const cands = candidates.filter((c): c is string => typeof c === 'string' && !!c);
  const roots = [ctx.home, ctx.realHome].filter((r): r is string => typeof r === 'string' && r.startsWith('/')).map(normalize);
  if (roots.length) return cands.some(c => roots.some(r => isUnder(c, r))) ? 'it writes into the room store' : null;
  return [...cands, String(raw || '')].some(c => DOT_SEGMENT.test(c)) ? 'it writes into the room store (~/.sub-human)' : null;
}

export const WRITE_DENY = (tool: string, p: string | null) => `${MSG} (Denied: ${tool} on ${p}.)`;

// ---------- Read / Grep / Glob ----------
/**
 * The home's secret directories: keys/ (the seat signing keys, and this home's machine key: with one, a model could
 * sign via=human entries that verify), listen/ (the web listener's Noise private key) and links/ (each link's token, a
 * pending invite's SECRET and PIN, and a web link's own Noise key). Everything else in the store stays readable.
 */
export const SECRET_DIRS = ['keys', 'listen', 'links'];
const SECRET_SEGMENT = /(?:^|\/)\.sub-human\/(?:keys|listen|links)(?:\/|$)/;
const DOT_HOME_END = /(?:^|\/)\.sub-human\/?$/;
const homesOf = (ctx: GuardCtx): string[] => [ctx.home, ctx.realHome].filter((r): r is string => typeof r === 'string' && r.startsWith('/')).map(normalize);
const secretRoots = (ctx: GuardCtx): string[] => homesOf(ctx).flatMap(h => SECRET_DIRS.map(d => (h === '/' ? '' : h) + '/' + d));

/**
 * 'deny reason' for a Read whose target is any of candidates and lies under one of the home's secret directories
 * (SECRET_DIRS), or null. Before mod-hello answered, a path through ".sub-human/keys|listen|links" counts.
 */
export function readVerdict(candidates: unknown[], ctx: GuardCtx = {}, raw: unknown = ''): string | null {
  const cands = candidates.filter((c): c is string => typeof c === 'string' && !!c);
  const roots = secretRoots(ctx);
  if (roots.length) return cands.some(c => roots.some(r => isUnder(c, r))) ? 'it reads a seat signing key or a link\'s secret' : null;
  return [...cands, String(raw || '')].some(c => SECRET_SEGMENT.test(c)) ? 'it reads a seat signing key or a link\'s secret (~/.sub-human)' : null;
}

/**
 * 'deny reason' for a Grep (tool 'Grep') or a Glob (tool 'Glob'): readVerdict over where the search looks, and, for a
 * Grep, a search rooted at the home or above it (ripgrep descends into hidden directories: a match prints the secrets'
 * contents, and a regex is an oracle even when only file names come back). A Glob lists names only, so it is denied
 * only inside the secret directories. Before mod-hello answered, a Grep at a path ending in ".sub-human" counts.
 */
export function searchVerdict(tool: string, candidates: unknown[], ctx: GuardCtx = {}, raw: unknown = ''): string | null {
  const read = readVerdict(candidates, ctx, raw);
  if (read || tool !== 'Grep') return read;
  const cands = candidates.filter((c): c is string => typeof c === 'string' && !!c);
  const homes = homesOf(ctx);
  const above = (c: string, h: string) => c === '/' || isUnder(h, c);
  if (homes.length) return cands.some(c => homes.some(h => above(normalize(c), h))) ? 'it searches the room store\'s home or a directory above it, which holds the seat signing keys' : null;
  return [...cands, String(raw || '')].some(c => DOT_HOME_END.test(c)) ? 'it searches the room store (~/.sub-human), which holds the seat signing keys' : null;
}

/** Where a Grep or Glob looks, as the tool input names it: [base, deepest]. base: input.path ('' for the cwd); deepest:
 *  for a Glob, the base joined with its pattern's literal leading segments (an absolute or ~ pattern on its own). */
export function searchTargets(tool: string, input: { path?: unknown; pattern?: unknown } | null | undefined = {}): string[] {
  const base = input && typeof input.path === 'string' ? input.path : '';
  if (tool !== 'Glob' || !input || typeof input.pattern !== 'string') return [base];
  const lit: string[] = [];
  for (const seg of input.pattern.split('/')) { if (/[*?[\]{}!]/.test(seg)) break; lit.push(seg); }
  const prefix = lit.join('/');
  if (!prefix) return [base];
  if (prefix.startsWith('/') || /^~(?=\/|$)/.test(prefix)) return [base, prefix];
  return [base, base ? base.replace(/\/$/, '') + '/' + prefix : prefix];
}

export const READ_DENY = (p: string | null, tool = 'Read') => `ROOM-GUARD: the seat signing keys and the links' secrets are the people's own; a model never reads or searches them. (Denied: ${tool} on ${p || 'the working directory'}.)`;

// ---------- the room MCP tools ----------
/** hold only from a row subagent (agentId), never a main thread; the rest allowed for a seated session. */
export function roomToolVerdict(
  { tool, agentId }: { tool?: unknown; agentId?: unknown } = {}, seated = false,
): { decision: 'deny' | 'allow'; reason: string } | null {
  const t = String(tool || '');
  if (!t.startsWith(MCP_PREFIX)) return null;
  if (t === HOLD && !agentId) return { decision: 'deny', reason: HOLD_DENY };
  return seated ? { decision: 'allow', reason: ROOM_ALLOW } : null;
}

/** A guard that failed denies only a call that plausibly touches the store: denying everything would break sessions. */
export function failClosed(e: unknown): boolean {
  try { return JSON.stringify(e).includes('sub-human'); } catch { return true; }
}
