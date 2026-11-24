/**
 * Preloaded into every node test process (npm run test:node, `--import`). It gives the process a temp HOME,
 * CLAUDE_CONFIG_DIR and SUB_HUMAN_HOME under one temp root (children inherit them; the root goes at exit, unless
 * SUB_HUMAN_KEEP_TMP=1), drops the CLAUDE* variables a run started inside Claude Code inherits, and guards the real
 * ones: a write through node:fs under the real ~/.sub-human (or SUB_HUMAN_HOME), the inherited Claude Code config dir
 * or ~/.claude.json throws, prints REAL CONFIG TOUCHED and fails the test file. Child processes write past that hook,
 * so at exit a directory made in a real home during the run, named as one the run made in its temp homes, fails it too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const realHome = process.env.HOME ?? os.homedir();
/** The real places no test may write, read before the env below replaces them. */
export const GUARDED: readonly string[] = [...new Set([
  path.join(realHome, '.sub-human'),
  process.env.SUB_HUMAN_HOME,
  process.env.CLAUDE_CONFIG_DIR ?? path.join(realHome, '.claude'),
  path.join(realHome, '.claude.json'),
].filter((d): d is string => !!d).map(d => path.resolve(d)))];

/** Whether a path a test writes lies in a guarded place. */
export function touches(p: string, guarded: readonly string[] = GUARDED): boolean {
  const a = path.resolve(p);
  return guarded.some(g => a === g || a.startsWith(g + path.sep));
}

for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];
export const ROOT: string = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-test-'));
for (const [k, d] of [['HOME', 'home'], ['CLAUDE_CONFIG_DIR', 'config'], ['SUB_HUMAN_HOME', 'sub-human']] as const) {
  process.env[k] = path.join(ROOT, d);
  fs.mkdirSync(path.join(ROOT, d));
}
const began = Date.now() - process.uptime() * 1000 - 20;

/** The directory names under dir, to depth levels down. */
export function dirNames(dir: string, depth = 3, out = new Set<string>()): Set<string> {
  if (depth > 0) for (const e of ls(dir)) if (e.isDirectory()) { out.add(e.name); dirNames(path.join(dir, e.name), depth - 1, out); }
  return out;
}
function ls(dir: string): fs.Dirent[] { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }

/**
 * The directories under dir (to depth) born since `since` and named as one of names: what a child process, which
 * this one's node:fs never sees, made in a real home. As the 0.8 guard did with room codes, only names this run made
 * in its temp homes count, so a live Claude Code beside the run, rewriting its own files there, trips nothing.
 */
export function bornLike(dir: string, names: ReadonlySet<string>, since: number, depth = 3): string[] {
  const out: string[] = [];
  if (depth > 0) for (const e of ls(dir)) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    let born = 0;
    try { born = fs.statSync(p).birthtimeMs; } catch { continue; }
    if (names.has(e.name) && born >= since) out.push(p); else out.push(...bornLike(p, names, since, depth - 1));
  }
  return out;
}

process.on('exit', () => {
  const names = dirNames(ROOT, 4);
  for (const d of ['home', 'config', 'sub-human']) names.delete(d);
  for (const p of GUARDED.flatMap(g => bornLike(g, names, began))) {
    process.stderr.write(`REAL CONFIG TOUCHED: ${p} was made during the run, as one in its temp homes was\n`);
    process.exitCode = 1;
  }
  if (process.env.SUB_HUMAN_KEEP_TMP !== '1') fs.rmSync(ROOT, { recursive: true, force: true });
});

const asPath = (v: unknown): string | null =>
  typeof v === 'string' ? v : v instanceof URL ? fileURLToPath(v) : Buffer.isBuffer(v) ? v.toString() : null;
const READ_FLAGS = new Set([undefined, 'r', 'rs', 'sr', fs.constants.O_RDONLY]);

function check(name: string, args: unknown[], at: readonly number[]): void {
  if ((name === 'open' || name === 'openSync') && READ_FLAGS.has(typeof args[1] === 'string' || typeof args[1] === 'number' ? args[1] : undefined)) return;
  for (const i of at) {
    const p = asPath(args[i]);
    if (p === null || !touches(p)) continue;
    process.exitCode = 1;
    process.stderr.write(`REAL CONFIG TOUCHED: a test wrote ${path.resolve(p)} (${name})\n`);
    throw new Error(`REAL CONFIG TOUCHED: ${p}`);
  }
}

// each writing call and the positions of the paths it writes; sync, callback and promise forms alike
const WRITES: Record<string, readonly number[]> = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], open: [0], rm: [0], rmdir: [0], unlink: [0], truncate: [0],
  rename: [0, 1], copyFile: [1], cp: [1], symlink: [1], link: [1], chmod: [0], utimes: [0],
};
type Fn = (...a: unknown[]) => unknown;
function wrap(target: object, name: string, at: readonly number[]): void {
  const orig: unknown = Reflect.get(target, name);
  if (typeof orig !== 'function') return;
  const fn: Fn = (...a) => { check(name, a, at); return Reflect.apply(orig, target, a); };
  Reflect.set(target, name, fn);
}
for (const [name, at] of Object.entries(WRITES)) { wrap(fs, name, at); wrap(fs, `${name}Sync`, at); wrap(fs.promises, name, at); }
wrap(fs, 'createWriteStream', [0]);
syncBuiltinESMExports(); // `import { writeFileSync } from 'node:fs'` gets the guarded one too
