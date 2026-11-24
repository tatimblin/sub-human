// net/channel.ts: the published Noise_XK_25519_ChaChaPoly_SHA256 vectors (test/fixtures/noise, the non-PSK XK object of
// cacophony and of snow, as fetched), then the channel over a stream pair: admit before anything, check strings,
// frames, and what a wrong key, a refusal or a tampered frame does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { duplexPair } from 'node:stream';
import type { Duplex } from 'node:stream';
import * as v from '../vendor/valibot.mjs';
import { Handshake, NoiseError, accept, connect, dh, generateKeyPair, keyPair, HANDSHAKE_MS, MAX_FRAME, MAX_MESSAGE } from './channel.js';
import type { Channel } from './channel.js';

const Vectors = v.object({
  vectors: v.array(v.object({
    init_prologue: v.string(), init_static: v.string(), init_ephemeral: v.string(), init_remote_static: v.string(),
    resp_prologue: v.string(), resp_static: v.string(), resp_ephemeral: v.string(), handshake_hash: v.optional(v.string()),
    messages: v.array(v.object({ payload: v.string(), ciphertext: v.string() })),
  })),
});
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const fixtures = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'noise');

for (const file of ['cacophony-xk.json', 'snow-xk.json']) {
  const { vectors } = v.parse(Vectors, JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8')));
  test(`Noise XK vectors (${file}): every message byte for byte, both sides (R29c)`, () => {
    assert.equal(vectors.length, 1);
    for (const x of vectors) {
      const is = keyPair(hex(x.init_static));
      const i = new Handshake(true, { s: is, rs: hex(x.init_remote_static), prologue: hex(x.init_prologue), e: keyPair(hex(x.init_ephemeral)) });
      const r = new Handshake(false, { s: keyPair(hex(x.resp_static)), prologue: hex(x.resp_prologue), e: keyPair(hex(x.resp_ephemeral)) });
      const [m1, m2, m3, ...rest] = x.messages;
      assert.ok(m1 && m2 && m3);
      for (const [m, from, to] of [[m1, i, r], [m2, r, i], [m3, i, r]] as const) {
        const c = from.writeMessage(hex(m.payload));
        assert.equal(c.toString('hex'), m.ciphertext);
        assert.equal(to.readMessage(c).toString('hex'), m.payload);
      }
      assert.deepEqual(r.remoteKey, is.pub, 'message 3 carried the joiner\'s key');
      assert.ok(i.hash && r.hash && i.hash.equals(r.hash));
      if (x.handshake_hash) assert.equal(i.hash.toString('hex'), x.handshake_hash);
      const a = i.split(), b = r.split();
      assert.ok(rest.length > 0, 'the fixture carries transport messages');
      rest.forEach((m, k) => { // after XK's three messages the responder speaks first
        const [tx, rx] = k % 2 === 0 ? [b.send, a.recv] : [a.send, b.recv];
        const c = tx.encrypt(hex(m.payload));
        assert.equal(c.toString('hex'), m.ciphertext, `transport message ${k + 4}`);
        assert.equal(rx.decrypt(c).toString('hex'), m.payload);
      });
    }
  });
}

test('handshake: only the pinned key reads message 1; message 2 binds the session; tampering fails', () => {
  const host = generateKeyPair(), other = generateKeyPair(), me = generateKeyPair();
  const i = new Handshake(true, { s: me, rs: host.pub });
  const m1 = i.writeMessage();
  assert.throws(() => new Handshake(false, { s: other }).readMessage(m1), NoiseError);
  // a real host's answer to another session does not decrypt here
  const i2 = new Handshake(true, { s: me, rs: host.pub }), r2 = new Handshake(false, { s: host });
  r2.readMessage(i2.writeMessage());
  assert.throws(() => i.readMessage(r2.writeMessage()), NoiseError);
  const i3 = new Handshake(true, { s: me, rs: host.pub }), r3 = new Handshake(false, { s: host });
  r3.readMessage(i3.writeMessage());
  i3.readMessage(r3.writeMessage());
  const m3 = i3.writeMessage(Buffer.from('mac'));
  m3[5] = (m3[5] ?? 0) ^ 1;
  assert.throws(() => r3.readMessage(m3), NoiseError);
  assert.throws(() => new Handshake(true, { rs: host.pub }), NoiseError, 'XK needs the joiner\'s own key');
  assert.throws(() => dh(generateKeyPair().priv, Buffer.alloc(32)), NoiseError, 'a low-order key');
});

test('transport: replayed, reordered and tampered messages fail', () => {
  const host = generateKeyPair();
  const i = new Handshake(true, { s: generateKeyPair(), rs: host.pub }), r = new Handshake(false, { s: host });
  r.readMessage(i.writeMessage());
  i.readMessage(r.writeMessage());
  r.readMessage(i.writeMessage());
  const a = i.split(), b = r.split();
  const c1 = a.send.encrypt(Buffer.from('one')), c2 = a.send.encrypt(Buffer.from('two'));
  assert.throws(() => b.recv.decrypt(c2), NoiseError, 'reordered');
  assert.equal(b.recv.decrypt(c1).toString(), 'one');
  assert.throws(() => b.recv.decrypt(c1), NoiseError, 'replayed');
  const bad = Buffer.from(c2);
  bad[0] = (bad[0] ?? 0) ^ 1;
  assert.throws(() => b.recv.decrypt(bad), NoiseError, 'tampered');
  assert.equal(b.recv.decrypt(c2).toString(), 'two');
});

/** A host and a joiner over a stream pair; admit records what it saw. */
async function pair(o: { rs?: Buffer; payload?: Buffer; admit?: boolean } = {}) {
  const { a, b, host } = linked();
  const me = generateKeyPair();
  const seen: { key: Buffer; payload: Buffer }[] = [];
  const hostSide = accept(b, { s: host, admit: (key, payload) => { seen.push({ key, payload }); return o.admit ?? true; } });
  const joiner = connect(a, { s: me, rs: o.rs ?? host.pub, ...(o.payload ? { payload: o.payload } : {}) });
  return { host, me, a, b, seen, hostSide, joiner };
}
const next = (c: Channel): Promise<Buffer> => new Promise(ok => c.onMessage(ok));
const closed = (c: Channel): Promise<Error | null> => new Promise(ok => c.onClose(ok));

test('channel: admit sees the joiner key and message 3 payload; both show one check string; messages both ways (R29c, R30)', async () => {
  const p = await pair({ payload: Buffer.from('the-mac') });
  const [h, j] = await Promise.all([p.hostSide, p.joiner]);
  assert.ok(h);
  assert.deepEqual(p.seen, [{ key: p.me.pub, payload: Buffer.from('the-mac') }]);
  assert.deepEqual([h.remoteKey, j.remoteKey], [p.me.pub, p.host.pub]);
  assert.match(j.check, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(h.check, j.check);
  const big = Buffer.alloc(3 * MAX_FRAME + 7, 7);
  for (const m of [Buffer.from('{"t":"ping","n":1}'), big, Buffer.alloc(0)]) j.send(m);
  const got: Buffer[] = [];
  await new Promise<void>(ok => h.onMessage(m => { got.push(m); if (got.length === 3) ok(); }));
  assert.equal(got[0]?.toString(), '{"t":"ping","n":1}');
  assert.ok(got[1]?.equals(big), 'a message larger than a frame arrives whole');
  assert.equal(got[2]?.length, 0);
  h.send(Buffer.from('pong'));
  assert.equal((await next(j)).toString(), 'pong');
  const end = closed(h);
  j.close();
  assert.equal(await end, null);
});

test('channel: a wrong host key fails at message 1, before message 3 (and the MAC) is ever written (R29c)', async () => {
  const p = await pair({ rs: generateKeyPair().pub, payload: Buffer.from('secret-mac') });
  await assert.rejects(p.hostSide, NoiseError);
  await assert.rejects(p.joiner, NoiseError);
  assert.equal(p.seen.length, 0);
});

test('channel: admit false ends the stream; the joiner\'s channel closes', async () => {
  const p = await pair({ admit: false });
  assert.equal(await p.hostSide, null);
  const j = await p.joiner;
  await closed(j);
  assert.throws(() => j.send(Buffer.from('x')), NoiseError);
});

test('channel: a tampered frame closes it with an error', async () => {
  const p = await pair();
  const [h, j] = await Promise.all([p.hostSide, p.joiner]);
  assert.ok(h);
  const end = closed(h);
  p.a.write(Buffer.from([0, 20, ...Buffer.alloc(20)])); // a frame no key sealed
  assert.ok((await end) instanceof NoiseError);
  await closed(j);
});

test('channel: a joiner that never sends message 1 is dropped after timeoutMs, or HANDSHAKE_MS with none; admit is never asked', { timeout: 5000 }, async t => {
  const [, b] = duplexPair();
  let asked = false;
  await assert.rejects(accept(b, { s: generateKeyPair(), timeoutMs: 30, admit: () => (asked = true) }), NoiseError);
  assert.ok(!asked && b.destroyed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [, c] = duplexPair();
  const h = accept(c, { s: generateKeyPair(), admit: () => (asked = true) });
  t.mock.timers.tick(HANDSHAKE_MS - 1);
  assert.ok(!c.destroyed);
  t.mock.timers.tick(1);
  await assert.rejects(h, NoiseError);
  assert.ok(!asked);
});

/** A joiner that speaks the wire by hand, to send what connect() never would. */
async function rawJoiner(stream: Duplex, hostKey: Buffer) {
  const hs = new Handshake(true, { s: generateKeyPair(), rs: hostKey });
  const frame = (b: Buffer): Buffer => { const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
  stream.write(frame(hs.writeMessage()));
  const m2 = await new Promise<Buffer>(ok => stream.once('data', (c: Buffer) => ok(c)));
  hs.readMessage(m2.subarray(2));
  const m3 = frame(hs.writeMessage());
  const { send } = hs.split();
  return { m3, seal: (more: number, body: Buffer): Buffer => frame(send.encrypt(Buffer.concat([Buffer.from([more]), body]))) };
}
/** A stream pair that closes as a socket does, one end gone and the other sees it, and a host key. */
function linked() {
  const [a, b] = duplexPair();
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
  return { a, b, host: generateKeyPair() };
}

test('channel: nothing past message 3 is read while admit() waits; it arrives once admitted', { timeout: 5000 }, async () => {
  const { a, b, host } = linked();
  let answer: (yes: boolean) => void = () => {};
  let asked = false;
  const h = accept(b, { s: host, admit: () => { asked = true; return new Promise<boolean>(ok => { answer = ok; }); } });
  const j = await rawJoiner(a, host.pub);
  a.write(j.m3);
  a.write(j.seal(0, Buffer.from('hello')));
  await new Promise(ok => setImmediate(ok));
  assert.ok(asked && b.isPaused(), 'the host stopped reading');
  answer(true);
  const ch = await h;
  assert.ok(ch);
  assert.equal((await next(ch)).toString(), 'hello');
  ch.close();
});

test('channel: data piled behind message 3 in one write ends the stream before admission', { timeout: 5000 }, async () => {
  const { a, b, host } = linked();
  let asked = false;
  const h = accept(b, { s: host, admit: () => (asked = true) });
  const j = await rawJoiner(a, host.pub);
  a.write(Buffer.concat([j.m3, Buffer.alloc(1 << 20)]));
  assert.equal(await h.catch(() => null), null);
  assert.ok(b.destroyed && !asked);
});

test('channel: an admit() that throws ends the stream', { timeout: 5000 }, async () => {
  const { a, b, host } = linked();
  const h = accept(b, { s: host, admit: () => { throw new Error('the card failed'); } });
  a.write((await rawJoiner(a, host.pub)).m3);
  await assert.rejects(h, /the card failed/);
  assert.ok(b.destroyed);
});

/** An admitted raw joiner and the host's channel. */
async function admitted() {
  const { a, b, host } = linked();
  const h = accept(b, { s: host, admit: () => true });
  const j = await rawJoiner(a, host.pub);
  a.write(j.m3);
  const ch = await h;
  assert.ok(ch);
  return { a, j, ch };
}

test('channel: a message over MAX_MESSAGE is refused on receipt and on send, and so are messages past it in all with nobody reading them yet', { timeout: 5000 }, async () => {
  const piece = Buffer.alloc(65_000);
  for (const [more, why] of [[1, /over/], [0, /nobody reading/]] as const) {
    const { a, j, ch } = await admitted();
    const end = closed(ch);
    for (let n = 0; n * piece.length <= MAX_MESSAGE; n++) a.write(j.seal(more, piece));
    assert.match(String(await end), why);
  }
  const p = await pair();
  const [h2, jc] = await Promise.all([p.hostSide, p.joiner]);
  assert.throws(() => jc.send(Buffer.alloc(MAX_MESSAGE + 1)), /over/);
  h2?.close();
});

test('channel: a close inside a continued message is an error; a continuation byte other than 0 or 1 is refused', { timeout: 5000 }, async () => {
  const one = await admitted();
  const end = closed(one.ch);
  one.a.write(one.j.seal(1, Buffer.from('half')));
  await new Promise(ok => setImmediate(ok));
  one.a.destroy();
  assert.match(String(await end), /inside a message/);
  const two = await admitted();
  const end2 = closed(two.ch);
  two.a.write(two.j.seal(2, Buffer.from('x')));
  assert.match(String(await end2), /continuation/);
});
