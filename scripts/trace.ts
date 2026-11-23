#!/usr/bin/env node
/**
 * trace: the requirements trace (docs/TESTING.md §12). Reads every P0 and P1 requirement from docs/PRD.md, finds the
 * tests whose names carry its tag (`R12`, `R15a`, in the name itself), and writes one table between the markers in
 * TESTING.md: requirement → test files and names. A requirement no test names is listed as uncovered, never guessed.
 *
 *   node scripts/trace.ts           rewrite the table
 *   node scripts/trace.ts --check   exit 1 when the table in TESTING.md is not what the tests say
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN } from './lib/paths.ts';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PRD = path.join(ROOT, 'docs', 'PRD.md');
const TESTING = path.join(ROOT, 'docs', 'TESTING.md');
const BEGIN = '<!-- trace:begin (node scripts/trace.ts writes this table) -->';
const END = '<!-- trace:end -->';
const TAG = /\bR\d+[a-e]?\b/g;

export interface Requirement { readonly id: string; readonly priority: 'P0' | 'P1'; readonly title: string }
export interface Named { readonly file: string; readonly name: string }

/** The P0 and P1 requirements, in the PRD's order: `- **R12 (P0)** **Activity:** …`. */
export function requirements(prd: string): Requirement[] {
  const out: Requirement[] = [];
  for (const m of prd.matchAll(/^\s*- \*\*(R\d+[a-e]?) \((P[0-2])\)\*\*\s*(.*)$/gm)) {
    const [, id = '', p = '', rest = ''] = m;
    if (p !== 'P0' && p !== 'P1') continue;
    const title = rest.replace(/\*\*/g, '').replace(/`/g, '').split(/(?<=\w\w[.:])\s/)[0]?.slice(0, 70) ?? '';
    out.push({ id, priority: p, title: title.replace(/[.:]$/, '') });
  }
  return out;
}

/** The names of the tests in a source: the first argument of `test(` or `it(`, a template's `${…}` kept as written. */
export function testNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[^\w.])(?:test|it)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    out.push(raw.replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** Every test file under the plugin and scripts/test, with its tests' names. */
function allTests(): Named[] {
  const out: Named[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['vendor', 'node_modules', 'fixtures', '.claude-plugin'].includes(e.name)) walk(f); continue; }
      if (!/\.(?:node-)?test\.tsx?$/.test(e.name)) continue;
      for (const name of testNames(fs.readFileSync(f, 'utf8'))) out.push({ file: path.relative(ROOT, f), name });
    }
  };
  walk(PLUGIN);
  walk(path.join(ROOT, 'scripts', 'test'));
  return out;
}

/** The requirement tags in a test's name. */
const tags = (name: string): string[] => name.match(TAG) ?? [];

/** The table: one row per requirement, its tests by file, or `uncovered`. */
export function table(reqs: readonly Requirement[], tests: readonly Named[]): string {
  const rows = reqs.map(r => {
    const hits = tests.filter(t => tags(t.name).includes(r.id));
    const byFile = new Map<string, string[]>();
    for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.name]);
    const cell = hits.length
      ? [...byFile].map(([f, names]) => `\`${f.replace(/^plugin\/sub-human\//, '')}\`: ${names.map(n => `“${n.replace(/\|/g, '\\|')}”`).join('; ')}`).join('<br>')
      : '**uncovered**';
    return `| ${r.id} | ${r.priority} | ${r.title.replace(/\|/g, '\\|')} | ${cell} |`;
  });
  const uncovered = reqs.filter(r => !tests.some(t => tags(t.name).includes(r.id))).map(r => r.id);
  return [
    BEGIN,
    '| R | Priority | Requirement | Tests (file: names) |',
    '|---|---|---|---|',
    ...rows,
    '',
    uncovered.length ? `Uncovered: ${uncovered.join(', ')}.` : 'Every P0 and P1 requirement is named by a test.',
    END,
  ].join('\n');
}

function main(argv: readonly string[]): number {
  const doc = fs.readFileSync(TESTING, 'utf8');
  const at = doc.indexOf(BEGIN), to = doc.indexOf(END);
  if (at < 0 || to < at) { process.stderr.write(`trace: ${path.relative(ROOT, TESTING)} has no trace markers\n`); return 1; }
  const next = `${doc.slice(0, at)}${table(requirements(fs.readFileSync(PRD, 'utf8')), allTests())}${doc.slice(to + END.length)}`;
  if (argv.includes('--check')) {
    if (next === doc) return 0;
    process.stderr.write('trace: docs/TESTING.md\'s table is stale; run node scripts/trace.ts\n');
    return 1;
  }
  fs.writeFileSync(TESTING, next);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
