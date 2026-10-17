// The room's directory watch (lib/room/watch.ts, FsRoomStore.watch) the host's streams follow instead of a 250 ms poll:
// a log append and a changed document arrive as one coalesced change naming them; locks and temporary files are not one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as roomWatch from '../lib/room/watch.ts';
import type { Change } from '../lib/room/watch.ts';

test('room watch: docKey maps a changed path to its document; the log, locks and temporary files are none', () => {
  assert.deepEqual(['members.json', 'presence/bob.json', 'tasks.json', 'remote/invites.json', 'log.jsonl', 'members.json.lock', 'x.tmp.json', 'snapshot.json'].map(roomWatch.docKey),
    ['members', 'presence/bob', 'tasks', 'remote/invites', null, null, null, null]);
});

test('room watch: an append and a document write arrive as changes; unwatch stops them', async t => {
  const dir = h.tmpDir('sh-watch-', t);
  fs.mkdirSync(path.join(dir, 'presence'));
  fs.writeFileSync(path.join(dir, 'log.jsonl'), '');
  const got: (Change | null)[] = [];
  const unwatch = roomWatch.watch(dir, c => got.push(c), { slowMs: 60_000 });
  await new Promise(r => setTimeout(r, 50));
  fs.appendFileSync(path.join(dir, 'log.jsonl'), '{"id":1}\n');
  fs.writeFileSync(path.join(dir, 'presence', 'bob.json.tmp'), '{}');
  fs.renameSync(path.join(dir, 'presence', 'bob.json.tmp'), path.join(dir, 'presence', 'bob.json'));
  assert.ok(await h.until(() => got.some(c => c && c.log) && got.some(c => c && c.docs.has('presence/bob')), 3000, 10), JSON.stringify(got.map(c => c && { log: c.log, docs: [...c.docs] })));
  unwatch();
  const n = got.length;
  fs.appendFileSync(path.join(dir, 'log.jsonl'), '{"id":2}\n');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(got.length, n, 'unwatched');
});
