'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const clock = require(path.join(__dirname, '..', 'lib', 'clock.ts'));

test('clock: the real clock is Date.now and real timers', async () => {
  assert.ok(Math.abs(clock.now() - Date.now()) < 50);
  assert.equal(clock.real.now, clock.now);
  const t0 = Date.now();
  await clock.sleep(20);
  assert.ok(Date.now() - t0 >= 15);
  let fired = false;
  const h = clock.setTimeout(() => { fired = true; }, 5);
  clock.clearTimeout(h);
  await clock.sleep(20);
  assert.equal(fired, false);
});

test('clock: fake advance fires due timers in order (due time, then creation)', () => {
  const c = clock.createFake({ now: 1000 });
  const log = [];
  c.setTimeout(() => log.push(['b', c.now()]), 50);
  c.setTimeout(() => log.push(['a', c.now()]), 10);
  c.setTimeout(() => log.push(['b2', c.now()]), 50);
  c.setTimeout(() => log.push(['late', c.now()]), 500);
  c.advance(49);
  assert.deepEqual(log, [['a', 1010]]);
  assert.equal(c.now(), 1049);
  c.advance(1);
  assert.deepEqual(log.slice(1), [['b', 1050], ['b2', 1050]]);
  assert.equal(c.pending(), 1);
  c.advance(1000);
  assert.deepEqual(log.at(-1), ['late', 1500]);
  assert.equal(c.now(), 2050);
  assert.equal(c.pending(), 0);
});

test('clock: fake timers scheduled by a callback fire inside the same advance; clear cancels', () => {
  const c = clock.createFake();
  const log = [];
  c.setTimeout(() => { log.push('x'); c.setTimeout(() => log.push('y'), 10); }, 10);
  const k = c.setTimeout(() => log.push('never'), 15);
  c.clearTimeout(k);
  c.advance(20);
  assert.deepEqual(log, ['x', 'y']);
  c.setTimeout(() => log.push('z'), 0); // 0 is clamped to 1 ms, like Node
  c.advance(0);
  assert.deepEqual(log, ['x', 'y']);
  c.advance(1);
  assert.deepEqual(log, ['x', 'y', 'z']);
});

test('clock: fake intervals repeat until cleared; handles accept unref/refresh and numeric ids', () => {
  const c = clock.createFake();
  const at = [];
  const h = c.setInterval(() => at.push(c.now()), 100);
  assert.equal(h.unref(), h);
  c.advance(350);
  assert.deepEqual(at, [100, 200, 300]);
  c.clearInterval(+h);
  c.advance(1000);
  assert.deepEqual(at, [100, 200, 300]);
  let n = 0;
  const t = c.setTimeout(() => n++, 100);
  c.advance(90);
  t.refresh(); // re-armed from now: due at 190
  c.advance(90);
  assert.equal(n, 0);
  c.advance(10);
  assert.equal(n, 1);
});

test('clock: fake sleep + advanceAsync drives an async polling loop without real waiting', async () => {
  const c = clock.createFake();
  const seen = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) { seen.push(c.now()); await c.sleep(250); }
  })();
  await c.advanceAsync(1000);
  assert.deepEqual(seen, [0, 250, 500, 750, 1000]);
  stop = true;
  await c.advanceAsync(250);
  await loop;
});

test('clock: runAll drains timers and refuses to spin forever on an interval', () => {
  const c = clock.createFake();
  let n = 0;
  c.setTimeout(() => n++, 10);
  c.setTimeout(() => n++, 5000);
  c.runAll();
  assert.equal(n, 2);
  assert.equal(c.now(), 5000);
  c.setInterval(() => {}, 1);
  assert.throws(() => c.runAll(50), /still 1 timer/);
  c.set(42);
  assert.equal(c.now(), 42);
});
