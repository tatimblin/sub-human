'use strict';
// A room's server and the client (lib/remote/server.ts, lib/remote/client.ts) over
// the memory transport and over `sub-human serve --stdio` as a child: hello with an invite or a token, the
// named ops, "only as yourself" (AUTH), subscribe with {after, hash} (resume, FORK, the documents a mirror
// holds), decide after a remote answer, and a flaky link (OFFLINE at the deadline, never a half-applied write).
// The test process is the host and the remote machine at once: one home, the remote seats under another machine id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const identity = require(path.join(h.LIB, 'identity.ts'));
const protocol = require(path.join(h.LIB, 'remote', 'protocol.ts'));
const server = require(path.join(h.LIB, 'remote', 'server.ts'));
const client = require(path.join(h.LIB, 'remote', 'client.ts'));
const auth = require(path.join(h.LIB, 'remote', 'auth.ts'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.ts'));
const pipe = require(path.join(h.LIB, 'remote', 'transports', 'pipe.ts'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.ts'));
const { flaky } = require('./support/flaky.js');

// Never launch a real room Claude: a remote join on the host starts one as a local join does.
Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const REMOTE = 'remote0machine01';
const H = 'abcdef012345';

/** A fresh home with one room; host = its store as the server sees it. */
function hostRoom(t) {
  h.freshHome(t);
  const code = h.newRoom();
  return { code, host: store.open(code) };
}
const logLines = code => { try { return fs.readFileSync(path.join(store.open(code).dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

/** The client end of a memory pair whose server end serves host (closed when the test ends). */
function served(t, host, wrap = tr => tr) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host });
  t.after(() => srv.close());
  return wrap(a);
}
async function linked(t, host, opts = {}) {
  const { invite } = auth.mintInvite(host, { locator: 'pipe:test' });
  const c = await client.connect(served(t, host), { machine: REMOTE, invite, ...opts });
  t.after(() => c.close());
  return c;
}
/** What the remote join hook sends: the seat's public key and a proof signed by its private key. */
function seat(code, name, key = seatKey.ensure(code, name)) {
  const pubkey = seatKey.publicPem(code, name);
  return { name, pubkey, proof: auth.proveSeat(key, { room: code, name, pubkey }) };
}
const signed = (code, name, entry) => store.toPayload(code, entry, { via: 'human', from: name });
const rejects = (p, code) => assert.rejects(p, e => e.code === code, `expected ${code}`);

/** Collect a subscription's events. */
function collect(c, after, hash) {
  const got = { lines: [], docs: new Map(), ends: [] };
  const sub = c.subscribe(after, hash, ({ ev, data }) => {
    if (ev === 'entry') got.lines.push(data);
    if (ev === 'doc') got.docs.set(data.key, data.value);
    if (ev === 'end') got.ends.push(data.reason);
  });
  return { got, sub };
}

test('remote (memory): hello with an invite gives a token once; join, beat, append and blobs round-trip; subscribe streams the host log verbatim and the documents', async t => {
  const { code, host } = hostRoom(t);
  h.register('bob', 'member', process.pid, code); // a seat of the host machine: its pid and session never leave it
  const c = await linked(t, host);
  assert.equal(typeof c.token, 'string');
  assert.deepEqual([c.room, c.serverCaps.ops], [code, protocol.OPS]);
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true });
  const ms = identity.readMembers(code);
  assert.deepEqual([ms.alice.machine, ms.alice.pid], [REMOTE, undefined], 'a remote seat lives by its lease');
  const joined = host.readAll().find(e => e.kind === 'member_joined' && e.from === 'alice');
  assert.deepEqual([joined.machine, joined.pubkey], [REMOTE, seatKey.publicPem(code, 'alice')], 'the key is pinned');
  assert.deepEqual(await c.beat('alice', { presence: { state: 'working', detail: 'tests' } }), { ok: true });
  const say = await c.append(signed(code, 'alice', { kind: 'say', text: 'hello from afar' }));
  assert.equal(store.humanTrust(host.readById([say.id])[0]), 'verified');
  const note = await c.append({ from: 'alice', via: 'agent', kind: 'say', text: 'her Claude', to: 'room' });
  assert.equal(note.id, say.id + 1);
  const plan = Buffer.from('# the plan\n');
  const ref = `plans/${store.hash12(plan)}.md`;
  assert.equal(await c.blobPut(ref, plan), ref);
  assert.deepEqual(await c.blobGet(ref), plan);
  assert.equal(await c.blobGet('plans/none.md'), null);
  await rejects(c.blobPut('plans/other.md', plan), 'INVALID');

  const { got, sub } = collect(c, 0, store.hash12(''));
  assert.deepEqual(await sub.ready, { ok: true });
  await h.until(() => got.lines.length === logLines(code).length && got.docs.has('presence/alice'), 3000, 20);
  assert.deepEqual(got.lines, logLines(code), 'byte-identical lines');
  const members = got.docs.get('members');
  assert.deepEqual(Object.keys(members.bob).filter(k => ['pid', 'pid_start', 'session_id', 'cwd'].includes(k)), [], 'publicView');
  assert.equal(members.alice.machine, REMOTE);
  assert.equal(got.docs.get('presence/alice').state, 'working');
  assert.ok(got.docs.has('tasks'));
  assert.deepEqual(await c.leave('alice', 'session ended'), { ok: true });
  await h.until(() => got.lines.length === logLines(code).length, 3000, 20);
  assert.equal(JSON.parse(got.lines.at(-1)).text, 'alice left (session ended)');

  // a person's posts over a link are bounded (LINK_HUMAN_RATE_MAX per minute); an agent post has its own budget
  const config = require(path.join(h.LIB, 'config.ts'));
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true, rejoin: true });
  for (let i = 0; i < config.LINK_HUMAN_RATE_MAX - 1; i++) await c.append(signed(code, 'alice', { kind: 'say', text: `fast ${i}` }));
  await assert.rejects(c.append(signed(code, 'alice', { kind: 'say', text: 'one too many' })), e => e.code === 'RATE' && /alice posted/.test(e.message));
  await rejects(c.append(signed(code, 'alice', { kind: 'signoff', proposal_hash: 'abcdef012345', text: 'an answer counts too' })), 'RATE');

  // the token reconnects as the same link; the invite was single-use
  const again = await client.connect(served(t, host), { machine: REMOTE, token: c.token });
  t.after(() => again.close());
  assert.deepEqual([again.link, again.token], [c.link, c.token]);
  assert.deepEqual(await again.join(seat(code, 'alice')), { ok: true, rejoin: true });
});

test('remote (memory): a seat whose lease lapsed is logged left by the host\'s sweep; its next beat is ok and logs "rejoined"', async t => {
  const { code, host } = hostRoom(t);
  const seats = require(path.join(h.LIB, 'seats.ts'));
  const config = require(path.join(h.LIB, 'config.ts'));
  const c = await linked(t, host);
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true });
  host.members.update(ms => { ms.alice.seen_at = new Date(Date.now() - config.SEAT_LEASE_MS - config.LEAVE_SETTLE_MS - 1000).toISOString(); return ms; });
  assert.deepEqual(seats.sweep(code), ['alice']);
  assert.deepEqual(await c.beat('alice'), { ok: true });
  const moves = host.readAll().filter(e => e.from === 'alice' && (e.kind === 'member_joined' || e.kind === 'member_left')).map(e => e.text);
  assert.deepEqual(moves, ['alice joined', 'alice left (connection lost)', 'alice rejoined']);
  assert.equal(identity.readMembers(code).alice.lapsed_at, undefined);
  assert.ok(identity.liveMembers(code).includes('alice'));
  assert.deepEqual(await c.beat('alice'), { ok: true });
  assert.equal(host.readAll().filter(e => e.text === 'alice rejoined').length, 1, 'a beat of a seat that never lapsed logs nothing');
});

test('remote (memory): no token gets AUTH on every op but hello; a bad token, a bad, reused or foreign invite get AUTH; another version or op is PROTOCOL', async t => {
  const { code, host } = hostRoom(t);
  const anon = await client.connect(served(t, host), { machine: REMOTE });
  t.after(() => anon.close());
  assert.equal(anon.link, null);
  await rejects(anon.join(seat(code, 'alice')), 'AUTH');
  await rejects(anon.leave('alice', 'x'), 'AUTH');
  await rejects(anon.beat('alice'), 'AUTH');
  await rejects(anon.append({ from: 'alice', via: 'agent', kind: 'say', text: 'x' }), 'AUTH');
  await rejects(anon.subscribe(0, store.hash12(''), () => {}).ready, 'AUTH');
  await rejects(anon.blobGet('plans/x.md'), 'AUTH');
  await rejects(anon.blobPut('plans/x.md', Buffer.from('x')), 'AUTH');
  assert.deepEqual(host.readAll(), [], 'nothing written');

  const hello = opts => client.connect(served(t, host), { machine: REMOTE, ...opts });
  await rejects(hello({ token: 'not-a-token' }), 'AUTH');
  const { invite } = auth.mintInvite(host, { locator: 'pipe:test' });
  const [pre, c, loc, secret] = invite.split('.');
  await rejects(hello({ invite: [pre, c, loc, secret.replace(/^./, ch => (ch === 'A' ? 'B' : 'A'))].join('.') }), 'AUTH');
  await rejects(hello({ invite: [pre, 'vole-1234', loc, secret].join('.') }), 'AUTH');
  (await hello({ invite })).close();
  await rejects(hello({ invite }), 'AUTH');

  const [a, b] = memory.pair();
  server.serve(b, { store: host });
  const replies = [];
  a.onFrame(f => replies.push(f));
  a.send(protocol.request(1, 'hello', { v: 99, caps: {}, machine: REMOTE }));
  a.send(protocol.request(2, 'teleport', {}));
  a.send({ hello: true });
  await h.until(() => replies.length === 3, 2000, 5);
  a.close();
  assert.deepEqual(replies.map(f => [f.id, f.error.code]), [[1, 'PROTOCOL'], [2, 'PROTOCOL'], [null, 'PROTOCOL']]);
});

// ---------- protocol skew: fake versions on both ends (N-1, N, N+1) ----------
/** A host from before 0.4 (protocol 1): it checks v === 1, knows no proto, and answers no server version. */
function oldHost(t) {
  const [a, b] = memory.pair();
  b.onFrame(f => {
    if (f.op !== 'hello') return b.send(protocol.error(f.id, 'AUTH', 'say hello first'));
    const p = f.params || {};
    if (p.v !== 1) return b.send(protocol.error(f.id, 'PROTOCOL', `protocol v${p.v} is not served here (v1)`));
    b.send(protocol.reply(f.id, { v: 1, caps: { ops: ['hello'] }, room: 'vole-1234', link: null, extra: { some: 'future field' } }));
  });
  t.after(() => a.close());
  return a;
}
/** Raw hello frames against a host serving `proto`, as `version`. */
async function rawHello(t, host, params, opts = {}) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host, ...opts });
  t.after(() => srv.close());
  const got = [];
  a.onFrame(f => got.push(f));
  a.send(protocol.request(1, 'hello', { caps: {}, machine: REMOTE, ...params }));
  await h.until(() => got.length === 1, 2000, 5);
  a.close();
  return got[0];
}

test('protocol skew: the host picks the highest common version; N-1 and N+1 peers work, unknown hello fields are ignored both ways', async t => {
  const { host } = hostRoom(t);
  const N = protocol.PROTO;
  const at = (opts, srv = {}) => {
    const [a, b] = memory.pair();
    const s = server.serve(b, { store: host, ...srv });
    t.after(() => s.close());
    return client.connect(a, { machine: REMOTE, ...opts });
  };
  const same = await at({});
  assert.deepEqual([same.v, same.serverVersion], [N.max, protocol.PLUGIN_VERSION]);
  same.close();
  // N+1 joiner: speaks N.max..N.max+1; the host settles on N.max
  const newer = await at({ proto: { min: N.max, max: N.max + 1 }, version: '9.0.0', hostField: 'ignored' });
  assert.equal(newer.v, N.max);
  newer.close();
  // N+1 host: speaks N.max..N.max+1; this joiner gets N.max
  const newHost = await at({}, { proto: { min: N.max, max: N.max + 1 }, version: '9.0.0' });
  assert.deepEqual([newHost.v, newHost.serverVersion], [N.max, '9.0.0']);
  newHost.close();
  // N-1 joiner (0.3.0): hello {v: 1} with no proto or client, and it checks the reply's v === 1
  const old = await rawHello(t, host, { v: 1, someFutureField: true });
  assert.equal(old.result.v, 1, 'a 0.3.0 link still links');
  // N-1 host (0.3.0): this joiner asks for v 1 and accepts its bare reply (no proto, no server, an unknown field)
  const c = await client.connect(oldHost(t), { machine: REMOTE });
  assert.deepEqual([c.v, c.serverVersion], [1, null]);
  c.close();
});

test('protocol skew: no common version is PROTOCOL naming the side that must update', async t => {
  const { host } = hostRoom(t);
  const at = (opts, srv) => {
    const [a, b] = memory.pair();
    const s = server.serve(b, { store: host, ...srv });
    t.after(() => s.close());
    return client.connect(a, { machine: REMOTE, ...opts });
  };
  const fails = (p, re) => assert.rejects(p, e => e.code === 'PROTOCOL' && re.test(e.message), String(re));
  // the joiner is behind
  await fails(at({ proto: { min: 2, max: 2 }, version: '0.3.0' }, { proto: { min: 3, max: 4 }, version: '0.4.0' }),
    /^host runs sub-human 0\.4\.0 \(protocol 3–4\); you run 0\.3\.0 \(protocol 2\)\. Update your plugin: \/plugin update sub-human$/);
  // the host is behind
  await fails(at({ proto: { min: 5, max: 6 }, version: '0.9.0' }, { proto: { min: 3, max: 4 }, version: '0.4.0' }),
    /host runs sub-human 0\.4\.0 \(protocol 3–4\); you run 0\.9\.0 \(protocol 5–6\)\. The host must update/);
  // a 0.3.0 joiner meets a host that dropped protocol 1: the message reaches it as the error it shows
  const r = await rawHello(t, host, { v: 1 }, { proto: { min: 2, max: 3 }, version: '0.5.0' });
  assert.deepEqual([r.error.code, /you run an unknown sub-human version \(protocol 1\)\. Update your plugin/.test(r.error.message)], ['PROTOCOL', true]);
  // a host from before 0.4 and an sh2 invite (its PIN needs protocol 2): the host must update
  await fails(client.connect(oldHost(t), { machine: REMOTE, invite: 'sh2.x', pin: '123456' }),
    /^host runs an unknown sub-human version \(protocol 1\); you run .* \(protocol 1–2\)\. The host must update/);
  // a reply outside this end's range is refused here too
  await fails(at({ proto: { min: 1, max: 1 } }, { proto: { min: 1, max: 1 } }).then(() => at({ proto: { min: 3, max: 3 } }, {})), /must update|Update your plugin/);
});

test('remote (memory): a link writes only as the seats it joined: another `from`, a stolen key or a system kind is AUTH', async t => {
  const { code, host } = hostRoom(t);
  const a = await linked(t, host), b = await linked(t, host);
  await a.join(seat(code, 'alice'));
  await b.join(seat(code, 'bob'));
  await b.append(signed(code, 'bob', { kind: 'say', text: 'mine' }));
  const before = logLines(code).length;
  await rejects(a.append(signed(code, 'bob', { kind: 'say', text: 'as bob' })), 'AUTH');
  await rejects(a.append({ from: 'bob', via: 'agent', kind: 'say', text: 'as bob', to: 'room' }), 'AUTH');
  await rejects(a.beat('bob'), 'AUTH');
  await rejects(a.leave('bob', 'gone'), 'AUTH');
  await rejects(a.append(store.toPayload(code, { kind: 'member_left', text: 'alice left' }, { via: 'system', from: 'alice', system: true })), 'AUTH');
  // a seat needs its private key: a public key alone (it is in the log), or another key's proof, is refused
  const carol = seat(code, 'carol', crypto.generateKeyPairSync('ed25519').privateKey);
  await rejects(a.join(carol), 'AUTH');
  await rejects(a.join({ name: 'carol', pubkey: carol.pubkey }), 'AUTH');
  // a name keeps its pinned key: a new key with a valid proof is still refused, and the seat given back
  await b.leave('bob', 'gone');
  const fresh = crypto.generateKeyPairSync('ed25519');
  const pubkey = fresh.publicKey.export({ type: 'spki', format: 'pem' });
  await rejects(a.join({ name: 'bob', pubkey, proof: auth.proveSeat(fresh.privateKey, { room: code, name: 'bob', pubkey }) }), 'AUTH');
  assert.ok(identity.readMembers(code).bob.left_at);
  assert.equal(logLines(code).length, before + 1, 'only bob\'s own member_left was written');
});

test('remote (memory): a bound link (the card let one name in; a handoff\'s seats) joins its own seats only: another name, or a second seat, is AUTH', async t => {
  const { code, host } = hostRoom(t);
  const { invite } = auth.mintFor(host, { locator: 'pipe:test', machine: REMOTE, seats: ['carol'] });
  const c = await client.connect(served(t, host), { machine: REMOTE, invite });
  t.after(() => c.close());
  const before = logLines(code).length;
  await rejects(c.join(seat(code, 'bob')), 'AUTH');
  await assert.rejects(c.join(seat(code, 'dana')), e => e.code === 'AUTH' && /let in as carol, not dana/.test(e.message));
  assert.equal(logLines(code).length, before, 'no seat was taken');
  assert.deepEqual(await c.join(seat(code, 'carol')), { ok: true });
  assert.deepEqual(await c.join(seat(code, 'carol')), { ok: true, rejoin: true });
  await rejects(c.append(signed(code, 'bob', { kind: 'say', text: 'as bob' })), 'AUTH');
  assert.deepEqual(auth.links(host)[c.link].seats, ['carol']);
  // an unbound link (an sh1 invite, a login) still picks its name at join time
  const open = await linked(t, host);
  assert.deepEqual(await open.join(seat(code, 'erin')), { ok: true });
});

test('remote (memory): a remote answer is placed, then the host decides', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  host.append({ kind: 'proposal', text: `proposal ${H}: x`, hash: H, approvers: ['alice'] }, { via: 'agent', from: 'claude' });
  const answer = await c.append(signed(code, 'alice', { kind: 'signoff', proposal_hash: H }));
  const last = host.readAll().at(-1);
  assert.deepEqual([last.kind, last.text, last.refs], ['decision', `agreed: alice (proposal ${H})`, [answer.id - 1, answer.id]]);
  await c.append(signed(code, 'alice', { kind: 'objection', proposal_hash: H, text: 'late' }));
  assert.equal(host.readAll().filter(e => e.kind === 'decision').length, 1, 'decided once');
});

test('remote (memory): a cut mid-subscribe and a reconnect from {after, hash} resume with no gap and no duplicate; a wrong hash is FORK', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  const post = n => host.append({ kind: 'say', text: `line ${n}` }, { via: 'human', from: 'alice' });
  for (let i = 0; i < 3; i++) post(i);
  // a second connection whose transport is cut after 8 frames (hello, its reply, subscribe, its reply, 4 events)
  const cutter = await client.connect(served(t, host, tr => flaky(tr, { seed: 3, cutAfter: 8 })), { machine: REMOTE, token: c.token });
  const first = collect(cutter, 0, store.hash12(''));
  await first.sub.ready;
  for (let i = 3; i < 6; i++) post(i);
  await h.until(() => first.got.ends.length, 3000, 20);
  assert.deepEqual(first.got.ends, ['OFFLINE']);
  assert.ok(first.got.lines.length > 0 && first.got.lines.length < logLines(code).length, `${first.got.lines.length} lines before the cut`);
  // resume from the last line held
  const last = first.got.lines.at(-1);
  const again = await client.connect(served(t, host), { machine: REMOTE, token: c.token });
  t.after(() => again.close());
  const second = collect(again, JSON.parse(last).id, store.hash12(last));
  await second.sub.ready;
  post(6);
  await h.until(() => first.got.lines.length + second.got.lines.length === logLines(code).length, 3000, 20);
  assert.deepEqual([...first.got.lines, ...second.got.lines], logLines(code));
  // a mirror whose line differs from the host's, or that is ahead of it, is a FORK
  await rejects(again.subscribe(1, '000000000000', () => {}).ready, 'FORK');
  await rejects(again.subscribe(999, store.hash12(last), () => {}).ready, 'FORK');
});

test('remote (memory): the stream ends {reason: closed} when the room\'s claude is stopped', async t => {
  const { code, host } = hostRoom(t);
  identity.setRoomClaude(code, { job: 'j1', spawned_at: new Date().toISOString() });
  const c = await linked(t, host);
  const { got, sub } = collect(c, 0, store.hash12(''));
  await sub.ready;
  identity.setRoomClaude(code, { stopped_at: new Date().toISOString() });
  await h.until(() => got.ends.length, 3000, 20);
  assert.deepEqual(got.ends, ['closed']);
});

test('remote (memory): over a flaky link a dropped frame is OFFLINE at the deadline, never a half-applied write; a re-sent payload lands once', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  let shaky;
  for (let seed = 1; !shaky; seed++) { // the hello itself may be dropped: try the next seed
    shaky = await client.connect(served(t, host, tr => flaky(tr, { seed, drop: 0.35 })), { machine: REMOTE, token: c.token, deadlineMs: 150 }).catch(() => null);
  }
  t.after(() => shaky.close());
  const payloads = Array.from({ length: 16 }, (_, i) => signed(code, 'alice', { kind: 'say', text: `try ${i}` }));
  const results = [];
  for (const p of payloads) results.push(await shaky.append(p).then(e => ({ e }), err => ({ code: err.code })));
  assert.ok(results.some(r => r.code === 'OFFLINE') && results.some(r => r.e), JSON.stringify(results.map(r => r.code || 'ok')));
  assert.deepEqual([...new Set(results.map(r => r.code).filter(Boolean))], ['OFFLINE']);
  assert.equal(host.validateChain().ok, true);
  const placed = () => new Map(host.readAll().filter(e => e.nonce).map(e => [e.nonce, e]));
  for (const [i, r] of results.entries()) if (r.e) assert.ok(placed().has(payloads[i].nonce), 'a write that answered is in the log');
  // every OFFLINE payload is either in the log whole (its reply was lost) or not at all: re-sent, it lands once
  for (const [i, r] of results.entries()) {
    if (!r.code) continue;
    const had = placed().has(payloads[i].nonce);
    await c.append(payloads[i]).then(() => assert.equal(had, false), e => assert.deepEqual([e.code, had], ['AUTH', true]));
  }
  const nonces = host.readAll().filter(e => e.nonce).map(e => e.nonce);
  assert.equal(new Set(nonces).size, nonces.length);
  assert.equal(nonces.length, payloads.length);
});

test('remote (pipe): `sub-human serve --stdio CODE` as a child serves the host home; it exits when the link closes', async t => {
  const { code, host } = hostRoom(t);
  const { invite } = auth.mintInvite(host, { locator: 'pipe:test' });
  const tr = pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code], { env: h.childEnv() });
  let closed = false;
  tr.onClose(() => { closed = true; });
  const anon = await client.connect(pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code], { env: h.childEnv() }), { machine: REMOTE });
  await rejects(anon.beat('alice'), 'AUTH');
  anon.close();
  const c = await client.connect(tr, { machine: REMOTE, invite });
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true });
  const e = await c.append(signed(code, 'alice', { kind: 'say', text: 'over a pipe' }));
  const { got, sub } = collect(c, 0, store.hash12(''));
  await sub.ready;
  await h.until(() => got.lines.length === logLines(code).length, 5000, 20);
  assert.deepEqual(got.lines, logLines(code));
  assert.equal(JSON.parse(got.lines.at(-1)).id, e.id);
  c.close();
  await h.until(() => closed, 5000, 20);
  assert.equal(closed, true);
});

test('remote (pipe): `serve --stdio CODE --link ID` (the SSH forced command) takes only that link\'s token or the invite reserved for it', async t => {
  const { code, host } = hostRoom(t);
  const serveAs = id => pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code, ...(id ? ['--link', id] : [])], { env: h.childEnv() });
  const a = auth.mintInvite(host, { locator: 'ssh:me@far' });
  const b = auth.mintInvite(host, { locator: 'ssh:me@far' });
  const idA = auth.reserveLink(host, a.secret);
  assert.equal(auth.reserveLink(host, a.secret), idA, 'reserved once');
  const idB = auth.reserveLink(host, b.secret);
  assert.notEqual(idA, idB);
  assert.equal(auth.linkKnown(host, idA), true);
  assert.equal(auth.linkKnown(host, 'ffffffffffff'), false);
  // invite b over link A's forced command: AUTH, and b stays unused
  await rejects(client.connect(serveAs(idA), { machine: REMOTE, invite: b.invite }), 'AUTH');
  const ca = await client.connect(serveAs(idA), { machine: REMOTE, invite: a.invite });
  assert.equal(ca.link, idA, 'the invite redeems to the link it was reserved for');
  ca.close();
  const cb = await client.connect(serveAs(idB), { machine: REMOTE, invite: b.invite });
  assert.equal(cb.link, idB);
  cb.close();
  // a token presented over another link's forced command: AUTH; over its own: in
  await rejects(client.connect(serveAs(idB), { machine: REMOTE, token: ca.token }), 'AUTH');
  const again = await client.connect(serveAs(idA), { machine: REMOTE, token: ca.token });
  assert.equal(again.link, idA);
  again.close();
  // an invite never reserved, over a forced command: AUTH
  const c = auth.mintInvite(host, { locator: 'ssh:me@far' });
  await rejects(client.connect(serveAs(idA), { machine: REMOTE, invite: c.invite }), 'AUTH');
  assert.equal(auth.redeemInvite(host, c.secret, { machine: REMOTE }).link.id.length, 12, 'and stays unused');
});

test('the forced-command line a host writes for a link: the stable shim, restrict, no versioned path; appended once, one key one link', t => {
  const { code } = hostRoom(t);
  const shim = require(path.join(h.LIB, 'remote', 'shim.ts'));
  const sshkeys = require(path.join(h.LIB, 'remote', 'sshkeys.ts'));
  assert.deepEqual(auth.parseInvite(auth.mintInvite(store.open(code), { locator: 'ssh:host@127.0.0.1:2222' }).invite).locator, 'ssh:host@127.0.0.1:2222');
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv2YxFcmD0qVf1aW0gk1oQfWb3m9e1bJ1l3xq3fQnHk';
  assert.equal(sshkeys.publicKey(`${KEY} me@laptop "quoted" $(id)\n`), KEY, 'the key\'s own comment is dropped');
  for (const bad of [`command="sh" ${KEY}`, `${KEY}\n${KEY}`, 'not a key']) assert.equal(sshkeys.publicKey(bad), null, bad);
  const home = path.resolve(process.env.SUB_HUMAN_HOME);
  const id = 'abcdef012345';
  const line = shim.authorizedLine(code, id, KEY, home);
  assert.equal(line, `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --stdio ${code} --link ${id}",restrict ${KEY} sub-human:${code}:${id}`);
  assert.ok(!line.includes(process.execPath) && !line.includes(fs.realpathSync(h.BIN)), 'no versioned node or plugin path is baked in');
  const ak = path.join(h.tmpDir('sh-ak-', t), 'ssh', 'authorized_keys');
  assert.equal(sshkeys.appendAuthorized(ak, line, KEY), 'added');
  assert.equal(sshkeys.appendAuthorized(ak, line, KEY), 'present');
  assert.equal(fs.readFileSync(ak, 'utf8'), `${line}\n`);
  assert.equal(fs.statSync(ak).mode & 0o777, 0o600);
  assert.throws(() => sshkeys.appendAuthorized(ak, shim.authorizedLine(code, '0123456789ab', KEY, home), KEY), e => e.code === 'INVALID', 'one key, one link');
});
