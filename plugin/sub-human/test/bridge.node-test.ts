// lib/remote/bridge.ts: a synchronous call to a worker thread, with a deadline. lib/room/store-mirror.ts crosses it in
// production; the store contract runs a mirror (test/support/remote-store.ts).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import { createBridge } from '../lib/remote/bridge.ts';
import * as config from '../lib/config.ts';
import * as store from '../lib/room/store.ts';
import type { RoomError } from '../lib/room/validate.ts';

const BRIDGE = path.join(h.LIB, 'remote', 'bridge.ts');

/** The handler module's methods, as the tests call them. */
type TestApi = {
  echo: { params: unknown; result: { got: unknown; buf: Uint8Array } };
  later: { params: { ms: number }; result: number };
  throws: { params: { why: string; code?: string }; result: never };
  hang: { params: object; result: never };
  fn: { params: object; result: never };
  callerFlag: { params: { flag: Int32Array }; result: string };
  [method: string]: { params: unknown; result: unknown };
};

/** A handler module in a temp dir: handle(method, params) runs HANDLERS[method]. */
function handlerFile(t: TestContext) {
  const file = path.join(h.tmpDir('sh-bridge-', t), 'handler.js');
  fs.writeFileSync(file, `
    const HANDLERS = {
      echo: p => ({ got: p, buf: Buffer.from('hi') }),
      later: async p => { await new Promise(r => setTimeout(r, p.ms)); return p.ms; },
      throws: p => { const e = new Error('no: ' + p.why); if (p.code !== undefined) e.code = p.code; throw e; },
      hang: () => { setInterval(() => {}, 1000); return new Promise(() => {}); },
      fn: () => () => 1,
      // waits for a flag only the calling thread's event loop sets
      callerFlag: async ({ flag }) => { while (!Atomics.load(flag, 0)) await new Promise(r => setTimeout(r, 5)); return 'set'; },
    };
    exports.handle = (method, params) => HANDLERS[method](params);
  `);
  return file;
}

test('bridge: a call returns the handler\'s result (a structured clone); a throw is RoomError with its code, else INVALID', t => {
  const b = createBridge<TestApi>({ handler: handlerFile(t) });
  t.after(() => b.close());
  const r = b.call('echo', { a: [1, { b: 'c' }] });
  assert.deepEqual(r.got, { a: [1, { b: 'c' }] });
  assert.equal(Buffer.from(r.buf).toString(), 'hi');
  assert.equal(b.call('later', { ms: 20 }), 20, 'an async handler is awaited');
  assert.throws(() => b.call('throws', { why: 'rate', code: 'RATE' }), e => e instanceof store.RoomError && e.code === 'RATE' && e.message === 'no: rate');
  assert.throws(() => b.call('throws', { why: 'plain' }), e => e instanceof store.RoomError && e.code === 'INVALID' && e.message === 'no: plain');
  assert.throws(() => b.call('fn', {}), (e: RoomError) => e.code === 'INVALID' && /could not be cloned/.test(e.message), 'a result that does not clone is an error, not a timeout');
  assert.deepEqual(b.call('echo', 1).got, 1, 'the bridge still answers');
});

test('bridge: a handler that does not load fails the call with its load error', t => {
  const b = createBridge({ handler: path.join(h.tmpDir('sh-bridge-', t), 'missing.js') });
  t.after(() => b.close());
  assert.throws(() => b.call('echo', {}), e => e instanceof store.RoomError && /Cannot find module/.test(e.message));
});

test('bridge: no answer by the deadline is OFFLINE; nothing is retried, the late reply is dropped, the next call gets its own', t => {
  const b = createBridge<TestApi>({ handler: handlerFile(t), deadlineMs: 150 });
  t.after(() => b.close());
  const t0 = Date.now();
  assert.throws(() => b.call('later', { ms: 400 }), (e: RoomError) => e.code === 'OFFLINE' && /later: no answer within 150 ms/.test(e.message));
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 400, `gave up at the deadline (${took} ms)`);
  assert.throws(() => b.call('later', { ms: 400 }, { deadlineMs: 50 }), (e: RoomError) => e.code === 'OFFLINE', 'a per-call deadline');
  assert.equal(b.call('later', { ms: 500 }, { deadlineMs: 2000 }), 500, 'the abandoned calls\' replies are skipped');
});

test('bridge: a handler that needs the calling thread cannot finish while it waits: OFFLINE at the deadline, never a hang', async t => {
  const b = createBridge({ handler: handlerFile(t), deadlineMs: 200 });
  t.after(() => b.close());
  const flag = new Int32Array(new SharedArrayBuffer(4));
  setImmediate(() => Atomics.store(flag, 0, 1)); // runs only once this thread is free again
  assert.throws(() => b.call('callerFlag', { flag }), (e: RoomError) => e.code === 'OFFLINE');
  await new Promise(r => setImmediate(r));
  assert.equal(b.call('callerFlag', { flag }), 'set', 'with the calling thread free, the same work finishes');
});

test('bridge: the worker is unref\'d: a hook-like process exits when its body returns, with a call abandoned', t => {
  const handler = handlerFile(t);
  const body = `
    const b = require(${JSON.stringify(BRIDGE)}).createBridge({ handler: ${JSON.stringify(handler)}, deadlineMs: 100 });
    try { b.call('hang', {}); } catch (e) { process.stdout.write(e.code); }`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', body], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'OFFLINE');
  assert.ok(Date.now() - t0 < 2000, 'the hanging worker did not hold the process');
});

test('bridge: the deadlines fit inside the hook timeouts (SessionEnd has its own)', () => {
  const hooks = (JSON.parse(fs.readFileSync(path.join(h.PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { hooks: { timeout: number }[] }[]> }).hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'PreToolUse') continue; // the EnterPlanMode mode note: a few shell lines, no node, no store call
    for (const hk of groups.flatMap(g => g.hooks)) {
      const budget = event === 'SessionEnd' ? config.LINK_CALL_END_MS : config.LINK_CALL_MS;
      assert.ok(budget * 3 <= hk.timeout * 1000, `${event}: three calls fit in ${hk.timeout} s`);
    }
  }
});

