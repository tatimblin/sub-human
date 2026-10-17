// The remote protocol's parts: the line codec (lib/remote/protocol.ts), the
// memory and pipe transports and their lookup (lib/remote/transports/*), the seeded flaky transport
// (test/support/flaky.ts), and invites, link tokens and seat proofs (lib/remote/invites.ts, host-links.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import net from 'node:net';
import fs from 'node:fs';
import * as h from './helpers.ts';
import * as protocol from '../lib/remote/protocol.ts';
import * as transports from '../lib/remote/transports/index.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import * as pipe from '../lib/remote/transports/pipe.ts';
import * as invites from '../lib/remote/invites.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as config from '../lib/config.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { MemoryRoomStore } from './support/memory-store.ts';
import { flaky } from './support/flaky.ts';
import type { DecodedFrame, SignedPayload } from '../lib/remote/types-core.ts';
import type { RoomError } from '../lib/room/validate.ts';
import { isErrno } from '../lib/errors.ts';
import type { MemorySpec, PipeSpec, SshSpec, Transport } from '../lib/remote/types-rest.ts';
import { rc, sn, mid } from './support/brands.ts';
import { must } from './support/must.ts';


const CODE = rc('otter-1234');
/** Every frame the transport delivers, and whether it closed. */
function recorder(tr: Transport) {
  const got: { frames: DecodedFrame[]; closed: number } = { frames: [], closed: 0 };
  tr.onFrame(f => got.frames.push(f));
  tr.onClose(() => got.closed++);
  return got;
}

test('protocol: frames encode to one line; the decoder keeps partial lines and a split character, and flags bad ones', () => {
  assert.deepEqual(protocol.request(1, 'hello', { v: 1 }), { id: 1, op: 'hello', params: { v: 1 } });
  assert.deepEqual(protocol.error(2, 'AUTH', 'no'), { id: 2, error: { code: 'AUTH', message: 'no' } });
  const line = protocol.encode(protocol.event(3, 'entry', '{"id":1}\n'));
  assert.equal(line.split('\n').length, 2, 'a newline inside a value stays escaped');
  assert.ok(protocol.isEvent(JSON.parse(line)) && protocol.isReply(protocol.reply(1, null)) && protocol.isRequest(protocol.request(1, 'beat')));
  const d = protocol.decoder();
  const bytes = Buffer.from(protocol.encode(protocol.reply(1, 'é')) + protocol.encode(protocol.reply(2, 'x')));
  const cut = bytes.indexOf(Buffer.from('é')) + 1; // inside the two bytes of é
  assert.deepEqual(d.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(d.push(bytes.subarray(cut)), [{ id: 1, result: 'é' }, { id: 2, result: 'x' }]);
  const bad = d.push('not json\n[1]\n');
  assert.deepEqual(bad.map(f => [f.id, must(f.error).code]), [[null, 'PROTOCOL'], [null, 'PROTOCOL']]);
  const big = d.push('"' + 'x'.repeat(config.LINK_FRAME_MAX_BYTES + 1));
  assert.equal(must(must(big[0]).error).code, 'PROTOCOL', 'an endless line is cut off, not buffered');
  assert.deepEqual(Object.keys(protocol.CODES).slice(4), ['OFFLINE', 'HOST_ONLY', 'AUTH', 'FORK', 'PROTOCOL']);
});

test('transports: a memory pair carries frames both ways as lines; close fires once on both ends; send after close is a no-op', async () => {
  const [a, b] = memory.pair();
  const ga = recorder(a), gb = recorder(b);
  a.send(protocol.request(1, 'hello', { v: 1 }));
  b.send(protocol.reply(1, { buf: Buffer.from('x') }));
  await h.until(() => ga.frames.length && gb.frames.length, 2000, 5);
  assert.deepEqual(gb.frames, [{ id: 1, op: 'hello', params: { v: 1 } }]);
  assert.deepEqual(ga.frames, [{ id: 1, result: { buf: { type: 'Buffer', data: [120] } } }], 'JSON on the wire, as on a pipe');
  a.close();
  await h.until(() => ga.closed && gb.closed, 2000, 5);
  a.close(); a.send(protocol.reply(9, 1));
  await h.sleep(20);
  assert.deepEqual([ga.closed, gb.closed, gb.frames.length], [1, 1, 1]);
});

test('transports: open() by kind (a Promise): memory over a port, pipe over a child\'s stdio; an unknown kind is INVALID', async () => {
  const { port1, port2 } = new MessageChannel();
  const mem: MemorySpec = { kind: 'memory', port: port1 };
  const a = await transports.open(mem), b = memory.over(port2);
  const gb = recorder(b);
  a.send(protocol.request(1, 'beat'));
  await h.until(() => gb.frames.length, 2000, 5);
  a.close();
  // an echo child: every line back as a reply
  const echo = 'process.stdin.on("data", d => { for (const l of String(d).split("\\n").filter(Boolean)) process.stdout.write(JSON.stringify({id: JSON.parse(l).id, result: "echo"}) + "\\n"); })';
  const echoSpec: PipeSpec = { kind: 'pipe', cmd: [process.execPath, '-e', echo] };
  const p = await transports.open(echoSpec);
  const gp = recorder(p);
  p.send(protocol.request(7, 'hello'));
  await h.until(() => gp.frames.length, 5000, 10);
  assert.deepEqual(gp.frames, [{ id: 7, result: 'echo' }]);
  p.close();
  await h.until(() => gp.closed, 5000, 10);
  assert.equal(gp.closed, 1);
  await assert.rejects(transports.open({ kind: 'carrier-pigeon' }), (e: RoomError) => e.code === 'INVALID');
  const far: SshSpec = { kind: 'ssh', user: 'me', host: 'far' };
  await assert.rejects(transports.open(far), (e: RoomError) => e.code === 'INVALID', 'ssh connects to a room');
  // the child's own exit closes the client end
  const gone = recorder(pipe.spawn(process.execPath, ['-e', '']));
  await h.until(() => gone.closed, 5000, 10);
  assert.equal(gone.closed, 1);
});

test('transports: the built-in kinds, locators parse by kind; describe', () => {
  assert.deepEqual(transports.kinds(), ['memory', 'pipe', 'ssh', 'wss', 'ws']);
  assert.deepEqual(transports.parse('pipe:/a/home'), { kind: 'pipe', home: '/a/home' });
  assert.deepEqual(transports.parse('ssh:me@far:2222'), { kind: 'ssh', user: 'me', host: 'far', port: 2222 });
  for (const bad of ['memory:x', 'pipe:rel', 'ssh:-oX@h', 'nope:x', 'pipe', '']) assert.equal(transports.parse(bad), null, bad);
  const ssh: SshSpec = { kind: 'ssh', user: 'me', host: 'far', port: 2222 }, home: PipeSpec = { kind: 'pipe', home: '/h' };
  assert.equal(transports.describe(ssh), 'ssh me@far:2222');
  assert.equal(transports.describe(home), 'pipe /h');
});

test('transports: fromDuplex over a unix socket: frames both ways, close both ways', async t => {
  const sock = path.join(h.tmpDir('sh-tr-', t), 's.sock');
  const served: Transport[] = [];
  const srv = net.createServer(s => served.push(transports.fromDuplex(s)));
  await new Promise<void>(r => srv.listen(sock, r));
  t.after(() => srv.close());
  const dial = (p: string) => new Promise<Transport>((ok, no) => { const s = net.connect(p, () => ok(transports.fromDuplex(s))); s.once('error', no); });
  const ta = await dial(sock);
  const a = recorder(ta);
  await h.until(() => served.length, 2000, 5);
  const s0 = must(served[0]);
  const b = recorder(s0);
  ta.send(protocol.request(1, 'beat', {}));
  s0.send(protocol.reply(1, { ok: true }));
  await h.until(() => a.frames.length && b.frames.length, 2000, 5);
  assert.deepEqual(b.frames, [protocol.request(1, 'beat', {})]);
  assert.deepEqual(a.frames, [protocol.reply(1, { ok: true })]);
  ta.close();
  await h.until(() => b.closed, 2000, 5);
  assert.deepEqual([a.closed, b.closed], [1, 1], 'close fires once on both ends');
  ta.send(protocol.request(2, 'beat', {})); // a no-op
  await assert.rejects(dial(sock + '.none'), e => isErrno(e, 'ENOENT'));
  assert.ok(!fs.existsSync(sock + '.none'));
});

test('flaky: seeded drops and duplicates replay the same; cutAfter closes both ends after that many frames', async () => {
  const run = async (seed: number) => {
    const [a, b] = memory.pair();
    const f = flaky(a, { seed, drop: 0.3, dup: 0.2 });
    const gb = recorder(b);
    for (let i = 1; i <= 40; i++) f.send(protocol.request(i, 'beat'));
    await h.until(() => gb.frames.length >= 40 - f.stats.dropped + f.stats.duplicated, 2000, 5);
    a.close();
    return { ids: gb.frames.map(x => x.id as number), stats: f.stats };
  };
  const one = await run(7), two = await run(7);
  assert.deepEqual(one, two);
  assert.ok(one.stats.dropped > 0 && one.stats.duplicated > 0, JSON.stringify(one.stats));
  assert.deepEqual([...new Set(one.ids)], [...new Set(one.ids)].sort((x, y) => x - y), 'order kept');
  const [a, b] = memory.pair();
  const f = flaky(a, { seed: 1, cutAfter: 3 });
  const ga = recorder(f), gb = recorder(b);
  for (let i = 1; i <= 5; i++) f.send(protocol.request(i, 'beat'));
  await h.until(() => ga.closed && gb.closed, 2000, 5);
  assert.deepEqual(gb.frames.map(x => x.id), [1, 2, 3]);
});

test('auth: a link\'s token is kept as a digest on the host; a link writes only as its seats; revoking it kills the token', t => {
  h.freshHome(t);
  const s = new MemoryRoomStore(CODE);
  assert.throws(() => invites.redeemInvite(s, 'never-minted-secret-0', { machine: mid('m') }), (e: RoomError) => e.code === 'AUTH' && e.reason === 'INVITE_UNKNOWN');
  const { token, link } = hostLinks.create(s, { id: hostLinks.newLinkId(), machine: mid('m-remote'), seats: [] });
  const stored = JSON.stringify(s.kv.get(hostLinks.LINKS_KEY));
  assert.ok(!stored.includes(token), 'only sha256 digests on the host');
  assert.deepEqual(hostLinks.verifyToken(s, token), link);
  assert.equal(hostLinks.verifyToken(s, 'nope'), null);
  assert.equal(hostLinks.mayWriteAs(link, 'alice'), false);
  const bound = hostLinks.bindSeat(s, link.id, 'alice');
  assert.deepEqual(hostLinks.bindSeat(s, link.id, 'alice'), bound, 'binding twice is one binding');
  assert.deepEqual([hostLinks.mayWriteAs(bound, 'alice'), hostLinks.mayWriteAs(bound, 'bob'), hostLinks.mayWriteAs(null, 'alice')], [true, false, false]);
  assert.throws(() => hostLinks.bindSeat(s, 'nolink', 'alice'), (e: RoomError) => e.code === 'AUTH');
  assert.deepEqual(must(must(hostLinks.revokeLink(s, link.id)).link).id, link.id);
  assert.equal(hostLinks.verifyToken(s, token), null, 'the token is dead');
  assert.equal(hostLinks.revokeLink(s, link.id), null, 'nothing left to revoke');
});

test('auth: a seat proof is signed by the seat key for this room, name and key, and fresh', t => {
  h.freshHome(t);
  const pubkey = seatKey.publicPem(CODE, sn('alice'));
  const seat = { room: CODE, name: 'alice', pubkey };
  const proof = hostLinks.proveSeat(seatKey.ensure(CODE, sn('alice')), seat);
  hostLinks.checkSeatProof(proof, seat);
  const other = crypto.generateKeyPairSync('ed25519');
  const refused: [SignedPayload | undefined, typeof seat][] = [
    [proof, { ...seat, room: rc('vole-1234') }], [proof, { ...seat, name: 'bob' }],
    [hostLinks.proveSeat(other.privateKey, seat), seat], // signed by a key that is not pubkey
    [{ ...proof, ts: must(proof.ts) - 2 * 60 * 60 * 1000 }, seat], [undefined, seat],
  ];
  for (const [p, s] of refused) assert.throws(() => hostLinks.checkSeatProof(p, s), (e: RoomError) => e.code === 'AUTH');
});

test('frames: isEvent takes only an event this end knows; isOp only an op it serves; isRequest and isReply by shape', () => {
  assert.equal(protocol.isEvent({ id: 1, ev: 'entry', data: '{}' }), true);
  assert.equal(protocol.isEvent({ id: 1, ev: 'later-kind', data: 1 }), false, 'a newer host\'s event is no event here');
  assert.equal(protocol.isEvent({ id: 1, ev: 5 }), false);
  assert.equal(protocol.isEvent(null), false);
  assert.equal(protocol.isEvent([]), false);
  for (const op of protocol.OPS) assert.equal(protocol.isOp(op), true, op);
  assert.equal(protocol.isOp('hello.again'), false);
  assert.equal(protocol.isOp('toString'), false);
  assert.equal(protocol.isRequest({ id: 1, op: 'x' }), true);
  assert.equal(protocol.isRequest({ id: 1, op: 1 }), false);
  assert.equal(protocol.isReply({ id: 1, result: null }), true);
  assert.equal(protocol.isReply({ id: 1, op: 'x', result: null }), false);
  assert.equal(protocol.rangeOf({ proto: { min: 1, max: 2 } })?.max, 2);
  assert.equal(protocol.rangeOf({ proto: 'x' }), null);
  assert.equal(protocol.rangeOf({ proto: [1, 2] }), null);
});
