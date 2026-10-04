import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';

const server = start(0);
const base = `http://localhost:${server.address().port}`;
after(() => server.close());

test('GET /health', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
