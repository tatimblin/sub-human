'use strict';
/**
 * test/support/remote-store.js: the store contract's remote backend (docs/next/REMOTE-PLAN.md PR5). A
 * MirrorRoomStore on the calling thread; on a worker thread, the room's server (lib/remote/server.js over the
 * host's FsRoomStore, <home>/rooms/<code>) and the link that keeps the mirror (lib/remote/link.js serveMirror),
 * joined by the memory transport. The mirror's writes cross lib/remote/bridge.js and the link's socket as in
 * production; only the transport differs (not a `serve --stdio` child). A thread that makes synchronous bridge
 * calls never hosts the server, so the server is on the worker.
 *
 *   remoteStore(code, {dir}) -> {mirror, stop()}   dir: the mirror's directory. Blocks until the link is online.
 *       The link's token is bound to NAMES on the host, so the mirror may write as them without a join (the
 *       contract's entries come from several names); the join op itself is a case of its own.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, workerData } = require('node:worker_threads');

const LIB = path.join(__dirname, '..', '..', 'lib');
const NAMES = ['alice', 'bob', 'carol', 'dave'];
const MACHINE = 'remote0machine01';

/**
 * @param {string} code
 * @param {{dir: string}} opts
 * @returns {{mirror: object, stop(): void}}
 */
function remoteStore(code, { dir }) {
  const { MirrorRoomStore } = require(path.join(LIB, 'room', 'store-mirror.js'));
  const { socketPath } = require(path.join(LIB, 'remote', 'link.js'));
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(__filename, { workerData: { code, dir, home: process.env.SUB_HUMAN_HOME, ready } });
  worker.unref();
  Atomics.wait(ready, 0, 0, 10_000);
  if (Atomics.load(ready, 0) !== 1) throw new Error('the remote store\'s link did not come online');
  return {
    mirror: new MirrorRoomStore(code, { dir }),
    stop() { worker.terminate(); fs.rmSync(path.dirname(socketPath(dir)), { recursive: true, force: true }); },
  };
}

async function serveWorker({ code, dir, home, ready }) {
  process.env.SUB_HUMAN_HOME = home; // the test's home: a preloaded test/helpers.js gave this thread a fresh one
  const store = require(path.join(LIB, 'room', 'store.js'));
  const { MirrorRoomStore } = require(path.join(LIB, 'room', 'store-mirror.js'));
  const { serveMirror } = require(path.join(LIB, 'remote', 'link.js'));
  const auth = require(path.join(LIB, 'remote', 'auth.js'));
  const server = require(path.join(LIB, 'remote', 'server.js'));
  const client = require(path.join(LIB, 'remote', 'client.js'));
  const memory = require(path.join(LIB, 'remote', 'transports', 'memory.js'));
  store.createRoom(code);
  const host = store.open(code);
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token, link: l } = auth.redeemInvite(host, secret, { machine: MACHINE });
  for (const name of NAMES) auth.bindSeat(host, l.id, name);
  const connect = () => {
    const [a, b] = memory.pair();
    server.serve(b, { store: host });
    return client.connect(a, { machine: MACHINE, token });
  };
  const link = await serveMirror({ mirror: new MirrorRoomStore(code, { dir }), connect });
  while (link.state() === 'connecting') await new Promise(r => setTimeout(r, 5));
  Atomics.store(ready, 0, link.state() === 'online' ? 1 : 2);
  Atomics.notify(ready, 0);
}

if (!isMainThread && workerData && workerData.ready) serveWorker(workerData);

module.exports = { remoteStore, NAMES, MACHINE };
