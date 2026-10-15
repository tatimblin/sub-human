// A mirror's first sync of what the host's log already holds (lib/remote/link.ts serveMirror in-process, over the
// memory transport, against a real server on the host's FsRoomStore): a large log arrives whole, byte for byte, in
// bounded time; a corrupt line in the middle of the host's log stops the link where it stands (PROTOCOL), and the
// mirror keeps only the lines before it, never a repaired or reordered copy.
// A host whose log rotated into segments (lib/room/log-io.ts) sends a new mirror its snapshot first (the additive cap
// `snapshot`, protocol.ts) and then only the lines after it; a host without the cap (an older one), or a mirror that
// never asks, gets and gives every line across the segments, as before; a snapshot whose head, pins or next line do
// not hold is FORK, and nothing of it is written.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as link from '../lib/remote/link.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import { MirrorRoomStore } from '../lib/room/store-mirror.ts';
import * as consent from '../lib/room/consent.ts';
import * as seatKey from '../hooks/seat-key.ts';
import type { FsRoomStore } from '../lib/room/store.ts';
import type { Transport } from '../lib/remote/types-rest.ts';
import type { DecodedFrame } from '../lib/remote/types-core.ts';

const REMOTE = 'remote0machine01';

/** Options of a rig: the host's segment size while it writes, an older host (its hello lists no snapshot cap), a
 * change to each frame the mirror receives, and room entries written before the n lines. */
interface RigOpts { seg?: number; oldHost?: boolean; tamper?: (f: DecodedFrame) => DecodedFrame; before?: (host: FsRoomStore) => void }

/** A room hosted here with n entries, and a mirror of it that has synced nothing yet. */
function rig(t: TestContext, n: number, { seg, oldHost, tamper, before }: RigOpts = {}) {
  h.freshHome(t);
  const was = process.env.SUB_HUMAN_SEGMENT_BYTES;
  if (seg) process.env.SUB_HUMAN_SEGMENT_BYTES = String(seg);
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_SEGMENT_BYTES; else process.env.SUB_HUMAN_SEGMENT_BYTES = was; });
  const code = h.newRoom();
  const host = store.open(code) as FsRoomStore;
  if (before) before(host);
  for (let i = 1; i <= n; i++) host.append({ kind: 'status', text: `line ${i} ${'x'.repeat(i % 7 * 20)}` }, { via: 'system', from: 'claude', system: true });
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: REMOTE, seats: [] });
  const sessions: { close(): void }[] = [];
  t.after(() => sessions.forEach(s => s.close()));
  const events: string[] = []; // the stream events the mirror received, by name
  const watch = (a: Transport): Transport => ({ ...a, onFrame: fn => a.onFrame(f => { const g = tamper ? tamper(f) : f; if (typeof g.ev === 'string') events.push(g.ev); fn(g); }) });
  const connect = async () => {
    const [a, b] = memory.pair();
    sessions.push(server.serve(b, { store: host }));
    const c = await client.connect(watch(a), { machine: REMOTE, token });
    if (oldHost) c.serverCaps = { ...c.serverCaps, snapshot: undefined } as typeof c.serverCaps; // what an older host's hello says
    return c;
  };
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(linkSocket.socketPath(mirror.dir)), { recursive: true, force: true }));
  const logged: string[] = [];
  const start = () => link.serveMirror({ mirror, connect, log: m => { logged.push(m); }, retryMs: 30, retryMaxMs: 60, watch: false, seats: () => [] });
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  return { code, host, mirror, logged, start, events, hostLog: () => read(host.logFile), mirrorLog: () => read(mirror.logFile) };
}

test('first sync: a 3000-line log reaches a new mirror whole and byte for byte, in bounded time', async t => {
  const N = 3000;
  const r = rig(t, N);
  assert.equal(r.host.lastId(), N);
  const t0 = Date.now();
  const l = await r.start();
  t.after(() => l.stop('done'));
  const synced = await h.until(() => r.mirror.lastId() === N, 60_000, 20);
  const ms = Date.now() - t0;
  assert.ok(synced, `synced ${r.mirror.lastId()} of ${N} lines; ${r.logged.join('\n')}`);
  assert.equal(r.mirrorLog(), r.hostLog(), 'byte-identical');
  assert.equal(l.state(), 'online');
  assert.equal(r.mirror.verifyChain().ok, true);
  // a bound against a per-line cost that grows with the log (each line re-reading the mirror's file), not a benchmark
  assert.ok(ms < 30_000, `first sync of ${N} lines took ${ms} ms`);
});

test('first sync: a corrupt line in the middle of the host\'s log stops the link there (PROTOCOL); the mirror keeps the lines before it', async t => {
  const r = rig(t, 6);
  const lines = r.hostLog().split('\n').filter(Boolean);
  lines[3] = lines[3].slice(0, 25); // line 4, torn mid-object: not JSON
  fs.writeFileSync(r.host.logFile, lines.join('\n') + '\n');
  // the host's own readers skip the line and its chain check names it
  assert.deepEqual(store.open(r.code).readAll().map(e => e.id), [1, 2, 3, 5, 6]);
  const chain = r.host.validateChain();
  assert.equal(chain.ok, false);
  assert.equal(chain.line, 4);

  const l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => l.state() === 'stopped', 10_000, 20), `still ${l.state()}: ${r.logged.join('\n')}`);
  assert.match(await l.done, /not JSON/, 'the reason the link stopped');
  assert.equal(r.mirrorLog(), lines.slice(0, 3).join('\n') + '\n', 'the three lines before it, as the host holds them; nothing after');
  assert.deepEqual(r.mirror.readAll().map(e => e.id), [1, 2, 3]);
});

/** alice's seat on the host: her key pinned, a proposal she signed (the non-chat entries a snapshot carries). */
const H = 'abcdef012345';
function seated(host: FsRoomStore): void {
  seatKey.arm();
  host.append({ kind: 'member_joined', text: 'alice joined', pubkey: seatKey.publicPem(host.code, 'alice') }, { via: 'system', from: 'alice', system: true });
  host.append({ kind: 'proposal', text: `proposal ${H}: paging`, hash: H, approvers: ['alice'] }, { via: 'agent', from: 'claude' });
  host.append({ kind: 'signoff', proposal_hash: H }, { via: 'human', from: 'alice' });
}
const chat = (e: { kind: string }) => store.CHAT_KINDS.has(e.kind);

test('first sync from the host\'s snapshot: only the lines after it cross, they chain to its head, and the mirror reads the same', async t => {
  const r = rig(t, 200, { seg: 4096, before: seated });
  const snap = r.host.snapshot()!;
  assert.ok(snap && snap.id > 100, 'the host rotated');
  const l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => r.mirror.lastId() === 203, 10_000, 20), `synced to ${r.mirror.lastId()}: ${r.logged.join('\n')}`);
  assert.equal(r.events.filter(e => e === 'snapshot').length, 1);
  assert.equal(r.events.filter(e => e === 'entry').length, 203 - snap.id, 'only the lines after the snapshot');
  const m = r.mirror.snapshot()!;
  assert.deepEqual([m.id, m.hash, m.held], [snap.id, snap.hash, snap.id + 1], 'the mirror starts from the host\'s head');
  assert.deepEqual(r.mirror.readAll().map(e => e.id), r.host.readAll().filter(e => !chat(e) || e.id > snap.id).map(e => e.id), 'every non-chat entry, and the lines after');
  assert.deepEqual(r.mirror.validateChain(), { ok: true, count: 203 });
  assert.equal(r.mirror.verifyChain().ok, true);
  assert.ok(r.mirror.pins().has('alice'), 'pins from the snapshot');
  assert.deepEqual(consent.fold(r.mirror.readAll(), r.mirror.trust).matrix(H).agreed, ['alice'], 'the fold reads the same');
  assert.equal(r.mirror.trust(r.mirror.readAll()[2]), 'verified');
  // the room goes on: a new line arrives and chains; a reconnect asks after it, with no snapshot
  const said = r.host.append({ kind: 'say', text: 'after the snapshot' }, { via: 'human', from: 'alice' });
  assert.ok(await h.until(() => r.mirror.lastId() === said.id, 5000, 20));
  assert.equal(r.mirror.trust(r.mirror.readAll().at(-1)), 'verified');
  assert.equal(r.mirror.lineHash(said.id), r.host.lineHash(said.id));
});

test('an older host (no snapshot cap) gives every line across its segments; the mirror chains them all', async t => {
  const r = rig(t, 200, { seg: 4096, oldHost: true, before: seated });
  assert.ok(r.host.snapshot());
  const l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => r.mirror.lastId() === 203, 10_000, 20), r.logged.join('\n'));
  assert.deepEqual([r.events.includes('snapshot'), r.events.filter(e => e === 'entry').length], [false, 203], 'the replay, every line once');
  assert.deepEqual(r.mirror.readAll().map(e => e.id), r.host.readAll().map(e => e.id));
  assert.deepEqual(r.mirror.validateChain(), { ok: true, count: 203 });
  for (const id of [1, 50, 120, 203]) assert.equal(r.mirror.lineHash(id), r.host.lineHash(id), `line ${id} byte for byte`);
});

test('a mirror behind the host\'s rotations catches up across the sealed segments', async t => {
  const r = rig(t, 5);
  let l = await r.start();
  assert.ok(await h.until(() => r.mirror.lastId() === 5, 5000, 20));
  l.stop('pause');
  process.env.SUB_HUMAN_SEGMENT_BYTES = '2048';
  for (let i = 0; i < 80; i++) r.host.append({ kind: 'status', text: `while away ${i} ${'y'.repeat(40)}` }, { via: 'system', from: 'claude', system: true });
  assert.ok(r.host.snapshot()!.id > 5, 'line 5 is in a sealed segment now');
  l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => r.mirror.lastId() === 85, 10_000, 20), r.logged.join('\n'));
  assert.deepEqual(r.mirror.readAll().map(e => e.id), Array.from({ length: 85 }, (_, i) => i + 1));
  assert.deepEqual(r.mirror.validateChain(), { ok: true, count: 85 });
});

for (const [what, change] of [
  ['a head that does not hash', (d: Record<string, unknown>) => ({ ...d, hash: '000000000000' })],
  ['pins its entries do not give', (d: Record<string, unknown>) => ({ ...d, pins: {} })],
] as const) {
  test(`a snapshot with ${what} is FORK: the link stops and nothing of it is written`, async t => {
    const r = rig(t, 200, { seg: 4096, before: seated, tamper: f => (f.ev === 'snapshot' ? { ...f, data: change(f.data as Record<string, unknown>) } : f) });
    const l = await r.start();
    t.after(() => l.stop('done'));
    assert.ok(await h.until(() => l.state() === 'fork', 10_000, 20), `still ${l.state()}: ${r.logged.join('\n')}`);
    assert.match(await l.done, /snapshot/);
    assert.deepEqual([r.mirror.readAll(), r.mirror.snapshot()], [[], null]);
  });
}

test('a line after the snapshot that does not chain to its head is FORK; the mirror keeps the snapshot, nothing after', async t => {
  let first = true;
  const r = rig(t, 200, {
    seg: 4096, before: seated,
    tamper: f => {
      if (f.ev !== 'entry' || !first) return f;
      first = false;
      return { ...f, data: (f.data as string).replace(/"prev":"[0-9a-f]{12}"/, '"prev":"000000000000"') };
    },
  });
  const snap = r.host.snapshot()!;
  const l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => l.state() === 'fork', 10_000, 20), `still ${l.state()}: ${r.logged.join('\n')}`);
  assert.equal(r.mirror.lastId(), snap.id, 'the snapshot, and no line after it');
});
