/**
 * plugin/sub-human/mod/core/guard.ts: the store guard's verdicts as pure functions (no `$`, no node imports),
 * shared by the hooks module (mod/guard.ts) and the node tests (test/hooks/guard.node-test.ts, security.node-test.ts).
 * In: the tool input and ctx {home, realHome, userHome, pluginRoot, realPluginRoot, cwd, realCwd, claudeDir, sid},
 * every field optional (an unknown home leaves only the string rules). Out: a deny reason the model reads, or null.
 * It is a lexical check of the command's words: it follows `cd`, expands ~, $HOME and braces, and matches glob words
 * against the protected paths (the home; Claude Code's prompt history and this session's transcript, where an invite
 * line and its PIN may be), and it denies a recursive or file-reading tool pointed at a directory above them. A model
 * that builds a path at run time (a variable, an interpreter's string arithmetic, a symlink made first) still gets past
 * it: what it cannot get past is the log's hash chain, and the seat key's signature only against a Claude that never
 * read the key (README "What it protects against").
 */
import type { GuardCtx } from './types.ts';
import { homeOf } from './seat.ts';

export const MCP_PREFIX = 'mcp__plugin_sub-human_room__';
export const HOLD: string = MCP_PREFIX + 'hold';
export const WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const MSG = 'ROOM-GUARD: the room store is reached only through sub-human. Post with the room MCP tools; read with the room MCP read tool.';
export const HOLD_DENY = 'sub-human: hold is for row agents only (sub-human:participant / sub-human:room); never call it yourself. Spawn the row agents listed under ROWS instead.';
export const ROOM_ALLOW = 'sub-human: room tool for a joined session.';
export const FAILED = 'ROOM-GUARD: guard failed; denied to be safe.';

// ---------- Bash ----------
/** The read-only CLI, with plain arguments only (no pipes, redirects, substitutions or chained commands). */
const READ_CLI = /^\s*(?:[\w./~-]*\/)?sub-human\s+(?:read|who|tasks|show|verify)(?:\s+[\w.,:=@-]+)*\s*$/;
/** doctor, read only: no --fix (it rewrites the shim and the home's modes) and no --bundle (it writes a file). */
const READ_DOCTOR = /^\s*(?:[\w./~-]*\/)?sub-human\s+doctor(?:\s+(?:--quick|--json|--timeout\s+\d+))*\s*$/;
/** doctor that changes things: the person runs it. */
const DOCTOR_WRITES = /(?:^|[\s;&|(`'"/])sub-human\s+doctor\b[^;&|\n]*--(?:fix|bundle)(?![\w-])/;
const ENV_NAMES = /\bSUB_HUMAN_HOME\b/;
/** Claude Code's prompt history, by name (before the hello says where Claude Code's directory is). */
const HISTORY = /(?:^|[/\s'"])\.claude\/history\.jsonl\b/;
/** The CLI commands a person runs in their own shell: an invite, letting a machine in or out, the link daemon, the room server, the web listener. */
const PERSON_CLI = /(?:^|[\s;&|(`'"/])sub-human\s+(?:invite|admit|kick|listen|link|serve)(?![\w-])/;
/** The host's serve shim asked to link a machine over an ssh login (`ssh you@host H/bin/serve --stdio CODE --link ID --login`),
 *  under any home path: a person's step (/sub-human join USER@HOST ROOM), as `sub-human serve` is. */
const LOGIN_SERVE = /\bserve\b[^;&|\n]*--stdio\b[^;&|\n]*--login(?![\w-])/;
/** A dot-dir named .sub-human anywhere (~/.sub-human, $HOME/.sub-human, /Users/x/.sub-human). */
const DOT_HOME = /(?:^|[^\w.-])\.sub-human(?![\w-])/;
/** Something that runs JavaScript. */
const RUNS_JS = /(?:^|[\s;&|(`'"/])(?:node|nodejs|bun|deno|npx|tsx|ts-node)(?=[\s;&|)`'"]|$)/;
/** The plugin's modules that write the store or hold the seat key (test/ files are not matched): .ts, and .js: an
 * older version in the plugin cache still holds its hooks under those names, and run with this home they write it. */
const PLUGIN_CODE = /(?<!test\/)(?<![\w-])(?:lib\/(?:room|identity|proposal|consent|tasks|rows|notices|claude|io|lock|seats|remote|cli)(?![\w-])|hooks\/(?:handlers\/)?[\w-]+\.(?:[cm]?js|ts)\b|hooks\/(?:handlers\/)?(?:run|reply|seat|context|at-room|prompt|consent|join|seat-key|common|tasks|presence|session-end|session-restore|mod-hello|row-[\w-]+)(?![\w.-])|mcp\/[\w-]+(?:\.(?:[cm]?js|ts))?(?![\w-]))/;
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

/** bashVerdict reads ctx.realCwd / realPluginRoot for this command (ctx.cwd it reads for every command it can). */
export const needsCwd = (command: unknown): boolean => {
  const cmd = typeof command === 'string' ? command : '';
  return RUNS_JS.test(cmd) && PLUGIN_CODE.test(cmd) && !NAMES_PLUGIN(cmd);
};

// ---------- Bash: the paths a command's words can reach ----------
/** Tools that read files or walk a tree whatever their words say (a pattern, a code string): pointed at a directory
 * above a protected path, they reach it. grep only with -r / -R / --recursive / -d recurse (else it reads the files
 * its words name, which the path rules see). */
const WALKERS = new Set(['rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'tar', 'bsdtar', 'zip', '7z', 'rsync', 'xargs', 'python', 'python3',
  'node', 'nodejs', 'bun', 'deno', 'perl', 'ruby', 'php', 'eval', 'osascript', 'pax', 'cpio']);
/** Shells: walkers only with -c (a script they run as code). cp and scp: only recursive. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Tools whose plain words are paths they read (their words resolve against the cwd, or the last cd). */
const READERS = new Set(['cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq', 'nl', 'xxd', 'od',
  'hexdump', 'strings', 'base64', 'grep', 'egrep', 'fgrep', 'cp', 'mv', 'ln', 'scp', 'dd', 'diff', 'cmp', 'ssh-keygen', 'openssl',
  'tee', 'jq', 'yq', 'wc', 'file', 'source', '.', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'open', 'pbcopy', 'gzip', 'gunzip', 'bzip2',
  'xz', 'zcat', 'unzip', 'ls', 'stat', 'md5', 'md5sum', 'shasum', 'sha256sum', 'install', 'rm', 'touch', 'chmod', 'truncate', ...WALKERS, ...SHELLS]);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'caffeinate']);
const GLOB_CHARS = /[*?[]/;
/** Words that are paths inside other words (an interpreter's code, an option's value): absolute, ~ or $HOME ones. */
const EMBEDDED = /(?:~|\$\{?HOME\}?)?\/[^\s'"`;|&()<>=,]*/g;

/** {a,b} alternatives expanded (innermost first, at most max words). */
export function braceExpand(word: string, max = 64): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) return [word];
  const out: string[] = [];
  for (const alt of m[0].slice(1, -1).split(',')) { // the braces' inside (the group)
    for (const w of braceExpand(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length), max)) {
      out.push(w);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** One glob segment as a test of a name (`*` and `?` match a leading dot too: a shell may be set to). */
function segTest(seg: string): (name: string) => boolean {
  if (!GLOB_CHARS.test(seg)) return name => name === seg;
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = seg.indexOf(']', i + 2);
      if (j < 0) { re += '\\['; continue; }
      let cls = seg.slice(i + 1, j);
      if (cls[0] === '!') cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = j;
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try { const r = new RegExp('^' + re + '$', 's'); return n => r.test(n); } catch { return () => true; }
}

/**
 * Whether the absolute word p (glob segments allowed) can name the protected path root or one under it ('under'), or
 * one of root's ancestors ('above'); null: neither. A root segment '*' stands for any one name (a transcript's project
 * directory).
 */
export function reach(p: string, root: string): 'under' | 'above' | null {
  const ps = normalize(p).split('/').filter(Boolean), rs = root.split('/').filter(Boolean);
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i] ?? '', s = ps[i]; // r: i is in range
    if (s === undefined) return 'above';
    if (s === '**') return 'under';
    if (r !== '*' && !segTest(s)(r)) return null;
  }
  return 'under';
}

/** A protected path and what to say about it. */
interface Protected { root: string; why: string; above: string }
const STORE_WHY = 'it touches the room store';
const STORE_ABOVE = 'it searches or reads a directory above the room store, which holds the seat signing keys';
const TALK_WHY = 'it reads Claude Code\'s prompt history or this session\'s transcript, where an invite line and its PIN can be';
const TALK_ABOVE = 'it searches a directory above Claude Code\'s prompt history or this session\'s transcript, where an invite line and its PIN can be';

/** The paths bashVerdict and the Read guard protect: each home spelling (and the real one), Claude Code's
 * history.jsonl, and this session's transcript (projects/<any>/<sid>.jsonl and its subagents' directory). */
export function protectedPaths(ctx: GuardCtx = {}): Protected[] {
  const out: Protected[] = [];
  for (const h of [ctx.home, ctx.realHome]) if (typeof h === 'string' && h.startsWith('/') && normalize(h).length >= 4) out.push({ root: normalize(h), why: STORE_WHY, above: STORE_ABOVE });
  const cd = typeof ctx.claudeDir === 'string' && ctx.claudeDir.startsWith('/') ? normalize(ctx.claudeDir) : null;
  if (cd && cd.length > 1) {
    out.push({ root: `${cd}/history.jsonl`, why: TALK_WHY, above: TALK_ABOVE });
    if (typeof ctx.sid === 'string' && /^[\w-]{8,}$/.test(ctx.sid)) {
      out.push({ root: `${cd}/projects/*/${ctx.sid}.jsonl`, why: TALK_WHY, above: TALK_ABOVE });
      out.push({ root: `${cd}/projects/*/${ctx.sid}`, why: TALK_WHY, above: TALK_ABOVE });
    }
  }
  return out;
}

/** A word with ~, $HOME and ${HOME} expanded (userHome known), made absolute against base (a cwd, or a cd's word,
 * which may be a glob), or null: not a path this can place. */
function placeWord(w: string, base: string | null, userHome: string | null): string | null {
  let x = w;
  const tilde = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(x);
  if (tilde) { if (!userHome) return null; x = userHome + x.slice(tilde[0].length); }
  if (x.startsWith('$')) return null; // another variable: not placed (SUB_HUMAN_HOME is a string rule)
  if (x.startsWith('/')) return normalize(x);
  if (!base) return null;
  return normalize(base + '/' + x);
}

const unquote = (w: string): string => w.replace(/["'`\\]/g, '');
const isRecursiveGrep = (args: string[]): boolean => args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive' || /^--directories=recurse$/.test(a) || a === 'recurse');

/** The reason a command reaches a protected path, or null (see the header: lexical, and it follows cd). */
export function pathVerdict(cmd: string, ctx: GuardCtx = {}): string | null {
  const prot = protectedPaths(ctx);
  if (!prot.length) return null;
  const userHome = typeof ctx.userHome === 'string' && ctx.userHome.startsWith('/') ? normalize(ctx.userHome) : null;
  let base: string | null = typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/') ? normalize(ctx.cwd) : null;
  let walks = false;
  const aboves: { p: Protected }[] = [];
  const check = (word: string, at: string | null): string | null => {
    for (const w of braceExpand(word)) {
      const p = placeWord(w, at, userHome);
      if (!p) continue;
      for (const pr of prot) {
        const r = reach(p, pr.root);
        if (r === 'under') return pr.why;
        if (r === 'above') aboves.push({ p: pr });
      }
    }
    return null;
  };
  for (const seg of cmd.split(/\|\||&&|[;|&\n()]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean).map(unquote).map(w => w.replace(/^\d*[<>]+&?/, '')).filter(Boolean);
    let i = 0;
    for (let w = words[0]; w !== undefined; w = words[++i]) {
      if (!(/^\w+=/.test(w) || WRAPPERS.has(w) || /^-/.test(w) && i > 0 && WRAPPERS.has(words[i - 1] ?? ''))) break;
    }
    const next = words[i];
    if (next !== undefined && words[i - 1] === 'timeout' && /^\d/.test(next)) i++;
    const tool = (words[i] || '').split('/').pop() || '';
    const args = words.slice(i + 1);
    if (tool === 'cd' || tool === 'pushd') {
      const target = args.find(a => !a.startsWith('-')) ?? '~';
      const why = check(target, base); // a cd into the store is the store
      if (why) return why;
      const [first = target] = braceExpand(target); // never empty
      base = placeWord(first, base, userHome);
      continue;
    }
    const walker = WALKERS.has(tool) || (SHELLS.has(tool) && args.includes('-c')) || (['grep', 'egrep', 'fgrep'].includes(tool) && isRecursiveGrep(args))
      || (['cp', 'scp'].includes(tool) && args.some(a => /^-[a-zA-Z]*[rRa]/.test(a)));
    if (walker) walks = true;
    const reads = READERS.has(tool);
    let plain = 0;
    for (const a of args) {
      const val = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a;
      if (!val) continue;
      if (!a.startsWith('-')) plain++;
      if (!reads && !val.includes('/') && !GLOB_CHARS.test(val) && val !== '.' && val !== '..' && !/^~/.test(val)) continue;
      const why = check(val, base);
      if (why) return why;
    }
    // a walker with no path word (rg PATTERN, grep -r PATTERN, find -name X) walks where it stands
    const [arg0] = args;
    if (walker && base && (tool === 'find' ? arg0 === undefined || arg0.startsWith('-') : plain <= 1)) { const why = check('.', base); if (why) return why; }
  }
  // paths inside other words: an interpreter's code, a quoted string
  for (const m of cmd.matchAll(EMBEDDED)) { const why = check(unquote(m[0]), base); if (why) return why; }
  const [above] = aboves;
  if (walks && above) return above.p.above;
  return null;
}

const SIMPLE_ESC: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** One ANSI-C quoted word's body decoded from cmd[j] (just past $'): [decoded, index past the closing '], or null. */
function ansiWord(cmd: string, j: number): [string, number] | null {
  let word = '';
  for (;;) {
    if (j >= cmd.length) return null; // unterminated
    const ch = cmd[j];
    if (ch === "'") return [word, j + 1];
    if (ch !== '\\') { word += ch; j++; continue; }
    const e = cmd[j + 1];
    if (e === undefined) return null;
    let m: RegExpExecArray | null;
    const rest = cmd.slice(j + 1);
    if (SIMPLE_ESC[e] !== undefined) { word += SIMPLE_ESC[e]; j += 2; }
    // m[0] is the escape past its backslash: its letter, then the digits (or \c's character)
    else if ((m = /^x[0-9a-fA-F]{1,2}/.exec(rest))) { word += String.fromCharCode(parseInt(m[0].slice(1), 16)); j += 1 + m[0].length; }
    else if ((m = /^u[0-9a-fA-F]{1,4}/.exec(rest))) { word += String.fromCodePoint(parseInt(m[0].slice(1), 16)); j += 1 + m[0].length; }
    else if ((m = /^U[0-9a-fA-F]{1,8}/.exec(rest))) { const n = parseInt(m[0].slice(1), 16); if (n > 0x10ffff) return null; word += String.fromCodePoint(n); j += 1 + m[0].length; }
    else if ((m = /^[0-7]{1,3}/.exec(rest))) { word += String.fromCharCode(parseInt(m[0], 8) & 0xff); j += 1 + m[0].length; }
    else if ((m = /^c./.exec(rest))) { word += String.fromCharCode(m[0].charCodeAt(1) & 0x1f); j += 3; }
    else { word += '\\' + e; j += 2; }
  }
}

/** Where the scan stands (ansiC): 'u' unquoted, 'd' double quotes, 'p' a $( in double quotes or a heredoc body
 * (unquoted inside; depth counts its parens, cases its open `case`s), 'b' a backtick, 'v' a ${ in double quotes or a
 * heredoc body (the shell reads $'…' inside it: depth counts its braces), 'h' an unquoted heredoc's body (expansions,
 * no quotes). */
type Frame = { k: 'u' | 'd' | 'p' | 'b' | 'v' | 'h'; depth: number; cases: number };
const frame = (k: Frame['k']): Frame => ({ k, depth: 0, cases: 0 });
/** A heredoc whose body starts at the next newline: its delimiter, whether it was quoted (a literal body), <<- (tabs). */
type Heredoc = { delim: string; quoted: boolean; strip: boolean };

/** The shell keyword w starts at cmd[i] as a word of its own. */
function keywordAt(cmd: string, i: number, w: string): boolean {
  if (!cmd.startsWith(w, i)) return false;
  const before = cmd.charAt(i - 1), after = cmd.charAt(i + w.length); // '' past either end
  return (before === '' || /[\s;&|(`]/.test(before)) && (after === '' || /[\s;&|)]/.test(after));
}

/** A heredoc operator at cmd[i] (`<<` or `<<-`, not `<<<`): the heredoc and the index past its delimiter word, or
 * null when no word follows. */
function heredocAt(cmd: string, i: number): [Heredoc, number] | null {
  let j = i + 2;
  const strip = cmd[j] === '-';
  if (strip) j++;
  while (cmd[j] === ' ' || cmd[j] === '\t') j++;
  let delim = '', quoted = false;
  while (j < cmd.length && !/[\s;&|<>()]/.test(cmd.charAt(j))) {
    const c = cmd[j];
    if (c === "'" || c === '"') {
      const close = cmd.indexOf(c, j + 1);
      if (close < 0) return null;
      delim += cmd.slice(j + 1, close); quoted = true; j = close + 1;
    } else if (c === '\\') { delim += cmd[j + 1] ?? ''; quoted = true; j += 2; }
    else { delim += c; j++; }
  }
  return delim ? [{ delim, quoted, strip }, j] : null;
}

/** The body of heredoc hd from cmd[i] (just past its operator's line): [body, delimiter line, index past it]. A body
 * with no delimiter line runs to the end (the shell warns and takes it). */
function heredocBody(cmd: string, i: number, hd: Heredoc): [string, string, number] {
  for (let at = i; at < cmd.length;) {
    const nl = cmd.indexOf('\n', at);
    const end = nl < 0 ? cmd.length : nl;
    const line = cmd.slice(at, end);
    if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) return [cmd.slice(i, at), cmd.slice(at, nl < 0 ? end : end + 1), nl < 0 ? end : end + 1];
    at = end + 1;
  }
  return [cmd.slice(i), '', cmd.length];
}

/**
 * The command with each ANSI-C quoted word ($'…') decoded as bash and zsh read it (\xHH, \NNN octal, \uHHHH,
 * \UHHHHHHHH, \cX and the one-letter escapes; an unknown escape keeps its backslash), so `cat /h/$'\x68'ost/keys/…`
 * is placed as /h/host/keys/…, and each $"…" (a locale string) read as the double-quoted string it is
 * (`/h/$"home"` is /h/home). null: a $'…' this cannot read whole (unterminated): denied.
 * A $' counts only where the shell reads one: unquoted (also inside $(…), ${…} or `…` in double quotes or an
 * unquoted heredoc's body), never inside '…' (where $ is literal: grep 'foo$'), inside "…", after a backslash, as the
 * second $ of $$, or in a heredoc's body outside those (a quoted heredoc's body is literal throughout). A
 * `case` inside $(…) keeps its patterns' ) from closing it.
 */
export function ansiC(cmd: string): string | null {
  if (!cmd.includes("$'") && !cmd.includes('$"')) return cmd;
  return scanQuotes(cmd, 'u', false);
}

/**
 * ansiC, and each backtick inside single quotes dropped: there it is a literal character, never a command
 * substitution, so it must not split a path word (`sed -e 's/`a`/c/'` holds no path "/"). Words lose their backticks
 * anyway (pathVerdict's unquote); this keeps the embedded-path scan from reading one as a word's end.
 */
export function readQuotes(cmd: string): string | null {
  if (!cmd.includes("$'") && !cmd.includes('$"') && !(cmd.includes("'") && cmd.includes('`'))) return cmd;
  return scanQuotes(cmd, 'u', true);
}

/** ticks: drop each backtick inside '…' (readQuotes). */
function scanQuotes(cmd: string, start: Frame['k'], ticks: boolean): string | null {
  let out = '';
  const root = frame(start);
  const st: Frame[] = [root];
  const pending: Heredoc[] = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    const f = st.at(-1) ?? root; // root is never popped: st is never empty
    if (c === '\\') { out += cmd.slice(i, i + 2); i += 2; continue; }
    if (c === '\n' && pending.length && (f.k === 'u' || f.k === 'p' || f.k === 'b')) {
      out += c; i++;
      // each heredoc this line opened: its body, literal when its word was quoted, else read as the shell does
      for (const hd of pending.splice(0)) {
        const [body, close, next] = heredocBody(cmd, i, hd);
        const read = hd.quoted ? body : scanQuotes(body, 'h', ticks);
        if (read === null) return null;
        out += read + close; i = next;
      }
      continue;
    }
    if (f.k === 'd' || f.k === 'h') {
      if (c === '"' && f.k === 'd') { st.pop(); out += c; i++; continue; }
      if (c === '$' && cmd[i + 1] === '(') { st.push(frame('p')); out += '$('; i += 2; continue; }
      if (c === '$' && cmd[i + 1] === '{') { st.push(frame('v')); out += '${'; i += 2; continue; }
      if (c === '`') st.push(frame('b'));
      out += c; i++; continue;
    }
    // u, p, b, v: the shell reads quotes here
    if (c === '$' && cmd[i + 1] === '$') { out += '$$'; i += 2; continue; }
    if (c === '$' && cmd[i + 1] === "'") {
      const w = ansiWord(cmd, i + 2);
      if (!w) return null;
      out += w[0]; i = w[1]; continue;
    }
    if (c === '$' && cmd[i + 1] === '"') { st.push(frame('d')); out += '"'; i += 2; continue; } // $"…": a "…" string
    if (c === "'" && f.k !== 'v') { // inside "${…}" a ' is a plain character
      const close = cmd.indexOf("'", i + 1);
      const to = close < 0 ? cmd.length : close + 1;
      const span = cmd.slice(i, to);
      out += ticks ? span.replace(/`/g, '') : span; i = to; continue;
    }
    if (c === '"') { st.push(frame('d')); out += c; i++; continue; }
    if (c === '`') { if (f.k === 'b') st.pop(); else st.push(frame('b')); out += c; i++; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && f.k !== 'v') {
      const hd = heredocAt(cmd, i);
      if (hd) { pending.push(hd[0]); out += cmd.slice(i, hd[1]); i = hd[1]; continue; }
    }
    if (f.k === 'v') {
      if (c === '{') f.depth++;
      else if (c === '}' && f.depth-- === 0) st.pop();
    } else if (f.k === 'p') {
      if (c === '(') f.depth++;
      else if (c === ')') { if (!(f.cases > 0 && f.depth === 0) && f.depth-- === 0) st.pop(); } // a case pattern's ) stays
      else if (keywordAt(cmd, i, 'case')) f.cases++;
      else if (f.cases > 0 && keywordAt(cmd, i, 'esac')) f.cases--;
    }
    out += c; i++;
  }
  return out;
}

/** 'deny reason' for a Bash command, or null. */
export function bashVerdict(command: unknown, ctx: GuardCtx = {}): string | null {
  const raw = typeof command === 'string' ? command : '';
  if (!raw.trim()) return null;
  // $'…' words read as the shell reads them (and '…' as the literal it is); one this cannot read is not placed, so it is denied
  const read = readQuotes(raw);
  if (read === null) return 'it has an ANSI-C quoted word ($\'…\') the guard cannot read whole';
  // a ${NAME:-word} is read both ways: NAME set (a variable, not placed) and unset (its word: "/h/${u:-h}ome")
  const unset = withDefaults(read);
  return verdictOf(read, ctx) ?? (unset !== read ? verdictOf(unset, ctx) : null);
}

/** cmd with each ${NAME:-word}, ${NAME-word}, ${NAME:=word} or ${NAME=word} (no braces inside) as its word: what the
 * shell makes of it when NAME is unset. */
const withDefaults = (cmd: string): string => cmd.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^{}]*)\}/g, '$1');

function verdictOf(cmd: string, ctx: GuardCtx): string | null {
  if (READ_CLI.test(cmd) || READ_DOCTOR.test(cmd)) return null;
  if (DOCTOR_WRITES.test(cmd)) return DOCTOR_WHY;
  if (PERSON_CLI.test(cmd) || LOGIN_SERVE.test(cmd)) return 'it makes an invite, lets a machine in or out, or speaks for the room\'s connection: the person does that in their own session (/sub-human invite, admit or kick) or in a terminal outside Claude Code, never with !, which would put an invite and its PIN into this conversation';
  if (ENV_NAMES.test(cmd)) return 'it names the store location variable (SUB_HUMAN_HOME)';
  if (DOT_HOME.test(cmd)) return 'it touches the room store (~/.sub-human)';
  for (const h of homeSpellings(ctx)) {
    for (let i = cmd.indexOf(h); i >= 0; i = cmd.indexOf(h, i + 1)) {
      if (!/[\w.-]/.test(cmd[i + h.length] || '')) return 'it touches the room store'; // not /home2 or .sub-humanoid
    }
  }
  if (HISTORY.test(cmd)) return TALK_WHY;
  const reached = pathVerdict(cmd, ctx);
  if (reached) return reached;
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

/** `SUB_HUMAN_HOME=<home> ` when home (absolute) is not the default ~/.sub-human, so a terminal acts on this folder
 *  (lib/text.ts homePrefix is the same rule, for node); '' otherwise. */
export function homeEnv(home: unknown, userHome: unknown): string {
  if (typeof home !== 'string' || !home.startsWith('/')) return '';
  const trim = (p: string) => p.replace(/\/+$/, '') || '/';
  const dflt = homeOf(undefined, userHome);
  if (dflt && trim(dflt) === trim(home)) return '';
  return `SUB_HUMAN_HOME=${/[^\w@%+=:,./~-]/.test(home) ? `'${home.replace(/'/g, "'\\''")}'` : home} `;
}

/** The deny text. root (the plugin root, when known): name the read-only CLI by its path; it lives in scripts/, which is
 *  not on the Bash tool's PATH (a top-level bin/ would be, but claude.ai org sync rejects a plugin that has one).
 *  doctor --fix / --bundle: a person's step, run in a terminal (by the same path), never the store's wording. */
export const denyText = (why: string, root: unknown, homes: { home?: unknown; userHome?: unknown } = {}): string => {
  const known = typeof root === 'string' && root.startsWith('/');
  if (why === DOCTOR_WHY) {
    return `ROOM-GUARD: sub-human ${why} (the shim, the home's modes, a bundle file), so they are the person's step: ${
      known ? `they run \`${homeEnv(homes.home, homes.userHome)}node ${root}/scripts/sub-human doctor --bundle\` (or --fix) ` : 'they run it '}in a terminal outside Claude Code. In a session, /sub-human doctor is the read-only check.`;
  }
  if (why === TALK_WHY || why === TALK_ABOVE) return `ROOM-GUARD: the invite lines and PINs typed or shown in Claude Code are the people's own; a model never reads them. (Denied: ${why}.)`;
  return `${MSG} (Denied: ${why}.) Use the room MCP tools${known ? `, or \`${root}/scripts/sub-human read|who|tasks|show\`` : ''}.`;
};

// ---------- Write / Edit / MultiEdit / NotebookEdit ----------
/** The path the tool input names, or null. */
export function writeTarget(input: { file_path?: unknown; notebook_path?: unknown } | null | undefined = {}): string | null {
  const p = input && (input.file_path || input.notebook_path);
  return typeof p === 'string' && p ? p : null;
}

/** The path made absolute (~ expanded), or null when it cannot be. */
export function absTarget(p: unknown, { cwd, userHome }: { cwd?: string | null | undefined; userHome?: string | null } = {}): string | null {
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
 * sign via=human entries that verify), listen/ (the web listener's Noise private key), links/ (each link's token, a
 * pending invite's SECRET and PIN, and a web link's own Noise key) and sessions/ (the hooks module's lease with the
 * session's nonce, sessions/mods/, and the session indexes). Everything else in the store stays readable.
 */
export const SECRET_DIRS: readonly string[] = ['keys', 'listen', 'links', 'sessions'];
const SECRET_SEGMENT = /(?:^|\/)\.sub-human\/(?:keys|listen|links|sessions)(?:\/|$)/;
const DOT_HOME_END = /(?:^|\/)\.sub-human\/?$/;
const homesOf = (ctx: GuardCtx): string[] => [ctx.home, ctx.realHome].filter((r): r is string => typeof r === 'string' && r.startsWith('/')).map(normalize);
const secretRoots = (ctx: GuardCtx): string[] => homesOf(ctx).flatMap(h => SECRET_DIRS.map(d => (h === '/' ? '' : h) + '/' + d));

/**
 * 'deny reason' for a Read whose target is any of candidates and lies under one of the home's secret directories
 * (SECRET_DIRS), or null. Before mod-hello answered, a path through ".sub-human/keys|listen|links" counts.
 */
export function readVerdict(candidates: unknown[], ctx: GuardCtx = {}, raw: unknown = ''): string | null {
  const cands = candidates.filter((c): c is string => typeof c === 'string' && !!c);
  const talk = protectedPaths(ctx).filter(p => p.why === TALK_WHY);
  if (cands.some(c => talk.some(t => reach(c, t.root) === 'under')) || HISTORY.test(String(raw || ''))) return 'it reads Claude Code\'s prompt history or this session\'s transcript';
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
  const talk = protectedPaths(ctx).filter(p => p.why === TALK_WHY);
  if (cands.some(c => talk.some(t => reach(c, t.root) !== null))) return TALK_ABOVE;
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

export const READ_DENY = (p: string | null, tool = 'Read') => `ROOM-GUARD: the seat signing keys, the links' secrets and the invite lines and PINs typed here are the people's own; a model never reads or searches them. (Denied: ${tool} on ${p || 'the working directory'}.)`;

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
