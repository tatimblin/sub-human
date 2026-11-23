#!/usr/bin/env node
/**
 * risk-detach: U6's risk 2, with real sessions (docs/internals/v2-risks.md). Can a node child the module starts with
 * `$.process.spawn` outlive the session? A temp plugin's module, at session.start, starts three children:
 *
 *   detached  a starter that spawns `node heart.mjs` with detached:true + unref (a new session, setsid) and exits
 *   orphan    a starter that spawns the same heart without detached and exits (the heart keeps the session's group)
 *   direct    the heart itself as the spawned child (the loop's own child, which the module's unload kills)
 *
 * Each heart writes its pid and rewrites a heartbeat file every 250 ms, and exits by itself after 60 s. The script
 * runs `claude -p "say ok"` (the pinned 2.1.330, the default model), waits for it to exit, then reads each heartbeat
 * twice 5 s apart, kills every heart it started (capped at $0.10, so the turn ends normally), and removes what the
 * run left (cleanUp).
 *
 *   node scripts/risk-detach.ts            run it and print the evidence as JSON
 *
 * It uses the person's own sign-in, so it runs with the default config dir, but loads no user, project or local
 * settings (--setting-sources project, in an empty temp project: no installed plugin) and persists no session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeBin } from './lib/claude-bin.ts';

/** A throwaway plugin folder holding one hooks module, and a project folder to run claude in. */
export function tempPlugin(tag: string, moduleSource: string): { dir: string, plugin: string, project: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sub-human-risk-${tag}-`));
  const plugin = path.join(dir, 'plugin');
  const project = path.join(dir, 'project');
  for (const d of ['.claude-plugin', 'hooks', 'module']) fs.mkdirSync(path.join(plugin, d), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `risk-${tag}`, version: '0.0.0' }));
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"type":"module","private":true}\n');
  fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), '{"modules":["../module/register.ts"]}\n');
  fs.writeFileSync(path.join(plugin, 'module', 'register.ts'), moduleSource);
  return { dir, plugin, project };
}

// The parent session's own variables would make the child a peer or child of it; the run gets none of them.
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/.test(k)));

export type Run = { status: number | null, events: unknown[], stderr: string, ms: number };

/** One `claude -p` in the project with the plugin loaded: stream-json events, debug log beside. */
export function runClaude(t: { dir: string, plugin: string, project: string }, prompt: string, budgetUsd: string, extra: string[] = []): Run {
  const found = claudeBin();
  if ('error' in found) throw new Error(found.error);
  const t0 = Date.now();
  const r = spawnSync(found.bin, ['-p', prompt, '--plugin-dir', t.plugin, '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', budgetUsd,
    '--debug-file', path.join(t.dir, 'debug.log'), ...extra], { cwd: t.project, encoding: 'utf8', timeout: 180_000, env: cleanEnv() });
  fs.writeFileSync(path.join(t.dir, 'stream.jsonl'), r.stdout);
  const events: unknown[] = [];
  for (const line of r.stdout.split('\n')) { if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* a stray line */ } } }
  return { status: r.status, events, stderr: r.stderr, ms: Date.now() - t0 };
}

const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' && k in o ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined);

/** Whether a folder holds nothing but empty folders. */
const onlyEmptyDirs = (d: string): boolean =>
  fs.readdirSync(d, { withFileTypes: true }).every(e => e.isDirectory() && onlyEmptyDirs(path.join(d, e.name)));

/**
 * Removes the run's temp dir, and the projects folder it caused in the person's config dir (Claude Code names one
 * after the project's real path even with --no-session-persistence). That folder goes only while its name holds
 * `sub-human-risk` and it holds nothing but empty folders; nothing else under ~/.claude is touched.
 */
export function cleanUp(t: { dir: string, project: string }): void {
  const projects = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(t.project).replace(/[^a-zA-Z0-9]/g, '-'));
  if (path.basename(projects).includes('sub-human-risk') && fs.existsSync(projects) && onlyEmptyDirs(projects)) fs.rmSync(projects, { recursive: true });
  fs.rmSync(t.dir, { recursive: true, force: true });
}

/** The final result event's cost, subtype and text. A cold turn on the default model costs about $0.057. */
export const outcome = (events: unknown[]): { cost: unknown, subtype: unknown, result: unknown } => {
  const last = events.findLast(e => field(e, 'type') === 'result');
  return { cost: field(last, 'total_cost_usd'), subtype: field(last, 'subtype'), result: field(last, 'result') };
};

/** The debug log's lines that name the plugin, trimmed. */
export const debugLines = (dir: string, re: RegExp): string[] => {
  const f = path.join(dir, 'debug.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => re.test(l)).map(l => l.slice(0, 300)) : [];
};

const HEART = `import fs from 'node:fs'
const [, , out] = process.argv
fs.writeFileSync(out + '.pid', String(process.pid))
const beat = () => fs.writeFileSync(out + '.beat', String(Date.now()))
beat(); setInterval(beat, 250); setTimeout(() => process.exit(0), 60000)
`;
const STARTER = `import { spawn } from 'node:child_process'
const [, , heart, out, mode] = process.argv
const c = spawn(process.execPath, [heart, out], { detached: mode === 'detached', stdio: 'ignore' })
c.unref()
process.exit(0)
`;

const moduleFor = (dir: string): string => {
  const node = JSON.stringify(process.execPath);
  const at = (f: string): string => JSON.stringify(path.join(dir, f));
  return `// risk 2: three children, started at session.start; the stream loops run on after the hook returns.
export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const drain = async (argv) => { const s = $.process.spawn({ argv }); for await (const c of s) $.ui.log(c.text, { to: 'debug' }) }
    await drain([${node}, ${at('starter.mjs')}, ${at('heart.mjs')}, ${at('detached')}, 'detached'])
    await drain([${node}, ${at('starter.mjs')}, ${at('heart.mjs')}, ${at('orphan')}, 'orphan'])
    void drain([${node}, ${at('heart.mjs')}, ${at('direct')}])
    return started
  })
}
`;
};

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const readNum = (f: string): number | null => (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : null);

function main(): number {
  const t = tempPlugin('detach', '');
  fs.writeFileSync(path.join(t.dir, 'heart.mjs'), HEART);
  fs.writeFileSync(path.join(t.dir, 'starter.mjs'), STARTER);
  fs.writeFileSync(path.join(t.plugin, 'module', 'register.ts'), moduleFor(t.dir));
  const run = runClaude(t, 'say ok', '0.10');
  const exitedAt = Date.now();
  const kinds = ['detached', 'orphan', 'direct'];
  const pids = Object.fromEntries(kinds.map(k => [k, readNum(path.join(t.dir, `${k}.pid`))]));
  sleep(1000);
  const first = Object.fromEntries(kinds.map(k => [k, readNum(path.join(t.dir, `${k}.beat`))]));
  sleep(5000);
  const second = Object.fromEntries(kinds.map(k => [k, readNum(path.join(t.dir, `${k}.beat`))]));
  const verdict = Object.fromEntries(kinds.map(k => {
    const pid = pids[k];
    const a = first[k]; const b = second[k];
    const isAlive = typeof pid === 'number' && alive(pid);
    return [k, { pid, aliveAfter6s: isAlive, beatAdvanced: a != null && b != null && b > a, lastBeatMsAfterExit: b == null ? null : b - exitedAt, verdict: isAlive && a != null && b != null && b > a ? 'DETACHES' : 'KILLED' }];
  }));
  // A pid is signalled only while its heart still beats, so a pid the system has reused is never killed.
  const fresh = (k: string): boolean => { const b = readNum(path.join(t.dir, `${k}.beat`)); return b != null && Date.now() - b < 2000; };
  const live = (k: string): boolean => { const pid = pids[k]; return typeof pid === 'number' && alive(pid) && fresh(k); };
  for (const k of kinds) { const pid = pids[k]; if (typeof pid === 'number' && live(k)) process.kill(pid, 'SIGTERM'); }
  sleep(300);
  const leftovers = kinds.filter(live);
  const debug = debugLines(t.dir, /risk-detach|process\.spawn|skipped/i).slice(0, 20);
  if (leftovers.length === 0) cleanUp(t);
  process.stdout.write(`${JSON.stringify({ dir: t.dir, claudeExit: run.status, claudeMs: run.ms, ...outcome(run.events), verdict, leftovers, debug }, null, 2)}\n`);
  return leftovers.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
