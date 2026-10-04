import { createServer } from 'node:http';
import { createTask, seed } from './store.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
    // TODO: list tasks, newest first, paginated. Agree on the design in the room first.
    return send(res, 501, { error: 'not implemented' });
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
