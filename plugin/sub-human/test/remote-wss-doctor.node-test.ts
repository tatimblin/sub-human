// 1.1 with the rest of 1.0: `sub-human doctor` sees the host's web listener (pid, port, rooms), each room's Tailscale
// path (present or gone, against a fake `tailscale`), Funnel's certificate-transparency warning, and a joiner's wss
// link through its real transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as links from '../lib/room/links.ts';
import * as listener from '../lib/remote/listener.ts';
import * as doctor from '../lib/cli/doctor.ts';
import { Machine, childOf, kill } from './support/two-homes.ts';
import * as noiseLib from '../lib/remote/noise.ts';
import type { WsSpec } from '../lib/remote/types-rest.ts';
import type { RoomCode } from '../lib/brand.ts';
import type { Link } from '../lib/room/types.ts';
import { must } from './support/must.ts';

/** A link's web transport, asserted. */
const wsSpec = (l: Link): WsSpec => {
  assert.ok(l.transport.kind === 'ws' || l.transport.kind === 'wss', 'a web link');
  return l.transport;
};

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '600', SUB_HUMAN_LINK_IDLE_MS: '20000' };
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

function cleanup(t: TestContext, machines: Machine[], code: () => RoomCode) {
  t.after(() => {
    for (const m of machines) {
      m.lib(() => listener.stop());
      const d = m.lib(() => linkSocket.status(code()));
      if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
      fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code()))), { recursive: true, force: true });
    }
  });
}

/** A fake tailscale that remembers the paths serve/funnel turned on and lists them in `serve status --json`. */
function fakeTailscale(t: TestContext) {
  const bin = h.tmpDir('sh-fake-ts-', t);
  const served = path.join(bin, 'served');
  fs.writeFileSync(served, '');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const f = ${JSON.stringify(served)};
const p = (a.find(x => x.startsWith('--set-path=')) || '').slice(11);
const cur = fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean);
if (a[0] === 'status') console.log(JSON.stringify({ Self: { DNSName: 'box.tail1a2b.ts.net.' } }));
else if (a[1] === 'status') console.log(JSON.stringify({ Web: { 'box.tail1a2b.ts.net:443': { Handlers: Object.fromEntries(cur.map(x => [x, {}])) } } }));
else if (a.includes('off')) fs.writeFileSync(f, cur.filter(x => x !== p).join('\\n'));
else fs.writeFileSync(f, [...cur, p].join('\\n'));
`, { mode: 0o755 });
  return { bin, served };
}

test('doctor: the listener, a room\'s Tailscale path present or gone, Funnel\'s CT warning, a redacted bundle; a wss link\'s hello over the pinned channel', async t => {
  const ts = fakeTailscale(t);
  const port = await freePort();
  const host = new Machine(t, 'host', { SUB_HUMAN_LISTEN_PORT: String(port), PATH: `${ts.bin}:${process.env.PATH}` });
  const remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  cleanup(t, [host, remote], () => code);
  const checks = () => host.lib(() => doctor.checkListener({}));
  assert.match(must(checks()[0]).detail, /no room is served over the web/);

  host.join(alice, 'invite --web');
  let c = checks();
  assert.equal(must(c[0]).status, 'pass');
  assert.match(must(c[0]).detail, new RegExp(`running \\(pid \\d+\\) on 127\\.0\\.0\\.1:${port} · serves ${code}`));
  assert.deepEqual([must(c[1]).id, must(c[1]).status], [`web:${code}`, 'pass'], JSON.stringify(must(c[1])));
  assert.match(must(c[1]).detail, /Tailscale Serve \(tailnet only\) https:\/\/box\.tail1a2b\.ts\.net\/sub-human\/\S+ \(path present\)/);
  // the path gone behind our back (a serve reset): a failure, with the fix
  fs.writeFileSync(ts.served, '');
  c = checks();
  assert.deepEqual([must(c[1]).status, must(c[1]).fix], ['fail', '/sub-human invite --web in the room (it puts the path back)']);
  // Funnel: a warning that the name is public
  host.join(alice, 'invite --public');
  c = checks();
  assert.equal(must(c[1]).status, 'warn');
  assert.match(must(c[1]).detail, /Tailscale Funnel .*\(path present\)\. .*certificate-transparency/);
  // the bundle hashes the ts.net name and the room code
  const report = await host.lib(() => doctor.diagnose({ quick: true }));
  assert.ok(report.checks.some(x => x.id === 'listener'));
  const b = JSON.stringify(host.lib(() => doctor.bundle(report)));
  assert.ok(!b.includes('tail1a2b') && !b.includes(code), 'redacted');
  // the listener gone while a room is served: a failure
  host.lib(() => listener.stop());
  c = checks();
  assert.equal(must(c[0]).status, 'fail');
  assert.match(must(must(c[0]).fix), /sub-human listen --start/);

  // a joiner's wss link: doctor's hello goes over the WebSocket and the pinned Noise channel
  host.lib(() => listener.start({ port }));
  await remote.joinVia(host, alice, bob, { front: `http://127.0.0.1:${port}` });
  const lf = must(remote.lib(() => links.get(code)));
  const probe = await remote.lib(() => doctor.helloProbe(lf.transport, code, { timeoutMs: 5000 }));
  assert.equal(probe.ok, true, probe.error);
  assert.ok(probe.reply && must(probe.reply.v) >= 1);
  const wrongKey = await remote.lib(() => doctor.helloProbe({ ...wsSpec(lf), hostKey: noiseLib.generateKeyPair().pub.toString('base64url') }, code, { timeoutMs: 5000 }));
  assert.equal(wrongKey.ok, false, 'another pinned key gets no answer');
});
