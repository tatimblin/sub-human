#!/usr/bin/env node
/**
 * directory-lint: the Anthropic plugin directory's review rules this plugin has tripped, re-implemented, because no
 * official tool runs the directory portal's checks. npm run lint runs it (scripts/lint.ts), so CI does.
 *
 *   node scripts/directory-lint.ts [PLUGIN_DIR]     default plugin/sub-human; exit 1 on any finding
 *
 * Each finding prints `file:line  RULE  what — fix: how`.
 *
 *   MOD_PERMISSION_ANSWER_UNREAD  mod/**.ts (not mod/test): a classic.PreToolUse hook, a tool.call hook that answers
 *       `{ deny` itself, and each one's .catch handler, may only `return next(e)` (or, in tool.call, a const bound to
 *       `await next(e)`, passed through, also as `{ ...r, key: value }` that adds members but no deny, ask or allow)
 *       or an object literal of plain `key: value` members with a fixed `deny` or
 *       `ask` key: no spread, no computed key, no method or getter, no `allow`. A ternary is judged branch by branch.
 *       A tool.check or a classic.PermissionRequest hook is refused outright: the plugin answers no permission check.
 *   COMMAND_PATH_COMPUTED  (a hook or settings command names at most one plugin path and starts with no exec/eval)
 *                          every command in hooks/hooks.json, .mcp.json (command and args), settings.json (any
 *       `command`) and inline hooks/mcpServers in .claude-plugin/plugin.json names files only as
 *       `${CLAUDE_PLUGIN_ROOT}/<literal path to a file that exists>`: no other variable or expansion, no `$(`, no
 *       backticks, no glob or brace, no shell operator, no `-c`/`-e`/`--eval`/`-p`/`--print`.
 *   MOD_RUNS_PROCESS  mod/**.ts: a `$.process.run(` / `$.process.spawn(` whose arguments hold `-c`, `-e`, `--eval`,
 *       `-p` or `--print` as a string, or a string with a shell program in it (`;`, `|`, `&`, `>`, `<`, `$(`, a
 *       backtick).
 *   INVISIBLE_CHARACTER  any text file under the plugin: U+00AD, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF
 *       as characters (the escape written out in source is fine).
 *   LIMIT_*  the checklist: ≤ 512 files; every file but images and fonts < 256 KiB; no .DS_Store, Thumbs.db,
 *       desktop.ini or __MACOSX; README.md ≥ 40 words outside code blocks; a LICENSE file or `license` in
 *       .claude-plugin/plugin.json; no package.json beside a lockfile at the plugin root.
 *
 * Limits (a text scan, not a parser): a hook is found by `on('event'` with a literal event name; its handler is the
 * first `=>` inside that call, and its body is found by bracket matching over the source with strings, comments,
 * template literals and (by a heuristic on the previous token) regex literals blanked out. Every `return` in a body
 * counts, a nested function's too (stricter, never looser). A return's value ends at the first `;` or unmatched
 * closer at its depth; a ternary is split at its top-level `?`/`:`; any other expression (a call, `a || b`) is
 * refused. A process argv built elsewhere (mod/core/shim.ts shimArgv) is not followed. The file list is
 * `git ls-files` under the plugin inside a repository, else a walk of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, REPO } from './lib/paths.ts';

/** One finding. file is relative to the plugin root. */
export interface Finding { file: string, line: number, rule: string, message: string, fix: string }

// ---------------------------------------------------------------------------------------------------------------
// source masking: strings, templates, comments and regex literals blanked (offsets and newlines kept)

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** src with every string, template literal, comment and regex literal body replaced by spaces (quotes kept). */
export function mask(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = ''; // the last significant character outside strings and comments ('w' for a word)
  let prevWord = '';
  while (i < src.length) {
    const c = src[i] ?? '';
    const d = src[i + 1] ?? '';
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? src.length : j; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? src.length : j + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; prev = c; prevWord = ''; continue;
    }
    if (c === '/' && (prev === '' || REGEX_BEFORE.has(prev) || prevWord === 'return')) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        const k = src[j];
        if (k === '\\') { j += 2; continue; }
        if (k === '[') cls = true; else if (k === ']') cls = false; else if (k === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; prev = '/'; prevWord = ''; continue; }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j] ?? '')) j++;
      prevWord = src.slice(i, j); prev = 'w'; i = j; continue;
    }
    prev = c; prevWord = ''; i++;
  }
  return out.join('');
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/** The index of the bracket closing the one at m[open] (masked text), or -1. */
function matching(m: string, open: number): number {
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    const c = m[i] ?? '';
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The end of an expression starting at `from`: the first `;` (or `,`) at its depth, or an unmatched closer. */
function exprEnd(m: string, from: number, stopAtComma: boolean): number {
  let depth = 0;
  for (let i = from; i < m.length; i++) {
    const c = m[i] ?? '';
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === ';' || (stopAtComma && c === ','))) return i;
  }
  return m.length;
}

const lineAt = (src: string, i: number): number => src.slice(0, i).split('\n').length;

/** m[from,to) split at top-level `sep`: [start, end) ranges. */
function topLevelSplit(m: string, from: number, to: number, sep: string): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0, start = from;
  for (let i = from; i < to; i++) {
    const c = m[i] ?? '';
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (depth === 0 && c === sep) { parts.push([start, i]); start = i + 1; }
  }
  parts.push([start, to]);
  return parts;
}

/** The top-level ternary in m[from,to): [its `?`, its `:`], or null. */
function ternary(m: string, from: number, to: number): [number, number] | null {
  let depth = 0, q = -1, nested = 0;
  for (let i = from; i < to; i++) {
    const c = m[i] ?? '';
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (depth === 0 && c === '?') {
      const n = m[i + 1] ?? '';
      if (n === '?' || n === '.') { i++; continue; }
      if (q < 0) q = i; else nested++;
    } else if (depth === 0 && c === ':' && q >= 0) {
      if (nested) nested--; else return [q, i];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// rule 1: MOD_PERMISSION_ANSWER_UNREAD

const R1 = 'MOD_PERMISSION_ANSWER_UNREAD';
const R1_FIX = 'return next(e), or an object literal written out member by member with a fixed `deny`/`ask` key (no spread, computed key, method or `allow`)';
const FORBIDDEN_EVENTS = new Set(['tool.check', 'classic.PermissionRequest']);

interface Handler { from: number, to: number, expr: boolean }

/** The handler at the first `=>` in m[from, limit): its block body's range, or its expression body's. */
function handlerAt(m: string, from: number, limit: number): Handler | null {
  const arrow = m.indexOf('=>', from);
  if (arrow < 0 || arrow > limit) return null;
  let i = arrow + 2;
  while (/\s/.test(m[i] ?? '')) i++;
  if (m[i] === '{') { const end = matching(m, i); return end < 0 ? null : { from: i + 1, to: end, expr: false }; }
  return { from: i, to: exprEnd(m, i, true), expr: true };
}

/** Why a returned value src[from,to) is not a readable answer, or null when it is. */
function judgeValue(src: string, m: string, from: number, to: number, nextVars: ReadonlySet<string>, passOn = false): string | null {
  while (from < to && /\s/.test(m[from] ?? '')) from++;
  while (to > from && /\s/.test(m[to - 1] ?? '')) to--;
  if (m[from] === '(' && matching(m, from) === to - 1) return judgeValue(src, m, from + 1, to - 1, nextVars, passOn);
  const t = ternary(m, from, to);
  if (t) return judgeValue(src, m, t[0] + 1, t[1], nextVars, passOn) ?? judgeValue(src, m, t[1] + 1, to, nextVars, passOn);
  const aw = /^await\s+/.exec(src.slice(from, to));
  if (aw) return judgeValue(src, m, from + aw[0].length, to, nextVars, passOn);
  const text = src.slice(from, to);
  if (/^next\(\s*[\w$]+\s*\)$/.test(text)) return null;
  if (/^[\w$]+$/.test(text)) return nextVars.has(text) ? null : `returns \`${text}\`, a value not written out`;
  if (m[from] !== '{' || matching(m, from) !== to - 1) return `returns \`${(text.split('\n')[0] ?? '').slice(0, 60)}\`, not next(e) or an object literal`;
  const members = topLevelSplit(m, from + 1, to - 1, ',').map(([a, b]) => src.slice(a, b).trim()).filter(Boolean);
  // tool.call only: the tool's own answer passed on with context added (`{ ...r, context }`, r bound to await next(e)):
  // no deny, ask or allow of the hook's own, nothing computed; it decides nothing (the directory flags no such return)
  const head = /^\.\.\.([\w$]+)$/.exec(members[0] ?? '');
  if (passOn && head && nextVars.has(head[1] ?? '') && members.slice(1).every(x => /^([\w$]+)\s*:/.test(x) && !/^(?:deny|ask|allow)\s*:/.test(x))) return null;
  let keyed = false;
  for (const [a, b] of topLevelSplit(m, from + 1, to - 1, ',')) {
    const member = src.slice(a, b).trim();
    if (!member) continue;
    if (member.startsWith('...')) return `spreads \`${(member.split('\n')[0] ?? '').slice(0, 50)}\` into its answer`;
    if (member.startsWith('[')) return 'answers with a computed key';
    if (/^(?:get|set|async)\s+[\w$]+\s*\(/.test(member) || /^[\w$]+\s*\(/.test(member)) return 'answers with a method or getter';
    const k = /^([\w$]+|'[^']*'|"[^"]*")\s*(?::|$)/.exec(member);
    if (!k) return `answers with an unreadable member \`${member.slice(0, 40)}\``;
    const key = (k[1] ?? '').replace(/^['"]|['"]$/g, '');
    if (key === 'allow') return 'answers `allow`: the plugin approves nothing';
    if (key === 'deny' || key === 'ask') keyed = true;
  }
  return keyed ? null : 'answers an object with no fixed `deny` or `ask` key';
}

/** The findings of one handler. */
function judgeHandler(src: string, m: string, h: Handler, file: string, event: string): Finding[] {
  const nextVars = new Set<string>();
  for (const v of src.slice(h.from, h.to).matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*await\s+next\(/g)) if (v[1]) nextVars.add(v[1]);
  const ranges: [number, number][] = [];
  if (h.expr) ranges.push([h.from, h.to]);
  else for (const r of m.slice(h.from, h.to).matchAll(/\breturn\b/g)) {
    const at = h.from + (r.index ?? 0) + 'return'.length;
    ranges.push([at, exprEnd(m, at, false)]);
  }
  const out: Finding[] = [];
  for (const [a, b] of ranges) {
    const why = judgeValue(src, m, a, b, nextVars, event === 'tool.call');
    if (why) out.push({ file, line: lineAt(src, a), rule: R1, message: `a ${event} hook ${why}`, fix: R1_FIX });
  }
  return out;
}

/** Rule 1 over one module's source. */
export function checkPermissionAnswers(src: string, file: string): Finding[] {
  const m = mask(src);
  const out: Finding[] = [];
  for (const call of src.matchAll(/\bon\(\s*(['"])([\w.]+)\1/g)) {
    const event = call[2] ?? '';
    const at = call.index ?? 0;
    if (m.slice(at, at + 3) !== 'on(') continue; // inside a comment or a string
    if (FORBIDDEN_EVENTS.has(event)) {
      out.push({ file, line: lineAt(src, at), rule: R1, message: `a ${event} hook: the plugin answers no permission check`, fix: 'remove the hook; refuse in classic.PreToolUse or tool.call with a fixed { deny } instead' });
      continue;
    }
    if (event !== 'tool.call' && event !== 'classic.PreToolUse') continue;
    const open = at + 2;
    const close = matching(m, open);
    if (close < 0) continue;
    const handlers: Handler[] = [];
    const main = handlerAt(m, open, close);
    if (main) handlers.push(main);
    const after = /^\s*\.catch\(/.exec(m.slice(close + 1));
    if (after) {
      const cOpen = close + after[0].length;
      const cClose = matching(m, cOpen);
      const c = cClose < 0 ? null : handlerAt(m, cOpen, cClose);
      if (c) handlers.push(c);
    }
    // a tool.call hook is in scope when it answers `{ deny` itself
    if (event === 'tool.call' && !handlers.some(h => /\{\s*deny\b/.test(src.slice(h.from, h.to)))) continue;
    for (const h of handlers) out.push(...judgeHandler(src, m, h, file, event));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// rule 3: MOD_RUNS_PROCESS

const R3 = 'MOD_RUNS_PROCESS';
const EVAL_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print']);
const SHELL_PROGRAM = /[;|&<>`]|\$\(/;

/** Rule 3 over one module's source. */
export function checkProcessRuns(src: string, file: string): Finding[] {
  const m = mask(src);
  const out: Finding[] = [];
  for (const call of m.matchAll(/\$\.process\.(?:run|spawn)\s*\(/g)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const close = matching(m, open);
    if (close < 0) continue;
    for (let i = open; i < close; i++) {
      const q = src[i] ?? '';
      if ((q !== "'" && q !== '"' && q !== '`') || m[i] !== q) continue;
      let j = i + 1;
      while (j < close && !(m[j] === q && src[j] === q)) j++;
      const raw = src.slice(i + 1, j);
      const lit = q === '`' ? raw.replace(/\$\{[^}]*\}/g, '') : raw;
      const why = EVAL_FLAGS.has(lit) ? `passes \`${lit}\`: an inline program` : SHELL_PROGRAM.test(lit) ? `passes the shell text \`${lit.slice(0, 40)}\`` : null;
      if (why) out.push({ file, line: lineAt(src, i), rule: R3, message: `$.process ${why}`, fix: 'run a script file in the plugin (sh, then its path) with plain arguments and the data on stdin' });
      i = j;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// rule 2: COMMAND_PATH_COMPUTED

const R2 = 'COMMAND_PATH_COMPUTED';
const R2_FIX = 'name a file in the plugin as ${CLAUDE_PLUGIN_ROOT}/<path>, literally; compute anything else inside that script';
const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}/';

/** The shell words of a command string, quotes removed. */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '', started = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? '';
    if (c === '"' || c === "'") {
      const j = cmd.indexOf(c, i + 1);
      const end = j < 0 ? cmd.length : j;
      cur += cmd.slice(i + 1, end); started = true; i = end; continue;
    }
    if (/\s/.test(c)) { if (started) out.push(cur); cur = ''; started = false; continue; }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Why one word of a command (root: the plugin root) is not allowed, or null. */
export function judgeWord(word: string, root: string): string | null {
  if (/[;|&<>]/.test(word)) return `a shell operator in \`${word}\``;
  if (word.includes('$(') || word.includes('`')) return `a command substitution in \`${word}\``;
  if (EVAL_FLAGS.has(word)) return `\`${word}\`: an inline program`;
  let rest = word;
  if (word.includes('$')) {
    if (!word.startsWith(ROOT_VAR)) return `\`${word}\`: a variable other than a leading \${CLAUDE_PLUGIN_ROOT}/`;
    rest = word.slice(ROOT_VAR.length);
    if (rest.includes('$')) return `\`${word}\`: a variable after \${CLAUDE_PLUGIN_ROOT}/`;
  }
  if (/[*?[\]{}]/.test(rest)) return `\`${word}\`: a glob or brace`;
  if (rest !== word) {
    if (!rest || rest.split('/').includes('..')) return `\`${word}\`: not a path inside the plugin`;
    let isFile: boolean;
    try { isFile = fs.statSync(path.join(root, rest)).isFile(); } catch { isFile = false; }
    if (!isFile) return `\`${word}\`: no such file in the plugin`;
  }
  return null;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJsonFile(f: string): { text: string, data: unknown } | null {
  let text: string;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try { const data: unknown = JSON.parse(text); return { text, data }; } catch { return { text, data: null }; }
}

/** The line of a JSON string value in a file's text (the first that holds it), else 1. */
const lineOfValue = (text: string, value: string): number => {
  const i = text.indexOf(JSON.stringify(value).slice(1, -1));
  return i < 0 ? 1 : lineAt(text, i);
};

/** Every string under a `command` key, anywhere in v. */
function commandsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) commandsIn(x, out);
  else if (isRec(v)) for (const [k, x] of Object.entries(v)) { if (k === 'command' && typeof x === 'string') out.push(x); else commandsIn(x, out); }
  return out;
}

/** The commands of an mcpServers object: each server's command (shell words) and each of its args (one word). */
function mcpCommands(servers: unknown): { cmd: string, single: boolean }[] {
  const out: { cmd: string, single: boolean }[] = [];
  if (!isRec(servers)) return out;
  for (const s of Object.values(servers)) {
    if (!isRec(s)) continue;
    if (typeof s.command === 'string') out.push({ cmd: s.command, single: false });
    if (Array.isArray(s.args)) for (const a of s.args) if (typeof a === 'string') out.push({ cmd: a, single: true });
  }
  return out;
}

/** Rule 2 over a plugin root. */
export function checkCommands(root: string): Finding[] {
  const out: Finding[] = [];
  const judge = (file: string, text: string, cmd: string, single: boolean): void => {
    const ws = single ? [cmd] : words(cmd);
    for (const w of ws) {
      const why = judgeWord(w, root);
      if (why) out.push({ file, line: lineOfValue(text, cmd), rule: R2, message: why, fix: R2_FIX });
    }
    if (single) return;
    // a hook or settings command: the directory reads one file under the plugin root, run by `sh` or by itself
    const named = ws.filter(w => w.startsWith(ROOT_VAR)).length;
    if (named > 1) out.push({ file, line: lineOfValue(text, cmd), rule: R2, message: `names ${named} plugin paths; the directory reads one`, fix: 'run one script, sh "${CLAUDE_PLUGIN_ROOT}/<file>.sh", and name the rest inside it' });
    if (ws[0] === 'exec' || ws[0] === 'eval') out.push({ file, line: lineOfValue(text, cmd), rule: R2, message: `starts with the shell builtin \`${ws[0]}\``, fix: 'run the script itself: sh "${CLAUDE_PLUGIN_ROOT}/<file>.sh"' });
  };
  const hooks = readJsonFile(path.join(root, 'hooks', 'hooks.json'));
  if (hooks) for (const c of commandsIn(hooks.data)) judge('hooks/hooks.json', hooks.text, c, false);
  const mcp = readJsonFile(path.join(root, '.mcp.json'));
  if (mcp && isRec(mcp.data)) for (const c of mcpCommands(mcp.data.mcpServers ?? mcp.data)) judge('.mcp.json', mcp.text, c.cmd, c.single);
  const settings = readJsonFile(path.join(root, 'settings.json'));
  if (settings) for (const c of commandsIn(settings.data)) judge('settings.json', settings.text, c, false);
  const manifest = readJsonFile(path.join(root, '.claude-plugin', 'plugin.json'));
  if (manifest && isRec(manifest.data)) {
    const f = '.claude-plugin/plugin.json';
    if (isRec(manifest.data.hooks)) for (const c of commandsIn(manifest.data.hooks)) judge(f, manifest.text, c, false);
    for (const c of mcpCommands(manifest.data.mcpServers)) judge(f, manifest.text, c.cmd, c.single);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// rule 4: INVISIBLE_CHARACTER

const R4 = 'INVISIBLE_CHARACTER';
// written with escapes, so this file holds none of the characters
const INVISIBLE = /[­​-‏‪-‮⁠-⁩﻿]/g;

/** Rule 4 over one file's text. */
export function checkInvisible(text: string, file: string): Finding[] {
  const out: Finding[] = [];
  for (const hit of text.matchAll(INVISIBLE)) {
    const code = (hit[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    out.push({ file, line: lineAt(text, hit.index ?? 0), rule: R4, message: `U+${code}, an invisible or bidi character`, fix: `delete it, or write the escape \\u${code} in source` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// rule 5: the checklist limits

const MAX_FILES = 512;
const MAX_BYTES = 256 * 1024;
const MIN_README_WORDS = 40;
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|woff2?|ttf|otf|eot)$/i;
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX']);
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];

/** The plugin's files, relative: `git ls-files` inside a repository, else a walk. */
export function pluginFiles(root: string): string[] {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status === 0 && inside.stdout.trim() === 'true') {
    const git = spawnSync('git', ['ls-files', '-z', '--', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (git.status === 0) return git.stdout.split('\0').filter(f => f && fs.existsSync(path.join(root, f)));
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) { if (d.name !== '.git' && d.name !== 'node_modules') walk(rel); } else out.push(rel);
    }
  };
  walk('');
  return out;
}

/** README words outside fenced code blocks. */
export function readmeWords(text: string): number {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Rule 5 over a plugin root and its files. */
export function checkLimits(root: string, files: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const f = (file: string, rule: string, message: string, fix: string): void => { out.push({ file, line: 1, rule, message, fix }); };
  if (files.length > MAX_FILES) f('.', 'LIMIT_FILE_COUNT', `${files.length} files (the limit is ${MAX_FILES})`, 'ship fewer files: keep tests, fixtures and generated files out of the plugin folder');
  for (const rel of files) {
    if (rel.split('/').some(p => JUNK.has(p))) f(rel, 'LIMIT_JUNK_FILE', 'an OS metadata file', 'delete it and ignore it in .gitignore');
    if (MEDIA.test(rel)) continue;
    let size: number;
    try { size = fs.statSync(path.join(root, rel)).size; } catch { continue; }
    if (size >= MAX_BYTES) f(rel, 'LIMIT_FILE_SIZE', `${Math.round(size / 1024)} KiB (the limit is 256 KiB)`, 'split it or keep it out of the plugin folder');
  }
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) f('README.md', 'LIMIT_README', 'no README.md', `add a README.md of at least ${MIN_README_WORDS} words`);
  else {
    const n = readmeWords(fs.readFileSync(readme, 'utf8'));
    if (n < MIN_README_WORDS) f('README.md', 'LIMIT_README', `${n} words outside code blocks (at least ${MIN_README_WORDS})`, 'describe what the plugin does and how to use it');
  }
  const hasLicenseFile = fs.readdirSync(root).some(n => /^(?:LICEN[CS]E|COPYING)(?:\.[\w.]+)?$/i.test(n));
  const manifest = readJsonFile(path.join(root, '.claude-plugin', 'plugin.json'));
  const hasLicenseKey = !!manifest && isRec(manifest.data) && typeof manifest.data.license === 'string' && manifest.data.license.trim() !== '';
  if (!hasLicenseFile && !hasLicenseKey) f('.claude-plugin/plugin.json', 'LIMIT_LICENSE', 'no LICENSE file and no `license` in plugin.json', 'add a LICENSE file or a `license` field');
  if (fs.existsSync(path.join(root, 'package.json'))) {
    const lock = LOCKFILES.find(l => fs.existsSync(path.join(root, l)));
    if (lock) f(lock, 'LIMIT_LOCKFILE', `${lock} beside package.json at the plugin root`, 'the plugin installs no dependencies: delete the lockfile');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|bmp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|lockb)$/i;

/** Every rule over a plugin root. */
export function lint(root: string): Finding[] {
  const files = pluginFiles(root);
  const out: Finding[] = [];
  for (const rel of files) {
    if (BINARY.test(rel)) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    out.push(...checkInvisible(text, rel));
    if (/^mod\/.*\.ts$/.test(rel) && !rel.startsWith('mod/test/')) out.push(...checkPermissionAnswers(text, rel), ...checkProcessRuns(text, rel));
  }
  out.push(...checkCommands(root), ...checkLimits(root, files));
  return out;
}

/** One finding as a line: `base/file:line  RULE  message — fix: fix`. */
export const formatFinding = (f: Finding, base: string): string => `${path.join(base, f.file)}:${f.line}  ${f.rule}  ${f.message} — fix: ${f.fix}`;

function main(argv: readonly string[]): number {
  const root = path.resolve(argv[0] ?? PLUGIN);
  const found = lint(root);
  const base = path.relative(REPO, root) || '.';
  for (const f of found) process.stdout.write(formatFinding(f, base) + '\n');
  process.stdout.write(found.length ? `directory-lint: ${found.length} finding${found.length === 1 ? '' : 's'}\n` : 'directory-lint: clean\n');
  return found.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
