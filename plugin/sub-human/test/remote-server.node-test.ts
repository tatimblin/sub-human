// A room's server and the client (lib/remote/server.ts, lib/remote/client.ts) over
// the memory transport and over `sub-human serve --stdio` as a child: hello with an invite or a token, the
// named ops, "only as yourself" (AUTH), subscribe with {after, hash} (resume, FORK, the documents a mirror
// holds), decide after a remote answer, and a flaky link (OFFLINE at the deadline, never a half-applied write).
// The test process is the host and the remote machine at once: one home, the remote seats under another machine id.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as identity from '../lib/identity.ts';
import * as protocol from '../lib/remote/protocol.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as invites from '../lib/remote/invites.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as quota from '../lib/remote/quota.ts';
import { MemoryRoomStore } from './support/memory-store.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import * as pipe from '../lib/remote/transports/pipe.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { flaky } from './support/flaky.ts';
import * as config from '../lib/config.ts';
import * as seats from '../lib/seats.ts';
import * as sshkeys from '../lib/remote/sshkeys.ts';
import type { Client, ConnectOpts } from '../lib/remote/client.ts';
import type { CodedError, DecodedFrame } from '../lib/remote/types-core.ts';
import type { Transport } from '../lib/remote/types-rest.ts';
import type { Entry, EntryInput, Members, Presence, RoomStore } from '../lib/room/types.ts';

/** server.serve's options. */
type ServeOpts = Parameters<typeof server.serve>[1];

// Never launch a real room Claude: a remote join on the host starts one as a local join does.
Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const REMOTE = 'remote0machine01';
const H = 'abcdef012345';

/** A fresh home with one room; host = its store as the server sees it. */
function hostRoom(t: TestContext) {
  h.freshHome(t);
  const code = h.newRoom();
  return { code, host: store.open(code) };
}
const logLines = (code: string) => { try { return fs.readFileSync(path.join(store.open(code).dir!, 'log.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

/** The client end of a memory pair whose server end serves host (closed when the test ends). */
function served(t: TestContext, host: RoomStore, wrap: (tr: Transport) => Transport = tr => tr) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host });
  t.after(() => srv.close());
  return wrap(a);
}
async function linked(t: TestContext, host: RoomStore, opts: Partial<ConnectOpts> = {}) {
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: opts.machine ?? REMOTE, seats: [] });
  const c = await client.connect(served(t, host), { machine: REMOTE, token, ...opts });
  t.after(() => c.close());
  return c;
}
/** What the remote join hook sends: the seat's public key and a proof signed by its private key. */
function seat(code: string, name: string, key = seatKey.ensure(code, name)) {
  const pubkey = seatKey.publicPem(code, name);
  return { name, pubkey, proof: hostLinks.proveSeat(key, { room: code, name, pubkey }) };
}
const signed = (code: string, name: string, entry: EntryInput) => store.toPayload(code, entry, { via: 'human', from: name });
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: CodedError) => e.code === code, `expected ${code}`);

/** Collect a subscription's events. */
function collect(c: Client, after: number, hash: string | null) {
  const got: { lines: string[]; docs: Map<string, unknown>; ends: string[] } = { lines: [], docs: new Map(), ends: [] };
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
  assert.deepEqual([c.room, c.serverCaps!.ops], [code, protocol.OPS]);
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true });
  const ms = identity.readMembers(code);
  assert.deepEqual([ms.alice.machine, ms.alice.pid], [REMOTE, undefined], 'a remote seat lives by its lease');
  const joined = host.readAll().find(e => e.kind === 'member_joined' && e.from === 'alice');
  assert.deepEqual([joined!.machine, joined!.pubkey], [REMOTE, seatKey.publicPem(code, 'alice')], 'the key is pinned');
  assert.deepEqual(await c.beat('alice', { presence: { state: 'working', detail: 'tests' } }), { ok: true });
  const say = await c.append(signed(code, 'alice', { kind: 'say', text: 'hello from afar' }));
  assert.equal(host.trust(host.readById([say.id])[0]), 'verified');
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
  const members = got.docs.get('members') as Members;
  assert.deepEqual(Object.keys(members.bob).filter(k => ['pid', 'pid_start', 'session_id', 'cwd'].includes(k)), [], 'publicView');
  assert.equal(members.alice.machine, REMOTE);
  assert.equal((got.docs.get('presence/alice') as Presence).state, 'working');
  assert.ok(got.docs.has('tasks'));
  assert.deepEqual(await c.leave('alice', 'session ended'), { ok: true });
  await h.until(() => got.lines.length === logLines(code).length, 3000, 20);
  assert.equal(JSON.parse(got.lines.at(-1)!).text, 'alice left (session ended)');

  // a person's posts over a link are bounded (LINK_HUMAN_RATE_MAX per minute); an agent post has its own budget
  assert.deepEqual(await c.join(seat(code, 'alice')), { ok: true, rejoin: true });
  for (let i = 0; i < config.LINK_QUOTAS['append.human'].max - 1; i++) await c.append(signed(code, 'alice', { kind: 'say', text: `fast ${i}` }));
  await assert.rejects(c.append(signed(code, 'alice', { kind: 'say', text: 'one too many' })), (e: CodedError) => e.code === 'RATE' && /alice posted/.test(e.message));
  await rejects(c.append(signed(code, 'alice', { kind: 'signoff', proposal_hash: 'abcdef012345', text: 'an answer counts too' })), 'RATE');

  // the token reconnects as the same link; the invite was single-use
  const again = await client.connect(served(t, host), { machine: REMOTE, token: c.token! });
  t.after(() => again.close());
  assert.deepEqual([again.link, again.token], [c.link, c.token]);
  assert.deepEqual(await again.join(seat(code, 'alice')), { ok: true, rejoin: true });
});

test('remote (memory): a seat whose lease lapsed is logged left by the host\'s sweep; its next beat is ok and logs "rejoined"', async t => {
  const { code, host } = hostRoom(t);
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

  const hello = (opts: Partial<ConnectOpts>) => client.connect(served(t, host), { machine: REMOTE, ...opts });
  await rejects(hello({ token: 'not-a-token' }), 'AUTH');
  const { invite } = invites.mintFor(host, { locator: 'pipe:test', machine: REMOTE, seats: [] });
  const [pre, c, loc, secret, key] = invite.split('.');
  await rejects(hello({ invite: [pre, c, loc, secret.replace(/^./, (ch: string) => (ch === 'A' ? 'B' : 'A')), key].join('.') }), 'AUTH');
  await rejects(hello({ invite: [pre, 'vole-1234', loc, secret, key].join('.') }), 'AUTH');
  (await hello({ invite })).close();
  await rejects(hello({ invite }), 'AUTH');

  const [a, b] = memory.pair();
  server.serve(b, { store: host });
  const replies: DecodedFrame[] = [];
  a.onFrame(f => replies.push(f));
  a.send(protocol.request(1, 'hello', { v: 99, caps: {}, machine: REMOTE }));
  a.send(protocol.request(2, 'teleport', {}));
  a.send({ hello: true });
  await h.until(() => replies.length === 3, 2000, 5);
  a.close();
  assert.deepEqual(replies.map(f => [f.id, f.error!.code]), [[1, 'PROTOCOL'], [2, 'PROTOCOL'], [null, 'PROTOCOL']]);
});

// ---------- protocol skew: fake versions on both ends (N-1, N, N+1) ----------
/** Raw hello frames against a host serving `proto`, as `version`. */
async function rawHello(t: TestContext, host: RoomStore, params: Record<string, unknown>, opts: Partial<ServeOpts> = {}) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host, ...opts });
  t.after(() => srv.close());
  const got: DecodedFrame[] = [];
  a.onFrame(f => got.push(f));
  a.send(protocol.request(1, 'hello', { caps: {}, machine: REMOTE, ...params }));
  await h.until(() => got.length === 1, 2000, 5);
  a.close();
  return got[0];
}

test('protocol skew: the host picks the highest common version; N-1 and N+1 peers work, unknown hello fields are ignored both ways', async t => {
  const { host } = hostRoom(t);
  const N = protocol.PROTO;
  const at = (opts: Partial<ConnectOpts>, srv: Partial<ServeOpts> = {}) => {
    const [a, b] = memory.pair();
    const s = server.serve(b, { store: host, ...srv });
    t.after(() => s.close());
    return client.connect(a, { machine: REMOTE, ...opts });
  };
  const same = await at({});
  assert.deepEqual([same.v, same.serverVersion], [N.max, protocol.PLUGIN_VERSION]);
  same.close();
  // N+1 joiner: speaks N.max..N.max+1; the host settles on N.max
  const newer = await at({ proto: { min: N.max, max: N.max + 1 }, version: '9.0.0', hostField: 'ignored' } as Partial<ConnectOpts>); // deliberate: a field this end does not know
  assert.equal(newer.v, N.max);
  newer.close();
  // N+1 host: speaks N.max..N.max+1; this joiner gets N.max
  const newHost = await at({}, { proto: { min: N.max, max: N.max + 1 }, version: '9.0.0' });
  assert.deepEqual([newHost.v, newHost.serverVersion], [N.max, '9.0.0']);
  newHost.close();
  // a 0.5 beta's joiner: its hello also says v (the version it needs at least), honoured; an unknown field ignored
  const beta = await rawHello(t, host, { v: 2, proto: { min: 1, max: 2 }, client: '0.5.0-beta.15', someFutureField: true });
  assert.equal((beta.result as { v: number }).v, 2, 'a beta.15 link still links');
  // a hello with a version but no range (a joiner from before 0.5): PROTOCOL SKEW, it must update
  const pre = await rawHello(t, host, { v: 1 });
  assert.deepEqual([pre.error!.code, pre.error!.reason, /update it/.test(pre.error!.message)], ['PROTOCOL', 'SKEW', true]);
});

test('protocol skew: no common version is PROTOCOL naming the side that must update', async t => {
  const { host } = hostRoom(t);
  const at = (opts: Partial<ConnectOpts>, srv: Partial<ServeOpts>) => {
    const [a, b] = memory.pair();
    const s = server.serve(b, { store: host, ...srv });
    t.after(() => s.close());
    return client.connect(a, { machine: REMOTE, ...opts });
  };
  const fails = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: CodedError) => e.code === 'PROTOCOL' && re.test(e.message), String(re));
  // the joiner is behind
  await fails(at({ proto: { min: 2, max: 2 }, version: '0.3.0' }, { proto: { min: 3, max: 4 }, version: '0.4.0' }),
    /^host runs sub-human 0\.4\.0 \(protocol 3–4\); you run 0\.3\.0 \(protocol 2\)\. Update your plugin: \/plugin update sub-human$/);
  // the host is behind
  await fails(at({ proto: { min: 5, max: 6 }, version: '0.9.0' }, { proto: { min: 3, max: 4 }, version: '0.4.0' }),
    /host runs sub-human 0\.4\.0 \(protocol 3–4\); you run 0\.9\.0 \(protocol 5–6\)\. The host must update/);
  // a joiner that speaks only protocol 1 meets a host that dropped it: the message reaches it as the error it shows
  const r = await rawHello(t, host, { proto: { min: 1, max: 1 } }, { proto: { min: 2, max: 3 }, version: '0.5.0' });
  assert.deepEqual([r.error!.code, r.error!.reason, /you run an unknown sub-human version \(protocol 1\)\. Update your plugin/.test(r.error!.message)], ['PROTOCOL', 'SKEW', true]);
  // a reply outside this end's range is refused here too
  await fails(at({ proto: { min: 1, max: 1 } }, { proto: { min: 1, max: 1 } }).then(() => at({ proto: { min: protocol.PROTO.max + 1, max: protocol.PROTO.max + 1 } }, {})), /must update|Update your plugin/);
  // this version and 0.5.0-beta.15: protocol 3 against 1–2 settles on 2 both ways (a link made before keeps working)
  assert.deepEqual(protocol.PROTO, { min: 1, max: 3 });
  const oldHost = await at({}, { proto: { min: 1, max: 2 }, version: '0.5.0-beta.15' });
  assert.deepEqual([oldHost.v, oldHost.serverVersion], [2, '0.5.0-beta.15']);
  oldHost.close();
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
  await rejects(a.join({ name: 'carol', pubkey: carol.pubkey } as Parameters<Client['join']>[0]), 'AUTH'); // deliberate: no proof
  // a name keeps its pinned key: a new key with a valid proof is still refused, and the seat given back
  await b.leave('bob', 'gone');
  const fresh = crypto.generateKeyPairSync('ed25519');
  const pubkey = fresh.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  await rejects(a.join({ name: 'bob', pubkey, proof: hostLinks.proveSeat(fresh.privateKey, { room: code, name: 'bob', pubkey }) }), 'AUTH');
  assert.ok(identity.readMembers(code).bob.left_at);
  assert.equal(logLines(code).length, before + 1, 'only bob\'s own member_left was written');
});

test('remote (memory): a bound link (the card let one name in; a handoff\'s seats) joins its own seats only: another name, or a second seat, is AUTH', async t => {
  const { code, host } = hostRoom(t);
  const { invite } = invites.mintFor(host, { locator: 'pipe:test', machine: REMOTE, seats: ['carol'] });
  const c = await client.connect(served(t, host), { machine: REMOTE, invite });
  t.after(() => c.close());
  const before = logLines(code).length;
  await rejects(c.join(seat(code, 'bob')), 'AUTH');
  await assert.rejects(c.join(seat(code, 'dana')), (e: CodedError) => e.code === 'AUTH' && /let in as carol, not dana/.test(e.message));
  assert.equal(logLines(code).length, before, 'no seat was taken');
  assert.deepEqual(await c.join(seat(code, 'carol')), { ok: true });
  assert.deepEqual(await c.join(seat(code, 'carol')), { ok: true, rejoin: true });
  await rejects(c.append(signed(code, 'bob', { kind: 'say', text: 'as bob' })), 'AUTH');
  assert.deepEqual(hostLinks.links(host)[c.link!].seats, ['carol']);
  // an unbound link (a login's, an invite that binds no seat) still picks its name at join time
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
  assert.deepEqual([last!.kind, last!.text, last!.refs], ['decision', `agreed: alice (proposal ${H})`, [answer.id - 1, answer.id]]);
  await c.append(signed(code, 'alice', { kind: 'objection', proposal_hash: H, text: 'late' }));
  assert.equal(host.readAll().filter(e => e.kind === 'decision').length, 1, 'decided once');
});

test('remote (memory): a cut mid-subscribe and a reconnect from {after, hash} resume with no gap and no duplicate; a wrong hash is FORK', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  const post = (n: number) => host.append({ kind: 'say', text: `line ${n}` }, { via: 'human', from: 'alice' });
  for (let i = 0; i < 3; i++) post(i);
  // a second connection whose transport is cut after 8 frames (hello, its reply, subscribe, its reply, 4 events)
  const cutter = await client.connect(served(t, host, tr => flaky(tr, { seed: 3, cutAfter: 8 })), { machine: REMOTE, token: c.token! });
  const first = collect(cutter, 0, store.hash12(''));
  await first.sub.ready;
  for (let i = 3; i < 6; i++) post(i);
  await h.until(() => first.got.ends.length, 3000, 20);
  assert.deepEqual(first.got.ends, ['OFFLINE']);
  assert.ok(first.got.lines.length > 0 && first.got.lines.length < logLines(code).length, `${first.got.lines.length} lines before the cut`);
  // resume from the last line held
  const last = first.got.lines.at(-1)!;
  const again = await client.connect(served(t, host), { machine: REMOTE, token: c.token! });
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
  identity.updateRoomClaude(code, () => ({ job: 'j1', spawned_at: new Date().toISOString() }));
  const c = await linked(t, host);
  const { got, sub } = collect(c, 0, store.hash12(''));
  await sub.ready;
  identity.updateRoomClaude(code, () => ({ stopped_at: new Date().toISOString() }));
  await h.until(() => got.ends.length, 3000, 20);
  assert.deepEqual(got.ends, ['closed']);
});

test('remote (memory): over a flaky link a dropped frame is OFFLINE at the deadline, never a half-applied write; a re-sent payload lands once', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await c.join(seat(code, 'alice'));
  let shaky;
  for (let seed = 1; !shaky; seed++) { // the hello itself may be dropped: try the next seed
    shaky = await client.connect(served(t, host, tr => flaky(tr, { seed, drop: 0.35 })), { machine: REMOTE, token: c.token!, deadlineMs: 150 }).catch(() => null);
  }
  t.after(() => shaky.close());
  const payloads = Array.from({ length: 16 }, (_, i) => signed(code, 'alice', { kind: 'say', text: `try ${i}` }));
  const results: { e?: Entry; code?: string }[] = [];
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
  const { invite } = invites.mintFor(host, { locator: 'pipe:test', machine: REMOTE, seats: [] });
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
  assert.equal(JSON.parse(got.lines.at(-1)!).id, e.id);
  c.close();
  await h.until(() => closed, 5000, 20);
  assert.equal(closed, true);
});

test('remote (pipe): `serve --stdio CODE --link ID` (the SSH forced command) takes only that link\'s token; an invite over it stays unused', async t => {
  const { code, host } = hostRoom(t);
  const serveAs = (id?: string) => pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code, ...(id ? ['--link', id] : [])], { env: h.childEnv() });
  const a = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: REMOTE, seats: [] });
  const b = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: 'other0machine001', seats: [] });
  assert.equal(hostLinks.linkKnown(host, a.link.id), true);
  assert.equal(hostLinks.linkKnown(host, 'ffffffffffff'), false);
  // a token presented over another link's forced command: AUTH; over its own: in
  await rejects(client.connect(serveAs(b.link.id), { machine: REMOTE, token: a.token }), 'AUTH');
  const ca = await client.connect(serveAs(a.link.id), { machine: REMOTE, token: a.token });
  assert.equal(ca.link, a.link.id);
  ca.close();
  // an invite not reserved for that link, over its forced command: AUTH, and it stays unused
  const c = invites.mintFor(host, { locator: 'ssh:me@far', machine: REMOTE, seats: [] });
  await assert.rejects(client.connect(serveAs(a.link.id), { machine: REMOTE, invite: c.invite }), (e: CodedError) => e.code === 'AUTH' && e.reason === 'INVITE_OTHER_LINK');
  assert.equal(invites.redeemInvite(host, c.secret, { machine: REMOTE }).link.id.length, 12, 'and stays unused');
});

test('the lines an older sub-human wrote to authorized_keys: kick takes a link\'s out, a door goes by its tag; nothing here writes one', t => {
  const { code } = hostRoom(t);
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv2YxFcmD0qVf1aW0gk1oQfWb3m9e1bJ1l3xq3fQnHk';
  const home = path.resolve(process.env.SUB_HUMAN_HOME!);
  const id = 'abcdef012345';
  const linkLine = `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --stdio ${code} --link ${id}",restrict ${KEY} sub-human:${code}:${id}`;
  const door = `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --enroll ${code} --kind ssh",restrict ${KEY} ${sshkeys.ENROLL_TAG(code)}`;
  const ak = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  fs.writeFileSync(ak, `ssh-ed25519 AAAAmine me@laptop\n${linkLine}\n${door}\n`, { mode: 0o600 });
  assert.equal(sshkeys.removeAuthorized(ak, code, '0123456789ab'), 0, 'another link\'s line: none');
  assert.equal(sshkeys.removeAuthorized(ak, code, id), 1);
  assert.equal(sshkeys.removeTagged(ak, sshkeys.ENROLL_TAG(code)), 1);
  assert.equal(fs.readFileSync(ak, 'utf8'), 'ssh-ed25519 AAAAmine me@laptop\n', 'the person\'s own lines stay');
  assert.equal(fs.statSync(ak).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(sshkeys).sort(), ['ENROLL_TAG', 'authorizedKeysFile', 'removeAuthorized', 'removeTagged'], 'no writer left');
});

test('remote (memory): subscribe {snapshot: true} gets the snapshot first only from a host that has one, only after 0, and only when it fits a frame', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  assert.equal(c.snapshots(), true, 'this host\'s caps offer it');
  const events = (after: number, opts: { snapshot?: boolean } = {}) => {
    const got: { ev: string; data: unknown }[] = [];
    const sub = c.subscribe(after, store.open(code).lineHash(after), e => got.push(e), opts);
    return { got, sub };
  };
  const status = (i: number, n = 40) => host.append({ kind: 'status', text: `s${i} ${'x'.repeat(n)}` }, { via: 'system', from: 'claude', system: true });
  for (let i = 0; i < 5; i++) status(i);
  // no snapshot yet: the whole log, as before
  let r = events(0, { snapshot: true });
  await r.sub.ready;
  assert.ok(await h.until(() => r.got.filter(e => e.ev === 'entry').length === 5, 3000, 10));
  assert.ok(!r.got.some(e => e.ev === 'snapshot'));
  r.sub.stop();
  // rotated: the snapshot first, then the lines after its id
  const was = process.env.SUB_HUMAN_SEGMENT_BYTES;
  process.env.SUB_HUMAN_SEGMENT_BYTES = '1024';
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_SEGMENT_BYTES; else process.env.SUB_HUMAN_SEGMENT_BYTES = was; });
  for (let i = 5; i < 40; i++) status(i);
  const snap = host.snapshot()!;
  assert.ok(snap && snap.id > 5 && snap.id < 40);
  r = events(0, { snapshot: true });
  await r.sub.ready;
  assert.ok(await h.until(() => r.got.filter(e => e.ev === 'entry').length === 40 - snap.id, 3000, 10));
  assert.equal(r.got[0].ev, 'snapshot', 'first');
  assert.deepEqual([(r.got[0].data as { id: number }).id, (r.got[0].data as { hash: string }).hash], [snap.id, snap.hash]);
  r.sub.stop();
  // after > 0: a resume, never a snapshot; without the flag: every line (an older mirror)
  r = events(3, { snapshot: true });
  await r.sub.ready;
  assert.ok(await h.until(() => r.got.filter(e => e.ev === 'entry').length === 37, 3000, 10));
  assert.ok(!r.got.some(e => e.ev === 'snapshot'));
  r.sub.stop();
  r = events(0);
  await r.sub.ready;
  assert.ok(await h.until(() => r.got.filter(e => e.ev === 'entry').length === 40, 3000, 10));
  assert.ok(!r.got.some(e => e.ev === 'snapshot'));
  r.sub.stop();
  // a snapshot over a frame (its non-chat entries): the whole log instead
  delete process.env.SUB_HUMAN_SEGMENT_BYTES;
  for (let i = 0; i < 40; i++) host.append({ kind: 'task_req', text: `task ${i}`, op: 'add', subject: `t${i}`, detail: 'd'.repeat(1900) }, { via: 'agent', from: `a${i}` });
  for (let i = 0; i < 500; i++) host.append({ kind: 'task', text: `task ${i}`, op: 'update', id: i + 1, subject: 's'.repeat(400), detail: 'd'.repeat(1900), status: 'pending' }, { via: 'system', from: 'claude', system: true });
  assert.ok((host as store.FsRoomStore).rotate(), 'sealed now');
  assert.ok(JSON.stringify(host.snapshot()).length > config.LINK_FRAME_MAX_BYTES, 'too big for one frame');
  const total = host.lastId();
  r = events(0, { snapshot: true });
  await r.sub.ready;
  assert.ok(await h.until(() => r.got.filter(e => e.ev === 'entry').length === total, 5000, 10), `${r.got.length} of ${total}`);
  assert.ok(!r.got.some(e => e.ev === 'snapshot'));
});

test('quotas: one table for every op; a link\'s plans, seats and subscribes survive a reconnect; a connection\'s hellos are its own', async t => {
  const { host } = hostRoom(t);
  const made = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: REMOTE, seats: [] });
  const dial = () => client.connect(served(t, host), { machine: REMOTE, token: made.token });
  const plans = config.LINK_QUOTAS['blob.put'].max;
  let c = await dial();
  for (let i = 0; i < plans; i++) {
    const bytes = Buffer.from(`# plan ${i}\n`);
    await c.blobPut(`plans/${store.hash12(bytes)}.md`, bytes);
    if (i === Math.floor(plans / 2)) { c.close(); c = await dial(); } // a reconnect resets nothing
  }
  const more = Buffer.from('# one too many\n');
  await assert.rejects(c.blobPut(`plans/${store.hash12(more)}.md`, more), (e: CodedError) => e.code === 'RATE' && e.reason === 'QUOTA' && /try again in \d+ s/.test(e.message));
  const again = Buffer.from('# plan 0\n');
  assert.equal(await c.blobPut(`plans/${store.hash12(again)}.md`, again), `plans/${store.hash12(again)}.md`, 'a plan stored already is no new one');
  c.close();
  // one connection's hellos: the session's own count
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host });
  t.after(() => srv.close());
  const got: DecodedFrame[] = [];
  a.onFrame(f => got.push(f));
  const n = config.LINK_QUOTAS['hello.session'].max;
  for (let i = 1; i <= n + 1; i++) a.send(protocol.request(i, 'hello', { proto: protocol.PROTO, caps: {}, machine: REMOTE }));
  await h.until(() => got.length === n + 1, 3000, 5);
  assert.deepEqual(got.slice(0, n).map(f => !!f.result), new Array(n).fill(true));
  assert.deepEqual([got[n].error!.code, got[n].error!.reason], ['RATE', 'QUOTA']);
  a.close();
});

test('quotas: the log counts a seat\'s posts by via; a link window drops what has passed; a session window is per op', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const at = (ago: number) => new Date(now - ago).toISOString();
  const es = [{ from: 'bob', via: 'agent', at: at(120_000) }, ...Array.from({ length: 29 }, () => ({ from: 'bob', via: 'agent', at: at(1000) })), { from: 'bob', via: 'human', at: at(500) }] as Entry[];
  assert.equal(quota.fromLog(es, { from: 'bob', via: 'agent', windowMs: 60_000, now }), 29, 'the one older than the window is not counted');
  quota.checkLog(es, { from: 'bob', via: 'agent', op: 'append.agent', now });
  assert.throws(() => quota.checkLog([...es, { from: 'bob', via: 'agent', at: at(10) } as Entry], { from: 'bob', via: 'agent', op: 'append.agent', now }), (e: CodedError) => e.reason === 'QUOTA' && /bob posted 30 times in 1 min/.test(e.message));
  // the retry is when the oldest counted line leaves the window, not the window itself
  const late = Array.from({ length: 30 }, () => ({ from: 'bob', via: 'agent', at: at(50_000) })) as Entry[];
  assert.throws(() => quota.checkLog(late, { from: 'bob', via: 'agent', op: 'append.agent', now }), (e: CodedError) => /try again in 10 s/.test(e.message));
  const s = new MemoryRoomStore('otter-1234');
  const seatQ = config.LINK_QUOTAS.seat;
  for (let i = 0; i < seatQ.max; i++) quota.charge(s, 'abcdef012345', 'seat', { now });
  assert.throws(() => quota.charge(s, 'abcdef012345', 'seat', { now }), (e: CodedError) => e.code === 'RATE');
  quota.charge(s, '0123456789ab', 'seat', { now }); // another link: its own count
  quota.charge(s, 'abcdef012345', 'seat', { now: now + seatQ.windowMs }); // the window passed
  const w = quota.session();
  for (let i = 0; i < config.LINK_QUOTAS.ping.max; i++) w.take('ping', now);
  assert.throws(() => w.take('ping', now), (e: CodedError) => e.reason === 'QUOTA');
  w.take('beat', now);
});

test('kick (pipe): a `serve --stdio CODE` child names no link, yet the kick ends its stream with LINK_REVOKED, refuses its ops and closes it; the old token\'s hello says LINK_REVOKED', async t => {
  const { code, host } = hostRoom(t);
  const hosting = await import('../lib/remote/hosting.ts');
  const ak = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  const { invite } = invites.mintFor(host, { locator: 'pipe:test', machine: REMOTE, seats: [] });
  const tr = pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code], { env: h.childEnv() });
  let closed = false;
  tr.onClose(() => { closed = true; });
  const c = await client.connect(tr, { machine: REMOTE, invite });
  t.after(() => c.close());
  assert.deepEqual(await c.join(seat(code, 'bob')), { ok: true });
  const ends: { reason: string; message?: string }[] = [];
  const sub = c.subscribe(0, store.hash12(''), ({ ev, data }) => { if (ev === 'end') ends.push(data as { reason: string; message?: string }); });
  await sub.ready;
  const r = hosting.kick(code, 'bob', { file: ak });
  assert.deepEqual(r.seats, ['bob']);
  assert.ok(await h.until(() => ends.length > 0, 5000, 20), 'the stream ends without a SIGTERM reaching this serve');
  assert.equal(ends[0].reason, 'AUTH');
  assert.match(ends[0].message!, /removed this machine from room .*kick/);
  await assert.rejects(c.append(signed(code, 'bob', { kind: 'say', text: 'after the kick' })), (e: CodedError) => ['AUTH', 'OFFLINE'].includes(e.code!));
  assert.ok(await h.until(() => closed, 5000, 20), 'the serve closes the connection');
  assert.ok(!host.readAll().some(e => e.text === 'after the kick'), 'nothing posted over the revoked link');
  // the old token at a new connection: LINK_REVOKED (what the joiner's daemon stops with, and doctor reads)
  await assert.rejects(client.connect(served(t, host), { machine: REMOTE, token: c.token! }), (e: CodedError) => e.code === 'AUTH' && e.reason === 'LINK_REVOKED');
});

test('kick (memory): a connection that holds a revoked link gets AUTH LINK_REVOKED on every op; its join takes no seat (no ghost seat)', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  assert.deepEqual(await c.join(seat(code, 'bob')), { ok: true });
  hostLinks.revokeLink(host, c.link!); // another process's kick: this session only reads the store
  seats.exit(code, 'bob', 'removed by the host');
  await assert.rejects(c.join(seat(code, 'bob')), (e: CodedError) => e.code === 'AUTH' && e.reason === 'LINK_REVOKED');
  await assert.rejects(c.beat('bob'), (e: CodedError) => e.code === 'AUTH' && e.reason === 'LINK_REVOKED');
  await assert.rejects(c.append(signed(code, 'bob', { kind: 'say', text: 'ghost' })), (e: CodedError) => e.code === 'AUTH' && e.reason === 'LINK_REVOKED');
  const bob = identity.readMembers(code).bob;
  assert.ok(bob.left_at, 'the seat stays left');
  assert.ok(!host.readAll().some(e => e.kind === 'member_joined' && e.from === 'bob' && /rejoined/.test(String(e.text))), 'no "bob rejoined"');
});

test('a seat refused at join gives its link binding back; a seat of another machine that no link names leaves at the sweep', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  const wrong = seat(code, 'carol');
  await rejects(c.join({ ...wrong, pubkey: seat(code, 'dave').pubkey }), 'AUTH'); // a proof for another key
  assert.deepEqual(hostLinks.links(host)[c.link!].seats, [], 'not bound');
  // a ghost: a remote seat whose link is gone (a kick raced its join before this fix), its lease past the settle
  assert.equal(seats.enter({ code, name: 'ghost', machine: 'ghost0machine001', pubkey: seat(code, 'ghost').pubkey }).ok, true);
  host.members.update(ms => { ms.ghost.seen_at = new Date(Date.now() - 3_600_000).toISOString(); return ms; });
  assert.deepEqual(seats.sweep(code), ['ghost']);
  const g = identity.readMembers(code).ghost;
  assert.ok(g.left_at && !g.lapsed_at, 'left, not lapsed');
  assert.match(String(host.readAll().at(-1)!.text), /ghost left \(its connection was ended\)/);
  // a lapsed seat over a live link stays seated (its next beat renews it)
  assert.deepEqual(await c.join(seat(code, 'erin')), { ok: true });
  host.members.update(ms => { ms.erin.seen_at = new Date(Date.now() - 3_600_000).toISOString(); return ms; });
  assert.deepEqual(seats.sweep(code), ['erin']);
  const e = identity.readMembers(code).erin;
  assert.ok(e.lapsed_at && !e.left_at);
});
