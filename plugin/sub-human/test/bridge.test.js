'use strict';
// lib/remote/bridge.ts (a synchronous call to a worker thread, with a deadline) and its proof gate: a RoomStore
// whose every call crosses the bridge (test/support/thread-store.js) behaves as the FsRoomStore it forwards to, and
// the hook suites pass over it (`npm run test:thread-store` runs all of test/hooks; consent.test.js runs here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const { createBridge } = require(path.join(h.LIB, 'remote', 'bridge.ts'));
const config = require(path.join(h.LIB, 'config.ts'));
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const identity = require(path.join(h.LIB, 'identity.ts'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.ts'));
const { ThreadRoomStore } = require('./support/thread-store.js');

const BRIDGE = path.join(h.LIB, 'remote', 'bridge.ts');
const THREAD_STORE = path.join(__dirname, 'support', 'thread-store.js');

/** A handler module in a temp dir: handle(method, params) runs HANDLERS[method]. */
function handlerFile(t) {
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
  const b = createBridge({ handler: handlerFile(t) });
  t.after(() => b.close());
  const r = b.call('echo', { a: [1, { b: 'c' }] });
  assert.deepEqual(r.got, { a: [1, { b: 'c' }] });
  assert.equal(Buffer.from(r.buf).toString(), 'hi');
  assert.equal(b.call('later', { ms: 20 }), 20, 'an async handler is awaited');
  assert.throws(() => b.call('throws', { why: 'rate', code: 'RATE' }), e => e instanceof store.RoomError && e.code === 'RATE' && e.message === 'no: rate');
  assert.throws(() => b.call('throws', { why: 'plain' }), e => e instanceof store.RoomError && e.code === 'INVALID' && e.message === 'no: plain');
  assert.throws(() => b.call('fn', {}), e => e.code === 'INVALID' && /could not be cloned/.test(e.message), 'a result that does not clone is an error, not a timeout');
  assert.deepEqual(b.call('echo', 1).got, 1, 'the bridge still answers');
});

test('bridge: a handler that does not load fails the call with its load error', t => {
  const b = createBridge({ handler: path.join(h.tmpDir('sh-bridge-', t), 'missing.js') });
  t.after(() => b.close());
  assert.throws(() => b.call('echo', {}), e => e instanceof store.RoomError && /Cannot find module/.test(e.message));
});

test('bridge: no answer by the deadline is OFFLINE; nothing is retried, the late reply is dropped, the next call gets its own', t => {
  const b = createBridge({ handler: handlerFile(t), deadlineMs: 150 });
  t.after(() => b.close());
  const t0 = Date.now();
  assert.throws(() => b.call('later', { ms: 400 }), e => e.code === 'OFFLINE' && /later: no answer within 150 ms/.test(e.message));
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 400, `gave up at the deadline (${took} ms)`);
  assert.throws(() => b.call('later', { ms: 400 }, { deadlineMs: 50 }), e => e.code === 'OFFLINE', 'a per-call deadline');
  assert.equal(b.call('later', { ms: 500 }, { deadlineMs: 2000 }), 500, 'the abandoned calls\' replies are skipped');
});

test('bridge: a handler that needs the calling thread cannot finish while it waits: OFFLINE at the deadline, never a hang', async t => {
  const b = createBridge({ handler: handlerFile(t), deadlineMs: 200 });
  t.after(() => b.close());
  const flag = new Int32Array(new SharedArrayBuffer(4));
  setImmediate(() => Atomics.store(flag, 0, 1)); // runs only once this thread is free again
  assert.throws(() => b.call('callerFlag', { flag }), e => e.code === 'OFFLINE');
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
  const hooks = JSON.parse(fs.readFileSync(path.join(h.PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const hk of groups.flatMap(g => g.hooks)) {
      const budget = event === 'SessionEnd' ? config.LINK_CALL_END_MS : config.LINK_CALL_MS;
      assert.ok(budget * 3 <= hk.timeout * 1000, `${event}: three calls fit in ${hk.timeout} s`);
    }
  }
});

test('thread store: appends (a signed human one too), compare-and-set updates, blobs and the tailer land in the FsRoomStore it forwards to', t => {
  h.freshHome(t);
  const code = identity.newCode();
  const th = new ThreadRoomStore(code), fsStore = new store.FsRoomStore(code);
  seatKey.arm();

  const tail = th.tailer();
  const a = th.append({ kind: 'say', text: 'hello' }, { via: 'agent', from: 'alice' });
  const s = th.append({ kind: 'say', text: 'typed' }, { via: 'human', from: 'alice' });
  assert.equal(store.roomOf(a), code, 'entries come back tagged with their room');
  assert.deepEqual(fsStore.readAll(), [a, s]);
  assert.equal(store.humanTrust(fsStore.readAll()[1]), 'verified', 'signed on the worker with the key taken here');
  assert.deepEqual(th.readView({ after: 1 }), fsStore.readView({ after: 1 }));
  assert.deepEqual(tail.poll().entries.map(e => e.id), [1, 2]);
  assert.equal(th.validateChain().ok, true);

  // members.update: fn runs again when another writer got in between its read and its write
  let runs = 0;
  th.members.update(m => {
    if (runs++ === 0) fsStore.members.update(cur => ({ ...cur, bob: { role: 'member' } }));
    return { ...m, alice: { role: 'member' } };
  });
  assert.equal(runs, 2);
  assert.deepEqual(Object.keys(fsStore.members.read()).sort(), ['alice', 'bob']);
  assert.deepEqual(th.kv.update('tasks', v => ({ n: ((v && v.n) || 0) + 1 })), { n: 1 });
  assert.equal(th.kv.update('tasks', () => undefined), undefined);
  assert.deepEqual(fsStore.kv.get('tasks'), { n: 1 });
  assert.equal(th.kv.update('tasks', () => null), null);
  assert.equal(fsStore.kv.get('tasks'), null);

  assert.equal(th.blobs.put('plans/p.md', Buffer.from('# plan')), 'plans/p.md');
  assert.ok(Buffer.isBuffer(th.blobs.get('plans/p.md')));
  assert.equal(fsStore.blobs.get('plans/p.md').toString(), '# plan');
  assert.equal(th.lock('proposal', () => th.lastId()), 2, 'a store call under the room lock');

  delete globalThis[store.SIGNER];
  assert.throws(() => th.append({ kind: 'say', text: 'forged' }, { via: 'human', from: 'alice' }), e => e.code === 'INVALID', 'no signer here: refused before the worker');
  assert.equal(fsStore.lastId(), 2);
});

test('gate: test/hooks/consent.test.js passes with every store call of every process on a worker thread', () => {
  const env = { ...process.env, SUB_HUMAN_TEST_THREAD_STORE: '1', NODE_OPTIONS: `--require ${THREAD_STORE}` };
  delete env.NODE_TEST_CONTEXT;
  const probe = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(h.LIB, 'room', 'store.ts'))}).open('otter-1234').constructor.name)`], { env, encoding: 'utf8' });
  assert.equal(probe.stdout, 'ThreadRoomStore', 'the preload reaches child processes');
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, 'hooks', 'consent.test.js')], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# fail 0|ℹ fail 0/);
});
