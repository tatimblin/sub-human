'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snap } = require('../snap.js');
const { build } = require('../walkthrough.js');
const { opts, KEY_BYTES } = require('../demo-lib.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sh-viz-')); }
const cap = t => ({ text: t, cols: 60, rows: 6 });
const entry = (id, kind, from, text) => ({ id, at: new Date(1e12 + id * 1000).toISOString(), from, via: 'human', kind, to: 'room', text, hash: 'x', prev: 'y' });

test('snap: writes svg + txt, appends index, log excerpt since the previous scene, steps get own files', () => {
  const dir = tmp();
  const log = [entry(1, 'member_joined', 'alice', 'joined')];
  snap('sh-orch', 'S1', 'open', { dir, capture: cap('\x1b[1mroom\x1b[0m otter-4821\n'), room: 'otter-4821', entries: log });
  snap('sh-alice', 'S1', 'open', { dir, capture: cap('alice\n'), room: 'otter-4821', entries: log });
  log.push(entry(2, 'say', 'alice', 'hi <b>'), entry(3, 'say', 'bob', 'yo'));
  snap('sh-orch', 'S4', 'alice posts', { dir, capture: cap('x\n'), room: 'otter-4821', entries: log });
  snap('sh-orch', 'S4', 'bob posts', { dir, capture: cap('y\n'), room: 'otter-4821', entries: log });

  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.length, 4);
  assert.deepEqual(idx.map(r => r.svg), ['S1-sh-orch.svg', 'S1-sh-alice.svg', 'S4-sh-orch.svg', 'S4-2-sh-orch.svg']);
  assert.deepEqual(idx[0].log.map(e => e.id), [1]);
  assert.deepEqual(idx[1].log.map(e => e.id), [1]);   // same scene: same window
  assert.deepEqual(idx[2].log.map(e => e.id), [2, 3]); // only entries after S1
  assert.equal(idx[2].log[0].hash, undefined);         // chain fields dropped from excerpts
  assert.equal(fs.readFileSync(path.join(dir, 'S1-sh-orch.txt'), 'utf8'), 'room otter-4821\n');
  assert.match(fs.readFileSync(path.join(dir, 'S1-sh-orch.svg'), 'utf8'), /orch · S1/);
});

test('walkthrough: one section per scene in plan order, panes inlined, checks and log rendered', () => {
  const dir = tmp();
  const log = [entry(1, 'member_joined', 'alice', 'joined')];
  for (const s of ['sh-bob', 'sh-orch', 'sh-alice']) snap(s, 'S2', 'alice joins', { dir, capture: cap(`\x1b[32m${s}\x1b[0m\n`), room: 'r', entries: log });
  log.push(entry(2, 'say', 'alice', 'cursor <paging> & "x"'));
  snap('sh-orch', 'S11b', 'nested', { dir, capture: cap('n\n'), room: 'r', entries: log });
  snap('sh-orch', 'S10', 'work', { dir, capture: cap('w\n'), room: 'r', entries: log });
  fs.writeFileSync(path.join(dir, 'waits.jsonl'), JSON.stringify({ scene: 'S2', what: 'log: 1× member_joined', ok: true, ms: 1200 }) + '\n');
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({ S2: [{ check: 'member_joined', pass: true, evidence: '#1' }], S10: [{ check: 'status cites evidence', pass: false, evidence: 'none' }], _meta: { cost: '$1.20' } }));
  const out = path.join(dir, 'w.html');
  const r = build({ screens: dir, checksFile: checks, out });
  const html = fs.readFileSync(out, 'utf8');
  assert.equal(r.scenes, 3);
  assert.equal(r.pass, 1); assert.equal(r.fail, 1);
  const order = ['id="S2"', 'id="S10"', 'id="S11b"'].map(s => html.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'plan order');
  // panes ordered orch, alice, bob and inlined without fixed size
  const s2 = html.slice(html.indexOf('id="S2"'), html.indexOf('id="S10"'));
  const seats = [...s2.matchAll(/<figcaption>(\w+)<\/figcaption>/g)].map(m => m[1]);
  assert.deepEqual(seats, ['orch', 'alice', 'bob']);
  assert.equal((s2.match(/<svg/g) || []).length, 3);
  assert.doesNotMatch(s2, /<svg[^>]*\swidth="/);
  assert.match(html, /cursor &lt;paging&gt; &amp; &quot;x&quot;/);
  assert.match(html, /PASS<\/span><div><strong>member_joined/);
  assert.match(html, /FAIL<\/span><div><strong>status cites evidence/);
  assert.match(html, /run cost \$1.20/);
  assert.match(html, /Driver waits · 1\/1 met/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(html, /<(link|script)[^>]+(src|href)=/i, 'no external resources');
});

test('walkthrough: empty input still builds', () => {
  const dir = tmp();
  const r = build({ screens: dir, checksFile: path.join(dir, 'none.json'), out: path.join(dir, 'w.html') });
  assert.equal(r.scenes, 0);
  assert.match(fs.readFileSync(path.join(dir, 'w.html'), 'utf8'), /No captures yet/);
});

test('demo-lib: option parsing and raw key bytes', () => {
  assert.deepEqual(opts(['wait-log', '--kind', 'say', '--latest-plan', '--count', '2']), { _: ['wait-log'], kind: 'say', 'latest-plan': true, count: '2' });
  assert.equal(KEY_BYTES.Down, '\x1b[B');
  assert.equal(KEY_BYTES.Enter, '\r');
});
