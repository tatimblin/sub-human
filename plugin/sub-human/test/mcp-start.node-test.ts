// mcp/room.ts and hooks/node.sh: the room MCP server's start cannot fail for want of node or for a server that will
// not load. Claude Code skips a plugin's server that fails to connect once, in every session on the machine, for 15
// minutes (cc CONTRACT mcp-failure-cache).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import { must } from './support/must.ts';

/** o's value at keys, read as unknown (JSON from a child, untyped). */
const at = (o: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((v, k) => (v && typeof v === 'object' ? Reflect.get(v, k) : undefined), o);
const str = (v: unknown): string => (typeof v === 'string' ? v : assert.fail(`not a string: ${JSON.stringify(v)}`));

const LINES = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
].map(m => JSON.stringify(m)).join('\n') + '\n';

/** .mcp.json's room server as Claude Code starts it, ${CLAUDE_PLUGIN_ROOT} = root; stdin LINES, then closed. */
function start(root: string, env: Record<string, string> = {}) {
  const srv: unknown = at(JSON.parse(fs.readFileSync(path.join(h.PLUGIN, '.mcp.json'), 'utf8')), 'mcpServers', 'room');
  const sub = (s: unknown) => str(s).replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  const args = at(srv, 'args');
  const r = spawnSync(sub(at(srv, 'command')), Array.isArray(args) ? args.map(sub) : [], {
    input: LINES, encoding: 'utf8', timeout: 20000,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: must(process.env.SUB_HUMAN_HOME), SUB_HUMAN_HOME: must(process.env.SUB_HUMAN_HOME), ...env },
  });
  const replies = r.stdout.split('\n').filter(Boolean).map((l): unknown => JSON.parse(l));
  return { status: r.status, stderr: r.stderr, byId: (id: number) => must(replies.find(x => at(x, 'id') === id), `reply ${id}`) };
}

/** A copy of the plugin's entry files under a temp root, with mcp/room-server.ts replaced (null: missing). */
function brokenRoot(server: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-mcpstart-'));
  for (const rel of ['hooks/node.sh', 'hooks/compile-cache.js', 'lib/cache-dir.js', 'mcp/room.ts']) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(h.PLUGIN, rel), path.join(root, rel));
  }
  if (server !== null) fs.writeFileSync(path.join(root, 'mcp', 'room-server.ts'), server);
  return root;
}

test('mcp start: .mcp.json runs mcp/room.ts through hooks/node.sh, and it is the room server (tools listed)', () => {
  h.freshHome();
  const s = start(h.PLUGIN);
  assert.equal(at(s.byId(1), 'result', 'protocolVersion'), '2025-06-18');
  const list = at(s.byId(2), 'result', 'tools');
  const tools = Array.isArray(list) ? list.map(t => at(t, 'name')) : [];
  for (const t of ['post', 'read', 'plan', 'task']) assert.ok(tools.includes(t), tools.join(' '));
  assert.equal(at(s.byId(3), 'result', 'content', 0, 'text'), 'not in a room; run /sub-human');
});

test('mcp start: a server that throws while loading, or is missing, still connects: no tools, the error in its instructions and in every call', () => {
  h.freshHome();
  for (const [what, server, why] of [
    ['throws', 'throw new Error("boom: a half-written update");\n', /boom: a half-written update/],
    ['missing', null, /room-server\.ts/],
    ['bad syntax', 'export const = ;\n', /SyntaxError|Unexpected|Expected/],
  ] as const) {
    const root = brokenRoot(server);
    const s = start(root);
    assert.equal(s.status, 0, `${what}: ${s.stderr}`);
    assert.equal(at(s.byId(1), 'result', 'protocolVersion'), '2025-06-18', what);
    const said = str(at(s.byId(1), 'result', 'instructions'));
    assert.match(said, /^sub-human's room tools failed to load \(/, what);
    assert.match(said, why, what);
    assert.match(said, /sub-human doctor.*\/mcp to reconnect plugin:sub-human:room/, what);
    assert.deepEqual(at(s.byId(2), 'result', 'tools'), [], what);
    assert.equal(at(s.byId(3), 'result', 'isError'), true, what);
    assert.match(str(at(s.byId(3), 'result', 'content', 0, 'text')), why, what);
    assert.equal(at(s.byId(4), 'error', 'code'), -32601, what);
    assert.match(s.stderr, /sub-human room server failed to load/, what);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
