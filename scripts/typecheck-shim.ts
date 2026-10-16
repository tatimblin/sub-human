/**
 * typecheck-shim: npm run typecheck's check of plugin/sub-human/scripts/sub-human, the CLI shim. Its path is frozen and
 * extensionless, and tsc takes no extensionless file (tsgo panics: no ScriptKind), so this copies it to a temporary
 * sub-human.js, with its relative imports made absolute, beside a tsconfig that extends the root one with allowJs and
 * checkJs, and runs tsc there. Exit code: tsc's.
 *
 *   node scripts/typecheck-shim.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, PLUGIN } from './lib/paths.ts';

const SHIM = path.join(PLUGIN, 'scripts', 'sub-human');

/** The shim's source with each `'../X'` specifier made absolute (from scripts/), so the copy resolves the same files. */
export function absolutize(src: string): string {
  return src.replace(/(['"])\.\.\/([^'"]+)\1/g, (_m: string, q: string, rel: string) => `${q}${path.join(PLUGIN, rel)}${q}`);
}

function main(): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-shim-'));
  try {
    fs.writeFileSync(path.join(dir, 'sub-human.js'), absolutize(fs.readFileSync(SHIM, 'utf8')));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(REPO, 'tsconfig.json'),
      compilerOptions: { allowJs: true, checkJs: true, typeRoots: [path.join(REPO, 'node_modules', '@types')] },
      include: [],
      // the root config's own declarations (the plugin's $.state types, the built-in and MCP tool inputs)
      files: ['sub-human.js', path.join(PLUGIN, 'types', 'index.d.ts'), path.join(REPO, 'typings', 'claude-code-tools', 'index.d.ts'), path.join(REPO, 'typings', 'claude-code-mcp', 'index.d.ts')],
    }));
    const tsc = path.join(REPO, 'node_modules', '.bin', 'tsc');
    const r = spawnSync(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/^[^\n(]*sub-human\.js\(/gm, `${path.relative(REPO, SHIM)}(`);
    if (out.trim()) process.stdout.write(out);
    return r.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
