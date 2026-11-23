// net/invite.ts: lines for each pathway round-trip, bad lines are refused with a reason, and verify() tells an open
// line from one dialled again, a dead one and a MAC made for another key or secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mac, mint, parse, verify } from './invite.js';
import type { InviteRecord, Pathway } from './invite.js';

const hostKey = crypto.randomBytes(32), joinerKey = crypto.randomBytes(32);
const NOW = 1_000_000, TTL = 15 * 60_000;
const lineFor = (via: Pathway, secret?: Buffer) => mint({ code: 'vole-8126', name: 'jess', hostKey, via, now: NOW, ttlMs: TTL, ...(secret ? { secret } : {}) });

test('mint and parse: https (Funnel or Serve) and ssh lines carry the code, the host key and the secret', () => {
  const secret = crypto.randomBytes(16);
  const cases: [Pathway, RegExp][] = [
    [{ kind: 'https', origin: 'https://devbox.tail1234.ts.net' }, /^https:\/\/devbox\.tail1234\.ts\.net\/vole-8126#[0-9a-hjkmnp-tv-z]{77}$/],
    [{ kind: 'https', origin: 'https://devbox.tail1234.ts.net:8443' }, /^https:\/\/devbox\.tail1234\.ts\.net:8443\/vole-8126#/],
    [{ kind: 'ssh', host: 'devbox', user: null, sshPort: null, port: 7311 }, /^ssh:\/\/devbox\/vole-8126\?port=7311#/],
    [{ kind: 'ssh', host: 'box.example.com', user: 'jess', sshPort: 2222, port: 7311 }, /^ssh:\/\/jess@box\.example\.com:2222\/vole-8126\?port=7311#/],
  ];
  for (const [via, shape] of cases) {
    const { line, record } = lineFor(via, secret);
    assert.match(line, shape);
    const p = parse(`  ${line}\n`);
    assert.ok(p.ok, line);
    assert.deepEqual(p.value, { code: 'vole-8126', hostKey, secret, via });
    assert.deepEqual([record.code, record.name, record.state, record.expiresAt], ['vole-8126', 'jess', 'open', NOW + TTL]);
    assert.ok(!JSON.stringify(record).includes(secret.toString('base64url')), 'the record never holds the secret');
  }
});

test('parse: an upper-case or look-alike word reads the same; bad lines name what is wrong', () => {
  const { line } = lineFor({ kind: 'ssh', host: 'devbox', user: null, sshPort: null, port: 7311 });
  const word = line.slice(line.indexOf('#') + 1);
  const p = parse(line), q = parse(line.replace(word, word.toUpperCase().replace(/1/g, 'l').replace(/0/g, 'O')));
  assert.ok(p.ok && q.ok);
  assert.deepEqual(q.value, p.value);
  for (const bad of [
    'hello',
    'http://devbox/vole-8126#' + word,
    line.slice(0, -1),
    line.replace(`#${word}`, `#u${word.slice(1)}`), // a character Crockford leaves out
    line.replace(`#${word}`, `#z${word.slice(1)}`), // more bits than 48 bytes
    line.replace('vole-8126', 'Vole 8126'),
    line.replace('devbox', '-oProxyCommand=x'),
    line.replace('?port=7311', ''),
    line.replace('?port=7311', '?port=99999'),
    'https://user@devbox.ts.net/vole-8126#' + word,
    'z'.repeat(77),
  ]) {
    const r = parse(bad);
    assert.ok(!r.ok, bad);
    assert.ok(r.error.length > 0);
  }
});

test('verify: an open line\'s MAC is found; it binds the joiner key, the host key and the secret', () => {
  const a = lineFor({ kind: 'https', origin: 'https://h.ts.net' });
  const b = lineFor({ kind: 'https', origin: 'https://h.ts.net' });
  const pa = parse(a.line);
  assert.ok(pa.ok);
  const records = [b.record, a.record];
  const m = mac(pa.value, joinerKey);
  assert.deepEqual(verify(m, hostKey, joinerKey, records, NOW), { kind: 'open', record: a.record });
  assert.deepEqual(verify(m, hostKey, crypto.randomBytes(32), records, NOW), { kind: 'none' }, 'another link key');
  assert.deepEqual(verify(m, crypto.randomBytes(32), joinerKey, records, NOW), { kind: 'none' }, 'another host');
  assert.deepEqual(verify(m, hostKey, joinerKey, [b.record], NOW), { kind: 'none' }, 'another line');
  assert.deepEqual(verify(Buffer.alloc(0), hostKey, joinerKey, records, NOW), { kind: 'none' }, 'no payload');
  assert.deepEqual(verify(m.subarray(1), hostKey, joinerKey, records, NOW), { kind: 'none' });
});

test('verify: a pending or used line dialled again is "again"; an expired or refused one is dead (R30)', () => {
  const { line, record } = lineFor({ kind: 'https', origin: 'https://h.ts.net' });
  const p = parse(line);
  assert.ok(p.ok);
  const m = mac(p.value, joinerKey);
  const as = (state: InviteRecord['state']): InviteRecord => ({ ...record, state });
  assert.equal(verify(m, hostKey, joinerKey, [as('pending')], NOW).kind, 'again');
  assert.equal(verify(m, hostKey, joinerKey, [as('used')], NOW).kind, 'again');
  assert.equal(verify(m, hostKey, joinerKey, [as('dead')], NOW).kind, 'dead');
  assert.equal(verify(m, hostKey, joinerKey, [record], NOW + TTL - 1).kind, 'open');
  assert.equal(verify(m, hostKey, joinerKey, [record], NOW + TTL).kind, 'dead');
});

test('parse never throws: a bad escape, a hex or exponent port, and 200k random mutations of a real line', () => {
  const { line } = lineFor({ kind: 'ssh', host: 'devbox', user: 'jess', sshPort: null, port: 7311 });
  for (const bad of [line.replace('jess@', '%E0%A4%A@'), line.replace('7311', '0x10'), line.replace('7311', '1e3'), line.replace('7311', '0')]) {
    assert.ok(!parse(bad).ok, bad);
  }
  const alphabet = '%@:/?#=.-_aZ09~ é';
  let seed = 7;
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let i = 0; i < 200_000; i++) {
    const chars = line.split('');
    for (let k = rand(4); k >= 0; k--) chars.splice(rand(chars.length), rand(2), alphabet.charAt(rand(alphabet.length)));
    assert.doesNotThrow(() => parse(chars.join('')));
  }
});

test('mint refuses a host key or secret of the wrong length', () => {
  const via: Pathway = { kind: 'https', origin: 'https://h.ts.net' };
  assert.throws(() => mint({ code: 'vole-8126', name: 'jess', hostKey: Buffer.alloc(31), via, now: NOW, ttlMs: TTL }), TypeError);
  assert.throws(() => lineFor(via, Buffer.alloc(15)), TypeError);
});
