import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { reset, seed, createTask } from '../src/store.js';

const server = start(0);
const base = `http://localhost:${server.address().port}`;
after(() => server.close());

beforeEach(() => {
  reset();
});

async function getTasks(qs = '') {
  const res = await fetch(`${base}/tasks${qs}`);
  return { status: res.status, body: await res.json() };
}

test('first page: 20 tasks, newest first, ties broken by id desc', async () => {
  seed();
  const { status, body } = await getTasks();
  assert.equal(status, 200);
  assert.equal(body.tasks.length, 20);
  for (let i = 1; i < body.tasks.length; i++) {
    const prev = body.tasks[i - 1];
    const curr = body.tasks[i];
    if (prev.createdAt === curr.createdAt) {
      assert.ok(prev.id > curr.id, `expected id desc tie-break: ${prev.id} > ${curr.id}`);
    } else {
      assert.ok(
        Date.parse(prev.createdAt) > Date.parse(curr.createdAt),
        `expected createdAt desc: ${prev.createdAt} > ${curr.createdAt}`
      );
    }
  }
});

test('walking nextCursor visits all 237 ids exactly once, ending with nextCursor: null', async () => {
  seed();
  const seen = [];
  let cursor;
  let lastNextCursor;
  for (;;) {
    const qs = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : '?limit=20';
    const { status, body } = await getTasks(qs);
    assert.equal(status, 200);
    for (const t of body.tasks) seen.push(t.id);
    cursor = body.nextCursor;
    lastNextCursor = body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 237);
  assert.equal(new Set(seen).size, 237);
  assert.equal(lastNextCursor, null);
});

test('a task inserted mid-walk does not duplicate or skip the rest of the walk', async () => {
  seed();
  const page1 = await getTasks('?limit=20');
  let cursor = page1.body.nextCursor;
  const seen = page1.body.tasks.map((t) => t.id);

  // Insert a row whose createdAt falls within the still-unvisited range, simulating a
  // concurrent write landing in the middle of the pagination walk (not merely appended).
  const seedBase = Date.parse('2026-09-01T00:00:00Z');
  const inserted = createTask({ title: 'mid-walk insert', createdAt: new Date(seedBase + 36 * 60_000) });

  for (;;) {
    const qs = `?limit=20&cursor=${encodeURIComponent(cursor)}`;
    const { body } = await getTasks(qs);
    for (const t of body.tasks) seen.push(t.id);
    cursor = body.nextCursor;
    if (!cursor) break;
  }

  for (let id = 1; id <= 237; id++) {
    assert.equal(seen.filter((x) => x === id).length, 1, `id ${id} should appear exactly once`);
  }
  assert.equal(seen.filter((x) => x === inserted.id).length, 1, 'inserted row should be visited exactly once');
  assert.equal(seen.length, 238);
});

test('limit=500 is clamped to 100; limit=0 and limit=abc are rejected', async () => {
  seed();
  const big = await getTasks('?limit=500');
  assert.equal(big.status, 200);
  assert.equal(big.body.tasks.length, 100);

  const zero = await getTasks('?limit=0');
  assert.equal(zero.status, 400);

  const nonInt = await getTasks('?limit=abc');
  assert.equal(nonInt.status, 400);
});

test('a malformed cursor returns 400', async () => {
  seed();
  const garbage = Buffer.from('not valid json').toString('base64url');
  const res = await getTasks(`?cursor=${garbage}`);
  assert.equal(res.status, 400);
});

test('approxTotal reflects the in-memory row count', async () => {
  seed();
  const { body } = await getTasks();
  assert.equal(body.approxTotal, 237);
});
