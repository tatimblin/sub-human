import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from './entries.js';
import { decodeDoc, decodeEntry, decodeSnapshot } from './schema.js';

const envelope = { seq: 3, id: 'e3', at: 1700, prev: 'h2', from: 'ann', by: 'person', machine: 'm1' };
const ok: readonly Record<string, unknown>[] = [
  { kind: 'joined', repo: 'web', branch: 'main' },
  { kind: 'left' },
  { kind: 'activity', event: 'commit', text: 'change listTasks shape' },
  { kind: 'finding', text: 'the flaky test is a timezone bug' },
  { kind: 'post', text: 'rebase on main', to: 'bob' },
  { kind: 'plan', name: 'api', version: 1, hash: 'abc', base: 0, scope: 'group' },
  { kind: 'plan_ask', name: 'api', version: 1, people: ['bob'] },
  { kind: 'plan_answer', name: 'api', version: 1, answer: 'changes', note: 'cursor paging' },
  { kind: 'decision', name: 'api', version: 1, agreed: ['bob'], changes: [] },
  { kind: 'plan_sent', name: 'mine', version: 1, files: ['a.ts'] },
  { kind: 'plan_accept', name: 'mine', version: 1, answer: 'accept' },
  { kind: 'task', task: { n: 1, title: 'paging', status: 'open', addedBy: 'ann', blockedBy: [] } },
  { kind: 'invite', invite: 'i1', name: 'bob', expires: 9 },
  { kind: 'admit', invite: 'i1', name: 'bob', link: 'k1' },
  { kind: 'kick', name: 'bob' },
];

test('every kind decodes, and unknown fields are dropped, not refused', () => {
  const kinds = new Set<Entry['kind']>();
  for (const body of ok) {
    const r = decodeEntry({ ...envelope, ...body, future: { x: 1 } });
    assert.ok(r.ok, `${String(body['kind'])}: ${r.ok ? '' : r.error}`);
    assert.equal('future' in r.value, false);
    kinds.add(r.value.kind);
  }
  assert.equal(kinds.size, 15);
});

test('malformed entries are refused with the field named', () => {
  const bad: [unknown, RegExp][] = [
    [{ ...envelope, kind: 'nope' }, /kind/],
    [{ ...envelope, kind: 'finding' }, /text/],
    [{ ...envelope, seq: 0, kind: 'left' }, /seq/],
    [{ ...envelope, seq: 1.5, kind: 'left' }, /seq/],
    [{ ...envelope, by: 'root', kind: 'left' }, /by/],
    [{ ...envelope, from: '', kind: 'left' }, /from/],
    [{ ...envelope, from: 'x'.repeat(65), kind: 'left' }, /from/],
    [{ ...envelope, kind: 'post', text: 'hi', to: 7 }, /to/],
    [{ ...envelope, kind: 'plan_answer', name: 'api', version: 1, answer: 'yes' }, /answer/],
    [{ ...envelope, kind: 'task', task: { n: 1, title: 't', status: 'open', addedBy: 'ann' } }, /task\.blockedBy/],
    [{ ...envelope, kind: 'finding', text: 'x'.repeat(8001) }, /text/],
    [{ ...envelope, kind: 'joined', repo: undefined }, /repo/],
    [null, /./], ['line', /./], [[], /./],
  ];
  for (const [input, field] of bad) {
    const r = decodeEntry(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.ok ? '' : r.error, field);
  }
});

test('documents decode by kind', () => {
  assert.ok(decodeDoc('presence', { name: 'ann', state: 'working', at: 1 }).ok);
  assert.ok(decodeDoc('activity', { name: 'ann', files: ['a.ts'], at: 1 }).ok);
  assert.ok(decodeDoc('focus', { name: 'ann', text: 'paging', branch: 'feat', at: 1 }).ok);
  assert.equal(decodeDoc('presence', { name: 'ann', state: 'asleep', at: 1 }).ok, false);
  assert.equal(decodeDoc('activity', { name: 'ann', at: 1 }).ok, false);
  const focus = decodeDoc('focus', { name: 'ann', text: 'paging', at: 1 });
  assert.ok(focus.ok);
  assert.equal(focus.value.text, 'paging'); // typed as a FocusDoc
});

test('a snapshot of another version, or with a bad state, is refused', () => {
  const state = { seq: 0, hash: '', members: [], plans: [], sent: [], tasks: [], recent: [] };
  assert.ok(decodeSnapshot({ v: 1, state }).ok);
  assert.equal(decodeSnapshot({ v: 2, state }).ok, false);
  assert.equal(decodeSnapshot({ v: 1, state: { ...state, tasks: [{ n: 1 }] } }).ok, false);
  assert.equal(decodeSnapshot({ v: 1, state: { ...state, recent: [{ ...envelope, kind: 'kick', name: 'x' }] } }).ok, false);
});

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2 ** 32; };
}

function randomJson(r: () => number, depth: number): unknown {
  const keys = ['kind', 'seq', 'state', 'task', 'name', 'v', '__proto__', 'constructor', 'members', 'text'];
  const k = Math.floor(r() * (depth > 3 ? 5 : 8));
  switch (k) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return [0, -1, 1.5, 2 ** 53, Number.NaN, Infinity][Math.floor(r() * 6)];
    case 3: return ['', 'joined', 'task', 'x'.repeat(9000)][Math.floor(r() * 4)];
    case 4: return undefined;
    case 5: return Array.from({ length: Math.floor(r() * 4) }, () => randomJson(r, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(r() * 5) }, () => [keys[Math.floor(r() * keys.length)], randomJson(r, depth + 1)]));
  }
}

test('decoders never throw on random JSON or on valid entries with a field changed', () => {
  const r = rng(7);
  const valid = ok.map(b => ({ ...envelope, ...b }));
  const proto: unknown = JSON.parse('{"__proto__":{"kind":"left"},"kind":"x"}');
  for (let i = 0; i < 3000; i++) {
    const junk = randomJson(r, 0);
    const base = valid[i % valid.length] ?? {};
    const field = Object.keys(base)[Math.floor(r() * Object.keys(base).length)] ?? 'kind';
    const mutated = { ...base, [field]: junk };
    for (const input of [junk, mutated, proto]) {
      assert.doesNotThrow(() => {
        decodeEntry(input);
        decodeSnapshot(input);
        decodeSnapshot({ v: 1, state: input });
        decodeDoc('presence', input);
      });
    }
  }
});
