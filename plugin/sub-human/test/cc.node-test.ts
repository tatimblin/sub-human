// Tests for lib/cc/ (the Claude Code contract and its readers) and scripts/probe-cc.ts. Fixture transcript lines follow
// the shapes in docs/internals/cc-2.1.281.md (checked against real 2.1.281 transcripts; unchanged in 2.1.292,
// see docs/internals/cc-2.1.292.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as env from '../lib/cc/env.ts';
import * as transcript from '../lib/cc/transcript.ts';
import * as bg from '../lib/cc/bg.ts';
import * as contract from '../lib/cc/contract.ts';
import type { JobsOpts } from '../lib/cc/bg.ts';
type TranscriptLine = Parameters<typeof transcript.planFile>[0][number];
import type { ProbeResult } from '../lib/cc/contract.ts';
import { must } from './support/must.ts';

const cc = { ...env, ...transcript, ...bg, ...contract };

/** scripts/probe-cc.ts --json. */
interface ProbeOut { ok: boolean; version: string; cpuMs: number; results: ProbeResult[] }
const probeOut = (stdout: string) => JSON.parse(stdout) as ProbeOut;
/** A runner's answer, as jobs() and daemonStatus() read it. */
type RunAnswer = ReturnType<NonNullable<JobsOpts['run']>>;

const PROBE = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'probe-cc.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cc-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const J = (o: unknown) => JSON.stringify(o);
/** A contract entry's search or shape, as a list. */
const list = (x: string | readonly string[] | undefined): readonly string[] => (typeof x === 'string' ? [x] : x ?? []);
const REJECT = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n';
const NOTE_SUFFIX = '\n\nNote: The user\'s next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they\'d prefer you to work, consider saving that to memory for future sessions.';

const planAttach = (p: string) => J({ type: 'attachment', isSidechain: false, attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false, planFilePath: p, planExists: false } });
const toolUse = (id: string, input: unknown) => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input }] } });
const rejected = (id: string, note: string, { structured = true } = {}) => J({
  type: 'user', promptId: 'p1',
  message: { role: 'user', content: [{ type: 'tool_result', content: REJECT + note + NOTE_SUFFIX, is_error: true, tool_use_id: id }] },
  toolDenialKind: 'user-rejected', ...(structured ? { userFeedback: note } : {}),
});
const escaped = (id: string) => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected', is_error: true, tool_use_id: id }] } });
const approved = (id: string) => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'User has approved your plan.', tool_use_id: id }] } });

// ---------- env ----------

test('env: sessionId and claudePid validate', () => {
  assert.equal(cc.sessionId({ CLAUDE_CODE_SESSION_ID: 'abc-1' }), 'abc-1');
  assert.equal(cc.sessionId({ CLAUDE_CODE_SESSION_ID: '' }), null);
  assert.equal(cc.sessionId({}), null);
  assert.equal(cc.claudePid({ CLAUDE_PID: '4242' }), 4242);
  for (const bad of ['0', '-3', '1.5', 'x', '', undefined]) assert.equal(cc.claudePid({ CLAUDE_PID: bad }), null, String(bad));
  assert.equal(cc.taskListId({ CLAUDE_CODE_TASK_LIST_ID: 'sh-ab12' }), 'sh-ab12');
  assert.equal(cc.taskListId({}), null);
  assert.equal(cc.ENV.PID, 'CLAUDE_PID');
});

test('configDir respects CLAUDE_CONFIG_DIR; tasksDir sanitises like the binary', () => {
  assert.equal(cc.configDir({ HOME: '/h' }), path.join('/h', '.claude'));
  assert.equal(cc.configDir({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg');
  assert.equal(cc.tasksDir('sh-ab12', { CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', 'tasks', 'sh-ab12'));
  assert.equal(cc.tasksDir('a/b c.d', { CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', 'tasks', 'a-b-c-d'));
  assert.equal(cc.taskFile('l', '7', { CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', 'tasks', 'l', '7.json'));
  assert.equal(cc.sanitizeId('ok_-Z9'), 'ok_-Z9');
});

test('clearContextOnPlanAccept reads user, project and local settings', () => {
  const home = path.join(tmp, 'home'), proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const env = { HOME: home };
  assert.equal(cc.clearContextOnPlanAccept(proj, env), false);
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), J({ showClearContextOnPlanAccept: true }));
  assert.equal(cc.clearContextOnPlanAccept(proj, env), true);
  assert.equal(cc.clearContextOnPlanAccept(null, env), false);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{not json');
  assert.equal(cc.clearContextOnPlanAccept(null, env), false);
  assert.deepEqual(cc.userSettingsFiles(null, { CLAUDE_CONFIG_DIR: '/cfg' }), [path.join('/cfg', 'settings.json')]);
});

// ---------- transcript ----------

test('readLines: whole file, tail with a cut first line dropped, missing file', () => {
  const f = path.join(tmp, 't.jsonl');
  fs.writeFileSync(f, ['{"a":1}', '{"b":2}', '{"c":3}', ''].join('\n'));
  assert.deepEqual(cc.readLines(f), ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.deepEqual(cc.readLines(f, { tailBytes: 12 }), ['{"c":3}']); // cut inside {"b":2}
  assert.deepEqual(cc.readLines(f, { tailBytes: 16 }), ['{"b":2}', '{"c":3}']); // cut exactly on a boundary
  assert.deepEqual(cc.readEntries(f, { tailBytes: 16 }), [{ b: 2 }, { c: 3 }]);
  assert.deepEqual(cc.readLines(path.join(tmp, 'nope')), []);
  assert.deepEqual(cc.readLines(''), []);
  assert.deepEqual(cc.parseLines(['{"x":1}', '{torn', { y: 2 }]), [{ x: 1 }, { y: 2 }]);
});

test("planFile: the latest plan_mode attachment; ExitPlanMode's input only as that path or under the plans dir", () => {
  const lines = [planAttach('/p/old.md'), J({ type: 'attachment', attachment: { type: 'plan_mode_exit', planFilePath: '/p/exit.md' } }), planAttach('/p/new.md'), '{"torn'];
  assert.equal(cc.planFile(lines), '/p/new.md');
  // ExitPlanMode's planFilePath counts only as the attachment's own path or one under the plans dir: never a model's pick
  assert.equal(cc.planFile(lines, { planFilePath: '/p/new.md' }), '/p/new.md');
  assert.equal(cc.planFile(lines, { planFilePath: '/p/input.md' }), '/p/new.md');
  const plans = cc.plansDir();
  assert.equal(cc.planFile(lines, { planFilePath: `${plans}/input.md` }), `${plans}/input.md`);
  assert.equal(cc.planFile(lines, { planFilePath: `${plans}/../settings.json` }), '/p/new.md');
  assert.equal(cc.planFile([], { planFilePath: '/etc/passwd' }), null);
  assert.equal(cc.planFile(lines.map(l => { try { return JSON.parse(l) as TranscriptLine; } catch { return null; } }).filter(l => l !== null)), '/p/new.md');
  assert.equal(cc.planFile([]), null);
});

test('planFeedback: structured userFeedback, text fallback, Esc and approval', () => {
  const lines = [toolUse('t1', {}), rejected('t1', 'tighten step 2\nand 3')];
  assert.equal(cc.planFeedback(lines, 't1'), 'tighten step 2\nand 3');
  assert.equal(cc.planFeedback([rejected('t1', 'from text', { structured: false })], 't1'), 'from text');
  // the structured field wins over the text
  const both = J({ ...JSON.parse(rejected('t1', 'text note')), userFeedback: 'raw note' });
  assert.equal(cc.planFeedback([both], 't1'), 'raw note');
  assert.equal(cc.planFeedback([escaped('t2')], 't2'), null);
  assert.equal(cc.planFeedback([approved('t3')], 't3'), null);
  assert.equal(cc.planFeedback(lines, 'other'), null);
  assert.equal(cc.planFeedback(lines, null), null);
});

test('planAnswer: null until the tool_result is on disk; then the note, or note null (Esc, approval); the 2.1.296 trial row', () => {
  assert.equal(cc.planAnswer([toolUse('t1', {})], 't1'), null, 'the dialog still open');
  assert.equal(cc.planAnswer([toolUse('t1', {}), rejected('t1', 'x')], null), null);
  assert.deepEqual(cc.planAnswer([escaped('t2')], 't2'), { note: null });
  assert.deepEqual(cc.planAnswer([approved('t3')], 't3'), { note: null });
  // round 4, proposal 471cf694a6b9: bob's "Tell Claude what to change", as 2.1.296 wrote it
  const note = 'Keep the old heading as a subtitle under the new one';
  const content = `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${note}\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.`;
  const row = J({ parentUuid: 'c30cb4f4-638d-4681-91d5-6de50f162c19', isSidechain: false, type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content, is_error: true, tool_use_id: 'toolu_01HdxRtAHngcdhVfcMdMLXLZ' }] },
    timestamp: '2026-10-15T05:26:27.696Z', toolUseResult: `Error: ${content}`, toolDenialKind: 'user-rejected', userFeedback: note,
    sourceToolAssistantUUID: 'c30cb4f4-638d-4681-91d5-6de50f162c19', permissionDecision: { decision: 'reject', source: 'user_reject' }, version: '2.1.296' });
  const lines = [toolUse('toolu_01HdxRtAHngcdhVfcMdMLXLZ', { plan: 'proposal 471cf694a6b9' }), row, J({ type: 'permission-mode', permissionMode: 'plan' })];
  assert.deepEqual(cc.planAnswer(lines, 'toolu_01HdxRtAHngcdhVfcMdMLXLZ'), { note });
  assert.equal(cc.planFeedback(lines, 'toolu_01HdxRtAHngcdhVfcMdMLXLZ'), note);
});

test('lastHumanPrompt: the newest prompt only when it is the person\'s (no origin, or kind human); tool results and meta rows skipped', () => {
  const user = (content: unknown, extra = {}) => J({ type: 'user', message: { role: 'user', content }, timestamp: '2026-10-08T10:00:00.000Z', ...extra });
  assert.deepEqual(cc.lastHumanPrompt([user('open v2'), user('Open v3')]), { text: 'Open v3', at: Date.parse('2026-10-08T10:00:00.000Z') });
  assert.equal(must(cc.lastHumanPrompt([user('Open v3', { origin: { kind: 'human' } })])).text, 'Open v3');
  assert.equal(must(cc.lastHumanPrompt([user([{ type: 'text', text: 'Open v3' }])])).text, 'Open v3');
  const skipped = [user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), user('caveat', { isMeta: true }), user('side', { isSidechain: true }), J({ type: 'assistant', message: { content: 'hi' } })];
  assert.equal(must(cc.lastHumanPrompt([user('Open v3'), ...skipped])).text, 'Open v3');
  for (const kind of ['peer', 'task-notification', 'channel', 'plugin', 'unclassified', undefined]) {
    assert.equal(cc.lastHumanPrompt([user('Open v3'), user('open v2', { origin: kind === undefined ? {} : { kind } })]), null, String(kind));
  }
  assert.equal(cc.lastHumanPrompt([]), null);
});

test('toolUseInput: the model input from the assistant tool_use block', () => {
  const lines = [toolUse('t1', { plan: 'proposal ab12' }), rejected('t1', 'x')];
  assert.deepEqual(cc.toolUseInput(lines, 't1'), { plan: 'proposal ab12' });
  assert.equal(cc.toolUseInput(lines, 'zz'), null);
});

// ---------- prompts ----------

test('pasted content', () => {
  const p = '@room look\n\n<pasted_content id="1">\nline a\nline b\n</pasted_content id="1">\n';
  assert.deepEqual(cc.unwrapPasted(p), { text: '@room lookline a\nline b', normalized: true });
  assert.deepEqual(cc.unwrapPasted('plain'), { text: 'plain', normalized: false });
});

// ---------- jobs ----------

test('parseDispatch / JOB_RE', () => {
  assert.equal(cc.parseDispatch('backgrounded · 0b500131 · claude.ab12\n  claude agents   list sessions'), '0b500131');
  assert.equal(cc.parseDispatch('\u001b[0mbackgrounded · \u001b[36m0b500131'), null); // colour codes in the id: not parsed
  assert.equal(cc.parseDispatch('error: not trusted'), null);
  assert.equal(cc.parseDispatch(''), null);
});

const AGENTS = J([
  { id: 'e738dbef', cwd: '/r', kind: 'background', startedAt: 1, sessionId: 'e738dbef-93a2', name: 'old', state: 'failed' },
  { pid: 14474, id: '0a52ce26', cwd: '/r', kind: 'background', startedAt: 2, sessionId: '0a52ce26-6183', name: 'claude.ab12', status: 'busy', state: 'blocked' },
  { pid: 38545, cwd: '/r', kind: 'interactive', startedAt: 3, sessionId: '310228bc-3e3a', name: 'repos-4a', status: 'idle' },
]);

test('parseAgentsJson', () => {
  const js = cc.parseAgentsJson(AGENTS);
  assert.ok(js);
  assert.equal(js.length, 3);
  assert.deepEqual(js[0], { pid: null, id: 'e738dbef', sessionId: 'e738dbef-93a2', status: null, state: 'failed', kind: 'background', name: 'old', cwd: '/r', startedAt: 1 });
  assert.equal(js[1]?.pid, 14474);
  assert.equal(must(js[2]).id, null);
  assert.equal(cc.parseAgentsJson('nope'), null);
  assert.equal(cc.parseAgentsJson('{}'), null);
});

test('jobs() runs agents --json through an injected runner', () => {
  const calls: [string, string[]][] = [];
  const run = (bin: string, args: string[]) => { calls.push([bin, args]); return { status: 0, stdout: AGENTS }; };
  assert.equal(must(cc.jobs({ all: true, bin: 'cl', run })).length, 3);
  assert.deepEqual(calls[0], ['cl', ['agents', '--json', '--all']]);
  assert.equal(cc.jobs({ run: () => ({ status: 1, stdout: '' }) }), null);
  // @ts-expect-error -- deliberate: no status or stdout, as spawnSync's failure
  const failed: RunAnswer = { error: new Error('ENOENT') };
  assert.equal(cc.jobs({ run: () => failed }), null);
  assert.equal(cc.jobs({ run: () => { throw new Error('x'); } }), null);
  assert.deepEqual(cc.stopCmd(7), ['stop', '7']);
  assert.deepEqual(cc.agentsCmd(), ['agents', '--json']);
});

// `claude daemon status` as 2.1.296 prints it (running: exit 0; not running: exit 1)
const DAEMON_UP = 'pid:     51234\nversion: 2.1.296\nuptime:  812s\norigin:  transient\nconfig:  /Users/a/.claude/daemon.json\nlog:     /Users/a/.claude/daemon.log\n';
const DAEMON_DOWN = 'not running\n\nbg sessions:\n  sock dir:     /tmp/cc-daemon-501/38281156\n  control.sock: unreachable (connect ENOENT)\n';

test('parseDaemonStatus / daemonStatus: pid and version, not running, anything else null', () => {
  assert.deepEqual(cc.parseDaemonStatus(DAEMON_UP), { running: true, pid: 51234, version: '2.1.296' });
  assert.deepEqual(cc.parseDaemonStatus(DAEMON_DOWN), { running: false, pid: null, version: null });
  assert.deepEqual(cc.parseDaemonStatus('version: 2.1.296\n'), { running: true, pid: null, version: '2.1.296' });
  assert.equal(cc.parseDaemonStatus(''), null);
  assert.equal(cc.parseDaemonStatus('Usage: claude daemon [subcommand]'), null);
  const calls: [string, string[]][] = [];
  const run = (bin: string, args: string[]) => { calls.push([bin, args]); return { status: 0, stdout: DAEMON_UP }; };
  assert.equal(must(cc.daemonStatus({ bin: 'cl', run })).pid, 51234);
  assert.deepEqual(calls[0], ['cl', ['daemon', 'status']]);
  assert.equal(must(cc.daemonStatus({ run: () => ({ status: 1, stdout: DAEMON_DOWN }) })).running, false, 'exit 1 is "not running", not an error');
  assert.equal(cc.daemonStatus({ run: () => ({ error: new Error('ENOENT'), status: null, stdout: '' }) }), null);
  assert.equal(cc.daemonStatus({ run: () => { throw new Error('x'); } }), null);
  assert.equal(cc.daemonStatus({ run: () => ({ status: 0, stdout: 'unknown command' }) }), null);
});

test('exeState: /proc/PID/exe " (deleted)" on Linux; elsewhere ps -o comm=, deleted when an absolute path is gone', () => {
  const noProc = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const never = () => { throw new Error('not called'); };
  // Linux
  assert.deepEqual(cc.exeState(42, { readlink: () => '/home/u/.local/share/claude/versions/2.1.292 (deleted)', ps: never }),
    { exe: '/home/u/.local/share/claude/versions/2.1.292', deleted: true });
  assert.deepEqual(cc.exeState(42, { readlink: () => '/home/u/.local/share/claude/versions/2.1.296', ps: never }),
    { exe: '/home/u/.local/share/claude/versions/2.1.296', deleted: false });
  // macOS: no /proc
  const cask = '/opt/homebrew/Caskroom/claude-code@latest/2.1.292/claude';
  assert.deepEqual(cc.exeState(42, { readlink: noProc, ps: () => `${cask}\n`, exists: () => false }), { exe: cask, deleted: true });
  assert.deepEqual(cc.exeState(42, { readlink: noProc, ps: () => `${cask}\n`, exists: p => p === cask }), { exe: cask, deleted: false });
  assert.deepEqual(cc.exeState(42, { readlink: noProc, ps: () => 'claude\n', exists: () => false }), { exe: 'claude', deleted: false }, 'a bare name says nothing');
  assert.equal(cc.exeState(42, { readlink: noProc, ps: () => '' }), null, 'no such process');
  assert.equal(cc.exeState(42, { readlink: noProc, ps: () => { throw new Error('x'); } }), null);
  for (const bad of [0, -1, 'x', null, 1.5]) assert.equal(cc.exeState(bad, { readlink: never, ps: never }), null);
  // a live process of this test run: its executable exists
  const self = cc.exeState(process.pid);
  assert.equal(must(self).deleted, false);
});

test('DAEMON_ENV_ALLOW and daemonEnv', () => {
  for (const k of ['PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_PLUGIN_DIRS',
    // added to the daemon's allowlist in 2.1.292
    'CLAUDE_CODE_CLIENT_DATA_URL', 'CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT', 'CLAUDE_CODE_DISABLE_PROACTIVITY', 'CLAUDE_CODE_AUTO_MODE_TIER', 'CLAUDE_BG_AUTO_MEMORY_OFF',
    // and in 2.1.296
    'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG'])
    assert.ok(cc.DAEMON_ENV_ALLOW.includes(k), k);
  for (const k of ['HOME', 'CLAUDE_CODE_TASK_LIST_ID', 'CLAUDE_CODE_ENABLE_TODO_TOOLS', 'SUB_HUMAN_HOME', 'ANTHROPIC_API_KEY'])
    assert.ok(!cc.DAEMON_ENV_ALLOW.includes(k), k);
  assert.equal(new Set(cc.DAEMON_ENV_ALLOW).size, cc.DAEMON_ENV_ALLOW.length);
  assert.deepEqual(cc.daemonEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_TASK_LIST_ID: 'x' }), { PATH: '/bin' });
});

// ---------- matcher ----------

test('matcherIsExact / matcherMatches follow the binary rule', () => {
  assert.equal(cc.matcherIsExact('Agent|Task'), true);
  assert.equal(cc.matcherIsExact('TaskCreate, TaskUpdate'), true);
  assert.equal(cc.matcherIsExact('TaskCreate, TaskUpdate', { toolEvent: false }), false);
  assert.equal(cc.matcherIsExact('mcp__plugin_sub-human_room__.*'), false);
  assert.equal(cc.matcherIsExact('^(sub-human:)?sub-human$', { toolEvent: false }), false);
  assert.equal(cc.matcherIsExact(''), false);
  assert.equal(cc.matcherIsExact('*'), false);
  assert.equal(cc.matcherMatches('Agent|Task', 'TaskCreate'), false);
  assert.equal(cc.matcherMatches('Agent|Task', 'Task'), true);
  assert.equal(cc.matcherMatches('TaskCreate,TaskUpdate', 'TaskUpdate'), true);
  // unanchored regex: Edit inside an MCP tool name matches
  const m = 'Write|Edit|MultiEdit|NotebookEdit|mcp__plugin_sub-human_room__.*';
  assert.equal(cc.matcherMatches(m, 'mcp__other__EditThing'), true);
  assert.equal(cc.matcherMatches('^(Write|Edit)$|^mcp__plugin_sub-human_room__', 'mcp__other__EditThing'), false);
  assert.equal(cc.matcherMatches('', 'anything'), true);
  assert.equal(cc.matcherMatches('*', 'anything'), true);
  assert.equal(cc.matcherMatches('(', 'x'), false);
});

// ---------- contract ----------

test('CONTRACT entries are well formed and unique', () => {
  const ids = new Set();
  const VER = /^\d+\.\d+\.\d+$/;
  assert.match(cc.PROBED_VERSION, VER);
  assert.match(cc.MIN_VERSION, VER);
  for (const e of cc.CONTRACT) {
    assert.ok(e.id && !ids.has(e.id), e.id);
    ids.add(e.id);
    assert.ok(['API', 'env', 'incidental'].includes(e.stability), e.id);
    assert.ok(Number.isInteger(e.section), e.id);
    // the version range: first checked on `since`, last on PROBED_VERSION
    assert.ok(e.since && VER.test(e.since) && must(cc.compareVersions(e.since, cc.PROBED_VERSION)) <= 0, e.id);
    const s = Array.isArray(e.search) ? e.search : [e.search];
    assert.ok(s.length && s.every(x => typeof x === 'string' && x.length >= 8), e.id);
    const sh = e.shape === undefined ? [] : Array.isArray(e.shape) ? e.shape : [e.shape];
    // a shape keeps enough literal text to stay specific
    assert.ok(sh.every(x => typeof x === 'string' && x.replace(/~/g, '').length >= 16), e.id);
    for (const g of e.contains || []) {
      assert.ok(g.what && g.in.replace(/~/g, '').length >= 16 && g.names.length && g.names.every(n => /^\w+$/.test(n)), `${e.id}: ${g.what}`);
    }
    for (const d of e.degraded || []) assert.ok(VER.test(d.from) && must(cc.compareVersions(d.from, cc.PROBED_VERSION)) > 0 && d.note, e.id);
    assert.ok(e.note, e.id);
  }
  for (const id of ['task-completed-block-drops-fields', 'subagent-statusline-precedence', 'daemon-env-allowlist', 'matcher-rule',
    'hooks-json-modules', 'classic-chain-order', 'prompt-submit-ups-order', 'session-append-notice-hidden', 'ui-log-notice', 'process-run-stdin', 'plugin-test-off', 'plugin-types-state', 'prompt-origin-composer',
    'mcp-stdio-ppid', 'mcp-progress-resets-idle-timeout', 'mcp-server-shared-by-subagents', 'session-title-address'])
    assert.ok(ids.has(id), id);
  // the contract is data: the JSON file is CONTRACT, and nothing else holds an entry
  const json = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'cc', 'contract.json'), 'utf8')) as { entries: { id: string }[] };
  assert.deepEqual(json.entries.map(e => e.id), cc.CONTRACT.map(e => e.id));
  assert.ok(!fs.existsSync(path.join(import.meta.dirname, '..', 'lib', 'cc.ts')), 'lib/cc.ts is gone: import lib/cc/{env,transcript,bg,contract}.ts');
});

test('session-append-notice-rewrite is reported degraded from 2.1.300 (#8); degradedOn names it there and only there', () => {
  const e = must(cc.CONTRACT.find(x => x.id === 'session-append-notice-rewrite'));
  assert.deepEqual(must(e.degraded).map(d => [d.from, d.issue]), [['2.1.300', 8]]);
  assert.deepEqual(cc.degradedOn('2.1.296'), []);
  assert.deepEqual(cc.degradedOn('2.1.300').map(d => [d.id, d.issue]), [['session-append-notice-rewrite', 8]]);
  assert.deepEqual(cc.degradedOn('2.1.301').map(d => d.id), ['session-append-notice-rewrite']);
  assert.deepEqual(cc.degradedOn('not a version'), []);
});

test('every @cc tag in lib/cc/*.ts names a string some CONTRACT entry searches for', () => {
  const dir = path.join(import.meta.dirname, '..', 'lib', 'cc');
  const src = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const all = new Set(cc.CONTRACT.flatMap(e => list(e.search)));
  const tags = [...src.matchAll(/^ \* @cc (.+)$/gm)].map(m => must(m[1]));
  assert.ok(tags.length > 20);
  // doc comments write \n literally where the binary has a newline in a template or \n in a regex
  for (const t of tags) assert.ok(all.has(t) || all.has(t + ' ') || all.has(t.replace(/\\n/g, '\n')), t);
});

test('daemon-env-allowlist: a shape, not the exact arrays: each group\'s array must hold its names, in any order, more allowed', () => {
  const e = must(cc.CONTRACT.find(x => x.id === 'daemon-env-allowlist'));
  // the groups are DAEMON_ENV_ALLOW
  assert.deepEqual([...new Set(must(e.contains).flatMap(g => g.names))].sort(), [...cc.DAEMON_ENV_ALLOW].sort());
  const g = { what: 'base', in: 'new Set(["A_KEY_ANCHOR_LONG",', names: ['A_KEY_ANCHOR_LONG', 'B_KEY'] };
  const run = (text: string) => must(cc.probe(Buffer.from(text, 'latin1'), { entries: [{ id: 'x', stability: 'env', search: ['A_KEY_ANCHOR_LONG'], contains: [g], note: '' }] })[0]);
  assert.equal(run('var q=new Set(["A_KEY_ANCHOR_LONG",...x,"B_KEY"]),z=1;').ok, true);
  assert.equal(run('var q=new Set(["A_KEY_ANCHOR_LONG","NEW_KEY",...x,"B_KEY","LATER"]);').ok, true, 'keys added and moved pass');
  const dropped = run('var q=new Set(["A_KEY_ANCHOR_LONG",...x,"C_KEY"]);"B_KEY";');
  assert.equal(dropped.ok, false, 'a key dropped from the array fails, even when the name is quoted elsewhere');
  assert.deepEqual(dropped.missing, ['contains: base: B_KEY']);
  assert.match(String(run('"A_KEY_ANCHOR_LONG"').missing[0]), /^contains: base: no array at /);
  // a shape anchor
  const sh = { what: 'set', in: '~=new Set([...~,...~,"CLAUDE_', names: ['CLAUDE_X'] };
  const r = must(cc.probe(Buffer.from('a,Qz=new Set([...q6e,...l5n,"CLAUDE_Y","CLAUDE_X"]);', 'latin1'), { entries: [{ id: 'y', stability: 'env', contains: [sh], note: '' }] })[0]);
  assert.equal(r.ok, true);
  assert.deepEqual([...must(cc.arrayAt(String.raw`x=["a","b\"",...y,["c"],"d"]`, 0))], ['a', String.raw`b\"`, 'd'], 'escapes and nested arrays skipped');
  assert.equal(cc.arrayAt('x=["a"', 0), null);
});

test('shapeRe: ~ is one minified identifier, the rest is literal', () => {
  const r = cc.shapeRe('if(~.status===2&&!~.blockingError)');
  assert.ok(r.test('x;if(Vo.status===2&&!$z.blockingError)y'));
  assert.ok(!r.test('if(Vo.status===2&&!.blockingError)'));
  assert.ok(!r.test('if(Vo.status==2&&!zs.blockingError)'));
  assert.ok(!r.test('if(a.b.status===2&&!zs.blockingError)'));
  assert.ok(cc.shapeRe('var ~=1500,').test('var Nqo=1500,'));
  assert.ok(!cc.shapeRe('a.b(~)').test('aXb(c)'));
});

test('the plugin ships exactly one hooks module, at the path hooks.json names', () => {
  // cc CONTRACT hooks-json-modules / hooks-modules: an installed plugin's function hooks are the one module that
  // hooks/hooks.json names under `modules` (relative to hooks.json), loaded by default since 2.1.292.
  // "hooks/register.ts" is the built-in plugins' fixed path, not ours: ours is mod/register.ts, and no register.*
  // sits in hooks/ to be mistaken for it.
  const hooks = path.join(import.meta.dirname, '..', 'hooks');
  const json = JSON.parse(fs.readFileSync(path.join(hooks, 'hooks.json'), 'utf8')) as { modules: string[] };
  assert.deepEqual(json.modules, ['../mod/register.ts'], 'hooks.json names one hooks module per plugin');
  for (const m of json.modules) assert.ok(fs.statSync(path.resolve(hooks, m)).isFile(), `${m} exists`);
  assert.deepEqual(fs.readdirSync(hooks).filter(f => /^register\.[cm]?[jt]sx?$/.test(f)), []);
});

// ---------- probe ----------

const probeRun = spawnSync(process.execPath, [PROBE, '--json'], { encoding: 'utf8', timeout: 60_000 });
const haveBinary = probeRun.status !== 2;

test('probe: the installed binary satisfies the contract', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const out = probeOut(probeRun.stdout);
  const failed = out.results.filter(r => !r.ok).map(r => `${r.id}: ${r.missing.join(' | ')}`);
  assert.deepEqual(failed, [], `claude ${out.version}`);
  assert.equal(probeRun.status, 0);
  // CPU time, not wall time: beside a loaded suite the wall clock measured the machine, not the probe.
  assert.ok(out.cpuMs < 15_000, `probe CPU ${out.cpuMs} ms`);
});

test('probe: a mutated search string fails', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const extra = J([{ id: 'mutated', search: 'Inbound cross-session peer messages (SendMessage from your other sessions)!!x' }]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'cross-session-inbound'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = probeOut(r.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['cross-session-inbound', true], ['mutated', false]]);
});

test('probe: a mutated shape fails', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const extra = J([{ id: 'shape-ok', search: 'Valid types are: approve, block', shape: 'case"block":~.permissionBehavior="deny"' },
    { id: 'shape-mutated', search: 'Valid types are: approve, block', shape: 'case"block":~.permissionBehavior="allow"' }]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'none'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = probeOut(r.stdout);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['shape-ok', true], ['shape-mutated', false]]);
  assert.match(String(out.results[1]?.missing[0]), /^shape: /);
});

test('probe: a mutated function-hooks entry fails (search and shape)', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const by = (id: string) => must(cc.CONTRACT.find(e => e.id === id), id);
  const extra = J([
    { id: 'modules-search-mutated', search: must(by('hooks-json-modules').search?.[2]) + '!!x' },
    { id: 'chain-shape-mutated', search: by('classic-chain-order').search, shape: must(list(by('classic-chain-order').shape)[0]).replace('function-hook chain', 'function-hooks chain') },
    { id: 'notice-level-mutated', search: must(list(by('session-append-notice-hidden').search)[0]), shape: must(list(by('session-append-notice-hidden').shape)[0]).replace('"info"', '"notice"') },
  ]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'hooks-json-modules,classic-chain-order,session-append-notice-hidden'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = probeOut(r.stdout);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['hooks-json-modules', true], ['classic-chain-order', true], ['session-append-notice-hidden', true],
    ['modules-search-mutated', false], ['chain-shape-mutated', false], ['notice-level-mutated', false]]);
});

test('probe: each review-spike entry fails on a mutated search or shape', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  // cc-2.1.292.md "Review spikes": the MCP, title and chain-order entries each fail when one string is off by a character
  const by = (id: string) => must(cc.CONTRACT.find(e => e.id === id), id);
  const ids = ['mcp-stdio-ppid', 'mcp-progress-resets-idle-timeout', 'mcp-server-shared-by-subagents', 'session-title-address', 'classic-chain-order'];
  const extra: { id: string; search: string; shape?: string }[] = [];
  for (const id of ids) {
    const e = by(id);
    list(must(e.search)).forEach((s, i) => extra.push({ id: `${id}/search${i}`, search: s + '!!x' }));
    list(e.shape || []).forEach((sh, i) => extra.push({ id: `${id}/shape${i}`, search: must(list(e.search)[0]), shape: sh.replace(/[a-zA-Z]{4,}/, w => w + 'Q') }));
  }
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', ids.join(',')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: J(extra) } });
  assert.equal(r.status, 1);
  const out = probeOut(r.stdout);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [...ids.map(id => [id, true]), ...extra.map(x => [x.id, false])]);
});

test('probe: a bogus binary fails every entry', () => {
  const fake = path.join(tmp, 'claude-fake');
  fs.writeFileSync(fake, 'VERSION:"0.0.1" nothing here');
  const r = spawnSync(process.execPath, [PROBE, '--bin', fake], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude 0\.0\.1/);
  assert.match(r.stdout, /FAIL {2}matcher-rule/);
});

test('transcript-home-notice (stage 8f item 1): lastHome reads the folder of the last hidden home notice; a user row or a notice that only quotes it does not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-notice-'));
  const file = path.join(dir, 't.jsonl');
  const notice = (content: string, level = 'info') => ({ type: 'system', subtype: 'informational', content, isMeta: false, level });
  const write = (rows: object[]) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  write([notice('sub-human: home /a/one'), { type: 'user', message: { content: 'sub-human: home /b/two' } }, notice('said: sub-human: home /c/three', 'notice')]);
  assert.equal(transcript.lastHome(file), '/a/one');
  write([notice('sub-human: home /a/one'), notice('sub-human: home /d/four')]);
  assert.equal(transcript.lastHome(file), '/d/four', 'the last wins');
  write([notice('sub-human: home relative')]);
  assert.equal(transcript.lastHome(file), null, 'an absolute folder only');
  assert.equal(transcript.lastHome(path.join(dir, 'none.jsonl')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
