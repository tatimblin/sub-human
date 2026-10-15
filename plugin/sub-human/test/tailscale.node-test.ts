// lib/remote/tailscale.ts against a fake `tailscale` that talks like the real CLI: a tailnet without Serve prints
// "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=…" and then waits
// for an admin (the real one hung 20 s on a Mac). on() reads the output as it comes, kills the CLI at the URL (or
// after its deadline) and says what to do; tailscaled not running or logged out says so too. No real tailscale runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as ts from '../lib/remote/tailscale.ts';
import * as links from '../lib/room/links.ts';
import * as hosting from '../lib/remote/hosting.ts';

const UP = '{"BackendState":"Running","Self":{"DNSName":"box.tail1a2b.ts.net.","Online":true}}';
const ENABLE_URL = 'https://login.tailscale.com/f/serve?node=nABC123CNTRL';

/** A refusal as tailscale.ts throws it: a RoomError's code. */
type CodedErr = Error & { code?: string };

/** A fake tailscale: `status` prints statusOut (exit statusCode); anything else runs serveBody (sh). Its pid file
 * shows whether the serve call was left running. */
function fake(t: TestContext, { statusOut = UP, statusCode = 0, serveBody }: { statusOut?: string; statusCode?: number; serveBody?: string }) {
  const dir = h.tmpDir('sh-fake-ts-', t);
  const pidFile = path.join(dir, 'serve.pid');
  const bin = path.join(dir, 'tailscale');
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = status ]; then printf '%s\\n' '${statusOut}'; exit ${statusCode}; fi\necho $$ > "${pidFile}"\n${serveBody}\n`, { mode: 0o755 });
  const live = () => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; } };
  // killed is not yet reaped: the watcher exits with it, and the orphan is reaped by init a moment later (on Linux a
  // zombie still answers kill 0), so give it a second to go
  const alive = () => { const end = Date.now() + 1000; while (live() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); return live(); };
  return { bin, alive };
}

const serveIt = (bin: string, extra: { funnel?: boolean; timeoutMs?: number } = {}) => ts.on({ bin, path: '/sub-human/vole-1234', port: 7420, ...extra });

test('tailscale on: "Serve is not enabled … To enable, visit: URL" and a hang: killed at the URL, a clear message with that URL', t => {
  const f = fake(t, { serveBody: `printf '\\nServe is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         ${ENABLE_URL}\\n\\n'\nsleep 30` });
  const t0 = Date.now();
  assert.throws(() => serveIt(f.bin, { timeoutMs: 8000 }), (e: CodedErr) => {
    assert.equal(e.code, 'INVALID');
    assert.equal(e.message, `Tailscale Serve isn't enabled on your tailnet yet. An admin turns it on once at ${ENABLE_URL} (or Admin console → DNS → HTTPS Certificates and Serve), then run /sub-human invite --web again.`);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, `stopped at the URL, not the deadline (${Date.now() - t0} ms)`);
  assert.equal(f.alive(), false, 'the hanging CLI was killed');
});

test('tailscale on: Funnel not enabled names Funnel and --public', t => {
  const f = fake(t, { serveBody: `echo "Funnel is not enabled on your tailnet."; echo "To enable, visit:"; echo "  https://login.tailscale.com/f/funnel?node=nX"; sleep 30` });
  assert.throws(() => serveIt(f.bin, { funnel: true, timeoutMs: 8000 }),
    /Tailscale Funnel isn't enabled on your tailnet yet\. An admin turns it on once at https:\/\/login\.tailscale\.com\/f\/funnel\?node=nX .*then run \/sub-human invite --public again\./);
});

test('tailscale on: no answer and no URL within the deadline: killed, the same advice with the admin console', t => {
  const f = fake(t, { serveBody: 'sleep 30' });
  const t0 = Date.now();
  assert.throws(() => serveIt(f.bin, { timeoutMs: 600 }), (e: CodedErr) => {
    assert.equal(e.code, 'INVALID');
    assert.match(e.message, /^Tailscale Serve isn't enabled on your tailnet yet \(tailscale serve gave no answer within 1 s\)\. An admin turns it on once at https:\/\/login\.tailscale\.com\/admin\/dns .*run \/sub-human invite --web again\.$/);
    return true;
  });
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(f.alive(), false);
});

test('tailscale on: success (exit 0 with the --bg banner) returns the record', t => {
  const f = fake(t, { serveBody: 'echo "Available within your tailnet:"; echo; echo "https://box.tail1a2b.ts.net/sub-human/vole-1234"; echo "Serve started and running in the background."; exit 0' });
  assert.deepEqual(serveIt(f.bin), { bin: f.bin, path: '/sub-human/vole-1234', port: 7420, https: 443, funnel: false });
});

test('tailscale on: tailscaled not running, or logged out: OFFLINE with what to do', t => {
  const down = fake(t, { serveBody: 'echo "failed to connect to local Tailscale daemon for /localapi/v0/serve-config; not running? Error: dial unix /var/run/tailscale/tailscaled.sock: connect: no such file or directory" >&2; exit 1' });
  assert.throws(() => serveIt(down.bin), (e: CodedErr) => e.code === 'OFFLINE' && /^Tailscale isn't running on this machine: start the Tailscale app \(or tailscaled\) and log in, then run \/sub-human invite --web again/.test(e.message));
  const out = fake(t, { serveBody: 'echo "Logged out."; exit 1' });
  assert.throws(() => serveIt(out.bin), (e: CodedErr) => e.code === 'OFFLINE' && /logged out on this machine: log in/.test(e.message));
  const other = fake(t, { serveBody: 'echo "invalid argument: bad thing" >&2; exit 2' });
  assert.throws(() => serveIt(other.bin), /tailscale serve refused: invalid argument: bad thing/);
});

test('tailscale self: logged out, stopped and not running read as such; up gives the MagicDNS name', t => {
  assert.deepEqual(ts.self(fake(t, {}).bin), { dnsName: 'box.tail1a2b.ts.net', online: true, backend: 'Running' });
  const loggedOut = fake(t, { statusOut: '{"BackendState":"NeedsLogin","Self":{"DNSName":""}}', statusCode: 1 });
  assert.throws(() => ts.self(loggedOut.bin), (e: CodedErr) => e.code === 'OFFLINE' && /logged out on this machine/.test(e.message));
  const stopped = fake(t, { statusOut: '{"BackendState":"Stopped","Self":{"DNSName":"box.ts.net."}}' });
  assert.throws(() => ts.self(stopped.bin), /Tailscale is stopped on this machine/);
  const none = fake(t, { statusOut: 'failed to connect to local Tailscale daemon for /localapi/v0/status; not running?', statusCode: 1 });
  assert.throws(() => ts.self(none.bin), /Tailscale isn't running on this machine/);
});

test('tailscale classify: the CLI\'s words', () => {
  assert.deepEqual(ts.classify(`Serve is not enabled on your tailnet.\nTo enable, visit:\n\n   ${ENABLE_URL}\n`), { kind: 'enable', feature: 'Serve', url: ENABLE_URL });
  assert.deepEqual(ts.classify('Funnel is not enabled on your tailnet.'), { kind: 'enable', feature: 'Funnel', url: null });
  assert.equal(ts.classify('Available within your tailnet:\nServe started and running in the background.'), null);
  assert.deepEqual(ts.classify('Tailscale is stopped.'), { kind: 'stopped' });
});

test('tailscale warm: one background HTTPS request to the served URL (the certificate is fetched before the first joiner); never waited for', async t => {
  let hit = null as Buffer | null; // set by the server's callback
  const srv = net.createServer(s => { s.once('data', d => { hit = d; s.destroy(); }); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const t0 = Date.now();
  const pid = ts.warm(`https://127.0.0.1:${(srv.address() as AddressInfo).port}/sub-human/vole-1234`, { timeoutMs: 3000 });
  assert.ok(Number.isInteger(pid) && Date.now() - t0 < 1000, 'returns at once');
  assert.ok(await h.until(() => hit, 5000, 20), 'the request arrived');
  assert.equal(hit![0], 0x16, 'a TLS ClientHello');
  assert.equal(ts.warm('https://box.ts.net/x', { env: { SUB_HUMAN_TAILSCALE_WARM: '0' } }), null);
  assert.equal(ts.warm('https://box.ts.net/x"; rm -rf /'), null, 'a plain URL only');
});

test('join text: a wss link to a ts.net name still connecting says Tailscale may be issuing a certificate', t => {
  h.freshHome(t);
  const code = 'vole-4321';
  links.set(code, { code, transport: { kind: 'wss', host: 'box.tail1a2b.ts.net', path: `/sub-human/${code}`, hostKey: 'A'.repeat(43) }, invite: 'x', created_at: 'now' });
  assert.match(hosting.joinText(code, 'bob', { state: 'waiting' }), /still connecting to room vole-4321 \(Tailscale may be issuing a certificate: .*keeps trying\); type \/sub-human in a moment/);
  assert.doesNotMatch(hosting.joinText(code, 'bob', { state: 'waiting', reason: 'no route' }), /certificate/);
});
