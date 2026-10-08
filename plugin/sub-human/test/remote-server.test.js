'use strict';
// A room's server and the client (lib/remote/server.js, lib/remote/client.js; docs/archive/REMOTE-PLAN.md PR4) over
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
const store = require(path.join(h.LIB, 'room', 'store.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const protocol = require(path.join(h.LIB, 'remote', 'protocol.js'));
const server = require(path.join(h.LIB, 'remote', 'server.js'));
const client = require(path.join(h.LIB, 'remote', 'client.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.js'));
const pipe = require(path.join(h.LIB, 'remote', 'transports', 'pipe.js'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.js'));
const { flaky } = require('./support/flaky.js');

// Never launch a real orch: a remote join on the host starts one as a local join does.
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

  // the token reconnects as the same link; the invite was single-use
  const again = await client.connect(served(t, host), { machine: REMOTE, token: c.token });
  t.after(() => again.close());
  assert.deepEqual([again.link, again.token], [c.link, c.token]);
  assert.deepEqual(await again.join(seat(code, 'alice')), { ok: true, rejoin: true });
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

test('remote (memory): a remote answer is placed, then the host decides', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  host.append({ kind: 'proposal', text: `proposal ${H}: x`, hash: H, approvers: ['alice'] }, { via: 'agent', from: 'orch' });
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

test('remote (memory): the stream ends {reason: closed} when the room\'s orch is stopped', async t => {
  const { code, host } = hostRoom(t);
  identity.setOrch(code, { job: 'j1', spawned_at: new Date().toISOString() });
  const c = await linked(t, host);
  const { got, sub } = collect(c, 0, store.hash12(''));
  await sub.ready;
  identity.setOrch(code, { stopped_at: new Date().toISOString() });
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

test('cli: invite --ssh USER@HOST[:PORT]; authorize prints the forced-command line (absolute paths, restrict), --file appends it once', t => {
  const { code } = hostRoom(t);
  const run = (args, input) => spawnSync(process.execPath, [h.BIN, ...args], { env: h.childEnv(), encoding: 'utf8', input });
  const inv = run(['invite', '--room', code, '--ssh', 'host@127.0.0.1:2222']);
  assert.equal(inv.status, 0, inv.stderr);
  const invite = inv.stdout.trim();
  assert.deepEqual(auth.parseInvite(invite).locator, 'ssh:host@127.0.0.1:2222');
  for (const bad of ['-oProxyCommand=x@h', 'me@h;id', 'me@h:99999']) assert.notEqual(run(['invite', '--room', code, '--ssh', bad]).status, 0, bad);
  const dir = h.tmpDir('sh-ak-', t);
  const pub = path.join(dir, 'id.pub');
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv2YxFcmD0qVf1aW0gk1oQfWb3m9e1bJ1l3xq3fQnHk';
  fs.writeFileSync(pub, `${KEY} me@laptop "quoted" $(id)\n`);
  const r = run(['authorize', invite, pub]);
  assert.equal(r.status, 0, r.stderr);
  const id = auth.reserveLink(store.open(code), auth.parseInvite(invite).secret);
  const bin = fs.realpathSync(h.BIN);
  assert.equal(r.stdout.trim(),
    `command="SUB_HUMAN_HOME=${path.resolve(process.env.SUB_HUMAN_HOME)} ${process.execPath} ${bin} serve --stdio ${code} --link ${id}",restrict ${KEY} sub-human:${code}:${id}`);
  assert.doesNotMatch(r.stdout, /laptop|quoted|\$\(/, 'the key\'s own comment is dropped');
  // by link id, from stdin, into a file: appended once (0600), the same key with another line refused
  const ak = path.join(dir, 'ssh', 'authorized_keys');
  assert.equal(run(['authorize', id, '-', '--room', code, '--file', ak], KEY).status, 0);
  assert.equal(run(['authorize', id, '-', '--room', code, '--file', ak], KEY).status, 0);
  assert.equal(fs.readFileSync(ak, 'utf8'), r.stdout);
  assert.equal(fs.statSync(ak).mode & 0o777, 0o600);
  const other = auth.mintInvite(store.open(code), { locator: 'ssh:me@far' }).invite;
  assert.notEqual(run(['authorize', other, '-', '--file', ak], KEY).status, 0, 'one key, one link');
  // refusals: options before the key, two keys, a link id without --room or unknown, a foreign room
  for (const [args, input] of [
    [['authorize', invite, '-'], `command="sh" ${KEY}`],
    [['authorize', invite, '-'], `${KEY}\n${KEY}`],
    [['authorize', invite, '-'], 'not a key'],
    [['authorize', id, '-'], KEY],
    [['authorize', 'ffffffffffff', '-', '--room', code], KEY],
    [['authorize', invite, '-', '--room', 'vole-0000'], KEY],
  ]) assert.notEqual(run(args, input).status, 0, `${args.join(' ')} <<< ${input}`);
});
