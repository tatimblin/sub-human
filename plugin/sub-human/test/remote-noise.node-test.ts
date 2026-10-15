// lib/remote/noise.ts against published Noise test vectors for Noise_NK_25519_ChaChaPoly_SHA256, vendored here:
//   cacophony: https://raw.githubusercontent.com/haskell-cryptography/cacophony/master/vectors/cacophony.txt
//   snow:      https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/snow.txt
// (fetched 2026-10-08; the NK_25519_ChaChaPoly_SHA256 object of each, verbatim). Messages alternate initiator,
// responder; the first two are the handshake, the rest transport messages under the split keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as noise from '../lib/remote/noise.ts';

const VECTORS = [
  {
    source: 'cacophony',
    protocol_name: 'Noise_NK_25519_ChaChaPoly_SHA256',
    init_prologue: '4a6f686e2047616c74',
    init_ephemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
    init_remote_static: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
    resp_prologue: '4a6f686e2047616c74',
    resp_static: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
    resp_ephemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
    handshake_hash: '2efa38a9c7c93ac98f3a097af25c2f58b9e7673787717bc27e98827118c2c1a5',
    messages: [
      { payload: '4c756477696720766f6e204d69736573', ciphertext: 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0' },
      { payload: '4d757272617920526f746862617264', ciphertext: '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88' },
      { payload: '462e20412e20486179656b', ciphertext: 'a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0' },
      { payload: '4361726c204d656e676572', ciphertext: '174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff' },
      { payload: '4a65616e2d426170746973746520536179', ciphertext: '337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777' },
      { payload: '457567656e2042f6686d20766f6e2042617765726b', ciphertext: '047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d' },
    ],
  },
  {
    source: 'snow',
    protocol_name: 'Noise_NK_25519_ChaChaPoly_SHA256',
    init_prologue: '5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e',
    init_ephemeral: '1b0c2affa2a0ba57c3d96a2b5def1671aa00f66a46d306618a2546a6757f5f65',
    init_remote_static: 'a1685fa10096ad890ba2427ef08d85c44ffe7b1990ebb6ed7555f57b248b9319',
    resp_prologue: '5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e',
    resp_static: 'eb80faf5ebe8437d8edacb3bd95d0718a4eb3e5de6f835bca4d7e161301a563e',
    resp_ephemeral: '908f7161432df9036325367c1592ca275fea9a44cdf70d4f3135e16d0034dedc',
    messages: [
      { payload: '6b2da7554f3d4b8a27f371a0b2fb0d1b9c4830ea29e804b05d698f3f302740f4', ciphertext: '1c83e1721fadb9fc168e67da9d25503aa286e42d7d35b80c73096d29cce503096ee5516c7bd399fb1f8b0f2affa71e262626c7eb957069a46177f86530217aac9d18bbb78c297d3de7b651995c6783cc' },
      { payload: '0216bdac2fb32a7c53d9c4711e3ed995c2e856d19fb1ed465cc88efd4f347e6f', ciphertext: 'd514c7509ba675f32aaaaef759846609383fb36f6081a3aed84737c800a3127c66ebfa61ba8ee2a58b5074e40e3c0ce02ac02c30f3b6afd9ace9fcc4494485e7e3e545d05f5e9f1336ab5cd9f0d8eb54' },
      { payload: '0497dfc21ec4d70f04ffc7094b9467808c043d027c87d410b62e1af3dc791dce', ciphertext: '5bd6fb7c4fd75dd4d15b6600c8df4a59509709a97affb19f4e4a72e62dc8459f89361ae710a9fd58545eee4ceb37ec01' },
      { payload: '874ba1f2539061f556a212f83c7a96faf33a451aa75099ef8a9b2aeb54c48f36', ciphertext: '1f7b7dd2a4992441bc91b6996b0079c3b0747e5aa8dc2443b1fe01331d57644647bbef13cda29f0abc9836739df52fff' },
    ],
  },
];

const hex = (s: string) => Buffer.from(s, 'hex');

for (const v of VECTORS) {
  test(`Noise NK vector (${v.source}): every message byte for byte, both sides`, () => {
    const rs = noise.keyPair(hex(v.resp_static));
    assert.equal(rs.pub.toString('hex'), v.init_remote_static, 'the responder static public key is the pinned one');
    const i = noise.initiator({ rs: hex(v.init_remote_static), prologue: hex(v.init_prologue), e: noise.keyPair(hex(v.init_ephemeral)) });
    const r = noise.responder({ s: rs, prologue: hex(v.resp_prologue), e: noise.keyPair(hex(v.resp_ephemeral)) });
    const [m1, m2, ...rest] = v.messages;
    const c1 = i.writeMessage(hex(m1.payload));
    assert.equal(c1.toString('hex'), m1.ciphertext, 'message 1');
    assert.equal(r.readMessage(c1).toString('hex'), m1.payload);
    const c2 = r.writeMessage(hex(m2.payload));
    assert.equal(c2.toString('hex'), m2.ciphertext, 'message 2');
    assert.equal(i.readMessage(c2).toString('hex'), m2.payload);
    assert.ok(i.done && r.done);
    if (v.handshake_hash) assert.equal(i.handshakeHash!.toString('hex'), v.handshake_hash);
    assert.deepEqual(i.handshakeHash, r.handshakeHash);
    const ic = i.split(), rc = r.split();
    rest.forEach((m, k) => {
      const [tx, rx] = k % 2 === 0 ? [ic.send, rc.recv] : [rc.send, ic.recv];
      const c = tx.encrypt(hex(m.payload));
      assert.equal(c.toString('hex'), m.ciphertext, `transport message ${k + 3}`);
      assert.equal(rx.decrypt(c).toString('hex'), m.payload);
    });
  });
}

test('Noise NK: a responder without the pinned key cannot read message 1; a wrong answer fails at the initiator', () => {
  const host = noise.generateKeyPair(), other = noise.generateKeyPair();
  const i = noise.initiator({ rs: host.pub });
  const m1 = i.writeMessage(Buffer.from('{"code":"otter-1234"}'));
  assert.throws(() => noise.responder({ s: other }).readMessage(m1), { code: 'NOISE' });
  // an impostor that answers from its own key: its message 2 does not decrypt for the initiator
  const imp = noise.responder({ s: other });
  imp.re = m1.subarray(0, 32); // pretend it read message 1
  imp.ss.mixHash(imp.re);
  imp.step = 1;
  const m2 = imp.writeMessage(Buffer.from('ok'));
  assert.throws(() => i.readMessage(m2), { code: 'NOISE' });
});

test('Noise NK transport: tamper, replay and reorder fail; a fresh handshake works end to end', () => {
  const host = noise.generateKeyPair();
  const i = noise.initiator({ rs: host.pub }), r = noise.responder({ s: host });
  assert.equal(r.readMessage(i.writeMessage(Buffer.from('hi'))).toString(), 'hi');
  assert.equal(i.readMessage(r.writeMessage(Buffer.from('yo'))).toString(), 'yo');
  const a = i.split(), b = r.split();
  const c1 = a.send.encrypt(Buffer.from('one')), c2 = a.send.encrypt(Buffer.from('two'));
  assert.throws(() => b.recv.decrypt(c2), { code: 'NOISE' }, 'reordered');
  assert.equal(b.recv.decrypt(c1).toString(), 'one');
  assert.throws(() => b.recv.decrypt(c1), { code: 'NOISE' }, 'replayed');
  const bad = Buffer.from(c2);
  bad[0] ^= 1;
  assert.throws(() => b.recv.decrypt(bad), { code: 'NOISE' }, 'tampered');
  assert.equal(b.recv.decrypt(c2).toString(), 'two');
  assert.throws(() => a.send.encrypt(Buffer.alloc(noise.MAX_PLAINTEXT + 1)), { code: 'NOISE' });
});

test('Noise: X25519 refuses a low-order public key (all-zero secret)', () => {
  assert.throws(() => noise.dh(noise.generateKeyPair().priv, Buffer.alloc(32)), { code: 'NOISE' });
});

test('the host static key: made once 0600, read back the same, refused when others can read it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-noise-'));
  const file = path.join(dir, 'keys', 'host-x25519.json');
  const a = noise.loadOrCreateStatic(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(noise.loadOrCreateStatic(file), a);
  fs.chmodSync(file, 0o644);
  assert.throws(() => noise.loadOrCreateStatic(file), /readable by others/);
  fs.rmSync(dir, { recursive: true, force: true });
});
