/**
 * test/support/tls-front.ts: a TLS front in its own process (the shape of Tailscale Serve or the lab's Caddy): it
 * terminates TLS on 127.0.0.1:FRONT_PORT with CERT/KEY and pipes each connection to 127.0.0.1:TARGET_PORT. A
 * separate process, because the tests' hooks run with spawnSync, which blocks the test's own event loop.
 *   node tls-front.js FRONT_PORT TARGET_PORT CERT KEY      prints "ready" once listening
 */
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const [front, target, cert = '', key = ''] = process.argv.slice(2);
tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, s => {
  const u = net.connect(Number(target), '127.0.0.1');
  s.pipe(u).pipe(s);
  const end = () => { s.destroy(); u.destroy(); };
  for (const x of [s, u]) { x.on('error', end); x.on('close', end); }
}).listen(Number(front), '127.0.0.1', () => process.stdout.write('ready\n'));
