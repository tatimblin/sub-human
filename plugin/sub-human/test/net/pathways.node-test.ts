// The real pathways against fake binaries on PATH (TESTING §6): ssh -W through a fake ssh that bridges to the host's
// loopback listener, and tailscale control through a fake CLI that records commands (Funnel, Serve, a port 443 held
// by another app, every port held, one forward off while another stays, the tailnet with Funnel off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as v from '../../vendor/valibot.mjs';
import path from 'node:path';
import { PLUGIN } from '../support/daemon.js';
import { CODE, hostRoom, joinBob, twoHomes } from '../support/two-homes.js';
import { dialSsh, sshArgs } from '../../net/pathways/ssh.js';
import { expose, findTailscale } from '../../net/pathways/tailscale.js';

const BIN = path.join(PLUGIN, 'test', 'fixtures', 'bin');
const NO_APP = '/nonexistent/Tailscale';

async function scratch(): Promise<string> { return fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'bin-')); }
async function logged(file: string): Promise<string[][]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(l => v.parse(v.array(v.string()), JSON.parse(l)));
}
const PATH = `${BIN}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;

test('ssh: the arguments name the listener and the joiner\'s own account, and never an option as the host', () => {
  assert.deepEqual(sshArgs({ kind: 'ssh', host: 'devbox', user: 'jess', sshPort: 2222, port: 7420 }),
    ['-W', '127.0.0.1:7420', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-p', '2222', '-l', 'jess', '--', 'devbox']);
});

test('ssh: a join over ssh -W reaches the host\'s loopback listener', async t => {
  const dir = await scratch();
  const env = { ...process.env, PATH, FAKE_SSH_LOG: path.join(dir, 'ssh.log') };
  const h = await twoHomes(t, { joinOpts: { dial: via => (via.kind === 'ssh' ? dialSsh(via, env) : Promise.reject(new Error('ssh only'))) } });
  const { line } = await joinBob(h, 'ssh');
  const port = /\?port=(\d+)#/.exec(line)?.[1] ?? '';
  const runs = await logged(env.FAKE_SSH_LOG);
  assert.ok(runs.length >= 2, 'the join and the link each ran ssh');
  assert.ok(runs.every(a => a.join(' ') === `-W 127.0.0.1:${port} -o BatchMode=yes -o ExitOnForwardFailure=yes -- devbox`), JSON.stringify(runs));
  const placed = await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  assert.ok(placed.seq > 0);
});

test('ssh: an unreachable host is one line naming why', async t => {
  const env = { ...process.env, PATH, FAKE_SSH_FAIL: '1' };
  const h = await twoHomes(t, { joinOpts: { dial: via => (via.kind === 'ssh' ? dialSsh(via, env) : Promise.reject(new Error('ssh only'))) } });
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  const r = await h.joiner.call({ op: 'dial', line, name: 'bob' });
  assert.ok(!r.ok && /Connection refused/.test(r.error) && !r.error.includes('\n'), r.ok ? '' : r.error);
});

async function ts(state: object = {}, extra: Record<string, string> = {}): Promise<{ env: Record<string, string | undefined>; log: string; state: string }> {
  const dir = await scratch();
  const [log, st] = [path.join(dir, 'ts.log'), path.join(dir, 'serve.json')];
  await fs.writeFile(st, JSON.stringify(state));
  return { env: { PATH, FAKE_TS_LOG: log, FAKE_TS_STATE: st, ...extra }, log, state: st };
}
const serveSchema = v.object({ TCP: v.optional(v.record(v.string(), v.object({ TCPForward: v.optional(v.string()) }))) });
const serveState = async (file: string): Promise<v.InferOutput<typeof serveSchema>> => v.parse(serveSchema, JSON.parse(await fs.readFile(file, 'utf8')));

test('tailscale: found on PATH, else at the macOS app\'s path', async () => {
  assert.equal(findTailscale({ PATH }, NO_APP), path.join(BIN, 'tailscale'));
  assert.equal(findTailscale({ PATH: '/nonexistent' }, NO_APP), null);
  assert.equal(findTailscale({ PATH: '/nonexistent' }, path.join(BIN, 'tailscale')), path.join(BIN, 'tailscale'));
});

test('tailscale: Funnel publishes the listener on 443 with PROXY v2; Serve the same for the tailnet', async () => {
  const f = await ts();
  const pub = await expose('public', 7420, f.env, NO_APP);
  assert.ok(pub.ok);
  assert.equal(pub.value.origin, 'https://node.tail1234.ts.net');
  const t = await expose('tailnet', 7420, f.env, NO_APP);
  assert.ok(t.ok);
  assert.equal(t.value.origin, 'https://node.tail1234.ts.net:8443', 'Serve and Funnel collide on one port');
  const runs = (await logged(f.log)).filter(a => a[0] !== 'status' && a[1] !== 'status');
  assert.deepEqual(runs, [
    ['funnel', '--bg', '--tls-terminated-tcp=443', '--proxy-protocol=2', 'tcp://127.0.0.1:7420'],
    ['serve', '--bg', '--tls-terminated-tcp=8443', '--proxy-protocol=2', 'tcp://127.0.0.1:7420'],
  ]);
  const again = await expose('public', 7420, f.env, NO_APP);
  assert.ok(again.ok && again.value.origin === 'https://node.tail1234.ts.net');
  assert.equal((await logged(f.log)).filter(a => a[0] === 'funnel').length, 1, 'our forward already there is kept, not made again');
});

test('tailscale: a port 443 another app serves is left alone; the next free port is taken', async () => {
  const f = await ts({ TCP: { 443: { HTTPS: true } }, Web: { 'node.tail1234.ts.net:443': {} } });
  const r = await expose('public', 7420, f.env, NO_APP);
  assert.ok(r.ok);
  assert.equal(r.value.origin, 'https://node.tail1234.ts.net:8443');
  const s = await serveState(f.state);
  assert.ok(s.TCP?.['443'] && !s.TCP['443'].TCPForward, 'the other app\'s 443 is untouched');
});

test('tailscale: every Funnel port held is one line, and nothing is run', async () => {
  const f = await ts({ TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 10000: { TCPForward: '127.0.0.1:9' } } });
  const r = await expose('public', 7420, f.env, NO_APP);
  assert.ok(!r.ok && /443, 8443, 10000 all serve something else/.test(r.error));
  assert.equal((await logged(f.log)).filter(a => a[0] === 'funnel').length, 0);
});

test('tailscale: turning one forward off leaves every other forward as it was', async () => {
  const f = await ts({ TCP: { 10000: { TCPForward: '127.0.0.1:5432' } } });
  const pub = await expose('public', 7420, f.env, NO_APP);
  const tail = await expose('tailnet', 7420, f.env, NO_APP);
  assert.ok(pub.ok && tail.ok);
  await pub.value.off();
  const s = await serveState(f.state);
  assert.deepEqual(Object.keys(s.TCP ?? {}).sort(), ['10000', '8443']);
  assert.deepEqual((await logged(f.log)).at(-1), ['funnel', '--tls-terminated-tcp=443', 'off']);
});

test('tailscale: a tailnet with Funnel off names the admin page, without waiting on it', async () => {
  const f = await ts({}, { FAKE_TS_OFF: '1' });
  const started = Date.now();
  const r = await expose('public', 7420, f.env, NO_APP);
  assert.ok(!r.ok && /Funnel isn't on for this tailnet.*https:\/\/login\.tailscale\.com\/f\/funnel\?node=n1/.test(r.error), r.ok ? '' : r.error);
  assert.ok(Date.now() - started < 5000);
});

test('tailscale: not running or logged out is one line, and nothing is published', async () => {
  const f = await ts({}, { FAKE_TS_BACKEND: 'NeedsLogin' });
  const r = await expose('tailnet', 7420, f.env, NO_APP);
  assert.ok(!r.ok && /isn't running or logged in/.test(r.error));
  const none = await expose('tailnet', 7420, { PATH: '/nonexistent' }, NO_APP);
  assert.ok(!none.ok && /isn't installed/.test(none.error));
});

test('tailscale: a forward of ours already there without the PROXY header is one line, and is not reused', async () => {
  const f = await ts({ TCP: { 443: { TCPForward: '127.0.0.1:7420' } }, AllowFunnel: { 'node.tail1234.ts.net:443': true } });
  const r = await expose('public', 7420, f.env, NO_APP);
  assert.ok(!r.ok && /without the PROXY header.*--tls-terminated-tcp=443 off/.test(r.error), r.ok ? '' : r.error);
  assert.equal((await logged(f.log)).filter(a => a[0] === 'funnel').length, 0);
});
