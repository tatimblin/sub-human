'use strict';
// Reconnect hardening in the link daemon (lib/remote/link.js): jittered backoff, the wake and network watchers on a
// fake clock, the outbox (lib/remote/outbox.js), and serveMirror in-process over the memory transport against a real
// server (lib/remote/server.js): a half-open link caught by a missed pong, make-before-break with no duplicate
// line, the outbox sent in order (never consent; "placed already" counts as sent; kept on FORK), a lapsed lease
// renewed with no log line, the link state file, the server closing a silent session, and an old server (no ping
// in its caps) never pinged. Two homes and real processes: test/remote-reconnect-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const outbox = require(path.join(h.LIB, 'remote', 'outbox.js'));
const protocol = require(path.join(h.LIB, 'remote', 'protocol.js'));
const server = require(path.join(h.LIB, 'remote', 'server.js'));
const client = require(path.join(h.LIB, 'remote', 'client.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const links = require(path.join(h.LIB, 'room', 'links.js'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.js'));
const clock = require(path.join(h.LIB, 'clock.js'));
const { leaseFresh } = require(path.join(h.LIB, 'room', 'members.js'));
const { RoomError } = require(path.join(h.LIB, 'room', 'validate.js'));
const { MirrorRoomStore } = require(path.join(h.LIB, 'room', 'store-mirror.js'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.js'));

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const REMOTE = 'remote0machine01';
const FAST = { pingMs: 40, pongMs: 60, deadMs: 250 };
const signed = (code, name, entry) => store.toPayload(code, entry, { via: 'human', from: name });
const say = (code, text) => signed(code, 'bob', { kind: 'say', text });
const lines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

// ---------- pure pieces ----------
test('reconnect: nextDelay is decorrelated jitter in [base, 3 x prev], capped', () => {
  assert.equal(link.nextDelay(1000, 1000, 10_000, () => 0), 1000);
  assert.equal(link.nextDelay(1000, 1000, 10_000, () => 1), 3000);
  assert.equal(link.nextDelay(3000, 1000, 10_000, () => 1), 9000);
  assert.equal(link.nextDelay(9000, 1000, 10_000, () => 1), 10_000, 'capped');
  assert.equal(link.nextDelay(9000, 1000, 10_000, () => 0), 1000, 'never below base');
  for (let i = 0; i < 200; i++) {
    const d = link.nextDelay(4000, 1000, 10_000);
    assert.ok(d >= 1000 && d <= 10_000, d);
  }
  const t = link.linkTimings();
  assert.deepEqual([t.retryMs, t.retryMaxMs, t.pingMs, t.pongMs, t.deadMs, t.wakeTickMs, t.wakeGapMs, t.netPollMs],
    [1000, 10_000, 15_000, 5000, 10_000, 2000, 5000, 5000]);
  assert.equal(link.linkTimings({ pingMs: 7, retryMs: undefined }).pingMs, 7);
});

test('reconnect: wakeWatch on a fake clock: a late tick or a wall clock off the monotonic one is a wake; steady ticks are not', () => {
  const c = clock.createFake({ now: 1_000_000 });
  let mono = 0;
  const woke = [];
  const unwatch = link.wakeWatch({ onWake: g => woke.push(g), tickMs: 1000, gapMs: 5000, clock: c, mono: () => mono });
  const tick = (ms = 1000) => { mono += ms; c.advance(ms); };
  for (let i = 0; i < 10; i++) tick();
  assert.deepEqual(woke, [], 'steady');
  // the machine slept 60 s: neither the timer nor the monotonic clock ran, the wall clock did
  c.set(c.now() + 60_000);
  tick();
  assert.equal(woke.length, 1);
  assert.ok(woke[0] >= 59_000, woke);
  tick();
  assert.equal(woke.length, 1, 'once');
  // the timer ran on time but the wall clock jumped against the monotonic one (a clock step)
  mono += 1000;
  c.set(c.now() + 7000);
  c.advance(1000);
  assert.equal(woke.length, 2);
  unwatch();
  c.set(c.now() + 60_000);
  tick();
  assert.equal(woke.length, 2, 'unwatched');
});

test('reconnect: netWatch calls onChange once per changed address set; netSignature ignores internal addresses and order', () => {
  const c = clock.createFake();
  let sig = 'en0/10.0.0.2';
  let changes = 0;
  const unwatch = link.netWatch({ onChange: () => changes++, pollMs: 5000, clock: c, signature: () => sig });
  c.advance(15_000);
  assert.equal(changes, 0);
  sig = 'en0/192.168.1.9';
  c.advance(5000);
  c.advance(5000);
  assert.equal(changes, 1);
  unwatch();
  const a = { lo0: [{ address: '127.0.0.1', internal: true }], en0: [{ address: '10.0.0.2', internal: false }, { address: 'fe80::1', internal: false }] };
  const b = { en0: [{ address: 'fe80::1', internal: false }, { address: '10.0.0.2', internal: false }] };
  assert.equal(link.netSignature(a), link.netSignature(b));
  assert.equal(link.netSignature(a), 'en0/10.0.0.2', 'link-local IPv6 is not a network change');
  assert.equal(link.netSignature({ en0: [{ address: '2001:db8::5', internal: false }] }), 'en0/2001:db8::5');
  assert.equal(typeof link.netSignature(), 'string');
});

test('outbox: only a signed @room post by a person is queueable; at most max, 0600, in order; old posts expire', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const p = say(code, 'hi');
  assert.equal(outbox.queueable(p), true);
  assert.equal(outbox.queueable(signed(code, 'bob', { kind: 'signoff', proposal_hash: 'abcdef012345' })), false, 'consent');
  assert.equal(outbox.queueable(signed(code, 'bob', { kind: 'objection', proposal_hash: 'abcdef012345' })), false, 'consent');
  assert.equal(outbox.queueable(store.toPayload(code, { kind: 'say', text: 'x' }, { via: 'agent', from: 'bob' })), false, 'an agent');
  assert.equal(outbox.queueable(store.toPayload(code, { kind: 'say', text: 'x', to: 'alice' }, { via: 'agent', from: 'bob' })), false);
  assert.equal(outbox.queueable({ ...p, nonce: undefined }), false, 'unsigned');
  assert.equal(outbox.queueable({ ...p, to: 'alice' }), false, 'addressed');
  const dir = h.tmpDir('sh-outbox-', t);
  const box = outbox.open(dir, { max: 3, ageMs: 1000 });
  assert.deepEqual([box.add(p, 0), box.add(say(code, 'two'), 500), box.add(say(code, 'three'), 900)], [1, 2, 3]);
  assert.throws(() => box.add(say(code, 'four')), e => e.code === 'OFFLINE' && /3 @room posts are queued already/.test(e.message));
  assert.equal(fs.statSync(box.file).mode & 0o777, 0o600);
  assert.deepEqual(outbox.open(dir).items().map(x => x.payload.text), ['hi', 'two', 'three'], 'kept on disk');
  assert.deepEqual(box.expire(1600).map(x => x.payload.text), ['hi', 'two']);
  assert.equal(box.first().payload.text, 'three');
  box.drop();
  assert.equal(box.size(), 0);
  assert.equal(fs.existsSync(box.file), false, 'an empty outbox is no file');
});

// ---------- serveMirror against a real server ----------
/** A host room with bob joined over one link; connect() makes a new memory pair each dial. cut(i) makes connection i
 * half-open (nothing crosses either way, nothing closes); refuse makes new dials fail. */
async function rig(t, { serverCaps } = {}) {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token } = auth.redeemInvite(host, secret, { machine: REMOTE });
  const sessions = [], conns = [];
  const pings = { n: 0 };
  const r = { code, host, conns, pings, refuse: false };
  r.connect = async () => {
    if (r.refuse) throw new RoomError('OFFLINE', 'no route to host');
    const [a, b] = memory.pair();
    let cut = false;
    const half = {
      send: f => { if (!cut) b.send(f); },
      onFrame: fn => b.onFrame(f => { if (cut) return; if (f.op === 'ping') pings.n++; fn(f); }),
      onClose: fn => b.onClose(fn),
      close: () => b.close(),
    };
    sessions.push(server.serve(half, { store: host }));
    const c = await client.connect(a, { machine: REMOTE, token, caps: { ping: true } });
    if (serverCaps) c.serverCaps = serverCaps;
    conns.push({ c, cut: () => { cut = true; } });
    return c;
  };
  t.after(() => sessions.forEach(s => s.close()));
  // bob joins over this link first (binds the seat to it), as the join hook does
  const first = await r.connect();
  const pubkey = seatKey.publicPem(code, 'bob');
  await first.join({ name: 'bob', pubkey, proof: auth.proveSeat(seatKey.ensure(code, 'bob'), { room: code, name: 'bob', pubkey }) });
  first.close();
  conns.length = 0;
  r.mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  r.states = [];
  r.logged = [];
  r.start = (opts = {}) => link.serveMirror({
    mirror: r.mirror, connect: r.connect, log: m => r.logged.push(m), timings: FAST, retryMs: 30, retryMaxMs: 60, watch: false,
    seats: () => [], writeState: rec => r.states.push(rec), ...opts,
  });
  r.same = () => fs.existsSync(r.mirror.logFile) && fs.readFileSync(r.mirror.logFile, 'utf8') === fs.readFileSync(host.logFile, 'utf8');
  r.hook = (op, params) => link.handle(op, { socket: link.socketPath(r.mirror.dir), params });
  t.after(() => fs.rmSync(path.dirname(link.socketPath(r.mirror.dir)), { recursive: true, force: true }));
  return r;
}
const ids = file => lines(file).map(l => JSON.parse(l).id);
const unique = a => new Set(a).size === a.length;

test('link: a half-open connection is caught by a missed pong; the new one is made before the old is dropped, with no duplicate line', async t => {
  const r = await rig(t);
  const l = await r.start();
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online' && r.states.some(s => s.rttMs != null), 3000, 5);
  const up = r.states.findLast(s => s.state === 'up');
  assert.deepEqual([up.attempt, up.queued, up.pid, up.detail, typeof up.rttMs], [0, 0, process.pid, 'online', 'number']);
  r.host.append({ kind: 'status', text: 'before' }, { via: 'system', from: 'room', system: true });
  await h.until(r.same, 3000, 5);
  const seen = r.states.length;

  r.conns[0].cut(); // half-open: the transport stays open, nothing crosses
  r.host.append({ kind: 'status', text: 'while half-open' }, { via: 'system', from: 'room', system: true });
  await h.until(() => r.conns.length === 2 && l.state() === 'online' && r.conns[0].c.closed, 3000, 5);
  assert.ok(r.conns[0].c.closed, 'the old connection is closed once the new one is live');
  assert.match(r.logged.join('\n'), /no pong within 60 ms: redialing now/);
  assert.match(r.logged.join('\n'), /swapped in, the old connection is closed/);
  assert.deepEqual(r.states.slice(seen).map(s => s.state).filter(s => s !== 'up'), [], 'up throughout: a swap is no outage');
  r.host.append({ kind: 'status', text: 'after' }, { via: 'system', from: 'room', system: true });
  await h.until(r.same, 3000, 5);
  assert.ok(r.same());
  assert.ok(unique(ids(r.mirror.logFile)));
  assert.equal(r.mirror.verifyChain().ok, true);
  assert.equal((await r.hook('append', { payload: say(r.code, 'over the new one') })).entry.text, 'over the new one');
});

test('link: no pong within deadMs and no new connection: the link is dead (OFFLINE), retried, and back once the host answers', async t => {
  const r = await rig(t);
  const l = await r.start();
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.refuse = true;
  r.conns[0].cut();
  await h.until(() => l.state() === 'offline', 3000, 5);
  const down = r.states.findLast(s => s.state !== 'up');
  assert.match(down.lastError, /no pong within 250 ms|no route to host/);
  assert.ok(r.conns[0].c.closed);
  await assert.rejects(r.hook('append', { payload: say(r.code, 'x') }), e => e.code === 'OFFLINE');
  await h.until(() => r.states.at(-1).state === 'down' && r.states.at(-1).attempt >= 2, 3000, 5);
  r.refuse = false;
  await h.until(() => l.state() === 'online', 3000, 5);
  assert.equal(r.states.at(-1).attempt, 0);
});

test('link: wake() while online makes before it breaks: hooks\' appends during repeated swaps land once each, in order', async t => {
  const r = await rig(t);
  const l = await r.start();
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  const texts = [];
  const writes = [];
  for (let i = 0; i < 30; i++) {
    texts.push(`p${i}`);
    writes.push(r.hook('append', { payload: say(r.code, `p${i}`) }));
    r.host.append({ kind: 'status', text: `s${i}` }, { via: 'system', from: 'room', system: true });
    if (i % 10 === 5) l.wake('test');
    await h.sleep(3);
  }
  await Promise.all(writes);
  await h.until(() => r.conns.length >= 4 && !r.conns.slice(0, -1).some(x => !x.c.closed), 3000, 5);
  await h.until(r.same, 3000, 5);
  assert.ok(r.same(), 'byte-identical');
  const posted = store.open(r.code).readAll().filter(e => e.kind === 'say').map(e => e.text);
  assert.deepEqual(posted, texts, 'each once, in order');
  assert.ok(unique(ids(r.mirror.logFile)));
  assert.equal(r.mirror.verifyChain().ok, true);
  assert.equal(r.conns.filter(x => !x.c.closed).length, 1, 'one connection left');
});

test('link: offline, an @room post is queued (consent and agents\' posts are not); sent in order on reconnect, a landed one only once', async t => {
  const r = await rig(t);
  const l = await r.start();
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.refuse = true;
  r.conns[0].c.close();
  await h.until(() => l.state() === 'offline', 3000, 5);

  const posts = ['one', 'two', 'three'].map(text => say(r.code, text));
  for (const [i, p] of posts.entries()) assert.deepEqual(await r.hook('append', { payload: p, queue: true }), { queued: i + 1 });
  await assert.rejects(r.hook('append', { payload: signed(r.code, 'bob', { kind: 'signoff', proposal_hash: 'abcdef012345' }), queue: true }),
    e => e.code === 'OFFLINE', 'consent is never queued');
  await assert.rejects(r.hook('append', { payload: store.toPayload(r.code, { kind: 'say', text: 'agent' }, { via: 'agent', from: 'bob' }), queue: true }),
    e => e.code === 'OFFLINE', 'an agent\'s post is never queued');
  await assert.rejects(r.hook('append', { payload: say(r.code, 'not marked') }), e => e.code === 'OFFLINE', 'only a post the hook marks queue');
  await assert.rejects(r.hook('beat', { name: 'bob' }), e => e.code === 'OFFLINE');
  assert.equal(r.mirror.kv.get('link').queued, 3);
  assert.equal(r.states.at(-1).queued, 3);
  // "two" reached the host before the link died (its reply was lost): it must not land twice
  r.host.place(posts[1]);
  const before = r.host.readAll().length;

  r.refuse = false;
  await l.wake('test');
  await h.until(() => l.state() === 'online' && r.same(), 3000, 5);
  const said = r.host.readAll().filter(e => e.kind === 'say').map(e => e.text);
  assert.deepEqual(said, ['two', 'one', 'three']);
  assert.equal(r.host.readAll().length, before + 2);
  assert.equal(fs.existsSync(path.join(r.mirror.dir, 'outbox.json')), false);
  const st = r.mirror.kv.get('link');
  assert.equal(st.queued, undefined);
  assert.deepEqual([st.flush.sent, st.flush.unsent], [3, []]);
  assert.equal(r.states.at(-1).queued, 0);
});

test('link: a queued post that waited too long is dropped and reported, never re-signed', async t => {
  const r = await rig(t);
  const box = outbox.open(h.tmpDir('sh-ob-', t), { ageMs: 50 });
  const l = await r.start({ outbox: box });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.refuse = true;
  r.conns[0].c.close();
  await h.until(() => l.state() === 'offline', 3000, 5);
  await r.hook('append', { payload: say(r.code, 'stale one'), queue: true });
  await h.sleep(80);
  await r.hook('append', { payload: say(r.code, 'fresh one'), queue: true });
  r.refuse = false;
  await l.wake('test');
  await h.until(() => l.state() === 'online', 3000, 5);
  assert.deepEqual(r.host.readAll().filter(e => e.kind === 'say').map(e => e.text), ['fresh one']);
  const f = r.mirror.kv.get('link').flush;
  assert.equal(f.sent, 1);
  assert.deepEqual(f.unsent.map(u => u.text), ['stale one']);
  assert.match(f.unsent[0].why, /waited too long/);
});

test('link: a FORK at reconnect keeps the queued posts and says so', async t => {
  const r = await rig(t);
  const l = await r.start();
  await h.until(() => l.state() === 'online', 3000, 5);
  r.refuse = true;
  r.conns[0].c.close();
  await h.until(() => l.state() === 'offline', 3000, 5);
  await r.hook('append', { payload: say(r.code, 'kept'), queue: true });
  // the host log is reset under the mirror: the next subscribe is a FORK
  fs.rmSync(r.host.logFile);
  r.host.append({ kind: 'status', text: 'a new log' }, { via: 'system', from: 'room', system: true });
  r.host.append({ kind: 'status', text: 'a new log 2' }, { via: 'system', from: 'room', system: true });
  r.refuse = false;
  l.wake('test');
  assert.match(await l.done, /not the mirror's/);
  assert.equal(l.state(), 'fork');
  assert.deepEqual(outbox.open(r.mirror.dir).items().map(x => x.payload.text), ['kept']);
  assert.equal(r.mirror.kv.get('link').queued, 1);
  assert.match(r.logged.join('\n'), /FORK in room .*1 queued @room post\(s\) are kept, not sent/);
  assert.deepEqual([r.states.at(-1).state, r.states.at(-1).detail], ['down', 'fork']);
});

test('link: a seat whose lease lapsed on the host during the outage is renewed on reconnect, with no log line', async t => {
  const r = await rig(t);
  const l = await r.start({ seats: () => ['bob', 'carol'] });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.refuse = true;
  r.conns[0].c.close();
  await h.until(() => l.state() === 'offline', 3000, 5);
  r.host.members.update(ms => { ms.bob.seen_at = new Date(0).toISOString(); return ms; }); // the host's lease lapsed
  r.mirror.applyDoc('members', r.host.members.read());
  assert.equal(leaseFresh(r.host.members.read().bob), false);
  const n = r.host.readAll().length;
  r.refuse = false;
  await l.wake('test');
  await h.until(() => l.state() === 'online', 3000, 5);
  assert.equal(leaseFresh(r.host.members.read().bob), true, 'bob is back');
  assert.equal(r.host.readAll().length, n, 'no "left" or "joined" line');
  assert.match(r.logged.join('\n'), /seat bob: its lease had lapsed on the host; renewed/);
  assert.match(r.logged.join('\n'), /seat carol: .*has not joined over this link/, 'a seat not of this link is only logged');
});

test('link: an old server (no ping in its caps) is never pinged; the state file is links/<code>.state.json', async t => {
  const r = await rig(t, { serverCaps: { ops: protocol.OPS.filter(o => o !== 'ping') } });
  const l = await r.start({ writeState: undefined });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  await h.sleep(FAST.pingMs * 4);
  assert.equal(r.pings.n, 0);
  const st = links.readState(r.code);
  assert.deepEqual([st.state, st.attempt, st.lastError, st.rttMs, st.queued, st.pid, st.detail], ['up', 0, null, null, 0, process.pid, 'online']);
  assert.ok(Date.parse(st.since) <= Date.parse(st.at));
  assert.equal(fs.statSync(links.stateFile(r.code)).mode & 0o777, 0o600);
  assert.deepEqual(links.list(), [], 'a state file is not a link');
});

test('server: a session that said hello with caps.ping and then goes silent is closed; one without is kept', async t => {
  const { code, host } = (() => { h.freshHome(t); const c = h.newRoom(); return { code: c, host: store.open(c) }; })();
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token } = auth.redeemInvite(host, secret, { machine: REMOTE });
  const open = async caps => {
    const [a, b] = memory.pair();
    const srv = server.serve(b, { store: host, silentMs: 120 });
    t.after(() => srv.close());
    const c = await client.connect(a, { machine: REMOTE, token, caps });
    t.after(() => c.close());
    return c;
  };
  const pinging = await open({ ping: true }), quiet = await open({});
  assert.equal(pinging.supports('ping'), true);
  assert.equal(typeof (await pinging.ping(1000)).rttMs, 'number', 'pings keep it open');
  await h.until(() => pinging.closed, 2000, 10);
  assert.equal(pinging.closed, true);
  assert.equal(quiet.closed, false);
  assert.equal(code, host.code);
});
