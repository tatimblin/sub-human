// lib/remote/noise.ts against published Noise test vectors for Noise_NK_25519_ChaChaPoly_SHA256 and
// Noise_XK_25519_ChaChaPoly_SHA256, vendored here:
//   cacophony: https://raw.githubusercontent.com/haskell-cryptography/cacophony/master/vectors/cacophony.txt
//   snow:      https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/snow.txt
// (NK fetched 2026-10-08, XK 2026-10-15; the object of each with no PSK, verbatim but for its PSK fields). Messages
// alternate initiator, responder; the first two (NK) or three (XK) are the handshake, the rest transport messages
// under the split keys.
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

const XK_VECTORS = [
  {
    source: 'cacophony',
    protocol_name: 'Noise_XK_25519_ChaChaPoly_SHA256',
    init_prologue: '4a6f686e2047616c74',
    init_static: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
    init_ephemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
    init_remote_static: '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62',
    resp_prologue: '4a6f686e2047616c74',
    resp_static: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
    resp_ephemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
    handshake_hash: 'cefffc5d1074126cc980ebfe902587ff36ba61dc77d4447ebe0f96dc22ae59d7',
    messages: [
      { payload: '4c756477696720766f6e204d69736573', ciphertext: 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944a3785af283c991bab613473804356ef6931f83acf64f99c274b93570857cfc5e' },
      { payload: '4d757272617920526f746862617264', ciphertext: '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088433a4534805fa9fe4eb8343ace6609160c767ad9b832e8eea1d9b7a2111818dd' },
      { payload: '462e20412e20486179656b', ciphertext: '5d8e67b9c1b8e36f5dc674bc5cd2ce243fb5d1710fa57de0370da7cc979015398eaad94603b05498ba9a613d2fd923dcaa6fd4288dfd8d70f419bf737efb4cd37f5da37ebb728849318c82' },
      { payload: '4361726c204d656e676572', ciphertext: '3205e1265f809505e6edc092839d3156745d2abafbfd946b261e41' },
      { payload: '4a65616e2d426170746973746520536179', ciphertext: '470bcb1ae099555ff0d729500df550418d6ee5149d9e40bd2f4c6b3d263cc818d5' },
      { payload: '457567656e2042f6686d20766f6e2042617765726b', ciphertext: 'd7187ed9d217ba6e91cf596e4871012ccedf7b5bed0d4cb8f7affb020fa17a95a23371e0f6' },
    ],
  },
  {
    source: 'snow',
    protocol_name: 'Noise_XK_25519_ChaChaPoly_SHA256',
    init_prologue: '5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e',
    init_static: 'd79245fc228517d26ab3026f901e6de5e87029f62f5337bb7aeaf290630663c5',
    init_ephemeral: '821a1cfc35eafdfd7ceec182cea0b46a8b41715f8b1a6c3255da349a4205a912',
    init_remote_static: 'baa04200175deb54e07ebee17c69f8a464400d33504a8f0b960a49638712df5c',
    resp_prologue: '5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e',
    resp_static: '41f32f158d5bde75b0814850d79885e717c1858b34ae1787911dabb846dfb28a',
    resp_ephemeral: 'd3d600d3d556e1819de798950067a5b9f07977aa4dfc7ccea983bccc4f92ed5d',
    messages: [
      { payload: '5ff166c364c401f5cccefe5dbef2399eb35af4f77373ac26e98cc2178b3d4f05', ciphertext: 'e72ac10bdc197cc923051ac8ce5e8f952873928d4c0be6bc3e1ce2c44a5d8948fcff0ce5c4eb228940fa1f01db75144acf89e5f5fe3f456ebb2439d1c59e430840751ef5f93567d268d5399b78c56137' },
      { payload: '44d9a8b2dfc5e4db9109c08e7345ad331bc74d16d5580a0ccab5695a0d4ea406', ciphertext: '573253370220f0dcfae0ff8f800d885f67aaa0aabf13191e4b17241b0a50ba1721b33d6f53bb9147724bb5f9b80347d4151c68de9ecd62170433df78eb5e3dee843ced53014a2922d7f7c7a447ddc347' },
      { payload: '82e4f70bd164c183c4d116f4d18e92c1e8c57257dcc5414b10e1df7ba66490dc', ciphertext: '7aee57bc9c27b1489388b1b114335b1c777a242dd3f199d0a44cf3588910371cfefaced10536e91859a496caeb78f52e63d3703766c33e05bbd94c985421e1d1461d769fd6b9f333b32ca30cb17ee09ac7af9b7499a5a8d0a3e19aff0e1dd055' },
      { payload: '534f98102268d35aed2ad42b7929840845b67f3d1e27fa05b9365675cdf9ecf3', ciphertext: 'c837eb9eba146171756bdc87f554052496e2ccc7c8e7a224d49a53302240134c9925c8919662f162f8e086dc93694eb1' },
      { payload: '7cdebd667263c56a74ed30fcc0783f4ee90b17cc4e8c4c31e47f81484211caf1', ciphertext: '553d810ba41db883b8f990b088f834eecf960c66dc63c65eefef0a51e5661289069ce103e5c9b742ae33806d383eb2a1' },
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

for (const v of XK_VECTORS) {
  test(`Noise XK vector (${v.source}): every message byte for byte, both sides; the responder learns the initiator's key`, () => {
    const rs = noise.keyPair(hex(v.resp_static));
    const is = noise.keyPair(hex(v.init_static));
    assert.equal(rs.pub.toString('hex'), v.init_remote_static, 'the responder static public key is the pinned one');
    const i = noise.initiator({ pattern: 'XK', rs: hex(v.init_remote_static), s: is, prologue: hex(v.init_prologue), e: noise.keyPair(hex(v.init_ephemeral)) });
    const r = noise.responder({ pattern: 'XK', s: rs, prologue: hex(v.resp_prologue), e: noise.keyPair(hex(v.resp_ephemeral)) });
    const [m1, m2, m3, ...rest] = v.messages;
    const c1 = i.writeMessage(hex(m1.payload));
    assert.equal(c1.toString('hex'), m1.ciphertext, 'message 1');
    assert.equal(r.readMessage(c1).toString('hex'), m1.payload);
    assert.equal(r.remoteStatic, null, 'no initiator key before message 3');
    const c2 = r.writeMessage(hex(m2.payload));
    assert.equal(c2.toString('hex'), m2.ciphertext, 'message 2');
    assert.equal(i.readMessage(c2).toString('hex'), m2.payload);
    assert.ok(!i.done && !r.done, 'XK has a third message');
    const c3 = i.writeMessage(hex(m3.payload));
    assert.equal(c3.toString('hex'), m3.ciphertext, 'message 3');
    assert.equal(r.readMessage(c3).toString('hex'), m3.payload);
    assert.ok(i.done && r.done);
    assert.deepEqual(r.remoteStatic, is.pub, 'message 3 carried the initiator\'s static key');
    if (v.handshake_hash) assert.equal(i.handshakeHash!.toString('hex'), v.handshake_hash);
    assert.deepEqual(i.handshakeHash, r.handshakeHash);
    const ic = i.split(), rc = r.split();
    rest.forEach((m, k) => {
      // after XK's three messages the responder speaks first
      const [tx, rx] = k % 2 === 0 ? [rc.send, ic.recv] : [ic.send, rc.recv];
      const c = tx.encrypt(hex(m.payload));
      assert.equal(c.toString('hex'), m.ciphertext, `transport message ${k + 4}`);
      assert.equal(rx.decrypt(c).toString('hex'), m.payload);
    });
  });
}

test('Noise XK: message 1 of one pattern never reads as the other; a forged message 3 fails; a key that is not the pinned one is refused', () => {
  const host = noise.generateKeyPair(), me = noise.generateKeyPair(), other = noise.generateKeyPair();
  const xk = noise.initiator({ pattern: 'XK', rs: host.pub, s: me });
  const m1 = xk.writeMessage(Buffer.from('{"v":3}'));
  assert.throws(() => noise.responder({ s: host }).readMessage(m1), { code: 'NOISE' }, 'an XK message 1 is no NK message 1');
  const nk = noise.initiator({ rs: host.pub });
  assert.throws(() => noise.responder({ pattern: 'XK', s: host }).readMessage(nk.writeMessage(Buffer.from('x'))), { code: 'NOISE' });
  assert.throws(() => noise.responder({ pattern: 'XK', s: other }).readMessage(m1), { code: 'NOISE' }, 'only the pinned key reads message 1');
  const r = noise.responder({ pattern: 'XK', s: host });
  r.readMessage(m1);
  xk.readMessage(r.writeMessage(Buffer.from('ok')));
  const m3 = xk.writeMessage();
  const bad = Buffer.from(m3);
  bad[5] ^= 1;
  assert.throws(() => r.readMessage(bad), { code: 'NOISE' }, 'a tampered message 3');
  assert.throws(() => noise.initiator({ pattern: 'XK', rs: host.pub }), { code: 'NOISE' }, 'XK needs the initiator\'s own key');
});

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
