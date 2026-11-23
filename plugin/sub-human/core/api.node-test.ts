// The socket API's shapes: what the daemon reads, and what a caller reads back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppendDraft } from './api.js';
import { daemonArgv, decodePointer, decodeRequest, readAnswer, refusedAppend, socketFile } from './api.js';

const ID = '0b9d6f3e-2c4a-4f1e-9a7b-5d8c1e2f3a4b';

test('an append\'s draft goes through the entry schema: the caller\'s id is kept, the host\'s stamps never survive', () => {
  const r = decodeRequest({ op: 'append', code: 'R', draft: { kind: 'post', id: ID, from: 'a', by: 'person', text: 'hi', seq: 9, at: 5, prev: 'p', machine: 'm' } });
  assert.deepEqual(r, { ok: true, value: { op: 'append', code: 'R', draft: { kind: 'post', id: ID, from: 'a', by: 'person', text: 'hi' } } });
  for (const id of [undefined, 'x', 7]) {
    const no = decodeRequest({ op: 'append', code: 'R', draft: { kind: 'post', id, from: 'a', by: 'person', text: 'hi' } });
    assert.ok(!no.ok && /^request not understood: draft\.id/.test(no.error), String(id));
  }
  const bad = decodeRequest({ op: 'append', code: 'R', draft: { kind: 'post', id: ID, from: 'a', by: 'person' } });
  assert.ok(!bad.ok && /^entry not understood: text/.test(bad.error));
});

test('who may append what: a post or finding is a Claude\'s, a person\'s post only theirs, a link\'s system entry only its membership (R35, R37)', () => {
  const d = (kind: 'post' | 'finding' | 'joined' | 'activity', by: AppendDraft['by']): AppendDraft => (kind === 'joined' ? { kind, id: ID, from: 'a', by }
    : kind === 'activity' ? { kind, id: ID, from: 'a', by, event: 'test', text: 't' } : { kind, id: ID, from: 'a', by, text: 't' });
  const rows: [AppendDraft, 'socket' | 'link', boolean, boolean][] = [
    [d('post', 'claude'), 'socket', false, true], [d('finding', 'claude'), 'link', false, true],
    [d('post', 'person'), 'socket', true, true], [d('post', 'person'), 'socket', false, false], [d('post', 'person'), 'link', false, true],
    [d('finding', 'person'), 'socket', true, false], [d('post', 'system'), 'socket', true, false], [d('finding', 'system'), 'link', false, false],
    [d('joined', 'system'), 'link', false, true], [d('activity', 'system'), 'link', false, false], [d('activity', 'system'), 'socket', false, true],
  ];
  for (const [draft, via, here, taken] of rows) assert.equal(refusedAppend(draft, via, here) === null, taken, `${draft.kind} by ${draft.by} from ${via}${here ? ', here' : ''}`);
});

test('a document is read by its kind and must be the named member\'s', () => {
  const doc = { name: 'a', text: 'paging', at: 1 };
  assert.ok(decodeRequest({ op: 'put_doc', code: 'R', kind: 'focus', name: 'a', doc }).ok);
  const other = decodeRequest({ op: 'put_doc', code: 'R', kind: 'focus', name: 'b', doc });
  assert.ok(!other.ok && /can't be stored as b's/.test(other.error));
  const members = decodeRequest({ op: 'put_doc', code: 'R', kind: 'members', name: 'a', doc: { members: [] } });
  assert.ok(!members.ok, 'the members document is the host\'s');
});

test('an unknown op, a missing field and an empty code are refused', () => {
  for (const q of [{ op: 'drop' }, { op: 'ping' }, { op: 'put_blob', code: '', text: '' }, null, 'status']) {
    const r = decodeRequest(q);
    assert.ok(!r.ok && r.error.startsWith('request not understood'), JSON.stringify(q));
  }
  assert.deepEqual(decodeRequest({ op: 'status', extra: 1 }), { ok: true, value: { op: 'status' } });
});

test('a session id must be safe as a file name', () => {
  const p = { code: 'R', name: 'a', title: 'a.R', leave: '7d9c2a1e-4b3f-4c5d-8e6f-0a1b2c3d4e5f' };
  const join = { op: 'join', id: '0b9d6f3e-2c4a', cwd: '/w', name: 'a', leave: p.leave };
  assert.ok(decodeRequest(join).ok);
  assert.ok(!decodeRequest({ ...join, leave: 'x' }).ok, 'a pointer carries its leave id');
  assert.ok(!decodeRequest({ ...join, code: 'R' }).ok, 'a room asked for is a room code');
  assert.ok(!decodeRequest({ op: 'claim', id: '../x', cwd: '/w' }).ok);
  assert.deepEqual(decodePointer(JSON.stringify(p)), p);
  for (const id of ['../x', '', 'a/b', 'x'.repeat(129)]) assert.ok(!decodeRequest({ op: 'retire', id }).ok, id);
  assert.equal(decodePointer('{"code":"R"}'), null);
  assert.equal(decodePointer('not json'), null);
});

test('plan and task requests are read by their act', () => {
  const edit = { op: 'plan', code: 'R', from: 'a', act: 'edit', name: 'p', base: 0, text: '# p' };
  assert.deepEqual(decodeRequest(edit), { ok: true, value: edit });
  assert.ok(!decodeRequest({ ...edit, act: 'decide' }).ok);
  assert.ok(!decodeRequest({ op: 'task', code: 'R', from: 'a', act: 'claim' }).ok, 'a claim names its task');
  const done = { op: 'task', code: 'R', from: 'a', act: 'done', n: 2 };
  assert.deepEqual(decodeRequest(done), { ok: true, value: done });
  const refused = { refused: 'stale', latest: { version: 2, hash: 'h' } };
  assert.deepEqual(readAnswer('plan', 200, JSON.stringify({ ok: true, value: refused })), { ok: true, value: refused });
});

test('readAnswer: the value for its op, the daemon\'s own error, and one line for anything else', () => {
  assert.deepEqual(readAnswer('append', 200, '{"ok":true,"value":{"seq":3,"hash":"h"}}'), { ok: true, value: { seq: 3, hash: 'h' } });
  assert.deepEqual(readAnswer('ping', 200, '{"ok":true,"value":null}'), { ok: true, value: null });
  assert.deepEqual(readAnswer('append', 200, '{"ok":false,"error":"busy"}'), { ok: false, error: 'busy' });
  for (const [status, body] of [[200, '{"ok":true,"value":{"seq":0}}'], [502, 'Bad gateway'], [200, '{"ok":"yes"}']] as const) {
    const r = readAnswer('append', status, body);
    assert.ok(!r.ok && !r.error.includes('\n') && /nothing was done|not understood/.test(r.error), body);
  }
});

test('the net ops are read with their fields, and an admit answer is one of three', () => {
  assert.ok(decodeRequest({ op: 'invite', code: 'vole-8126', from: 'tristan', name: 'jess', via: 'public' }).ok);
  assert.ok(!decodeRequest({ op: 'invite', code: 'vole-8126', from: 'tristan', name: 'jess', via: 'forward' }).ok);
  assert.ok(decodeRequest({ op: 'admit', session: 's1', code: 'vole-8126', id: 'a1', answer: 'kick' }).ok);
  assert.ok(!decodeRequest({ op: 'admit', session: 's1', code: 'vole-8126', id: 'a1', answer: 'yes' }).ok);
  assert.ok(decodeRequest({ op: 'dial', line: 'https://n.ts.net/vole-8126#x', name: 'jess' }).ok);
  assert.ok(!decodeRequest({ op: 'dial', line: 'x'.repeat(2000), name: 'jess' }).ok);
  const asks = readAnswer('asks', 200, JSON.stringify({ ok: true, value: { asks: [{ id: 'a', code: 'c', kind: 'leaked', name: 'n', expected: 'n', machine: '', check: '1-2', member: false }] } }));
  assert.ok(asks.ok);
  assert.deepEqual(readAnswer('link', 200, '{"ok":true,"value":null}'), { ok: true, value: null });
});

test('the socket and the daemon\'s argv are under the home and the plugin', () => {
  assert.equal(socketFile('/h'), '/h/daemon.sock');
  assert.deepEqual(daemonArgv('/bin/node', '/p', '/h'), ['/bin/node', '--import', '/p/resolve-ts.ts', '/p/net/daemon.ts', '/h']);
});
