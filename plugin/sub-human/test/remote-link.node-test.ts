// The link registry (lib/room/links.ts), the link daemon's pieces (lib/remote/link.ts: socket path, locator,
// handle, serveMirror's FORK and re-mirror, idleWatch) and the mirror's own writes (lib/room/store-mirror.ts
// applyLine, applyDoc), and the tail's one line for a link that is down (lib/tail.ts linkLine);
// the mirror through the bridge is in test/store-contract.node-test.ts (remote), two homes in test/remote-e2e.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as links from '../lib/room/links.ts';
import * as link from '../lib/remote/link.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as linkConnect from '../lib/remote/link-connect.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import { MirrorRoomStore } from '../lib/room/store-mirror.ts';
import { linkLine } from '../lib/tail.ts';
import * as identity from '../lib/identity.ts';
import { writeJsonAtomic } from '../lib/io.ts';
import { pidStart } from '../lib/lock.ts';
import * as protocol from '../lib/remote/protocol.ts';
import * as ssh from '../lib/remote/transports/ssh.ts';
import * as room from '../lib/room.ts';
import * as render from '../lib/room/render.ts';
import { lane } from '../lib/room/deliver.ts';
import { RoomError } from '../lib/room/validate.ts';
import * as realClock from '../lib/clock.ts';
import * as config from '../lib/config.ts';
import type { Clock } from '../lib/clock.ts';
import type { LinkStatus } from '../lib/remote/link-socket.ts';
import type { RunningLink } from '../lib/remote/types-core.ts';
import type { SshSpec } from '../lib/remote/types-rest.ts';
import type { Link, LinkStateWord } from '../lib/room/types.ts';
import { rc, sn, mid, tokenOf, wordOf } from './support/brands.ts';

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('links: one private file per room; get, set, remove, list; a bad code or shape is refused', t => {
  const home = h.freshHome(t);
  const l: Link = { code: rc('vole-1234'), transport: { kind: 'pipe', home: '/h' }, invite: wordOf('sh1.x'), created_at: 'now' };
  assert.equal(links.get(rc('vole-1234')), null);
  assert.deepEqual(links.set(rc('vole-1234'), l), l);
  assert.deepEqual(links.get(rc('vole-1234')), l);
  assert.deepEqual([mode(links.linksDir()), mode(path.join(home, 'links', 'vole-1234.json'))], [0o700, 0o600]);
  links.set(rc('otter-0001'), { ...l, code: rc('otter-0001'), invite: undefined, token: tokenOf('t') });
  assert.deepEqual(links.list(), [rc('otter-0001'), rc('vole-1234')]);
  assert.equal(links.get('../x'), null);
  // @ts-expect-error: not a room code, refused at run time
  assert.throws(() => links.set('../x', l), (e: RoomError) => e.code === 'INVALID');
  assert.throws(() => links.set(rc('vole-1234'), { ...l, invite: undefined }), (e: RoomError) => e.code === 'INVALID', 'no credential');
  assert.throws(() => links.set(rc('vole-1234'), { ...l, code: rc('otter-0001') }), (e: RoomError) => e.code === 'INVALID');
  assert.equal(links.remove(rc('vole-1234')), true);
  assert.equal(links.remove(rc('vole-1234')), false);
  assert.deepEqual(links.list(), [rc('otter-0001')]);
  assert.equal(links.logFile(rc('otter-0001')), path.join(home, 'links', 'otter-0001.log'));
});

test('store modes: a new home and every store directory are 0700; a home an older version made 0755 is repaired on open', t => {
  const home = h.freshHome(t);
  fs.rmSync(home, { recursive: true });
  const code = h.newRoom();
  h.register('alice', 'member', process.pid, code);
  store.open(code).append({ kind: 'status', text: 'x' }, { via: 'system', from: 'room', system: true });
  writeJsonAtomic(path.join(home, 'rooms', code, 'presence', 'alice.json'), { state: 'idle' });
  links.set(rc('vole-1234'), { code: rc('vole-1234'), transport: { kind: 'pipe', home: '/x' }, invite: wordOf('i'), created_at: 'now' });
  const dirs = [home, ...fs.readdirSync(home, { recursive: true }).map(f => path.join(home, f as string)).filter(f => fs.statSync(f).isDirectory())];
  assert.ok(dirs.length >= 6, dirs.join(' '));
  for (const d of dirs) assert.equal(mode(d), 0o700, d);
  // an old home: 0755 everywhere
  const old = h.freshHome(t);
  for (const d of [old, path.join(old, 'rooms'), path.join(old, 'sessions'), path.join(old, 'rooms', rc('vole-1234'))]) {
    fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(d, 0o755);
  }
  store.open(rc('vole-1234'));
  for (const d of [old, path.join(old, 'rooms'), path.join(old, 'sessions')]) assert.equal(mode(d), 0o700, d);
  assert.equal(mode(path.join(old, 'rooms', rc('vole-1234'))), 0o755, 'below the home only new directories: the home closes them');
});

test('store.open: a linked code is a mirror (isHost false) and exists before its directory does', t => {
  h.freshHome(t);
  assert.equal(store.roomExists(rc('vole-1234')), false);
  links.set(rc('vole-1234'), { code: rc('vole-1234'), transport: { kind: 'pipe', home: '/h' }, token: tokenOf('t') });
  assert.equal(store.roomExists(rc('vole-1234')), true);
  const s = store.open(rc('vole-1234'));
  assert.ok(s instanceof MirrorRoomStore);
  assert.equal(s.isHost, false);
  assert.equal(store.open(h.newRoom()).isHost, true);
});

test('link: the socket path is short whatever the home; locators name a home, never a command; handle is OFFLINE with no daemon', async t => {
  const deep = path.join('/', 'x'.repeat(200), 'rooms', rc('vole-1234'));
  const p = linkSocket.socketPath(deep);
  assert.ok(Buffer.byteLength(p) < 104, p);
  assert.ok(p.startsWith(`/tmp/sub-human-${process.getuid!()}/`), p);
  assert.notEqual(linkSocket.socketPath(deep + 'x'), p);
  assert.equal(linkSocket.socketPath('/h/rooms/vole-1234'), '/h/rooms/vole-1234/.link/link.sock', 'a short home: in the mirror');
  // never TMPDIR: a daemon and a hook with different ones agree
  const old = process.env.TMPDIR;
  process.env.TMPDIR = h.tmpDir('sh-tmpdir-', t);
  try { assert.equal(linkSocket.socketPath(deep), p); } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
  // a hook tries the recorded path, then the computed one
  assert.deepEqual(linkSocket.socketPaths('/h/rooms/vole-1234', { socket: '/r/link.sock' }), ['/r/link.sock', '/h/rooms/vole-1234/.link/link.sock']);
  assert.deepEqual(linkSocket.socketPaths('/h/rooms/vole-1234', { socket: 'rel.sock' }), ['/h/rooms/vole-1234/.link/link.sock'], 'a relative recorded path is ignored');
  assert.equal(linkConnect.pipeLocator('/a/home'), 'pipe:/a/home');
  assert.deepEqual(linkConnect.transportOf('pipe:/a/home'), { kind: 'pipe', home: '/a/home' });
  for (const bad of ['pipe:relative', 'pipe:', '', 'tcp:host:22']) assert.equal(linkConnect.transportOf(bad), null, bad);
  await assert.rejects(linkSocket.handle('append', { socket: path.join(h.tmpDir('sh-sock-', t), 'none.sock'), params: {} }), (e: RoomError) => e.code === 'OFFLINE');
  await assert.rejects(linkSocket.handle('subscribe', { socket: '/x', params: {} }), (e: RoomError) => e.code === 'PROTOCOL', 'only the hooks\' ops are relayed');
});

test('link: handle tries each socket in order; a missing one, or one in a directory open to others, is skipped', async t => {
  const serve = (file: string, result: unknown) => new Promise<void>(resolve => {
    const srv = net.createServer(s => { const dec = protocol.decoder(); s.on('data', c => { for (const f of dec.push(c)) s.end(protocol.encode(protocol.reply(f.id!, result))); }); });
    t.after(() => srv.close());
    srv.listen(file, resolve);
  });
  const mine = h.tmpDir('sh-sock-', t), open = h.tmpDir('sh-open-', t);
  fs.chmodSync(mine, 0o700);
  fs.chmodSync(open, 0o755);
  await serve(path.join(open, 'l.sock'), { ok: false, who: 'not ours' });
  await serve(path.join(mine, 'l.sock'), { ok: true, who: 'the daemon' });
  const r = await linkSocket.handle('beat', { socket: [path.join(open, 'l.sock'), path.join(mine, 'none.sock'), path.join(mine, 'l.sock')], params: {} });
  assert.deepEqual(r, { ok: true, who: 'the daemon' });
  await assert.rejects(linkSocket.handle('beat', { socket: [path.join(open, 'l.sock')], params: {} }), (e: RoomError) => e.code === 'OFFLINE', 'never one in an open directory');
});

test('link: an ssh locator is a plain user@host[:port]; an invite can name neither an ssh option nor a command', () => {
  assert.deepEqual(linkConnect.transportOf('ssh:me@host'), { kind: 'ssh', user: 'me', host: 'host' });
  assert.deepEqual(linkConnect.transportOf('ssh:host@127.0.0.1:2222'), { kind: 'ssh', user: 'host', host: '127.0.0.1', port: 2222 });
  assert.deepEqual(linkConnect.transportOf('ssh:a_b.c-d@dev.example.com:22'), { kind: 'ssh', user: 'a_b.c-d', host: 'dev.example.com', port: 22 });
  assert.equal(linkConnect.sshLocator('me@far:2222'), 'ssh:me@far:2222');
  const bad = [
    '-oProxyCommand=sh@host', 'me@-oProxyCommand=sh', 'me@host -oProxyCommand=sh', 'me@host;id', 'me@host:22 id', 'me@host:0',
    'me@host:65536', 'me@host:-1', 'me@', '@host', 'host', 'me@ho st', 'me@host\n-oX', "me@ho'st", 'me@ho"st', 'me@%h', 'me@a@b',
    'me@[::1]', 'me@host:22:22', 'm e@host', '-l@host', 'me@host:2a',
  ];
  for (const d of bad) {
    assert.equal(linkConnect.transportOf(`ssh:${d}`), null, d);
    assert.equal(linkConnect.sshLocator(d), null, d);
  }
});

test('link: the ssh command: BatchMode, this machine\'s own options, the port, "--" before the destination, a fixed remote command', () => {
  const cmd = linkConnect.sshCommand({ kind: 'ssh', user: 'me', host: 'far', port: 2222 }, rc('vole-1234'), ['-i', '/k/id', '-o', 'UserKnownHostsFile=/k/kh']);
  assert.deepEqual(cmd, ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-i', '/k/id', '-o', 'UserKnownHostsFile=/k/kh', '-p', '2222', '--', 'me@far', 'sub-human serve --stdio vole-1234']);
  const old = process.env.SUB_HUMAN_SSH_OPTS;
  process.env.SUB_HUMAN_SSH_OPTS = ' -F /dev/null  -i /k/id ';
  try { assert.deepEqual(linkConnect.sshCommand({ kind: 'ssh', user: 'me', host: 'far' }, rc('vole-1234')).slice(8, -3), ['-F', '/dev/null', '-i', '/k/id']); } finally {
    if (old === undefined) delete process.env.SUB_HUMAN_SSH_OPTS; else process.env.SUB_HUMAN_SSH_OPTS = old;
  }
  // a link file edited by hand is checked again
  assert.throws(() => linkConnect.sshCommand({ kind: 'ssh', user: '-oProxyCommand=sh', host: 'far' }, rc('vole-1234'), []), (e: RoomError) => e.code === 'INVALID');
  // @ts-expect-error: not a room code, refused at run time
  assert.throws(() => linkConnect.sshCommand({ kind: 'ssh', user: 'me', host: 'far' }, 'vole-1234; id', []), (e: RoomError) => e.code === 'INVALID');
});

test('ssh: a ProxyJump rides the locator (?via=), as plain as the destination; the link\'s own options pin the host key and the key; prime opens a ControlMaster the daemon rides under BatchMode', t => {
  assert.deepEqual(linkConnect.transportOf('ssh:me@far:2222?via=bastion'), { kind: 'ssh', user: 'me', host: 'far', port: 2222, via: 'bastion' });
  assert.deepEqual(linkConnect.transportOf('ssh:me@far?via=ops@jump.example:2200,jump2'), { kind: 'ssh', user: 'me', host: 'far', via: 'ops@jump.example:2200,jump2' });
  assert.equal(linkConnect.sshLocator('me@far', { via: 'bastion' }), 'ssh:me@far?via=bastion');
  for (const bad of ['ssh:me@far?via=-oProxyCommand=sh', 'ssh:me@far?via=a b', 'ssh:me@far?via=', 'ssh:me@far?jump=x', 'ssh:me@far?via=x?via=y',
    'ssh:me@far?via=%h', 'ssh:me@far?via=j:0', 'ssh:me@far?via=a,b,c,d,e']) assert.equal(linkConnect.transportOf(bad), null, bad);
  assert.equal(linkConnect.sshLocator('me@far', { via: '-J' }), null);

  const home = h.freshHome(t);
  const spec: SshSpec = { kind: 'ssh', user: 'me', host: 'far', via: 'bastion', key: '/k/id_ed25519', knownHosts: '/k/known_hosts', alias: 'sub-human-vole-1234' };
  const local = ['-i', '/k/id_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'UserKnownHostsFile=/k/known_hosts', '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=sub-human-vole-1234'];
  assert.deepEqual(ssh.command(spec, rc('vole-1234'), []).slice(8), [...local, '-J', 'bastion', '--', 'me@far', 'sub-human serve --stdio vole-1234']);
  // SUB_HUMAN_SSH_OPTS comes after the pinned options (ssh takes the first value), so it cannot weaken them
  const withOpts = ssh.command(spec, rc('vole-1234'), ['-o', 'StrictHostKeyChecking=no']);
  assert.ok(withOpts.indexOf('StrictHostKeyChecking=yes') < withOpts.indexOf('StrictHostKeyChecking=no'), withOpts.join(' '));
  const cp = path.join(home, 'ssh', 'cm-%C');
  assert.deepEqual(ssh.command({ ...spec, mux: true }, rc('vole-1234'), []).slice(2, 10), ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ControlMaster=no']);
  assert.ok(ssh.command({ ...spec, mux: true }, rc('vole-1234'), []).includes(`ControlPath=${cp}`), 'rides the primed master; never becomes one');
  const prime = ssh.primeCommand(spec, rc('vole-1234'), { opts: [] });
  assert.deepEqual(prime.slice(0, 6), ['ssh', '-M', '-N', '-f', '-o', 'ControlPersist=8h']);
  assert.ok(!prime.includes('BatchMode=yes'), 'the person answers the MFA prompt once');
  assert.ok(prime.includes(`ControlPath=${cp}`) && prime.includes('HostKeyAlias=sub-human-vole-1234'));
  assert.throws(() => ssh.primeCommand(spec, rc('vole-1234'), { persist: '8h; id' }), (e: RoomError) => e.code === 'INVALID');
  // the primed master too: SUB_HUMAN_SSH_OPTS after every pinned option, and before the destination
  const primeOpts = ssh.primeCommand(spec, rc('vole-1234'), { opts: ['-o', 'StrictHostKeyChecking=no', '-o', `ControlPath=/tmp/elsewhere`] });
  assert.ok(primeOpts.indexOf('StrictHostKeyChecking=yes') < primeOpts.indexOf('StrictHostKeyChecking=no'), primeOpts.join(' '));
  assert.ok(primeOpts.indexOf(`ControlPath=${cp}`) < primeOpts.indexOf('ControlPath=/tmp/elsewhere'), primeOpts.join(' '));
  assert.ok(primeOpts.indexOf('StrictHostKeyChecking=no') < primeOpts.indexOf('--'), 'options before the destination');
  for (const bad of [{ key: '-oProxyCommand=x' }, { knownHosts: 'relative' }, { knownHosts: '/k/kh', alias: 'a b' }, { via: '-x' }]) {
    assert.throws(() => ssh.command({ ...spec, ...bad }, rc('vole-1234'), []), (e: RoomError) => e.code === 'INVALID', JSON.stringify(bad));
  }
});

test('mirror: applyLine appends a host line only when it chains; applyDoc writes only the room documents', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code) as store.FsRoomStore;
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  const lines = () => fs.readFileSync(host.logFile, 'utf8').split('\n').filter(Boolean);
  host.append({ kind: 'status', text: 'one' }, { via: 'system', from: 'room', system: true });
  host.append({ kind: 'status', text: 'two' }, { via: 'system', from: 'room', system: true });
  assert.throws(() => mirror.applyLine(lines()[1]), (e: RoomError) => e.code === 'FORK', 'a gap');
  assert.equal(mirror.applyLine(lines()[0]).text, 'one');
  assert.throws(() => mirror.applyLine(lines()[0]), (e: RoomError) => e.code === 'FORK', 'a duplicate');
  assert.throws(() => mirror.applyLine(JSON.stringify({ ...JSON.parse(lines()[1]), prev: '000000000000' })), (e: RoomError) => e.code === 'FORK');
  mirror.applyLine(lines()[1]);
  assert.equal(fs.readFileSync(mirror.logFile, 'utf8'), fs.readFileSync(host.logFile, 'utf8'));
  assert.throws(() => mirror.applyLine('{nope'), (e: RoomError) => e.code === 'PROTOCOL');
  mirror.applyDoc('members', { bob: { name: 'bob' } });
  mirror.applyDoc('presence/bob', { state: 'idle' });
  assert.deepEqual([mirror.members.read(), mirror.kv.get('presence/bob')], [{ bob: { name: 'bob' } }, { state: 'idle' }]);
  mirror.applyDoc('members', { bob: { name: 'bob' } });
  mirror.applyDoc('presence/bob', null);
  assert.deepEqual(mirror.kv.list('presence/'), []);
  assert.throws(() => mirror.applyDoc('rows/x', {}), (e: RoomError) => e.code === 'PROTOCOL');
  mirror.reset();
  assert.deepEqual([mirror.readAll(), mirror.members.read()], [[], {}]);
});

test('link: a mirror that is not the host\'s prefix is a FORK: the daemon stops and says so; after reset() it copies the room again', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code) as store.FsRoomStore;
  for (const text of ['a', 'b']) host.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true });
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(linkSocket.socketPath(mirror.dir)), { recursive: true, force: true }));
  mirror.applyLine(JSON.stringify({ id: 1, at: new Date().toISOString(), from: 'room', via: 'system', kind: 'status', to: 'room', text: 'not the host\'s', prev: store.hash12('') }));
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: mid('m1'), seats: [] });
  const sessions: ReturnType<typeof server.serve>[] = [];
  const connect = () => {
    const [a, b] = memory.pair();
    sessions.push(server.serve(b, { store: host }));
    return client.connect(a, { machine: mid('m1'), token });
  };
  t.after(() => sessions.forEach(s => s.close()));
  const logged: string[] = [];
  const forked = await link.serveMirror({ mirror, connect, log: m => logged.push(m) });
  assert.match(await forked.done, /not the mirror's/);
  assert.equal(forked.state(), 'fork');
  assert.deepEqual([mirror.kv.get('link').state, mirror.kv.get('link').pid], ['fork', process.pid]);
  assert.match(logged.join('\n'), new RegExp(`FORK in room ${code}.*sub-human link --reset ${code}`));
  assert.equal(mirror.readAll()[0].text, 'not the host\'s', 'nothing repaired');

  mirror.reset();
  const again = await link.serveMirror({ mirror, connect });
  await h.until(() => again.state() === 'online' && fs.existsSync(mirror.logFile) && fs.readFileSync(mirror.logFile, 'utf8') === fs.readFileSync(host.logFile, 'utf8'), 3000, 10);
  assert.equal(fs.readFileSync(mirror.logFile, 'utf8'), fs.readFileSync(host.logFile, 'utf8'));
  again.stop('done');
  assert.equal(await again.done, 'done');
  assert.equal(fs.existsSync(linkSocket.socketPath(mirror.dir)), false, 'the socket is gone with it');
});

test('skew: a newer host\'s unknown entry kind, via and fields, an unknown document and an unknown event keep the link online; readers show them, never as a person\'s words', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(linkSocket.socketPath(mirror.dir)), { recursive: true, force: true }));
  const at = new Date().toISOString();
  const lines: string[] = [];
  const add = (e: Record<string, unknown>) => { lines.push(JSON.stringify({ id: lines.length + 1, at, to: 'room', ...e, prev: store.hash12(lines.at(-1) || '') })); };
  add({ from: 'room', via: 'system', kind: 'link_admitted', text: 'a future room line', future: { nested: true } });
  add({ from: 'bob', via: 'relay', kind: 'say', text: 'not bob\'s own words' });
  add({ from: 'bob', via: 'agent', kind: 'say', text: 'plain', reactions: ['+1'] });
  // a host of protocol N+1 (plugin 9.0.0): it streams what this version has never seen
  const connect = () => {
    const [a, b] = memory.pair();
    b.onFrame(f => {
      if (f.op === 'hello') return b.send(protocol.reply(f.id!, { v: protocol.PROTO.max, proto: { min: 1, max: protocol.PROTO.max + 1 }, server: '9.0.0', caps: {}, room: code, link: 'abcdef012345', newField: 1 }));
      if (f.op !== 'subscribe') return undefined;
      b.send(protocol.reply(f.id!, { ok: true }));
      // @ts-expect-error deliberate: an event this version does not know
      b.send(protocol.event(f.id!, 'ping', { t: 1 }));
      b.send(protocol.event(f.id!, 'doc', { key: 'links', value: { x: 1 } }));
      // @ts-expect-error deliberate: a doc event with no data
      b.send(protocol.event(f.id!, 'doc', null));
      for (const l of lines) b.send(protocol.event(f.id!, 'entry', l));
      return b.send(protocol.event(f.id!, 'doc', { key: 'presence/bob', value: { state: 'idle', mood: 'new field' } }));
    });
    return client.connect(a, { machine: mid('m1'), token: tokenOf('tok') });
  };
  const logged: string[] = [];
  const l = await link.serveMirror({ mirror, connect, log: m => logged.push(m) });
  t.after(() => l.stop('done'));
  await h.until(() => mirror.kv.get('presence/bob'), 3000, 10);
  assert.equal(l.state(), 'online', logged.join('\n'));
  assert.equal(fs.readFileSync(mirror.logFile, 'utf8'), lines.join('\n') + '\n', 'every line kept verbatim');
  assert.match(logged.join('\n'), /skipped: the host streamed "links"/);
  const es = mirror.readAll();
  const chat = es.map(e => room.chatLines(e, { viewer: 'alice', entries: es }).join(' / '));
  assert.deepEqual(chat, ['room: a future room line', 'bob (via relay): not bob\'s own words', 'bob\'s Claude: plain']);
  assert.ok(es.every(e => typeof room.line(e, { full: true }) === 'string'));
  assert.equal(typeof render.digest(es, { members: {}, code }), 'string');
  assert.deepEqual(es.map(e => lane({ name: 'alice', role: 'member' }, e, es)), ['pull', 'pull', 'pull'], 'nothing unknown wakes anyone');
});

test('link: a lost connection is retried with decorrelated jitter: each delay in [retryMs, 3 x the last], at most retryMaxMs', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(linkSocket.socketPath(mirror.dir)), { recursive: true, force: true }));
  const at: number[] = [];
  const connect = () => { at.push(Date.now()); return Promise.reject(new RoomError('OFFLINE', 'no route')); };
  // random() = 1: the top of each range, so the delays grow 3x per failure up to the cap. The delays are read from
  // what the daemon asks its clock for: the gaps between attempts also measured how late a loaded machine fires
  // timers, and an upper bound on them failed under load. Never online here, so every timer it sets is a retry.
  const asked: number[] = [];
  const clock: Clock = { ...realClock, setTimeout: (fn, ms) => { asked.push(ms as number); return realClock.setTimeout(fn, ms); } };
  const l = await link.serveMirror({ mirror, connect, retryMs: 40, retryMaxMs: 400, random: () => 1, watch: false, seats: () => [], clock });
  await h.until(() => at.length >= 5, 30_000, 5);
  l.stop('done');
  assert.deepEqual(asked.slice(0, 4), [120, 360, 400, 400]);
  const gaps = at.slice(1, 5).map((x, i) => x - at[i]);
  gaps.forEach((g, i) => assert.ok(g >= asked[i] - 5, `gap ${i}: ${g} ms, under the ${asked[i]} ms asked: ${gaps}`));
  assert.deepEqual([config.LINK_RETRY_MS, config.LINK_RETRY_MAX_MS], [1000, 10_000]);
});

test('link: the daemon stops with no seat of this machine left, offline too (by the live session indexes); never while connecting', async t => {
  const home = h.freshHome(t);
  const code = rc('vole-1234');
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: tokenOf('t') });
  store.createRoom(code);
  const mirror = store.open(code) as MirrorRoomStore; // linked above: a mirror
  const seat = (extra = {}) => ({ bob: { name: 'bob', role: 'member', machine: identity.machineId(), joined_at: new Date().toISOString(), seen_at: new Date().toISOString(), ...extra } });
  const sleeper = h.spawnSleeper(60);
  writeJsonAtomic(path.join(home, 'sessions', 'by-pid', `${sleeper.pid}.json`), { code, name: sn('bob'), role: 'member', pid: sleeper.pid, pid_start: pidStart(sleeper.pid), session_id: null, address: `bob.${code}` });
  let state: LinkStateWord = 'offline', stopped: string | null = null;
  // the two parts of a running link idleWatch uses
  const watch = () => link.idleWatch({ state: () => state, stop: why => { stopped = why; } } as RunningLink, mirror, 150);

  // offline: the host's document is stale (an old lease), but bob's claude process lives: the daemon keeps retrying
  mirror.applyDoc('members', seat({ seen_at: new Date(0).toISOString() }));
  assert.deepEqual(identity.localSeats(code), ['bob']);
  let unwatch = watch();
  await h.sleep(600);
  assert.equal(stopped, null);
  // bob's session crashed (no SessionEnd, so no leave reached the host): the daemon stops
  process.kill(sleeper.pid!, 'SIGKILL');
  await h.until(() => stopped, 3000, 20);
  unwatch();
  assert.equal(stopped, 'no seat of this machine is left in the room');
  assert.deepEqual(identity.localSeats(code), []);

  // connecting (the first connection, before a join's seat exists): never
  stopped = null; state = 'connecting';
  unwatch = watch();
  await h.sleep(600);
  assert.equal(stopped, null);
  unwatch();

  // online: the host's document decides, as before: a fresh lease keeps it, a left seat stops it
  state = 'online';
  mirror.applyDoc('members', seat());
  unwatch = watch();
  await h.sleep(600);
  assert.equal(stopped, null);
  mirror.applyDoc('members', seat({ left_at: new Date().toISOString() }));
  await h.until(() => stopped, 3000, 20);
  unwatch();
  assert.equal(stopped, 'no seat of this machine is left in the room');
});

test('link: online, a seat whose lease lapsed during a pause but whose claude process lives keeps the daemon (issue #7); a dead or left one stops it; a late tick is a sleep, not idle', async t => {
  const home = h.freshHome(t);
  const code = rc('vole-1234');
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: tokenOf('t') });
  store.createRoom(code);
  const mirror = store.open(code) as MirrorRoomStore; // linked above: a mirror
  const seat = (extra = {}) => ({ bob: { name: 'bob', role: 'member', machine: identity.machineId(), joined_at: new Date().toISOString(), seen_at: new Date(0).toISOString(), ...extra } });
  const index = (s: { pid?: number }) => writeJsonAtomic(path.join(home, 'sessions', 'by-pid', `${s.pid}.json`), { code, name: sn('bob'), role: 'member', pid: s.pid, pid_start: pidStart(s.pid), session_id: null, address: `bob.${code}` });
  let stopped: string | null = null;
  const watches: (() => void)[] = [];
  t.after(() => watches.forEach(u => u())); // a failed assertion must not leave an interval keeping the run alive
  const watch = (state: LinkStateWord, opts?: Parameters<typeof link.idleWatch>[3]) => { const u = link.idleWatch({ state: () => state, stop: why => { stopped = why; } } as RunningLink, mirror, 150, opts); watches.push(u); return u; };

  // (a) online after a pause: the host's document still shows bob's lease as lapsed, but bob's claude process lives
  const sleeper = h.spawnSleeper(60);
  index(sleeper);
  mirror.applyDoc('members', seat());
  let unwatch = watch('online');
  await h.sleep(600);
  assert.equal(stopped, null);
  // (b) bob's session died: nothing holds the seat any more
  process.kill(sleeper.pid!, 'SIGKILL');
  await h.until(() => stopped, 3000, 20);
  unwatch();
  assert.equal(stopped, link.NO_SEAT_REASON);

  // (c) a live process, but the host shows the seat as left: the person joins again, the daemon stops
  stopped = null;
  const other = h.spawnSleeper(60);
  index(other);
  assert.deepEqual(identity.localSeats(code), ['bob']);
  mirror.applyDoc('members', seat({ left_at: new Date().toISOString() }));
  unwatch = watch('online');
  await h.until(() => stopped, 3000, 20);
  unwatch();
  assert.equal(stopped, link.NO_SEAT_REASON);
  other.kill('SIGKILL');

  // (d) no seat, but a tick that comes far later than asked (the machine slept): the count restarts, no stop
  stopped = null;
  let clock = 1_000_000;
  unwatch = watch('offline', { now: () => clock, gapMs: 5000 });
  await h.sleep(400);
  clock += 60_000;
  await h.sleep(600);
  assert.equal(stopped, null, 'the late tick is skipped, its time not counted');
  clock += 150; // then idleMs of awake time with no seat stops it
  await h.until(() => stopped, 3000, 20);
  unwatch();
  assert.equal(stopped, link.NO_SEAT_REASON);
});

test('tail: one line for a link that is not online, keyed fork, stopped or offline; none while it is online or connecting', () => {
  // a running link's status without its pid: the fields linkLine reads
  assert.equal(linkLine({ running: true, state: 'online' } as LinkStatus, rc('vole-1234')), null);
  assert.equal(linkLine({ running: true, state: 'connecting' } as LinkStatus, rc('vole-1234')), null);
  assert.deepEqual(linkLine({ running: false, state: 'fork' }, rc('vole-1234')), {
    key: 'fork', text: 'this machine\'s copy of room vole-1234 no longer matches the host\'s. Run /sub-human doctor.' });
  assert.match(linkLine({ running: false, state: 'fork', queued: 3 }, rc('vole-1234'))!.text, /host's; 3 @room post\(s\) are kept, not sent\. Run \/sub-human doctor\./);
  assert.deepEqual(linkLine({ running: true, state: 'offline', reason: 'the link closed' } as LinkStatus, rc('vole-1234')), {
    key: 'offline', text: 'the connection to room vole-1234 is down (the link closed); @room posts wait and go out when it\'s back, card answers can\'t be sent until then' });
  assert.match(linkLine({ running: false }, rc('vole-1234'))!.text, /the connection to room vole-1234 isn't running; .*Type \/sub-human to reconnect\./);
  assert.deepEqual(linkLine({ running: false, state: 'stopped', reason: 'the room was closed' }, rc('vole-1234')), {
    key: 'stopped', text: 'the connection to room vole-1234 stopped (the room was closed); @room posts can\'t be sent. Run /sub-human doctor.' });
});

test('link: a join the host let in whose person has not typed /sub-human yet keeps its daemon (live: NO_SEAT after 60 s)', async t => {
  h.freshHome(t);
  const code = rc('vole-4321');
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: tokenOf('t'), join_as: 'bob', join_sid: 'sid-1', created_at: new Date().toISOString() });
  store.createRoom(code);
  const mirror = store.open(code) as MirrorRoomStore;
  let stopped: string | null = null;
  const unwatch = link.idleWatch({ state: () => 'online', stop: why => { stopped = why; } } as RunningLink, mirror, 150);
  t.after(unwatch);
  await h.sleep(500);
  assert.equal(stopped, null, 'let in, its seat not taken yet: kept');
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: tokenOf('t') }); // the seat taken: join_as gone
  await h.until(() => stopped, 3000, 20);
  assert.equal(stopped, link.NO_SEAT_REASON);
});

test('join news: what the join command already said is not said again by the tail', async t => {
  h.freshHome(t);
  const joining = await import('../lib/remote/joining.ts');
  const hosting = await import('../lib/remote/hosting.ts');
  const code = rc('vole-9876');
  const pin = { at: new Date().toISOString(), left: 5 };
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, invite: wordOf('x'), join_as: 'bob', join_sid: 'sid-1', pin_wanted: pin, created_at: new Date().toISOString() });
  const said = hosting.joinText(code, sn('bob'), { state: 'pin' });
  links.set(code, { ...links.get(code)!, join_told: said });
  const n = joining.pendingNews('sid-1')!;
  assert.deepEqual([n.state, n.text], ['pin', ''], 'the command said it: the tail says nothing');
  links.set(code, { ...links.get(code)!, join_told: 'something else' });
  assert.equal(joining.pendingNews('sid-1')!.text, said);
});
