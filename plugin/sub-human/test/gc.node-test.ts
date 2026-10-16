// What a home stops keeping (lib/gc.ts) and the open-rooms index (lib/room/registry.ts, lib/identity.ts openRooms):
// openRooms judges only indexed rooms and drops the ones closed for good; a home from before the index builds it once;
// a sweep sets aside (renames) a room closed for good that nobody touched in ROOM_GC_MS (with its seat keys), and never
// one with a live seat, a seat that never left, a link of this machine's or a host's link record, a room Claude that
// may run or a recent change; the folders set aside (by `link --forget`, or by GC) are deleted after a further TTL; session indexes
// of ended sessions and row maps of ended sessions go after their TTL; a sweep runs at most every GC_EVERY_MS and
// within its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as store from '../lib/room/store.ts';
import * as links from '../lib/room/links.ts';
import * as gc from '../lib/gc.ts';
import * as config from '../lib/config.ts';
import { keyDir } from '../lib/room/keys.ts';
import * as seatKey from '../hooks/seat-key.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn, tokenOf } from './support/brands.ts';
import { must } from './support/must.ts';

const DAY = 24 * 60 * 60_000;
const SID = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Every file and directory under p (p too) last changed `days` ago. */
function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  const walk = (q: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    fs.utimesSync(q, t, t);
  };
  walk(p);
}
/** A room whose one person joined (pid: a live one, or one gone) and, unless live, left. */
async function roomWith({ live = false, left = true }: { live?: boolean; left?: boolean } = {}): Promise<RoomCode> {
  const code = h.newRoom();
  const pid = live ? process.pid : await h.deadPid();
  const r = identity.join({ code, name: sn('alice'), role: 'member', pid, session_id: null, cwd: '/' });
  assert.ok(r.ok, r.error);
  seatKey.ensure(code, sn('alice'));
  if (left && !live) assert.ok(identity.leave(code, sn('alice'), { reason: 'done' }));
  return code;
}
const dirOf = (code: RoomCode) => must(store.open(code).dir);
const indexed = () => (JSON.parse(fs.readFileSync(path.join(identity.home(), 'open-rooms.json'), 'utf8')) as { rooms: Record<string, string> }).rooms;

test('openRooms: judges only the indexed rooms and drops the ones closed for good; a join puts a room back', async t => {
  h.freshHome(t);
  const closed = await Promise.all([1, 2, 3].map(() => roomWith()));
  const open = await roomWith({ live: true });
  const lapsed = await roomWith({ left: false }); // a seat that never left (its process gone): not closed for good
  // stage 8e I.1: the leave that closed each for good took it off the index at once, before any look
  assert.ok(closed.every(c => !indexed()[c]), 'closed: off the index at its leave');
  assert.ok(indexed()[open] && indexed()[lapsed], 'indexed when made');
  assert.deepEqual(identity.openRooms(), [open]);
  assert.deepEqual(Object.keys(indexed()).sort(), [open, lapsed].sort(), 'closed for good: out of the index');
  // a room outside the index is never judged, even with a live seat written around the join
  const sleeper = h.spawnSleeper(60);
  t.after(() => sleeper.kill());
  const r = identity.join({ code: must(closed[0]), name: sn('bob'), role: 'member', pid: must(sleeper.pid), session_id: null, cwd: '/' });
  assert.ok(r.ok);
  assert.ok(indexed()[must(closed[0])], 'a join puts it back');
  assert.deepEqual(identity.openRooms().sort(), [open, must(closed[0])].sort());
});

test('openRooms: a home from before the index builds it once from every room directory', async t => {
  h.freshHome(t);
  const a = await roomWith({ live: true });
  const b = await roomWith();
  fs.rmSync(path.join(identity.home(), 'open-rooms.json'));
  assert.deepEqual(identity.openRooms(), [a]);
  assert.deepEqual(Object.keys(indexed()), [a], 'built from both directories, the closed one dropped at once');
  assert.ok(fs.existsSync(dirOf(b)), 'dropping a room from the index deletes nothing');
});

test('gc: a closed room untouched for ROOM_GC_MS is set aside with its keys; one with a live seat, a link, a running room Claude or a recent change stays', async t => {
  h.freshHome(t);
  const old = await roomWith();
  const recent = await roomWith();
  const live = await roomWith({ live: true });
  const linked = await roomWith();
  links.set(linked, { code: linked, transport: { kind: 'pipe', home: '/nowhere' }, token: tokenOf('x'.repeat(32)), created_at: new Date().toISOString() });
  const running = await roomWith();
  identity.updateRoomClaude(running, () => ({ job: 'job12345', spawned_at: new Date().toISOString() }));
  for (const c of [old, live, linked, running]) age(dirOf(c), 40);
  age(dirOf(recent), 3);
  const aside = path.join(path.dirname(dirOf(old)), `${old}.forgotten-2026-01-01T00-00-00-000Z`);
  fs.mkdirSync(aside);
  age(aside, 40);
  assert.ok(fs.existsSync(keyDir(old)));
  const oldDir = dirOf(old);
  const oldKeys = keyDir(old);
  const r = must(gc.sweep({ force: true }));
  assert.deepEqual(r.rooms, [old]);
  assert.deepEqual(r.aside, [path.basename(aside)], 'the folder `link --forget` set aside 40 days ago goes; the one GC just set aside stays');
  assert.ok(!fs.existsSync(oldDir) && !fs.existsSync(oldKeys), 'the room and its seat keys moved');
  const set = fs.readdirSync(path.dirname(oldDir)).filter(n => n.startsWith(`${old}.gc-`));
  assert.equal(set.length, 1, 'the room set aside, not deleted');
  assert.ok(fs.existsSync(path.join(identity.home(), 'keys', must(set[0]))), 'its seat keys beside it, still under keys/');
  for (const c of [recent, live, linked, running]) assert.ok(fs.existsSync(dirOf(c)), `${c} stays`);
  assert.ok(!identity.roomExists(old));
  // a further ROOM_GC_MS later the folder set aside goes, with its keys
  const r2 = must(gc.sweep({ force: true, now: Date.now() + config.ROOM_GC_MS + 1000 }));
  assert.ok(r2.aside.includes(must(set[0])));
  assert.ok(!fs.existsSync(path.join(path.dirname(oldDir), must(set[0]))) && !fs.existsSync(path.join(identity.home(), 'keys', must(set[0]))));
});

test('GC of a room with a never-left seat: a seat whose session crashed (no left_at, pid gone) keeps the room, however old', async t => {
  h.freshHome(t);
  const code = await roomWith({ left: false });
  assert.ok(!must(identity.readMembers(code).alice).left_at);
  age(dirOf(code), 40);
  age(keyDir(code), 40);
  const r = must(gc.sweep({ force: true }));
  assert.deepEqual(r.rooms, []);
  assert.ok(fs.existsSync(dirOf(code)) && fs.existsSync(keyDir(code)), 'the room and its seat keys stay');
});

test('GC of a room with a remote link record: the host\'s record of a machine linked to the room keeps it', async t => {
  h.freshHome(t);
  const code = await roomWith();
  store.open(code).kv.set('remote/links', { '0123456789ab': { id: '0123456789ab', token_sha256: 'x', machine: 'm', seats: ['bob'], created_at: new Date().toISOString() } });
  age(dirOf(code), 40);
  const r = must(gc.sweep({ force: true }));
  assert.deepEqual(r.rooms, []);
  assert.ok(fs.existsSync(dirOf(code)));
  store.open(code).kv.set('remote/links', {});
  age(dirOf(code), 40);
  assert.deepEqual(must(gc.sweep({ force: true })).rooms, [code], 'no record left: it goes aside');
});

test('gc: at most once per GC_EVERY_MS and only within its budget; never the room a join is about to take', async t => {
  h.freshHome(t);
  const rooms = [await roomWith(), await roomWith(), await roomWith()];
  for (const c of rooms) age(dirOf(c), 40);
  assert.deepEqual(gc.sweep({ budgetMs: 0 }), { rooms: [], aside: [], sessions: 0 }, 'no time: nothing done');
  assert.equal(gc.sweep(), null, 'not due again yet');
  assert.deepEqual(must(gc.sweep({ now: Date.now() + config.GC_EVERY_MS + 1000, keep: must(rooms[1]) })).rooms, [rooms[0], rooms[2]].sort(), 'due: all but the one kept');
});

test('gc: a session index of an ended session goes after its TTL; a live one stays', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const dead = await h.deadPid();
  assert.ok(identity.join({ code, name: sn('alice'), role: 'member', pid: dead, session_id: SID(1), cwd: '/' }).ok);
  assert.ok(identity.join({ code, name: sn('bob'), role: 'member', pid: process.pid, session_id: SID(2), cwd: '/' }).ok);
  const sessions = path.join(identity.home(), 'sessions');
  age(sessions, 40);
  const n = identity.pruneSessionIndexes();
  assert.equal(n, 2, 'alice\'s by-sid and by-pid');
  assert.ok(!fs.existsSync(path.join(sessions, 'by-sid', `${SID(1)}.json`)));
  assert.ok(fs.existsSync(path.join(sessions, 'by-sid', `${SID(2)}.json`)) && fs.existsSync(path.join(sessions, 'by-pid', `${process.pid}.json`)));
  assert.equal(identity.pruneSessionIndexes(Date.now(), 1000 * DAY), 0, 'nothing younger than the TTL');
});

test('gc: a room\'s row map of an ended session goes after ROWS_TTL_MS; a live session\'s and a recent one stay', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  assert.ok(identity.join({ code, name: sn('alice'), role: 'member', pid: process.pid, session_id: SID(3), cwd: '/' }).ok);
  const kv = store.open(code).kv;
  const map = (days: number) => ({ byAgent: { a1: { kind: 'room', name: code, parent: null, at: new Date(Date.now() - days * DAY).toISOString() } } });
  kv.set(`rows/${SID(3)}`, map(30));  // alice's live session: stays
  kv.set(`rows/${SID(4)}`, map(30));  // an ended session: goes
  kv.set(`rows/${SID(5)}`, map(1));   // recent: stays
  assert.equal(gc.sweepRows(code), 1);
  assert.deepEqual(kv.list('rows/'), [`rows/${SID(3)}`, `rows/${SID(5)}`].sort());
});
