// lib/remote/invite-secret.ts: the SECRET word of an invite line: 128 bits of secret and a 64-bit tag of the host key
// in 39 characters of lower-case Crockford base32, read back in either case and with the look-alikes; the tag names one
// key in one role, under that secret only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as secret from '../lib/remote/invite-secret.ts';
import { must } from './support/must.ts';

const key = () => crypto.randomBytes(32).toString('base64url');

test('a SECRET is 39 characters a chat app leaves alone, and reads back as the same 16 + 8 bytes', () => {
  assert.equal(secret.WORD_LEN, 39);
  for (let i = 0; i < 50; i++) {
    const s = secret.mint(), t = crypto.randomBytes(8);
    const w = secret.encode(s, t);
    assert.match(w, /^[0-9a-hjkmnp-tv-z]{39}$/);
    const d = must(secret.decode(w));
    assert.deepEqual([d.secret, d.tag], [s, t]);
  }
  const zero = secret.encode(Buffer.alloc(16), Buffer.alloc(8));
  assert.equal(zero, '0'.repeat(39));
  const ones = secret.encode(Buffer.alloc(16, 0xff), Buffer.alloc(8, 0xff));
  assert.equal(ones, `3${'z'.repeat(38)}`, 'the first character carries 2 bits (195 - 192: the top 3 are 0)');
});

test('decode: upper case and the look-alikes read as Crockford says; anything else is no SECRET', () => {
  const s = secret.mint(), t = crypto.randomBytes(8);
  const w = secret.encode(s, t);
  assert.deepEqual(must(secret.decode(w.toUpperCase())).secret, s);
  assert.deepEqual(must(secret.decode(`  ${w}\n`)).secret, s);
  const withO = w.replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual(must(secret.decode(withO)).secret, s);
  for (const bad of [w.slice(1), `${w}0`, w.replace(/.$/, 'u'), w.replace(/^./, '8'), `${w.slice(0, 20)}-${w.slice(21)}`, '', 42, null]) {
    assert.equal(secret.decode(bad), null, String(bad));
  }
});

test('the tag names one key in one role, under this secret only', () => {
  const s = secret.mint(), k = key();
  const d = { secret: s, tag: secret.tagOf(s, 'listener', k) };
  assert.equal(d.tag.length, 8);
  assert.equal(secret.keyHolds(d, 'listener', k), true);
  assert.equal(secret.keyHolds(d, 'machine', k), false, 'another role');
  assert.equal(secret.keyHolds(d, 'listener', key()), false, 'another key');
  assert.equal(secret.keyHolds({ secret: secret.mint(), tag: d.tag }, 'listener', k), false, 'another secret');
  assert.equal(secret.keyHolds(d, 'listener', 'not a key'), false);
  assert.throws(() => secret.tagOf(Buffer.alloc(15), 'machine', k), TypeError);
  assert.equal(secret.idOf(s), s.toString('base64url'));
});
