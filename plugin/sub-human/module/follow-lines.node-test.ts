// follow-lines.ts: linesAfter, the log read by byte ranges as follow.ts reads it, chain-checked; absorb and the cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Head } from '../store/store.js';
import { MemoryStore } from '../test/support/memory-store.js';
import type { Me, State } from '../core/deliver.js';
import type { Entry, LogLine } from '../core/entries.js';
import { NO_DOCS } from '../core/entries.js';
import { fold } from '../core/fold.js';
import { DRAWN_MAX, absorb, freshCursor, toDraw, linesAfter, planTerms, unreadPlans } from './follow-lines.js';

const START: Head = { seq: 0, hash: '' };

/** A log of posts by bob, each text given, as the store writes it. */
async function log(...texts: string[]): Promise<string[]> {
  const s = new MemoryStore();
  await s.append({ kind: 'joined', id: 'j', at: 1, from: 'bob', by: 'system', machine: 'm' });
  for (const [i, text] of texts.entries()) await s.append({ kind: 'post', id: `p${i}`, at: 2, from: 'bob', by: 'person', machine: 'm', text });
  return s.room.lines;
}
const file = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(lines.map(l => `${l}\n`).join(''));

/** follow.ts's loop: read `size` bytes at the offset, take the complete lines, move on. */
async function readAll(bytes: Uint8Array, size: number): Promise<{ texts: string[]; head: Head }> {
  let head = START;
  let offset = 0;
  const texts: string[] = [];
  while (offset < bytes.length) {
    const r = await linesAfter(new TextDecoder().decode(bytes.slice(offset, offset + size)), head);
    assert.ok(r.ok, r.ok ? '' : r.error);
    if (r.value.bytes === 0) { size *= 2; continue; } // one line longer than a read: read more at once
    for (const l of r.value.lines) if (l.entry.kind === 'post') texts.push(l.entry.text);
    head = r.value.head;
    offset += r.value.bytes;
  }
  return { texts, head };
}

test('reads cut anywhere, inside a multibyte character too, give every line once, in order', async () => {
  const texts = ['café ☕ naïve', '日本語のテキスト', '🦦 otters 🦦', 'plain'];
  const lines = await log(...texts);
  const whole = await readAll(file(lines), 1 << 20);
  assert.deepEqual(whole.texts, texts);
  for (const size of [7, 13, 64, 101]) assert.deepEqual(await readAll(file(lines), size), whole, `reads of ${size} bytes`);
});

test('a torn last line is left for the next read, and the bytes counted stop before it', async () => {
  const lines = await log('one', 'two');
  const text = `${lines[0]}\n${lines[1]}\n${(lines[2] ?? '').slice(0, 20)}`;
  const r = await linesAfter(text, START);
  assert.ok(r.ok);
  assert.equal(r.value.head.seq, 2);
  assert.equal(r.value.bytes, new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n`).length);
});

test('a line that does not follow the head is a fork (R36)', async () => {
  const lines = await log('one', 'two');
  const first = await linesAfter(`${lines[0]}\n`, START);
  assert.ok(first.ok);
  const r = await linesAfter(`${lines[1]}\n`, { ...first.value.head, hash: 'f'.repeat(64) });
  assert.ok(!r.ok && /^fork: .*entry 2/.test(r.error));
  const skipped = await linesAfter(`${lines[2]}\n`, first.value.head);
  assert.ok(!skipped.ok && /^fork/.test(skipped.error));
});

test('a tampered line breaks the chain at the line after it', async () => {
  const lines = await log('one', 'two');
  const tampered = [lines[0], (lines[1] ?? '').replace('"one"', '"0ne"'), lines[2]].map(l => `${l}\n`).join('');
  const r = await linesAfter(tampered, START);
  assert.ok(!r.ok && /entry 3/.test(r.error));
  assert.ok(!(await linesAfter('not json\n', START)).ok);
});

// absorb: what one poll's lines and edits are for me
const joined = (from: string, at: number): Entry => ({ kind: 'joined', seq: at, id: `j${from}`, at, prev: '', from, by: 'system', machine: 'm' });
const finding = (from: string, text: string, at: number): Entry => ({ kind: 'finding', seq: at, id: `f${at}`, at, prev: '', from, by: 'claude', machine: 'm', text });
const lineOf = (entry: Entry): LogLine => ({ entry, hash: `h${entry.seq}` });
const ALICE: Me = { name: 'alice', code: 'otter-4821', touched: [{ path: 'src/a.js', at: 0 }], terms: [] };
const settled = (lines: readonly LogLine[]): State => ({ room: fold(null, lines, NO_DOCS), wakes: [], draws: [], bursts: {} });

test('absorb: context and a drawn line for what bears on me, the feed in order, and nothing held', () => {
  const lines = [lineOf(joined('alice', 1)), lineOf(joined('bob', 2)), lineOf(finding('bob', 'src/a.js changed', 3)), lineOf(finding('bob', 'lunch', 4))];
  const edited = [{ doc: { name: 'bob', files: ['src/b.js'], at: 5 } }, { doc: { name: 'alice', files: ['src/a.js'], at: 5 } }];
  const a = absorb(settled(lines), lines.slice(1), edited, ALICE, 10);
  assert.deepEqual(a.items.map(i => i.text), ['src/a.js changed']);
  assert.deepEqual(a.drawn, [{ line: "bob's Claude: src/a.js changed", value: 1, at: 3 }]);
  assert.equal(a.held, 0);
  assert.deepEqual(a.feed.map(f => (f.kind === 'entry' ? f.entry.kind : f.kind)), ['joined', 'finding', 'finding', 'edits']);
});

test('toDraw: the most valuable and newest first, three between prompts, then one line for the rest, once (R41)', () => {
  const d = (line: string, value: number, at: number) => ({ line, value, at });
  assert.equal(DRAWN_MAX, 3);
  const burst = [d('old note', 1, 1), d('new note', 1, 5), d('overlap', 3, 2), d('about me', 2, 3), d('another', 1, 4)];
  const first = toDraw(burst, 0);
  assert.deepEqual(first, { draw: ['overlap', 'about me', 'new note', 'sub-human: and 2 more: /sub-human news'], shown: 4 });
  assert.deepEqual(toDraw([d('later', 3, 9)], first.shown), { draw: [], shown: 4 }); // the rest went in the one line
  assert.deepEqual(toDraw([d('a', 1, 1), d('b', 1, 2)], 0), { draw: ['b', 'a'], shown: 2 });
  assert.deepEqual(toDraw([d('c', 1, 3), d('d', 1, 4)], 2), { draw: ['d', 'sub-human: and 1 more: /sub-human news'], shown: 4 });
});

test('freshCursor: each one its own, from the log\'s start', () => {
  const a = freshCursor();
  a.held.activity.set('x', { mtime: 1, doc: { name: 'x', files: [], at: 0 } });
  assert.deepEqual(freshCursor().head, START);
  assert.equal(freshCursor().held.activity.size, 0);
});

test('unreadPlans: the latest version of each plan I am on, once; planTerms: the terms read', () => {
  const v = (version: number, from: string, asked: string[]) => ({ version, hash: `h${version}${from}`, base: version - 1, from, at: 0, asked, answers: [] });
  const room = { ...fold(null, [], NO_DOCS), plans: [
    { name: 'mine', scope: 'group' as const, versions: [v(1, 'bob', ['alice']), v(2, 'bob', [])] },
    { name: 'theirs', scope: 'group' as const, versions: [v(1, 'bob', ['carol'])] },
  ] };
  assert.deepEqual(unreadPlans(room, 'alice', new Map()), ['h2bob']);
  const read = new Map([['h2bob', ['listTasks']]]);
  assert.deepEqual(unreadPlans(room, 'alice', read), []);
  assert.deepEqual(planTerms(room, read), ['listTasks']);
});
