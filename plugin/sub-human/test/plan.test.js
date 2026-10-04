'use strict';
// Tests for lib/plan.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const plan = require(path.join(h.LIB, 'plan.js'));
const room = require(path.join(h.LIB, 'room.js'));
const identity = require(path.join(h.LIB, 'identity.js'));

const FM = o => `---\nsub-human: ${JSON.stringify(o)}\n---\n`;

test('plan: parseFrontmatter accepts only a leading sub-human JSON line', () => {
  const ok = FM({ room: 'otter-4821', approval: 'all', approvers: ['alice', 'bob'] }) + '# Plan\n';
  assert.deepEqual(plan.parseFrontmatter(ok), { room: 'otter-4821', approval: 'all', approvers: ['alice', 'bob'], review: undefined });
  assert.deepEqual(plan.parseFrontmatter(Buffer.from(ok)).approvers, ['alice', 'bob']);
  assert.equal(plan.parseFrontmatter(FM({ review: 'abcdef012345' })).review, 'abcdef012345');
  assert.deepEqual(plan.parseFrontmatter('---\nsub-human: {}\n---').approvers, undefined, 'no trailing newline is fine');
  for (const bad of [
    '# Plan\n' + ok,                                           // not leading
    '\n' + ok, ' ' + ok, '﻿' + ok,                        // leading junk
    '---\nsub-human: {not json}\n---\n',
    '---\nsub-human: [1,2]\n---\n',
    '---\nsub-human: "x"\n---\n',
    '---\nsubhuman: {}\n---\n',
    '---\nsub-human: {}\n',                                    // unterminated
    '---\r\nsub-human: {}\r\n---\r\n',
    '---\ntitle: x\nsub-human: {}\n---\n',
    FM({ room: '../etc' }), FM({ approvers: ['a b'] }), FM({ approvers: 'alice' }), FM({ review: 'XYZ' }), FM({ approval: 3 }),
    '', null, 42,
  ]) assert.equal(plan.parseFrontmatter(bad), null, JSON.stringify(bad));
});

test('plan: isStub, body, stubFor', () => {
  const stub = plan.stubFor('otter-4821', 'abcdef012345');
  assert.equal(plan.isStub(stub), true);
  assert.deepEqual(plan.parseFrontmatter(stub), { room: 'otter-4821', approval: undefined, approvers: undefined, review: 'abcdef012345' });
  assert.equal(plan.isStub(FM({ room: 'otter-4821', review: 'abcdef012345' })), true);
  assert.equal(plan.isStub(FM({ room: 'otter-4821', review: 'abcdef012345' }) + '\n# Real plan\n' + 'step\n'.repeat(60)), false);
  assert.equal(plan.isStub(FM({ room: 'otter-4821', approvers: ['a'] })), false, 'no review field');
  assert.equal(plan.isStub('# just a plan'), false);
  assert.equal(plan.body(FM({}) + 'hello'), 'hello');
  assert.equal(plan.body('no fm'), 'no fm');
});

test('plan: storeCanonical is content-addressed and idempotent; canonical returns the bytes', () => {
  h.freshHome();
  const code = h.newRoom();
  const bytes = FM({ room: code, approval: 'all', approvers: ['alice'] }) + '# Plan\n\nemoji 🎉 and `code`\n';
  const hash = plan.storeCanonical(code, bytes);
  assert.equal(hash, plan.hash12(Buffer.from(bytes)));
  assert.equal(hash, room.hash12(bytes));
  const file = path.join(identity.roomDir(code), 'plans', `${hash}.md`);
  const m1 = fs.statSync(file).mtimeMs;
  assert.equal(plan.storeCanonical(code, Buffer.from(bytes)), hash);
  assert.equal(fs.statSync(file).mtimeMs, m1, 'not rewritten');
  assert.ok(Buffer.isBuffer(plan.canonical(code, hash)));
  assert.equal(plan.canonical(code, hash).toString('utf8'), bytes);
  assert.equal(plan.canonical(code, '000000000000'), null);
  assert.equal(plan.canonical(code, '../../x'), null);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${hash}.md`], 'no temp files left');
});

test('plan: editSummary is a short line diff', () => {
  const a = '# Plan\none\ntwo\nthree\nfour\n';
  const b = '# Plan\none\nTWO\nthree\nfour\nfive\n';
  const d = plan.editSummary(a, b);
  assert.match(d, /^@@ line 3/);
  assert.match(d, /^- two$/m);
  assert.match(d, /^\+ TWO$/m);
  assert.match(d, /^\+ five$/m);
  assert.ok(!/^[-+] one$/m.test(d));
  assert.equal(plan.editSummary(a, a), '(no changes)');
  const big = plan.editSummary('x\n'.repeat(5000), 'y\n'.repeat(5000));
  assert.ok(big.length <= 2000, String(big.length));
});
