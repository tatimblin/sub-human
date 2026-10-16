import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snap } from '../snap.ts';
import type { LogEntry, LogExcerpt, SnapRecord } from '../snap.ts';
import { build, isNoise, classify, freshLines, capLines, mergePanes } from '../walkthrough.ts';
import type { Line } from '../walkthrough.ts';
import { opts, KEY_BYTES } from '../demo-lib.ts';

/** A pane line with only its text (and red) given. */
const L = (text: string, red = false): Line => ({ text, html: '', red, row: false });

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'sh-viz-')); }
const cap = (t: string) => ({ text: t, cols: 60, rows: 6 });
const entry = (id: number, kind: string, from: string, text: string): LogEntry => ({ id, at: new Date(1e12 + id * 1000).toISOString(), from, via: 'human', kind, to: 'room', text, hash: 'x', prev: 'y' });

test('snap: writes svg + txt, appends index, log excerpt since the previous scene, steps get own files', () => {
  const dir = tmp();
  const log = [entry(1, 'member_joined', 'alice', 'joined')];
  snap('sh-claude', 'S1', 'open', { dir, capture: cap('\x1b[1mroom\x1b[0m otter-4821\n'), room: 'otter-4821', entries: log });
  snap('sh-alice', 'S1', 'open', { dir, capture: cap('alice\n'), room: 'otter-4821', entries: log });
  log.push(entry(2, 'say', 'alice', 'hi <b>'), entry(3, 'say', 'bob', 'yo'));
  snap('sh-claude', 'S4', 'alice posts', { dir, capture: cap('x\n'), room: 'otter-4821', entries: log });
  snap('sh-claude', 'S4', 'bob posts', { dir, capture: cap('y\n'), room: 'otter-4821', entries: log });

  const idx: SnapRecord[] = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const logOf = (r: SnapRecord): LogExcerpt[] => r.log ?? [];
  assert.equal(idx.length, 4);
  assert.deepEqual(idx.map(r => r.svg), ['S1-sh-claude.svg', 'S1-sh-alice.svg', 'S4-sh-claude.svg', 'S4-2-sh-claude.svg']);
  assert.deepEqual(logOf(idx[0]).map(e => e.id), [1]);
  assert.deepEqual(logOf(idx[1]).map(e => e.id), [1]);   // same scene: same window
  assert.deepEqual(logOf(idx[2]).map(e => e.id), [2, 3]); // only entries after S1
  assert.equal(Reflect.get(logOf(idx[2])[0], 'hash'), undefined);         // chain fields dropped from excerpts
  assert.equal(fs.readFileSync(path.join(dir, 'S1-sh-claude.txt'), 'utf8'), 'room otter-4821\n');
  assert.match(fs.readFileSync(path.join(dir, 'S1-sh-claude.svg'), 'utf8'), /claude · S1/);
});

test('walkthrough: one section per scene in plan order, text excerpts, checks and log rendered', () => {
  const dir = tmp();
  const log = [entry(1, 'member_joined', 'alice', 'joined')];
  for (const s of ['sh-bob', 'sh-claude', 'sh-alice']) snap(s, 'S2', 'alice joins', { dir, capture: cap(`\x1b[32m${s} pane says hello\x1b[0m\n`), room: 'r', entries: log });
  log.push(entry(2, 'say', 'alice', 'cursor <paging> & "x"\nsecond line'), entry(3, 'say', 'bob', ''));
  snap('sh-claude', 'S11b', 'nested', { dir, capture: cap('nested work\n'), room: 'r', entries: log });
  snap('sh-claude', 'S10', 'work', { dir, capture: cap('working on it\n'), room: 'r', entries: log });
  fs.writeFileSync(path.join(dir, 'waits.jsonl'), [
    { scene: 'S2', what: 'log: 1× member_joined', ok: true, ms: 1200 },
    { scene: 'S2', what: 'bob idle', ok: false, ms: 30000 },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({ S2: [{ check: 'member_joined', pass: true, evidence: '#1 ' + 'e'.repeat(300) }], S10: [{ check: 'status cites evidence', pass: false, evidence: 'none' }], _meta: { cost: '$1.20' } }));
  const out = path.join(dir, 'w.html');
  const r = build({ screens: dir, checksFile: checks, out });
  const html = fs.readFileSync(out, 'utf8');
  assert.equal(r.scenes, 3);
  assert.equal(r.pass, 1); assert.equal(r.fail, 1);
  const order = ['id="S2"', 'id="S10"', 'id="S11b"'].map(s => html.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'plan order');
  // panes ordered room Claude, alice, bob, as text excerpts with palette classes
  const s2 = html.slice(html.indexOf('id="S2"'), html.indexOf('id="S10"'));
  const seats = [...s2.matchAll(/<figcaption>(\w+)<\/figcaption>/g)].map(m => m[1]);
  assert.deepEqual(seats, ['claude', 'alice', 'bob']);
  assert.match(s2, /<figure class="term"><figcaption>claude<\/figcaption><pre><i class=a>sh-claude pane says hello<\/i><\/pre>/);
  assert.match(html, /\.term i\.a\{color:#98c379\}/);
  assert.doesNotMatch(html, /<svg/i, 'no svg in the page');
  assert.doesNotMatch(html, /<script/i, 'no scripts');
  // log: one compact line per entry, escaped, real newlines kept, empty text omitted
  assert.match(html, /#2 alice\/human say cursor &lt;paging&gt; &amp; "x"\nsecond line/);
  assert.match(html, /#3 bob\/human say\n|#3 bob\/human say<\/pre>/);
  assert.match(html, /<b>PASS<\/b> member_joined<small>#1 e+…<\/small>/);
  assert.ok(((html.match(/<small>(#1 e+…)<\/small>/) ?? [])[1] ?? '').length <= 160, 'evidence clipped');
  assert.match(html, /<b>FAIL<\/b> status cites evidence/);
  assert.match(html, /run cost \$1.20/);
  assert.match(html, /1\/2 driver waits met<br><span class="fail">✗ bob idle/);
  assert.doesNotMatch(html, /log: 1× member_joined/, 'met waits are not listed');
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /--term-bg:/);
  assert.match(html, /docs\/rebuild\/screens locally/);
  assert.doesNotMatch(html, /<(link|script)[^>]+(src|href)=/i, 'no external resources');
});

test('walkthrough excerpt: new lines only, noise dropped, unchanged chip, rows strip, merged panes, pages', () => {
  const dir = tmp();
  const status = '  \u23f5\u23f5 auto mode on · 1 monitor';
  const screen = (body: string[], rows: string[]) => cap([
    ' \u2590\u259b\u2588\u2588\u2588\u259c\u258c   Claude Code v2.1.0', '\u26a0 1 MCP server needs authentication · run /mcp',
    ...body, '\u273b Waiting for 2 background agents to finish', '\u2500'.repeat(40), '\u276f ', status, ...rows,
  ].join('\n') + '\n');
  const s = (sess: string, scene: string, caption: string, body: string[], rows: string[]) => snap(sess, scene, caption, { dir, capture: screen(body, rows), room: 'r', entries: [] });
  s('sh-alice', 'S1', 'start', ['\u23fa hello from alice'], ['  \u25ef room  1 here']);
  s('sh-bob', 'S1', 'start', ['\u23fa hello from alice'], ['  \u25ef room  1 here']);
  // S2: alice unchanged but a new row; bob unchanged
  s('sh-alice', 'S2', 'rows move', ['\u23fa hello from alice'], ['  \u25ef room  +bob joined · 2 here']);
  s('sh-bob', 'S2', 'rows move', ['\u23fa hello from alice'], ['  \u25ef room  1 here']);
  // S3: paginated steps, 14 new lines on the last page
  s('sh-alice', 'S3', 'reads page 1', ['\u23fa page one text'], []);
  s('sh-alice', 'S3', 'reads page 2', ['\u23fa page two text'], []);
  s('sh-alice', 'S3', 'reads page 3', Array.from({ length: 14 }, (_, i) => `line number ${i + 1} of the page`), []);
  const checks = path.join(dir, 'checks.json');
  fs.writeFileSync(checks, '{}');
  const out = path.join(dir, 'w.html');
  build({ screens: dir, checksFile: checks, out });
  const html = fs.readFileSync(out, 'utf8');
  const sec = (id: string): string => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</section>', html.indexOf(`id="${id}"`)));
  // S1: identical panes merge; noise (banner, MCP auth, waiting, rules, empty prompt, status bar) is gone
  assert.match(sec('S1'), /<figcaption>alice = bob<\/figcaption>/);
  assert.doesNotMatch(html, /Claude Code v|MCP server needs|Waiting for|auto mode on|\u2500{20}/);
  // S2: row-only change becomes a rows strip; nothing new becomes a chip
  assert.match(sec('S2'), /<span class="chip rows"><b>alice<\/b> rows: \u25ef room  \+bob joined · 2 here<\/span>/);
  assert.match(sec('S2'), /<span class="chip">bob: unchanged<\/span>/);
  assert.doesNotMatch(sec('S2'), /<figure/);
  // S3: one shown step (the final page) with the page count; capped at 3 + elision + 6
  assert.equal((sec('S3').match(/<p class="caption">/g) || []).length, 1);
  assert.match(sec('S3'), /reads page 3<span class="pages">\(final page; \+2 more pages\)/);
  const pre = ((sec('S3').match(/<pre>([\s\S]*?)<\/pre>/) ?? [])[1] ?? '').split('\n');
  assert.equal(pre.length, 10);
  assert.match(pre[3], /… 5 lines …/);
  assert.match(pre[0], /line number 1 /); assert.match(pre[9], /line number 14 /);
});

test('walkthrough excerpt rules: noise, plan view body, red lines kept through the cap', () => {
  for (const l of ['  \u23fa Ran 1 stop hook', '  \u23bf  Tip: use /plan', '\u00b7 Thinking\u2026', '\u276f', '  \u23f8 plan mode on', 'Update available! Run: brew upgrade',
    '\u2500\u2500\u2500\u2500 bob.room-1 \u2500', '  \u23bf  Allowed by PermissionRequest hook', 'ok', '\u23fa', '\u25d0 medium \u00b7 /effort']) assert.ok(isNoise(l), l);
  for (const l of ['\u23fa alice: hi bob', '  \u2502 bob agreed to the proposal', '  \u23bf  Stop hook error: sub-human: review open']) assert.ok(!isNoise(l), l);
  const plan = ['\u23fa Entered plan mode', '\u2594\u2594\u2594\u2594\u2594\u2594', '   Ready to code?', "   Here is Claude's plan:", '  \u254c\u254c\u254c\u254c\u254c\u254c',
    '   Plan: cursor paging', '   Context and more body', '   - body bullet', '  \u254c\u254c\u254c\u254c\u254c\u254c', '   \u2502 room proposal abc from claude',
    '  \u2500\u2500\u2500\u2500\u2500\u2500', '   Would you like to proceed?', '   \u276f 1. Yes, and use auto mode', '     2. Yes, manually approve edits'];
  const info = classify(plan);
  assert.deepEqual(plan.filter((_, i) => info[i].drop), ['   Context and more body', '   - body bullet', '   \u276f 1. Yes, and use auto mode', '     2. Yes, manually approve edits']);
  const f = freshLines(plan.map(t => ({ text: t, html: t })), null).lines.map(l => l.text);
  assert.deepEqual(f, ['   Plan: cursor paging', '   \u2502 room proposal abc from claude']);
  // previous capture's lines (as a multiset) are not new; a repeat beyond the old count is
  const prev = freshLines([{ text: 'same line here', html: '' }], null).bag;
  assert.deepEqual(freshLines([{ text: 'same line here', html: '' }, { text: 'brand new line', html: '' }, { text: 'same line here', html: '' }], prev).lines.map(l => l.text), ['brand new line', 'same line here']);
  const lines = Array.from({ length: 20 }, (_, i) => L('l' + i, i === 10));
  const c = capLines(lines);
  assert.deepEqual(c.map(l => ('elided' in l ? '…' + l.elided : l.text)), ['l0', 'l1', 'l2', '…7', 'l10', '…3', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19']);
  const m = mergePanes([{ seat: 'alice', lines: ['a1', 'a2', 'a3', 'a4', 'a5'].map(t => L(t)) }, { seat: 'bob', lines: ['a1', 'a2', 'a3', 'a4', 'b5'].map(t => L(t)) }]);
  assert.deepEqual(m.map(p => p.seat), ['alice = bob']);
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

test('demo-lib: every key demo.sh sends is a known key (S8 died on "unknown key C-e", run moose-8575)', () => {
  const sh = fs.readFileSync(path.join(import.meta.dirname, '..', 'demo.sh'), 'utf8');
  const sent: string[] = [];
  for (const line of sh.split('\n')) {
    for (const m of line.replace(/#.*$/, '').matchAll(/\bkeys\s+("?\$?[\w-]+"?)((?:\s+[A-Za-z][\w-]*)+)/g)) {
      if (m[1] === 'sh-keys') continue;
      sent.push(...m[2].trim().split(/\s+/));
    }
  }
  assert.ok(sent.includes('C-e') && sent.includes('PageDown'), `parsed keys: ${sent.join(' ')}`);
  const unknown = sent.filter(k => !(k in KEY_BYTES) && k.length !== 1);
  assert.deepEqual(unknown, []);
});
