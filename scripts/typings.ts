#!/usr/bin/env node
/**
 * typings: npm run typings. Copies the declarations Claude Code wrote beside the hooks module,
 * plugin/sub-human/.claude-plugin/types/{claude-code,claude-code-tools,claude-code-mcp}/index.d.ts (gitignored), into
 * the committed snapshot, typings/<same>/index.d.ts, which npm run typecheck reads.
 *
 * Claude Code writes that folder when an interactive session loads the plugin from its folder
 * (`claude --plugin-dir plugin/sub-human`: the plugin-dir watch lays the type root; `claude -p`, `claude plugin
 * validate` and `claude plugin test` do not), and again after an update. claude-code/index.d.ts's first line names
 * the version that wrote it; npm run probe fails while that is not lib/cc/contract.json `probed`. claude-code-tools
 * holds the built-in tools that session had, claude-code-mcp the MCP tools it had connected.
 *
 *   node scripts/typings.ts     copy, and say which version wrote them (exit 1 when the folder is missing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, REPO } from './lib/paths.ts';

/** The Claude Code version on a declarations file's first line ("// Written by Claude Code X."), or null. */
export function writtenBy(text: string): string | null {
  return /^\/\/ Written by Claude Code (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)\.?\s*$/m.exec(text.split('\n', 1)[0] ?? '')?.[1] ?? null;
}

export const SOURCE = path.join(PLUGIN, '.claude-plugin', 'types');
export const TARGET = path.join(REPO, 'typings');
export const ROOTS = ['claude-code', 'claude-code-tools', 'claude-code-mcp'] as const;

/** Copy each type root's index.d.ts from `from` to `to`; returns the version that wrote claude-code, or an error. */
export function copyTypings(from = SOURCE, to = TARGET): { version: string | null, copied: string[] } | { error: string } {
  const missing = ROOTS.filter(r => !fs.existsSync(path.join(from, r, 'index.d.ts')));
  if (missing.length) {
    return { error: `${path.relative(REPO, from) || from}: no ${missing.join(', ')}; start \`claude --plugin-dir plugin/sub-human\` (interactive) once, which writes them` };
  }
  const copied: string[] = [];
  for (const r of ROOTS) {
    fs.mkdirSync(path.join(to, r), { recursive: true });
    fs.copyFileSync(path.join(from, r, 'index.d.ts'), path.join(to, r, 'index.d.ts'));
    copied.push(`${r}/index.d.ts`);
  }
  return { version: writtenBy(fs.readFileSync(path.join(to, 'claude-code', 'index.d.ts'), 'utf8')), copied };
}

function main(): number {
  const r = copyTypings();
  if ('error' in r) { process.stderr.write(`typings: ${r.error}\n`); return 1; }
  process.stdout.write(`typings: copied ${r.copied.join(', ')} (written by Claude Code ${r.version ?? '(unknown)'})\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
