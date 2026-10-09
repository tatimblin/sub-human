'use strict';
// Tests for lib/tail.js (the loop behind `sub-human tail`, the hooks module's child), in-process on a fake clock:
// the events, settle, max window, leave hold, cursor restart, room switch, error recovery, the chain check and the
// room Claude watchdog. The log, cursors and seats are real files in a temp SUB_HUMAN_HOME. test/cli.test.js keeps
// real-time smoke tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const rows = require(path.join(h.LIB, 'rows.js'));
const config = require(path.join(h.LIB, 'config.js'));
const { createFake } = require(path.join(h.LIB, 'clock.js'));
const tailLib = require(path.join(h.LIB, 'tail.js'));

const FAST = {
  resolveMs: 100, unseatedMs: 100, pollMs: 50, settleMs: 300, settleMaxMs: 1000, roomClaudeSettleMs: 300, roomClaudeSettleMaxMs: 1000,
  leaveMs: 600, healthMs: 5000, backoffMs: 200, backoffMaxMs: 1000, errorLogMs: 60_000, stallMs: 5000,
};
const DEFAULTS = {
  ...FAST, settleMs: config.SETTLE_MS, settleMaxMs: config.SETTLE_MAX_MS, roomClaudeSettleMs: config.ROOM_CLAUDE_SETTLE_MS,
  roomClaudeSettleMaxMs: config.ROOM_CLAUDE_SETTLE_MAX_MS, leaveMs: config.LEAVE_SETTLE_MS,
};

const handles = new Set();
test.afterEach(() => { for (const x of handles) x.stop(); handles.clear(); });

const BATCH = new Set(['chat', 'pull', 'wake']);
/**
 * An in-process tail: {clock, out, writes, errs, advance(ms), events(), of(type), lines(), chat(), forClaude(),
 * ids(), batches()}. writes counts the batch writes (chat / pull / wake), not seat, rows or health. lines() is what
 * a batch shows in order: each chat event's lines, then its wake's lines (pull is the model's copy).
 */
function startTail({ timings = {}, lookup = () => identity.resolveByPid(process.pid), ...opts } = {}) {
  const clock = opts.clock || createFake({ now: Date.now() });
  const t = { clock, out: '', writes: 0, errs: [] };
  t.handle = tailLib.runTail({
    clock, lookup, timings: { ...FAST, ...timings }, fs: opts.fs, deps: opts.deps, sid: opts.sid,
    write: (s, done) => {
      t.out += s;
      if (s.split('\n').filter(Boolean).some(l => BATCH.has(JSON.parse(l).type))) t.writes++;
      done();
    },
    err: s => t.errs.push(s),
  });
  handles.add(t.handle);
  t.advance = ms => clock.advance(ms);
  t.events = () => t.out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  t.of = type => t.events().filter(x => x.type === type);
  t.text = () => t.lines().map(l => l + '\n').join('');
  t.lines = () => t.events().flatMap(x => (x.type === 'chat' ? x.lines : x.type === 'wake' ? x.text.split('\n') : []));
  t.chat = () => t.lines().filter(l => !l.startsWith('(for Claude)'));
  t.forClaude = () => t.lines().filter(l => l.startsWith('(for Claude)'));
  t.entries = () => t.lines().filter(l => /^#\d+ /.test(l));
  t.ids = () => t.entries().map(l => Number(l.split(' ')[0].slice(1)));
  t.batches = () => t.lines().filter(l => l.startsWith('room now: ')).length;
  t.stop = () => { t.handle.stop(); handles.delete(t.handle); };
  return t;
}

const inRoom = (code, f) => f(room.open(code));
const say = (code, from, text, extra = {}, via = 'human') => inRoom(code, r => r.append({ kind: 'say', text, ...extra }, { via, from }));
const sys = (code, kind, from, extra = {}) => inRoom(code, r => r.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true }));
const cursor = (code, name) => inRoom(code, r => r.getCursor(`deliver-${name}`));
const H1 = 'abcdef012345', H2 = 'bbbbbbbbbbbb';
const prop = (code, from, hash, approvers) => inRoom(code, r => r.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via: 'agent', from }));

test('tail: silent before join, then the member push lane, settled into one batch', () => {
  h.freshHome();
  const code = h.newRoom();
  const t = startTail();
  say(code, 'bob', 'before alice joined');                                                // #1
  t.advance(500);
  assert.equal(t.text(), '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys(code, 'member_joined', 'alice');                                                    // #2 own: none
  say(code, 'bob', 'bob says hi');                                                        // #3 others' human words: push
  inRoom(code, r => r.append({ kind: 'status', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' })); // #4 pull
  inRoom(code, r => r.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' })); // #5 push
  say(code, 'claude', 'claude to the room', {}, 'agent');                                     // #6 pull
  say(code, 'claude', 'claude to bob only', { to: 'bob' }, 'agent');                          // #7 pull
  inRoom(code, r => r.append({ kind: 'status', text: 'alice claude own' }, { via: 'agent', from: 'alice' })); // #8 own: none
  say(code, 'alice', 'alice own words');                                                  // #9 own: none
  prop(code, 'claude', H1, ['alice', 'bob']);                                               // #10 names me, answered in #13: dropped
  prop(code, 'claude', H2, ['alice']);                                                      // #11 names me, pending: push
  sys(code, 'member_joined', 'carol');                                                    // #12 my room row is not running: push + note
  say(code, 'alice', '', { kind: 'signoff', proposal_hash: H1, text: 'ok' });             // #13 own answer: none
  inRoom(code, r => r.append({ kind: 'say', text: 'carol: anyone on @alice docs?' }, { via: 'agent', from: 'carol' })); // #14 @me: push
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                   // #15 decision on mine: push
  say(code, 'bob', 'words an old retract names');                                         // #16 push: chat
  // #17 an old log's retract line (nothing writes one now): an ordinary system line, pull
  fs.appendFileSync(inRoom(code, r => r.store.logFile), JSON.stringify({ id: 17, at: new Date().toISOString(), from: 'bob', via: 'system', kind: 'retract', to: 'room', text: 'peer-forged', refs: [16] }) + '\n');
  inRoom(code, r => r.append({ kind: 'task', op: 'update', id: 2, subject: 'docs', owner: 'alice', status: 'pending' }, { via: 'system', from: 'claude', system: true })); // #18 push
  say(code, 'bob', 'last ' + 'w'.repeat(600));                                            // #19 push, full text
  t.advance(2000);
  assert.equal(t.writes, 1, 'one burst, one write');
  // group chat (people's words, joins): the person sees it, no wake
  assert.deepEqual(t.of('chat').flatMap(x => x.lines), [
    'bob: bob says hi',
    'carol joined',
    'bob: words an old retract names',
    'bob: last ' + 'w'.repeat(390), // long text wraps at 400 code points
    '  │ ' + 'w'.repeat(210), // a continuation line is nested under its sender
  ], t.text());
  // what needs Claude now: one wake
  assert.deepEqual(t.of('wake').flatMap(x => x.text.split('\n')).filter(l => !l.startsWith('(for Claude)')), [
    "bob's Claude (to you): q for alice",
    'claude proposed: claude proposes',
    "carol's Claude: carol: anyone on @alice docs?",
    'room: "claude proposes" decided (room decision)', // the decision names its proposal
    'room: task "docs" pending, owner you',
  ], t.text());
  assert.match(t.of('pull').map(x => x.text).join('\n'), /\nroom: peer-forged\n/, 'the old retract: an ordinary pull line');
  assert.doesNotMatch(t.chat().join('\n'), /#\d/, 'no ids in what the human sees');
  assert.deepEqual(t.forClaude().map(l => l.slice(0, 40)), ['(for Claude) room now: proposal bbbbbb w']);
  assert.match(t.of('rows').at(-1).text, /SUB-HUMAN ROWS: your room row is not running/, 'the missing row is the rows event');
  assert.ok(t.forClaude()[0].startsWith(`(for Claude) room now: proposal ${H2.slice(0, 6)} waiting on alice · you: answer needed (`), t.forClaude()[0]);
  assert.ok(t.forClaude()[0].includes(`"proposal ${H2}"`), 'the card call carries the full hash');
  assert.equal(cursor(code, 'alice'), 19);
  const notices = require(path.join(h.LIB, 'notices.js'));
  assert.ok(notices.shown(code, 'alice').has(12), 'the join is recorded as shown (a restarted child does not repeat it)');
  assert.deepEqual(t.errs, []);
});

test('tail: a member sees every join as a chat line; with its room row running, no row-call invite', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, 'alice', { room: true });
  sys(code, 'member_joined', 'alice');                         // #1
  const t = startTail();
  t.advance(300);
  sys(code, 'member_joined', 'bob');                           // #2 the room row nests bob by itself: a chat line only
  say(code, 'bob', 'hi');                                      // #3
  t.advance(1000);
  assert.deepEqual(t.lines(), ['bob joined', 'bob: hi'], t.text());
  assert.doesNotMatch(t.text(), /Agent|row:/);
});

test('tail: room Claude push is to=claude (a leading @claude), objections on its proposals, task_req (not decisions)', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  sys(code, 'member_joined', 'claude');
  const t = startTail({ deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  inRoom(code, r => r.append({ kind: 'status', text: 'alice claude idea' }, { via: 'agent', from: 'alice' })); // #2 pull
  say(code, 'bob', 'bob words', { to: 'alice' });                                              // #3 pull
  say(code, 'claude', 'claude own', {}, 'agent');                                                  // #4 none
  prop(code, 'claude', H1, ['alice', 'bob']);                                                    // #5 own: none
  sys(code, 'member_left', 'bob');                                                             // #6 pull
  say(code, 'alice', '', { kind: 'objection', proposal_hash: H1, text: 'no' });                // #7 push
  inRoom(code, r => r.append({ kind: 'task_req', op: 'add', subject: 'parser tests' }, { via: 'agent', from: 'bob' })); // #8 push
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                        // #9 pull
  say(code, 'alice', 'end', { to: 'claude' });                                                 // #10 push: "@claude end"
  say(code, 'bob', '@claude not a tag');                                                       // #11 pull: "@room @claude not a tag"
  t.advance(1500);
  assert.deepEqual(t.ids(), [7, 8, 10], t.text());
  assert.equal(t.batches(), 1);
  assert.match(t.text(), /#10 alice\[human\] say to=claude "end"/);
});

test('tail: a member_joined notice says whether that row already runs (live holds), for the room\'s Claude', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  const t = startTail({ deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  sys(code, 'member_joined', 'bob');                                     // #1 first join: no row yet, pushed with the call
  t.advance(1500);
  assert.match(t.text(), /member_joined/);
  rows.writeHolds(code, 'claude', { members: ['bob'] });                   // the room Claude's bob row is now held
  sys(code, 'member_left', 'bob');                                       // #2 pull
  sys(code, 'member_joined', 'bob');                                     // #3 rejoin: the row survived, not pushed
  say(code, 'bob', 'back', { to: 'claude' });                            // #4
  t.advance(1500);
  assert.deepEqual(t.ids(), [1, 4], t.text());
  assert.match(t.entries()[0], /^#1 bob\[system\] member_joined .* · row: bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  assert.doesNotMatch(t.entries()[1], / · row:/, 'only member_joined carries the note');
});

test('tail: leave/rejoin collapse at the default 8 s hold (left+rejoin within 3 s prints nothing)', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  const t = startTail({ timings: { ...DEFAULTS, roomClaudeSettleMs: 1500 }, deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  const t0 = t.clock.now();
  // member_left is pull in the lanes; addressing it to the room's Claude makes it push, to exercise the hold.
  sys(code, 'member_left', 'bob', { to: 'claude' });                       // #1 back at 3 s: dropped with #3
  sys(code, 'member_left', 'carol', { to: 'claude' });                     // #2 lone: printed at >= 8 s
  t.advance(3000);
  sys(code, 'member_joined', 'bob');                                     // #3
  t.advance(4900);                                                       // 7.9 s: still held
  assert.equal(t.text(), '', t.text());
  t.advance(2000);
  assert.ok(t.text().includes('#2 carol'), t.text());
  assert.ok(t.clock.now() - t0 >= 8000);
  assert.match(t.text(), / · away 8s\+/);
  assert.deepEqual(t.ids(), [2], t.text());
  assert.equal(cursor(code, 'claude'), 3, 'dropped ids advance the cursor');
});

test('tail: the room\'s Claude settles longer by default (two pushes 2 s apart are one batch)', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  sys(code, 'member_joined', 'claude');
  const t = startTail({ timings: DEFAULTS, deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  say(code, 'alice', 'default 20, max 50', { to: 'claude' });          // #2
  t.advance(2000);
  say(code, 'bob', 'fine, please propose it', { to: 'claude' });       // #3
  t.advance(2900);
  assert.equal(t.text(), '', 'still settling: 3 s of quiet after #3');
  t.advance(500);
  assert.deepEqual(t.ids(), [2, 3], t.text());
  assert.equal(t.batches(), 1, t.text());
});

test('tail: a steady trickle is cut into batches at the settle max; held ids keep the cursor back', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                                  // #1
  const t = startTail({ timings: { settleMs: 400, settleMaxMs: 900 } });
  t.advance(300);
  for (let i = 0; i < 10; i++) { say(code, 'bob', `tick ${i}`); t.advance(200); }
  assert.ok(cursor(code, 'alice') < 11, 'buffered ids are not past the cursor yet');
  t.advance(1000);
  assert.deepEqual(t.lines(), Array.from({ length: 10 }, (_, i) => `bob: tick ${i}`));
  assert.ok(t.writes >= 2 && t.writes <= 4, `${t.writes} batches`);
  assert.equal(cursor(code, 'alice'), 11);
});

test('tail: startCursor: the saved cursor, else (the room\'s Claude after a 0.4.x upgrade) deliver-orch, else the latest join', () => {
  const rm = cursors => ({ getCursor: k => cursors[k] || 0, readView: () => [{ id: 7, kind: 'member_joined', from: 'claude' }] });
  const claude = { name: 'claude', role: 'claude' };
  assert.equal(tailLib.startCursor(rm({ 'deliver-claude': 5, 'deliver-orch': 3 }), 'deliver-claude', claude, 9), 5);
  assert.equal(tailLib.startCursor(rm({ 'deliver-orch': 3 }), 'deliver-claude', claude, 9), 3, 'resumes where the orch stopped');
  assert.equal(tailLib.startCursor(rm({}), 'deliver-claude', claude, 9), 7, 'no cursor: its latest join');
  assert.equal(tailLib.startCursor(rm({ 'deliver-orch': 3 }), 'deliver-bob', { name: 'bob', role: 'member' }, 9), 9, 'a member never reads it');
});

test('tail: survives a restart via its cursor (no read from byte 0); switches when the session changes rooms', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                         // #1
  say(code, 'bob', 'history');                                 // #2: after the join, so it is delivered
  const reads = [];
  const big = 'x'.repeat(1000);
  const spyFs = { ...fs, readSync: (fd, buf, off, len, pos) => { reads.push(pos); return fs.readSync(fd, buf, off, len, pos); } };
  const a = startTail({ fs: spyFs });
  a.advance(500);
  say(code, 'bob', 'first watch');                             // #3
  a.advance(500);
  assert.deepEqual(a.lines(), ['bob: history', 'bob: first watch']);
  assert.equal(cursor(code, 'alice'), 3, 'the cursor is saved once the write is done');
  a.stop();
  say(code, 'bob', 'posted in the gap');                       // #4: nobody is watching
  inRoom(code, r => r.append({ kind: 'status', text: 'own, skipped' }, { via: 'agent', from: 'alice' })); // #5
  for (let i = 0; i < 10; i++) say(code, 'alice', `own words ${i} ${big}`); // #6-#15: own, skipped; the log is > 10 KB
  assert.equal(cursor(code, 'alice'), 3, 'the first tail saved its cursor');
  reads.length = 0;
  const b = startTail({ fs: spyFs });
  b.advance(50);
  assert.ok(reads.length && reads.every(p => p > 0), `nothing is read from byte 0: ${reads}`);
  b.advance(500);
  say(code, 'bob', 'after restart');                           // #16
  b.advance(500);
  assert.deepEqual(b.lines(), ['bob: posted in the gap', 'bob: after restart'], b.text());
  assert.equal(cursor(code, 'alice'), 16);
  // The session joins another room: the tail re-resolves and follows the new one.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  sys(code2, 'member_joined', 'carol');
  say(code2, 'dave', 'hello from room two');
  b.advance(600);
  assert.ok(b.text().includes('dave: hello from room two\n'), b.text());
  say(code, 'bob', 'old room, no longer watched');
  b.advance(600);
  assert.ok(!b.text().includes('no longer watched'), b.text());
});

test('tail: an error inside the loop is logged once, backed off and recovered; delivery continues', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                         // #1
  let statFails = 0, viewFails = 0, lookupFails = 0;
  const flakyFs = { ...fs, statSync: (...x) => { if (statFails > 0) { statFails--; throw Object.assign(new Error('EIO: injected read error'), { code: 'EIO' }); } return fs.statSync(...x); } };
  const flakyRoom = c => { const r = room.open(c); return { ...r, readView: (...x) => { if (viewFails > 0 && !(x[0] && x[0].after === Infinity)) { viewFails--; throw new Error('injected view error'); } return r.readView(...x); } }; };
  const t = startTail({
    fs: flakyFs, deps: { openRoom: flakyRoom },
    lookup: () => { if (lookupFails > 0) { lookupFails--; throw new Error('injected lookup error'); } return identity.resolveByPid(process.pid); },
  });
  t.advance(300);
  say(code, 'bob', 'one');                                     // #2
  t.advance(500);
  assert.deepEqual(t.lines(), ['bob: one']);
  statFails = 4;                                               // the poll throws 4 times in a row
  say(code, 'bob', 'two');                                     // #3
  t.advance(1000);
  assert.equal(t.lines().length, 1, 'backing off: 200, 400, 800 ms');
  t.advance(3000);
  assert.deepEqual(t.lines(), ['bob: one', 'bob: two'], t.text());
  assert.equal(t.errs.length, 1, `rate-limited to one line: ${t.errs}`);
  assert.match(t.errs[0], /^sub-human tail: poll failed: EIO: injected read error; retrying\n$/);
  viewFails = 1;                                               // the flush's view read throws once: the batch is kept
  lookupFails = 3;                                             // a failing seat lookup keeps the session
  say(code, 'bob', 'three');                                   // #4
  t.advance(2000);
  assert.deepEqual(t.lines(), ['bob: one', 'bob: two', 'bob: three'], t.text());
  assert.ok(t.errs.some(e => /flush failed: injected view error/.test(e)), t.errs.join(''));
  assert.ok(t.errs.some(e => /seat lookup failed: injected lookup error/.test(e)), t.errs.join(''));
  assert.equal(cursor(code, 'alice'), 4);
});

test('tail: a dead poll loop is noticed by the seat check and the session restarts from its cursor', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                         // #1
  const t = startTail();
  t.advance(300);
  t.handle.session().killPoll();
  say(code, 'bob', 'while the loop was dead');                 // #2
  t.advance(FAST.stallMs + 1000);
  assert.deepEqual(t.lines(), ['bob: while the loop was dead'], t.text());
  assert.match(t.errs.join(''), /poll loop failed: stalled/);
});

test('tail: a hash-chain break is reported once per break, for Claude; the tail keeps delivering', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                         // #1
  say(code, 'bob', 'genuine');                                 // #2
  const t = startTail();
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(t.lines(), ['bob: genuine'], 'an intact chain prints nothing');
  const file = inRoom(code, r => r.store.logFile);
  fs.appendFileSync(file, JSON.stringify({ id: 3, at: new Date().toISOString(), from: 'alice', via: 'agent', kind: 'status', to: 'room', text: 'spliced', prev: '000000000000' }) + '\n');
  t.advance(FAST.healthMs);
  t.advance(FAST.healthMs * 3);
  assert.deepEqual(t.of('health').map(x => x.text), ['room log check: the hash chain breaks at #3; that entry and the ones after it may have been changed outside the plugin'], t.out);
  say(code, 'bob', 'still delivered');
  t.advance(1000);
  assert.ok(t.text().includes('bob: still delivered\n'), t.text());
});

test('tail: the room\'s Claude runs claude.watchdog(code) every health interval; a member never does', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  const calls = [];
  const t = startTail({ deps: { roomClaude: { watchdog: c => { calls.push(c); if (calls.length === 2) throw new Error('watchdog boom'); return 'live'; } } } });
  t.advance(FAST.healthMs * 3 + 100);
  assert.deepEqual(calls, [code, code, code], 'it keeps going after a throw');
  assert.match(t.errs.join(''), /health check failed: watchdog boom/);
  t.stop();
  h.freshHome();
  h.register('alice');
  const mcalls = [];
  const m = startTail({ deps: { roomClaude: { watchdog: c => mcalls.push(c) } } });
  m.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(mcalls, []);
});

test('tail: --max-seconds stops it with no timer left', () => {
  h.freshHome();
  h.register('alice');
  const clock = createFake({ now: Date.now() });
  tailLib.runTail({ clock, lookup: () => identity.resolveByPid(process.pid), timings: FAST, write: (s, d) => d(), err: () => {}, maxSeconds: 2 });
  clock.advance(2000);
  assert.equal(clock.pending(), 0);
});

test('Batcher: settles on quiet, cuts at the max window, keeps young items, retries a failed flush', () => {
  const clock = createFake();
  const out = [];
  let fail = 0;
  const b = new tailLib.Batcher({
    clock, settleMs: 100, settleMaxMs: 250, retryMs: 50,
    onFlush: ready => { if (fail > 0) { fail--; throw new Error('x'); } out.push(ready.map(p => p.e.id)); },
  });
  b.enqueue({ e: { id: 2 } }); b.enqueue({ e: { id: 1 } });
  clock.advance(99);
  assert.deepEqual(out, []);
  clock.advance(1);
  assert.deepEqual(out, [[1, 2]], 'quiet: one batch, in id order');
  for (let i = 3; i <= 6; i++) { b.enqueue({ e: { id: i } }); clock.advance(80); }
  assert.deepEqual(out, [[1, 2], [3, 4]], 'the max window cuts a trickle; #5 and #6 are too young and wait');
  clock.advance(100);
  assert.deepEqual(out, [[1, 2], [3, 4], [5, 6]]);
  fail = 1;
  b.enqueue({ e: { id: 7 } });
  clock.advance(100);
  assert.equal(out.length, 3);
  clock.advance(50);
  assert.deepEqual(out.at(-1), [7], 'retried after retryMs');
  b.stop();
  b.enqueue({ e: { id: 8 } });
  clock.advance(1000);
  assert.equal(clock.pending(), 0);
});

test('tail: the health tick renews the seat lease (identity.heartbeat)', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const beats = [];
  const t = startTail({ deps: { heartbeat: me => beats.push(`${me.code}/${me.name}`) } });
  t.advance(FAST.healthMs * 2 + 100);
  assert.ok(beats.length >= 2 && beats.every(b => b === `${code}/alice`), beats.join(','));
});

// ---------- the events as the mod routes them ----------
const startNd = startTail;

test('tail: a member batch is chat + pull, a line to me is a wake; it says its seat', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, 'alice', { room: true });
  sys(code, 'member_joined', 'alice');                                                  // #1
  const t = startNd({ sid: 'sid-a' });
  t.advance(300);
  assert.deepEqual(t.of('seat'), [{ type: 'seat', seat: { name: 'alice', code, role: 'member', addr: `alice.${code}` } }]);
  sys(code, 'member_joined', 'bob');                                                    // #2 chat
  say(code, 'bob', 'bob says hi');                                                      // #3 chat
  inRoom(code, r => r.append({ kind: 'status', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' })); // #4 pull
  say(code, 'bob', '@alice can you look?');                                             // #5 @me: wake
  inRoom(code, r => r.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' })); // #6 wake
  prop(code, 'claude', H2, ['alice']);                                                    // #7 a proposal for me: wake + state
  t.advance(2000);
  assert.equal(t.writes, 1, 'ONE batch write (after the seat and rows events)');
  const batch = t.events().filter(x => ['chat', 'pull', 'wake'].includes(x.type));
  assert.deepEqual(batch.map(x => x.type), ['chat', 'pull', 'wake'], 'chat first, then pull, then wake');
  assert.deepEqual(t.of('chat')[0].lines, ['bob joined', 'bob: bob says hi']);
  const pull = t.of('pull')[0].text.split('\n');
  assert.equal(pull[0], tailLib.PULL_HEAD);
  assert.deepEqual(pull.slice(1), ['bob joined', 'bob: bob says hi', "bob's Claude: bob claude chatter"], 'the pull lane plus the chat copy');
  const wake = t.of('wake')[0].text.split('\n');
  assert.deepEqual(wake.slice(0, 3), ['bob: @alice can you look?', "bob's Claude (to you): q for alice", 'claude proposed: claude proposes']);
  assert.ok(wake[3].startsWith(`(for Claude) room now: proposal ${H2.slice(0, 6)}`), wake[3]);
  assert.equal(inRoom(code, r => r.getCursor('deliver-alice')), 7);
  const notices = require(path.join(h.LIB, 'notices.js'));
  assert.ok(notices.shown(code, 'alice').has(2), 'the join is recorded as shown');
  t.stop();
  assert.deepEqual(t.errs, []);
});

test('tail: rows says the missing room row and the pending reminders at start and when they change; null clears', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                                                  // #1
  const t = startNd({ sid: 's' });
  t.advance(300);
  let r = t.of('rows');
  assert.equal(r.length, 1);
  assert.match(r[0].text, /^SUB-HUMAN ROWS: your room row is not running/);
  t.advance(FAST.healthMs + 100);
  assert.equal(t.of('rows').length, 1, 'unchanged: not sent again');
  rows.writeHolds(code, 'alice', { room: true });
  t.advance(FAST.healthMs);
  r = t.of('rows');
  assert.equal(r.at(-1).text, null, 'the row runs: cleared');
  prop(code, 'claude', H2, ['alice']);
  t.advance(FAST.healthMs);
  assert.match(t.of('rows').at(-1).text, new RegExp(H2.slice(0, 6)), 'a proposal awaiting me is reminded');
});

test('tail: the room\'s Claude gets its push block as one wake, the pull lane as pull; no chat', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  rows.writeHolds(code, 'claude', { members: ['bob'] });
  const t = startNd({ sid: 'so', deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  inRoom(code, r => r.append({ kind: 'task_req', text: 'please add tests', op: 'add', subject: 'tests' }, { via: 'agent', from: 'bob' })); // #1 push
  say(code, 'bob', 'bob to the room');                                                  // #2 pull for the room's Claude
  t.advance(2000);
  assert.deepEqual(t.of('chat'), []);
  const wake = t.of('wake');
  assert.equal(wake.length, 1);
  assert.match(wake[0].text, /^room now: /);
  assert.match(wake[0].text, /#1 /);
  assert.match(t.of('pull')[0].text, /bob: bob to the room/);
});

test('tail: a chain break is a health event', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const t = startNd({ sid: 's' });
  t.advance(300);
  fs.appendFileSync(inRoom(code, r => r.store.logFile), JSON.stringify({ id: 2, at: new Date().toISOString(), from: 'alice', via: 'agent', kind: 'status', to: 'room', text: 'spliced', prev: '000000000000' }) + '\n');
  t.advance(FAST.healthMs * 2);
  assert.deepEqual(t.of('health').map(x => x.text.slice(0, 40)), ['room log check: the hash chain breaks at']);
});

test('tail: a member\'s wake carries the room state without entry ids (the person sees the plugin prompt\'s row); the room\'s Claude\'s keeps them', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, 'alice', { room: true });
  sys(code, 'member_joined', 'alice');                                                  // #1
  const t = startNd({ sid: 's' });
  t.advance(300);
  prop(code, 'claude', H1, ['alice']);                                                    // #2
  say(code, 'alice', '', { kind: 'signoff', proposal_hash: H1, text: 'ok' });           // #3 own
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                 // #4 a decision on mine: wake
  t.advance(2000);
  const state = t.of('wake').flatMap(x => x.text.split('\n')).filter(l => l.startsWith('(for Claude) room now:'));
  assert.ok(state.length >= 1, t.out);
  for (const l of state) assert.doesNotMatch(l, /#\d/, l);
  assert.match(room.open(code).stateLine({ name: 'claude', role: 'claude' }, room.open(code).readAll()), /decided #4/);
});

test('tail: a room hosted elsewhere: one OFFLINE line when the link goes down, one "back online" line once it is online again', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  let st = { running: true, state: 'online' };
  const remote = c => { const r = room.open(c); return { ...r, store: { ...r.store, isHost: false } }; };
  const t = startTail({ deps: { openRoom: remote, linkStatus: () => st } });
  const health = () => t.of('health').map(x => x.text);
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(health(), [], 'nothing while it is up');
  st = { running: true, state: 'offline', reason: 'the connection to the host closed' };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health(), ['room link: OFFLINE (the connection to the host closed); @room posts are queued and sent when it is back, answers are refused']);
  st = { running: true, state: 'connecting' };
  t.advance(FAST.healthMs + 100);
  assert.equal(health().length, 1, 'connecting is not back yet');
  st = { running: true, state: 'online' };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(1), [tailLib.LINK_BACK], 'once');
  assert.equal(tailLib.LINK_BACK, 'room link: back online; @room posts go through again');
  // down again; back with the queued posts sent: the one back-online line says so
  st = { running: true, state: 'offline', reason: 'x', queued: 2 };
  t.advance(FAST.healthMs * 2 + 100);
  st = { running: true, state: 'online', flush: { at: 'a', sent: 2, unsent: [] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(3), [`${tailLib.LINK_BACK}; 2 queued @room post(s) sent`]);
  // a brief outage the tail never saw: posts sent quietly; one that was not sent is told
  st = { running: true, state: 'online', flush: { at: 'b', sent: 1, unsent: [] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.equal(health().length, 4, 'sent quietly');
  st = { running: true, state: 'online', flush: { at: 'c', sent: 0, unsent: [{ text: 'hi', why: 'it waited too long' }] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(4), ['room link: NOT sent (it waited too long): "hi"']);
});
