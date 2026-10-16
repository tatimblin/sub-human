// The log in segments (lib/room/log-io.ts) on the file store: a room from before segments (one log.jsonl, an old
// log.idx) opens, folds and appends unchanged, then rotates like any other; a rotation a crash cut short is finished by
// the next append; a lost snapshot is rebuilt from the sealed segments; an older plugin's appender, which knows only
// log.jsonl, still chains after a rotation (the carry line); a segment that does not chain is never sealed (a break is
// never laundered into a snapshot); a demoted host's segments are set aside as one log.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as consent from '../lib/room/consent.ts';
import * as seatKey from '../hooks/seat-key.ts';
import type { Entry, RoomStore } from '../lib/room/types.ts';
import type { FsRoomStore } from '../lib/room/store.ts';

const hash12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const H = 'abcdef012345';

/** A fresh home and room on the file store, rotating at `bytes` (unset: the default 1 MiB) while the test runs. */
function room(t: TestContext, bytes?: number): { code: string; s: FsRoomStore } {
  h.freshHome(t);
  const was = process.env.SUB_HUMAN_SEGMENT_BYTES;
  if (bytes) process.env.SUB_HUMAN_SEGMENT_BYTES = String(bytes); else delete process.env.SUB_HUMAN_SEGMENT_BYTES;
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_SEGMENT_BYTES; else process.env.SUB_HUMAN_SEGMENT_BYTES = was; });
  const code = h.newRoom();
  seatKey.arm();
  return { code, s: store.open(code) as FsRoomStore };
}
const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const say = (s: RoomStore, from: string, text: string, via: 'human' | 'agent' = 'human') => s.append({ kind: 'say', text }, { via, from });
const sys = (s: RoomStore, kind: string, from: string, extra: object = {}) => s.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from);

/** A log as an older sub-human left it: one log.jsonl, chained by hand, alice's key pinned, a proposal she signed. */
function legacyLog(code: string, file: string, n: number): string[] {
  const key = seatKey.ensure(code, 'alice');
  const out: string[] = [];
  let prev = '';
  const start = Date.now() - n * 1000;
  for (let id = 1; id <= n; id++) {
    const now = start + id * 1000;
    let p: Record<string, unknown>;
    if (id === 1) p = { from: 'alice', via: 'system', kind: 'member_joined', to: 'room', text: 'alice joined', pubkey: seatKey.publicPem(code, 'alice') };
    else if (id === 2) p = { from: 'claude', via: 'agent', kind: 'proposal', to: 'room', text: `proposal ${H}: old`, hash: H, approvers: ['alice'] };
    else if (id === 3) p = envelope.sign({ from: 'alice', via: 'human', kind: 'signoff', to: 'room', proposal_hash: H }, key, { room: code, from: 'alice', now });
    else p = { from: id % 2 ? 'alice' : 'bob', via: 'agent', kind: 'say', to: 'room', text: `old ${id} ${'y'.repeat(80)}` };
    const { sig, ...rest } = p as Record<string, unknown> & { sig?: string };
    const e: Record<string, unknown> = { id, at: new Date(now).toISOString(), ...rest, prev: hash12(prev) };
    if (sig !== undefined) e.sig = sig;
    prev = JSON.stringify(e);
    out.push(prev);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
  return out;
}

test('migration: a room with one log.jsonl and an old log.idx opens, folds and appends unchanged, then rotates', t => {
  const { code, s } = room(t);
  const old = legacyLog(code, s.logFile, 400);
  // the checkpoint an older version wrote: never read now, and removed at the first rotation
  const idx = path.join(s.dir, 'log.idx');
  fs.writeFileSync(idx, JSON.stringify({ v: 1, offset: 10, id: 1, hash: 'ffffffffffff', count: 1, marks: [[1, 0, 10]] }));
  assert.deepEqual(s.readAll().map(e => e.id), ids(400));
  assert.deepEqual(s.validateChain(), { ok: true, count: 400 });
  assert.equal(s.verifyChain().ok, true, 'the old checkpoint is not trusted: the chain is checked from byte 0');
  assert.equal(s.trust(s.readAll()[2]), 'verified');
  assert.deepEqual(consent.fold(s.readAll(), s.trust).matrix(H).agreed, ['alice'], 'the fold reads the same');
  assert.deepEqual(s.readView({ after: 398 }).map(e => e.id), [1, 2, 3, 399, 400]);
  const e = say(s, 'alice', 'after the update');
  assert.deepEqual([e.id, e.prev], [401, hash12(old.at(-1)!)], 'the next id and prev, from the old log');
  assert.ok(!fs.existsSync(path.join(s.dir, 'snapshot.json')), 'under the size: still one file');
  assert.equal(lines(s.logFile).length, 401);
  // past the size: the first append seals the old log as it is
  process.env.SUB_HUMAN_SEGMENT_BYTES = '4096';
  const f = say(s, 'alice', 'and now it rotates');
  assert.ok(fs.existsSync(path.join(s.dir, 'log-0001.jsonl')));
  assert.deepEqual(lines(path.join(s.dir, 'log-0001.jsonl')).slice(0, 400), old, 'the old lines, byte for byte');
  assert.ok(!fs.existsSync(idx), 'log.idx is retired');
  assert.deepEqual(lines(s.logFile), [lines(path.join(s.dir, 'log-0001.jsonl')).at(-1)], 'log.jsonl starts again with the sealed last line');
  assert.equal(s.snapshot()!.id, f.id);
  const g = say(s, 'alice', 'the first line of the new segment');
  assert.deepEqual([g.id, g.prev], [f.id + 1, hash12(lines(path.join(s.dir, 'log-0001.jsonl')).at(-1)!)]);
  assert.deepEqual(s.readAll().map(x => x.id), ids(403));
  assert.deepEqual(s.validateChain(), { ok: true, count: 403 });
  assert.deepEqual(consent.fold(s.readAll(), s.trust).matrix(H).agreed, ['alice']);
  assert.deepEqual(consent.fold(s.readView({ after: s.recentFrom() }), s.trust).matrix(H).agreed, ['alice'], 'the recent view folds the same');
  assert.ok(s.pins().has('alice'), 'pins carried by the snapshot');
});

test('rotation: a reader in another process sees the same log; the window keeps the rate across a rotation', t => {
  const { s } = room(t, 1024);
  sys(s, 'member_joined', 'alice', { pubkey: seatKey.publicPem(s.code, 'alice') });
  for (let i = 0; i < 5; i++) say(s, 'bob', `bob ${i}`, 'agent');
  assert.ok(s.rotate() || s.snapshot(), 'sealed');
  const snap = s.snapshot()!;
  assert.ok(snap.window.some(w => w.from === 'bob'), 'the window keeps the last minute');
  say(s, 'bob', 'six', 'agent');
  assert.throws(() => say(s, 'bob', 'seven', 'agent'), (e: Error & { code?: string }) => e.code === 'RATE', 'the rate counts lines before the rotation');
  // another process reads the rotated room the same
 const src = `const s = require(${JSON.stringify(path.join(h.LIB, 'room', 'store.ts'))}).open(${JSON.stringify(s.code)}); process.stdout.write(JSON.stringify({ ids: s.readAll().map(e => e.id), chain: s.validateChain(), pins: [...s.pins().keys()] }))`;
  const r = spawnSync(process.execPath, ['-e', src], { env: h.childEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ids: s.readAll().map(e => e.id), chain: { ok: true, count: s.lastId() }, pins: ['alice'] });
});

test('rotation: a crash between linking the segment and replacing log.jsonl is finished by the next append', t => {
  const { s } = room(t, 1024);
  for (let i = 0; i < 12; i++) say(s, 'alice', `m${i} ${'z'.repeat(60)}`);
  const snap = s.snapshot()!;
  assert.ok(snap, 'rotated');
  const seg: number = JSON.parse(fs.readFileSync(path.join(s.dir, 'snapshot.json'), 'utf8')).seg;
  const sealed = path.join(s.dir, `log-${String(seg).padStart(4, '0')}.jsonl`);
  // the state after the snapshot was written but before log.jsonl was replaced: log.jsonl is the sealed file itself
  fs.rmSync(s.logFile);
  fs.linkSync(sealed, s.logFile);
  const before = lines(sealed);
  assert.deepEqual(s.readAll().map(e => e.id), ids(snap.id), 'readers skip the sealed lines they see twice');
  const e = say(s, 'alice', 'after the crash');
  assert.equal(e.id, snap.id + 1);
  assert.deepEqual(lines(sealed), before, 'the sealed segment was not written to');
  assert.deepEqual(s.validateChain(), { ok: true, count: snap.id + 1 });
});

test('rotation: a lost snapshot is rebuilt from the sealed segments', t => {
  const { s } = room(t, 1024);
  sys(s, 'member_joined', 'alice', { pubkey: seatKey.publicPem(s.code, 'alice') });
  for (let i = 0; i < 30; i++) say(s, 'alice', `m${i} ${'z'.repeat(60)}`);
  const want = { ids: s.readAll().map(e => e.id), snap: s.snapshot() };
  fs.rmSync(path.join(s.dir, 'snapshot.json'));
  const again = store.open(s.code, { dir: s.dir });
  assert.deepEqual(again.readAll().map(e => e.id), want.ids);
  assert.deepEqual(again.snapshot()!.id, want.snap!.id);
  assert.deepEqual([...again.pins().keys()], ['alice']);
  assert.deepEqual(again.validateChain(), { ok: true, count: want.ids.length });
});

test('rotation: an older plugin that appends to log.jsonl after a rotation still chains (the carry line)', t => {
  const { s } = room(t, 1024);
  for (let i = 0; i < 12; i++) say(s, 'alice', `m${i} ${'z'.repeat(60)}`);
  assert.ok(s.snapshot());
  // the 0.5 appender: the last line of log.jsonl gives the next id and prev
  const last = lines(s.logFile).at(-1)!;
  const e = { id: JSON.parse(last).id + 1, at: new Date().toISOString(), from: 'bob', via: 'agent', kind: 'say', to: 'room', text: 'old code', prev: hash12(last) };
  fs.appendFileSync(s.logFile, JSON.stringify(e) + '\n');
  assert.equal(s.readAll().at(-1)!.text, 'old code');
  assert.deepEqual(s.validateChain(), { ok: true, count: e.id });
  assert.equal(say(s, 'alice', 'new code').id, e.id + 1);
});

test('rotation: a segment whose chain breaks is never sealed; the break stays visible', t => {
  const { s } = room(t, 2048);
  for (let i = 0; i < 3; i++) say(s, 'alice', `m${i}`);
  const ls = lines(s.logFile);
  ls[1] = ls[1].replace('"m1"', '"M1"'); // an edit around the store: line 3 no longer chains
  fs.writeFileSync(s.logFile, ls.join('\n') + '\n');
  for (let i = 3; i < 20; i++) say(s, 'alice', `m${i} ${'z'.repeat(80)}`);
  assert.ok(fs.statSync(s.logFile).size > 2048, 'past the size');
  assert.equal(s.snapshot(), null, 'not sealed');
  assert.ok(!fs.existsSync(path.join(s.dir, 'log-0001.jsonl')));
  assert.equal(s.rotate(), false);
  const v = s.verifyChain();
  assert.deepEqual([v.ok, v.badAt], [false, 3]);
});

test('setAside: a demoted host\'s segments become one orphaned log, every line once, in order', t => {
  const { s } = room(t, 1024);
  for (let i = 0; i < 25; i++) say(s, 'alice', `m${i} ${'z'.repeat(60)}`);
  assert.ok(s.snapshot());
  const all = s.readAll();
  const file = s.setAside()!;
  const got = lines(file).map(l => JSON.parse(l) as Entry);
  assert.deepEqual(got.map(e => e.id), all.map(e => e.id));
  for (let i = 1; i < got.length; i++) assert.equal(got[i].prev, hash12(lines(file)[i - 1]));
  assert.deepEqual([s.readAll(), s.snapshot(), fs.existsSync(path.join(s.dir, 'log-0001.jsonl'))], [[], null, false]);
});
