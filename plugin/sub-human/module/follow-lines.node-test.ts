// follow-lines.ts linesAfter: the log read by byte ranges, as follow.ts reads it, chain-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Head } from '../store/store.js';
import { MemoryStore } from '../store/memory-store.js';
import { linesAfter } from './follow-lines.js';

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

test('a line that does not follow the head is a fork', async () => {
  const lines = await log('one', 'two');
  const first = await linesAfter(`${lines[0]}\n`, START);
  assert.ok(first.ok);
  const r = await linesAfter(`${lines[1]}\n`, { ...first.value.head, hash: 'f'.repeat(64) });
  assert.ok(!r.ok && /^fork: .*seq 2/.test(r.error));
  const skipped = await linesAfter(`${lines[2]}\n`, first.value.head);
  assert.ok(!skipped.ok && /^fork/.test(skipped.error));
});

test('a tampered line breaks the chain at the line after it', async () => {
  const lines = await log('one', 'two');
  const tampered = [lines[0], (lines[1] ?? '').replace('"one"', '"0ne"'), lines[2]].map(l => `${l}\n`).join('');
  const r = await linesAfter(tampered, START);
  assert.ok(!r.ok && /seq 3/.test(r.error));
  assert.ok(!(await linesAfter('not json\n', START)).ok);
});
