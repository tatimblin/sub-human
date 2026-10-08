'use strict';
// The remote protocol's parts: the line codec (lib/remote/protocol.js), the
// memory and pipe transports and their lookup (lib/remote/transports/*), the seeded flaky transport
// (test/support/flaky.js), and invites, link tokens and seat proofs (lib/remote/auth.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { MessageChannel } = require('node:worker_threads');
const h = require('./helpers.js');
const protocol = require(path.join(h.LIB, 'remote', 'protocol.js'));
const transports = require(path.join(h.LIB, 'remote', 'transports', 'index.js'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.js'));
const pipe = require(path.join(h.LIB, 'remote', 'transports', 'pipe.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const config = require(path.join(h.LIB, 'config.js'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.js'));
const { MemoryRoomStore } = require('./support/memory-store.js');
const { flaky } = require('./support/flaky.js');

const CODE = 'otter-1234';
/** Every frame the transport delivers, and whether it closed. */
function recorder(tr) {
  const got = { frames: [], closed: 0 };
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
  assert.deepEqual(bad.map(f => [f.id, f.error.code]), [[null, 'PROTOCOL'], [null, 'PROTOCOL']]);
  const big = d.push('"' + 'x'.repeat(config.LINK_FRAME_MAX_BYTES + 1));
  assert.equal(big[0].error.code, 'PROTOCOL', 'an endless line is cut off, not buffered');
  assert.deepEqual(Object.keys(protocol.CODES).slice(4), ['OFFLINE', 'HOST_ONLY', 'AUTH', 'FORK', 'PROTOCOL', 'STALE']);
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
  const a = await transports.open({ kind: 'memory', port: port1 }), b = memory.over(port2);
  const gb = recorder(b);
  a.send(protocol.request(1, 'beat'));
  await h.until(() => gb.frames.length, 2000, 5);
  a.close();
  // an echo child: every line back as a reply
  const echo = 'process.stdin.on("data", d => { for (const l of String(d).split("\\n").filter(Boolean)) process.stdout.write(JSON.stringify({id: JSON.parse(l).id, result: "echo"}) + "\\n"); })';
  const p = await transports.open({ kind: 'pipe', cmd: [process.execPath, '-e', echo] });
  const gp = recorder(p);
  p.send(protocol.request(7, 'hello'));
  await h.until(() => gp.frames.length, 5000, 10);
  assert.deepEqual(gp.frames, [{ id: 7, result: 'echo' }]);
  p.close();
  await h.until(() => gp.closed, 5000, 10);
  assert.equal(gp.closed, 1);
  await assert.rejects(transports.open({ kind: 'carrier-pigeon' }), e => e.code === 'INVALID');
  await assert.rejects(transports.open({ kind: 'ssh', user: 'me', host: 'far' }), e => e.code === 'INVALID', 'ssh connects to a room');
  // the child's own exit closes the client end
  const gone = recorder(pipe.spawn(process.execPath, ['-e', '']));
  await h.until(() => gone.closed, 5000, 10);
  assert.equal(gone.closed, 1);
});

test('transports: the registry: built-in kinds, locators parse by kind, a kind registers once; describe', () => {
  assert.deepEqual(transports.kinds(), ['memory', 'pipe', 'ssh']);
  assert.deepEqual(transports.KINDS, transports.kinds());
  assert.deepEqual(transports.parse('pipe:/a/home'), { kind: 'pipe', home: '/a/home' });
  assert.deepEqual(transports.parse('ssh:me@far:2222'), { kind: 'ssh', user: 'me', host: 'far', port: 2222 });
  for (const bad of ['memory:x', 'pipe:rel', 'ssh:-oX@h', 'nope:x', 'pipe', '']) assert.equal(transports.parse(bad), null, bad);
  assert.equal(transports.describe({ kind: 'ssh', user: 'me', host: 'far', port: 2222 }), 'ssh me@far:2222');
  assert.equal(transports.describe({ kind: 'pipe', home: '/h' }), 'pipe /h');
  assert.throws(() => transports.register('pipe', { open() {} }), /registered already/);
  assert.throws(() => transports.register('Bad Kind', { open() {} }), /short lower-case/);
  assert.throws(() => transports.register('noopen', {}), /needs open/);
});

test('transports: a registered socket kind in a few lines: async open, fromDuplex over a unix socket, locator, close both ways', async t => {
  const net = require('node:net');
  const fs = require('node:fs');
  const sock = path.join(h.tmpDir('sh-tr-', t), 's.sock');
  const served = [];
  const srv = net.createServer(s => served.push(transports.fromDuplex(s)));
  await new Promise(r => srv.listen(sock, r));
  t.after(() => srv.close());
  transports.register('unixtest', {
    parse: rest => (rest.startsWith('/') ? { path: rest } : null),
    open: spec => new Promise((ok, no) => { const s = net.connect(spec.path, () => ok(transports.fromDuplex(s))); s.once('error', no); }),
    describe: spec => `unix ${spec.path}`,
  });
  assert.ok(transports.KINDS.includes('unixtest'));
  const spec = transports.parse(`unixtest:${sock}`);
  assert.deepEqual(spec, { kind: 'unixtest', path: sock });
  const ta = await transports.open(spec);
  const a = recorder(ta);
  await h.until(() => served.length, 2000, 5);
  const b = recorder(served[0]);
  ta.send(protocol.request(1, 'beat', {}));
  served[0].send(protocol.reply(1, { ok: true }));
  await h.until(() => a.frames.length && b.frames.length, 2000, 5);
  assert.deepEqual(b.frames, [protocol.request(1, 'beat', {})]);
  assert.deepEqual(a.frames, [protocol.reply(1, { ok: true })]);
  ta.close();
  await h.until(() => b.closed, 2000, 5);
  assert.deepEqual([a.closed, b.closed], [1, 1], 'close fires once on both ends');
  ta.send(protocol.request(2, 'beat', {})); // a no-op
  await assert.rejects(transports.open({ kind: 'unixtest', path: sock + '.none' }), e => e.code === 'ENOENT');
  assert.ok(!fs.existsSync(sock + '.none'));
});

test('flaky: seeded drops and duplicates replay the same; cutAfter closes both ends after that many frames', async () => {
  const run = async seed => {
    const [a, b] = memory.pair();
    const f = flaky(a, { seed, drop: 0.3, dup: 0.2 });
    const gb = recorder(b);
    for (let i = 1; i <= 40; i++) f.send(protocol.request(i, 'beat'));
    await h.until(() => gb.frames.length >= 40 - f.stats.dropped + f.stats.duplicated, 2000, 5);
    a.close();
    return { ids: gb.frames.map(x => x.id), stats: f.stats };
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

test('auth: an invite is one string, redeemed once for a token; the host keeps only digests; a link writes only as its seats', t => {
  h.freshHome(t);
  const s = new MemoryRoomStore(CODE);
  const { invite, secret } = auth.mintInvite(s, { locator: 'pipe:node serve' });
  assert.match(invite, /^sh1\.otter-1234\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(auth.parseInvite(invite), { v: 1, code: CODE, locator: 'pipe:node serve', secret, hostKey: null });
  for (const bad of ['', 'sh2.otter-1234.cGlwZQ.' + secret, `sh1.Otter.cGlwZQ.${secret}`, 'sh1.otter-1234..' + secret, 'sh1.otter-1234.cGlwZQ.short', null,
    `sh1.otter-1234.cGlwZQ.${secret}.0`, `sh2.otter-1234.cGlwZQ.${secret}.short-key`, `sh2.otter-1234.cG!wZQ.${secret}.0`]) {
    assert.equal(auth.parseInvite(bad), null, String(bad));
  }
  const { token, link } = auth.redeemInvite(s, secret, { machine: 'm-remote' });
  assert.throws(() => auth.redeemInvite(s, secret, { machine: 'm-remote' }), e => e.code === 'AUTH', 'single use');
  assert.throws(() => auth.redeemInvite(s, 'never-minted-secret-0', { machine: 'm' }), e => e.code === 'AUTH');
  const stored = JSON.stringify([s.kv.get(auth.INVITES_KEY), s.kv.get(auth.LINKS_KEY)]);
  assert.ok(!stored.includes(secret) && !stored.includes(token), 'only sha256 digests on the host');
  assert.deepEqual(auth.verifyToken(s, token), link);
  assert.equal(auth.verifyToken(s, 'nope'), null);
  assert.equal(auth.mayWriteAs(link, 'alice'), false);
  const bound = auth.bindSeat(s, link.id, 'alice');
  assert.deepEqual(auth.bindSeat(s, link.id, 'alice'), bound, 'binding twice is one binding');
  assert.deepEqual([auth.mayWriteAs(bound, 'alice'), auth.mayWriteAs(bound, 'bob'), auth.mayWriteAs(null, 'alice')], [true, false, false]);
  assert.throws(() => auth.bindSeat(s, 'nolink', 'alice'), e => e.code === 'AUTH');
  assert.throws(() => auth.mintInvite(new MemoryRoomStore(CODE, { isHost: false }), { locator: 'x' }), e => e.code === 'HOST_ONLY');
});

test('auth: an sh2 invite carries the room, locator, a 128-bit secret and the host key, never the PIN; the host checks the PIN online: 5 tries, 15 minutes, burnt on success or the last try', t => {
  h.freshHome(t);
  const s = new MemoryRoomStore(CODE);
  const hostKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const t0 = Date.parse('2026-10-08T12:00:00Z');
  const mint = (opts = {}) => auth.mintInvite(s, { locator: 'ssh:me@far:2222', pin: true, hostKey, now: t0, ...opts });
  const a = mint();
  assert.match(a.invite, /^sh2\.otter-1234\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.match(a.pin, /^[0-9]{6}$/);
  assert.ok(!a.invite.includes(a.pin) || !a.invite.split('.').includes(a.pin), 'the PIN is not a part of the invite');
  assert.equal(Buffer.from(a.secret, 'base64url').length, 16, '128 bits');
  assert.deepEqual(auth.parseInvite(a.invite), { v: 2, code: CODE, locator: 'ssh:me@far:2222', secret: a.secret, hostKey });
  assert.equal(auth.parseInvite(auth.mintInvite(s, { locator: 'pipe:/h', pin: true }).invite).hostKey, null, 'no key: "0"');
  const stored = JSON.stringify(s.kv.get(auth.INVITES_KEY));
  assert.ok(!stored.includes(a.secret) && !stored.includes(`"${a.pin}"`), 'neither the secret nor the PIN in clear on the host');

  // no PIN or a wrong one: a try each, and the room line the server posts; the right one redeems and burns the invite
  const wrong = String((Number(a.pin) + 1) % 1e6).padStart(6, '0');
  assert.throws(() => auth.redeemInvite(s, a.secret, { machine: 'm', now: t0 }), e => e.code === 'AUTH' && /needs its PIN/.test(e.message) && /4 tries left/.test(e.note));
  assert.throws(() => auth.redeemInvite(s, a.secret, { machine: 'm', pin: wrong, now: t0 }), e => /wrong PIN \(3 tries left\)/.test(e.message));
  const ok = auth.redeemInvite(s, a.secret, { machine: 'm', pin: a.pin, now: t0 + 60_000 });
  assert.equal(typeof ok.token, 'string');
  assert.throws(() => auth.redeemInvite(s, a.secret, { machine: 'm', pin: a.pin, now: t0 }), e => /used already/.test(e.message), 'single use');

  // five wrong PINs burn it: the right one no longer works
  const b = mint();
  const bad = String((Number(b.pin) + 7) % 1e6).padStart(6, '0');
  for (let i = 4; i >= 1; i--) assert.throws(() => auth.redeemInvite(s, b.secret, { machine: 'm', pin: bad, now: t0 }), e => e.message.includes(`(${i} ${i === 1 ? 'try' : 'tries'} left)`));
  assert.throws(() => auth.redeemInvite(s, b.secret, { machine: 'm', pin: bad, now: t0 }), e => /last try: the invite is burnt/.test(e.message) && /burnt/.test(e.note));
  assert.throws(() => auth.redeemInvite(s, b.secret, { machine: 'm', pin: b.pin, now: t0 }), e => /unknown or was used/.test(e.message));

  // 15 minutes: an expired invite burns, PIN or not
  const c = mint();
  assert.throws(() => auth.redeemInvite(s, c.secret, { machine: 'm', pin: c.pin, now: t0 + 15 * 60_000 + 1 }), e => /expired/.test(e.message));
  assert.throws(() => auth.redeemInvite(s, c.secret, { machine: 'm', pin: c.pin, now: t0 }), e => /unknown or was used/.test(e.message));

  // admit names an invite by its ref (never the secret); a used or expired one is refused; revoke burns what was reserved
  const d = mint();
  const ref = auth.inviteRef(d.secret);
  assert.match(ref, /^[0-9a-f]{12}$/);
  const r1 = auth.reserveRef(s, ref, { now: t0 });
  assert.equal(auth.reserveRef(s, ref, { now: t0 }).id, r1.id, 'the same link id again');
  assert.throws(() => auth.reserveRef(s, ref, { now: t0 + 16 * 60_000 }), e => /expired/.test(e.message));
  assert.throws(() => auth.reserveRef(s, auth.inviteRef(a.secret), { now: t0 }), e => /used or burnt/.test(e.message));
  assert.throws(() => auth.reserveRef(s, 'zz', { now: t0 }), e => e.code === 'AUTH');
  assert.throws(() => auth.redeemInvite(s, d.secret, { machine: 'm', pin: d.pin, linkId: 'abcdef012345', now: t0 }), e => /not for link/.test(e.message));
  const dl = auth.redeemInvite(s, d.secret, { machine: 'm', pin: d.pin, linkId: r1.id, now: t0 });
  assert.equal(dl.link.id, r1.id);
  assert.deepEqual(auth.revokeLink(s, r1.id).link.id, r1.id);
  assert.equal(auth.verifyToken(s, dl.token), null, 'the token is dead');
  assert.equal(auth.revokeLink(s, r1.id), null, 'nothing left to revoke');
  const e2 = mint();
  const r2 = auth.reserveRef(s, auth.inviteRef(e2.secret), { now: t0 });
  assert.deepEqual(auth.revokeLink(s, r2.id), { link: null, invites: 1 }, 'an admitted invite not yet redeemed is burnt');
  assert.throws(() => auth.redeemInvite(s, e2.secret, { machine: 'm', pin: e2.pin, now: t0 }), e => e.code === 'AUTH');
});

test('auth: a seat proof is signed by the seat key for this room, name and key, and fresh', t => {
  h.freshHome(t);
  const pubkey = seatKey.publicPem(CODE, 'alice');
  const seat = { room: CODE, name: 'alice', pubkey };
  const proof = auth.proveSeat(seatKey.ensure(CODE, 'alice'), seat);
  auth.checkSeatProof(proof, seat);
  const other = crypto.generateKeyPairSync('ed25519');
  const refused = [
    [proof, { ...seat, room: 'vole-1234' }], [proof, { ...seat, name: 'bob' }],
    [auth.proveSeat(other.privateKey, seat), seat], // signed by a key that is not pubkey
    [{ ...proof, ts: proof.ts - 2 * 60 * 60 * 1000 }, seat], [undefined, seat],
  ];
  for (const [p, s] of refused) assert.throws(() => auth.checkSeatProof(p, s), e => e.code === 'AUTH');
});
