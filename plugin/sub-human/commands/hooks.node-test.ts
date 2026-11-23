// The command hooks on recorded stdin (test/fixtures/cc/2.1.330, and test/fixtures/hooks for what -p can't record),
// in-process over the fake daemon; cli.node-test.ts runs them through hooks/node.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HOOKS, isHook } from './hooks.js';
import type { MakeCtx } from './hooks.js';
import { hookFixture } from '../test/support/fixtures.js';
import { fakeHome } from '../test/support/fake-daemon.js';
import { testCtx } from '../test/support/command-ctx.js';
import { HANDOFF_MS } from '../core/api.js';

const SID = '00000000-0000-4000-8000-000000000001';
const expansion = (args: string) => ({
  ...hookFixture('hook-user-prompt-expansion-steps', 'UserPromptExpansion'), command_name: 'sub-human', command_args: args, prompt: `/sub-human ${args}`,
});
const notification = hookFixture('notification-permission-prompt', 'Notification',
  name => fs.readFileSync(new URL(`../test/fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));

function setup() {
  const fake = fakeHome();
  const ctx: MakeCtx = (session, cwd) => testCtx(fake, { session, cwd });
  return { fake, ctx };
}

test('the /sub-human expansion blocks with the answer as one line for the person (R43)', async () => {
  const { fake, ctx } = setup();
  const r = await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  assert.deepEqual(r, {
    out: {
      decision: 'block', reason: `sub-human: You opened room ${code} as alice. /sub-human invite brings someone from another machine.`,
      hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true },
    },
    exit: 0,
  });
  const help = await HOOKS.expand(expansion('help'), ctx);
  assert.match(JSON.stringify(help.out), /sub-human: \/sub-human \[NAME\]/);
});

test('SessionStart gives a session in a room its NAME.CODE title, and says nothing otherwise', async () => {
  const { fake, ctx } = setup();
  const start = hookFixture('hook-session-start-steps', 'SessionStart');
  assert.deepEqual(await HOOKS.start(start, ctx), { exit: 0 });
  await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  assert.deepEqual(await HOOKS.start(start, ctx), { out: { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `alice.${code}` } }, exit: 0 });
  // a second session here as alice gets the title its join gave it, kept in its pointer (R5)
  const later = `${SID}-2`;
  await HOOKS.expand({ ...expansion(''), session_id: later }, ctx);
  assert.deepEqual(await HOOKS.start({ ...start, session_id: later }, ctx),
    { out: { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `alice-2.${code}` } }, exit: 0 });
});

test('a permission prompt marks the member waiting; no room, or another notification, writes nothing', async () => {
  const { fake, ctx } = setup();
  assert.deepEqual(await HOOKS.notify(notification, ctx), { exit: 0 });
  await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  assert.deepEqual(await HOOKS.notify({ ...notification, notification_type: 'idle_prompt' }, ctx), { exit: 0 });
  assert.deepEqual(await HOOKS.notify(notification, ctx), { exit: 0 });
  assert.deepEqual(await fake.presence(code, 'alice'), { name: 'alice', state: 'working', waiting: true, at: 5_000, machine: 'laptop' });
  fake.down = 'sub-human\'s daemon did not answer; nothing was done';
  assert.deepEqual(await HOOKS.notify(notification, ctx), { err: `sub-human: alice isn't shown as waiting in ${code}: sub-human's daemon did not answer; nothing was done`, exit: 1 });
});

test('SessionEnd posts no left: the pointer goes and the member is away; a session in no room writes nothing (R3)', async () => {
  const { fake, ctx } = setup();
  const end = hookFixture('hook-session-end-steps', 'SessionEnd');
  assert.deepEqual(await HOOKS.end(end, ctx), { exit: 0 });
  assert.deepEqual(fake.calls, []);
  await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  fake.down = 'sub-human\'s daemon did not answer; nothing was done';
  assert.equal((await HOOKS.end(end, ctx)).exit, 1);
  fake.down = null;
  assert.deepEqual(await HOOKS.end(end, ctx), { exit: 0 });
  assert.equal(await testCtx(fake, { session: SID }).sessions.get(SID), null);
  assert.deepEqual(await fake.kinds(code), ['joined']);
  assert.equal((await fake.presence(code, 'alice'))?.state, 'away');
  // coming back posts no second joined
  await HOOKS.expand({ ...expansion(''), session_id: 'back' }, ctx);
  assert.deepEqual(await fake.kinds(code), ['joined']);
});

test('/clear and /resume hand the room on: no left, and the next session in the cwd takes it with its title', async () => {
  for (const reason of ['clear', 'resume'] as const) {
    const { fake, ctx } = setup();
    const end = { ...hookFixture('hook-session-end-steps', 'SessionEnd'), reason };
    const start = { ...hookFixture('hook-session-start-steps', 'SessionStart'), source: reason, session_id: 'next-session' };
    await HOOKS.expand(expansion(''), ctx);
    const code = await fake.code();
    assert.deepEqual(await HOOKS.end(end, ctx), { exit: 0 });
    assert.ok(!(await fake.lines(code)).some(l => l.includes('"kind":"left"')), `no left on ${reason}`);
    assert.equal(await ctx(SID, '/work/project').sessions.get(SID), null);
    assert.deepEqual(await HOOKS.start({ ...start, cwd: '/elsewhere' }, ctx), { exit: 0 }, 'another cwd takes nothing');
    assert.deepEqual(await HOOKS.start(start, ctx), { out: { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `alice.${code}` } }, exit: 0 });
    assert.equal((await ctx('next-session', '/work/project').sessions.get('next-session'))?.code, code);
  }
});

test('a handoff not taken within HANDOFF_MS is gone, its member away, and a startup never claims one', async () => {
  const { fake, ctx } = setup();
  await HOOKS.expand(expansion(''), ctx);
  await HOOKS.end({ ...hookFixture('hook-session-end-steps', 'SessionEnd'), reason: 'clear' }, ctx);
  const start = hookFixture('hook-session-start-steps', 'SessionStart');
  assert.deepEqual(await HOOKS.start({ ...start, session_id: 'fresh' }, ctx), { exit: 0 }, 'source startup');
  fake.now += HANDOFF_MS + 1;
  assert.deepEqual(await HOOKS.start({ ...start, source: 'clear', session_id: 'late' }, ctx), { exit: 0 });
  const code = await fake.code();
  assert.deepEqual(await fake.kinds(code), ['joined']);
  assert.equal((await fake.presence(code, 'alice'))?.state, 'away');
});

test('probe D: a stale handoff, then a join elsewhere: the sweep marks its member away, and no stray left', async () => {
  const { fake, ctx } = setup();
  await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  await HOOKS.end({ ...hookFixture('hook-session-end-steps', 'SessionEnd'), reason: 'clear' }, ctx);
  fake.now += HANDOFF_MS + 1;
  await HOOKS.expand({ ...expansion('bob'), session_id: 'bob-session', cwd: '/work/web' }, ctx);
  assert.deepEqual(await fake.kinds(code), ['joined', 'joined']);
  assert.equal((await fake.presence(code, 'alice'))?.state, 'away');
});

test('probe C: a compact 61 s after the last ping keeps the session in its room, with its title and no left', async () => {
  const { fake, ctx } = setup();
  await HOOKS.expand(expansion(''), ctx);
  const code = await fake.code();
  await fake.ping(SID);
  fake.now += 61_000;
  const start = { ...hookFixture('hook-session-start-steps', 'SessionStart'), source: 'compact' };
  assert.deepEqual(await HOOKS.start(start, ctx), { out: { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `alice.${code}` } }, exit: 0 });
  assert.deepEqual(await fake.kinds(code), ['joined']);
});

test('no SessionEnd reason posts a left: only /sub-human leave does', async () => {
  for (const reason of ['logout', 'prompt_input_exit', 'other', 'clear', 'resume'] as const) {
    const { fake, ctx } = setup();
    await HOOKS.expand(expansion(''), ctx);
    await HOOKS.end({ ...hookFixture('hook-session-end-steps', 'SessionEnd'), reason }, ctx);
    assert.deepEqual(await fake.kinds(await fake.code()), ['joined'], reason);
  }
});

test('a payload that is not the hook\'s answers nothing and builds no context', async () => {
  const never: MakeCtx = () => { throw new Error('built a context'); };
  for (const bad of [null, 'x', {}, { session_id: '', cwd: '/' }, { session_id: 's' }]) {
    for (const h of ['expand', 'start', 'notify', 'end'] as const) assert.deepEqual(await HOOKS[h](bad, never), { exit: 0 });
  }
  assert.equal(isHook('expand'), true);
  assert.equal(isHook('toString'), false);
  assert.equal(isHook(undefined), false);
});
