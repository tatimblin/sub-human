// The bridge builds a `$.http.fetch` call that a real daemon answers, and reads the answer back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { request } from './bridge.js';
import { readAnswer } from '../core/api.js';
import { startDaemon } from '../net/daemon.js';
import { must } from '../test/support/must.js';

/** What `$.http.fetch(c.url, c)` does with a call: node's http over the socket. */
function fetchLike(c: ReturnType<typeof request>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const q = http.request(c.url, { socketPath: c.socketPath, method: c.method, headers: c.headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (s: string) => { text += s; });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text }); });
    });
    q.on('error', reject);
    q.end(c.body);
  });
}

test('request: a POST of the JSON request over the home\'s socket', () => {
  const c = request({ op: 'ping', session: 's' }, '/h');
  assert.deepEqual(c, {
    url: 'http://daemon/', socketPath: '/h/daemon.sock', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"op":"ping","session":"s"}',
  });
});

test('a call the bridge built is answered by the daemon and read back typed', async () => {
  const h = await fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'b-'));
  const d = await startDaemon({ home: h });
  const daemon = must(d.ok ? d.value : null, 'a daemon');
  const status = readAnswer('status', await fetchLike(request({ op: 'status' }, h)));
  assert.ok(status.ok && status.value.pid === process.pid);
  const refused = readAnswer('append', await fetchLike(request({ op: 'append', code: 'R', draft: { kind: 'post', id: '0b9d6f3e-2c4a-4f1e-9a7b-5d8c1e2f3a4b', from: 'a', by: 'claude', text: 'hi' } }, h)));
  assert.deepEqual(refused, { ok: false, error: 'a is not in R; nothing was written' });
  assert.deepEqual(readAnswer('status', { status: 400, text: '{"ok":false,"error":"request not understood: op"}' }), { ok: false, error: 'request not understood: op' });
  await daemon.close();
});
