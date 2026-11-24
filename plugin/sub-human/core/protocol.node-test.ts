// core/protocol.ts: every message round-trips on the side that reads it; unknown fields are dropped and unknown types
// skipped; malformed ones are refused; negotiate() picks a shared version and caps or names who must update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeToHost, decodeToLink, encode, hello, negotiate, skewLine, VERSION } from './protocol.js';
import type { Hello, Message, Ping, Pong, PutDoc, ToHost, ToLink } from './protocol.js';
import type { Post, Snapshot } from './entries.js';
import { EMPTY } from './fold.js';

const entry: Post = { seq: 41, id: 'c-1', at: 5, prev: 'h40', from: 'jess', by: 'person', machine: 'jess-laptop', kind: 'post', text: 'hi', to: 'tristan' };
const { seq: _s, at: _a, prev: _p, machine: _m, ...draft } = entry;
const snapshot: Snapshot = { v: 1, state: { ...EMPTY, seq: 40, hash: 'h40' } };
const both: (Hello | Ping | Pong | PutDoc | Message)[] = [
  hello('jess', 'jess-laptop'),
  { t: 'ping', n: 3 },
  { t: 'pong', n: 3 },
  { t: 'put_doc', id: 'd1', key: 'presence/jess', doc: { state: 'working' } },
  { t: 'put_doc', id: 'd2', key: 'focus/jess', doc: null },
  { t: 'message', to: 'tristan.vole-8126', from: 'jess', text: 'the listTasks shape changed' },
];
const toHost: ToHost[] = [
  ...both,
  { t: 'append', entry: draft },
  { t: 'put_blob', id: 'b1', hash: 'sha256-abc', text: '# plan' },
  { t: 'subscribe', after_seq: 0, hash: '' },
  { t: 'call', id: 'q1', req: { op: 'task', code: 'vole-8126', from: 'jess', act: 'claim', n: 2 } },
];
const toLink: ToLink[] = [
  ...both,
  { t: 'ack', id: 'c-1' },
  { t: 'answer', id: 'q1', value: { seq: 9, hash: 'h9', n: 2 } },
  { t: 'put_blob', id: 'b2', hash: 'sha256-abc', text: '# plan' },
  { t: 'refused', id: 'c-1', reason: 'not a member of this link' },
  { t: 'snapshot', snapshot },
  { t: 'lines', lines: [{ entry, hash: 'h41' }] },
  { t: 'bye', reason: 'kicked' },
];

test('round trips: each message decodes to itself on the side that reads it', () => {
  for (const m of toHost) assert.deepEqual(decodeToHost(encode(m)), { ok: true, value: m }, m.t);
  for (const m of toLink) assert.deepEqual(decodeToLink(encode(m)), { ok: true, value: m }, m.t);
});

test('tolerance: unknown fields are dropped, in entries too; an unknown type is null; a new bye reason is closed', () => {
  assert.deepEqual(decodeToHost('{"t":"ping","n":1,"later":true}'), { ok: true, value: { t: 'ping', n: 1 } });
  const r = decodeToHost(JSON.stringify({ t: 'append', entry: { ...entry, later: 1 }, extra: 1 }));
  assert.deepEqual(r, { ok: true, value: { t: 'append', entry: draft } }, 'the host\'s stamps a writer sent come off');
  assert.deepEqual(decodeToLink('{"t":"presence_v9","x":1}'), { ok: true, value: null });
  assert.deepEqual(decodeToHost(JSON.stringify({ t: 'snapshot', snapshot })), { ok: true, value: null }, 'not the host\'s to read');
  assert.deepEqual(decodeToLink('{"t":"bye","reason":"moved"}'), { ok: true, value: { t: 'bye', reason: 'closed' } });
});

test('malformed messages are refused with a reason', () => {
  for (const bad of [
    'not json', '[]', '{"n":1}', '{"t":7}',
    '{"t":"ping","n":-1}', '{"t":"ping"}',
    '{"t":"append","id":"","entry":{"from":"jess","by":"person","kind":"post"}}',
    '{"t":"append","id":"c","entry":{"from":"jess","by":"root","kind":"post"}}',
    '{"t":"subscribe","after_seq":1.5,"hash":""}',
    '{"t":"hello","version":0,"min":0,"caps":[],"name":"a","machine":"b"}',
    '{"t":"call","id":"q","req":{"op":"status"}}',
    '{"t":"call","id":"q","req":{"op":"kick","code":"vole-8126","from":"jess","name":"tristan"}}',
  ]) {
    const r = decodeToHost(bad);
    assert.ok(!r.ok, bad);
    assert.ok(r.error.length > 0);
  }
  for (const bad of [
    JSON.stringify({ t: 'snapshot', snapshot: { v: 2, state: snapshot.state } }),
    JSON.stringify({ t: 'lines', lines: [{ entry: { ...entry, kind: 'nope' }, hash: 'h41' }] }),
    JSON.stringify({ t: 'lines', lines: [{ entry, hash: '' }] }),
  ]) assert.ok(!decodeToLink(bad).ok, bad);
});

const peer = (version: number, min: number, caps: string[] = []): Hello => ({ t: 'hello', version, min, caps, name: 'tristan', machine: 'devbox' });

test('negotiate: the highest shared version and the shared caps; on a skew, the side behind updates (R33)', () => {
  assert.deepEqual(negotiate(hello('jess', 'laptop'), hello('tristan', 'devbox')), { ok: true, version: VERSION, caps: [] });
  assert.deepEqual(negotiate(peer(3, 1, ['a', 'b']), peer(2, 2, ['b', 'c'])), { ok: true, version: 2, caps: ['b'] });
  assert.deepEqual(negotiate(peer(2, 1), peer(4, 3)), { ok: false, update: 'me' });
  assert.deepEqual(negotiate(peer(4, 3), peer(2, 1)), { ok: false, update: 'them' });
  assert.deepEqual(negotiate(peer(3, 1), peer(2, 5)), { ok: false, update: 'them' }, 'an impossible hello');
  assert.deepEqual(negotiate(peer(2, 5), peer(3, 1)), { ok: false, update: 'me' });
  assert.match(skewLine('me', 'tristan'), /Your sub-human .*tristan.*\/plugin update sub-human/);
  assert.match(skewLine('them', 'jess'), /^jess runs an older sub-human/);
});
