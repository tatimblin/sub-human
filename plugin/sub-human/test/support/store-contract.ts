// The RoomStore contract (TESTING §3), one suite for every backend: store/store-contract.node-test.ts runs it over
// memory and fs, and the mirror joins it later with a Backend of its own.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoreDraft } from '../../core/entries.js';
import type { RoomStore } from '../../store/store.js';
import { fold } from '../../core/fold.js';
import { must } from './must.js';

/** A fresh room in a backend. */
export interface Backend { room(every?: number): Promise<Room> }
export interface Room {
  /** A new handle on this same room (another process, on disk). */
  open(): RoomStore;
  /** Rewrites stored line `seq` as a forked host would. */
  forge(seq: number, edit: (line: string) => string): Promise<void>;
}

let ids = 0;
export const post = (from: string, text: string): StoreDraft =>
  ({ kind: 'post', id: `p${++ids}`, at: ids, from, by: 'person', machine: 'm1', text });
const joined = (from: string): StoreDraft => ({ kind: 'joined', id: `j${++ids}`, at: ids, from, by: 'system', machine: 'm1' });

async function appendAll(s: RoomStore, drafts: readonly StoreDraft[]): Promise<void> {
  for (const d of drafts) assert.ok((await s.append(d)).ok, 'an append');
}

export function storeContract(name: string, backend: Backend): void {
  describe(`RoomStore contract: ${name}`, () => {
    test('appends get the next seq and name the hash before them', async () => {
      const s = (await backend.room()).open();
      assert.deepEqual(await s.head(), { ok: true, value: { seq: 0, hash: '' } });
      const a = await s.append(joined('ann'));
      const b = await s.append(post('ann', 'hi'));
      assert.ok(a.ok && b.ok);
      assert.equal(a.value.entry.seq, 1);
      assert.equal(a.value.entry.prev, '');
      assert.equal(b.value.entry.seq, 2);
      assert.equal(b.value.entry.prev, a.value.hash);
      assert.deepEqual(await s.head(), { ok: true, value: { seq: 2, hash: b.value.hash } });
      assert.deepEqual(await s.read(0), { ok: true, value: [a.value, b.value] });
      assert.deepEqual(await s.read(1), { ok: true, value: [b.value] });
      assert.deepEqual(await s.read(2), { ok: true, value: [] });
      assert.deepEqual(await s.read(9), { ok: true, value: [] });
      assert.deepEqual(await s.read(1, a.value.hash), { ok: true, value: [b.value] }); // a cursor's hash that holds
      const moved = await s.read(1, b.value.hash);
      assert.ok(!moved.ok && /fork/.test(moved.error), 'a cursor whose line changed is a fork');
    });

    test('a draft that is not an entry is refused and nothing is stored', async () => {
      const s = (await backend.room()).open();
      const bad: StoreDraft = { ...post('ann', 'x'), from: '' };
      const r = await s.append(bad);
      assert.equal(r.ok, false);
      assert.deepEqual(await s.read(0), { ok: true, value: [] });
    });

    test('documents: latest wins, per kind and name, seen by every handle', async () => {
      const room = await backend.room();
      const s = room.open();
      assert.equal(await s.getDoc('presence', 'ann'), null);
      await s.putDoc('presence', 'ann', { name: 'ann', state: 'working', at: 1 });
      await s.putDoc('presence', 'ann', { name: 'ann', state: 'idle', at: 2 });
      await s.putDoc('presence', 'bob', { name: 'bob', state: 'working', at: 3 });
      await s.putDoc('focus', 'ann', { name: 'ann', text: 'paging', at: 4 });
      const other = room.open();
      assert.deepEqual(await other.getDoc('presence', 'ann'), { name: 'ann', state: 'idle', at: 2 });
      const docs = await other.docs();
      assert.deepEqual([...docs.presence].sort((x, y) => x.at - y.at), [
        { name: 'ann', state: 'idle', at: 2 }, { name: 'bob', state: 'working', at: 3 },
      ]);
      assert.deepEqual(docs.focus, [{ name: 'ann', text: 'paging', at: 4 }]);
      assert.deepEqual(docs.activity, []);
      assert.deepEqual(await s.head(), { ok: true, value: { seq: 0, hash: '' } });
    });

    test('plan text is stored by its hash', async () => {
      const s = (await backend.room()).open();
      const h = await s.putBlob('# plan\n\n1. page');
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.equal(await s.putBlob('# plan\n\n1. page'), h);
      assert.equal(await s.getBlob(h), '# plan\n\n1. page');
      assert.equal(await s.getBlob('0'.repeat(64)), null);
      assert.equal(await s.getBlob('../../log'), null);
    });

    test('the snapshot plus the lines after it fold to the state of the whole log', async () => {
      const s = (await backend.room(5)).open();
      await appendAll(s, [joined('ann'), joined('bob'), post('ann', 'a'), post('bob', 'b'), joined('cy'),
        post('cy', 'c'), { kind: 'left', id: 'l1', at: 90, from: 'bob', by: 'system', machine: 'm1' }, post('ann', 'd'),
        post('ann', 'e'), post('cy', 'f'), post('ann', 'g'), post('bob', 'h')]);
      await s.putDoc('presence', 'ann', { name: 'ann', state: 'working', at: 5 });
      const c = await s.catchup();
      assert.ok(c.ok);
      const snap = must(c.value.snapshot, 'a snapshot');
      assert.equal(snap.state.seq, 10);
      assert.deepEqual(c.value.lines.map(l => l.entry.seq), [11, 12]);
      const all = await s.read(0);
      assert.ok(all.ok);
      const docs = await s.docs();
      assert.deepEqual(fold(snap, c.value.lines, docs), fold(null, all.value, docs));
    });

    test('a broken chain is reported as a fork, never repaired', async () => {
      const room = await backend.room();
      const s = room.open();
      await appendAll(s, [joined('ann'), post('ann', 'one'), post('ann', 'two'), post('ann', 'three'), post('ann', 'four')]);
      await room.forge(3, l => l.replace('two', 'TWO'));
      for (const after of [0, 2, 3]) {
        const r = await s.read(after);
        assert.equal(r.ok, false, `read(${after})`);
        assert.ok(!r.ok && /fork/.test(r.error));
      }
      assert.equal((await s.read(4)).ok, true); // the lines after 4 still chain to it
      assert.equal((await s.catchup()).ok, false);
    });

    test('a log rewritten under its snapshot is a fork', async () => {
      const room = await backend.room(4);
      const s = room.open();
      await appendAll(s, [joined('ann'), post('ann', 'a'), post('ann', 'b'), post('ann', 'c'), post('ann', 'd')]);
      assert.equal((await s.catchup()).ok, true);
      await room.forge(4, l => l.replace('"c"', '"C"'));
      const c = await s.catchup();
      assert.ok(!c.ok && /fork/.test(c.error));
    });

    test('no snapshot is taken over a fork', async () => {
      const room = await backend.room(3);
      const s = room.open();
      await appendAll(s, [joined('ann'), post('ann', 'a')]);
      await room.forge(1, l => l.replace('"m1"', '"m9"'));
      await s.append(post('ann', 'b')); // a snapshot is due at 3
      await room.forge(1, l => l.replace('"m9"', '"m1"')); // the host's log again
      const c = await s.catchup();
      assert.ok(c.ok);
      assert.equal(c.value.snapshot, null);
      assert.equal(c.value.lines.length, 3);
    });

    test('concurrent writers on several handles each get their own seq, and the chain holds', async () => {
      const room = await backend.room();
      const writers = [room.open(), room.open(), room.open(), room.open()];
      const results = await Promise.all(writers.flatMap((w, i) => Array.from({ length: 10 }, (_, j) => w.append(post(`w${i}`, `${j}`)))));
      const seqs = results.map(r => (r.ok ? r.value.entry.seq : 0)).sort((a, b) => a - b);
      assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
      const all = await room.open().read(0);
      assert.ok(all.ok);
      assert.equal(all.value.length, 40);
    });
  });
}
