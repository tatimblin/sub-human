'use strict';
// The devbox's stand-in for tailscaled's serve proxy: accept on 0.0.0.0:FWD (reachable from the lab's core network
// only: tls-front) and pipe each connection to 127.0.0.1:TARGET, the host's own loopback listener (1.1's ws
// listener). While nothing listens there, a connection is closed at once. Usage: node fwd.js FWD TARGET
const net = require('node:net');
const [fwd, target] = process.argv.slice(2).map(Number);
net.createServer(c => {
  const u = net.connect(target, '127.0.0.1');
  c.pipe(u).pipe(c);
  const end = () => { c.destroy(); u.destroy(); };
  for (const s of [c, u]) { s.on('error', end); s.on('close', end); }
}).listen(fwd, '0.0.0.0', () => process.stderr.write(`lab fwd 0.0.0.0:${fwd} -> 127.0.0.1:${target}\n`));
