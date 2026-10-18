// @ts-check
// plugin/sub-human/hooks/compile-cache.js: node's compile cache on, before a hook's TypeScript loads. Every node
// command of the plugin preloads it (`node --import <root>/hooks/compile-cache.js <root>/hooks/X.ts`: hooks.json,
// .mcp.json, mod/core/shim.ts shimArgv): without the cache each run strips the types of every module it loads again,
// about 50 ms per hook. It must load before the hook's module graph, so it is a preload and not an import, and plain
// JavaScript, so loading it strips nothing. The cache lives in the plugin's own home (lib/cache-dir.js: <home>/cache,
// 0700; else node's default place) and is keyed by each file's content: an update never runs stale code.
// scripts/sub-human turns it on the same way.
import fs from 'node:fs';
import module from 'node:module';
import { cacheDir } from '../lib/cache-dir.js';

module.enableCompileCache?.(cacheDir());
// node makes its per-version folder in the cache (v24.15.0-arm64-…) with the umask's mode, 0755: the home keeps
// nothing group or world readable, so it is closed the first time (one stat on every later run)
try {
  const dir = module.getCompileCacheDir?.();
  if (dir && fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
} catch { /* the cache is a speed-up only */ }
