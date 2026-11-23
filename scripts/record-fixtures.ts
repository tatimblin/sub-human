#!/usr/bin/env node
/**
 * record-fixtures: real Claude Code payloads for the tests (docs/TESTING.md §8), recorded once per Claude Code version
 * into plugin/sub-human/test/fixtures/cc/<version>/ (one <name>.json each, plus index.json).
 *
 * It runs the pinned binary (scripts/lib/claude-bin.ts) with `claude -p` over stream-json, the default model, in a temp
 * git project (with a bare local remote to push to), with a throwaway logging plugin (scripts/record-fixtures/plugin: a
 * hooks module that logs tool.call, session.send, prompt.submit and turn.complete with their results, and a command
 * hook that logs its stdin) loaded by --plugin-dir. Permission requests come to this script (--permission-prompt-tool
 * stdio), which answers as the person would for ExitPlanMode and AskUserQuestion only (answer below): -p alone offers
 * neither tool.
 *
 * A fresh CLAUDE_CONFIG_DIR has no sign-in (the keychain entry is keyed to the config dir), so it runs on the person's
 * own config, read only for sign-in: --setting-sources project (the temp project has no settings, so no installed
 * plugin or user hook loads), --strict-mcp-config, --no-session-persistence, no auto-memory, plans in the temp project
 * through --settings, and its own task list id. No settings file is written. What a session still leaves in that
 * config (leftovers below) is removed after it. Every payload is scrubbed (scrubber below) before it is written.
 *
 *   node scripts/record-fixtures.ts [--only steps,plan,extra] [--out DIR] [--budget USD]   about $0.30; prints the cost
 *
 * --only re-records those sessions and keeps the others' fixtures. index.json keeps every run's cost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import * as v from 'valibot';
import { PLUGIN } from './lib/paths.ts';
import { claudeBin, probedVersion } from './lib/claude-bin.ts';

const TEMPLATE = path.join(import.meta.dirname, 'record-fixtures', 'plugin');
export const FIXTURES: string = path.join(PLUGIN, 'test', 'fixtures', 'cc');

// ---- scrubbing ----

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOOL_USE = /\btoolu_[A-Za-z0-9_]+/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const TOKEN = /\b(?:sk-ant-[A-Za-z0-9_-]+|(?:ghp|gho|github_pat)_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]+)/g;
const KEEP_EMAIL = 'user@example.com';
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path as Claude Code names its folder under the config's projects/: every character but a letter or digit a dash. */
export const encodePath = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

/**
 * A scrubber over JSON text: each path in `paths` (and its encodePath form) becomes its stand-in, longest first; the
 * user name becomes `user`; UUIDs and tool_use ids become stable fakes, numbered in order of first sight across every
 * call from after+1 (so a re-recorded session's fakes never meet kept ones); emails and tokens become placeholders.
 */
export function scrubber(paths: ReadonlyArray<readonly [string, string]>, user: string, after = 0): (text: string) => string {
  const ids = new Map<string, string>();
  const fake = (id: string, make: (n: number) => string): string => {
    const known = ids.get(id);
    if (known) return known;
    const made = make(after + ids.size + 1);
    ids.set(id, made);
    return made;
  };
  const pairs = paths.flatMap(([from, to]): Array<[string, string]> => [[from, to], [encodePath(from), encodePath(to)]])
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  return text => {
    let out = text;
    for (const [from, to] of pairs) out = out.replaceAll(from, to);
    if (user.length > 2) out = out.replace(new RegExp(`\\b${escape(user)}\\b`, 'g'), 'user');
    return out
      .replace(UUID, id => fake(id.toLowerCase(), n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`))
      .replace(TOOL_USE, id => fake(id, n => `toolu_fake${String(n).padStart(4, '0')}`))
      .replace(TOKEN, '<token>')
      .replace(EMAIL, KEEP_EMAIL);
  };
}

/** The highest fake number in scrubbed text, 0 for none: where the next recording's fakes start. */
export function lastFake(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/00000000-0000-4000-8000-(\d{12})|toolu_fake(\d{4})/g)) n = Math.max(n, Number(m[1] ?? m[2]));
  return n;
}

// ---- naming ----

const Logged = v.looseObject({ event: v.string(), input: v.optional(v.unknown()), result: v.optional(v.unknown()) });
const Obj = v.looseObject({});
const field = (o: unknown, k: string): unknown => (v.is(Obj, o) ? o[k] : undefined);
const kebab = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

/** A fixture's base name from one logged module event (`tool-bash-git-push`, `session-send-plugin`, ...). */
export function nameFor(event: string, input: unknown, result: unknown): string {
  if (event !== 'tool.call') {
    const origin = field(field(input, 'origin'), 'kind');
    return event === 'session.send' && typeof origin === 'string' ? `session-send-${origin}` : kebab(event);
  }
  const tool = String(field(input, 'tool'));
  const record = field(result, 'result');
  if (tool === 'Bash') {
    const op = field(record, 'gitOperation');
    if (op !== undefined) return `tool-bash-git-${field(op, 'commit') !== undefined ? 'commit' : field(op, 'push') !== undefined ? 'push' : 'other'}`;
    if (field(result, 'isError') === true) return 'tool-bash-error';
    return /\btest\b/.test(String(field(input, 'command'))) ? 'tool-bash-test' : 'tool-bash';
  }
  if (tool === 'TaskUpdate' && typeof field(input, 'status') === 'string') return `tool-task-update-${kebab(String(field(input, 'status')))}`;
  const by = String(field(input, 'tool_use_id')).startsWith('toolu_plugin_') ? '-plugin' : '';
  return `tool-${kebab(tool)}${by}${field(result, 'isError') === true ? '-error' : field(result, 'deny') !== undefined ? '-deny' : ''}`;
}

export type Fixture = { name: string, event: string, session: string, hook?: string, input?: unknown, result?: unknown };

/** The fixtures in one session's log dir, named by nameFor (or hook-<event>), each name made unique with -2, -3. */
export function fixturesFrom(logDir: string, session: string, taken: Set<string>): Fixture[] {
  const out: Fixture[] = [];
  const unique = (base: string): string => {
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    return name;
  };
  for (const f of fs.readdirSync(logDir).sort()) {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8'));
    const hook = /^hook-([A-Za-z]+)-/.exec(f)?.[1];
    if (hook) { out.push({ name: unique(`hook-${kebab(hook)}-${session}`), event: 'hook', session, hook, input: raw }); continue; }
    const e = v.parse(Logged, raw);
    const base = nameFor(e.event, e.input, e.result);
    out.push({ name: unique(/^(prompt-submit|turn-complete|tool-list)$/.test(base) ? `${base}-${session}` : base), event: e.event, session, input: e.input, result: e.result });
  }
  return out;
}

// ---- the index ----

const IndexEntry = v.object({ event: v.string(), session: v.string(), tool: v.optional(v.string()), hook: v.optional(v.string()) });
const Run = v.object({ date: v.string(), sessions: v.array(v.string()), costUsd: v.number() });
export const Index = v.object({
  version: v.string(),
  costUsd: v.number(),
  runs: v.array(Run),
  gaps: v.array(v.string()),
  fixtures: v.record(v.string(), IndexEntry),
});
export type Index = v.InferOutput<typeof Index>;

/** What the fixtures cannot hold, and why; written into index.json for the tests' readers. */
export const GAPS: string[] = [
  'Notification: no notification fires under -p, so there is no hook-notification fixture.',
  'A delivered session.send: both sends here go to `nobody` and are refused (isDelivered false); delivery to another session needs two live sessions (U6).',
];

/**
 * The index after a run: the old entries of sessions not re-recorded, then the new ones; the run appended to the old
 * runs; costUsd their sum. `dropped` lists the old names a re-recorded session no longer has.
 */
export function mergeIndex(old: Index | null, version: string, run: v.InferOutput<typeof Run>, added: Fixture[]): { index: Index, dropped: string[] } {
  const kept = Object.entries(old?.fixtures ?? {}).filter(([, e]) => !run.sessions.includes(e.session));
  const fixtures: Index['fixtures'] = Object.fromEntries(kept);
  for (const f of added) {
    const tool = field(f.input, 'tool');
    fixtures[f.name] = { event: f.event, session: f.session, ...(typeof tool === 'string' && { tool }), ...(f.hook && { hook: f.hook }) };
  }
  const runs = [...(old?.runs ?? []), run];
  const costUsd = Number(runs.reduce((sum, r) => sum + r.costUsd, 0).toFixed(4));
  const dropped = Object.keys(old?.fixtures ?? {}).filter(n => !(n in fixtures));
  return { index: { version, costUsd, runs, gaps: GAPS, fixtures }, dropped };
}

// ---- answering ----

const Question = v.looseObject({ question: v.string(), options: v.array(v.looseObject({ label: v.string() })) });

/**
 * The recorder's answer, as the person, to a permission request the session sends over stdio: it approves a plan and
 * picks each question's first option, so their results get recorded; anything --allowedTools did not allow is refused.
 */
export function answer(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'ExitPlanMode') return { behavior: 'allow', updatedInput: input };
  if (tool === 'AskUserQuestion') {
    const qs = v.safeParse(v.array(Question), input.questions);
    const answers = Object.fromEntries((qs.success ? qs.output : []).map(q => [q.question, q.options[0]?.label ?? '']));
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }
  return { behavior: 'deny', message: 'not part of this recording' };
}

// ---- cleaning up ----

/** The plugin's data folder name for a --plugin-dir load of the logging plugin (`rec`). */
const PLUGIN_DATA = 'rec-inline';

/**
 * What a recorded session leaves in the config dir it ran on: its task list (by session id and by the list id the
 * recorder set), its session env, the temp project's folder, and the logging plugin's data folder.
 */
export function leftovers(config: string, project: string, sessionIds: readonly string[], listId: string): string[] {
  return [
    ...sessionIds.flatMap(id => [path.join(config, 'tasks', id), path.join(config, 'session-env', id)]),
    path.join(config, 'tasks', listId),
    path.join(config, 'projects', encodePath(project)),
    path.join(config, 'plugins', 'data', PLUGIN_DATA),
  ];
}

// ---- recording ----

type Session = { name: string, prompt: string, args: string[] };
const SESSIONS: Session[] = [
  { name: 'steps', prompt: '/rec:steps', args: [
    '--tools', 'Write,Edit,Bash,TaskCreate,TaskUpdate,TaskList,TaskGet,AskUserQuestion,SendMessage',
    '--allowedTools', 'Write Edit Bash(git *) Bash(ls *) Bash(npm test) TaskCreate TaskUpdate TaskList TaskGet SendMessage'] },
  { name: 'plan', prompt: 'Without reading any file, make a two-line plan to append a line `three` to notes.txt, then present it with ExitPlanMode. Once it is approved, reply "ok" and stop without changing anything.', args: [
    '--permission-mode', 'plan', '--tools', 'Write,Edit,ExitPlanMode'] },
  { name: 'extra', prompt: '/rec:extra', args: [
    '--tools', 'Bash,TaskCreate,TaskUpdate', '--allowedTools', 'Bash(git push *) TaskCreate TaskUpdate'] },
];

const Request = v.looseObject({ type: v.literal('control_request'), request_id: v.string(),
  request: v.looseObject({ subtype: v.string(), tool_name: v.optional(v.string()), input: v.optional(v.record(v.string(), v.unknown())) }) });
const Done = v.looseObject({ type: v.literal('result'), total_cost_usd: v.optional(v.number()), result: v.optional(v.string()), is_error: v.optional(v.boolean()) });
type Done = v.InferOutput<typeof Done>;
const WithSession = v.looseObject({ session_id: v.pipe(v.string(), v.uuid()) });

// plansDirectory must be inside the project (relative to it), or plan files land in the config's plans/
const PLANS = '.plans';
const parseOr = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const git = (cwd: string, ...args: string[]): void => { spawnSync('git', args, { cwd, stdio: 'ignore' }); };

function project(dir: string): void {
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "rec", "private": true, "scripts": { "test": "node --test" } }\n');
  fs.writeFileSync(path.join(dir, 'test', 'one.test.js'), "import { test } from 'node:test';\ntest('one', () => {});\n");
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.name', 'Rec');
  git(dir, 'config', 'user.email', KEEP_EMAIL);
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  git(path.dirname(dir), 'init', '-q', '--bare', 'remote.git');
  git(dir, 'remote', 'add', 'origin', '../remote.git');
  fs.mkdirSync(path.join(dir, PLANS)); // after the commit: an empty folder is no change
}

/** The env a recorded run gets: the parent's, without the marks of a Claude Code session around it. */
function childEnv(listId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, val] of Object.entries(process.env)) if (!/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|SUB_HUMAN_)/.test(k)) env[k] = val;
  return { ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_TASK_LIST_ID: listId };
}

/**
 * One stream-json session: the prompt in, permission requests answered, until its result (or stderr's, as an error);
 * with every session id it reported, for the cleanup.
 */
function session(bin: string, args: string[], prompt: string, cwd: string, listId: string): Promise<{ done: Done, ids: string[] }> {
  return new Promise(resolve => {
    const child = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', ...args], { cwd, env: childEnv(listId), stdio: ['pipe', 'pipe', 'pipe'] });
    const send = (o: unknown): void => { child.stdin.write(`${JSON.stringify(o)}\n`); };
    const ids = new Set<string>();
    let done: Done | null = null;
    let err = '';
    const timer = setTimeout(() => child.kill(), 300_000);
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      const msg = parseOr(line);
      const sid = v.safeParse(WithSession, msg);
      if (sid.success) ids.add(sid.output.session_id);
      const req = v.safeParse(Request, msg);
      if (req.success && req.output.request.subtype === 'can_use_tool') {
        const { tool_name = '', input = {} } = req.output.request;
        send({ type: 'control_response', response: { subtype: 'success', request_id: req.output.request_id, response: answer(tool_name, input) } });
      }
      const end = v.safeParse(Done, msg);
      if (end.success) { done = end.output; child.stdin.end(); }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ done: done ?? { type: 'result', is_error: true, result: err.trim().slice(0, 300) || 'no result' }, ids: [...ids] });
    });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: '' });
  });
}

const flag = (argv: string[], name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

function readIndex(dir: string): Index | null {
  const f = path.join(dir, 'index.json');
  return fs.existsSync(f) ? v.parse(Index, JSON.parse(fs.readFileSync(f, 'utf8'))) : null;
}

async function main(argv: string[]): Promise<number> {
  const version = probedVersion();
  const only = flag(argv, '--only')?.split(',');
  const budget = Number(flag(argv, '--budget') ?? '0.5'); // the most all sessions together may spend
  const outDir = path.resolve(flag(argv, '--out') ?? path.join(FIXTURES, version));
  const found = claudeBin(version);
  if ('error' in found) { process.stderr.write(`record-fixtures: ${found.error}\n`); return 1; }
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rec-')));
  const listId = path.basename(work);
  const cwd = path.join(work, 'project');
  project(cwd);
  const config = path.join(os.homedir(), '.claude');
  const sessions = SESSIONS.filter(x => !only || only.includes(x.name));
  const old = readIndex(outDir);
  const kept = Object.entries(old?.fixtures ?? {}).filter(([, e]) => !sessions.some(s => s.name === e.session)).map(([n]) => n);
  const taken = new Set(kept);
  let cost = 0;
  const fixtures: Fixture[] = [];
  for (const s of sessions) {
    const dir = path.join(work, s.name);
    fs.cpSync(TEMPLATE, path.join(dir, 'plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'log'), { recursive: true });
    const { done, ids } = await session(found.bin, ['--plugin-dir', path.join(dir, 'plugin'), '--setting-sources', 'project',
      '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', (budget - cost).toFixed(2),
      '--settings', JSON.stringify({ plansDirectory: PLANS }), ...s.args], s.prompt, cwd, listId);
    for (const p of leftovers(config, cwd, ids, listId)) fs.rmSync(p, { recursive: true, force: true });
    const spent = done.total_cost_usd ?? 0;
    cost += spent;
    process.stdout.write(`${s.name}: $${spent.toFixed(4)} ${done.is_error ? '(error) ' : ''}${(done.result ?? '').slice(0, 100)}\n`);
    fixtures.push(...fixturesFrom(path.join(dir, 'log'), s.name, taken));
  }
  const after = kept.reduce((n, name) => Math.max(n, lastFake(fs.readFileSync(path.join(outDir, `${name}.json`), 'utf8'))), 0);
  const home = os.homedir();
  const tmp = os.tmpdir();
  const scrub = scrubber([[cwd, '/work/project'], [work, '/work'], [tmp, '/tmp'], [fs.realpathSync(tmp), '/tmp'], [home, '/home/user']], path.basename(home), after);
  const run = { date: new Date().toISOString().slice(0, 10), sessions: sessions.map(s => s.name), costUsd: Number(cost.toFixed(4)) };
  const { index, dropped } = mergeIndex(old, version, run, fixtures);
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of dropped) fs.rmSync(path.join(outDir, `${name}.json`), { force: true });
  for (const f of fixtures) fs.writeFileSync(path.join(outDir, `${f.name}.json`), `${scrub(JSON.stringify(f, null, 2))}\n`);
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(`record-fixtures: ${fixtures.length} fixtures in ${path.relative(process.cwd(), outDir)}, $${cost.toFixed(4)}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
