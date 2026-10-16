// Join / leave lines (lib/room/render.ts joinLeave, noticeText, rowSegment; shown ones in lib/room/session.ts) and where they surface: the tail child's chat events (scripts/sub-human
// tail), the room row text (lib/rows.ts) and the room hold's progress line (mcp/hold.ts). Nothing here sleeps:
// the tail runs on a fake clock and the hold on node:test's mock timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as h from './helpers.ts';
import * as render from '../lib/room/render.ts';
import * as session from '../lib/room/session.ts';
import * as rows from '../lib/rows.ts';
import * as room from '../lib/room.ts';
import * as identity from '../lib/identity.ts';
import * as tailLib from '../lib/tail.ts';
import { createFake } from '../lib/clock.ts';
import * as seats from '../lib/seats.ts';
import * as config from '../lib/config.ts';
import * as seatKey from '../hooks/seat-key.ts';
import * as hold from '../mcp/hold.ts';
import type { Room } from '../lib/room.ts';
import type { FakeClock } from '../lib/clock.ts';
import type { Entry, Member, Members } from '../lib/room/types.ts';
import type { Me, ToolResult } from '../mcp/types.ts';
import * as hostLinksForSeats from '../lib/remote/host-links.ts';
import type { RoomCode } from '../lib/brand.ts';
import { rc, sn, mid, eid } from './support/brands.ts';
import { must } from './support/must.ts';
/** A remote seat's link on the host (lib/remote/server.ts binds every remote seat to one; the sweep lets a seat no
 * link names leave). */
const linkFor = (code: RoomCode, name: string) => hostLinksForSeats.create(room.open(code).store, { id: hostLinksForSeats.newLinkId(), machine: mid('far-away'), seats: [name] });
let R: Room | null = null; // the room under test (set per test)
/** The join / leave notices as these tests use them: render.ts's, and the shown ones in the seat's session document. */
const notices = {
  joinLeave: render.joinLeave, text: render.noticeText, rowSegment: render.rowSegment,
  shown: (code: RoomCode, name: string) => session.shown(room.open(code).store, name),
  markShown: (code: RoomCode, name: string, ids: number[], via: string, opts?: { now?: number }) => session.markShown(room.open(code).store, name, ids, via, opts),
};

const CODE = rc('stoat-3644');
const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const mv = (id: number, kind: string, from: string, s: number, text?: string): Entry => ({ id: eid(id), at: at(s), from, via: 'system', kind, to: 'room', text: text || `${from} ${kind === 'member_left' ? 'left' : 'joined'}` });
const MEMBERS: Members = { claude: { name: sn('claude'), role: 'claude' }, alice: { name: sn('alice'), role: 'member' }, bob: { name: sn('bob'), role: 'member' } };

test('notices.joinLeave: others only, leaves settle after 8 s, a quick leave + rejoin is no notice', () => {
  const es: Entry[] = [
    mv(1, 'member_joined', 'alice', 0), mv(2, 'member_joined', 'claude', 1), mv(3, 'member_joined', 'bob', 10),
    { id: eid(4), at: at(11), from: 'bob', via: 'human', kind: 'say', text: 'hi' },
    mv(5, 'member_left', 'bob', 20), mv(6, 'member_joined', 'bob', 25, 'bob rejoined'), // back in 5 s: nothing
    mv(7, 'member_left', 'bob', 40), mv(8, 'member_joined', 'bob', 60, 'bob rejoined (resumed)'), // away 20 s
    mv(9, 'member_left', 'bob', 100),
  ];
  const ns = notices.joinLeave(es, 'alice', { now: T0 + 104_000, settle: 8000 });
  assert.deepEqual(ns.map(n => [n.id, n.kind, n.settled, n.rejoin]), [
    [3, 'member_joined', true, false], [7, 'member_left', true, false], [8, 'member_joined', true, true], [9, 'member_left', false, false],
  ], 'own join, the room\'s Claude, a say and the 5 s round trip are left out; #9 is still settling');
  assert.equal(must(notices.joinLeave(es, 'alice', { now: T0 + 108_000, settle: 8000 }).at(-1)).settled, true);
  assert.deepEqual(notices.joinLeave(es, 'bob', { now: T0 + 200_000 }).map(n => n.id), [1], 'bob sees only alice');
});

test('notices.joinLeave: a seat whose lease lapsed (lib/seats.ts sweep) and that beat again soon after is no notice', t => {
  h.freshHome(t);
  const code = h.newRoom();
  t.mock.method(seats.seam, 'startDetached', () => 1);
  if (!Object.values(hostLinksForSeats.links(room.open(code).store)).some(k => k.seats.includes('bob'))) linkFor(code, 'bob');
  assert.equal(seats.enter({ code, name: sn('bob'), machine: mid('far-away'), pubkey: seatKey.publicPem(code, sn('bob')) }).ok, true);
  const s = room.open(code).store;
  s.members.update(ms => { must(ms.bob).seen_at = new Date(Date.now() - config.SEAT_LEASE_MS - config.LEAVE_SETTLE_MS - 1000).toISOString(); return ms; });
  assert.deepEqual(seats.sweep(code), ['bob']);
  assert.equal(seats.back(code, sn('bob')), true);
  const es = room.open(code).readAll();
  assert.deepEqual(es.filter(e => e.from === 'bob').map(e => e.text), ['bob joined', 'bob left (connection lost)', 'bob rejoined']);
  assert.deepEqual(notices.joinLeave(es, 'alice', { now: Date.now() + 60_000, settle: 8000 }).map(n => n.name + ' ' + n.kind), ['bob member_joined'], 'only the first join');
});

test('notices.text and rowSegment: the one-line notice and the room row segment', () => {
  assert.equal(notices.text({ kind: 'member_joined', name: 'bob', rejoin: false }), 'bob joined');
  assert.equal(notices.text({ kind: 'member_joined', name: 'bob', rejoin: true }), 'bob rejoined');
  assert.equal(notices.text({ kind: 'member_left', name: 'bob', rejoin: false }), 'bob left');
  const es = [mv(1, 'member_joined', 'bob', 0)];
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 5_000 }), '+bob joined');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 130_000 }), '', 'gone after 2 minutes');
  assert.equal(notices.rowSegment(es, 'bob', { now: T0 + 5_000 }), '', 'not my own join');
  es.push(mv(2, 'member_left', 'bob', 30));
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 33_000 }), '+bob joined', 'the leave is still settling');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 39_000 }), '−bob left');
});

test('notices.text and rowSegment: a leave carries the chat line\'s short reason (render.ts leftWhy)', () => {
  assert.equal(notices.text({ kind: 'member_left', name: 'bob', rejoin: false, why: ' (connection lost)' }), 'bob left (connection lost)');
  const es = [mv(1, 'member_joined', 'bob', 0), mv(2, 'member_left', 'bob', 30, 'bob left (connection lost)')];
  assert.equal(must(notices.joinLeave(es, 'alice', { now: T0 + 39_000 }).at(-1)).why, ' (connection lost)');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 39_000 }), '−bob left (connection lost)');
  es[1] = mv(2, 'member_left', 'bob', 30, 'bob left (prompt_input_exit)');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 39_000 }), '−bob left (session ended)', 'a SessionEnd token reads as the chat line does');
  es[1] = mv(2, 'member_left', 'bob', 30, 'bob left (left)');
  assert.equal(notices.rowSegment(es, 'alice', { now: T0 + 39_000 }), '−bob left', '/sub-human leave adds nothing');
  const t = rows.rowText(CODE, { viewer: 'alice', entries: [mv(1, 'member_left', 'bob', 0, 'bob left (session ended)')], members: MEMBERS, now: T0 + 12_000, taskSummary: '' });
  assert.match(t, /^−bob left \(session ended\)/, 'the room row (panel and statusline)');
});

test('rows.rowText: the room row leads with a recent join', () => {
  const es = [mv(1, 'member_joined', 'alice', 0), mv(2, 'member_joined', 'bob', 10)];
  const t = rows.rowText(CODE, { viewer: 'alice', entries: es, members: MEMBERS, now: T0 + 12_000, taskSummary: '' });
  assert.equal(t, '+bob joined · 2 here');
  assert.equal(rows.rowText(CODE, { viewer: 'alice', entries: es, members: MEMBERS, now: T0 + 400_000, taskSummary: '' }), '2 here');
});

test('notices shown / markShown: ids merge and sort; via is required', () => {
  h.freshHome();
  const code = h.newRoom();
  assert.deepEqual([...notices.shown(code, 'alice')], []);
  notices.markShown(code, 'alice', [5, 3], 'mod'); // the tail child's chat events
  notices.markShown(code, 'alice', [7, 3], 'mod');
  assert.deepEqual([...notices.shown(code, 'alice')], [3, 5, 7]);
  notices.markShown(code, 'alice', [9], 'mod', { now: T0 });
  assert.equal(must(must(session.read(room.open(code).store, 'alice').shown).log.at(-1)).at, at(0), 'markShown stamps the given time');
  // @ts-expect-error deliberate: no via, to see it refused
  assert.throws(() => session.markShown(room.open(code).store, 'alice', [6]), /via/);
  assert.throws(() => notices.markShown(code, 'alice', [6], 'model'), /via/);
  assert.throws(() => notices.markShown(code, 'alice', [6], 'monitor'), /via/, 'the Monitor is gone');
});

// ---------- the room hold's progress line ----------
// mcp/hold.ts polls on the global timers and Date, so node:test's mock timers drive it: no real waiting.
test('session document: one per seat; a seat an earlier sub-human kept in separate documents keeps them, migrated by the first write', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = room.open(code).store;
  // what 0.5.0-beta.15 kept per seat
  s.setCursor('deliver-alice', 41);
  s.kv.set('rows/notices-alice', { shown: [3, 5], log: [{ id: 5, via: 'mod', at: at(0) }] });
  s.kv.set('members/alice/review', { phase: 'shown', hash: 'abcdef012345', at: T0 });
  s.kv.set('members/alice/confirm', { hash: 'abcdef012345', note: 'wait', from: 'bob', title: 'x', at: T0 });
  s.kv.set('members/alice/pick', { hash: 'abcdef012345', at: T0 });
  s.kv.set('rows/holds-alice', { pid: process.pid, at: at(0), members: ['bob'], room: true });
  const old = session.read(s, 'alice');
  assert.deepEqual([old.cursor, must(old.shown).ids, must(old.review).phase, must(old.confirm).note, must(old.pick).hash, must(old.holds).members], [41, [3, 5], 'shown', 'wait', 'abcdef012345', ['bob']]);
  assert.deepEqual([...notices.shown(code, 'alice')], [3, 5], 'nothing shown twice after an upgrade');
  // the first write keeps every field, and from then on the document is the one place
  session.put(s, 'alice', 'cursor', 42);
  s.kv.delete('members/alice/review');
  const now = session.read(s, 'alice');
  assert.deepEqual([now.cursor, must(now.review).phase, must(now.confirm).note], [42, 'shown', 'wait']);
  session.put(s, 'alice', 'review', undefined);
  assert.equal(session.read(s, 'alice').review, undefined, 'a cleared field stays cleared (the older document is not read again)');
  assert.equal(session.read(s, 'bob').cursor, undefined, 'another seat: its own document');
  // blocks: per row agent, the newest kept
  session.setBlocks(s, 'alice', 'a1', 2);
  assert.equal(session.blocks(s, 'alice', 'a1'), 2);
  assert.equal(session.blocks(s, 'bob', 'a1'), 0);
});

test('hold {room}: joins and settled leaves show as notices on the progress line; a quick round trip shows nothing', async t => {
  const ENV = { SUB_HUMAN_HOLD_POLL_MS: '20', SUB_HUMAN_HOLD_GRACE_MS: '100000', SUB_HUMAN_HOLD_WHO_MS: '20', SUB_HUMAN_LEAVE_MS: '300' };
  const old = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  const tick = (ms: number) => t.mock.timers.tick(ms);
  const until = (cond: () => boolean, ms: number) => { for (let i = 0; i < ms && !cond(); i += 20) tick(20); return cond(); };
  try {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-notice-hold-'));
  const dir = path.join(process.env.SUB_HUMAN_HOME, 'rooms', CODE);
  fs.mkdirSync(dir, { recursive: true });
  const ms: Record<'claude' | 'alice' | 'bob', Member> = { claude: { name: sn('claude'), role: 'claude' }, alice: { name: sn('alice'), role: 'member' }, bob: { name: sn('bob'), role: 'member' } };
  const save = () => fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify(ms));
  save();
  let id = 0;
  const add = (from: string, kind: string, text: string) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: ++id, at: new Date().toISOString(), from, via: 'system', kind, to: 'room', text }) + '\n');
  add('alice', 'member_joined', 'alice joined');
  const progress: string[] = []; // the room hold's line only (bob's row streams his own thread)
  const me = { code: CODE, name: sn('alice'), role: 'member' } as Me; // the fields hold reads
  let who: Me | null = me;
  const plug = hold.create({ identity, whoami: () => who, progress: (k, _n, m) => { if (k === 'r') progress.push(must(m)); }, onCancel: () => {}, log: () => {}, text: s => ({ content: [{ type: 'text', text: s as string }] }) });
  // bob's row is already held, so the room hold does not return JOINED for him
  const ended: ToolResult[] = [];
  const b = plug.call('hold', me, { member: sn('bob') }, { id: 1, progressToken: 'b' });
  const r = plug.call('hold', me, { room: CODE }, { id: 2, progressToken: 'r' });
  for (const p of [b, r]) void (p as Promise<ToolResult>).then(x => ended.push(x)); // a hold call answers with a Promise
  tick(60);
  add('bob', 'member_joined', 'bob joined');
  assert.ok(until(() => progress.some(m => m.startsWith('bob joined')), 2000), progress.join('\n'));
  assert.ok(progress.some(m => m === `bob joined${hold.HINT}`), progress.join('\n'));
  assert.ok(!progress.some(m => /member_joined/.test(m)), 'no raw member_joined line');
  const n = progress.length;
  add('bob', 'member_left', 'bob left'); ms.bob.left_at = new Date().toISOString(); save();
  tick(100);
  add('bob', 'member_joined', 'bob rejoined'); delete ms.bob.left_at; save();
  until(() => false, 500);
  assert.ok(!progress.slice(n).some(m => /bob left|bob rejoined|member_left/.test(m)), progress.slice(n).join('\n'));
  add('bob', 'member_left', 'bob left'); ms.bob.left_at = new Date().toISOString(); save();
  tick(100);
  assert.ok(!progress.some(m => m.startsWith('bob left')), 'not before it settles');
  assert.ok(until(() => progress.some(m => m.startsWith('bob left')), 2000), progress.join('\n'));
  assert.ok(progress.some(m => m === `bob left${hold.HINT}`));
  who = null; // this seat leaves: both holds end
  until(() => false, 100);
  await Promise.resolve();
  assert.equal(ended.length, 2, 'both holds return');
  assert.ok(ended.every(x => /^STOP/.test(must(x.content[0]).text)), 'both holds return STOP');
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---------- the tail child sends joins and leaves as chat events ----------
// lib/tail.ts in-process on a fake clock (test/tail.node-test.ts covers the loop itself; test/cli.node-test.ts the real child).
const FAST = {
  resolveMs: 100, unseatedMs: 100, pollMs: 50, settleMs: 300, settleMaxMs: 1000, roomClaudeSettleMs: 300, roomClaudeSettleMaxMs: 1000,
  leaveMs: 600, healthMs: 5000, backoffMs: 200, backoffMaxMs: 1000, errorLogMs: 60_000, stallMs: 5000,
};
interface TailHarness {
  clock: FakeClock;
  raw: string;
  handle: ReturnType<typeof tailLib.runTail>;
  readonly out: string;
  advance(ms: number): void;
  until(cond: () => boolean, ms: number): boolean;
}
function startTail() {
  const clock = createFake({ now: Date.now() });
  const t = { clock, raw: '' } as TailHarness;
  t.handle = tailLib.runTail({
    clock, lookup: () => identity.resolveByPid(process.pid), timings: FAST,
    write: (s, done) => { t.raw += s; done(); }, err: () => {},
  });
  // the chat lines it sent, one per line
  Object.defineProperty(t, 'out', { get: () => t.raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; lines: string[] }).filter(x => x.type === 'chat').flatMap(x => x.lines).map(l => l + '\n').join('') });
  t.advance = ms => clock.advance(ms);
  t.until = (cond, ms) => { for (let i = 0; i < ms && !cond(); i += 50) clock.advance(50); return cond(); };
  return t;
}
const sys = (kind: string, from: string, text?: string) => must(R, 'the room under test').append({ kind, text: text || `${from} ${kind}` }, { via: 'system', from, system: true });

test('tail (member): a join and a settled leave are chat events; a quick round trip sends nothing', () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');
  rows.writeHolds(code, sn('alice'), { room: true, members: ['bob'] }); // her rows run: no row note is pushed
  const t = startTail();
  try {
    t.advance(400);
    sys('member_joined', 'bob', 'bob joined');                 // #2
    assert.ok(t.until(() => t.out === 'bob joined\n', 3000), t.out);
    assert.deepEqual([...notices.shown(code, 'alice')], [2], 'recorded as shown (via mod)');
    sys('member_left', 'bob', 'bob left');                     // #3
    t.advance(200);
    sys('member_joined', 'bob', 'bob rejoined');               // #4, 200 ms later: neither is a line
    t.advance(1200);
    assert.equal(t.out, 'bob joined\n');
    sys('member_left', 'bob', 'bob left');                     // #5
    t.advance(300);
    assert.equal(t.out, 'bob joined\n', 'still settling');
    assert.ok(t.until(() => t.out.includes('bob left'), 3000), t.out);
    assert.equal(t.out, 'bob joined\nbob left\n');
  } finally { t.handle.stop(); }
});
