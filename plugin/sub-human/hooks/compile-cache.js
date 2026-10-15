// plugin/sub-human/hooks/compile-cache.js: node's compile cache on, before a hook's TypeScript loads. Every node
// command of the plugin preloads it (`node --import <root>/hooks/compile-cache.js <root>/hooks/X.ts`: hooks.json,
// .mcp.json, mod/core/shim.ts shimArgv): without the cache each run strips the types of every module it loads again,
// about 50 ms per hook. It must load before the hook's module graph, so it is a preload and not an import, and plain
// JavaScript, so loading it strips nothing. The cache lives in the plugin's own home (lib/cache-dir.js: <home>/cache,
// 0700; else node's default place) and is keyed by each file's content: an update never runs stale code.
// scripts/sub-human turns it on the same way.
import module from 'node:module';
import { cacheDir } from '../lib/cache-dir.js';

module.enableCompileCache?.(cacheDir());
