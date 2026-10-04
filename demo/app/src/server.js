import { createServer } from 'node:http';
import { createTask, seed, listTasks, approxCount } from './store.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw) {
  if (raw == null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(task) {
  return Buffer.from(JSON.stringify({ createdAt: task.createdAt, id: task.id })).toString(
    'base64url'
  );
}

function decodeCursor(raw) {
  if (raw == null) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'number') {
      return { ok: false };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/tasks') {
    const { title } = await readJson(req);
    if (!title) return send(res, 400, { error: 'title is required' });
    return send(res, 201, createTask({ title }));
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit == null) return send(res, 400, { error: 'limit must be an integer >= 1' });

    const cursor = decodeCursor(url.searchParams.get('cursor'));
    if (!cursor.ok) return send(res, 400, { error: 'invalid cursor' });

    const { tasks, hasNext } = listTasks({ limit, after: cursor.value });
    const nextCursor = hasNext ? encodeCursor(tasks[tasks.length - 1]) : null;
    return send(res, 200, { tasks, nextCursor, approxTotal: approxCount() });
  }

  send(res, 404, { error: 'not found' });
}

export function start(port = 3000) {
  return createServer(handle).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  start(3000);
  console.log('tasks-api on http://localhost:3000');
}
