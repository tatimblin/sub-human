// The RoomStore contract (lib/room/store.ts), run against FsRoomStore (the room directory), MemoryRoomStore
// (test/support/memory-store.ts), ThreadRoomStore (test/support/thread-store.ts: every call crosses
// lib/remote/bridge.ts to an FsRoomStore on a worker) and MirrorRoomStore (test/support/remote-store.ts: the
// mirror of a room whose server and link run on a worker, over the memory transport): append, ids and the prev
// chain, signed human entries (sig v2 placed anywhere, v1 still read), keys pinned in the log, place's replay and
// trust checks and verdicts, the rate buckets, readView parity, the tailer, chain checks, cursors, members
// compare-and-set (across processes for the file store) and the named seat ops, blobs and the small documents.
// All passing is what lets a room move off this machine behind the same interface. The cases that write as the
// system or write the host's documents directly are host-only (a mirror refuses them: HOST_ONLY, AUTH); the
// remote cases at the end cover what a mirror does instead.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as room from '../lib/room.ts';
import * as config from '../lib/config.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as consent from '../lib/room/consent.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { MemoryRoomStore } from './support/memory-store.ts';
import { ThreadRoomStore } from './support/thread-store.ts';
import { remoteStore, MACHINE } from './support/remote-store.ts';
import { machineId } from '../lib/home.ts';
import * as identity from '../lib/identity.ts';
import type { Entry, EntryInput, Member, Members, Payload, RoomStore, Via } from '../lib/room/types.ts';
import { rc, sn } from './support/brands.ts';

type Err = Error & { code?: string };
/** A store under test and how to change its log around it. */
interface Backend {
  make(t: TestContext): RoomStore;
  hostOnly?: string;
  /** replace line i (0-based) of the log */
  tamper(s: RoomStore, i: number, fn: (line: string) => string): void;
  /** a line written around the store */
  raw(s: RoomStore, e: object): void;
}

const CODE = rc('otter-1234');
const FILES: Pick<Backend, 'tamper' | 'raw'> = {
  // replace line i (0-based) of the log
  tamper: (s, i, fn) => {
    const lines = fs.readFileSync(path.join(s.dir!, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
    lines[i] = fn(lines[i]!);
    fs.writeFileSync(path.join(s.dir!, 'log.jsonl'), lines.join('\n') + '\n');
  },
  // a line written around the store
  raw: (s, e) => fs.appendFileSync(path.join(s.dir!, 'log.jsonl'), JSON.stringify(e) + '\n'),
};
// A remote join on the host starts the room's Claude, as a local one does: never a real one.
Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false' });
/** A mirror of a room hosted on a worker (test/support/remote-store.ts), stopped when the test ends. */
function mirrorOf(t: TestContext): RoomStore {
  const r = remoteStore(CODE, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => r.stop());
  return r.mirror;
}
const HOST_ONLY = 'host only: it writes as the system or the host\'s documents directly';
const BACKENDS: Record<string, Backend> = {
  fs: { make: t => store.open(CODE, { dir: h.tmpDir('sh-store-', t) }), ...FILES },
  thread: { make: t => new ThreadRoomStore(CODE, { dir: h.tmpDir('sh-store-', t) }), ...FILES },
  remote: { make: mirrorOf, hostOnly: HOST_ONLY, ...FILES },
  memory: {
    make: () => new MemoryRoomStore(CODE),
    // s is this backend's own make(): a MemoryRoomStore
    tamper: (s, i, fn) => { const m = s as MemoryRoomStore; m._lines[i] = fn(m._lines[i]!); },
    raw: (s, e) => { (s as MemoryRoomStore)._lines.push(JSON.stringify(e)); },
  },
};

const say = (s: RoomStore, from: string, text: string, via: Via = 'human') => s.append({ kind: 'say', text }, { via, from });
const sys = (s: RoomStore, kind: string, from: string, extra: Partial<EntryInput> = {}) => s.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });
const H = 'abcdef012345';
/** The next raw line of s: id and prev chained, as a writer around the store would make it. */
const rawLine = (s: RoomStore, fields: Omit<Entry, 'id' | 'at' | 'prev'>): Entry => {
  const last = s.readAll().at(-1);
  return { id: (last ? last.id : 0) + 1, at: new Date().toISOString(), ...fields, prev: store.hash12(last ? JSON.stringify(last) : '') };
};
const placed = ({ id, at, prev, ...payload }: Entry): Payload => payload as Payload; // a stored line's payload

for (const [name, B] of Object.entries(BACKENDS)) {
  test(`store contract (${name}): append assigns rising ids and chains prev; reads agree`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.deepEqual(s.readAll(), []);
    assert.equal(s.lastId(), 0);
    const a = say(s, 'alice', 'one');
    const b = s.append({ kind: 'status', text: 'two' }, { via: 'agent', from: 'bob' });
    const c = s.append({ kind: 'task_req', text: 'task add: x', op: 'add', subject: 'x' }, { via: 'agent', from: 'bob' });
    assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
    assert.equal(a.prev, store.hash12(''));
    assert.equal(c.by, 'bob', 'task_req gets by = from');
    for (const [k, v] of Object.entries({ from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'one' })) assert.equal(a[k as keyof Entry], v);
    assert.ok(Date.parse(a.at) <= Date.now());
    const all = s.readAll();
    assert.deepEqual(all.map(e => e.id), [1, 2, 3]);
    assert.equal(all[1].prev, store.hash12(JSON.stringify(all[0])), 'prev = hash12 of the previous stored line');
    assert.equal(s.lastId(), 3);
    assert.deepEqual(s.readById([3, 1, 9]).map(e => e.id), [3, 1]);
    assert.deepEqual(s.readAfter(1).map(e => e.id), [2, 3]);
    assert.deepEqual(s.readAfter(0, e => e.via === 'agent').map(e => e.id), [2, 3]);
  });

  test(`store contract (${name}): human entries are signed with the seat key; agents are rate limited; bad entries refused`, t => {
    h.freshHome(t);
    const s = B.make(t);
    const e = say(s, 'alice', 'mine');
    assert.equal(e.room, CODE);
    assert.equal(typeof e.sig, 'string');
    assert.equal(s.trust(s.readAll()[0]), 'verified');
    assert.equal(s.trust(s.readAll()[0]), s.trust(s.readAll()[0]), 'the same verdict again');
    assert.throws(() => s.append({ kind: 'nope' }, { via: 'agent', from: 'bob' }), (e2: Err) => e2.code === 'INVALID');
    for (let i = 0; i < config.RATE_MAX; i++) say(s, 'bob', `p${i}`, 'agent');
    assert.throws(() => say(s, 'bob', 'one too many', 'agent'), (e2: Err) => e2.code === 'RATE');
    assert.throws(() => s.append({ kind: 'say', text: 'x'.repeat(config.LOG_LINE_MAX_BYTES) }, { via: 'system', from: 'room', system: true }), (e2: Err) => e2.code === 'INVALID');
    assert.equal(s.lastId(), 1 + config.RATE_MAX, 'nothing refused was written');
  });

  test(`store contract (${name}): a post addressed to one member has its own rate bucket per (from, to)`, t => {
    h.freshHome(t);
    const s = B.make(t);
    const to = (who: string, text: string) => s.append({ kind: 'say', text, to: who }, { via: 'agent', from: 'bob' });
    for (let i = 0; i < config.RATE_MAX; i++) say(s, 'bob', `p${i}`, 'agent');
    assert.throws(() => say(s, 'bob', 'room is full', 'agent'), (e: Err) => e.code === 'RATE');
    for (let i = 0; i < config.RATE_ADDRESSED_MAX; i++) to('alice', `a${i}`);
    assert.throws(() => to('alice', 'one too many'), (e: Err) => e.code === 'RATE' && /to alice/.test(e.message));
    assert.equal(to('carol', 'another bucket').to, 'carol');
    assert.equal(s.append({ kind: 'say', text: 'mine', to: 'alice' }, { via: 'agent', from: 'dave' }).from, 'dave', 'per sender');
  });

  test(`store contract (${name}): a person's own entries have a rate too, per seat (the host's link cap is lower)`, t => {
    h.freshHome(t);
    const s = B.make(t);
    const cap = name === 'remote' ? config.LINK_QUOTAS['append.human'].max : config.RATE_HUMAN_MAX;
    for (let i = 0; i < cap; i++) say(s, 'alice', `w${i}`);
    assert.throws(() => say(s, 'alice', 'one too many'), (e: Err) => e.code === 'RATE' && /alice posted/.test(e.message));
    assert.equal(say(s, 'bob', 'another person').from, 'bob', 'per seat');
    assert.equal(say(s, 'alice', 'her Claude', 'agent').via, 'agent', 'her Claude has its own bucket');
  });

  test(`store contract (${name}): members.join/leave/beat: one seat per name across machines, judged by lease off this machine`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    const here = machineId();
    assert.equal(s.isHost, true);
    assert.deepEqual(s.members.join({ name: sn('alice'), role: 'member', machine: 'far-away' }), { ok: true });
    const a = s.members.read().alice;
    assert.deepEqual([a.machine, typeof a.joined_at, a.seen_at === a.joined_at], ['far-away', 'string', true]);
    // alice's seat on another machine has a fresh lease: taken from here, whatever pid asks; her own machine rejoins
    const taken = s.members.join({ name: sn('alice'), role: 'member', machine: here, pid: process.pid });
    assert.equal(taken.ok, false);
    assert.match(taken.error!, /name taken: "alice" is already in otter-1234/);
    assert.deepEqual(s.members.join({ name: sn('alice'), role: 'member', machine: 'far-away' }), { ok: true, rejoin: true });
    // a stale lease frees the name
    s.members.update(ms => { ms.alice.seen_at = new Date(Date.now() - config.SEAT_LEASE_MS - 1).toISOString(); return ms; });
    assert.deepEqual(s.members.join({ name: sn('alice'), role: 'member', machine: here, pid: process.pid }), { ok: true, rejoin: true });
    assert.deepEqual([s.members.read().alice.machine, s.members.read().alice.pid], [here, process.pid]);
    // beat: the lease (at most every SEAT_BEAT_MS) and presence; a bad state writes nothing
    const later = Date.parse(s.members.read().alice.seen_at!) + config.SEAT_BEAT_MS + 1;
    assert.equal(s.members.beat('alice', { now: later, presence: { state: 'idle', detail: 'x' } }), true);
    assert.equal(s.members.read().alice.seen_at, new Date(later).toISOString());
    assert.deepEqual(s.kv.get('presence/alice'), { state: 'idle', at: new Date(later).toISOString(), detail: 'x' });
    assert.equal(s.members.beat('alice', { now: later + 1000 }), true);
    assert.equal(s.members.read().alice.seen_at, new Date(later).toISOString(), 'renewed at most every SEAT_BEAT_MS');
    assert.throws(() => s.members.beat('alice', { presence: { state: 'away' } }), (e: Err) => e.code === 'INVALID');
    assert.equal(s.members.beat('zed'), false, 'no seat');
    // leave: once
    assert.equal(s.members.leave('alice'), true);
    assert.ok(s.members.read().alice.left_at);
    assert.equal(s.members.leave('alice'), false);
    assert.equal(s.members.beat('alice', { presence: { state: 'working' } }), false, 'a left seat writes nothing');
    assert.equal(s.kv.get('presence/alice', null), null, 'leaving drops the seat\'s presence');
  });

  test(`store contract (${name}): sig v2 covers the payload, not its place: placed at another id it still verifies; v1 lines still do`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    const e = say(s, 'alice', 'mine');
    assert.deepEqual([e.sigv, typeof e.nonce, typeof e.ts], [2, 'string', 'number']);
    // the same payload placed in another copy of the room, after other entries: a new id and prev, the same sig
    const other = B.make(t);
    sys(other, 'status', 'room'); sys(other, 'status', 'room');
    const moved = other.place(placed(s.readAll()[0]));
    assert.deepEqual([moved.id, moved.sig], [3, e.sig]);
    assert.notEqual(moved.prev, e.prev);
    assert.equal(other.trust(other.readAll()[2]), 'verified');
    // a v1 line (signed over the stored line minus sig, as before sig v2) still reads as the person's
    const v1 = rawLine(other, { from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'old', room: CODE });
    v1.sig = crypto.sign(null, Buffer.from(JSON.stringify(v1)), seatKey.ensure(CODE, sn('alice'))).toString('base64');
    B.raw(other, v1);
    say(other, 'alice', 'v2 after v1');
    assert.deepEqual(other.readAll().slice(-2).map(e => other.trust(e)), ['verified', 'verified']);
    assert.deepEqual(other.validateChain(), { ok: true, count: 5 });
    assert.equal(other.verifyChain().ok, true, 'a mixed v1/v2 log chains');
  });

  test(`store contract (${name}): member_joined pins a key; a keyed room never counts an unsigned answer and refuses another key`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    s.append({ kind: 'proposal', text: 'p', hash: H, approvers: ['alice', 'bob'] }, { via: 'agent', from: 'claude' });
    // no key pinned yet: a legacy room, where an unsigned answer from a seat with no key still counts
    B.raw(s, rawLine(s, { from: 'bob', via: 'human', kind: 'signoff', to: 'room', proposal_hash: H }));
    const forged = s.readAll().at(-1);
    assert.equal(s.pins().size, 0);
    assert.equal(s.trust(forged), 'legacy');
    // alice joins with her key: the room is keyed from here on
    const alice = seatKey.publicPem(CODE, sn('alice'));
    sys(s, 'member_joined', 'alice', { pubkey: alice });
    assert.deepEqual([...s.pins().keys()], ['alice']);
    assert.ok(s.pins().get('alice')!.equals(crypto.createPublicKey(alice)));
    assert.equal(s.trust(forged), 'unverified', 'a keyed room never returns legacy');
    // the same key again (a rejoin) is fine; another key for a pinned name is refused
    sys(s, 'member_joined', 'alice', { pubkey: alice });
    const stranger = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string; // pem is a string
    assert.throws(() => sys(s, 'member_joined', 'alice', { pubkey: stranger }), (e: Err) => e.code === 'AUTH' && /a lost key means a new name/.test(e.message));
    // alice's signed answer counts; bob, with a local key but none pinned, is refused, signed or not
    s.append({ kind: 'signoff', proposal_hash: H }, { via: 'human', from: 'alice' });
    assert.throws(() => s.append({ kind: 'signoff', proposal_hash: H }, { via: 'human', from: 'bob' }), (e: Err) => e.code === 'AUTH' && /no key is pinned for bob/.test(e.message));
    assert.throws(() => s.place({ from: 'bob', via: 'human', kind: 'signoff', to: 'room', proposal_hash: H }), (e: Err) => e.code === 'AUTH');
    const m = consent.fold(s.readAll(), s.trust).matrix(H);
    assert.deepEqual([m.agreed, m.missing], [['alice'], ['bob']]);
  });

  test(`store contract (${name}): place refuses a replayed nonce, a stale ts, another room's payload and a changed field`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    const p = store.toPayload(CODE, { kind: 'say', text: 'once' }, { via: 'human', from: 'alice' });
    s.place(p);
    assert.throws(() => s.place(p), (e: Err) => e.code === 'AUTH' && /nonce/.test(e.message), 'a replay');
    const key = seatKey.ensure(CODE, sn('alice'));
    const fields: Payload = { from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'x' };
    const refused = [
      envelope.sign(fields, key, { room: CODE, from: 'alice', now: Date.now() - envelope.SIG_SKEW_MS - 1000 }),
      envelope.sign(fields, key, { room: rc('vole-0000'), from: 'alice' }),
      { ...envelope.sign(fields, key, { room: CODE, from: 'alice' }), text: 'changed' },
    ];
    for (const r of refused) assert.throws(() => s.place(r), (e: Err) => e.code === 'AUTH', JSON.stringify(r).slice(0, 80));
    assert.throws(() => s.place({ ...fields, via: 'agent', nonce: 'n', sig: 's' }), (e: Err) => e.code === 'INVALID', 'only a person\'s entry is signed');
    assert.throws(() => s.place({ ...fields, via: 'system', kind: 'status' }), (e: Err) => e.code === 'INVALID', 'system needs {system: true}');
    assert.equal(s.lastId(), 1, 'nothing refused was written');
  });

  test(`store contract (${name}): readView({after}) holds every non-chat entry and every entry after`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    sys(s, 'member_joined', 'alice');           // 1
    say(s, 'alice', 'early chat');              // 2
    say(s, 'bob', 'mid chat');                  // 3
    s.append({ kind: 'proposal', text: 'p', hash: 'abcdef012345', approvers: ['alice'] }, { via: 'agent', from: 'bob' }); // 4
    say(s, 'alice', 'later chat');              // 5
    say(s, 'alice', 'more chat');               // 6
    say(s, 'bob', 'latest');                    // 7
    const all = s.readAll();
    for (const after of [0, 2, 4, 6, 7, Infinity]) {
      const want = all.filter(e => !(after > 0) || !store.CHAT_KINDS.has(e.kind) || e.id > after).map(e => e.id);
      assert.deepEqual(s.readView({ after }).map(e => e.id), want, `after ${after}`);
    }
    assert.deepEqual(s.readView({ after: 4 }).filter(e => e.id > 4), all.filter(e => e.id > 4), 'the same entries as readAll after `after`');
  });

  test(`store contract (${name}): a tailer gives only what is appended after it was made`, t => {
    h.freshHome(t);
    const s = B.make(t);
    say(s, 'alice', 'a'); say(s, 'alice', 'b');
    const tl = s.tailer();
    say(s, 'alice', 'c');
    const p = tl.poll();
    assert.deepEqual(p.entries.map(e => e.id), [3]);
    assert.equal(p.reset, false);
    assert.deepEqual(tl.poll().entries, []);
  });

  test(`store contract (${name}): a tailer from \`after\` gives the stored lines verbatim; lineHash is each line's hash12`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.equal(s.lineHash(0), store.hash12(''));
    assert.deepEqual(s.tailer({ after: 0 }).poll().lines, []);
    say(s, 'alice', 'a'); say(s, 'alice', 'b'); say(s, 'alice', 'c');
    const all = s.readAll();
    const tl = s.tailer({ after: 1 });
    const p = tl.poll();
    assert.deepEqual(p.entries.map(e => e.id), [2, 3]);
    assert.deepEqual(p.lines.map(l => JSON.parse(l)), all.slice(1), 'lines are the stored entries');
    assert.equal(all[2].prev, store.hash12(p.lines[0]), 'byte-identical: the next prev hashes it');
    say(s, 'alice', 'd');
    assert.deepEqual(tl.poll().entries.map(e => e.id), [4]);
    assert.deepEqual(s.tailer({ after: 4 }).poll().lines, []);
    assert.equal(s.lineHash(3), s.readAll()[3].prev);
    assert.equal(s.lineHash(9), null);
  });

  test(`store contract (${name}): validateChain and verifyChain find a changed line; verifyChain is incremental`, t => {
    h.freshHome(t);
    const s = B.make(t);
    for (let i = 0; i < 4; i++) say(s, 'alice', `m${i}`);
    assert.deepEqual(s.validateChain(), { ok: true, count: 4 });
    const v1 = s.verifyChain();
    assert.equal(v1.ok, true);
    assert.equal(v1.checked, 4);
    say(s, 'alice', 'm4');
    const v2 = s.verifyChain();
    assert.equal(v2.ok, true);
    assert.equal(v2.checked, 1, 'only the new line');
    B.tamper(s, 2, l => l.replace('"m2"', '"M2"'));
    const bad = s.validateChain();
    assert.equal(bad.ok, false);
    assert.equal(bad.badAt, 4, 'the entry after the changed one no longer chains');
    assert.equal(s.verifyChain().ok, true, 'lines before the checkpoint are trusted (validateChain re-checks them all)');
    B.tamper(s, 4, l => l.replace(/"prev":"[0-9a-f]+"/, '"prev":"000000000000"'));
    const v3 = s.verifyChain();
    assert.equal(v3.ok, false, 'the checkpoint line changed: re-checked from the start');
    assert.equal(v3.badAt, 4);
  });

  test(`store contract (${name}): the log rotates into segments behind the same reads; the chain, pins and nonces carry across`, t => {
    h.freshHome(t);
    const was = process.env.SUB_HUMAN_SEGMENT_BYTES;
    process.env.SUB_HUMAN_SEGMENT_BYTES = '2048'; // a rotation every few lines (read at each append; a host on a worker copies it at its start)
    t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_SEGMENT_BYTES; else process.env.SUB_HUMAN_SEGMENT_BYTES = was; });
    const s = B.make(t);
    const words = (i: number) => `line ${i} ${'x'.repeat(200)}`;
    say(s, 'alice', words(1));
    const replay = placed(s.readAll()[0]);
    for (let i = 2; i <= 14; i++) say(s, 'alice', words(i));
    const all = s.readAll();
    assert.deepEqual(all.map(e => e.id), Array.from({ length: 14 }, (_, i) => i + 1), 'every line, once, in order');
    for (let i = 1; i < all.length; i++) assert.equal(all[i].prev, store.hash12(JSON.stringify(all[i - 1])), `#${i + 1} chains to #${i}`);
    for (let i = 1; i < all.length; i++) assert.equal(s.lineHash(all[i - 1].id), all[i].prev, `lineHash(${i})`);
    assert.deepEqual(s.validateChain(), { ok: true, count: 14 });
    assert.equal(s.verifyChain().ok, true);
    assert.equal(s.lastId(), 14);
    const tl = s.tailer({ after: 2 }).poll();
    assert.deepEqual(tl.entries.map(e => e.id), Array.from({ length: 12 }, (_, i) => i + 3), 'a tailer from a sealed segment runs on to the end');
    for (let i = 1; i < tl.lines.length; i++) assert.equal(JSON.parse(tl.lines[i]).prev, store.hash12(tl.lines[i - 1]), 'verbatim across segments');
    for (const after of [3, 9, 13, Infinity]) {
      const want = all.filter(e => !store.CHAT_KINDS.has(e.kind) || e.id > after).map(e => e.id);
      assert.deepEqual(s.readView({ after }).map(e => e.id), want, `readView after ${after}`);
    }
    assert.equal(s.trust(all[0]), 'verified', 'a sealed line still verifies against its pinned or local key');
    assert.throws(() => s.place(replay), (e: Err) => e.code === 'AUTH' && /nonce/.test(e.message), 'a nonce placed before the rotation is still refused');
    if (s.dir && name !== 'memory') {
      assert.ok(fs.existsSync(path.join(s.dir, 'log-0001.jsonl')) && fs.existsSync(path.join(s.dir, 'snapshot.json')), 'sealed segments and a snapshot');
      const snap = s.snapshot()!;
      assert.ok(snap && snap.id > 1 && snap.id < 14, `the snapshot stands for sealed lines (${snap && snap.id})`);
      assert.equal(s.recentFrom(), snap.id);
      assert.equal(snap.hash, s.lineHash(snap.id));
    } else assert.deepEqual([s.snapshot(), s.recentFrom()], [null, 0], 'a store that keeps no segments');
    // a tailer made now follows the next rotations: each new line once
    const live = s.tailer();
    for (let i = 15; i <= 22; i++) say(s, 'alice', words(i));
    assert.deepEqual(live.poll().entries.map(e => e.id), Array.from({ length: 8 }, (_, i) => i + 15));
    assert.deepEqual(s.readAll().map(e => e.id), Array.from({ length: 22 }, (_, i) => i + 1));
  });

  test(`store contract (${name}): cursors default to 0, persist, and refuse unsafe names`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.equal(s.getCursor('tail-alice'), 0);
    s.setCursor('tail-alice', 7);
    assert.equal(s.getCursor('tail-alice'), 7);
    assert.equal(s.getCursor('tail-bob'), 0);
    assert.throws(() => s.setCursor('../x', 1), (e: Err) => e.code === 'INVALID');
  });

  test(`store contract (${name}): members read/update: atomic, null writes nothing, reads are copies`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.deepEqual(s.members.read(), {});
    assert.deepEqual(s.members.update(ms => ({ ...ms, alice: { name: sn('alice'), role: 'member' } })), { alice: { name: 'alice', role: 'member' } });
    assert.equal(s.members.update(() => null), null);
    const r = s.members.read();
    (r.alice as { role: string }).role = 'changed'; // deliberate: not a role, only a change to a copy
    assert.equal(s.members.read().alice.role, 'member', 'mutating a read changes nothing stored');
    s.members.update(ms => { ms.bob = { name: 'bob' } as Member; return ms; });
    assert.deepEqual(Object.keys(s.members.read()).sort(), ['alice', 'bob']);
  });

  test(`store contract (${name}): blobs: room-relative refs, bytes back exactly, legacy absolute paths read by name`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    const bytes = Buffer.from('# plan\né\n', 'utf8');
    const ref = s.blobs.put('plans/abcdef012345.md', bytes);
    assert.equal(ref, 'plans/abcdef012345.md');
    assert.ok(s.blobs.has(ref));
    assert.ok(s.blobs.get(ref)!.equals(bytes));
    assert.equal(s.blobs.ref('/old/home/rooms/otter-1234/plans/abcdef012345.md'), ref, 'an older entry\'s absolute path');
    assert.ok(s.blobs.get('/old/home/rooms/otter-1234/plans/abcdef012345.md')!.equals(bytes));
    assert.equal(s.blobs.get('plans/missing.md'), null);
    assert.equal(s.blobs.ref('../etc/passwd'), null);
    assert.throws(() => s.blobs.put('../x', bytes), (e: Err) => e.code === 'INVALID');
  });

  test(`store contract (${name}): kv: get/set/update/delete/list, update undefined keeps and null deletes`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.equal(s.kv.get('tasks'), null);
    assert.deepEqual(s.kv.get('tasks', []), []);
    s.kv.set('tasks', [{ id: '1' }]);
    assert.deepEqual(s.kv.get('tasks'), [{ id: '1' }]);
    assert.equal(s.kv.update('presence/alice', cur => { assert.equal(cur, null); return undefined; }), undefined);
    assert.equal(s.kv.get('presence/alice'), null, 'undefined: nothing written');
    s.kv.update('presence/alice', () => ({ state: 'idle' }));
    s.kv.set('presence/bob', { state: 'working' });
    s.kv.set('members/alice/review', { phase: 'shown' });
    assert.deepEqual(s.kv.list('presence/'), ['presence/alice', 'presence/bob']);
    assert.deepEqual(s.kv.update<object>('presence/alice', cur => ({ ...cur, at: 1 })), { state: 'idle', at: 1 });
    assert.equal(s.kv.update('presence/bob', () => null), null);
    assert.deepEqual(s.kv.list('presence/'), ['presence/alice']);
    s.kv.delete('presence/alice');
    assert.deepEqual(s.kv.list('presence/'), []);
    assert.equal(s.kv.lock('tasks', () => 'ran'), 'ran');
    assert.equal(s.lock('proposal', () => 'ran'), 'ran');
    assert.throws(() => s.kv.get('../x'), (e: Err) => e.code === 'INVALID');
    assert.throws(() => s.kv.list('presence'), (e: Err) => e.code === 'INVALID');
  });

  test(`store contract (${name}): a Room over the store renders and queries this room only`, { skip: B.hostOnly }, t => {
    h.freshHome(t);
    const s = B.make(t);
    s.members.update(() => ({ alice: { name: sn('alice'), role: 'member' }, bob: { name: sn('bob'), role: 'member', left_at: new Date().toISOString() } }));
    const r = room.open(CODE, { store: s });
    r.append({ kind: 'proposal', text: 'proposal abcdef012345: x', hash: 'abcdef012345', approvers: ['alice'] }, { via: 'agent', from: 'bob' });
    assert.equal(r.proposals().length, 1);
    assert.match(r.stateLine({ name: 'alice' }), /^room now: proposal abcdef .* · you: answer needed .* · away: bob$/);
    assert.match(r.digest(), new RegExp(`## members of ${CODE}`));
    assert.equal(r.deliver({ name: 'alice', role: 'member' }, r.readAll()[0], { entries: r.readAll() }), 'wake');
  });
}

test('store contract (fs): members.update is atomic across processes (no lost update)', async t => {
  h.freshHome(t);
  const dir = h.tmpDir('sh-store-cas-', t);
  const N = 6, K = 15;
  const script = `const s=require(${JSON.stringify(path.join(h.LIB, 'room', 'store.ts'))}).open(${JSON.stringify(CODE)},{dir:${JSON.stringify(dir)}});`
    + `const t=Number(process.argv[1]);while(Date.now()<t){}for(let i=0;i<${K};i++)s.members.update(m=>{m.n=(m.n||0)+1;m['p'+process.pid]=(m['p'+process.pid]||0)+1;return m;});`;
  const start = Date.now() + 400;
  await Promise.all(Array.from({ length: N }, () => new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, String(start)], { env: h.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
  })));
  const m = store.open(CODE, { dir }).members.read();
  assert.equal(m.n, N * K);
  assert.equal(Object.keys(m).filter(k => k.startsWith('p')).length, N);
});

test('store contract (memory): members.update retries when another writer got in first (compare-and-set)', () => {
  const s = new MemoryRoomStore(CODE);
  let calls = 0;
  s.members.update(ms => {
    calls++;
    // numbers, not seats: the memory store's compare-and-set does not look inside
    if (calls === 1) s.members.update(x => ({ ...x, other: 1 }) as unknown as Members); // a concurrent writer between read and write
    return { ...ms, mine: 1 } as unknown as Members;
  });
  assert.equal(calls, 2, 'fn ran again on the newer version');
  assert.deepEqual(s.members.read(), { other: 1, mine: 1 });
});

test('store: setBackend routes every open() (identity included) to another store', t => {
  h.freshHome(t);
  const mem = new MemoryRoomStore(CODE);
  store.setBackend(() => mem);
  try {
    mem.members.update(() => ({ alice: { name: sn('alice'), role: 'member', seen_at: new Date().toISOString() } }));
    assert.deepEqual(Object.keys(identity.readMembers(CODE)), ['alice']);
    assert.equal(identity.seatAlive(identity.readMembers(CODE).alice), true, 'no pid: the lease decides');
    identity.writePresence(CODE, sn('alice'), 'idle');
    assert.equal(mem.kv.get('presence/alice').state, 'idle');
    assert.equal(room.open(CODE).store, mem);
  } finally { store.setBackend(null); }
});

test('store contract (remote): a write goes through the host and reads back at once; join, beat and leave are the host\'s ops', t => {
  h.freshHome(t);
  const s = mirrorOf(t);
  assert.equal(s.isHost, false);
  const e = say(s, 'alice', 'hi');
  assert.deepEqual([s.lastId(), s.readAll().at(-1)], [e.id, e], 'read-your-writes');
  assert.equal(s.trust(s.readAll().at(-1)), 'verified');
  // the join: the seat's key and a proof from this thread's signer; the host logs member_joined with them
  assert.deepEqual(s.members.join({ name: sn('erin'), role: 'member', machine: MACHINE }), { ok: true });
  const joined = s.readAll().at(-1)!;
  assert.deepEqual([joined.kind, joined.from, joined.machine, joined.pubkey], ['member_joined', 'erin', MACHINE, seatKey.publicPem(CODE, sn('erin'))]);
  assert.deepEqual([s.members.read().erin.machine, 'pid' in s.members.read().erin], [MACHINE, false], 'a seat on another machine lives by its lease');
  assert.equal(s.members.beat('erin', { presence: { state: 'idle' } }), true);
  assert.equal(s.kv.get('presence/erin').state, 'idle', 'presence written on the host, streamed back');
  assert.equal(s.members.leave('erin', { reason: 'done' }), true);
  assert.equal(s.readAll().at(-1)!.text, 'erin left (done)');
  assert.ok(s.members.read().erin.left_at);
  assert.equal(s.members.beat('erin'), false, 'a left seat');
  assert.deepEqual(store.open(CODE).readAll().map(x => x.id), s.readAll().map(x => x.id), 'the host log');
});

test('store contract (remote): the host\'s documents and system writes are refused; session-local documents stay on this machine', t => {
  h.freshHome(t);
  const s = mirrorOf(t);
  assert.throws(() => s.members.update(() => ({})), (e: Err) => e.code === 'HOST_ONLY');
  for (const key of ['members', 'tasks', 'presence/alice']) {
    assert.throws(() => s.kv.set(key, {}), (e: Err) => e.code === 'HOST_ONLY', key);
    assert.throws(() => s.kv.delete(key), (e: Err) => e.code === 'HOST_ONLY', key);
  }
  assert.throws(() => s.kv.update('tasks', () => []), (e: Err) => e.code === 'HOST_ONLY');
  assert.throws(() => sys(s, 'status', 'alice'), (e: Err) => e.code === 'AUTH' && /never writes via "system"/.test(e.message));
  s.kv.set('rows/notices-alice', { ids: [1] });
  s.setCursor('tail-alice', 3);
  assert.deepEqual([s.kv.get('rows/notices-alice'), s.getCursor('tail-alice')], [{ ids: [1] }, 3]);
  assert.equal(store.open(CODE).kv.get('rows/notices-alice'), null, 'not on the host');
  assert.deepEqual(store.open(CODE).readAll(), []);
});

test('store contract (remote): blobs are put on the host by their content and fetched from it when this machine has none', t => {
  h.freshHome(t);
  const s = mirrorOf(t);
  const plan = Buffer.from('# plan\né\n');
  const ref = `plans/${store.hash12(plan)}.md`;
  assert.equal(s.blobs.put(ref, plan), ref);
  assert.ok(s.blobs.has(ref) && store.open(CODE).blobs.get(ref)!.equals(plan));
  assert.throws(() => s.blobs.put('plans/abcdef012345.md', plan), (e: Err) => e.code === 'INVALID' && /content/.test(e.message));
  const other = Buffer.from('# only on the host\n');
  const ref2 = store.open(CODE).blobs.put(`plans/${store.hash12(other)}.md`, other);
  assert.equal(s.blobs.has(ref2), false);
  assert.ok(s.blobs.get(ref2)!.equals(other), 'fetched over the link');
  assert.equal(s.blobs.get('plans/missing.md'), null);
});

test('store contract (remote): with the link down a write is OFFLINE at once and nothing is written anywhere; reads use the mirror', t => {
  h.freshHome(t);
  const r = remoteStore(CODE, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => r.stop());
  say(r.mirror, 'alice', 'before');
  r.stop();
  const t0 = Date.now();
  assert.throws(() => say(r.mirror, 'alice', 'after'), (e: Err) => e.code === 'OFFLINE' && /nothing was sent/.test(e.message));
  assert.ok(Date.now() - t0 < config.LINK_CALL_MS, 'not at the deadline: the daemon is gone');
  assert.deepEqual(r.mirror.readAll().map(e => e.text), ['before']);
  assert.deepEqual(store.open(CODE).readAll().map(e => e.text), ['before']);
});
