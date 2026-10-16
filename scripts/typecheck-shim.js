'use strict';
/**
 * typecheck-shim: npm run typecheck's check of plugin/sub-human/scripts/sub-human, the CLI shim. Its path is frozen and
 * extensionless, and tsc takes no extensionless file (tsgo panics: no ScriptKind), so this copies it to a temporary
 * sub-human.js, with its relative imports made absolute, beside a tsconfig that extends the root one with allowJs and
 * checkJs, and runs tsc there. Exit code: tsc's.
 *
 *   node scripts/typecheck-shim.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, PLUGIN } = require('./lib/paths.js');

const SHIM = path.join(PLUGIN, 'scripts', 'sub-human');

/** The shim's source with each `'../X'` specifier made absolute (from scripts/), so the copy resolves the same files. */
function absolutize(src) {
  return src.replace(/(['"])\.\.\/([^'"]+)\1/g, (_m, q, rel) => `${q}${path.join(PLUGIN, rel)}${q}`);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-shim-'));
  try {
    fs.writeFileSync(path.join(dir, 'sub-human.js'), absolutize(fs.readFileSync(SHIM, 'utf8')));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(REPO, 'tsconfig.json'),
      compilerOptions: { allowJs: true, checkJs: true, typeRoots: [path.join(REPO, 'node_modules', '@types')] },
      include: [],
      // the root config's own declarations (the plugin's $.state types, the built-in tool inputs)
      files: ['sub-human.js', path.join(PLUGIN, 'types', 'index.d.ts'), path.join(REPO, 'typings', 'claude-code-tools', 'index.d.ts')],
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

if (require.main === module) process.exit(main());
module.exports = { absolutize };
