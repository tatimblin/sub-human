// Tests for lib/tail.ts (the loop behind `sub-human tail`, the hooks module's child), in-process on a fake clock:
// the events, settle, max window, leave hold, cursor restart, room switch, error recovery, the chain check and the
// room Claude watchdog. The log, cursors and seats are real files in a temp SUB_HUMAN_HOME. test/cli.node-test.ts keeps
// real-time smoke tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as h from './helpers.ts';
import * as room from '../lib/room.ts';
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import * as config from '../lib/config.ts';
import { createFake } from '../lib/clock.ts';
import * as tailLib from '../lib/tail.ts';
import * as session from '../lib/room/session.ts';
import * as proposal from '../lib/proposal.ts';
import * as plans from '../lib/plans.ts';
import type { Room } from '../lib/room.ts';
import { fsStore } from './support/fs-store.ts';
import type { FakeClock } from '../lib/clock.ts';
import type { Entry, EntryInput, Role, Via } from '../lib/room/types.ts';
import type { Identity } from '../lib/identity.ts';
import type * as linkMod from '../lib/remote/link-socket.ts';
import type { TailEvent } from '../lib/types-app.ts';
import type { RoomCode } from '../lib/brand.ts';
import { rc, sn } from './support/brands.ts';
import { must } from './support/must.ts';

const FAST = {
  resolveMs: 100, unseatedMs: 100, pollMs: 50, settleMs: 300, settleMaxMs: 1000, roomClaudeSettleMs: 300, roomClaudeSettleMaxMs: 1000,
  leaveMs: 600, healthMs: 5000, backoffMs: 200, backoffMaxMs: 1000, errorLogMs: 60_000, stallMs: 5000,
};
const DEFAULTS = {
  ...FAST, settleMs: config.SETTLE_MS, settleMaxMs: config.SETTLE_MAX_MS, roomClaudeSettleMs: config.ROOM_CLAUDE_SETTLE_MS,
  roomClaudeSettleMaxMs: config.ROOM_CLAUDE_SETTLE_MAX_MS, leaveMs: config.LEAVE_SETTLE_MS,
};

const handles = new Set<{ stop(): void }>();
test.afterEach(() => { for (const x of handles) x.stop(); handles.clear(); });

const BATCH = new Set(['chat', 'pull', 'wake']);
/**
 * An in-process tail: {clock, out, writes, errs, advance(ms), events(), of(type), lines(), chat(), forClaude(),
 * ids(), batches()}. writes counts the batch writes (chat / pull / wake), not seat, rows or health. lines() is what
 * a batch shows in order: each chat event's lines, then its wake's lines (pull is the model's copy).
 */
type TailOpts = Parameters<typeof tailLib.runTail>[0];
interface StartOpts extends Partial<Pick<TailOpts, 'lookup' | 'fs' | 'deps' | 'sid'>> {
  timings?: Partial<NonNullable<TailOpts['timings']>>;
  clock?: FakeClock;
}
type EventOf<K extends TailEvent['type']> = Extract<TailEvent, { type: K }>;
interface TailHarness {
  clock: FakeClock;
  out: string;
  writes: number;
  errs: string[];
  handle: ReturnType<typeof tailLib.runTail>;
  advance(ms: number): void;
  events(): TailEvent[];
  of<K extends TailEvent['type']>(type: K): EventOf<K>[];
  text(): string;
  lines(): string[];
  chat(): string[];
  forClaude(): string[];
  entries(): string[];
  ids(): number[];
  batches(): number;
  stop(): void;
}
function startTail({ timings = {}, lookup = () => identity.resolveByPid(process.pid), ...opts }: StartOpts = {}): TailHarness {
  const clock = opts.clock || createFake({ now: Date.now() });
  const t = { clock, out: '', writes: 0, errs: [] } as unknown as TailHarness; // deliberate: the methods are added below
  t.handle = tailLib.runTail({
    clock, lookup, timings: { ...FAST, ...timings },
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}), ...(opts.deps !== undefined ? { deps: opts.deps } : {}), ...(opts.sid !== undefined ? { sid: opts.sid } : {}),
    write: (s, done) => {
      t.out += s;
      if (s.split('\n').filter(Boolean).some(l => BATCH.has((JSON.parse(l) as TailEvent).type))) t.writes++;
      done();
    },
    err: s => t.errs.push(s),
  });
  handles.add(t.handle);
  t.advance = ms => clock.advance(ms);
  t.events = () => t.out.split('\n').filter(Boolean).map(l => JSON.parse(l) as TailEvent);
  t.of = <K extends TailEvent['type']>(type: K) => t.events().filter((x): x is EventOf<K> => x.type === type);
  t.text = () => t.lines().map(l => l + '\n').join('');
  t.lines = () => t.events().flatMap(x => (x.type === 'chat' ? x.lines : x.type === 'wake' ? x.text.split('\n') : []));
  t.chat = () => t.lines().filter(l => !l.startsWith('(for Claude)'));
  t.forClaude = () => t.lines().filter(l => l.startsWith('(for Claude)'));
  t.entries = () => t.lines().filter(l => /^#\d+ /.test(l));
  t.ids = () => t.entries().map(l => Number(must(l.split(' ')[0]).slice(1)));
  t.batches = () => t.lines().filter(l => l.startsWith('room now: ')).length;
  t.stop = () => { t.handle.stop(); handles.delete(t.handle); };
  return t;
}

/** An Identity as the tail's helpers read it (no session, no pid). */
const ident = (code: RoomCode, name: string, role: Role): Identity => ({ code, name: sn(name), role, session_id: null, pid: null, address: `${name}.${code}` });
const inRoom = <T>(code: RoomCode, f: (r: Room) => T): T => f(room.open(code));
const say = (code: RoomCode, from: string, text: string, extra: Partial<EntryInput> = {}, via: Via = 'human') => inRoom(code, r => r.append({ kind: 'say', text, ...extra }, { via, from }));
const sys = (code: RoomCode, kind: string, from: string, extra: Partial<EntryInput> = {}) => inRoom(code, r => r.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true }));
const cursor = (code: RoomCode, name: string) => inRoom(code, r => session.get(r.store, name, 'cursor') || 0);
const shown = (code: RoomCode, name: string) => inRoom(code, r => session.shown(r.store, name));
const H1 = 'abcdef012345', H2 = 'bbbbbbbbbbbb';
const prop = (code: RoomCode, from: string, hash: string, approvers: string[]) => inRoom(code, r => r.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via: 'agent', from }));

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
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                   // #15 decision on mine: a notice, no wake
  say(code, 'bob', 'words an old retract names');                                         // #16 push: chat
  // #17 an old log's retract line (nothing writes one now): an ordinary system line, pull
  fs.appendFileSync(inRoom(code, r => fsStore(r.store).logFile), JSON.stringify({ id: 17, at: new Date().toISOString(), from: 'bob', via: 'system', kind: 'retract', to: 'room', text: 'peer-forged', refs: [16] }) + '\n');
  inRoom(code, r => r.append({ kind: 'task', op: 'update', id: 2, subject: 'docs', owner: 'alice', status: 'pending' }, { via: 'system', from: 'claude', system: true })); // #18 push
  say(code, 'bob', 'last ' + 'w'.repeat(600));                                            // #19 push, full text
  t.advance(2000);
  assert.equal(t.writes, 1, 'one burst, one write');
  // group chat (people's words, joins): the person sees it, no wake
  assert.deepEqual(t.of('chat').flatMap(x => x.lines), [
    'bob: bob says hi',
    'carol joined',
    'room: "claude proposes" (abcdef) decided (room decision)', // the decision names its proposal
    'bob: words an old retract names',
    'bob: last ' + 'w'.repeat(390), // long text wraps at 400 code points
    '  │ ' + 'w'.repeat(210), // a continuation line is nested under its sender
  ], t.text());
  // what needs Claude now: one wake
  assert.deepEqual(t.of('wake').flatMap(x => x.text.split('\n')).filter(l => !l.startsWith('(for Claude)')), [
    "bob's Claude (to you): q for alice",
    'claude proposed: claude proposes (bbbbbb)',
    "carol's Claude: carol: anyone on @alice docs?",
    'room: task "docs" pending, owner you',
  ], t.text());
  assert.match(t.of('pull').map(x => x.text).join('\n'), /\nroom: peer-forged\n/, 'the old retract: an ordinary pull line');
  assert.doesNotMatch(t.chat().join('\n'), /#\d/, 'no ids in what the human sees');
  assert.deepEqual(t.forClaude().map(l => l.slice(0, 40)), ["(for Claude) to answer bob's Claude: Sen", '(for Claude) room now: proposal bbbbbb w']);
  assert.equal(t.forClaude()[0], `(for Claude) to answer bob's Claude: SendMessage bob.${code}`, 'a post to me names how to answer its Claude');
  assert.match(must(must(t.of('rows').at(-1)).text), /SUB-HUMAN ROWS: your room row is not running/, 'the missing row is the rows event');
  assert.ok(must(t.forClaude()[1]).startsWith(`(for Claude) room now: proposal ${H2.slice(0, 6)} waiting on alice · you: answer needed (`), t.forClaude()[1]);
  assert.ok(must(t.forClaude()[1]).includes(`"proposal ${H2}"`), 'the card call carries the full hash');
  assert.equal(cursor(code, 'alice'), 19);
  assert.ok(shown(code, 'alice').has(12), 'the join is recorded as shown (a restarted child does not repeat it)');
  assert.deepEqual(t.errs, []);
});

test('tail (room-plan live): a task added with me as its suggested owner is a chat line that says so, and no wake', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');                                                        // #1
  const t = startTail();
  t.advance(300);
  inRoom(code, r => r.append({ kind: 'task', op: 'add', id: 2, subject: 'handler tests', status: 'pending', suggest: 'alice' }, { via: 'system', from: 'room', system: true })); // #2
  t.advance(1000);
  assert.deepEqual(t.lines(), ['room: task "handler tests" pending, suggested for you (claim it to take it)'], t.text());
  assert.deepEqual(t.of('wake'), []);
});

test('tail (live repro): another member\'s new version of a plan I asked to sign off and objected to wakes my Claude, saying so', () => {
  h.freshHome();
  const { code } = h.register('alice');
  h.register('bob', 'member', 1, code);
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');
  const store = room.open(code).store;
  plans.put(store, { base: 0, text: 'hello world' }, { by: 'alice' });
  const a = proposal.ask({ code, name: sn('alice') }, {});
  assert.ok(proposal.answer({ code, name: sn('alice') }, a, { choice: 'Object', notes: 'ask bob' }).entry);
  const t = startTail();
  t.advance(300);
  plans.put(store, { base: 1, text: 'goodbye world' }, { by: 'bob' });
  t.advance(1000);
  const wake = t.of('wake').flatMap(x => x.text.split('\n'));
  // noise pass F: no "for bob" when the Claude is bob's own, no hash
  assert.deepEqual(wake.filter(l => !l.startsWith('(for Claude)')), ["bob's Claude: plan room v2", '  │ retires the sign-off request for plan room v1'], t.text());
  assert.ok(wake.some(l => l.startsWith('(for Claude) this v2 of plan room comes after v1, whose sign-off alice asked for; objected: alice.')), t.text());
});

test('tail: a member sees every join as a chat line; with its room row running, no row-call invite', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');                         // #1
  const t = startTail();
  t.advance(300);
  sys(code, 'member_joined', 'bob');                           // #2 the room row nests bob by itself: a chat line only
  say(code, 'bob', 'hi');                                      // #3
  t.advance(1000);
  assert.deepEqual(t.lines(), ['bob joined', 'bob: hi'], t.text());
  assert.doesNotMatch(t.text(), /Agent|row:/);
});

test('tail (noise pass E): a decision the consent hook already told the model is the person\'s notice only; the SendMessage hint goes once per peer', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');
  const t = startTail();
  t.advance(300);
  prop(code, 'alice', H1, ['alice']);
  const d = sys(code, 'decision', 'room', { proposal_hash: H1, text: 'agreed: alice', approvers: ['alice'] });
  inRoom(code, r => session.markReported(r.store, 'alice', [d.id]));
  t.advance(1000);
  assert.ok(t.chat().some(l => /agreed/.test(l)), t.text());
  assert.equal(t.of('pull').length, 0, 'no room-context copy of what the model was told');
  const ask = () => inRoom(code, r => r.append({ kind: 'say', text: 'look?', to: 'alice' }, { via: 'agent', from: 'bob' }));
  ask(); t.advance(1000); ask(); t.advance(1000);
  assert.equal(t.forClaude().filter(l => l.includes('to answer bob\'s Claude: SendMessage')).length, 1, t.text());
});

test('tail (noise pass F): a plan version and its sign-off request in one batch are one line, the request\'s, with the summary', () => {
  h.freshHome();
  const { code } = h.register('alice');
  h.register('bob', 'member', 1, code);
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');
  const t = startTail();
  t.advance(300);
  const store = room.open(code).store;
  plans.put(store, { base: 0, text: '# Paging\n\nopaque cursor', summary: 'opaque cursor' }, { by: 'bob' });
  proposal.ask({ code, name: sn('bob') }, {});
  t.advance(1000);
  assert.deepEqual(t.lines().filter(l => !l.startsWith('(for Claude)')), ["bob's Claude asks you and bob to sign off on plan room v1: opaque cursor"], t.text());
});

test('tail (noise pass A): a machine its PIN let in shows its check and the kick as the join notice, once', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');
  const t = startTail();
  t.advance(300);
  const notice = 'bob joined from bobs-mbp (check 3f9c-2a71) · not them? /sub-human kick bob';
  sys(code, 'status', 'room', { text: notice });
  sys(code, 'member_joined', 'bob');
  t.advance(1000);
  assert.deepEqual(t.chat(), [`room: ${notice}`], t.text());
  assert.equal(t.of('wake').length, 0, 'no wake: the person acts on it, not Claude');
});

/** The room session's wakes: each ends with the one line telling it what to do (lib/tail.ts formatRoomClaudeBatch). */
const rowsTurns = (t: { lines(): string[] }): number => t.lines().filter(l => l.startsWith('Make only the call its row note names')).length;

test('tail: the room session is woken only by a join whose row is not running: no post to it, no answer, no decision, no task request', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  sys(code, 'member_joined', 'claude');
  const t = startTail({ deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  inRoom(code, r => r.append({ kind: 'status', text: 'alice claude idea' }, { via: 'agent', from: 'alice' })); // #2
  say(code, 'bob', 'bob words', { to: 'alice' });                                              // #3
  prop(code, 'claude', H1, ['alice', 'bob']);                                                    // #4
  say(code, 'alice', '', { kind: 'objection', proposal_hash: H1, text: 'no' });                // #5
  inRoom(code, r => r.append({ kind: 'task_req', op: 'add', subject: 'parser tests' }, { via: 'agent', from: 'bob' })); // #6
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                        // #7
  say(code, 'alice', 'end', { to: 'claude' });                                                 // #8: no @claude any more, and a post to it is no wake
  sys(code, 'member_joined', 'carol');                                                         // #9: her row is not running
  t.advance(1500);
  assert.deepEqual(t.ids(), [9], t.text());
  assert.equal(rowsTurns(t), 1);
  assert.match(t.text(), /#9 carol\[system\] member_joined .* · row: carol has no row running; spawn it now: Agent sub-human:participant/);
  assert.match(t.text(), /Make only the call its row note names, then end your turn with the one word "ok"\./);
  assert.doesNotMatch(t.text(), /room now:/, 'no room state: it reads nothing else');
});

test('tail: a member_joined notice says whether that row already runs (live holds), for the room\'s Claude', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  const t = startTail({ deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  sys(code, 'member_joined', 'bob');                                     // #1 first join: no row yet, pushed with the call
  t.advance(1500);
  assert.match(t.text(), /member_joined/);
  rows.writeHolds(code, sn('claude'), { members: ['bob'] });                   // the room Claude's bob row is now held
  sys(code, 'member_left', 'bob');                                       // #2 pull
  sys(code, 'member_joined', 'bob');                                     // #3 rejoin: the row survived, not pushed
  say(code, 'bob', 'back', { to: 'claude' });                            // #4: no wake
  t.advance(1500);
  assert.deepEqual(t.ids(), [1], t.text());
  assert.match(must(t.entries()[0]), /^#1 bob\[system\] member_joined .* · row: bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
});

test('tail: the room session settles longer by default (two joins 2 s apart are one batch: one rows turn)', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  sys(code, 'member_joined', 'claude');
  const t = startTail({ timings: DEFAULTS, deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  sys(code, 'member_joined', 'alice');                                  // #2
  t.advance(2000);
  sys(code, 'member_joined', 'bob');                                    // #3
  t.advance(2900);
  assert.equal(t.text(), '', 'still settling: 3 s of quiet after #3');
  t.advance(500);
  assert.deepEqual(t.ids(), [2, 3], t.text());
  assert.equal(rowsTurns(t), 1, t.text());
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

test('tail: startCursor: the saved cursor, else the latest join, else the log\'s end', () => {
  // a fake room with the one call startCursor makes; its entry and the seats carry only the fields it reads
  const rm: Parameters<typeof tailLib.startCursor>[0] = { readView: () => [{ id: 7, kind: 'member_joined', from: 'claude' } as Entry] }; // deliberate: a partial entry
  const claude = ident(rc('vole-0000'), 'claude', 'claude');
  assert.equal(tailLib.startCursor(rm, 5, claude, 9), 5, 'the session document\'s cursor');
  assert.equal(tailLib.startCursor(rm, 0, claude, 9), 7, 'no cursor: its latest join');
  assert.equal(tailLib.startCursor(rm, 0, ident(rc('vole-0000'), 'bob', 'member'), 9), 9, 'no join: the log\'s end');
});

test('tail: survives a restart via its cursor (no read from byte 0); switches when the session changes rooms', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');                         // #1
  say(code, 'bob', 'history');                                 // #2: after the join, so it is delivered
  const reads: number[] = [];
  const big = 'x'.repeat(1000);
  const spyFs = { ...fs, readSync: ((fd: number, buf: NodeJS.ArrayBufferView, off: number, len: number, pos: number) => { reads.push(pos); return fs.readSync(fd, buf, off, len, pos); }) as typeof fs.readSync };
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
  const flakyFs = { ...fs, statSync: ((...x: [fs.PathLike]) => { if (statFails > 0) { statFails--; throw Object.assign(new Error('EIO: injected read error'), { code: 'EIO' }); } return fs.statSync(...x); }) as typeof fs.statSync };
  const flakyRoom = (c: RoomCode) => { const r = room.open(c); return { ...r, readView: (...x: Parameters<Room['readView']>) => { if (viewFails > 0 && !(x[0] && x[0].after === Infinity)) { viewFails--; throw new Error('injected view error'); } return r.readView(...x); } }; };
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
  assert.match(must(t.errs[0]), /^sub-human tail: poll failed: EIO: injected read error; retrying\n$/);
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
  must(t.handle.session()).killPoll();
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
  const file = inRoom(code, r => fsStore(r.store).logFile);
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
  const calls: string[] = [];
  const t = startTail({ deps: { roomClaude: { watchdog: c => { calls.push(c); if (calls.length === 2) throw new Error('watchdog boom'); return 'live'; } } } });
  t.advance(FAST.healthMs * 3 + 100);
  assert.deepEqual(calls, [code, code, code], 'it keeps going after a throw');
  assert.match(t.errs.join(''), /health check failed: watchdog boom/);
  t.stop();
  h.freshHome();
  h.register('alice');
  const mcalls: string[] = [];
  const m = startTail({ deps: { roomClaude: { watchdog: c => { mcalls.push(c); return 'live'; } } } });
  m.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(mcalls, []);
});

test('tail: --max-seconds stops it with no timer left', () => {
  h.freshHome();
  h.register('alice');
  const clock = createFake({ now: Date.now() });
  tailLib.runTail({ clock, lookup: () => identity.resolveByPid(process.pid), timings: FAST, write: (_s, d) => d(), err: () => {}, maxSeconds: 2 });
  clock.advance(2000);
  assert.equal(clock.pending(), 0);
});

test('Batcher: settles on quiet, cuts at the max window, keeps young items, retries a failed flush', () => {
  const clock = createFake();
  const out: number[][] = [];
  let fail = 0;
  const b = new tailLib.Batcher<{ e: { id: number } }>({
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
  const beats: string[] = [];
  const t = startTail({ deps: { heartbeat: me => beats.push(`${me.code}/${me.name}`) } });
  t.advance(FAST.healthMs * 2 + 100);
  assert.ok(beats.length >= 2 && beats.every(b => b === `${code}/alice`), beats.join(','));
});

test('stage 8e G (live verify, remote/99x): an invite\'s join request is one wake for the host\'s seat: its first line the person\'s, the rest (for Claude); no chat line of its own', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const q: { ref: string; told: string[] } = { ref: 'a6a8c73830ec', told: [] };
  const adm = {
    lapse: () => [], pending: () => (q.told.length ? [] : [q]), targets: () => ['alice'], describe: () => 'bob (check 59e9-554c) on mac',
    markTold: (_c: string, _r: string, n: string) => { q.told.push(n); },
  } as unknown as NonNullable<NonNullable<TailOpts['deps']>['admission']>; // deliberate: a fake with only what the tail calls
  const t = startTail({ deps: { admission: adm } });
  t.advance(FAST.healthMs * 2 + 100);
  const wakes = t.of('wake');
  assert.equal(wakes.length, 1, t.out);
  const [shown, ...rest] = must(wakes[0]).text.split('\n');
  assert.equal(shown, 'room: bob (check 59e9-554c) on mac typed your invite line without its PIN and asks to join; your Claude shows you a card (or: /sub-human admit a6a8c73830ec)');
  assert.ok(rest.length && rest.every(l => l.startsWith('(for Claude) ')), rest.join('|'));
  assert.equal(t.of('chat').length, 0);
});

test('tail: on the host the health tick sweeps the seats (lib/seats.ts sweep); a room hosted elsewhere never does (nor repairs tasks)', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const swept: string[] = [];
  const t = startTail({ deps: { sweepSeats: c => swept.push(c) } });
  t.advance(FAST.healthMs * 2 + 100);
  assert.ok(swept.length >= 2 && swept.every(c => c === code), swept.join(','));
  t.stop();
  const mswept: string[] = [];
  const remote = (c: RoomCode) => { const r = room.open(c); return { ...r, store: { ...r.store, isHost: false } }; };
  const mrepaired: string[] = [];
  const m = startTail({ deps: { openRoom: remote, linkStatus: () => ({ running: true, state: 'online' }) as LinkStatus, sweepSeats: c => mswept.push(c),
    repairTasks: c => mrepaired.push(c), roomSessionDown: () => true } });
  m.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(mswept, []);
  assert.deepEqual(mrepaired, [], 'nor repairs the task files: they are the host\'s');
});

test('tail: on the host a member\'s health tick repairs the task files only while the room session is down; the room session\'s always', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  let down = false;
  const repaired: string[] = [];
  const t = startTail({ deps: { repairTasks: c => repaired.push(c), roomSessionDown: () => down } });
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(repaired, [], 'the room session is up: it repairs them itself');
  down = true;
  t.advance(FAST.healthMs * 2 + 100);
  assert.ok(repaired.length >= 2 && repaired.every(c => c === code), repaired.join(','));
  // a room hosted elsewhere never repairs (the files are the host's): the seat-sweep test below
});

test('tail: roomSessionDown (the default): a recorded task list whose room session holds no seat, not closing', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const repaired: string[] = [];
  const run = () => { const t = startTail({ deps: { repairTasks: c => repaired.push(c) } }); t.advance(FAST.healthMs + 100); t.stop(); const n = repaired.length; repaired.length = 0; return n > 0; };
  assert.equal(run(), false, 'no room session record');
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', tasks_dir: '/x/tasks/sh-' + code }));
  assert.equal(run(), true, 'spawned, never bound');
  const o = h.spawnSleeper();
  identity.join({ code, name: sn('claude'), role: 'claude', pid: o.pid, session_id: 'so' });
  assert.equal(must(identity.readMembers(code).claude).tasks_dir, '/x/tasks/sh-' + code, 'the recorded list survives the bind');
  assert.equal(run(), false, 'bound and live');
  o.kill();
  await h.until(() => !identity.isAlive(o.pid));
  assert.equal(run(), true, 'its process died');
  identity.updateRoomClaude(code, () => ({ closing: new Date().toISOString() }));
  assert.equal(run(), false, 'closing');
});

/** The link daemon's status as linkStatus answers it; the fakes below carry only what the tail reads. */
type LinkStatus = ReturnType<typeof linkMod.status>;
interface FakeLink {
  running: boolean;
  state: string;
  reason?: string;
  queued?: number;
  flush?: { at: string; sent: number; unsent: { text: string; why: string }[] };
}

// ---------- the events as the mod routes them ----------
const startNd = startTail;

test('tail: a member batch is chat + pull, a line to me is a wake; it says its seat', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
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
  assert.deepEqual(must(t.of('chat')[0]).lines, ['bob joined', 'bob: bob says hi']);
  const pull = must(t.of('pull')[0]).text.split('\n');
  assert.equal(pull[0], tailLib.PULL_HEAD);
  assert.deepEqual(pull.slice(1), ['bob joined', 'bob: bob says hi', "bob's Claude: bob claude chatter"], 'the pull lane plus the chat copy (noise pass E: no end line)');
  const wake = must(t.of('wake')[0]).text.split('\n');
  assert.deepEqual(wake.slice(0, 4), ['bob: @alice can you look?', "bob's Claude (to you): q for alice", `(for Claude) to answer bob's Claude: SendMessage bob.${code}`, 'claude proposed: claude proposes (bbbbbb)']);
  assert.ok(must(wake[4]).startsWith(`(for Claude) room now: proposal ${H2.slice(0, 6)}`), wake[3]);
  assert.equal(cursor(code, 'alice'), 7);
  assert.ok(shown(code, 'alice').has(2), 'the join is recorded as shown');
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
  assert.match(must(must(r[0]).text), /^SUB-HUMAN ROWS: your room row is not running/);
  t.advance(FAST.healthMs + 100);
  assert.equal(t.of('rows').length, 1, 'unchanged: not sent again');
  rows.writeHolds(code, sn('alice'), { room: true });
  t.advance(FAST.healthMs);
  r = t.of('rows');
  assert.equal(must(r.at(-1)).text, null, 'the row runs: cleared');
  prop(code, 'claude', H2, ['alice']);
  t.advance(FAST.healthMs);
  assert.match(must(must(t.of('rows').at(-1)).text), new RegExp(H2.slice(0, 6)), 'a proposal awaiting me is reminded');
});

test('tail: the room session gets a join as one wake (its rows turn); nothing as pull or chat', () => {
  h.freshHome();
  const { code } = h.register('claude', 'claude');
  rows.writeHolds(code, sn('claude'), { members: ['bob'] });
  const t = startNd({ sid: 'so', deps: { roomClaude: { watchdog: () => 'live' } } });
  t.advance(300);
  say(code, 'bob', 'please add tests', { to: 'claude' });                               // #1: none
  say(code, 'bob', 'bob to the room');                                                  // #2: none
  sys(code, 'member_joined', 'carol');                                                  // #3: wake (no row)
  t.advance(2000);
  assert.deepEqual([t.of('chat'), t.of('pull')], [[], []]);
  const wake = t.of('wake');
  assert.equal(wake.length, 1);
  assert.match(must(wake[0]).text, /^#3 carol\[system\] member_joined/);
});

test('tail: a member\'s wake carries the room state without entry ids (the person sees the plugin prompt\'s row); the room\'s Claude\'s keeps them', () => {
  h.freshHome();
  const { code } = h.register('alice');
  rows.writeHolds(code, sn('alice'), { room: true });
  sys(code, 'member_joined', 'alice');                                                  // #1
  const t = startNd({ sid: 's' });
  t.advance(300);
  prop(code, 'claude', H1, ['alice']);                                                    // #2
  say(code, 'alice', '', { kind: 'signoff', proposal_hash: H1, text: 'ok' });           // #3 own
  sys(code, 'decision', 'room', { proposal_hash: H1 });                                 // #4 a decision on mine: a notice
  const kept = room.open(code).stateLine({ name: 'claude', role: 'claude' }, room.open(code).readAll());
  prop(code, 'claude', H2, ['alice']);                                                    // #5 a sign-off request: wake
  t.advance(2000);
  const state = t.of('wake').flatMap(x => x.text.split('\n')).filter(l => l.startsWith('(for Claude) room now:'));
  assert.ok(state.length >= 1, t.out);
  for (const l of state) assert.doesNotMatch(l, /#\d/, l);
  assert.match(kept, /decided #4/);
});

test('tail: a room hosted elsewhere: one OFFLINE line when the link goes down, one "back online" line once it is online again', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  let st: FakeLink = { running: true, state: 'online' };
  const remote = (c: RoomCode) => { const r = room.open(c); return { ...r, store: { ...r.store, isHost: false } }; };
  const t = startTail({ deps: { openRoom: remote, linkStatus: () => st as LinkStatus } });
  const health = () => t.of('health').map(x => x.text);
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(health(), [], 'nothing while it is up');
  st = { running: true, state: 'offline', reason: 'the connection to the host closed' };
  t.advance(FAST.healthMs * 2 + 100);
  assert.equal(health().length, 1, health().join('\n'));
  assert.match(must(health()[0]), /^the connection to room \S+ is down \(the connection to the host closed\); @room posts wait and go out when it's back/);
  st = { running: true, state: 'connecting' };
  t.advance(FAST.healthMs + 100);
  assert.equal(health().length, 1, 'connecting is not back yet');
  st = { running: true, state: 'online' };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(1), [tailLib.LINK_BACK], 'once');
  assert.equal(tailLib.LINK_BACK, 'the connection to the room is back; @room posts go through again');
  // down again; back with the queued posts sent: the one back-online line says so
  st = { running: true, state: 'offline', reason: 'x', queued: 2 };
  t.advance(FAST.healthMs * 2 + 100);
  st = { running: true, state: 'online', flush: { at: 'a', sent: 2, unsent: [] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(3), [`${tailLib.LINK_BACK}; 2 waiting @room post(s) sent`]);
  // a brief outage the tail never saw: posts sent quietly; one that was not sent is told
  st = { running: true, state: 'online', flush: { at: 'b', sent: 1, unsent: [] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.equal(health().length, 4, 'sent quietly');
  st = { running: true, state: 'online', flush: { at: 'c', sent: 0, unsent: [{ text: 'hi', why: 'it waited too long' }] } };
  t.advance(FAST.healthMs * 2 + 100);
  assert.deepEqual(health().slice(4), ['not sent (it waited too long): "hi"']);
});

test('remindersText: the one a review opens next (the oldest unless named), the others listed by short hash and plan', () => {
  h.freshHome();
  const { code } = h.register('alice');
  const me = ident(code, 'alice', 'member');
  const v = (from: string, hash: string, plan: string, version: number) => inRoom(code, r => r.append({ kind: 'plan', text: `plan ${plan} v${version}`, hash, path: `plans/${hash}.md`,
    plan, version, base: version - 1, for: from }, { via: 'agent', from, system: true }));
  const p = (from: string, hash: string, title: string) => inRoom(code, r => r.append({ kind: 'proposal', text: `proposal ${hash}: ${title}`, hash, approvers: ['alice'] }, { via: 'agent', from }));
  v('bob', 'aaaaaaaaaaaa', 'friday', 1);
  p('bob', 'aaaaaaaaaaaa', 'plan friday v1');
  p('carol', 'cccccccccccc', 'Rate limits'); // a request from before plans: named by its title
  v('bob', 'dddddddddddd', 'monday', 1);
  p('bob', 'dddddddddddd', 'plan monday v1');
  const text = must(tailLib.remindersText(me, room.open(code)));
  assert.match(text, /^plan friday v1 \(proposal aaaaaaaaaaaa\) still awaits alice's sign-off/);
  assert.match(text, /\(2 more await alice's answer: cccccc "Rate limits", dddddd "plan monday v1"; the hooks open whichever plan alice names, else the oldest\.\)$/);
  // a newer version of plan friday retires the request on v1: it is no longer listed
  v('carol', 'eeeeeeeeeeee', 'friday', 2);
  assert.doesNotMatch(must(tailLib.remindersText(me, room.open(code))), /aaaaaa/);
  assert.equal(tailLib.remindersText({ ...me, role: 'claude' }, room.open(code)), null);
});

test('remindersText: a note of mine waiting on the picked proposal points at the confirm card, not a new review', () => {
  h.freshHome();
  const { code } = h.register('alice');
  const me = ident(code, 'alice', 'member');
  inRoom(code, r => r.append({ kind: 'proposal', text: 'proposal dddddddddddd: Ship v3 Monday', hash: 'dddddddddddd', approvers: ['alice'] }, { via: 'agent', from: 'bob' }));
  // a note on another proposal: the ordinary reminder
  proposal.writeConfirm(me, { hash: 'aaaaaaaaaaaa', note: 'open rate limiting', from: 'bob', title: null, at: Date.now() });
  assert.match(must(tailLib.remindersText(me, room.open(code))), /^proposal dddddddddddd still awaits alice's sign-off/);
  // waiting, not yet offered again: show it now, as consent's reoffer on the same prompt says (never a softer line)
  const cf = { hash: 'dddddddddddd', note: 'open rate limiting', from: 'bob', title: 'Ship v3 Monday', at: Date.now() };
  for (const extra of [{}, { stage: 'waiting' as const }, { stage: 'nudged' as const }]) {
    proposal.writeConfirm(me, { ...cf, ...extra });
    assert.equal(tailLib.remindersText(me, room.open(code)),
      'proposal dddddddddddd: alice\'s note is not recorded yet. First, call AskUserQuestion with "objection dddddddddddd". Don\'t reopen the review (that drops the note).');
  }
  // shown and interrupted (asked, no answer): the Esc is said to be no answer, as consent's reoffer says it
  for (const extra of [{ stage: 'asked' as const }]) {
    proposal.writeConfirm(me, { ...cf, ...extra });
    assert.equal(tailLib.remindersText(me, room.open(code)),
      'proposal dddddddddddd: alice\'s note is not recorded yet. Esc was no answer, not a decline. First, call AskUserQuestion with "objection dddddddddddd". Don\'t reopen the review (that drops the note).');
  }
  // offered again (or its no-answer close told): the card is alice's to ask for
  for (const extra of [{ stage: 'reoffered' as const }, { stage: 'told' as const }]) {
    proposal.writeConfirm(me, { ...cf, ...extra });
    assert.equal(tailLib.remindersText(me, room.open(code)),
      'proposal dddddddddddd: alice\'s note waits to be sent or discarded; if alice asks, call AskUserQuestion with "objection dddddddddddd". Don\'t reopen the review (that drops the note).');
  }
});

test('tail: a session with no seat and a PIN join waiting looks again every resolveMs; let in, it asks the module once to take the seat (PLAN-JOIN step 3), or says why it stopped', () => {
  h.freshHome();
  const clock = createFake({ now: Date.now() });
  const out: string[] = [];
  let news: { state: 'waiting' | 'linked' | 'refused'; code: RoomCode; text: string; name?: string; line?: string; check?: string } | null = { state: 'waiting', code: rc('vole-1234'), text: '' };
  let asked = 0;
  tailLib.runTail({
    clock, lookup: () => null, timings: { ...FAST, resolveMs: 100, unseatedMs: 5000 }, sid: 'sid-1', err: () => {},
    write: (s, d) => { out.push(s); d(); },
    deps: { pendingNews: (sid: string) => { asked++; assert.equal(sid, 'sid-1'); return news; } },
  });
  const evs = () => out.flatMap(s => s.split('\n').filter(Boolean)).map(l => JSON.parse(l) as TailEvent);
  const chat = () => evs().filter((e): e is EventOf<'chat'> => e.type === 'chat');
  const takes = () => evs().filter((e): e is EventOf<'take'> => e.type === 'take');
  clock.advance(350);
  assert.ok(asked >= 3, `waiting: asked again every resolveMs (${asked})`);
  assert.deepEqual(chat(), []);
  // let in: the command's own answer said so (text ''), the take event goes out all the same, once, with the line for
  // the person when the module cannot take it and this machine's check; never as chat
  const line = 'the host let you in to room vole-1234: type /sub-human to join it as bob';
  news = { state: 'linked', code: rc('vole-1234'), text: '', name: 'bob', line, check: 'check 3f9c-2a71' };
  clock.advance(100);
  const before = asked;
  clock.advance(1000);
  assert.ok(asked - before >= 5, `taking: it looks again every resolveMs, for the seat (${asked - before})`);
  clock.advance(20_000);
  assert.deepEqual(takes(), [{ type: 'take', code: 'vole-1234', name: 'bob', text: line, check: 'check 3f9c-2a71' }], 'asked once');
  assert.deepEqual(chat(), [], 'the take is no chat line');
  news = { state: 'refused', code: rc('vole-1234'), text: 'could not join room vole-1234: the host refused to let this machine in' };
  clock.advance(5000);
  assert.equal(chat().length, 1);
  assert.deepEqual(must(chat()[0]).lines, [news.text]);
  const after = asked;
  clock.advance(10_000);
  assert.ok(asked - after <= 2, 'no longer waiting: back to the unseated pace');
});

test('tail: a let-in join with no line of its own (the command said it) still asks for the take; a tail started again asks again (the take is idempotent)', () => {
  h.freshHome();
  for (let run = 0; run < 2; run++) {
    const t = startTail({ lookup: () => null, timings: { resolveMs: 100, unseatedMs: 5000 }, sid: 'sid-1', deps: { pendingNews: () => ({ state: 'linked', code: rc('vole-1234'), text: '' }) } });
    t.advance(2000);
    assert.deepEqual(t.events().filter(e => e.type !== 'seat'), [{ type: 'take', code: 'vole-1234', name: '', text: '' }]);
    t.stop();
  }
});

test('tail: a session with no seat and no join of its own says nothing (and never looks without a session id)', () => {
  h.freshHome();
  const clock = createFake({ now: Date.now() });
  const out: string[] = [];
  let asked = 0;
  tailLib.runTail({ clock, lookup: () => null, timings: FAST, sid: null, err: () => {}, write: (s, d) => { out.push(s); d(); }, deps: { pendingNews: () => { asked++; return null; } } });
  clock.advance(30_000);
  assert.equal(asked, 0);
  assert.equal(out.join('').includes('"chat"'), false);
});

test('tail: on the host, the room\'s open invite refs each time they change, so the module takes a used, burnt, cancelled or expired one off its status line (item 2)', () => {
  h.freshHome();
  const { code } = h.register('alice');
  sys(code, 'member_joined', 'alice');
  const now = Date.now();
  const rec = (o: Record<string, unknown> = {}) => ({ v: 4, short: true, kind: 'pipe', tries: 5, created_at: new Date(now).toISOString(), expires_at: new Date(now + 15 * 60_000).toISOString(), ...o });
  inRoom(code, r => r.store.kv.set('remote/invites', { ['a'.repeat(64)]: rec(), ['b'.repeat(64)]: rec() }));
  const t = startNd({ sid: 'sid-a' });
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(t.of('invites').map(e => e.open), [['aaaaaaaaaaaa', 'bbbbbbbbbbbb']]);
  t.advance(FAST.healthMs + 100);
  assert.equal(t.of('invites').length, 1, 'nothing changed: nothing said');
  inRoom(code, r => r.store.kv.set('remote/invites', { ['a'.repeat(64)]: rec({ used_at: new Date(now).toISOString() }), ['b'.repeat(64)]: rec({ burnt_at: new Date(now).toISOString() }) }));
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(t.of('invites').map(e => e.open), [['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], []]);
  assert.equal(t.of('invites').at(-1)?.expired, undefined, 'used and cancelled: not expired');
  // noise pass H: one that lapses unused is named, so the module tells the person who made it
  inRoom(code, r => r.store.kv.set('remote/invites', { ['c'.repeat(64)]: rec({ expires_at: new Date(t.clock.now() + 2 * FAST.healthMs).toISOString() }) }));
  t.advance(FAST.healthMs + 100);
  assert.deepEqual(t.of('invites').at(-1)?.open, ['cccccccccccc']);
  t.advance(2 * FAST.healthMs);
  assert.deepEqual(t.of('invites').at(-1), { type: 'invites', open: [], expired: ['cccccccccccc'] });
  t.stop();
});

test('tail (item 15): a seated session (a kicked machine whose copy still shows the seat) is told too when the host lets its new join in', () => {
  h.freshHome();
  const { code } = h.register('bob');
  sys(code, 'member_joined', 'bob');
  const text = `the host let you in to room ${code}: type /sub-human to join it as bob`;
  const t = startNd({ sid: 'sid-b', deps: { pendingNews: () => ({ state: 'linked', code, text }) } });
  t.advance(FAST.resolveMs * 3 + 100);
  assert.deepEqual(t.of('chat').filter(e => e.lines.includes(text)).length, 1, 'said once');
  t.stop();
});

test('tail (stage 8f item 2, live verify, verify10/remote/05f): a second join\'s let-in is said even word for word the first one\'s, once the first took its seat', () => {
  h.freshHome();
  const { code } = h.register('bob');
  sys(code, 'member_joined', 'bob');
  const text = `the host let you in to room ${code}: type /sub-human to join it as bob`;
  let news: { state: 'waiting' | 'linked'; code: RoomCode; text: string } | null = { state: 'linked', code, text };
  const t = startNd({ sid: 'sid-b', deps: { pendingNews: () => news } });
  t.advance(FAST.resolveMs * 3 + 100);
  // bob took the seat (no join waits), was kicked, typed a new invite line and PIN: waiting, then let in again
  news = null;
  t.advance(FAST.resolveMs * 3 + 100);
  news = { state: 'waiting', code, text: '' };
  t.advance(FAST.resolveMs * 3 + 100);
  news = { state: 'linked', code, text };
  t.advance(FAST.resolveMs * 3 + 100);
  assert.equal(t.of('chat').filter(e => e.lines.includes(text)).length, 2, 'said for each join');
  t.stop();
});
