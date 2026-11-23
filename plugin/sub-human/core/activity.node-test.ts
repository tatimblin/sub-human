import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from './activity.js';
import { capture, plansDir } from './activity.js';
import { bridgeOp, parseTag } from './tasks.js';
import { toolFixture } from '../test/support/fixtures.js';

// Every call here is a recorded one (test/fixtures/cc/2.1.330); where a case needs another value (a path, a command,
// a subagent's id) it changes that one field of the recorded call, never its shape.
const ctx = (c: Partial<Context> = {}): Context => ({ name: 'ann', root: '/work/project', now: 50, ...c });
const edit = toolFixture('tool-edit', 'Edit');
const write = toolFixture('tool-write', 'Write');
const planWrite = toolFixture('tool-write-2', 'Write');
const commit = toolFixture('tool-bash-git-commit', 'Bash');
const push = toolFixture('tool-bash-git-push', 'Bash');
const npmTest = toolFixture('tool-bash-test', 'Bash');
const failed = toolFixture('tool-bash-error', 'Bash');
const created = toolFixture('tool-task-create', 'TaskCreate');
const updates = ['tool-task-update-completed', 'tool-task-update-in-progress', 'tool-task-update-deleted'].map(n => toolFixture(n, 'TaskUpdate'));

test('an edit or write adds its repo-relative file to the activity document, once (R12)', () => {
  assert.deepEqual(capture(edit.input, edit.result, ctx()), { kind: 'doc', doc: { name: 'ann', files: ['notes.txt'], at: 50 } });
  assert.deepEqual(capture(write.input, write.result, ctx({ root: '/work/project/' })), { kind: 'doc', doc: { name: 'ann', files: ['notes.txt'], at: 50 } });
  const doc = { name: 'ann', files: ['src/a.ts'], at: 1 };
  assert.deepEqual(capture(planWrite.input, planWrite.result, ctx({ doc })),
    { kind: 'doc', doc: { name: 'ann', files: ['src/a.ts', '.plans/without-reading-any-file-staged-firefly-of-00000000-0000-4000-8000-000000000015.md'], at: 50 } });
  // coalesced: a file already in the document changes nothing
  assert.deepEqual(capture(edit.input, edit.result, ctx({ doc: { name: 'ann', files: ['notes.txt'], at: 1 } })), { kind: 'none' });
});

test('an edit outside the repo, of a secret file or of an ignored one is never shared (R14a)', () => {
  assert.deepEqual(capture(edit.input, edit.result, ctx({ root: '/work/other' })), { kind: 'none' });
  assert.deepEqual(capture(edit.input, edit.result, ctx({ root: '/work/proj' })), { kind: 'none' });
  for (const file of ['.env', 'config/.env.local', 'certs/server.pem', 'id_rsa']) {
    assert.deepEqual(capture({ ...edit.input, file_path: `/work/project/${file}` }, edit.result, ctx()), { kind: 'none' }, file);
  }
  assert.deepEqual(capture(planWrite.input, planWrite.result, ctx({ ignore: 'node_modules/\n.plans/\n' })), { kind: 'none' });
  assert.deepEqual(capture(edit.input, edit.result, ctx({ ignore: '*.txt' })), { kind: 'none' });
});

test('a plan file is no edit: in the session\'s plans directory or Claude Code\'s default one', () => {
  const exit = toolFixture('tool-exit-plan-mode', 'ExitPlanMode');
  const plans = plansDir(exit.result);
  assert.equal(plans, '/work/project/.plans');
  assert.deepEqual(capture(planWrite.input, planWrite.result, ctx({ ...(plans !== null && { plans }) })), { kind: 'none' });
  assert.deepEqual(capture({ ...write.input, file_path: '/work/project/.claude/plans/p.md' }, write.result, ctx()), { kind: 'none' });
  assert.deepEqual(capture(edit.input, edit.result, ctx({ plans: '/work/project/.plans/' })).kind, 'doc', 'other files still count');
  assert.equal(plansDir(edit.result), null);
});

test('a commit and a push are events from the Bash result\'s gitOperation (R12)', () => {
  assert.deepEqual(capture(commit.input, commit.result, ctx({ repo: 'project', branch: 'main' })), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'commit', text: 'committed 9b6afa1: add notes', repo: 'project', branch: 'master' }],
  });
  assert.deepEqual(capture(push.input, push.result, ctx()), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'push', text: 'pushed master', branch: 'master' }],
  });
});

test('a test or build run is an event with whether it passed; other commands are nothing (R12)', () => {
  assert.deepEqual(capture(npmTest.input, npmTest.result, ctx({ branch: 'paging' })), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'test', text: 'npm test', ok: true, branch: 'paging' }],
  });
  assert.deepEqual(capture({ ...failed.input, command: 'npm test' }, failed.result, ctx()), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'test', text: 'npm test', ok: false }],
  });
  assert.deepEqual(capture({ ...npmTest.input, command: 'npm run build' }, npmTest.result, ctx()), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'build', text: 'npm run build', ok: true }],
  });
  assert.deepEqual(capture(failed.input, failed.result, ctx()), { kind: 'none' });
  assert.deepEqual(capture({ ...npmTest.input, command: 'ls -la' }, npmTest.result, ctx()), { kind: 'none' });
});

test('an event whose text holds a secret is dropped; its text is one clean line', () => {
  const command = 'API_TOKEN=Zx81kQ0pLm3n7Rt5vW9yB2cD npm test';
  assert.deepEqual(capture({ ...npmTest.input, command }, npmTest.result, ctx()), { kind: 'none' });
  // only the raw text matches: cleaning joins the env line onto the command, so its line start is gone
  assert.deepEqual(capture({ ...npmTest.input, command: 'npm test\nAPI_KEY=Zx81kQ0pLm3n7Rt5vW9yB2cD' }, npmTest.result, ctx()), { kind: 'none' });
  const r = capture({ ...npmTest.input, command: 'npm test\n  \u001b[1m--watch=false\u001b[0m' }, npmTest.result, ctx());
  assert.ok(r.kind === 'events' && r.events[0]?.text === 'npm test --watch=false');
});

test('a personal task change is an event; a room task (tagged) is the bridge\'s, never activity (R23)', () => {
  assert.deepEqual(capture(created.input, created.result, ctx()), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'task', text: 'added task: demo task' }],
  });
  assert.deepEqual(capture({ ...created.input, subject: '[room vole-8126#3] paging' }, created.result, ctx()), { kind: 'none' });
  const [completed, started, deleted] = updates;
  assert.ok(completed && started && deleted);
  const subjects = new Map([['1', 'demo task']]);
  assert.deepEqual(capture(completed.input, completed.result, ctx({ subjects })), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'task', text: 'completed task: demo task' }],
  });
  assert.deepEqual(capture(started.input, started.result, ctx({ subjects })), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'task', text: 'started task: demo task' }],
  });
  assert.deepEqual(capture(deleted.input, deleted.result, ctx()), {
    kind: 'events', events: [{ kind: 'activity', from: 'ann', by: 'claude', event: 'task', text: 'deleted task: #1' }],
  });
});

test('the classifier agrees with tasks.ts bridgeOp on every recorded update, tagged or not', () => {
  for (const u of updates) {
    for (const subject of ['demo task', '[room vole-8126#3] demo task']) {
      const r = u.result.isError ? null : u.result.result;
      const change = r && 'statusChange' in r ? r.statusChange : undefined;
      const op = bridgeOp(change, parseTag(subject));
      const got = capture(u.input, u.result, ctx({ subjects: new Map([['1', subject]]) }));
      assert.equal(got.kind === 'events', op.kind === 'activity', `${u.input.status ?? ''} ${subject}`);
    }
  }
});

test('a subagent\'s call is the same member\'s activity (R16a)', () => {
  for (const f of [edit, commit, npmTest]) {
    assert.deepEqual(capture({ ...f.input, agentId: 'a1b2c3' }, f.result, ctx()), capture(f.input, f.result, ctx()));
  }
});

test('other tools and malformed calls are nothing', () => {
  const send = toolFixture('tool-send-message', 'SendMessage');
  const plan = toolFixture('tool-exit-plan-mode', 'ExitPlanMode');
  assert.deepEqual(capture(send.input, send.result, ctx()), { kind: 'none' });
  assert.deepEqual(capture(plan.input, plan.result, ctx()), { kind: 'none' });
  assert.deepEqual(capture(null, edit.result, ctx()), { kind: 'none' });
  assert.deepEqual(capture(edit.input, 'done', ctx()), { kind: 'none' });
  assert.deepEqual(capture({ tool: 'Edit' }, edit.result, ctx()), { kind: 'none' });
});
