// plugin/sub-human/lib/cache-dir.js: where node's compile cache lives (hooks/compile-cache.js, scripts/sub-human):
// <home>/cache, 0700. Hooks hold the seat keys, and a cache in a shared os.tmpdir() is another user's to plant. Plain
// JavaScript: it loads before any TypeScript is stripped. undefined (node's default place) when the home is not an
// absolute path or the directory cannot be made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cacheDir() {
  const home = process.env.SUB_HUMAN_HOME || path.join(os.homedir(), '.sub-human');
  if (!path.isAbsolute(home)) return undefined;
  const dir = path.join(home, 'cache');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; } catch { return undefined; }
}
