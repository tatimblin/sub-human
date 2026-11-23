import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_MS } from '../core/api.js';
import { runCommand } from './index.js';
import { fakeHome } from '../test/support/fake-daemon.js';
import type { FakeHome } from '../test/support/fake-daemon.js';
import { GIT_ALICE, testCtx } from '../test/support/command-ctx.js';
import { must } from '../test/support/must.js';

const BOB = { ...GIT_ALICE, 'git config --get user.name': 'Bob' };

/** `name` a member of room `code`, made now, and here or away on this machine. */
async function seed(fake: FakeHome, code: string, name: string, state: 'idle' | 'away' = 'idle'): Promise<void> {
  await fake.host(code, [{ kind: 'joined', from: name, by: 'system' }]);
  const r = await fake.daemon.putDoc(code, { kind: 'presence', doc: { name, state, at: 1 } });
  assert.ok(r.ok);
}

test('a bare /sub-human with no room open opens one, as the git name, with repo and branch', async () => {
  const fake = fakeHome();
  const ctx = testCtx(fake);
  const a = await runCommand('', ctx);
  const code = await fake.code();
  assert.match(code, /^[a-z]+-\d{4}$/);
  assert.deepEqual(a, { kind: 'say', text: `You opened room ${code} as alice. /sub-human invite brings someone from another machine.` });
  const s = await fake.rooms.state(code);
  assert.ok(s.ok);
  assert.deepEqual(s.value.members.map(m => [m.name, m.repo, m.branch, m.machines]), [['alice', 'api', 'main', ['laptop']]]);
  const p = must(await ctx.sessions.get('session-1'), 'the pointer');
  assert.deepEqual({ ...p, leave: '' }, { id: 'session-1', code, name: 'alice', title: `alice.${code}`, leave: '' });
  assert.match(p.leave, /^[0-9a-f-]{36}$/);
});

test('a second session as a name already here joins with no second joined, and the lowest free title (R5)', async () => {
  const fake = fakeHome();
  await runCommand('', testCtx(fake));
  const code = await fake.code();
  const bob = await runCommand('', testCtx(fake, { session: 'session-2', run: BOB }));
  assert.equal(bob.text, `You're in ${code} as bob, with alice.`);
  const again = testCtx(fake, { session: 'session-3' });
  assert.equal((await runCommand('', again)).text, `You're in ${code} as alice, with bob.`);
  assert.equal((await again.sessions.get('session-3'))?.title, `alice-2.${code}`);
  assert.deepEqual(await fake.kinds(code), ['joined', 'joined']);
  // the first leaves (session-3 still holds the name, so no left): its title is free again for the next session
  await runCommand('leave', testCtx(fake));
  const fourth = testCtx(fake, { session: 'session-4' });
  await runCommand('', fourth);
  assert.equal((await fourth.sessions.get('session-4'))?.title, `alice.${code}`);
  assert.equal((await again.sessions.get('session-3'))?.title, `alice-2.${code}`);
  assert.deepEqual(await fake.kinds(code), ['joined', 'joined']);
});

test('probe B: two sessions that never pinged hold their titles; a third join takes the next, and one joined in all', async () => {
  const fake = fakeHome();
  await runCommand('', testCtx(fake));
  const code = await fake.code();
  await runCommand('', testCtx(fake, { session: 'session-2' }));
  fake.now += 10 * 60_000;
  const third = testCtx(fake, { session: 'session-3' });
  await runCommand('', third);
  assert.equal((await third.sessions.get('session-3'))?.title, `alice-3.${code}`);
  assert.deepEqual(await fake.kinds(code), ['joined']);
});

test('a quiet session\'s title is never reissued: liveness only decides presence', async () => {
  const fake = fakeHome();
  await runCommand('', testCtx(fake));
  const code = await fake.code();
  await fake.ping('session-1');
  fake.now += 10 * LIVE_MS;
  const next = testCtx(fake, { session: 'session-2' });
  await runCommand('', next);
  assert.equal((await next.sessions.get('session-2'))?.title, `alice-2.${code}`);
  assert.equal((await next.sessions.get('session-1'))?.title, `alice.${code}`);
  assert.deepEqual(await fake.kinds(code), ['joined']);
});

test('probe E: two joins at once as one name post one joined and take two titles', async () => {
  const fake = fakeHome();
  await runCommand('', testCtx(fake));
  const code = await fake.code();
  await runCommand('leave', testCtx(fake));
  const [x, y] = [testCtx(fake, { session: 's-x' }), testCtx(fake, { session: 's-y' })];
  await Promise.all([runCommand(code, x), runCommand(code, y)]);
  assert.deepEqual(await fake.kinds(code), ['joined', 'left', 'joined']);
  const titles = [(await x.sessions.get('s-x'))?.title, (await y.sessions.get('s-y'))?.title].sort();
  assert.deepEqual(titles, [`alice-2.${code}`, `alice.${code}`]);
});

test('two first opens at once make one room', async () => {
  const fake = fakeHome();
  const [a, b] = [testCtx(fake), testCtx(fake, { session: 'session-2', run: BOB })];
  const answers = await Promise.all([runCommand('', a), runCommand('', b)]);
  assert.equal((await fake.rooms.codes()).length, 1);
  const code = await fake.code();
  assert.deepEqual(answers.map(x => x.text).sort(), [
    `You opened room ${code} as alice. /sub-human invite brings someone from another machine.`, `You're in ${code} as bob, with alice.`,
  ].sort());
});

test('the room this cwd last used comes first while the person is a member, even with another room open', async () => {
  const fake = fakeHome();
  const first = testCtx(fake);
  await runCommand('', first);
  const mine = await fake.code();
  await fake.daemon.retire('session-1'); // the session ended: alice is away, and still a member
  await seed(fake, 'zebra-0002', 'bob');
  const back = testCtx(fake, { session: 'session-2' });
  assert.equal((await runCommand('', back)).text, `You're in ${mine} as alice.`);
  await fake.daemon.retire('session-2');
  // from another cwd, the one open room
  const elsewhere = testCtx(fake, { session: 'session-3', cwd: '/work/web' });
  assert.equal((await runCommand('', elsewhere)).text, 'You\'re in zebra-0002 as alice, with bob.');
});

test('a cwd\'s last room is passed over once the person has left it', async () => {
  const fake = fakeHome();
  const first = testCtx(fake);
  await runCommand('', first);
  const mine = await fake.code();
  await runCommand('leave', first);
  await seed(fake, 'zebra-0002', 'bob');
  assert.equal((await runCommand('', testCtx(fake, { session: 'session-2' }))).text, 'You\'re in zebra-0002 as alice, with bob.');
  assert.notEqual(mine, 'zebra-0002');
});

test('a name ending in -digits is refused in one line, as a title would read', async () => {
  const fake = fakeHome();
  assert.deepEqual(await runCommand('alice-2', testCtx(fake)), {
    kind: 'refused', text: 'Nobody joined: alice-2 can\'t be a name (one lowercase word, not a verb, not ending in -digits). Type /sub-human NAME.',
  });
  assert.deepEqual(fake.calls, []);
});

test('NAME and ROOM may be given, in either order', async () => {
  const fake = fakeHome();
  await runCommand('', testCtx(fake));
  const code = await fake.code();
  assert.equal((await runCommand(`${code} Carol`, testCtx(fake, { session: 's2' }))).text, `You're in ${code} as carol, with alice.`);
  assert.equal((await runCommand('dave', testCtx(fake, { session: 's3', cwd: '/work/web' }))).text, `You're in ${code} as dave, with alice, carol.`);
});

test('a session already in a room says so, and joins no other', async () => {
  const fake = fakeHome();
  const ctx = testCtx(fake);
  await runCommand('', ctx);
  const code = await fake.code();
  assert.equal((await runCommand('', ctx)).text, `You're already in ${code} as alice.`);
  assert.equal((await runCommand('alice', ctx)).kind, 'say');
  const other = await runCommand('bob', ctx);
  assert.deepEqual(other, { kind: 'refused', text: `This session is in ${code} as alice, so it joined no other. Type /sub-human leave first.` });
  assert.deepEqual(fake.calls, ['join session-1 alice']);
});

test('with several rooms open it lists them and joins none', async () => {
  const fake = fakeHome();
  await seed(fake, 'vole-0001', 'x');
  await seed(fake, 'wren-0002', 'y');
  const ctx = testCtx(fake);
  assert.equal((await runCommand('', ctx)).text, 'Rooms open here: vole-0001, wren-0002. Type /sub-human ROOM to join one.');
  assert.equal(await ctx.sessions.get('session-1'), null);
  assert.equal((await runCommand('wren-0002', ctx)).text, 'You\'re in wren-0002 as alice, with y.');
});

test('a room whose every member is away, or who left, is not open: a bare join opens a new one', async () => {
  const fake = fakeHome();
  await seed(fake, 'vole-0001', 'x', 'away');
  await seed(fake, 'wren-0002', 'y');
  await fake.host('wren-0002', [{ kind: 'left', from: 'y', by: 'system' }]);
  assert.match((await runCommand('', testCtx(fake))).text, /^You opened room /);
  assert.equal((await fake.rooms.codes()).length, 3);
});

test('refusals: an unknown room, no name, a bad name, two names, a kicked name', async () => {
  const fake = fakeHome();
  assert.deepEqual(await runCommand('mole-1234', testCtx(fake)),
    { kind: 'refused', text: 'Nobody joined: there is no room mole-1234 on this machine. Type /sub-human to open one.' });
  assert.equal((await runCommand('', testCtx(fake, { run: {} }))).text, 'Nobody joined: there is no git name to join as. Type /sub-human NAME.');
  assert.match((await runCommand('room', testCtx(fake))).text, /^Nobody joined: room can't be a name/);
  assert.match((await runCommand('ann bea', testCtx(fake))).text, /^ann bea is not one name/);
  await seed(fake, 'vole-0001', 'x');
  await fake.daemon.kick('vole-0001', 'mallory', 'x');
  assert.equal((await runCommand('vole-0001 mallory', testCtx(fake))).text, 'Nobody joined: mallory was removed from vole-0001.');
  assert.deepEqual(await fake.kinds('vole-0001'), ['joined', 'kick']);
});

test('the name comes from SUB_HUMAN_NAME, else git user.name, else the local part of user.email', async () => {
  const fake = fakeHome();
  const named = testCtx(fake, { env: { SUB_HUMAN_NAME: 'Zoë' } });
  assert.match((await runCommand('', named)).text, / as zoe\./);
  const email = testCtx(fake, { session: 's2', cwd: '/work/web', run: { 'git config --get user.email': 'quinn.x@example.com' } });
  assert.match((await runCommand('', email)).text, / as quinnx, with zoe\./);
});

test('when the daemon refuses, nobody joined and no session file is written', async () => {
  const fake = fakeHome();
  fake.down = 'sub-human\'s daemon did not start; nothing was done';
  const ctx = testCtx(fake);
  assert.deepEqual(await runCommand('', ctx), { kind: 'refused', text: 'Nobody joined: sub-human\'s daemon did not start; nothing was done' });
  assert.equal(await ctx.sessions.get('session-1'), null);
  assert.deepEqual(await fake.rooms.codes(), []);
});
