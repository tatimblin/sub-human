'use strict';
// lib/room/envelope.js, pure: sig v2 covers the payload and not its place (id, at, prev), with sorted keys; v1
// (the stored line minus sig) still verifies; the ts bound; first-sight key pinning from member_joined.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./helpers.js');
const envelope = require(path.join(h.LIB, 'room', 'envelope.js'));

const CODE = 'otter-1234';
const pair = () => crypto.generateKeyPairSync('ed25519');
const pem = pub => pub.export({ type: 'spki', format: 'pem' });
const payload = (extra = {}) => ({ from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'ship it', ...extra });

test('envelope: signable leaves out id, at, prev and sig, and sorts keys at every level', () => {
  const a = envelope.signable({ id: 7, at: 'x', prev: 'y', sig: 'z', text: 't', approvers: ['b', 'a'], from: 'alice', task: { z: 1, a: 2 } });
  assert.equal(a, '{"approvers":["b","a"],"from":"alice","task":{"a":2,"z":1},"text":"t"}');
  assert.equal(envelope.signable({ text: 't', from: 'alice' }), envelope.signable({ from: 'alice', text: 't' }));
});

test('envelope: sign adds room, from, nonce, ts and sigv 2; the sig verifies wherever the line is placed', () => {
  const { privateKey, publicKey } = pair();
  const now = Date.now();
  const p = envelope.sign(payload(), privateKey, { room: CODE, from: 'alice', now });
  assert.deepEqual([p.room, p.from, p.ts, p.sigv], [CODE, 'alice', now, 2]);
  assert.match(p.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(envelope.sign(payload(), privateKey, { room: CODE, from: 'alice' }).nonce, p.nonce);
  assert.equal(envelope.isV2(p), true);
  assert.equal(envelope.verify(p, publicKey), true);
  // placed at any id, time and prev: still the person's words
  assert.equal(envelope.verify({ id: 1, at: new Date().toISOString(), ...p, prev: 'aaaaaaaaaaaa' }, publicKey), true);
  assert.equal(envelope.verify({ id: 42, at: '2020-01-01T00:00:00.000Z', ...p, prev: 'bbbbbbbbbbbb' }, publicKey), true);
  // any signed field changed, or another key: no
  for (const k of ['text', 'from', 'room', 'nonce', 'kind']) assert.equal(envelope.verify({ ...p, [k]: 'other' }, publicKey), false, k);
  assert.equal(envelope.verify({ ...p, ts: now + 1 }, publicKey), false);
  assert.equal(envelope.verify({ ...p, provisional: true }, publicKey), false, 'an added field is not signed');
  assert.equal(envelope.verify(p, pair().publicKey), false);
  assert.equal(envelope.verify({ ...p, sig: undefined }, publicKey), false);
});

test('envelope: a v1 entry (signed over the stored line minus sig, before PR1) still verifies; its id is under the sig', () => {
  const { privateKey, publicKey } = pair();
  const e = { id: 3, at: new Date().toISOString(), from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'old', room: CODE, prev: 'aaaaaaaaaaaa' };
  e.sig = crypto.sign(null, Buffer.from(JSON.stringify(e)), privateKey).toString('base64');
  assert.equal(envelope.isV2(e), false);
  assert.equal(envelope.verify(e, publicKey), true);
  assert.equal(envelope.verify({ ...e, id: 4 }, publicKey), false, 'v1 covered its place too');
  assert.equal(envelope.verify({ ...e, text: 'new' }, publicKey), false);
});

test('envelope: freshTs is the replay bound around the host clock', () => {
  const now = Date.now();
  assert.equal(envelope.freshTs({ ts: now }, now), true);
  assert.equal(envelope.freshTs({ ts: now - envelope.SIG_SKEW_MS }, now), true);
  assert.equal(envelope.freshTs({ ts: now + envelope.SIG_SKEW_MS + 1 }, now), false);
  assert.equal(envelope.freshTs({ ts: now - envelope.SIG_SKEW_MS - 1 }, now), false);
  assert.equal(envelope.freshTs({ ts: String(now) }, now), false);
  assert.equal(envelope.freshTs({}, now), false);
});

test('envelope: pinnedKeys keeps the first member_joined pubkey per name; keyed says whether any is pinned', () => {
  const [a1, a2, b] = [pair().publicKey, pair().publicKey, pair().publicKey];
  const joined = (from, pub, extra = {}) => ({ kind: 'member_joined', via: 'system', from, text: `${from} joined`, pubkey: pem(pub), ...extra });
  const legacy = [{ kind: 'member_joined', via: 'system', from: 'alice', text: 'alice joined' }, { kind: 'say', via: 'human', from: 'alice', text: 'hi' }];
  assert.equal(envelope.pinnedKeys(legacy).size, 0);
  assert.equal(envelope.keyed(legacy), false);
  const log = [
    ...legacy,
    joined('bob', b, { via: 'human' }),            // not a system entry: pins nothing
    { kind: 'say', via: 'system', from: 'bob', pubkey: pem(b) }, // not a join
    joined('alice', a1),
    joined('alice', a2),                            // first sight wins
    { kind: 'member_joined', via: 'system', from: 'carol', pubkey: 'not a key' },
  ];
  const pins = envelope.pinnedKeys(log);
  assert.deepEqual([...pins.keys()], ['alice']);
  assert.ok(pins.get('alice').equals(a1));
  assert.equal(envelope.keyed(log), true);
  assert.equal(envelope.parseKey(pem(a1)).asymmetricKeyType, 'ed25519');
  assert.equal(envelope.parseKey(pem(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)), null, 'Ed25519 only');
});
