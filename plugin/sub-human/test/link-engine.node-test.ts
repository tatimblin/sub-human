// The link daemon's state machine (lib/remote/link-engine.ts), with no I/O: a table of event scripts run on the fake
// clock (lib/clock.ts createFake), timers carried out by the clock, each row checking the phase, the counters and the
// effects. serveMirror's runs against a real server are in test/remote-reconnect.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../lib/remote/link-engine.ts';
import * as clock from '../lib/clock.ts';
import type { EngineEffect, EngineEvent, EngineState } from '../lib/remote/link-engine.ts';
import type { LinkTimings } from '../lib/remote/types-core.ts';
import { must } from './support/must.ts';

const T: LinkTimings = { retryMs: 1000, retryMaxMs: 10_000, pingMs: 15_000, pongMs: 5000, deadMs: 10_000, wakeTickMs: 2000, wakeGapMs: 5000, netPollMs: 5000, relayMs: 2000 };

/** The engine on a fake clock: dispatch() runs an event, timers fire as the clock advances; fx holds every effect. */
function rig(random: () => number = () => 0) {
  const c = clock.createFake({ now: 1_000_000 });
  let st: EngineState = engine.initial(c.now(), T.retryMs);
  const fx: EngineEffect[] = [];
  const timers = new Map<string, ReturnType<typeof c.setTimeout>>();
  const dispatch = (ev: EngineEvent): EngineEffect[] => {
    const r = engine.step(st, ev, { timings: T, random, now: c.now() });
    st = r.state;
    for (const e of r.effects) {
      fx.push(e);
      if (e.type === 'setTimer') {
        c.clearTimeout(timers.get(e.name));
        timers.set(e.name, c.setTimeout(() => { timers.delete(e.name); dispatch({ type: 'timer', name: e.name }); }, e.ms));
      } else if (e.type === 'clearTimer') { c.clearTimeout(timers.get(e.name)); timers.delete(e.name); }
    }
    return r.effects;
  };
  /** The four steps of dial d, done. */
  const dialOk = (d: number, pings = true) => {
    dispatch({ type: 'connected', dial: d });
    dispatch({ type: 'subscribed', dial: d });
    dispatch({ type: 'seated', dial: d });
    return dispatch({ type: 'flushed', dial: d, pings });
  };
  const types = (es: EngineEffect[]) => es.map(e => e.type);
  const of = <K extends EngineEffect['type']>(es: EngineEffect[], type: K) => es.filter((e): e is Extract<EngineEffect, { type: K }> => e.type === type);
  return { c, dispatch, dialOk, fx, types, of, get st() { return st; }, timers };
}

const off = (message = 'no route to host') => ({ code: 'OFFLINE', message });

const TABLE: { name: string; random?: () => number; run(r: ReturnType<typeof rig>): void }[] = [
  {
    name: 'start: connecting, one dial; its four steps in order, then online with the heartbeat armed',
    run(r) {
      assert.deepEqual(r.types(r.dispatch({ type: 'start' })), ['publish', 'log', 'connect', 'publish']);
      assert.deepEqual([r.st.phase, r.st.dial, r.st.attempts, engine.shown(r.st)], ['connecting', 1, 1, 'connecting']);
      assert.deepEqual(r.types(r.dispatch({ type: 'connected', dial: 1 })), ['subscribe']);
      assert.deepEqual(r.types(r.dispatch({ type: 'subscribed', dial: 1 })), ['keepSeats']);
      assert.deepEqual(r.types(r.dispatch({ type: 'seated', dial: 1 })), ['flush']);
      const live = r.dispatch({ type: 'flushed', dial: 1, pings: true });
      assert.deepEqual(r.types(live), ['publish', 'online', 'clearTimer', 'clearTimer', 'setTimer']);
      assert.deepEqual([r.st.phase, r.st.conn, r.st.dial, r.st.attempts], ['online', 1, null, 0]);
      assert.deepEqual(r.of(live, 'setTimer')[0], { type: 'setTimer', name: 'ping', ms: T.pingMs });
    },
  },
  {
    name: 'a host without ping: online, no heartbeat',
    run(r) {
      r.dispatch({ type: 'start' });
      assert.equal(r.of(r.dialOk(1, false), 'setTimer').length, 0);
      r.c.advance(60_000);
      assert.equal(r.of(r.fx, 'sendPing').length, 0);
    },
  },
  {
    name: 'a failed first dial: offline with the reason, a retry after the jittered delay, attempts counted',
    run(r) {
      r.dispatch({ type: 'start' });
      const out = r.dispatch({ type: 'dialFailed', dial: 1, error: { ...off(), reason: null }, offline: 'the host is unreachable' });
      assert.deepEqual([r.st.phase, r.st.reason, r.st.lastError, r.st.retrying], ['offline', 'the host is unreachable', 'no route to host', true]);
      assert.deepEqual(r.of(out, 'setTimer'), [{ type: 'setTimer', name: 'retry', ms: 1000 }], 'random 0: the base delay');
      r.c.advance(999);
      assert.equal(r.st.dial, null);
      r.c.advance(1);
      assert.deepEqual([r.st.dial, r.st.attempts, engine.shown(r.st)], [2, 2, 'connecting'], 'a redial of an offline link reads connecting');
      r.dialOk(2);
      assert.deepEqual([r.st.phase, r.st.attempts, r.st.lastError, r.st.prevError], ['online', 0, null, 'no route to host']);
    },
  },
  {
    name: 'backoff is decorrelated jitter: random 1 triples the delay up to retryMaxMs; online resets it',
    random: () => 1,
    run(r) {
      r.dispatch({ type: 'start' });
      const delays: number[] = [];
      for (let d = 1; d <= 4; d++) {
        const out = r.dispatch({ type: 'dialFailed', dial: d, error: off() });
        delays.push(must(r.of(out, 'setTimer')[0]).ms);
        r.c.advance(must(delays.at(-1)));
      }
      assert.deepEqual(delays, [3000, 9000, 10_000, 10_000]);
      r.dialOk(5);
      assert.equal(r.st.delay, T.retryMs);
    },
  },
  {
    name: 'AUTH or PROTOCOL at a dial stops it for good with the code and reason; nothing is retried',
    run(r) {
      r.dispatch({ type: 'start' });
      const out = r.dispatch({ type: 'dialFailed', dial: 1, error: { code: 'AUTH', reason: 'INVITE_USED', message: 'this invite was used already' } });
      assert.deepEqual([r.st.phase, r.st.code, r.st.why, r.st.reason], ['stopped', 'AUTH', 'INVITE_USED', 'this invite was used already']);
      assert.deepEqual(r.of(out, 'finish'), [{ type: 'finish', why: 'this invite was used already' }]);
      assert.equal(r.of(out, 'setTimer').length, 0);
      assert.deepEqual(r.dispatch({ type: 'redial', why: 'woke' }), [], 'for good: a wake changes nothing');
      assert.equal(engine.forGood(r.st), true);
    },
  },
  {
    name: 'FORK at a dial: fork, said loudly (forked), finish',
    run(r) {
      r.dispatch({ type: 'start' });
      const out = r.dispatch({ type: 'dialFailed', dial: 1, error: { code: 'FORK', reason: 'NOT_CHAINED', message: 'line 3 is not the mirror\'s' } });
      assert.deepEqual([r.st.phase, r.st.code, r.st.why], ['fork', 'FORK', 'NOT_CHAINED']);
      assert.deepEqual(r.types(out).filter(t => t === 'forked' || t === 'finish'), ['forked', 'finish']);
    },
  },
  {
    name: 'make before break: a redial while online keeps the live connection until the new one is live, then retires it',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      const re = r.dispatch({ type: 'redial', why: 'the network changed' });
      assert.deepEqual(r.of(re, 'log').map(e => e.msg), ['the network changed: redialing now', 'redialing (the network changed); the current connection stays until the new one is live']);
      assert.deepEqual([r.st.phase, r.st.conn, r.st.dial], ['online', 1, 2]);
      assert.equal(r.dispatch({ type: 'redial', why: 'again' }).filter(e => e.type === 'connect').length, 0, 'one dial at a time');
      const swap = r.dialOk(2);
      assert.deepEqual([r.st.conn, r.st.dial], [2, null]);
      assert.deepEqual(r.of(swap, 'online'), [{ type: 'online', conn: 2, old: 1 }]);
      assert.deepEqual(r.of(swap, 'retire'), [{ type: 'retire', conn: 1 }]);
    },
  },
  {
    name: 'a failed redial keeps the live connection: still online, the failure only logged',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      r.dispatch({ type: 'redial', why: 'woke' });
      const out = r.dispatch({ type: 'dialFailed', dial: 2, error: off('timed out') });
      assert.deepEqual([r.st.phase, r.st.conn, r.st.retrying], ['online', 1, false]);
      assert.deepEqual(r.of(out, 'close'), [{ type: 'close', conn: 2 }]);
      assert.match(must(r.of(out, 'log')[0]).msg, /redial failed \(timed out\); the current connection stays/);
      // but a FORK on the redial stops it, live connection or not
      r.dispatch({ type: 'redial', why: 'woke' });
      r.dispatch({ type: 'dialFailed', dial: 3, error: { code: 'FORK', message: 'reset' } });
      assert.equal(r.st.phase, 'fork');
    },
  },
  {
    name: 'heartbeat: a ping every pingMs; a pong re-arms it; a late pong redials (make before break); a dead one goes offline',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      r.c.advance(T.pingMs);
      assert.deepEqual(r.of(r.fx, 'sendPing'), [{ type: 'sendPing', conn: 1, ms: T.deadMs }]);
      r.dispatch({ type: 'pong', conn: 1, rttMs: 42 });
      assert.equal(r.st.rttMs, 42);
      assert.equal(r.timers.has('pong'), false, 'answered: no pong deadline');
      r.c.advance(T.pingMs);
      assert.equal(r.of(r.fx, 'sendPing').length, 2);
      r.c.advance(T.pongMs); // no pong: suspect
      assert.deepEqual([r.st.phase, r.st.conn, r.st.dial], ['online', 1, 2], 'redialing, the old connection still live');
      assert.ok(r.of(r.fx, 'log').some(e => e.msg === `no pong within ${T.pongMs} ms: redialing now`));
      r.dispatch({ type: 'noPong', conn: 1 }); // deadMs: dead, while the dial goes on
      assert.deepEqual([r.st.phase, r.st.conn, r.st.dial, r.st.lastError], ['offline', null, 2, `no pong within ${T.deadMs} ms`]);
      assert.equal(r.st.retrying, false, 'the dial under way decides');
      r.dialOk(2);
      assert.deepEqual([r.st.phase, r.st.conn], ['online', 2]);
    },
  },
  {
    name: 'a dead connection with no dial under way: offline and a retry',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      r.c.advance(T.pingMs);
      const out = r.dispatch({ type: 'noPong', conn: 1 });
      assert.deepEqual([r.st.phase, r.st.conn, r.st.retrying], ['offline', null, true]);
      assert.deepEqual(r.of(out, 'close'), [{ type: 'close', conn: 1 }]);
    },
  },
  {
    name: 'lost: the live connection only; a stale one changes nothing; a lost FORK stream end stops it',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      assert.deepEqual(r.dispatch({ type: 'lost', conn: 7, error: off() }), [], 'not the live one');
      r.dispatch({ type: 'lost', conn: 1, error: { code: 'OFFLINE', message: 'the connection to the host closed' } });
      assert.deepEqual([r.st.phase, r.st.retrying], ['offline', true]);
      r.c.advance(T.retryMs);
      r.dialOk(2);
      r.dispatch({ type: 'lost', conn: 2, error: { code: 'FORK', reason: 'LOG_RESET', message: 'the host log was reset' } });
      assert.deepEqual([r.st.phase, r.st.why], ['fork', 'LOG_RESET']);
    },
  },
  {
    name: 'the room moved: offline with its reason, and a redial now',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      const out = r.dispatch({ type: 'movedAway', conn: 1 });
      assert.deepEqual([r.st.phase, r.st.reason, r.st.dial], ['offline', 'the room moved; reconnecting to its new host', 2]);
      assert.deepEqual(r.of(out, 'close'), [{ type: 'close', conn: 1 }]);
    },
  },
  {
    name: 'a wake resets the backoff: the retry timer goes, a dial starts now',
    random: () => 1,
    run(r) {
      r.dispatch({ type: 'start' });
      r.dispatch({ type: 'dialFailed', dial: 1, error: off() });
      r.c.advance(3000);
      r.dispatch({ type: 'dialFailed', dial: 2, error: off() });
      assert.equal(r.st.delay, 9000);
      const out = r.dispatch({ type: 'redial', why: 'woke from sleep' });
      assert.deepEqual([r.st.dial, r.st.delay, r.st.retrying], [3, T.retryMs, false]);
      assert.ok(out.some(e => e.type === 'clearTimer' && e.name === 'retry'));
    },
  },
  {
    name: 'stop is for good: timers cleared, the live connection closed, finish; a dial that completes later is closed',
    run(r) {
      r.dispatch({ type: 'start' });
      r.dialOk(1);
      r.dispatch({ type: 'redial', why: 'woke' });
      const out = r.dispatch({ type: 'stop', phase: 'stopped', why: 'no seat of this machine is left in the room', reason: 'NO_SEAT' });
      assert.deepEqual([r.st.phase, r.st.why, r.st.conn], ['stopped', 'NO_SEAT', null]);
      assert.deepEqual(r.types(out).filter(t => t === 'clearTimer').length, 3);
      assert.deepEqual(r.of(out, 'close'), [{ type: 'close', conn: 1 }]);
      assert.deepEqual(r.of(r.dispatch({ type: 'connected', dial: 2 }), 'close'), [{ type: 'close', conn: 2 }], 'the dial in flight is closed');
      assert.equal(r.st.dial, null);
      assert.deepEqual(r.dispatch({ type: 'stop', phase: 'stopped', why: 'again' }), [], 'stops once');
      r.c.advance(60_000);
      assert.equal(r.of(r.fx, 'sendPing').length, 0, 'no heartbeat after a stop');
    },
  },
  {
    name: 'a step for a dial that is not the one under way is closed, never swapped in',
    run(r) {
      r.dispatch({ type: 'start' });
      assert.deepEqual(r.dispatch({ type: 'flushed', dial: 9, pings: true }).filter(e => e.type !== 'publish'), [{ type: 'close', conn: 9 }]);
      assert.equal(r.st.conn, null);
    },
  },
];

for (const row of TABLE) test(`link engine: ${row.name}`, () => row.run(rig(row.random)));

test('link engine: step never changes the state passed in', () => {
  const s0 = engine.initial(0, T.retryMs);
  const frozen = JSON.stringify(s0);
  engine.step(s0, { type: 'start' }, { timings: T, now: 5 });
  assert.equal(JSON.stringify(s0), frozen);
});
