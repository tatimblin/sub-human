// core/link-engine.ts as a table of event scripts on a fake clock: timers the engine sets fire as the clock advances,
// and each row checks the phase and the effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backoff, initial, step } from './link-engine.js';
import type { LinkEffect, LinkEvent, LinkState, Timer, Timings } from './link-engine.js';

const T: Timings = { retryMs: 1000, retryMaxMs: 10_000, dialMs: 20_000, pingMs: 15_000, pongMs: 5000, tickMs: 2000, postTtlMs: 60_000 };

/** The engine on a fake clock; fx holds every effect since the last take(). */
function rig(seed = 1) {
  let now = 1_000_000;
  let st: LinkState = initial(T, now, seed);
  let fx: LinkEffect[] = [];
  const timers = new Map<Timer, number>();
  const send = (ev: LinkEvent): void => {
    const r = step(st, ev, now);
    st = r.state;
    for (const e of r.effects) {
      fx.push(e);
      if (e.type === 'setTimer') timers.set(e.name, now + e.ms);
      if (e.type === 'clearTimer') timers.delete(e.name);
    }
  };
  /** Move the clock, firing each timer that comes due, in order. */
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, at]) => at <= end).sort((a, b) => a[1] - b[1])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1];
      send({ type: 'timer', name: due[0] });
    }
    now = end;
  };
  /** The lid closed: the clock moves and no timer runs meanwhile. */
  const sleep = (ms: number): void => { now += ms; };
  const take = (): LinkEffect[] => { const out = fx; fx = []; return out; };
  const online = (conn: number): void => { send({ type: 'connected', conn }); send({ type: 'synced', conn }); };
  return { send, advance, sleep, take, online, timers, get st() { return st; }, get now() { return now; } };
}
type Rig = ReturnType<typeof rig>;
const of = <K extends LinkEffect['type']>(es: LinkEffect[], type: K) => es.filter((e): e is Extract<LinkEffect, { type: K }> => e.type === type);

/** n failed dials in a row; each retry fires exactly at its delay. The delays. */
function failures(r: Rig, n: number): number[] {
  r.send({ type: 'start' });
  const out: number[] = [];
  for (let conn = 1; conn <= n; conn++) {
    r.send({ type: 'failed', conn, why: 'no route to host' });
    const set = of(r.take(), 'setTimer').find(e => e.name === 'retry');
    assert.ok(set);
    out.push(set.ms);
    r.advance(set.ms - 1);
    assert.equal(r.st.conn, null, 'not before the delay');
    r.advance(1);
    assert.equal(r.st.conn, conn + 1, 'the retry dials');
  }
  return out;
}

const TABLE: { name: string; seed?: number; run(r: Rig): void }[] = [
  {
    name: 'start dials; connected subscribes; synced is online with flush and the heartbeat armed',
    run(r) {
      r.send({ type: 'start' });
      assert.deepEqual(r.take(), [
        { type: 'status', phase: 'connecting', why: null }, { type: 'dial', conn: 1 }, { type: 'setTimer', name: 'dial', ms: T.dialMs },
      ]);
      r.send({ type: 'connected', conn: 1 });
      assert.deepEqual(r.take(), [{ type: 'subscribe', conn: 1, fresh: false }]);
      r.send({ type: 'synced', conn: 1 });
      assert.deepEqual(r.take(), [
        { type: 'clearTimer', name: 'dial' },
        { type: 'status', phase: 'online', why: null },
        { type: 'flush', conn: 1, posts: [] },
        { type: 'setTimer', name: 'ping', ms: T.pingMs },
      ]);
      assert.equal(r.st.since, r.now);
    },
  },
  {
    name: 'a failed dial goes offline with the reason and retries after a jittered backoff that grows to the cap',
    run(r) {
      const delays = failures(r, 6);
      assert.deepEqual([r.st.phase, r.st.why], ['offline', 'no route to host']);
      let prev = T.retryMs;
      for (const d of delays) {
        assert.ok(d >= T.retryMs && d <= Math.min(T.retryMaxMs, prev * 3), `${d} after ${prev}`);
        prev = d;
      }
      r.online(7);
      assert.deepEqual([r.st.phase, r.st.delay], ['online', T.retryMs], 'online resets the backoff');
    },
  },
  {
    name: 'the jitter comes from the seed: the same seed gives the same delays, another seed others',
    run() {
      assert.deepEqual(failures(rig(7), 4), failures(rig(7), 4));
      assert.notDeepEqual(failures(rig(7), 4), failures(rig(8), 4));
      assert.equal(backoff(1000, 1000, 10_000, 0), 1000);
      assert.equal(backoff(1000, 1000, 10_000, 1), 3000);
      assert.equal(backoff(9000, 1000, 10_000, 1), 10_000);
    },
  },
  {
    name: 'heartbeat: a ping every pingMs; a pong re-arms it; no pong within pongMs drops the half-open connection',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.take();
      r.advance(T.pingMs);
      assert.deepEqual(r.take().filter(e => e.type !== 'clearTimer'), [{ type: 'ping', conn: 1 }, { type: 'setTimer', name: 'pong', ms: T.pongMs }]);
      r.advance(100);
      r.send({ type: 'pong', conn: 1 });
      assert.deepEqual(r.take(), [{ type: 'clearTimer', name: 'pong' }, { type: 'setTimer', name: 'ping', ms: T.pingMs }]);
      r.advance(T.pingMs + T.pongMs);
      const out = r.take();
      assert.deepEqual(of(out, 'close'), [{ type: 'close', conn: 1 }]);
      assert.equal(r.st.phase, 'offline');
      assert.match(r.st.why ?? '', /no answer from the host within 5 s/);
      assert.ok(r.timers.has('retry'));
    },
  },
  {
    name: 'sleep or a clock jump: a ping at once when online; a dial at once, backoff reset, when offline',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.advance(T.tickMs);
      r.send({ type: 'tick' });
      r.take();
      r.sleep(10 * 60_000);
      r.send({ type: 'tick' });
      assert.ok(r.take().some(e => e.type === 'ping'), 'a gap: is the connection still there?');
      r.send({ type: 'tick' });
      assert.ok(!r.take().some(e => e.type === 'ping'), 'no gap: nothing');
      r.send({ type: 'failed', conn: 1, why: 'reset' });
      r.take();
      assert.ok(r.timers.has('retry'));
      const back = r.st.lastTick - 60_000; // the wall clock set back
      const s = step(r.st, { type: 'tick' }, back);
      assert.deepEqual(s.effects.filter(e => e.type === 'dial'), [{ type: 'dial', conn: 2 }]);
      assert.ok(s.effects.some(e => e.type === 'clearTimer' && e.name === 'retry'));
    },
  },
  {
    name: 'a network change: a ping when online, a dial now when offline; a dial under way is dropped and made again',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.take();
      r.send({ type: 'network' });
      assert.ok(r.take().some(e => e.type === 'ping'));
      r.send({ type: 'failed', conn: 1, why: 'wifi gone' });
      r.take();
      r.send({ type: 'network' });
      assert.deepEqual(of(r.take(), 'dial'), [{ type: 'dial', conn: 2 }]);
      r.send({ type: 'network' });
      const again = r.take();
      assert.deepEqual([of(again, 'close'), of(again, 'dial')], [[{ type: 'close', conn: 2 }], [{ type: 'dial', conn: 3 }]]);
    },
  },
  {
    name: 'posts: sent at once when online, queued when not, flushed on reconnect under their ids until acked',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.take();
      r.send({ type: 'post', id: 'c-1' });
      assert.deepEqual(r.take(), [{ type: 'send', conn: 1, id: 'c-1' }]);
      r.send({ type: 'failed', conn: 1, why: 'gone' });
      r.send({ type: 'post', id: 'c-2' });
      r.send({ type: 'post', id: 'c-2' });
      assert.ok(!r.take().some(e => e.type === 'send'), 'offline: queued, once');
      r.advance(r.st.delay);
      r.online(2);
      assert.deepEqual(of(r.take(), 'flush'), [{ type: 'flush', conn: 2, posts: ['c-1', 'c-2'] }], 'c-1 was never acked');
      r.send({ type: 'acked', id: 'c-1' });
      r.send({ type: 'acked', id: 'c-2' });
      assert.deepEqual(r.st.queue, []);
    },
  },
  {
    name: 'a post not acked within postTtlMs is dropped and named',
    run(r) {
      r.send({ type: 'start' });
      r.send({ type: 'failed', conn: 1, why: 'gone' });
      r.send({ type: 'post', id: 'c-1' });
      r.advance(30_000);
      r.send({ type: 'post', id: 'c-2' });
      r.take();
      r.advance(30_000);
      r.send({ type: 'tick' });
      assert.deepEqual(of(r.take(), 'expired'), [{ type: 'expired', ids: ['c-1'] }]);
      assert.deepEqual(r.st.queue.map(p => p.id), ['c-2']);
    },
  },
  {
    name: 'fork: resubscribe from scratch, then re-send the queued posts under their ids',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.send({ type: 'post', id: 'c-9' });
      r.take();
      r.send({ type: 'fork', conn: 1 });
      assert.deepEqual(r.take(), [{ type: 'subscribe', conn: 1, fresh: true }, { type: 'setTimer', name: 'dial', ms: T.dialMs }]);
      r.send({ type: 'post', id: 'c-10' });
      assert.ok(!r.take().some(e => e.type === 'send'), 'not while resyncing');
      r.send({ type: 'synced', conn: 1 });
      assert.deepEqual(of(r.take(), 'flush'), [{ type: 'flush', conn: 1, posts: ['c-9', 'c-10'] }]);
    },
  },
  {
    name: 'kick: stops for good, closes, and nothing dials again',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.take();
      r.send({ type: 'bye', conn: 1, reason: 'kicked' });
      const out = r.take();
      assert.deepEqual(of(out, 'close'), [{ type: 'close', conn: 1 }]);
      assert.deepEqual(of(out, 'finish'), [{ type: 'finish', why: 'the host removed you from this room' }]);
      assert.equal(r.st.phase, 'stopped');
      for (const ev of [{ type: 'network' }, { type: 'tick' }, { type: 'start' }, { type: 'timer', name: 'retry' }] satisfies LinkEvent[]) r.send(ev);
      r.advance(60_000);
      assert.ok(!r.take().some(e => e.type === 'dial'));
    },
  },
  {
    name: 'refused and skew stop too; a local stop finishes once',
    run(r) {
      for (const reason of ['refused', 'skew'] as const) {
        const q = rig();
        q.send({ type: 'start' });
        q.send({ type: 'connected', conn: 1 });
        q.send({ type: 'bye', conn: 1, reason });
        assert.equal(q.st.phase, 'stopped', reason);
      }
      r.send({ type: 'start' });
      r.send({ type: 'stop', why: 'left the room' });
      r.send({ type: 'stop', why: 'again' });
      assert.equal(of(r.take(), 'finish').length, 1);
    },
  },
  {
    name: 'a dial that never connects is dropped after dialMs and retried',
    run(r) {
      r.send({ type: 'start' });
      r.take();
      r.advance(T.dialMs);
      const out = r.take();
      assert.deepEqual(of(out, 'close'), [{ type: 'close', conn: 1 }]);
      assert.deepEqual([r.st.phase, r.st.conn, r.timers.has('retry')], ['offline', null, true]);
      assert.match(r.st.why ?? '', /within 20 s/);
    },
  },
  {
    name: 'a host that never answers subscribe is dropped after dialMs; a fork resync is held to it too',
    run(r) {
      r.send({ type: 'start' });
      r.send({ type: 'connected', conn: 1 });
      r.advance(T.dialMs);
      assert.deepEqual([r.st.phase, r.st.conn], ['offline', null]);
      r.advance(r.st.delay);
      r.online(2);
      r.send({ type: 'fork', conn: 2 });
      r.advance(T.dialMs - 1);
      assert.equal(r.st.conn, 2);
      r.advance(1);
      assert.deepEqual([r.st.phase, r.st.conn], ['offline', null]);
    },
  },
  {
    name: 'synced in time clears the deadline; a pong keeps it online past dialMs',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      assert.ok(!r.timers.has('dial'));
      r.advance(T.pingMs);
      r.send({ type: 'pong', conn: 1 });
      r.advance(T.dialMs - T.pingMs);
      assert.equal(r.st.phase, 'online');
    },
  },
  {
    name: 'sleep during a dial: the next tick drops the pending dial and dials again at once',
    run(r) {
      r.send({ type: 'start' });
      r.send({ type: 'tick' });
      r.take();
      r.sleep(10 * 60_000);
      r.send({ type: 'tick' });
      const out = r.take();
      assert.deepEqual([of(out, 'close'), of(out, 'dial')], [[{ type: 'close', conn: 1 }], [{ type: 'dial', conn: 2 }]]);
      assert.ok(!r.timers.has('retry'), 'no backoff wait: it dials now');
    },
  },
  {
    name: 'host away: shown as such, retried, and kept through failed dials until a dial gets through',
    run(r) {
      r.send({ type: 'start' });
      r.online(1);
      r.take();
      r.send({ type: 'bye', conn: 1, reason: 'host_away' });
      assert.deepEqual([r.st.phase, r.st.why], ['host_away', 'host away']);
      assert.ok(r.timers.has('retry'));
      r.advance(r.st.delay);
      r.send({ type: 'failed', conn: 2, why: 'connection refused' });
      assert.equal(r.st.phase, 'host_away');
      r.advance(r.st.delay);
      r.online(3);
      assert.equal(r.st.phase, 'online');
    },
  },
  {
    name: 'events for an old connection change nothing',
    run(r) {
      r.send({ type: 'start' });
      r.send({ type: 'failed', conn: 1, why: 'x' });
      r.advance(r.st.delay);
      r.take();
      const before = r.st;
      for (const ev of [
        { type: 'connected', conn: 1 }, { type: 'synced', conn: 1 }, { type: 'failed', conn: 1, why: 'late' },
        { type: 'pong', conn: 1 }, { type: 'bye', conn: 1, reason: 'kicked' }, { type: 'fork', conn: 1 },
      ] satisfies LinkEvent[]) r.send(ev);
      assert.deepEqual(r.take(), []);
      assert.deepEqual(r.st, before);
    },
  },
];

for (const row of TABLE) test(`link engine: ${row.name} (R32)`, () => row.run(rig(row.seed)));

test('link engine: step never changes the state passed in', () => {
  const s = initial(T, 0, 1);
  const copy = structuredClone(s);
  step(s, { type: 'start' }, 0);
  step(s, { type: 'post', id: 'x' }, 0);
  assert.deepEqual(s, copy);
});
