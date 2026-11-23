import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sessionFile } from '../core/api.js';
import { runCommand } from './index.js';
import { nodeRuns } from './doctor.js';
import type { Ctx } from './types.js';
import { fakeHome } from '../test/support/fake-daemon.js';
import type { FakeHome } from '../test/support/fake-daemon.js';
import { GIT_ALICE, testCtx } from '../test/support/command-ctx.js';
import { must } from '../test/support/must.js';

/** alice in a new room, and bob beside her in a second session; the room's code. */
async function room(): Promise<{ fake: FakeHome; alice: Ctx; bob: Ctx; code: string }> {
  const fake = fakeHome();
  const alice = testCtx(fake);
  const bob = testCtx(fake, { session: 'session-2', run: { ...GIT_ALICE, 'git config --get user.name': 'bob' } });
  await runCommand('', alice);
  await runCommand('', bob);
  return { fake, alice, bob, code: await fake.code() };
}

test('who lists the members here, their machines, state, focus and where they work (R4, R14)', async () => {
  const { fake, alice, code } = await room();
  await fake.daemon.putDoc(code, { kind: 'focus', doc: { name: 'bob', text: 'paging handler', repo: 'web', branch: 'paging', at: 1 } });
  await fake.daemon.putDoc(code, { kind: 'presence', doc: { name: 'alice', state: 'working', at: 1 } });
  await fake.daemon.putDoc(code, { kind: 'presence', doc: { name: 'bob', state: 'working', waiting: true, at: 1 } });
  assert.deepEqual(await runCommand('who', alice), { kind: 'say', text: [
    `${code} · 2 here`,
    'alice (you) · laptop · working · api on main',
    'bob · laptop · waiting on a permission prompt · paging handler · web on paging',
  ].join('\n') });
});

test('a member is here on each machine whose presence isn\'t away, and nowhere once all are: still a member', async () => {
  const { fake, alice, bob, code } = await room();
  const store = await fake.store(code);
  await store.putDoc('presence', 'alice@desk', { name: 'alice', state: 'working', machine: 'desk', at: 2 });
  const line = async () => (await runCommand('who', bob)).text.split('\n').find(l => l.startsWith('alice'));
  assert.match(must(await line(), 'alice'), /^alice · desk, laptop · /);
  await fake.daemon.retire(alice.session);
  assert.match(must(await line(), 'alice'), /^alice · desk · /);
  await store.putDoc('presence', 'alice@desk', { name: 'alice', state: 'away', machine: 'desk', at: 3 });
  assert.equal(await line(), undefined, 'away everywhere: not here');
  assert.deepEqual(await fake.kinds(code), ['joined', 'joined'], 'and still a member: no left');
});

test('who, tasks, leave and kick in a session in no room say so', async () => {
  const ctx = testCtx(fakeHome());
  assert.equal((await runCommand('who', ctx)).text, 'This session is in no room. Type /sub-human to join one.');
  assert.equal((await runCommand('tasks', ctx)).text, 'This session is in no room. Type /sub-human to join one.');
  assert.equal((await runCommand('leave', ctx)).text, 'This session is in no room.');
  assert.equal((await runCommand('kick bob', ctx)).kind, 'refused');
});

test('tasks lists the open tasks with owners and blockers, and counts the done ones (R24)', async () => {
  const { fake, alice, code } = await room();
  assert.equal((await runCommand('tasks', alice)).text, `${code} has no tasks yet.`);
  const task = (n: number, title: string, rest: object) => fake.host(code, [{
    kind: 'task', from: 'alice', by: 'system', task: { n, title, status: 'open', addedBy: 'alice', blockedBy: [], ...rest },
  }]);
  await task(1, 'store paging', { status: 'claimed', owner: 'alice' });
  await task(2, 'handler paging', { blockedBy: [1] });
  await task(3, 'schema', { status: 'done', owner: 'bob' });
  assert.equal((await runCommand('tasks', alice)).text, [
    `${code} · 2 open`, '#1 alice\'s · store paging', '#2 open · handler paging · after #1', '1 done',
  ].join('\n'));
});

test('leave writes left and an away presence, and forgets the session; another session as the name keeps it (R3)', async () => {
  const { fake, alice, bob, code } = await room();
  const alice2 = testCtx(fake, { session: 'session-3' });
  await runCommand('', alice2);
  assert.equal((await runCommand('leave', alice2)).text, `You left ${code}.`);
  const lefts = async () => (await fake.lines(code)).filter(l => l.includes('"kind":"left"')).length;
  assert.equal(await lefts(), 0, 'no left while another session holds the name');
  assert.equal((await fake.presence(code, 'alice'))?.state, 'idle', 'alice is still here in session-1');
  assert.equal((await runCommand('leave', alice)).text, `You left ${code}.`);
  assert.equal(await lefts(), 1);
  assert.equal(await alice.sessions.get('session-1'), null);
  const s = await fake.rooms.state(code);
  assert.ok(s.ok);
  assert.deepEqual(s.value.members.map(m => [m.name, m.machines.length, m.presence?.state]), [['alice', 0, 'away'], ['bob', 1, 'idle']]);
  assert.equal((await runCommand('who', bob)).text, `${code} · 1 here\nbob (you) · laptop · idle · api on main`);
});

test('a leave the daemon refuses keeps the session in the room, to try again', async () => {
  const { fake, alice, code } = await room();
  fake.down = 'sub-human\'s daemon did not answer; nothing was done';
  assert.deepEqual(await runCommand('leave', alice), { kind: 'refused', text: `You're still in ${code}: sub-human's daemon did not answer; nothing was done` });
  assert.equal((await alice.sessions.get('session-1'))?.code, code);
});

test('a leave retried after its left was stored writes it once: the pointer keeps the left\'s id', async () => {
  const { fake, alice, code } = await room();
  const p = must(await alice.sessions.get('session-1'), 'the pointer');
  assert.equal((await runCommand('leave', alice)).text, `You left ${code}.`);
  // the pointer outlived its left (a crash before it was removed): the retry carries the same leave id
  await fs.writeFile(sessionFile(fake.dir, p.id), JSON.stringify({ code: p.code, name: p.name, title: p.title, leave: p.leave }));
  assert.equal((await runCommand('leave', alice)).text, `You left ${code}.`);
  assert.equal((await runCommand('leave', alice)).text, 'This session is in no room.');
  const lines = (await fake.lines(code)).filter(l => l.includes('"kind":"left"'));
  assert.equal(lines.length, 1);
});

test('kick removes a member for good; never yourself, nobody unknown, nobody twice (R31)', async () => {
  const { fake, alice, bob, code } = await room();
  assert.equal((await runCommand('kick', alice)).text, 'Nobody was removed. Type /sub-human kick NAME.');
  assert.equal((await runCommand('kick alice', alice)).text, 'You were not removed: to go, type /sub-human leave.');
  assert.equal((await runCommand('kick zed', alice)).text, `zed was not removed: there is no zed in ${code}.`);
  assert.deepEqual(await runCommand('kick bob', alice), { kind: 'say', text: `bob is removed from ${code} for good.` });
  assert.equal((await runCommand('kick bob', alice)).text, `bob is already removed from ${code}.`);
  assert.deepEqual(fake.calls.filter(c => c.startsWith('kick')), [`kick ${code} bob alice`]);
  assert.match((await runCommand('leave', bob)).text, /^You're still in .*: bob was removed/);
});

test('help is at most six lines (R4)', async () => {
  const ctx = testCtx(fakeHome());
  const help = await runCommand('help', ctx);
  assert.ok(help.text.split('\n').length <= 6);
  assert.match(help.text, /^\/sub-human \[NAME\]/);
  assert.deepEqual(fakeHome().calls, []);
});

test('news reaches the command only where the module is off: one line saying so (the module draws it)', async () => {
  assert.equal((await runCommand('news', testCtx(fakeHome()))).text, 'This session is in no room. Type /sub-human to join one.');
  const { alice } = await room();
  assert.deepEqual(await runCommand('news', alice), {
    kind: 'refused', text: "News wasn't shown: sub-human's module draws it, and it isn't running in this session. /sub-human who shows what each member is doing.",
  });
});

test('invite: one line for NAME by the pathway asked, else the default; only from a session in a room', async () => {
  const { fake, alice, code } = await room();
  const r = await runCommand('invite carol', alice);
  assert.equal(r.kind, 'say');
  assert.match(r.text, new RegExp(`^Send carol this line .*\n/sub-human join ssh://devbox/${code}\\?port=7420#0+$`));
  await runCommand('invite carol --ssh', alice);
  assert.deepEqual(fake.calls.filter(c => c.startsWith('invite')), [`invite ${code} carol public alice`, `invite ${code} carol ssh alice`]);
  assert.equal((await runCommand('invite', alice)).kind, 'refused');
  assert.equal((await runCommand('invite carol --forward', alice)).kind, 'refused');
  assert.match((await runCommand('invite carol', testCtx(fake, { session: 'session-9' }))).text, /in no room/);
});

test('join: the line is dialled as the git name; let in, the session takes its place; refused, it says so', async () => {
  const fake = fakeHome();
  const line = `ssh://devbox/otter-4821?port=7420#${'0'.repeat(77)}`;
  fake.linked.set('otter-4821', { phase: 'stopped', why: 'refused' });
  const r = await runCommand(`join ${line}`, testCtx(fake));
  assert.deepEqual(r, { kind: 'refused', text: 'You did not join otter-4821: the host did not let this machine in. Ask them for a new invite.' });
  assert.deepEqual(fake.calls.filter(c => c.startsWith('dial')), ['dial alice']);
  // let in: here the room's code is one this home holds, as a mirror would after its first sync
  const host = testCtx(fake, { session: 'session-h' });
  await runCommand('', host);
  const code = await fake.code();
  fake.linked.set(code, { phase: 'online', why: null });
  const bob = testCtx(fake, { session: 'session-b' });
  const j = await runCommand(`join ssh://devbox/${code}?port=7420#${'0'.repeat(77)} bob`, bob);
  assert.deepEqual(j, { kind: 'say', text: `You're in ${code} as bob, with alice.` });
  assert.match((await runCommand(`join ${line}`, bob)).text, /so it joined no other/);
});

test('doctor: node, the socket path, the module, the version checked on, every room log, sshd and Tailscale (R29b)', async () => {
  const { fake, code } = await room();
  const ran: string[] = [];
  const answers: Record<string, string> = { 'sshd -G': 'port 22\nallowtcpforwarding yes', 'tailscale status --json': '{"Version":"1.80","BackendState":"Running"}' };
  const well = { ...testCtx(fake, { env: { SUB_HUMAN_HOME: '/h' } }), run: (p: string, args: readonly string[]) => { ran.push(p); return Promise.resolve(answers[[p, ...args].join(' ')] ?? null); } };
  assert.equal((await runCommand('doctor', well)).text, [
    'ok    node 24.11.1',
    'ok    home /h',
    'ok    hooks module on in 1 session here',
    'ok    sub-human is checked on Claude Code 2.1.330',
    'ok    1 room here, every log intact',
    'ok    sshd allows TCP forwarding, so an ssh invite works',
    'ok    Tailscale is running, so a URL invite works',
  ].join('\n'));
  assert.deepEqual(ran, ['sshd', 'tailscale'], 'never the claude on PATH');
  await fake.forge(code, ls => ls.map((l, i) => (i === 0 ? l.replace('"alice"', '"mallory"') : l)));
  fake.down = 'sub-human\'s daemon did not answer; nothing was done';
  const long = `/${'d'.repeat(100)}`;
  const sick = testCtx(fake, { nodeVersion: '23.4.0', env: { SUB_HUMAN_INVITE: 'carrier-pigeon', SUB_HUMAN_HOME: long }, run: { 'sshd -G': 'AllowTcpForwarding no', 'tailscale status --json': '{"BackendState":"NeedsLogin"}' } });
  const lines = (await runCommand('doctor', sick)).text.split('\n');
  assert.match(must(lines[0], 'node'), /^fix   node 23\.4\.0 can't run sub-human/);
  assert.equal(lines[1], 'fix   the home\'s path is too long for the daemon\'s socket (113 bytes, at most 103); set SUB_HUMAN_HOME to a shorter path');
  assert.match(must(lines[2], 'module'), /^fix   the sub-human daemon did not answer/);
  assert.match(must(lines[4], 'rooms'), new RegExp(`^fix   room logs that don't read: ${code} \\(the log of ${code} does not read \\(fork`));
  assert.equal(lines[5], 'fix   sshd has AllowTcpForwarding no, so an ssh invite can\'t connect; set it to yes in sshd_config, or invite by URL');
  assert.equal(lines[6], 'fix   Tailscale is NeedsLogin, not running: sign in to it to invite by URL, or use /sub-human invite NAME --ssh');
  assert.equal(lines[7], 'fix   SUB_HUMAN_INVITE=carrier-pigeon is not public, tailnet or ssh; public is used');
  fake.down = null;
  fake.cc = ['2.1.330', '2.1.331'];
  const none = testCtx(fake, { run: {} });
  const text = (await runCommand('doctor', none)).text.split('\n');
  assert.equal(text[3], 'ok    sub-human is checked on Claude Code 2.1.330; sessions here run 2.1.331, which it was not checked on');
  assert.equal(text[5], 'ok    no sshd here to read; only an ssh invite needs one, on the machine that invites');
  assert.equal(text[6], 'fix   Tailscale isn\'t installed or doesn\'t answer: install it to invite by URL, or use /sub-human invite NAME --ssh');
});

test('nodeRuns: 22.18+, 24.3+, 25 on; never 23', () => {
  for (const [v, want] of [['22.18.0', true], ['22.17.9', false], ['23.11.0', false], ['24.2.0', false], ['v24.3.0', true], ['25.0.0', true], ['20.1.0', false]] as const) {
    assert.equal(nodeRuns(v), want, v);
  }
});
