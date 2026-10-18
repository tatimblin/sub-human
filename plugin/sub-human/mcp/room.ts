/**
 * plugin/sub-human/mcp/room.ts: the room MCP server's entry (.mcp.json). It loads ./room-server.ts, the server. When
 * that fails to load (a broken install, a plugin update half on disk), this file still answers as an MCP server, with
 * no tools and the error in its instructions, and every tool call answered with it: Claude Code skips a plugin's
 * server that fails to connect, in every session on the machine, for 15 minutes (cc CONTRACT mcp-failure-cache), so a
 * start that cannot fail keeps one bad moment from costing the room's tools everywhere. Node builtins only: nothing
 * here can be what failed. Messages that came before the failure stay in stdin's buffer (room-server.ts reads stdin
 * only once it has loaded), so this answers them.
 */

const PROTOCOL = '2025-11-25';

let failure = '', why = '';
try {
  await import('./room-server.ts');
} catch (e) {
  failure = e instanceof Error ? (e.stack || e.message) : String(e);
  why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  stub();
}

function stub(): void {
  process.stderr.write(`sub-human room server failed to load: ${failure}\n`);
  const say = `sub-human's room tools failed to load (${(why.split('\n')[0] || 'unknown error').slice(0, 300)}). Tell the person: run sub-human doctor, update or reinstall the plugin (/plugin), then /mcp to reconnect plugin:sub-human:room.`;
  const send = (m: unknown) => { try { process.stdout.write(JSON.stringify(m) + '\n'); } catch { process.exit(0); } };
  const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? Reflect.get(o, k) : undefined);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      const id = field(msg, 'id'), method = field(msg, 'method');
      if (id === undefined || id === null) continue; // a notification
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') {
        const asked = field(field(msg, 'params'), 'protocolVersion');
        reply({ protocolVersion: typeof asked === 'string' ? asked : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'room', title: 'sub-human room', version: '0.0.0' }, instructions: say });
      } else if (method === 'ping') reply({});
      else if (method === 'tools/list') reply({ tools: [] });
      else if (method === 'tools/call') reply({ content: [{ type: 'text', text: say }], isError: true });
      else send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
    }
  });
  const end = () => process.exit(0);
  process.stdin.on('end', end);
  process.stdin.on('close', end);
}
