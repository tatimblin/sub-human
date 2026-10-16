// lib/room/store.ts: a log lock that times out is RoomError LOCK with withLock's message (it was LOCK with an empty
// message: withLock built the RoomError with its message in the code argument).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import * as h from './helpers.ts';
import * as room from '../lib/room.ts';
import * as lock from '../lib/lock.ts';
import type { FsRoomStore } from '../lib/room/store.ts';

test('room: a held log lock times out as RoomError LOCK with a message', async t => {
  h.freshHome();
  const R = room.open(h.newRoom());
  R.append({ kind: 'say', text: 'first' }, { via: 'agent', from: 'alice' });
  const sleeper = h.spawnSleeper(30);
  await h.sleep(100);
  const L = (R.store as FsRoomStore).logFile + '.lock'; // freshHome: the file store
  fs.writeFileSync(L, `${sleeper.pid} ${os.hostname()} ${lock.pidStart(sleeper.pid)}`); // a live owner
  // the clock runs 1000x fast, so LOCK_TIMEOUT_MS passes in a few ms
  const realNow = Date.now;
  const t0 = realNow();
  t.mock.method(Date, 'now', () => { const n = realNow(); return n + (n - t0) * 1000; });
  try {
    assert.throws(() => R.append({ kind: 'say', text: 'second' }, { via: 'agent', from: 'alice' }), e => {
      assert.ok(e instanceof room.RoomError);
      assert.equal(e.code, 'LOCK');
      assert.match(e.message, /could not acquire .*log\.jsonl\.lock/);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    fs.unlinkSync(L);
    sleeper.kill();
  }
});
