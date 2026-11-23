// The socket API's shapes: what the daemon reads, and what a caller reads back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonArgv, decodePointer, decodeRequest, readAnswer, socketFile } from './api.js';

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
  assert.ok(decodeRequest({ op: 'session', id: '0b9d6f3e-2c4a', code: 'R', name: 'a' }).ok);
  for (const id of ['../x', '', 'a/b', 'x'.repeat(129)]) assert.ok(!decodeRequest({ op: 'session_end', id }).ok, id);
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

test('the socket and the daemon\'s argv are under the home and the plugin', () => {
  assert.equal(socketFile('/h'), '/h/daemon.sock');
  assert.deepEqual(daemonArgv('/bin/node', '/p', '/h'), ['/bin/node', '--import', '/p/resolve-ts.ts', '/p/net/daemon.ts', '/h']);
});
