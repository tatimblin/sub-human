#!/usr/bin/env node
/**
 * typings: npm run typings. Refreshes the committed snapshot typings/{claude-code,claude-code-tools,claude-code-mcp}/
 * index.d.ts, which npm run typecheck reads, from the pinned Claude Code binary (scripts/lib/claude-bin.ts).
 *
 * An interactive session writes these beside a hooks module (.claude-plugin/types/); `claude plugin test` and
 * `claude plugin validate` do not, so they are taken from the binary instead, with no session:
 *   claude-code        the bundled declarations (a zstd file in the binary) behind the header a session writes
 *                      ("// Written by Claude Code X."): byte for byte what a session writes (checked on 2.1.296)
 *   claude-code-tools  the build's own built-in tool inputs, bundled for `claude plugin validate`. A session writes the
 *                      tools it has, so its file can differ by a tool or two
 *   claude-code-mcp    the file a session with no MCP server writes (the plugin has none)
 * claude-code's first line names the version; npm run probe fails while that is not core/cc/contract.json `probed`.
 *
 *   node scripts/typings.ts     extract and copy, and say which version wrote them
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { REPO } from './lib/paths.ts';
import { claudeBin, claudeEnv } from './lib/claude-bin.ts';

/** The Claude Code version on a declarations file's first line ("// Written by Claude Code X."), or null. */
export function writtenBy(text: string): string | null {
  return /^\/\/ Written by Claude Code (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)\.?\s*$/m.exec(text.split('\n', 1)[0] ?? '')?.[1] ?? null;
}

export const TARGET: string = path.join(REPO, 'typings');
export const ROOTS = ['claude-code', 'claude-code-tools', 'claude-code-mcp'] as const;

/** Copy each type root's index.d.ts from `from` to `to`; returns the version that wrote claude-code, or an error. */
export function copyTypings(from: string, to = TARGET): { version: string | null, copied: string[] } | { error: string } {
  const missing = ROOTS.filter(r => !fs.existsSync(path.join(from, r, 'index.d.ts')));
  if (missing.length) return { error: `${from}: no ${missing.join(', ')}` };
  const copied: string[] = [];
  for (const r of ROOTS) {
    fs.mkdirSync(path.join(to, r), { recursive: true });
    fs.copyFileSync(path.join(from, r, 'index.d.ts'), path.join(to, r, 'index.d.ts'));
    copied.push(`${r}/index.d.ts`);
  }
  return { version: writtenBy(fs.readFileSync(path.join(to, 'claude-code', 'index.d.ts'), 'utf8')), copied };
}

const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HOOKS_HEAD = '// Claude Code function hooks';
const TOOLS_HEAD = '// The inputs of the built-in tools this build has';
const MCP_EMPTY = [
  '// The inputs of the MCP tools the session had connected when this mod',
  "// was last saved, from each server's tools/list inputSchema.",
  "// Merges into the engine's ToolCallInput (types/ McpToolInputs) so",
  '// `e.tool === "mcp__<server>__<tool>"` narrows to the tool\'s arguments.',
  '// Written again at a save of the mod with a server connected.',
  'export {}',
  "declare module 'claude-code' {",
  '  interface McpToolInputs {',
  '  }',
  '}',
  '',
].join('\n');

/** The first zstd frame in bin whose text starts with head, decompressed. A frame is cut at the next magic. */
export function bundled(bin: Buffer, head: string): string | null {
  for (let i = bin.indexOf(ZSTD); i >= 0; i = bin.indexOf(ZSTD, i + 1)) {
    const next = bin.indexOf(ZSTD, i + 4);
    let out: Buffer;
    try { out = zlib.zstdDecompressSync(bin.subarray(i, next < 0 ? bin.length : next)); } catch { continue; }
    if (out.toString('utf8', 0, head.length) === head) return out.toString('utf8');
  }
  return null;
}

/** Write the three type roots of a binary (its bytes, its version) under dir; null, or what is missing. */
export function extractTypings(bin: Buffer, version: string, dir: string): string | null {
  const hooks = bundled(bin, HOOKS_HEAD), tools = bundled(bin, TOOLS_HEAD);
  if (!hooks || !tools) return `no bundled ${hooks ? 'tool inputs' : 'declarations'} in the binary`;
  // the MCP file is not bundled; its header is, and it changing means the empty file may have too
  if (!MCP_EMPTY.split('\n').slice(0, 5).every(l => bin.includes(l))) return "the MCP tools file's header changed: check claude-code-mcp by hand";
  const files: Record<(typeof ROOTS)[number], string> = {
    'claude-code': `// Written by Claude Code ${version}.\n${hooks}\n`,
    'claude-code-tools': tools,
    'claude-code-mcp': MCP_EMPTY,
  };
  for (const r of ROOTS) { fs.mkdirSync(path.join(dir, r), { recursive: true }); fs.writeFileSync(path.join(dir, r, 'index.d.ts'), files[r]); }
  return null;
}

function main(): number {
  const found = claudeBin();
  if ('error' in found) { process.stderr.write(`typings: ${found.error}\n`); return 1; }
  const version = /\d+\.\d+\.\d+/.exec(spawnSync(found.bin, ['--version'], { encoding: 'utf8', timeout: 30_000, env: claudeEnv(found.prefix) }).stdout || '')?.[0];
  if (!version) { process.stderr.write(`typings: ${found.bin} --version said no version\n`); return 1; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-typings-'));
  try {
    const why = extractTypings(fs.readFileSync(found.bin), version, tmp);
    if (why) { process.stderr.write(`typings: ${found.bin}: ${why}\n`); return 1; }
    const r = copyTypings(tmp);
    if ('error' in r) { process.stderr.write(`typings: ${r.error}\n`); return 1; }
    process.stdout.write(`typings: copied ${r.copied.join(', ')} (written by Claude Code ${r.version ?? '(unknown)'})\n`);
    return 0;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.main) process.exitCode = main();
