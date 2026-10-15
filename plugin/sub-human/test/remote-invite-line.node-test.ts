// An invite line (protocol 3) at the wire, the host's end on a real hosted store and the joiner's as client.connect
// over the memory transport: the host keeps no PIN in clear; a hello with the SECRET and no PIN is asked for the PIN and
// charged nothing; a wrong PIN costs a try, waits (per invite, longer per source machine) and the fifth burns the
// invite; the right PIN makes an admission bound to the machine its key proves (and, over the web, the Noise key its
// connection proved) and the hello waits for the card; once let in, that machine (and key) alone redeems it, for the
// one name. Over ssh and a pipe the host proves its machine key over the joiner's nonce first: a host the line does not
// name gets nothing. A link made over the web is its key; a protocol-2 link keeps its token. An older peer gets SKEW.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as invites from '../lib/remote/invites.ts';
import * as inviteSecret from '../lib/remote/invite-secret.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as admission from '../lib/remote/admission.ts';
import * as machineKey from '../lib/remote/machine-key.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import * as config from '../lib/config.ts';
import type { RoomStore } from '../lib/room/types.ts';
import type { CodedError, Invites, ShortInvite, AdmissionRecord } from '../lib/remote/types-core.ts';
import type { ConnectOpts } from '../lib/remote/client.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

function hostRoom(t: TestContext) {
  h.freshHome(t);
  const code = h.newRoom();
  return { code, host: store.open(code) };
}
const records = (host: RoomStore) => host.kv.get<Invites>(invites.INVITES_KEY, null) || {};
const recordOf = (host: RoomStore, ref: string) => Object.entries(records(host)).find(([k]) => k.startsWith(ref))![1] as ShortInvite;
const roomLines = (host: RoomStore) => host.readAll().filter(e => e.from === 'room').map(e => e.text);

/** A machine of the joiner's own: an Ed25519 key, and its proof for room code (what machine-key.ts proof makes). */
function machine() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const key = kp.publicKey.export({ format: 'jwk' }).x!;
  const proof = (room: string) => { const ts = Date.now(); return { key, ts, sig: crypto.sign(null, Buffer.from(`sub-human machine:${room}:${ts}`), kp.privateKey).toString('base64url') }; };
  return { key, id: machineKey.idOf(key), proof };
}

/** An invite line to the room: its SECRET word (tagged for this home's machine key, as ssh and pipe lines are). */
function mint(host: RoomStore, kind = 'pipe') {
  const r = invites.mintInvite(host, { kind, locator: kind === 'ws' ? 'wss://box/sub-human/x' : 'pipe:/nowhere', by: 'alice' });
  const word = inviteSecret.encode(r.secret, inviteSecret.tagOf(r.secret, 'machine', machineKey.publicKey()));
  return { ...r, word, id: inviteSecret.idOf(r.secret) };
}

/** One connection to the host's server (opts: serve's, e.g. a web connection's via and peer). */
function dial(t: TestContext, host: RoomStore, m: ReturnType<typeof machine>, opts: Partial<ConnectOpts>, serveOpts: Partial<Parameters<typeof server.serve>[1]> = {}) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host, ...serveOpts });
  t.after(() => srv.close());
  return client.connect(a, { machine: m.id, machineKey: m.proof(host.code), ...opts });
}
const refused = async (p: Promise<unknown>): Promise<CodedError> => { try { await p; } catch (e) { return e as CodedError; } throw new Error('it was not refused'); };

/** The checkHost an invite line's joiner runs over ssh and a pipe (lib/remote/link-connect.ts). */
const checkHost = (code: string, word: string) => (host: { key: string; sig: string } | null, nonce: string) => {
  const d = inviteSecret.decode(word)!;
  const key = host && machineKey.verifyHost(host, code, nonce);
  if (!key || !inviteSecret.keyHolds(d, 'machine', key)) throw Object.assign(new Error('mismatch'), { code: 'AUTH', reason: 'HOST_KEY_MISMATCH' });
};

test('the host keeps no PIN in clear; the line\'s SECRET names this home\'s machine key; at most SHORT_LIVE_MAX open', t => {
  const { host } = hostRoom(t);
  const r = mint(host);
  const rec = recordOf(host, r.ref);
  assert.equal(rec.v, 4);
  assert.equal(rec.tries, config.INVITE_PIN_TRIES);
  assert.ok(!JSON.stringify(rec).includes(`"${r.pin}"`), 'no PIN in clear');
  assert.equal(rec.pin_sha256, crypto.createHash('sha256').update(`${r.id}:${r.pin}`).digest('hex'));
  assert.ok(!JSON.stringify(records(host)).includes(r.id), 'nor the secret: only its sha256 keys the record');
  assert.equal(inviteSecret.keyHolds(inviteSecret.decode(r.word)!, 'machine', machineKey.publicKey()), true);
  for (let i = 1; i < config.SHORT_LIVE_MAX; i++) mint(host);
  assert.throws(() => mint(host), /open already/);
});

test('ssh and pipe: the host proves its machine key over the joiner\'s nonce first; a line for another host sends nothing', async t => {
  const { code, host } = hostRoom(t);
  const r = mint(host);
  const m = machine();
  const e = await refused(dial(t, host, m, { invite: r.word, as: { name: 'carol', label: 'carols-mbp' }, checkHost: checkHost(code, r.word) }));
  assert.equal(e.reason, 'PIN_NEEDED', 'the key held: the SECRET went, and the host asks for the PIN');
  // another host (its machine key is not the one the tag names): stopped before the second hello
  const other = inviteSecret.encode(r.secret, inviteSecret.tagOf(r.secret, 'machine', crypto.randomBytes(32).toString('base64url')));
  const before = roomLines(host).length;
  const e2 = await refused(dial(t, host, m, { invite: other, pin: r.pin, as: { name: 'carol', label: 'x' }, checkHost: checkHost(code, other) }));
  assert.equal(e2.reason, 'HOST_KEY_MISMATCH');
  assert.equal(recordOf(host, r.ref).tries, config.INVITE_PIN_TRIES, 'no try spent: neither the SECRET nor the PIN went');
  assert.equal(roomLines(host).length, before);
  // an older host proves nothing: SKEW, before anything secret goes
  const e3 = await refused(dial(t, host, m, { invite: r.word, checkHost: checkHost(code, r.word) }, { proto: { min: 1, max: 2 }, version: '0.5.0-beta.15' }));
  assert.equal(e3.code, 'PROTOCOL');
  assert.match(e3.message, /host runs sub-human 0\.5\.0-beta\.15 \(protocol 1–2\).*The host must update/);
});

test('the PIN online: none asked for (free), a wrong one costs a try and a room line, the right one waits for the card; the throttle per invite and per source', async t => {
  const { code, host } = hostRoom(t);
  const r = mint(host);
  const carol = machine(), mallory = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  let now = Date.parse('2026-10-15T12:00:00Z');
  const redeem = (m: ReturnType<typeof machine>, pin?: string) => { try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as, pin, now }); return null; } catch (e) { return e as CodedError; } };
  assert.equal(redeem(carol)!.reason, 'PIN_NEEDED');
  assert.match(redeem(carol)!.message, /5 tries left/);
  assert.equal(recordOf(host, r.ref).tries, 5, 'asking for the PIN costs nothing');
  const wrong = String((Number(r.pin) + 1) % 10_000).padStart(4, '0');
  const w1 = redeem(mallory, wrong)!;
  assert.deepEqual([w1.code, w1.reason], ['AUTH', 'PIN_WRONG']);
  assert.match(w1.message, /4 tries left/);
  assert.match(String(w1.note), /carol on carols-mbp typed a wrong PIN for invite [0-9a-f]{12} \(4 tries left\)/);
  assert.equal(redeem(carol, r.pin)!.reason, 'PIN_THROTTLED', 'the invite takes no PIN for 2 s after a wrong one');
  assert.equal(recordOf(host, r.ref).tries, 4, 'a throttled PIN costs nothing');
  now += 2100;
  assert.equal(redeem(mallory, wrong)!.reason, 'PIN_THROTTLED', 'the machine that was wrong waits one step longer (4 s)');
  const held = redeem(carol, r.pin)!;
  assert.deepEqual([held.code, held.reason], ['OFFLINE', 'ADMIT_WAITING'], 'another machine past the invite\'s wait: the right PIN holds');
  assert.match(String(held.note), /carol on carols-mbp typed invite [0-9a-f]{12}'s PIN; waiting for alice to let them in \(the card, or \/sub-human admit [0-9a-f]{12}\)/);
  const adm = records(host)[invites.admissionSlot(r.id)] as AdmissionRecord;
  assert.deepEqual([adm.admit, adm.machine, adm.name, adm.label, adm.key, adm.by], ['asked', carol.id, 'carol', 'carols-mbp', null, 'alice']);
  assert.equal(inviteSecret.admissionRef(r.secret), invites.admissionSlot(r.id).slice(0, 12), 'the joiner computes the request\'s ref itself');
  assert.ok(recordOf(host, r.ref).used_at, 'the invite is used: no more PINs');
  assert.equal(redeem(carol)!.reason, 'ADMIT_WAITING', 'its redial without the PIN waits for the card');
  assert.equal(redeem(mallory, r.pin)!.reason, 'INVITE_USED', 'another machine with the line and the PIN: used');
  assert.equal(adm.from, r.ref, 'the request names the invite it came from');
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice', now });
  const made = invites.redeemInvite(host, r.id, { machine: carol.id, proven: carol.id, as, now });
  assert.deepEqual([made.link.seats, made.link.bound, made.link.machine, made.link.key], [['carol'], true, carol.id, undefined]);
  assert.equal(redeem(carol)!.reason, 'INVITE_USED', 'once');
});

test('five wrong PINs burn the invite; the right one after that is refused; a 0.5.0-beta.15 short invite is refused as an older one', t => {
  const { host } = hostRoom(t);
  const r = mint(host);
  let now = Date.parse('2026-10-15T12:00:00Z');
  const wrong = String((Number(r.pin) + 3) % 10_000).padStart(4, '0');
  let last: CodedError | null = null;
  for (let i = 0; i < 5; i++) {
    const m = machine(); // a fresh source each time: the invite's own wait still applies
    try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: wrong, now }); } catch (e) { last = e as CodedError; }
    now += 60_000;
  }
  assert.equal(last!.reason, 'PIN_LAST');
  assert.match(String(last!.note), /burnt after its last wrong PIN/);
  const m = machine();
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: r.pin, now }), (e: CodedError) => e.reason === 'INVITE_BURNT');
  // a record a 0.5.0-beta.15 host left (v 3, its PIN in clear): never redeemed
  const old = crypto.randomBytes(16).toString('base64url');
  host.kv.update(invites.INVITES_KEY, (cur: Invites | null) => ({ ...cur, [crypto.createHash('sha256').update(old).digest('hex')]: { v: 3, short: true, kind: 'ssh', locator: 'ssh:me@box', host_key: null, by: null, door_file: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), tries: 5, prs: '1234' } as ShortInvite }));
  assert.throws(() => invites.redeemInvite(host, old, { machine: m.id, proven: m.id, pin: '1234' }), /made by an older sub-human/);
});

test('over the web: the admission is bound to the Noise key the PIN\'s connection proved, the link too; a protocol-2 link keeps its token; an invite line needs protocol 3 and XK', async t => {
  const { host } = hostRoom(t);
  const r = mint(host, 'ws');
  const carol = machine();
  const K = crypto.randomBytes(32).toString('base64url'), K2 = crypto.randomBytes(32).toString('base64url');
  const web = (peer: string | null) => ({ via: 'ws' as const, peer });
  const as = { name: 'carol', label: 'carols-mbp' };
  const e1 = await refused(dial(t, host, carol, { invite: r.word, pin: r.pin, as }, web(K)));
  assert.equal(e1.reason, 'ADMIT_WAITING');
  const adm = records(host)[invites.admissionSlot(r.id)] as AdmissionRecord;
  assert.equal(adm.key, K);
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice' });
  const e2 = await refused(dial(t, host, carol, { invite: r.word }, web(K2)));
  assert.equal(e2.reason, 'KEY_MISMATCH', 'only the key the PIN came with redeems it');
  const c = await dial(t, host, carol, { invite: r.word }, web(K));
  assert.ok(c.token);
  const link = hostLinks.links(host)[c.link!];
  assert.deepEqual([link.key, link.seats, link.bound], [K, ['carol'], true]);
  c.close();
  // the link is its key: the token over another key, or over NK, gets nowhere; over its own key it does
  assert.equal((await refused(dial(t, host, carol, { token: c.token! }, web(K2)))).reason, 'KEY_MISMATCH');
  assert.equal((await refused(dial(t, host, carol, { token: c.token! }, web(null)))).reason, 'KEY_MISMATCH');
  (await dial(t, host, carol, { token: c.token! }, web(K))).close();
  // a link made before protocol 3 (no key): its token alone, over NK or anything
  const old = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: carol.id, seats: [] });
  (await dial(t, host, carol, { token: old.token }, web(null))).close();
  // an invite line over NK (an old joiner's handshake), or at protocol 2: SKEW
  const r2 = mint(host, 'ws');
  assert.equal((await refused(dial(t, host, carol, { invite: r2.word, as }, web(null)))).reason, 'SKEW');
  assert.equal((await refused(dial(t, host, carol, { invite: r2.word, as, proto: { min: 1, max: 2 } }))).reason, 'SKEW');
  assert.equal(recordOf(host, r2.ref).tries, 5);
});

test('machine-key: the host proof verifies only for its room and nonce', () => {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const p = machineKey.hostProof('vole-1234', nonce);
  assert.equal(machineKey.verifyHost(p, 'vole-1234', nonce), machineKey.publicKey());
  assert.equal(machineKey.verifyHost(p, 'vole-1235', nonce), null);
  assert.equal(machineKey.verifyHost(p, 'vole-1234', crypto.randomBytes(18).toString('base64url')), null);
  assert.equal(machineKey.verifyHost({ ...p, key: crypto.randomBytes(32).toString('base64url') }, 'vole-1234', nonce), null);
  assert.equal(machineKey.verifyHost(p, 'vole-1234', 'short'), null);
});
