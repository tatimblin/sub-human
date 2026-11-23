// The helpers both backends share: the line format, the chain check over raw lines, the tail file; and home.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headOf, lineHash, parseTail, placeLine, tailText, verifyLines } from './store.js';
import { sha256 } from '../core/hash.js';
import { post } from '../test/support/store-contract.js';
import { blobFile, docFile, fileKey, homeDir, roomDir } from '../home.js';

async function chain(objs: readonly Record<string, unknown>[]): Promise<string[]> {
  const raws: string[] = [];
  let prev = '';
  for (const [i, o] of objs.entries()) {
    const line = JSON.stringify({ ...o, seq: i + 1, prev });
    raws.push(line);
    prev = await lineHash(line);
  }
  return raws;
}
const body = (text: string): Record<string, unknown> => ({ kind: 'post', id: text, at: 1, from: 'ann', by: 'person', machine: 'm1', text });

test('sha256 is hex SHA-256 through crypto.subtle', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('placeLine: the next seq, the head hash as prev, and only what the schema keeps', () => {
  const draft = { ...post('ann', 'hi'), extra: 1 };
  const r = placeLine(draft, { seq: 4, hash: 'h4' });
  assert.ok(r.ok);
  assert.equal(r.value.entry.seq, 5);
  assert.equal(r.value.entry.prev, 'h4');
  assert.ok(!r.value.line.includes('extra'));
});

test('a newer writer\'s extra field and unknown kind keep the chain: the hash is over the raw line', async () => {
  const raws = await chain([body('a'), { ...body('b'), mood: 'new field' }, { ...body('c'), kind: 'poll' }, body('d')]);
  const r = await verifyLines(raws, 0);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map(l => l.entry.seq), [1, 2, 4]); // the poll is left out, the chain runs through it
  const second = r.value[1];
  assert.equal(second?.hash, await lineHash(raws[1] ?? ''));
  assert.equal(r.value[2]?.entry.prev, await lineHash(raws[2] ?? ''));
});

test('verifyLines refuses a gap, a repeat, a bad prev and a line that is not JSON', async () => {
  const raws = await chain([body('a'), body('b'), body('c')]);
  assert.equal((await verifyLines([raws[0] ?? '', raws[2] ?? ''], 0)).ok, false);
  assert.equal((await verifyLines([raws[0] ?? '', raws[0] ?? ''], 0)).ok, false);
  assert.equal((await verifyLines([...raws, '{oops'], 0)).ok, false);
  const r = await verifyLines(raws, 1, 'not the hash of line 1');
  assert.ok(!r.ok && /fork/.test(r.error));
  assert.equal((await verifyLines(raws, 5, 'h')).ok, false); // a snapshot past the end of the log
});

test('verifyLines refuses a line whose prev chains but whose seq is wrong, here or at the cursor', async () => {
  const [one = '', two = ''] = await chain([body('a'), body('b')]);
  const skipped = JSON.stringify({ ...body('c'), seq: 7, prev: await lineHash(two) });
  const r = await verifyLines([one, two, skipped], 0);
  assert.ok(!r.ok && /seq 3/.test(r.error));
  const misplaced = JSON.stringify({ ...body('b'), seq: 5, prev: await lineHash(one) });
  const at = await verifyLines([one, misplaced], 2);
  assert.ok(!at.ok && /no line 2/.test(at.error));
});

test('headOf: empty, a line, a line that is not readable', async () => {
  assert.deepEqual(await headOf(undefined), { ok: true, value: { seq: 0, hash: '' } });
  const [line = ''] = await chain([body('a')]);
  assert.deepEqual(await headOf(line), { ok: true, value: { seq: 1, hash: await lineHash(line) } });
  assert.equal((await headOf('nope')).ok, false);
});

test('the tail file round-trips and refuses what it is not', () => {
  const t = { seq: 3, hash: 'abc', at: 99 };
  assert.deepEqual(parseTail(tailText(t)), { ok: true, value: t });
  assert.equal(parseTail('{"seq":-1,"hash":"x","at":1}').ok, false);
  assert.equal(parseTail('torn').ok, false);
});

test('home: SUB_HUMAN_HOME or ~/.sub-human', () => {
  assert.equal(homeDir({ SUB_HUMAN_HOME: '/tmp/h' }, '/u'), '/tmp/h');
  assert.equal(homeDir({ SUB_HUMAN_HOME: '' }, '/u'), '/u/.sub-human');
  assert.equal(homeDir({}, '/u'), '/u/.sub-human');
  assert.equal(docFile(roomDir('/h', 'ab12'), 'focus', 'ann'), '/h/rooms/ab12/docs/focus/ann.json');
  assert.equal(blobFile(roomDir('/h', 'ab12'), 'ab'), '/h/rooms/ab12/plans/ab.md');
});

test('fileKey: one safe file name per name, on a case-insensitive disk too', async () => {
  assert.equal(await fileKey('ann'), 'ann');
  assert.equal(await fileKey('a.b-c_1'), 'a.b-c_1');
  const odd = ['Ann', 'ANN', 'aNN', '..', '.ann', '../x', 'a/b', '', 'Ann Lee', '\uD800', '\uDC00', 'é', 'É',
    'x'.repeat(65), '日'.repeat(64), '𝄞'.repeat(64)];
  const keys = await Promise.all(odd.map(fileKey));
  for (const k of keys) {
    assert.match(k, /^[a-z0-9_]{0,32}~[0-9a-f]{32}$/, k);
    assert.ok(new TextEncoder().encode(k).length <= 255);
  }
  const all = [...keys, 'ann', 'a.b-c_1'];
  assert.equal(new Set(all.map(k => k.toLowerCase())).size, all.length, 'no two names share a file');
  assert.match(await fileKey('Ann'), /^ann~/);
});
