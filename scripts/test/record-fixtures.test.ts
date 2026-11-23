// scripts/record-fixtures.ts scrubs and names what it records; plugin/sub-human/test/support/fixtures.ts loads the
// committed fixtures by name, typed.
// The scripts project leaves out the built-in tools' typings the plugin project holds; the typed loads below need them.
/// <reference path="../../typings/claude-code-tools/index.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubber, nameFor, answer, leftovers, mergeIndex, lastFake, encodePath, FIXTURES, GAPS, type Fixture } from '../record-fixtures.ts';
import {
  CC_VERSION, fixtureIndex, hookFixture, promptFixture, sendFixture, toolFixture, toolListFixture, turnFixture,
} from '../../plugin/sub-human/test/support/fixtures.ts';

test('scrubber: home and work paths, in both spellings, become stand-ins, longest first', () => {
  const scrub = scrubber([['/Users/ada/tmp/rec-1/project', '/work/project'], ['/Users/ada', '/home/user']], 'ada');
  const text = JSON.stringify({
    cwd: '/Users/ada/tmp/rec-1/project',
    transcript: '/Users/ada/.claude/projects/-Users-ada-tmp-rec-1-project/x.jsonl',
    note: 'by ada, not adam',
  });
  const out = scrub(text);
  assert.ok(!out.includes('/Users/ada') && !out.includes('-Users-ada'), out);
  assert.match(out, /"cwd":"\/work\/project"/);
  assert.match(out, /\/home\/user\/\.claude\/projects\/-work-project\/x\.jsonl/);
  assert.match(out, /by user, not adam/);
});

test('scrubber: session and tool_use ids become stable fakes across calls; emails and tokens placeholders', () => {
  const scrub = scrubber([], 'nobody-here');
  const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
  const a = scrub(`{"session_id":"${id}","tool_use_id":"toolu_01AbC","p":"toolu_plugin_a8f7"}`);
  const b = scrub(`{"again":"${id.toLowerCase()}","other":"0e2d4c8a-1111-4222-8333-944455556666"}`);
  assert.equal(a, '{"session_id":"00000000-0000-4000-8000-000000000001","tool_use_id":"toolu_fake0002","p":"toolu_fake0003"}');
  assert.equal(b, '{"again":"00000000-0000-4000-8000-000000000001","other":"00000000-0000-4000-8000-000000000004"}');
  assert.equal(scrubber([], 'x', 7)('"a3bb189e-8bf9-4888-9912-ace4e6543002"'), '"00000000-0000-4000-8000-000000000008"', 'numbered after 7');
  assert.equal(lastFake('"00000000-0000-4000-8000-000000000019" toolu_fake0024 toolu_fake0003'), 24);
  assert.equal(lastFake('{}'), 0);
  assert.equal(scrub('mail ada@corp.io key sk-ant-oat01-xyz_1 gh ghp_abc123'), 'mail user@example.com key <token> gh <token>');
});

test('nameFor: Bash by what it did; TaskUpdate by status; a plugin send apart from the model', () => {
  const bash = (command: string, result: unknown): string => nameFor('tool.call', { tool: 'Bash', command }, result);
  assert.equal(bash('git commit -m x', { result: { gitOperation: { commit: { sha: 'a' } } } }), 'tool-bash-git-commit');
  assert.equal(bash('git push', { result: { gitOperation: { push: { branch: 'm' } } } }), 'tool-bash-git-push');
  assert.equal(bash('ls nope', { result: 'Error', isError: true }), 'tool-bash-error');
  assert.equal(bash('npm test', { result: { stdout: '' } }), 'tool-bash-test');
  assert.equal(nameFor('tool.call', { tool: 'TaskUpdate', status: 'in_progress' }, {}), 'tool-task-update-in-progress');
  assert.equal(nameFor('tool.call', { tool: 'SendMessage', tool_use_id: 'toolu_plugin_1' }, {}), 'tool-send-message-plugin');
  assert.equal(nameFor('tool.call', { tool: 'ExitPlanMode' }, { deny: 'no' }), 'tool-exit-plan-mode-deny');
  assert.equal(nameFor('session.send', { origin: { kind: 'model' } }, {}), 'session-send-model');
  assert.equal(nameFor('turn.complete', {}, {}), 'turn-complete');
});

test('answer: a plan approved, a question given its first option, anything else refused', () => {
  assert.deepEqual(answer('ExitPlanMode', { plan: 'p' }), { behavior: 'allow', updatedInput: { plan: 'p' } });
  const q = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
  assert.deepEqual(answer('AskUserQuestion', q), { behavior: 'allow', updatedInput: { ...q, answers: { 'Which?': 'A' } } });
  assert.equal(answer('Bash', { command: 'rm -rf /' }).behavior, 'deny');
});

test('leftovers: the session ids\' tasks and env, the list id\'s tasks, the encoded project, the plugin\'s data; all under the config', () => {
  const config = '/h/cfg';
  const got = leftovers(config, '/private/var/T/sh-rec-Ab1/project', ['11111111-2222-4333-8444-555555555555'], 'sh-rec-Ab1', 'rec-0a1b2c3d');
  assert.deepEqual(got, [
    '/h/cfg/tasks/11111111-2222-4333-8444-555555555555',
    '/h/cfg/session-env/11111111-2222-4333-8444-555555555555',
    '/h/cfg/tasks/sh-rec-Ab1',
    '/h/cfg/projects/-private-var-T-sh-rec-Ab1-project',
    '/h/cfg/plugins/data/rec-0a1b2c3d-inline',
  ]);
  assert.ok(got.every(p => p.startsWith(`${config}/`) && p.length > config.length + 6), 'never the config dir itself');
  assert.equal(encodePath('/a/b.c_d'), '-a-b-c-d');
});

test('mergeIndex: a re-recorded session replaces its own entries only; every run\'s cost is kept and summed', () => {
  const f = (name: string, session: string): Fixture => ({ name, event: 'tool.call', session, input: { tool: 'Bash' } });
  const first = mergeIndex(null, '9.9.9', { date: 'd1', sessions: ['a', 'b'], costUsd: 0.2 }, [f('x', 'a'), f('y', 'b')]).index;
  assert.deepEqual(first.fixtures.x, { event: 'tool.call', session: 'a', tool: 'Bash' });
  const { index, dropped } = mergeIndex(first, '9.9.9', { date: 'd2', sessions: ['b'], costUsd: 0.05 }, [f('z', 'b')]);
  assert.deepEqual(Object.keys(index.fixtures), ['x', 'z']);
  assert.deepEqual(dropped, ['y']);
  assert.deepEqual(index.runs.map(r => r.costUsd), [0.2, 0.05]);
  assert.equal(index.costUsd, 0.25);
  assert.deepEqual(index.gaps, GAPS);
});

test('the committed fixtures: every one listed loads, and none holds this machine\'s home, user, host or temp dir', () => {
  const dir = path.join(FIXTURES, CC_VERSION);
  const index = fixtureIndex();
  assert.equal(index.version, CC_VERSION);
  const files = fs.readdirSync(dir).filter(f => f !== 'index.json').map(f => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(Object.keys(index.fixtures).sort(), files);
  assert.equal(index.costUsd, Number(index.runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)), 'the total is every run\'s');
  assert.ok(index.gaps.some(g => /Notification/.test(g)) && index.gaps.some(g => /session\.send/.test(g)));
  const home = os.homedir(), user = path.basename(home), host = os.hostname().split('.')[0] ?? '';
  const tmps = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const p of [home, ...tmps]) assert.ok(!text.includes(p) && !text.includes(encodePath(p)), `${f} holds ${p}`);
    assert.ok(host.length < 3 || !text.toLowerCase().includes(host.toLowerCase()), `${f} holds the host name`);
    assert.ok(user.length < 3 || !new RegExp(`\\b${user}\\b`).test(text), `${f} holds the user name`);
  }
});

test('the committed fixtures carry the shapes the design relies on (ARCHITECTURE §7, §9)', () => {
  const edit = toolFixture('tool-edit', 'Edit');
  assert.ok(!edit.result.isError && edit.result.result && 'filePath' in edit.result.result);
  const write = toolFixture('tool-write', 'Write');
  assert.ok(!write.result.isError && write.result.result && 'filePath' in write.result.result);
  const commit = toolFixture('tool-bash-git-commit', 'Bash').result;
  assert.ok(!commit.isError && commit.result?.gitOperation?.commit?.kind === 'committed');
  const push = toolFixture('tool-bash-git-push', 'Bash').result;
  assert.ok(!push.isError && push.result?.gitOperation?.push?.branch === 'master');
  const deleted = toolFixture('tool-task-update-deleted', 'TaskUpdate').result;
  assert.ok(!deleted.isError && deleted.result?.statusChange?.to === 'deleted');
  assert.equal(toolFixture('tool-bash-error', 'Bash').result.isError, true);
  assert.match(toolFixture('tool-bash-test', 'Bash').input.command, /npm test/);
  const created = toolFixture('tool-task-create', 'TaskCreate').result;
  assert.ok(!created.isError && created.result?.task.subject === 'demo task');
  const done = toolFixture('tool-task-update-completed', 'TaskUpdate').result;
  assert.ok(!done.isError && done.result?.statusChange?.to === 'completed');
  const plan = toolFixture('tool-exit-plan-mode', 'ExitPlanMode').result;
  assert.ok(!plan.isError && plan.result && 'plan' in plan.result && 'filePath' in plan.result);
  const asked = toolFixture('tool-ask-user-question', 'AskUserQuestion').result;
  assert.ok(!asked.isError && asked.result && 'answers' in asked.result);
  assert.equal(sendFixture('session-send-model').input.origin.kind, 'model');
  assert.equal(sendFixture('session-send-plugin').result.isDelivered, false);
  assert.equal(turnFixture('turn-complete-steps').input.isAborted, false);
  assert.equal(promptFixture('prompt-submit-steps').input.text, '/rec:steps');
  assert.ok(toolListFixture('tool-list-steps').some(t => t.name === 'TaskCreate'));
  assert.equal(hookFixture('hook-session-start-steps', 'SessionStart').source, 'startup');
  assert.equal(hookFixture('hook-user-prompt-expansion-steps', 'UserPromptExpansion').command_name, 'rec:steps');
  assert.throws(() => toolFixture('tool-edit', 'Write'), /not a Write call/);
  const moved = (n: string): string => fs.readFileSync(path.join(FIXTURES, CC_VERSION, `${n}.json`), 'utf8').replaceAll('"filePath"', '"elsewhere"');
  assert.throws(() => toolFixture('tool-edit', 'Edit', moved), /not a Edit result with filePath/);
});
