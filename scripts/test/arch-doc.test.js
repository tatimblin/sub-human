'use strict';
// docs/ARCHITECTURE.md's generated sections must match the code: regenerate them in memory and compare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DOC, generate, render, firstSentence } = require('../arch-doc.js');

test('docs/ARCHITECTURE.md generated sections are current (run npm run docs)', async () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const sections = await generate();
  for (const name of ['hooks', 'mod-hooks', 'mcp-tools', 'cc-contract', 'lib-modules']) assert.ok(sections[name], name);
  assert.equal(render(doc, sections), doc, 'docs/ARCHITECTURE.md is stale: run npm run docs');
});

test('render replaces only between markers and is idempotent', () => {
  const doc = 'a\n<!-- gen:x -->\nold\n<!-- /gen:x -->\nb\n';
  const once = render(doc, { x: 'new' });
  assert.equal(once, 'a\n<!-- gen:x -->\nnew\n<!-- /gen:x -->\nb\n');
  assert.equal(render(once, { x: 'new' }), once);
  assert.throws(() => render('no markers', { x: 'new' }), /missing/);
});

test('firstSentence keeps e.g. inside a sentence and skips boilerplate', () => {
  assert.equal(firstSentence('Read it (e.g. a line); more. Second one.', 0), 'Read it (e.g. a line); more.');
  assert.equal(firstSentence('short. CommonJS, zero dependencies. Then this.'), 'short. Then this.');
});
