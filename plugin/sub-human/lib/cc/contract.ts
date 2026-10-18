/**
 * plugin/sub-human/lib/cc/contract.ts: the Claude Code internals contract (contract.json), typed, and the probe that checks a binary against it.
 *
 * contract.json is the data: `probed` (the Claude Code version every entry was last checked against), `min` (the oldest
 * that runs the plugin: function hooks) and `entries`, one per undocumented behaviour the plugin relies on:
 *   id, section (§ in docs/internals/cc-2.1.281.md), stability (API | env | incidental), feature (FEATURES: the part of
 *   sub-human that stands on it; lib/cc/verdict.ts turns a failed entry's feature to its fallback), since (the first
 *   version it was checked on), search (literal strings, all must be in the binary), shape? (code where `~` is one minified
 *   identifier), contains? (arrays that must hold names: see probe), degraded? ([{from, issue, note}]: a version on which
 *   the behaviour was reported to change while the probe may still pass), note.
 * scripts/probe-cc.ts reads the JSON itself and runs probe() over the installed binary; `sub-human doctor` runs it too
 * (doctor/claude.ts), and scripts/arch-doc.ts renders the table in docs/ARCHITECTURE.md from the JSON. Every export of
 * lib/cc/{env,transcript,bg}.ts that relies on an entry names one of its search strings in a `@cc` tag.
 *
 *   CONTRACT, PROBED_VERSION, MIN_VERSION       the JSON's entries, probed and min
 *   FEATURES                                    every feature an entry may name (core: the plumbing every feature
 *                                               needs; cosmetic: drawing only; test: the wiring tests)
 *   compareVersions(a, b) -> -1|0|1|null        numeric per dot-separated part; null for an unreadable one
 *   degradedOn(version, entries?) -> [{id, issue, note}]   entries reported degraded on that version or later
 *   shapeRe(shape)                              a shape as a RegExp: `~` = one minified identifier, the rest literal
 *   arrayAt(text, from, {deep}) -> Set|null     the quoted strings of the array literal that starts at or after from
 *   probe(buf, {entries?}) -> [{id, stability, ok, missing, note}]   every entry's search strings, shapes and contains
 *       groups checked against the binary. One latin1 view, String#indexOf, and each shape tested only around its
 *       longest literal piece: ~3 s for a 235 MB binary
 *   locateBinary({bin?, env?}) -> path|null     the binary to probe: bin, $CLAUDE_BIN, `claude` on PATH (symlinks
 *                                               resolved), else the newest /opt/homebrew/Caskroom/claude-code*\/<v>/claude
 *   binaryVersion(buf) -> string|null           the VERSION:"…" literal in the binary
 */

import fs from 'node:fs';
import path from 'node:path';

type Env = NodeJS.ProcessEnv;
type Stability = 'API' | 'env' | 'incidental';
const FEATURES = ['core', 'room-session', 'tasks', 'plan-edit', 'sign-off', 'rows', 'delivery', 'addressing', 'fork', 'statusline', 'cosmetic', 'test', 'fallback'] as const;
/** The part of sub-human an entry's behaviour serves (contract.json `feature`). `fallback`: what a fallback itself relies on, never
 * gated (turning a feature to the fallback that the failed entry carries would leave it nowhere to go). */
type Feature = typeof FEATURES[number];

/**
 * One `contains` group: the array literal at (the first `[` at or after a match of) `in` holds every name, as one of its
 * quoted strings (deep: at any depth, e.g. in its objects; else only its own elements).
 */
interface ContainsGroup { what: string; in: string; deep?: boolean; names: readonly string[] }
/** A version on which an entry's behaviour was reported to change. */
interface Degraded { from: string; issue?: number; note: string }
/** One CONTRACT entry (contract.json). */
interface ContractEntry {
  id: string;
  section?: number;
  stability: Stability | 'test';
  feature: Feature;
  since?: string;
  search?: string | readonly string[];
  shape?: string | readonly string[];
  contains?: readonly ContainsGroup[];
  degraded?: readonly Degraded[];
  note: string;
}
/** One probe() result. */
interface ProbeResult { id: string; stability: string; ok: boolean; missing: string[]; note: string }
interface ContractFile { probed: string; min: string; entries: ContractEntry[] }

const FILE = path.join(import.meta.dirname, 'contract.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as ContractFile; // the plugin's own file (npm run probe checks it)
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };

const CONTRACT: readonly ContractEntry[] = deepFreeze(data.entries);
const PROBED_VERSION: string = data.probed;
const MIN_VERSION: string = data.min;

function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const parse = (v: unknown): number[] | null => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1).map(Number) : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (const [i, p] of x.entries()) {
    const q = y[i];
    if (q !== undefined && p !== q) return p < q ? -1 : 1; // three numbers each
  }
  return 0;
}

/** The entries reported degraded on version (it is their `from` or newer). An unreadable version names none. */
function degradedOn(version: unknown, entries: readonly ContractEntry[] = CONTRACT): { id: string; issue?: number; note: string }[] {
  const out: { id: string; issue?: number; note: string }[] = [];
  for (const e of entries) {
    for (const d of e.degraded ?? []) {
      const c = compareVersions(version, d.from);
      if (c !== null && c >= 0) out.push({ id: e.id, ...(d.issue !== undefined ? { issue: d.issue } : {}), note: d.note });
    }
  }
  return out;
}

/**
 * A CONTRACT shape as a RegExp: `~` stands for one minified identifier ([\w$]+), everything else is literal.
 * Shapes pin code whose meaning is in its structure (a fallback order, a numeric default) without naming the
 * build's minified identifiers, so a rebuild that only renames them still passes.
 */
const shapeRe = (shape: unknown): RegExp => new RegExp(String(shape).split('~').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\w$]+'));

// Buffer#indexOf over the whole binary cost ~50 ms a call and a shape regex over all of it seconds: the probe test
// timed out with the suite running beside it. IDENT_MAX bounds one minified identifier (they are a few chars).
const IDENT_MAX = 64;
/** The longest array literal a contains group reads. */
const ARRAY_MAX = 16_384;
const latin1 = (s: unknown): string => Buffer.from(String(s), 'utf8').toString('latin1');
const list = (x: string | readonly string[] | undefined): readonly string[] => (x === undefined ? [] : typeof x === 'string' ? [x] : x);

/** Every place shape matches in text, as the index its match starts at (a literal shape: indexOf). */
function* shapeAt(text: string, shape: string): Generator<number> {
  const parts = String(shape).split('~');
  if (parts.length === 1) {
    for (let at = text.indexOf(shape); at >= 0; at = text.indexOf(shape, at + 1)) yield at;
    return;
  }
  let k = 0, anchor = parts[0] ?? ''; // split gives one part at least
  for (const [i, p] of parts.entries()) if (p.length > anchor.length) { k = i; anchor = p; }
  const re = new RegExp(shapeRe(shape).source, 'g');
  if (!anchor) { for (const m of text.matchAll(re)) yield m.index; return; }
  const before = parts.slice(0, k).join('').length + k * IDENT_MAX;
  const after = parts.slice(k + 1).join('').length + (parts.length - 1 - k) * IDENT_MAX;
  for (let at = text.indexOf(anchor); at >= 0; at = text.indexOf(anchor, at + 1)) {
    const from = Math.max(0, at - before);
    re.lastIndex = 0;
    const m = re.exec(text.slice(from, at + anchor.length + after));
    if (m) yield from + m.index;
  }
}
const shapeIn = (text: string, shape: string): boolean => !shapeAt(text, shape).next().done;

/**
 * The quoted strings of the array literal whose `[` is the first at or after from (within ARRAY_MAX), up to its `]`;
 * spreads and other elements are skipped, and so are nested arrays' and objects' strings unless deep. null when there
 * is no `[` or it does not close.
 */
function arrayAt(text: string, from: number, { deep = false }: { deep?: boolean | undefined } = {}): Set<string> | null {
  const open = text.indexOf('[', from);
  if (open < 0 || open - from > 256) return null;
  const names = new Set<string>();
  let depth = 0, braces = 0;
  for (let i = open; i < text.length && i - open < ARRAY_MAX; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return null;
      if (deep || (depth === 1 && braces === 0)) names.add(text.slice(i + 1, end));
      i = end;
    } else if (c === '[') depth++;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === ']' && --depth === 0) return names;
  }
  return null;
}

/** The names of group that no array at one of its places holds all of (the best place's), or [] when one does. */
function containsMissing(text: string, g: ContainsGroup): string[] {
  let best: string[] | null = null;
  for (const at of shapeAt(text, g.in)) {
    const arr = arrayAt(text, at, { deep: g.deep });
    if (!arr) continue;
    const missing = g.names.filter(n => !arr.has(n));
    if (!missing.length) return [];
    if (!best || missing.length < best.length) best = missing;
  }
  return best ? best.map(n => `${g.what}: ${n}`) : [`${g.what}: no array at ${g.in}`];
}

function probe(buf: Buffer, { entries = CONTRACT }: { entries?: readonly ContractEntry[] } = {}): ProbeResult[] {
  const text = buf.toString('latin1');
  return entries.map(e => {
    const missing = list(e.search).filter(s => text.indexOf(latin1(s)) < 0);
    for (const sh of list(e.shape)) if (!shapeIn(text, latin1(sh))) missing.push(`shape: ${sh}`);
    for (const g of e.contains ?? []) missing.push(...containsMissing(text, g).map(m => `contains: ${m}`));
    return { id: e.id, stability: e.stability, ok: missing.length === 0, missing, note: e.note };
  });
}

// ---------- the binary, for the probe and doctor ----------

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function onPath(cmd: string, env: Env): string | null {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
}
function caskroom(root = '/opt/homebrew/Caskroom') {
  let best: { p: string; mt: number } | null = null;
  let casks: string[] = [];
  try { casks = fs.readdirSync(root).filter(d => d.startsWith('claude-code')); } catch { return null; }
  for (const c of casks) {
    let vs: string[] = [];
    try { vs = fs.readdirSync(path.join(root, c)); } catch { continue; }
    for (const v of vs) {
      const p = path.join(root, c, v, 'claude');
      if (!isFile(p)) continue;
      const mt = fs.statSync(p).mtimeMs;
      if (!best || mt > best.mt) best = { p, mt };
    }
  }
  return best && best.p;
}
/** A JS shim (npm install) is followed to its real file only via realpath. */
function locateBinary({ bin, env = process.env }: { bin?: string; env?: Env } = {}): string | null {
  for (const c of [bin, env.CLAUDE_BIN, onPath('claude', env), caskroom()].filter((x): x is string => !!x)) {
    let p;
    try { p = fs.realpathSync(c); } catch { continue; }
    if (isFile(p)) return p;
  }
  return null;
}

function binaryVersion(buf: Buffer): string | null {
  const i = buf.indexOf('VERSION:"');
  if (i < 0) return null;
  const v = /^(\d+\.\d+\.\d+[^"]*)"/.exec(buf.toString('latin1', i + 9, i + 40));
  return v?.[1] ?? null;
}

export { FEATURES, CONTRACT, PROBED_VERSION, MIN_VERSION, compareVersions, degradedOn, shapeRe, arrayAt, probe, locateBinary, binaryVersion };
export type { ContractEntry, ContainsGroup, Degraded, Feature, ProbeResult, Stability };
