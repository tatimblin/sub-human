/**
 * test/support/remote-store.ts: the store contract's remote backend. A
 * MirrorRoomStore on the calling thread; on a worker thread, the room's server (lib/remote/server.ts over the
 * host's FsRoomStore, <home>/rooms/<code>) and the link that keeps the mirror (lib/remote/link.ts serveMirror),
 * joined by the memory transport. The mirror's writes cross lib/remote/bridge.ts and the link's socket as in
 * production; only the transport differs (not a `serve --stdio` child). A thread that makes synchronous bridge
 * calls never hosts the server, so the server is on the worker.
 *
 *   remoteStore(code, {dir}) -> {mirror, stop()}   dir: the mirror's directory. Blocks until the link is online.
 *       The link's token is bound to NAMES on the host, so the mirror may write as them without a join (the
 *       contract's entries come from several names); the join op itself is a case of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { MirrorRoomStore } from '../../lib/room/store-mirror.ts';
import { socketPath, serveMirror } from '../../lib/remote/link.ts';
import * as store from '../../lib/room/store.ts';
import * as auth from '../../lib/remote/auth.ts';
import * as server from '../../lib/remote/server.ts';
import * as client from '../../lib/remote/client.ts';
import * as memory from '../../lib/remote/transports/memory.ts';

const NAMES = ['alice', 'bob', 'carol', 'dave'];
const MACHINE = 'remote0machine01';

/** What the worker is started with. ready: 0 while starting, 1 online, 2 failed. */
interface WorkerData { code: string; dir: string; home: string | undefined; ready: Int32Array }

function remoteStore(code: string, { dir }: { dir: string }): { mirror: MirrorRoomStore; stop(): void } {
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(import.meta.filename, { workerData: { code, dir, home: process.env.SUB_HUMAN_HOME, ready } satisfies WorkerData });
  worker.unref();
  Atomics.wait(ready, 0, 0, 10_000);
  if (Atomics.load(ready, 0) !== 1) throw new Error('the remote store\'s link did not come online');
  return {
    mirror: new MirrorRoomStore(code, { dir }),
    stop() { worker.terminate(); fs.rmSync(path.dirname(socketPath(dir)), { recursive: true, force: true }); },
  };
}

async function serveWorker({ code, dir, home, ready }: WorkerData) {
  process.env.SUB_HUMAN_HOME = home; // the test's home: a preloaded test/helpers.ts gave this thread a fresh one
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

if (!isMainThread && workerData && workerData.ready) serveWorker(workerData as WorkerData);

export { remoteStore, NAMES, MACHINE };