// Every vendored file loads in node by relative path and works once (docs/TESTING.md §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../vendor/valibot.mjs';
import ignore from '../vendor/ignore.mjs';
import { createPatch } from '../vendor/diff/index.js';
import { WebSocket, WebSocketServer } from '../vendor/ws/index.mjs';

test('valibot parses and refuses', () => {
  const Member = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
  assert.deepEqual(v.parse(Member, { name: 'bob' }), { name: 'bob' });
  assert.equal(v.safeParse(Member, { name: '' }).success, false);
});

test('ignore matches gitignore rules', () => {
  const ig = ignore().add(['*.pem', '!keep.pem', 'secrets/']);
  assert.equal(ig.ignores('a/key.pem'), true);
  assert.equal(ig.ignores('keep.pem'), false);
  assert.equal(ig.ignores('secrets/x.txt'), true);
});

test('diff makes a unified patch', () => {
  const p = createPatch('plan.md', 'one\ntwo\n', 'one\nthree\n');
  assert.match(p, /^-two$/m);
  assert.match(p, /^\+three$/m);
});

test('ws: a server and a client on 127.0.0.1 echo one message', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  server.on('connection', s => s.on('message', (m: Buffer) => s.send(`echo ${m.toString()}`)));
  await new Promise<void>(r => server.once('listening', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  t.after(() => client.terminate());
  await new Promise<void>((r, j) => client.once('open', () => r()).once('error', j));
  const got = new Promise<string>(r => client.once('message', (m: Buffer) => r(m.toString())));
  client.send('hi');
  assert.equal(await got, 'echo hi');
});
