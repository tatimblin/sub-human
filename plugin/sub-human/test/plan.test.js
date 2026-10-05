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

test('plan: body', () => {
  assert.equal(plan.body(FM({}) + 'hello'), 'hello');
  assert.equal(plan.body('no fm'), 'no fm');
  assert.equal(plan.isStub, undefined, 'review stubs are gone');
  assert.equal(plan.stubFor, undefined);
  assert.equal(plan.editSummary, undefined);
});

test('plan: summary skips frontmatter, the notice and blanks, strips markers, clips lines', () => {
  const text = FM({ room: 'otter-4821', approval: 'all', approvers: ['alice'] }) + plan.PLAN_NOTICE + '\n\n# GET /tasks paging\n\n- cursor  paging,\tbare array\n- [ ] max 50\n> quote\n';
  assert.equal(plan.summary(text), 'GET /tasks paging\ncursor paging, bare array\nmax 50');
  assert.equal(plan.summary(text, 1), 'GET /tasks paging');
  assert.equal(plan.summary(Buffer.from(text), 2), 'GET /tasks paging\ncursor paging, bare array');
  assert.equal(plan.summary(text, 0), '');
  const withSummary = `---\nsub-human: ${JSON.stringify({ room: 'otter-4821', summary: 'One-line pitch' })}\n---\n# Title\n`;
  assert.equal(plan.summary(withSummary, 2), 'One-line pitch\nTitle');
  const long = plan.summary('# ' + 'x'.repeat(500));
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(plan.summary(''), '');
});

test('plan: planPath is <roomDir>/plans/<hash>.md', () => {
  h.freshHome();
  const code = h.newRoom();
  assert.equal(plan.planPath(code, 'abcdef012345'), path.join(identity.roomDir(code), 'plans', 'abcdef012345.md'));
  const hash = plan.storeCanonical(code, 'x');
  assert.equal(fs.readFileSync(plan.planPath(code, hash), 'utf8'), 'x');
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

test('plan: PLAN_NOTICE must be the first non-blank body line; orchestrator.md carries it verbatim', t => {
  const fm = FM({ room: 'otter-4821', approval: 'all', approvers: ['alice'] });
  assert.equal(plan.PLAN_NOTICE, "> **Room plan. Each approver signs off in the form the room shows them; nobody's Claude runs it.**");
  assert.equal(plan.hasNotice(fm + plan.PLAN_NOTICE + '\n# Plan\n'), true);
  assert.equal(plan.hasNotice(fm + '\n' + plan.PLAN_NOTICE + '  \n# Plan\n'), true);
  assert.equal(plan.hasNotice(fm + plan.PLAN_NOTICE), true);
  assert.equal(plan.hasNotice(fm + '# Plan\n' + plan.PLAN_NOTICE + '\n'), false, 'not first');
  assert.equal(plan.hasNotice(fm + plan.PLAN_NOTICE.replace('Each', 'One') + '\n'), false, 'altered');
  assert.equal(plan.hasNotice(fm), false);
  const orch = fs.readFileSync(path.join(h.PLUGIN, 'skills', 'sub-human', 'orchestrator.md'), 'utf8');
  // Parallel rebuild: D owns orchestrator.md. Skip only while it still carries the old (dialog) notice.
  if (orch.includes('manually approve edits')) return t.skip('orchestrator.md still has the pre-rebuild notice (owner D)');
  assert.ok(orch.includes('---\n' + plan.PLAN_NOTICE + '\n'), 'orchestrator.md template has the notice right after the frontmatter');
});
