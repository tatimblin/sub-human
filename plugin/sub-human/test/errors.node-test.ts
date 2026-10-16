// lib/errors.ts: reading a caught value; RoomError's code is a WireCode; REASON_CODE pairs each reason with its code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { errCode, isCoded, isErrno, msgOf, stackOf } from '../lib/errors.ts';
import { RoomError } from '../lib/room/validate.ts';
import { NoiseError } from '../lib/remote/noise.ts';
import * as protocol from '../lib/remote/protocol.ts';
import { REASON_CODE, isReason } from '../lib/reasons.ts';

const ROOT = path.join(import.meta.dirname, '..');
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } assert.fail('it did not throw'); };
const enoent = thrown(() => fs.readFileSync(path.join(ROOT, 'no-such-file')));

test('msgOf: an Error\'s message, any object\'s string message, else String(e)', () => {
  assert.equal(msgOf(new Error('boom')), 'boom');
  assert.equal(msgOf(new RoomError('AUTH', 'no')), 'no');
  assert.equal(msgOf({ message: 'from a worker' }), 'from a worker');
  assert.equal(msgOf('plain'), 'plain');
  assert.equal(msgOf(null), 'null');
  assert.equal(msgOf(undefined), 'undefined');
  assert.equal(msgOf({ message: 42 }), '[object Object]');
  assert.equal(msgOf(new Error('')), '', 'an empty message stays empty (callers that want a fallback say || String(e))');
});

test('stackOf: the stack when there is one, else String(e)', () => {
  const e = new Error('x');
  assert.equal(stackOf(e), e.stack);
  assert.equal(stackOf('x'), 'x');
  assert.equal(stackOf(null), 'null');
});

test('errCode: a string code, whatever threw it', () => {
  assert.equal(errCode(enoent), 'ENOENT');
  assert.equal(errCode(new RoomError('OFFLINE', 'x')), 'OFFLINE');
  assert.equal(errCode(new NoiseError('x')), 'NOISE');
  assert.equal(errCode({ code: 'LOCK' }), 'LOCK');
  assert.equal(errCode({ code: 7 }), undefined);
  assert.equal(errCode(new Error('x')), undefined);
  assert.equal(errCode(null), undefined);
  assert.equal(errCode('ENOENT'), undefined);
});

test('isErrno: a system error, by its code when given; never one of ours', () => {
  assert.ok(isErrno(enoent));
  assert.ok(isErrno(enoent, 'ENOENT'));
  assert.ok(!isErrno(enoent, 'EEXIST'));
  assert.ok(!isErrno(new RoomError('OFFLINE', 'x')));
  assert.ok(!isErrno(new NoiseError('x')));
  assert.ok(!isErrno({ code: 'ENOENT' }), 'an Error only');
});

test('isCoded: RoomError (and its subclasses) and NoiseError, not a system error or a plain one', () => {
  class Sub extends RoomError {}
  assert.ok(isCoded(new RoomError('INVALID', 'x')));
  assert.ok(isCoded(new Sub('LOCK', 'x')));
  assert.ok(isCoded(new NoiseError('x')));
  assert.ok(!isCoded(enoent));
  assert.ok(!isCoded(Object.assign(new Error('x'), { code: 'AUTH' })));
  assert.ok(!isCoded({ code: 'AUTH', message: 'x' }));
  assert.deepEqual(Object.keys(new RoomError('AUTH', 'x', 'INVITE_USED')).sort(), ['code', 'reason'], 'the brand is on the prototype: an error\'s own keys are unchanged');
});

test('CODES: one source (CODE_NAMES); a code this end does not know reads as INVALID', () => {
  assert.deepEqual(Object.keys(protocol.CODES).sort(), [...protocol.CODE_NAMES].sort());
  for (const c of protocol.CODE_NAMES) assert.equal(protocol.CODES[c], c);
  assert.ok(protocol.isWireCode('OFFLINE'));
  assert.ok(!protocol.isWireCode('NOISE'));
  assert.ok(!protocol.isWireCode('ENOENT'));
  const e = protocol.toError({ code: 'SOMETHING_NEWER', message: 'a newer host', reason: 'QUOTA' });
  assert.deepEqual([e.code, e.message, e.reason], ['INVALID', 'a newer host', 'QUOTA']);
  assert.equal(protocol.toError({ code: 'STALE', message: 'm' }).code, 'STALE');
});

test('REASON_CODE: every reason has a code of CODES (or null: a stop reason)', () => {
  for (const [r, c] of Object.entries(REASON_CODE)) {
    assert.ok(isReason(r));
    assert.ok(c === null || protocol.isWireCode(c), `${r}: ${String(c)}`);
  }
  assert.deepEqual(Object.entries(REASON_CODE).filter(([, c]) => c === null).map(([r]) => r).sort(), ['NO_SEAT', 'ROOM_CLOSED']);
});

test('REASON_CODE: every RoomError the source builds with a literal code and reason pairs them as the map does', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!['test', 'node_modules', 'vendor'].includes(d.name) && !d.name.startsWith('.')) walk(p); } else if (p.endsWith('.ts')) files.push(p);
    }
  };
  for (const d of ['lib', 'hooks', 'mcp', 'mod']) walk(path.join(ROOT, d));
  // new RoomError('CODE', <message on the same line>, 'REASON')
  const RE = /new (?:RoomError|[A-Z]\w*Error)\('([A-Z_]+)',[^\n]*?,\s*'([A-Z_]+)'\)/g;
  const seen: string[] = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(RE)) {
      const [, code, reason] = m;
      if (!isReason(reason)) continue;
      const want = REASON_CODE[reason];
      assert.ok(want === null || want === code, `${path.relative(ROOT, f)}: ${code} with ${reason} (REASON_CODE says ${want})`);
      seen.push(reason);
    }
  }
  assert.ok(seen.length >= 10, `found ${seen.length} literal pairs: the scan still matches the source`);
});

test('lib/errors.ts loads nothing at run time (a hook loads it for free)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'errors.ts'), 'utf8');
  const imports = src.split('\n').filter(l => /^import\b/.test(l));
  assert.ok(imports.length > 0);
  for (const l of imports) assert.match(l, /^import type /, l);
});
