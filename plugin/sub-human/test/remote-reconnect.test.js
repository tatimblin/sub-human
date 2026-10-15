'use strict';
// Reconnect hardening in the link daemon (lib/remote/link.ts): jittered backoff, the wake and network watchers on a
// fake clock, the outbox (lib/remote/outbox.ts), and serveMirror in-process over the memory transport against a real
// server (lib/remote/server.ts): a half-open link caught by a missed pong, make-before-break with no duplicate
// line, the outbox sent in order (never consent; "placed already" counts as sent; kept on FORK), a lapsed lease
// renewed with no log line, the link state file, the server closing a silent session, and an old server (no ping
// in its caps) never pinged. Two homes and real processes: test/remote-reconnect-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const link = require(path.join(h.LIB, 'remote', 'link.ts'));
const outbox = require(path.join(h.LIB, 'remote', 'outbox.ts'));
const protocol = require(path.join(h.LIB, 'remote', 'protocol.ts'));
const server = require(path.join(h.LIB, 'remote', 'server.ts'));
const client = require(path.join(h.LIB, 'remote', 'client.ts'));
const auth = require(path.join(h.LIB, 'remote', 'auth.ts'));
const links = require(path.join(h.LIB, 'room', 'links.ts'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.ts'));
const clock = require(path.join(h.LIB, 'clock.ts'));
const { leaseFresh } = require(path.join(h.LIB, 'room', 'members.ts'));
const { RoomError } = require(path.join(h.LIB, 'room', 'validate.ts'));
const { MirrorRoomStore } = require(path.join(h.LIB, 'room', 'store-mirror.ts'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.ts'));

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

test('outbox: only a signed @room or @claude post by a person is queueable; at most max, 0600, in order; old posts expire', t => {
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
  assert.equal(outbox.queueable({ ...p, to: 'claude' }), true, 'an @claude post is queued like an @room');
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
 * half-open (nothing crosses either way, nothing closes); refuse makes new dials fail; slowMs delays every frame to
 * the host (a slow upstream, not a dead one). */
async function rig(t, { serverCaps } = {}) {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token } = auth.redeemInvite(host, secret, { machine: REMOTE });
  const sessions = [], conns = [];
  const pings = { n: 0 };
  const r = { code, host, conns, pings, sessions, refuse: false };
  r.connect = async () => {
    if (r.refuse) throw new RoomError('OFFLINE', 'no route to host');
    const [a, b] = memory.pair();
    let cut = false;
    const half = {
      send: f => { if (!cut) b.send(f); },
      onFrame: fn => {
        const deliver = f => { if (cut) return; if (f.op === 'ping') pings.n++; fn(f); };
        b.onFrame(f => (r.slowMs ? setTimeout(() => deliver(f), r.slowMs) : deliver(f))); // r.slowMs: upstream latency
      },
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
  const up = r.states.findLast(s => s.state === 'online');
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
  assert.deepEqual(r.states.slice(seen).map(s => s.state).filter(s => s !== 'online'), [], 'online throughout: a swap is no outage');
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
  const down = r.states.findLast(s => s.state !== 'online');
  assert.match(down.lastError, /no pong within 250 ms|no route to host/);
  assert.ok(r.conns[0].c.closed);
  await assert.rejects(r.hook('append', { payload: say(r.code, 'x') }), e => e.code === 'OFFLINE');
  await h.until(() => r.states.at(-1).state === 'offline' && r.states.at(-1).attempt >= 2, 3000, 5);
  r.refuse = false;
  await h.until(() => l.state() === 'online', 3000, 5);
  assert.equal(r.states.at(-1).attempt, 0);
  // online again: no current error; why it went offline is kept apart as prevError
  assert.equal(r.states.at(-1).lastError, null);
  assert.match(r.states.at(-1).prevError, /no pong within 250 ms|no route to host/);
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
  assert.deepEqual([r.states.at(-1).state, r.states.at(-1).detail], ['fork', 'fork']);
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
  assert.deepEqual([st.state, st.attempt, st.lastError, st.rttMs, st.queued, st.pid, st.detail], ['online', 0, null, null, 0, process.pid, 'online']);
  assert.ok(Date.parse(st.since) <= Date.parse(st.at));
  assert.equal(fs.statSync(links.stateFile(r.code)).mode & 0o777, 0o600);
  assert.deepEqual(links.list(), [], 'a state file is not a link');
});

test('link: online, the mirror\'s document link lists the entry fields the host\'s caps list (same); an old host\'s lists none', async t => {
  for (const [caps, want] of [[undefined, ['same']], [{ ops: protocol.OPS }, undefined]]) {
    const r = await rig(t, { serverCaps: caps });
    const l = await r.start();
    await h.until(() => l.state() === 'online', 3000, 5);
    assert.deepEqual(r.mirror.kv.get('link').fields, want);
    l.stop('done');
    await l.done;
  }
  assert.deepEqual(protocol.CAPS.fields, ['same']);
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

// ---------- a slow link: a timed-out frame went out, so it is never "nothing was sent" (the lab's slow-link ghost) ----------
const SLOW = { pingMs: 0, relayMs: 80 };
const posts = host => host.readAll().filter(e => e.kind === 'say').map(e => e.text);
const box = r => outbox.open(r.mirror.dir);

test('link: a slow link\'s @room post is "sending", kept under its nonce; the late copy is the post, a resend is a replay', async t => {
  const r = await rig(t);
  const l = await r.start({ timings: SLOW });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.slowMs = 400; // longer than relayMs: the host answers after the daemon has answered the hook
  const p = say(r.code, 'slow one');
  const t0 = Date.now();
  assert.deepEqual(await r.hook('append', { payload: p, queue: true }), { queued: 1, slow: true });
  assert.ok(Date.now() - t0 < 300, 'answered by relayMs, before the hook\'s deadline');
  assert.deepEqual(box(r).items().map(x => x.payload.nonce), [p.nonce], 'in flight, under its nonce');
  assert.deepEqual(posts(r.host), [], 'not placed yet');
  await h.until(() => posts(r.host).length === 1 && box(r).size() === 0, 3000, 5);
  assert.deepEqual(posts(r.host), ['slow one'], 'the late copy is the post, once');
  r.slowMs = 0;
  await assert.rejects(r.hook('append', { payload: p, queue: true }), e => e.code === 'AUTH' && /placed already/.test(e.message), 'a resend is a replay');
  await h.until(r.same, 3000, 5);
  assert.deepEqual(posts(r.host), ['slow one']);
  assert.match(r.logged.join('\n'), /slow link: an @room post has no answer within 80 ms/);
  assert.match(r.logged.join('\n'), /the @room post that was in flight landed/);
  assert.equal(r.mirror.kv.get('link').flush, undefined, 'nothing reported unsent');
});

test('link: an op that is never queued times out with an unknown outcome; retrying the same signed payload is idempotent', async t => {
  const r = await rig(t);
  const l = await r.start({ timings: SLOW });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.slowMs = 400;
  const agent = store.toPayload(r.code, { kind: 'say', text: 'an agent post' }, { via: 'agent', from: 'bob' });
  await assert.rejects(r.hook('append', { payload: agent, queue: true }), e => e.code === 'OFFLINE' && protocol.unknownOutcome(e) && !/nothing was sent/.test(e.message));
  const once = signed(r.code, 'bob', { kind: 'say', text: 'signed once' }); // not marked queue: as an answer is sent
  await assert.rejects(r.hook('append', { payload: once }), e => protocol.unknownOutcome(e));
  assert.equal(box(r).size(), 0, 'never queued');
  await h.until(() => posts(r.host).length === 2, 3000, 5);
  r.slowMs = 0;
  // a retry of the same signed payload (its nonce) is refused as placed already: it can never land twice
  await assert.rejects(r.hook('append', { payload: once }), e => e.code === 'AUTH' && /placed already/.test(e.message));
  assert.deepEqual(posts(r.host), ['an agent post', 'signed once']);
});

test('link: a slow post whose connection dies before the answer stays queued and lands exactly once after the reconnect', async t => {
  const r = await rig(t);
  const l = await r.start({ timings: SLOW });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  r.slowMs = 300;
  assert.deepEqual(await r.hook('append', { payload: say(r.code, 'in flight'), queue: true }), { queued: 1, slow: true });
  r.refuse = true;
  r.conns[0].c.close(); // the connection drops while the frame is still on its way
  await h.until(() => l.state() === 'offline', 3000, 5);
  assert.equal(box(r).size(), 1, 'kept for the next connection');
  r.slowMs = 0;
  await h.sleep(400);
  r.refuse = false;
  await l.wake('test');
  await h.until(() => l.state() === 'online' && box(r).size() === 0, 3000, 5);
  await h.until(r.same, 3000, 5);
  assert.deepEqual(posts(r.host), ['in flight'], 'once, whichever copy landed');
});

test('link: a slow post answered "placed already" counts as sent; one the host refuses late is dropped and reported', async t => {
  const r = await rig(t);
  const l = await r.start({ timings: SLOW });
  t.after(() => l.stop('done'));
  await h.until(() => l.state() === 'online', 3000, 5);
  const p = say(r.code, 'placed by another way');
  r.host.place(p);
  r.slowMs = 300;
  assert.deepEqual(await r.hook('append', { payload: p, queue: true }), { queued: 1, slow: true });
  await h.until(() => box(r).size() === 0, 3000, 5);
  assert.equal(r.mirror.kv.get('link').flush, undefined, '"placed already" counts as sent');
  const bad = { ...say(r.code, 'a bad signature'), sig: 'AAAA' };
  assert.deepEqual(await r.hook('append', { payload: bad, queue: true }), { queued: 1, slow: true });
  await h.until(() => box(r).size() === 0, 3000, 5);
  const f = r.mirror.kv.get('link').flush;
  assert.deepEqual([f.sent, f.unsent.map(u => u.text)], [0, ['a bad signature']]);
  assert.deepEqual(posts(r.host), ['placed by another way']);
});

test('mirror store: a deadline that passed after the op went out is "unknown", never "nothing was sent"', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const dir = h.tmpDir('sh-mirror-u-', t);
  const sock = link.socketPath(dir);
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(path.dirname(sock), { recursive: true, force: true }));
  const reply = { mode: null };
  const srv = require('node:net').createServer(c => c.on('data', d => {
    const f = JSON.parse(String(d).split('\n')[0]);
    if (reply.mode === 'unknown') c.end(protocol.encode(protocol.error(f.id, 'OFFLINE', `append: no answer from the host within 2000 ms (a slow link); ${protocol.UNKNOWN_OUTCOME}`)));
    else if (reply.mode === 'offline') c.end(protocol.encode(protocol.error(f.id, 'OFFLINE', 'the link is offline')));
    // 'silent': no answer, so the bridge's own deadline passes
  }));
  await new Promise(res => srv.listen(sock, res));
  t.after(() => srv.close());
  const payload = JSON.stringify(signed(code, 'bob', { kind: 'say', text: 'x' }));
  // the bridge blocks its calling thread, so the store runs in a child process and this one serves the socket
  const probe = mode => {
    reply.mode = mode;
    return new Promise(resolve => {
      const child = require('node:child_process').fork(path.join(__dirname, 'support', 'mirror-probe.js'), [code, dir, payload], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('exit', () => resolve(JSON.parse(out)));
    });
  };
  const u = await probe('unknown');
  assert.deepEqual([u.code, u.unknown], ['OFFLINE', true]);
  assert.match(u.message, /outcome is unknown/);
  assert.doesNotMatch(u.message, /nothing was sent/);
  const o = await probe('offline');
  assert.deepEqual([o.code, o.unknown], ['OFFLINE', undefined]);
  assert.match(o.message, /nothing was sent/);
  const s = await probe('silent');
  assert.deepEqual([s.code, s.unknown], ['OFFLINE', true], 'past the bridge deadline it may have gone out');
  assert.doesNotMatch(s.message, /nothing was sent/);
});

// ---------- revoke: the link stops (AUTH), it does not redial a key that no longer gets in ----------
test('link: the host revokes the link: its serve ends the stream AUTH, the daemon stops and queues nothing', async t => {
  const r = await rig(t);
  const l = await r.start();
  await h.until(() => l.state() === 'online', 3000, 5);
  const [id] = Object.keys(r.host.kv.get(auth.LINKS_KEY));
  assert.equal(r.sessions.at(-1).revoked(), false, 'not revoked yet: nothing sent');
  auth.revokeLink(r.host, id);
  for (const s of r.sessions) s.revoked(); // sub-human revoke SIGTERMs the link's serve processes
  assert.match(await l.done, /the host revoked this link/);
  assert.equal(l.state(), 'stopped');
  assert.equal(r.mirror.kv.get('link').code, 'AUTH');
  await assert.rejects(r.hook('append', { payload: say(r.code, 'after revoke'), queue: true }), e => e.code === 'OFFLINE');
  assert.equal(box(r).size(), 0, 'not queued: the link is gone for good');
});

test('link: an ssh link with its own key and a token that ssh now refuses is AUTH (revoked); waiting for an admit stays OFFLINE', async () => {
  const off = new RoomError('OFFLINE', 'the link closed');
  const denied = { stderr: () => 'host@devbox: Permission denied (publickey).\r\n' };
  const own = { token: 'tok', transport: { kind: 'ssh', user: 'host', host: 'devbox', key: '/k/id_ed25519' } };
  const e1 = await link.keyRefused(own, denied, off);
  assert.deepEqual([e1.code, /revoked/.test(e1.message)], ['AUTH', true]);
  assert.equal(await link.keyRefused({ ...own, token: undefined, invite: 'sh2.x' }, denied, off), off, 'not admitted yet: keep trying');
  assert.equal(await link.keyRefused({ ...own, transport: { ...own.transport, key: undefined } }, denied, off), off, 'the user\'s own keys: maybe an agent not loaded');
  assert.equal(await link.keyRefused(own, { stderr: () => 'ssh: connect to host devbox port 22: Connection refused' }, off), off);
  assert.equal(await link.keyRefused(own, Promise.resolve(denied), off).then(e => e.code), 'AUTH', 'an async transport');
});
