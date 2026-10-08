'use strict';
// The link registry (lib/room/links.js), the link daemon's pieces (lib/remote/link.js: socket path, locator,
// handle, serveMirror's FORK and re-mirror, idleWatch) and the mirror's own writes (lib/room/store-mirror.js
// applyLine, applyDoc), and the tail's one line for a link that is down (lib/tail.js linkLine). docs/archive/REMOTE-PLAN.md PR5;
// the mirror through the bridge is in test/store-contract.test.js (remote), two homes in test/remote-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const links = require(path.join(h.LIB, 'room', 'links.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const server = require(path.join(h.LIB, 'remote', 'server.js'));
const client = require(path.join(h.LIB, 'remote', 'client.js'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.js'));
const { MirrorRoomStore } = require(path.join(h.LIB, 'room', 'store-mirror.js'));
const { linkLine } = require(path.join(h.LIB, 'tail.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const { writeJsonAtomic } = require(path.join(h.LIB, 'io.js'));
const { pidStart } = require(path.join(h.LIB, 'lock.js'));

const mode = p => fs.statSync(p).mode & 0o777;

test('links: one private file per room; get, set, remove, list; a bad code or shape is refused', t => {
  const home = h.freshHome(t);
  const l = { code: 'vole-1234', transport: { kind: 'pipe', home: '/h' }, invite: 'sh1.x', created_at: 'now' };
  assert.equal(links.get('vole-1234'), null);
  assert.deepEqual(links.set('vole-1234', l), l);
  assert.deepEqual(links.get('vole-1234'), l);
  assert.deepEqual([mode(links.linksDir()), mode(path.join(home, 'links', 'vole-1234.json'))], [0o700, 0o600]);
  links.set('otter-0001', { ...l, code: 'otter-0001', invite: undefined, token: 't' });
  assert.deepEqual(links.list(), ['otter-0001', 'vole-1234']);
  assert.equal(links.get('../x'), null);
  assert.throws(() => links.set('../x', l), e => e.code === 'INVALID');
  assert.throws(() => links.set('vole-1234', { ...l, invite: undefined }), e => e.code === 'INVALID', 'no credential');
  assert.throws(() => links.set('vole-1234', { ...l, code: 'otter-0001' }), e => e.code === 'INVALID');
  assert.equal(links.remove('vole-1234'), true);
  assert.equal(links.remove('vole-1234'), false);
  assert.deepEqual(links.list(), ['otter-0001']);
  assert.equal(links.logFile('otter-0001'), path.join(home, 'links', 'otter-0001.log'));
});

test('store.open: a linked code is a mirror (isHost false) and exists before its directory does', t => {
  h.freshHome(t);
  assert.equal(store.roomExists('vole-1234'), false);
  links.set('vole-1234', { code: 'vole-1234', transport: { kind: 'pipe', home: '/h' }, token: 't' });
  assert.equal(store.roomExists('vole-1234'), true);
  const s = store.open('vole-1234');
  assert.ok(s instanceof MirrorRoomStore);
  assert.equal(s.isHost, false);
  assert.equal(store.open(h.newRoom()).isHost, true);
});

test('link: the socket path is short whatever the home; locators name a home, never a command; handle is OFFLINE with no daemon', async t => {
  const deep = path.join('/', 'x'.repeat(200), 'rooms', 'vole-1234');
  const p = link.socketPath(deep);
  assert.ok(Buffer.byteLength(p) < 104, p);
  assert.ok(p.startsWith(os.tmpdir()));
  assert.notEqual(link.socketPath(deep + 'x'), p);
  assert.equal(link.pipeLocator('/a/home'), 'pipe:/a/home');
  assert.deepEqual(link.transportOf('pipe:/a/home'), { kind: 'pipe', home: '/a/home' });
  for (const bad of ['pipe:relative', 'ssh:me@host', 'pipe:', '']) assert.equal(link.transportOf(bad), null, bad);
  await assert.rejects(link.handle('append', { socket: path.join(h.tmpDir('sh-sock-', t), 'none.sock'), params: {} }), e => e.code === 'OFFLINE');
  await assert.rejects(link.handle('subscribe', { socket: '/x', params: {} }), e => e.code === 'PROTOCOL', 'only the hooks\' ops are relayed');
});

test('mirror: applyLine appends a host line only when it chains; applyDoc writes only the room documents', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  const lines = () => fs.readFileSync(host.logFile, 'utf8').split('\n').filter(Boolean);
  host.append({ kind: 'status', text: 'one' }, { via: 'system', from: 'room', system: true });
  host.append({ kind: 'status', text: 'two' }, { via: 'system', from: 'room', system: true });
  assert.throws(() => mirror.applyLine(lines()[1]), e => e.code === 'FORK', 'a gap');
  assert.equal(mirror.applyLine(lines()[0]).text, 'one');
  assert.throws(() => mirror.applyLine(lines()[0]), e => e.code === 'FORK', 'a duplicate');
  assert.throws(() => mirror.applyLine(JSON.stringify({ ...JSON.parse(lines()[1]), prev: '000000000000' })), e => e.code === 'FORK');
  mirror.applyLine(lines()[1]);
  assert.equal(fs.readFileSync(mirror.logFile, 'utf8'), fs.readFileSync(host.logFile, 'utf8'));
  assert.throws(() => mirror.applyLine('{nope'), e => e.code === 'PROTOCOL');
  mirror.applyDoc('members', { bob: { name: 'bob' } });
  mirror.applyDoc('presence/bob', { state: 'idle' });
  assert.deepEqual([mirror.members.read(), mirror.kv.get('presence/bob')], [{ bob: { name: 'bob' } }, { state: 'idle' }]);
  mirror.applyDoc('presence/bob', null);
  assert.deepEqual(mirror.kv.list('presence/'), []);
  assert.throws(() => mirror.applyDoc('rows/x', {}), e => e.code === 'PROTOCOL');
  mirror.reset();
  assert.deepEqual([mirror.readAll(), mirror.members.read()], [[], {}]);
});

test('link: a mirror that is not the host\'s prefix is a FORK: the daemon stops and says so; after reset() it copies the room again', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  for (const text of ['a', 'b']) host.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true });
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(link.socketPath(mirror.dir)), { recursive: true, force: true }));
  mirror.applyLine(JSON.stringify({ id: 1, at: new Date().toISOString(), from: 'room', via: 'system', kind: 'status', to: 'room', text: 'not the host\'s', prev: store.hash12('') }));
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token } = auth.redeemInvite(host, secret, { machine: 'm1' });
  const sessions = [];
  const connect = () => {
    const [a, b] = memory.pair();
    sessions.push(server.serve(b, { store: host }));
    return client.connect(a, { machine: 'm1', token });
  };
  t.after(() => sessions.forEach(s => s.close()));
  const logged = [];
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
  assert.equal(fs.existsSync(link.socketPath(mirror.dir)), false, 'the socket is gone with it');
});

test('link: the daemon stops with no seat of this machine left, offline too (by the live session indexes); never while connecting', async t => {
  const home = h.freshHome(t);
  const code = 'vole-1234';
  links.set(code, { code, transport: { kind: 'pipe', home: '/h' }, token: 't' });
  store.createRoom(code);
  const mirror = store.open(code);
  const seat = (extra = {}) => ({ bob: { name: 'bob', role: 'member', machine: identity.machineId(), joined_at: new Date().toISOString(), seen_at: new Date().toISOString(), ...extra } });
  const sleeper = h.spawnSleeper(60);
  writeJsonAtomic(path.join(home, 'sessions', 'by-pid', `${sleeper.pid}.json`), { code, name: 'bob', role: 'member', pid: sleeper.pid, pid_start: pidStart(sleeper.pid), session_id: null, address: `bob.${code}` });
  let state = 'offline', stopped = null;
  const watch = () => link.idleWatch({ state: () => state, stop: why => { stopped = why; } }, mirror, 150);

  // offline: the host's document is stale (an old lease), but bob's claude process lives: the daemon keeps retrying
  mirror.applyDoc('members', seat({ seen_at: new Date(0).toISOString() }));
  assert.deepEqual(identity.localSeats(code), ['bob']);
  let unwatch = watch();
  await h.sleep(600);
  assert.equal(stopped, null);
  // bob's session crashed (no SessionEnd, so no leave reached the host): the daemon stops
  process.kill(sleeper.pid, 'SIGKILL');
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

test('tail: one line for a link that is down, keyed fork or offline; none while it is up', () => {
  assert.equal(linkLine({ running: true, state: 'online' }, 'vole-1234'), null);
  assert.equal(linkLine({ running: true, state: 'connecting' }, 'vole-1234'), null);
  assert.deepEqual(linkLine({ running: false, state: 'fork' }, 'vole-1234'), {
    key: 'fork', text: 'room link: FORK: this machine\'s copy of room vole-1234 no longer matches the host\'s; run sub-human link --reset vole-1234' });
  assert.deepEqual(linkLine({ running: true, state: 'offline', reason: 'the link closed' }, 'vole-1234'), {
    key: 'offline', text: 'room link: OFFLINE (the link closed); @room posts are refused until it is back' });
  assert.match(linkLine({ running: false }, 'vole-1234').text, /the link daemon is not running/);
  assert.match(linkLine({ running: false, state: 'stopped', reason: 'the room was closed' }, 'vole-1234').text, /the link stopped: the room was closed/);
});
