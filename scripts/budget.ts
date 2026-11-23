#!/usr/bin/env node
/**
 * budget: the plugin's size budget (docs/ARCHITECTURE.md §11, PRD Q-3). Counts the non-blank, non-comment lines of
 * the runtime per area and of the plugin's tests, prints a table, and exits 1 when an area, the total or the tests
 * are over. Tests may not outgrow the runtime, checked once the runtime reaches 1,000 lines.
 *
 *   node scripts/budget.ts [PLUGIN_DIR]
 *
 * Runtime is every .ts/.js/.mjs/.sh under the plugin outside vendor/, test/, .claude-plugin/ and node_modules/,
 * that is not a test (*.test.ts, *.node-test.ts). A file outside the five areas counts as `top` (keys, home, config,
 * the CLI, doctor). Tests are the test files and test/, without test/fixtures/. Three parts have lines of their own
 * inside their area: module/tools, net/channel and net/pathways (a .ts file of that name or a folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { blank } from './ts-ratchet.ts';
import { PLUGIN } from './lib/paths.ts';

export const AREAS = { core: 2500, store: 800, module: 1900, commands: 700, net: 2100, top: 1000 } as const;
export type Area = keyof typeof AREAS;
const NAMES: readonly Area[] = ['core', 'store', 'module', 'commands', 'net', 'top'];
const isArea = (s: string): s is Area => Object.hasOwn(AREAS, s);
export const PARTS = { 'module/tools': 400, 'net/channel': 300, 'net/pathways': 600 } as const;
export type Part = keyof typeof PARTS;
const PART_NAMES: readonly Part[] = ['module/tools', 'net/channel', 'net/pathways'];
/** The part a runtime path is in, or null. */
export const partOf = (rel: string): Part | null => PART_NAMES.find(p => rel === `${p}.ts` || rel.startsWith(`${p}/`)) ?? null;
export const TOTAL = 9000;

const SKIP = new Set(['vendor', '.claude-plugin', 'node_modules']);
const CODE = /\.(?:[cm]?[jt]sx?|sh)$/;
const TEST = /\.(?:node-)?test\.tsx?$/;

/** The lines of a source that hold code (comments and blank lines left out). */
export function codeLines(src: string, file: string): number {
  const lines = file.endsWith('.sh') ? src.split('\n').filter(l => !/^\s*#/.test(l)) : blank(src).split('\n');
  return lines.filter(l => l.trim() !== '').length;
}

/** What a plugin-relative path counts as: an area, 'test', or null (not counted). */
export function kindOf(rel: string): Area | 'test' | null {
  const parts = rel.split('/');
  if (!CODE.test(rel) || rel.endsWith('.d.ts') || parts.some(p => SKIP.has(p))) return null;
  if (parts[0] === 'test') return parts[1] === 'fixtures' ? null : 'test';
  if (TEST.test(rel)) return 'test';
  const top = parts[0] ?? '';
  return parts.length > 1 && isArea(top) ? top : 'top';
}

/** The lines counted under a plugin root. */
export interface Counts { areas: Record<Area, number>, parts: Record<Part, number>, tests: number }

/** The lines per area, per part and of the tests, under a plugin root. */
export function count(root: string): Counts {
  const areas: Record<Area, number> = { core: 0, store: 0, module: 0, commands: 0, net: 0, top: 0 };
  const parts: Record<Part, number> = { 'module/tools': 0, 'net/channel': 0, 'net/pathways': 0 };
  let tests = 0;
  for (const rel of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const r = rel.split(path.sep).join('/');
    const kind = kindOf(r);
    if (!kind || !fs.statSync(path.join(root, rel)).isFile()) continue;
    const n = codeLines(fs.readFileSync(path.join(root, rel), 'utf8'), r);
    if (kind === 'test') { tests += n; continue; }
    areas[kind] += n;
    const part = partOf(r);
    if (part) parts[part] += n;
  }
  return { areas, parts, tests };
}

/** The table's rows and what is over budget. */
// The tests are held to the runtime's size only with --final (the cutover): while the runtime is being built, a unit
// must never drop a test to fit, so the line is shown and warned about instead.
export function judge(c: Counts, final = false): { rows: [string, number, number | null][], over: string[], warn: string[] } {
  const rows: [string, number, number | null][] = [...NAMES.map((a): [string, number, number] => [a, c.areas[a], AREAS[a]]),
    ...PART_NAMES.map((p): [string, number, number] => [p, c.parts[p], PARTS[p]])];
  const total = Object.values(c.areas).reduce((s, n) => s + n, 0);
  rows.push(['total', total, TOTAL], ['tests', c.tests, final ? total : null]);
  const warn = !final && c.tests > total ? [`tests ${c.tests} > runtime ${total} (checked at the cutover)`] : [];
  return { rows, over: rows.filter(([, n, max]) => max !== null && n > max).map(([a, n, max]) => `${a} ${n} > ${max}`), warn };
}

function main(argv: readonly string[]): number {
  const final = argv.includes('--final');
  const { rows, over, warn } = judge(count(path.resolve(argv.find(a => !a.startsWith('--')) ?? PLUGIN)), final);
  for (const [a, n, max] of rows) process.stdout.write(`${a.padEnd(13)}${String(n).padStart(6)} / ${max ?? '-'}${max !== null && n > max ? '  OVER' : ''}\n`);
  for (const w of warn) process.stdout.write(`budget: warning: ${w}\n`);
  if (over.length) process.stderr.write(`budget: over: ${over.join(', ')}\n`);
  return over.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
