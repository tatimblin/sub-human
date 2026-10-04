'use strict';
// Tests for bin/sub-human. The CLI runs as a child of this test process, so it resolves to whatever is
// registered for process.pid (process ancestry), exactly as it resolves to claude in a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const identity = require(path.join(h.LIB, 'identity.js'));

const FAST = { SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_POLL_MS: '50' };
const children = new Set();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

function startTail(env = {}) {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise(r => child.on('exit', code => r(code))) };
  child.stdout.on('data', d => { t.out += d; });
  t.lines = () => t.out.split('\n').filter(Boolean);
  t.ids = () => t.lines().map(l => Number(l.split(' ')[0].slice(1)));
  t.until = async (needle, ms = 5000) => {
    await h.until(() => t.out.includes(needle), ms);
    assert.ok(t.out.includes(needle), `tail never printed ${needle}; got:\n${t.out}`);
  };
  t.stop = async () => { child.kill(); await t.exited; children.delete(child); };
  return t;
}
const cli = (args, env = {}) => spawnSync(h.BIN, args, { env: h.childEnv(env), encoding: 'utf8' });
const say = (from, text, extra = {}, via = 'human') => room.append({ kind: 'say', text, ...extra }, { via, from });
const sys = (kind, from, extra = {}) => room.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });

test('cli tail: silent before join, then the member filter', async () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const t = startTail();
  say('bob', 'before alice joined');                                                    // #1
  await h.sleep(500);
  assert.equal(t.out, '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');                                                        // #2 own: hidden
  say('bob', 'bob says hi');                                                            // #3 human: shown
  room.append({ kind: 'proposal', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' }); // #4 other Claude: hidden
  room.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #5 to me: shown
  say('orch', 'orch to the room', {}, 'agent');                                         // #6 orch to room: shown
  say('orch', 'orch to bob only', { to: 'bob' }, 'agent');                              // #7 orch to bob: hidden
  room.append({ kind: 'status', text: 'alice claude own' }, { via: 'agent', from: 'alice' }); // #8 own: hidden
  say('alice', 'alice own words');                                                      // #9 own: hidden
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice', 'bob'] });  // #10 system: shown
  sys('status', 'orch', { text: 'plan abcdef012345 is waiting for sign-off from alice and bob' }); // #11 shown
  sys('member_joined', 'carol');                                                        // #12 shown
  sys('decision', 'orch', { plan_hash: 'abcdef012345' });                               // #13 shown
  say('bob', 'last');                                                                   // #14 shown
  await t.until('"last"');
  await h.sleep(200);
  assert.deepEqual(t.ids(), [3, 5, 6, 10, 11, 12, 13, 14], t.out);
  for (const l of t.lines()) assert.ok(l.length <= 240);
  assert.match(t.lines()[0], /^#3 bob\[human\] say "bob says hi"$/);
  assert.equal(room.getCursor('tail-alice'), 14);
});

test('cli tail: orch sees everything not authored by orch', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  sys('member_joined', 'orch');
  const t = startTail();
  await h.sleep(300);
  room.append({ kind: 'proposal', text: 'alice claude idea' }, { via: 'agent', from: 'alice' });
  say('bob', 'bob words', { to: 'alice' });
  say('orch', 'orch own', {}, 'agent');
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice'] });
  sys('member_left', 'bob');
  say('alice', 'end');
  await t.until('"end"');
  assert.deepEqual(t.ids(), [2, 3, 6, 7], t.out);
});

test('cli tail: survives a restart via its cursor; switches when the session changes rooms', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('member_joined', 'alice');                         // #1
  say('bob', 'history');                                 // #2: after the join, so it is delivered
  const a = startTail();
  await a.until('"history"');
  say('bob', 'first watch');                             // #3
  await a.until('"first watch"');
  await a.stop();
  say('bob', 'posted in the gap');                       // #4: nobody is watching
  room.append({ kind: 'status', text: 'own, skipped' }, { via: 'agent', from: 'alice' }); // #5
  assert.equal(room.getCursor('tail-alice'), 3, 'the first tail saved its cursor');
  const b = startTail();
  await b.until('"posted in the gap"');
  say('bob', 'after restart');                           // #6
  await b.until('"after restart"');
  assert.deepEqual(b.ids(), [4, 6], b.out);
  await h.until(() => room.getCursor('tail-alice') === 6, 2000);
  assert.equal(room.getCursor('tail-alice'), 6);
  // The session joins another room: the tail re-resolves and follows the new one.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  room.bind(code2);
  sys('member_joined', 'carol');
  say('dave', 'hello from room two');
  await b.until('"hello from room two"');
  room.bind(code);
  say('bob', 'old room, no longer watched');
  await h.sleep(400);
  assert.ok(!b.out.includes('no longer watched'), b.out);
  // --max-seconds exits cleanly.
  const c = spawn(h.BIN, ['tail', '--max-seconds', '1'], { env: h.childEnv(FAST) });
  children.add(c);
  assert.equal(await new Promise(r => c.on('exit', r)), 0);
});

test('cli: who / read / digest resolve by ancestry; a forged CLAUDE_PID never prints bob', () => {
  h.freshHome();
  const code = h.newRoom();
  let r = cli(['who']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in a room; run \/sub-human/);
  assert.equal(cli(['read']).status, 1);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  h.register('alice', 'member', process.pid, code);
  r = cli(['who'], { CLAUDE_PID: String(bob.pid) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `alice (member) in ${code}\n`);
  assert.ok(!r.stdout.includes('bob'));
  room.bind(code);
  say('bob', 'line one\n  line `two` $(x)');
  say('bob', 'second');
  r = cli(['read', '--id', '2,1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('#2') < r.stdout.indexOf('#1'));
  assert.ok(r.stdout.includes('line one\n  line `two` $(x)'));
  r = cli(['read', '--json']);
  assert.deepEqual(r.stdout.trim().split('\n').map(l => JSON.parse(l).id), [1, 2]);
  assert.match(cli(['read']).stdout, /no new messages/);
  assert.equal(cli(['read', '--id', '99']).status, 1);
  r = cli(['digest']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROOM DIGEST/);
  assert.match(r.stdout, /alice \(member\)/);
  assert.ok(r.stdout.length <= room.DIGEST_CAP + 1);
  assert.equal(cli(['digest', '--room', 'nope-0000']).status, 1);
  assert.equal(cli(['post', 'hello']).status, 2, 'there is no post command');
  bob.kill();
});
