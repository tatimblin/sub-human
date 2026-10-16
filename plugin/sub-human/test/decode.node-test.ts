// lib/decode.ts: the combinators, and the decoders whose acceptance matters (records older versions wrote).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as d from '../lib/decode.ts';
import * as io from '../lib/io.ts';

const ok = <T>(r: d.Result<T, d.DecodeError>): T => { assert.ok(r.ok, `refused: ${JSON.stringify(r)}`); return r.value; };
const no = (r: d.Result<unknown, d.DecodeError>): d.DecodeError => { assert.ok(!r.ok, 'accepted'); return r.error; };

test('scalars: str num int bool, and unknown_', () => {
  assert.equal(ok(d.str('a')), 'a');
  assert.equal(no(d.str(1)).expected, 'a string');
  assert.equal(ok(d.num(1.5)), 1.5);
  assert.equal(no(d.num('1')).expected, 'a number');
  no(d.num(NaN));
  no(d.num(Infinity));
  assert.equal(ok(d.int(3)), 3);
  no(d.int(3.5));
  no(d.int('3'));
  assert.equal(ok(d.bool(false)), false);
  no(d.bool(0));
  assert.equal(ok(d.unknown_(undefined)), undefined);
});

test('lit: one of the values, by ===', () => {
  const k = d.lit('a', 'b', 1, null);
  assert.equal(ok(k('a')), 'a');
  assert.equal(ok(k(null)), null);
  assert.equal(ok(k(1)), 1);
  assert.equal(no(k('c')).expected, '"a" | "b" | 1 | null');
  no(k('1'));
});

test('arr and record: every item, with where it failed', () => {
  assert.deepEqual(ok(d.arr(d.int)([1, 2])), [1, 2]);
  assert.deepEqual(ok(d.arr(d.int)([])), []);
  assert.deepEqual(no(d.arr(d.int)([1, 'x'])), { at: '[1]', expected: 'an integer' });
  no(d.arr(d.int)({ 0: 1 }));
  assert.deepEqual(ok(d.record(d.str)({ a: 'x' })), { a: 'x' });
  assert.deepEqual(no(d.record(d.str)({ a: 'x', b: 2 })), { at: '.b', expected: 'a string' });
  no(d.record(d.str)([]));
  no(d.record(d.str)(null));
});

test('obj: listed fields checked, unknown keys kept, the input itself returned', () => {
  const D = d.obj({ a: d.str, b: d.opt(d.int), c: d.nullable(d.bool) });
  const v = { a: 'x', c: null, extra: { deep: 1 } };
  const got = ok(D(v));
  assert.equal(got, v, 'the same object, not a copy');
  assert.deepEqual((got as unknown as { extra: unknown }).extra, { deep: 1 });
  ok(D({ a: 'x', b: undefined, c: true }));
  assert.deepEqual(no(D({ c: true })), { at: '.a', expected: 'a string' });
  assert.deepEqual(no(D({ a: 'x', b: 1.5, c: true })), { at: '.b', expected: 'an integer' });
  assert.deepEqual(no(D({ a: 'x' })), { at: '.c', expected: 'a boolean' }, 'nullable is not optional');
  no(D([]));
  no(D(null));
  no(D('x'));
  const nested = d.obj({ p: d.obj({ q: d.arr(d.str) }) });
  assert.deepEqual(no(nested({ p: { q: ['a', 3] } })), { at: '.p.q[1]', expected: 'a string' });
});

test('union by tag, refine, decode, decodeOr, isObj, objAs, guard', () => {
  const U = d.union('kind', { a: d.obj({ kind: d.lit('a'), n: d.int }), b: d.obj({ kind: d.lit('b'), s: d.str }) });
  assert.deepEqual(ok(U({ kind: 'a', n: 1 })), { kind: 'a', n: 1 });
  assert.deepEqual(no(U({ kind: 'c' })), { at: '.kind', expected: 'a | b' });
  assert.deepEqual(no(U({ kind: 'b', s: 1 })), { at: '.s', expected: 'a string' });
  no(U({ kind: 'toString' }));
  const pos = d.refine(d.int, n => n > 0, 'a positive integer');
  assert.equal(ok(pos(2)), 2);
  assert.equal(no(pos(0)).expected, 'a positive integer');
  assert.equal(no(pos('x')).expected, 'an integer');
  assert.equal(d.decode(d.int, 2), 2);
  assert.equal(d.decode(d.int, 'x'), null);
  assert.equal(d.decodeOr(d.int, 'x', 7), 7);
  assert.equal(d.decodeOr(d.int, 'x', null), null);
  assert.equal(d.isObj({}), true);
  assert.equal(d.isObj([]), false);
  assert.equal(d.isObj(null), false);
  const o = { any: 1 };
  assert.equal(ok(d.objAs<{ any?: unknown }>()(o)), o);
  no(d.objAs()([]));
  assert.equal(d.guard(d.str)('x'), true);
  assert.equal(d.guard(d.str)(1), false);
});

test('io.readJson: the decoder or the fallback; readJsonRaw: undefined when unreadable', () => {
  const dir = h.tmpDir('sh-decode-');
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, '{"a":"x","b":1}');
  assert.deepEqual(io.readJson(f, d.obj({ a: d.str }), null), { a: 'x', b: 1 });
  assert.equal(io.readJson(f, d.obj({ a: d.int }), null), null);
  fs.writeFileSync(f, '{torn');
  assert.equal(io.readJson(f, d.objAs(), 'fb'), 'fb');
  assert.equal(io.readJsonRaw(f), undefined);
  fs.writeFileSync(f, 'null');
  assert.equal(io.readJsonRaw(f), null);
});

// ---------- records older versions wrote: each still reads as it did ----------

test('old records: a session index (0.5.0-beta.4 shape, extra keys, no role) still names its seat', async t => {
  const home = h.freshHome(t);
  const identity = await import('../lib/identity.ts');
  const { code } = h.register('alice');
  const sid = `sess-alice-${process.pid}`;
  const file = path.join(home, 'sessions', 'by-sid', `${sid}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rec).sort(), ['address', 'code', 'name', 'pid', 'pid_start', 'role', 'session_id'].filter(k => k in rec).sort());
  // beta.4 wrote the same fields, pid_start only when known; a newer one may add fields
  const { pid_start: _, role: _r, ...old } = rec;
  fs.writeFileSync(file, JSON.stringify({ ...old, later: { field: 1 } }));
  assert.deepEqual(identity.lastSeat(sid), { code, name: 'alice', role: 'member', address: `alice.${code}` });
  assert.equal(identity.resolveBySession(sid)!.name, 'alice');
  fs.writeFileSync(file, JSON.stringify({ ...old, code: 7 }));
  assert.equal(identity.lastSeat(sid), null, 'no room code: no seat (as before)');
  fs.writeFileSync(file, '[]');
  assert.equal(identity.lastSeat(sid), null);
});

test('old records: a module lease without nonce or pid_start reads; a fork record keeps home only as a string', async t => {
  const home = h.freshHome(t);
  const identity = await import('../lib/identity.ts');
  const sid = '0123abcd-0000-4000-8000-000000000001';
  fs.mkdirSync(path.join(home, 'sessions', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'mods', `${sid}.json`), JSON.stringify({ session_id: sid, pid: null, at: new Date().toISOString() }));
  assert.deepEqual(identity.readModLease(sid), { session_id: sid, pid: null, at: identity.readModLease(sid)!.at });
  fs.mkdirSync(path.join(home, 'sessions', 'forked'), { recursive: true });
  const f = path.join(home, 'sessions', 'forked', `${sid}.json`);
  fs.writeFileSync(f, JSON.stringify({ sid: 'old', title: 'T', home: 5, at: 'x' }));
  assert.deepEqual(identity.forkedOf(sid), { sid: 'old', title: 'T' });
  fs.writeFileSync(f, JSON.stringify({ sid: 'old', title: 'T', home: '/h' }));
  assert.deepEqual(identity.forkedOf(sid), { sid: 'old', title: 'T', home: '/h' });
  fs.writeFileSync(f, JSON.stringify({ sid: 'old' }));
  assert.equal(identity.forkedOf(sid), null);
});

test('old records: members.json keeps the fields this version does not know through an update', async t => {
  h.freshHome(t);
  const store = await import('../lib/room/store.ts');
  const { code } = h.register('alice');
  const s = store.open(code);
  const file = path.join(s.dir!, 'members.json');
  const ms = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  ms.alice.from_the_future = { x: 1 };
  ms.ghost = { name: 'ghost', role: 'member', left_at: 'then' } as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(ms));
  s.members.update(m => m);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.deepEqual(after.alice.from_the_future, { x: 1 });
  assert.equal(after.ghost.left_at, 'then');
  assert.deepEqual(Object.keys(s.members.read()).sort(), ['alice', 'ghost']);
});

test('old records: gc.json with only at, a link record and its state with unknown keys', async t => {
  const home = h.freshHome(t);
  const gc = await import('../lib/gc.ts');
  const links = await import('../lib/room/links.ts');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'gc.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.equal(gc.sweep(), null, 'a sweep began just now: none runs');
  fs.writeFileSync(path.join(home, 'gc.json'), JSON.stringify({ at: 5 }));
  assert.notEqual(gc.sweep(), null, 'an unreadable record: a sweep runs (as with none)');
  const code = (await import('../lib/identity.ts')).newCode();
  fs.mkdirSync(links.linksDir(), { recursive: true });
  fs.writeFileSync(path.join(links.linksDir(), `${code}.json`), JSON.stringify({ code, transport: { kind: 'pipe' }, newer: true }));
  assert.equal((links.get(code) as unknown as { newer: boolean }).newer, true);
  fs.writeFileSync(links.stateFile(code), JSON.stringify({ state: 'online', since: 'x', later: 1 }));
  assert.equal(links.readState(code)!.state, 'online');
  fs.writeFileSync(links.stateFile(code), '"online"');
  assert.equal(links.readState(code), null);
});
