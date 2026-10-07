'use strict';
// Tests for lib/cc.js (the Claude Code contract) and scripts/probe-cc.js. Fixture transcript lines follow
// the shapes in docs/internals/cc-2.1.281.md (checked against real 2.1.281 transcripts; unchanged in 2.1.292,
// see docs/internals/cc-2.1.292.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cc = require(path.join(__dirname, '..', 'lib', 'cc.js'));

const PROBE = path.join(__dirname, '..', '..', '..', 'scripts', 'probe-cc.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-cc-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const J = o => JSON.stringify(o);
const REJECT = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n';
const NOTE_SUFFIX = '\n\nNote: The user\'s next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they\'d prefer you to work, consider saving that to memory for future sessions.';

const planAttach = p => J({ type: 'attachment', isSidechain: false, attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false, planFilePath: p, planExists: false } });
const toolUse = (id, input) => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input }] } });
const rejected = (id, note, { structured = true } = {}) => J({
  type: 'user', promptId: 'p1',
  message: { role: 'user', content: [{ type: 'tool_result', content: REJECT + note + NOTE_SUFFIX, is_error: true, tool_use_id: id }] },
  toolDenialKind: 'user-rejected', ...(structured ? { userFeedback: note } : {}),
});
const escaped = id => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected', is_error: true, tool_use_id: id }] } });
const approved = id => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'User has approved your plan.', tool_use_id: id }] } });

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

test('planFile: tool input first, else the latest plan_mode attachment', () => {
  const lines = [planAttach('/p/old.md'), J({ type: 'attachment', attachment: { type: 'plan_mode_exit', planFilePath: '/p/exit.md' } }), planAttach('/p/new.md'), '{"torn'];
  assert.equal(cc.planFile(lines), '/p/new.md');
  assert.equal(cc.planFile(lines, { planFilePath: '/p/input.md' }), '/p/input.md');
  assert.equal(cc.planFile(lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)), '/p/new.md');
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

test('toolUseInput: the model input from the assistant tool_use block', () => {
  const lines = [toolUse('t1', { plan: 'proposal ab12' }), rejected('t1', 'x')];
  assert.deepEqual(cc.toolUseInput(lines, 't1'), { plan: 'proposal ab12' });
  assert.equal(cc.toolUseInput(lines, 'zz'), null);
});

// ---------- prompts ----------

const ENV_TEXT = '<cross-session-message from="uds:/tmp/x.sock" from-session="0b500131-aaaa" hop-chain="a,b" from-name="orch.ab12" from-mode="bypass" from-plugin="sub-human">\nhello\nworld\n</cross-session-message>';

test('parseEnvelope: attributes in order, optional, body', () => {
  assert.deepEqual(cc.parseEnvelope(ENV_TEXT), {
    from: 'uds:/tmp/x.sock', fromSession: '0b500131-aaaa', hopChain: ['a', 'b'], fromName: 'orch.ab12',
    fromMode: 'bypass', fromPlugin: 'sub-human', body: 'hello\nworld',
  });
  const min = cc.parseEnvelope('<cross-session-message from-name="bob">\n[SendFile: a.txt]\nhi\n</cross-session-message>');
  assert.equal(min.from, null);
  assert.equal(min.fromName, 'bob');
  assert.deepEqual(min.hopChain, []);
  assert.equal(min.body, '[SendFile: a.txt]\nhi');
  // out of order does not parse as an envelope
  assert.equal(cc.parseEnvelope('<cross-session-message from-name="b" from="a">\nx\n</cross-session-message>'), null);
  assert.equal(cc.parseEnvelope('plain'), null);
});

test('isPeerText / isPeerPrompt / entryIsPeer', () => {
  assert.equal(cc.isPeerText(ENV_TEXT), true);
  assert.equal(cc.isPeerText('Another Claude session sent a message: from x'), true);
  assert.equal(cc.isPeerText('x'.repeat(2100) + ENV_TEXT), false); // beyond the 2000-char window
  assert.equal(cc.isPeerText('@room hi'), false);
  // source absent: text decides (current at-room behaviour)
  assert.equal(cc.isPeerPrompt({ prompt: ENV_TEXT }), true);
  assert.equal(cc.isPeerPrompt({ prompt: ENV_TEXT, source: 'system' }), true);
  // a person pasting an envelope into the composer is not a peer
  assert.equal(cc.isPeerPrompt({ prompt: ENV_TEXT, source: 'user' }), false);
  assert.equal(cc.isPeerPrompt({ prompt: '<task-notification>x', source: 'system' }), false);
  assert.equal(cc.isPeerPrompt({}), false);
  assert.equal(cc.entryIsPeer({ type: 'user', origin: { kind: 'peer', from: 'x' }, message: { content: 'hi' } }), true);
  assert.equal(cc.entryIsPeer({ type: 'user', message: { content: [{ type: 'text', text: ENV_TEXT }] } }), true);
  assert.equal(cc.entryIsPeer({ type: 'user', message: { content: 'typed' } }), false);
  assert.equal(cc.entryIsPeer(null), false);
});

test('task notifications and pasted content', () => {
  assert.equal(cc.isTaskNotification('<task-notification>\n<task-id>x'), true);
  assert.equal(cc.isTaskNotification(' <task-notification>'), false);
  const p = '@room look\n\n<pasted_content id="1">\nline a\nline b\n</pasted_content id="1">\n';
  assert.deepEqual(cc.unwrapPasted(p), { text: '@room lookline a\nline b', normalized: true });
  assert.deepEqual(cc.unwrapPasted('plain'), { text: 'plain', normalized: false });
});

// ---------- jobs ----------

test('parseDispatch / JOB_RE', () => {
  assert.equal(cc.parseDispatch('backgrounded · 0b500131 · orch.ab12\n  claude agents   list sessions'), '0b500131');
  assert.equal(cc.parseDispatch('\u001b[0mbackgrounded · \u001b[36m0b500131'), null); // colour codes in the id: not parsed
  assert.equal(cc.parseDispatch('error: not trusted'), null);
  assert.equal(cc.parseDispatch(''), null);
});

const AGENTS = J([
  { id: 'e738dbef', cwd: '/r', kind: 'background', startedAt: 1, sessionId: 'e738dbef-93a2', name: 'old', state: 'failed' },
  { pid: 14474, id: '0a52ce26', cwd: '/r', kind: 'background', startedAt: 2, sessionId: '0a52ce26-6183', name: 'orch.ab12', status: 'busy', state: 'blocked' },
  { pid: 38545, cwd: '/r', kind: 'interactive', startedAt: 3, sessionId: '310228bc-3e3a', name: 'repos-4a', status: 'idle' },
]);

test('parseAgentsJson', () => {
  const js = cc.parseAgentsJson(AGENTS);
  assert.equal(js.length, 3);
  assert.deepEqual(js[0], { pid: null, id: 'e738dbef', sessionId: 'e738dbef-93a2', status: null, state: 'failed', kind: 'background', name: 'old', cwd: '/r', startedAt: 1 });
  assert.equal(js[1].pid, 14474);
  assert.equal(js[2].id, null);
  assert.equal(cc.parseAgentsJson('nope'), null);
  assert.equal(cc.parseAgentsJson('{}'), null);
});

test('jobs() runs agents --json through an injected runner', () => {
  const calls = [];
  const run = (bin, args) => { calls.push([bin, args]); return { status: 0, stdout: AGENTS }; };
  assert.equal(cc.jobs({ all: true, bin: 'cl', run }).length, 3);
  assert.deepEqual(calls[0], ['cl', ['agents', '--json', '--all']]);
  assert.equal(cc.jobs({ run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(cc.jobs({ run: () => ({ error: new Error('ENOENT') }) }), null);
  assert.equal(cc.jobs({ run: () => { throw new Error('x'); } }), null);
  assert.deepEqual(cc.stopCmd(7), ['stop', '7']);
  assert.deepEqual(cc.logsCmd('ab'), ['logs', 'ab']);
  assert.deepEqual(cc.agentsCmd(), ['agents', '--json']);
});

test('DAEMON_ENV_ALLOW and daemonEnv', () => {
  for (const k of ['PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_PLUGIN_DIRS',
    // added to the daemon's allowlist in 2.1.292
    'CLAUDE_CODE_CLIENT_DATA_URL', 'CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT', 'CLAUDE_CODE_DISABLE_PROACTIVITY', 'CLAUDE_CODE_AUTO_MODE_TIER', 'CLAUDE_BG_AUTO_MEMORY_OFF'])
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

// ---------- timeouts ----------

test('sessionEndBudgetMs', () => {
  assert.equal(cc.SESSION_END_DEFAULT_MS, 1500);
  assert.equal(cc.sessionEndBudgetMs([], {}), 1500);
  assert.equal(cc.sessionEndBudgetMs([1], {}), 1500);
  assert.equal(cc.sessionEndBudgetMs([5, 2], {}), 5000);
  assert.equal(cc.sessionEndBudgetMs([600], {}), 60000);
  assert.equal(cc.sessionEndBudgetMs([5], { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '9000' }), 9000);
  assert.equal(cc.HOOK_TIMEOUT_DEFAULT_MS, 600000);
});

// ---------- contract ----------

test('CONTRACT entries are well formed and unique', () => {
  const ids = new Set();
  for (const e of cc.CONTRACT) {
    assert.ok(e.id && !ids.has(e.id), e.id);
    ids.add(e.id);
    assert.ok(['API', 'env', 'incidental'].includes(e.stability), e.id);
    const s = Array.isArray(e.search) ? e.search : [e.search];
    assert.ok(s.length && s.every(x => typeof x === 'string' && x.length >= 8), e.id);
    const sh = e.shape === undefined ? [] : Array.isArray(e.shape) ? e.shape : [e.shape];
    // a shape keeps enough literal text to stay specific
    assert.ok(sh.every(x => typeof x === 'string' && x.replace(/~/g, '').length >= 16), e.id);
    assert.ok(e.note, e.id);
  }
  for (const id of ['task-completed-block-drops-fields', 'monitor-not-rearmed', 'subagent-statusline-precedence', 'daemon-env-allowlist', 'matcher-rule',
    'hooks-json-modules', 'classic-chain-order', 'prompt-submit-ups-order', 'session-append-notice-hidden', 'ui-log-notice', 'process-run-stdin', 'plugin-test-off', 'usermessage-notification-summary', 'plugin-types-state'])
    assert.ok(ids.has(id), id);
});

test('every @cc tag in lib/cc.js names a string some CONTRACT entry searches for', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cc.js'), 'utf8');
  const all = new Set(cc.CONTRACT.flatMap(e => (Array.isArray(e.search) ? e.search : [e.search])));
  const tags = [...src.matchAll(/^ \* @cc (.+)$/gm)].map(m => m[1]);
  assert.ok(tags.length > 20);
  // doc comments write \n literally where the binary has a newline in a template or \n in a regex
  for (const t of tags) assert.ok(all.has(t) || all.has(t + ' ') || all.has(t.replace(/\\n/g, '\n')), t);
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
  // "hooks/register.ts" is the built-in plugins' fixed path, not ours (MODS-PLAN W1: hooks/register.mjs).
  const hooks = path.join(__dirname, '..', 'hooks');
  const json = JSON.parse(fs.readFileSync(path.join(hooks, 'hooks.json'), 'utf8'));
  assert.deepEqual(json.modules, ['./register.mjs'], 'hooks.json names one hooks module per plugin');
  const named = json.modules.map(m => path.resolve(hooks, m));
  for (const m of named) assert.ok(fs.statSync(m).isFile(), `${m} exists`);
  const entries = fs.readdirSync(hooks).filter(f => /^register\.[cm]?[jt]sx?$/.test(f)).map(f => path.join(hooks, f));
  assert.deepEqual(entries, named);
});

// ---------- probe ----------

const probeRun = spawnSync(process.execPath, [PROBE, '--json'], { encoding: 'utf8', timeout: 60_000 });
const haveBinary = probeRun.status !== 2;

test('probe: the installed binary satisfies the contract', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const out = JSON.parse(probeRun.stdout);
  const failed = out.results.filter(r => !r.ok).map(r => `${r.id}: ${r.missing.join(' | ')}`);
  assert.deepEqual(failed, [], `claude ${out.version}`);
  assert.equal(probeRun.status, 0);
  assert.ok(out.ms < 15_000);
});

test('probe: a mutated search string fails', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const extra = J([{ id: 'mutated', search: 'Arm trigger. "always" arms at session start and on plugin reload!!x' }]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'monitor-schema'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['monitor-schema', true], ['mutated', false]]);
});

test('probe: a mutated shape fails', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const extra = J([{ id: 'shape-ok', search: 'Valid types are: approve, block', shape: 'case"block":~.permissionBehavior="deny"' },
    { id: 'shape-mutated', search: 'Valid types are: approve, block', shape: 'case"block":~.permissionBehavior="allow"' }]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'none'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['shape-ok', true], ['shape-mutated', false]]);
  assert.match(out.results[1].missing[0], /^shape: /);
});

test('probe: a mutated function-hooks entry fails (search and shape)', { skip: !haveBinary && 'no Claude Code binary found' }, () => {
  const by = id => cc.CONTRACT.find(e => e.id === id);
  const extra = J([
    { id: 'modules-search-mutated', search: by('hooks-json-modules').search[2] + '!!x' },
    { id: 'chain-shape-mutated', search: by('classic-chain-order').search, shape: by('classic-chain-order').shape.replace('function-hook chain', 'function-hooks chain') },
    { id: 'notice-level-mutated', search: by('session-append-notice-hidden').search[0], shape: by('session-append-notice-hidden').shape.replace('"info"', '"notice"') },
  ]);
  const r = spawnSync(process.execPath, [PROBE, '--json', '--only', 'hooks-json-modules,classic-chain-order,session-append-notice-hidden'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CC_PROBE_EXTRA: extra } });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map(x => [x.id, x.ok]), [['hooks-json-modules', true], ['classic-chain-order', true], ['session-append-notice-hidden', true],
    ['modules-search-mutated', false], ['chain-shape-mutated', false], ['notice-level-mutated', false]]);
});

test('probe: a bogus binary fails every entry', () => {
  const fake = path.join(tmp, 'claude-fake');
  fs.writeFileSync(fake, 'VERSION:"0.0.1" nothing here');
  const r = spawnSync(process.execPath, [PROBE, '--bin', fake], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude 0\.0\.1/);
  assert.match(r.stdout, /FAIL {2}matcher-rule/);
});
