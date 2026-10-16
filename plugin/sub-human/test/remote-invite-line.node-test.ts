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
import * as env from '../lib/env.ts';
import type { RoomStore } from '../lib/room/types.ts';
import type { Invites, ShortInvite, AdmissionRecord } from '../lib/remote/types-core.ts';
import type { RoomError } from '../lib/room/validate.ts';
import type { ConnectOpts } from '../lib/remote/client.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

function hostRoom(t: TestContext) {
  h.freshHome(t);
  const code = h.newRoom();
  return { code, host: store.open(code) };
}
const records = (host: RoomStore) => host.kv.get<Invites>(invites.INVITES_KEY, null) || {};
const recordOf = (host: RoomStore, ref: string): ShortInvite => {
  const rec = must(Object.entries(records(host)).find(([k]) => k.startsWith(ref)), `invite ${ref}`)[1];
  assert.ok(rec.short === true, 'an invite line\'s record');
  return rec;
};
/** The admission request invite id's PIN made. */
const admissionOf = (host: RoomStore, id: string): AdmissionRecord => {
  const rec = must(records(host)[invites.admissionSlot(id)], 'the admission');
  assert.ok(rec.admission === true, 'an admission record');
  return rec;
};
const roomLines = (host: RoomStore) => host.readAll().filter(e => e.from === 'room').map(e => e.text);

/** A machine of the joiner's own: an Ed25519 key, and its proof for room code (what machine-key.ts proof makes). */
function machine() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const key = must(kp.publicKey.export({ format: 'jwk' }).x);
  const proof = (room: string) => { const ts = Date.now(); return { key, ts, sig: crypto.sign(null, Buffer.from(`sub-human machine:${room}:${ts}`), kp.privateKey).toString('base64url') }; };
  // over the host's challenge (machine-key.ts proofFor): what an invite line's hello carries
  const proofFor = (room: string, challenge: string) => ({ key, ts: Date.now(), sig: crypto.sign(null, Buffer.from(`sub-human machine v2:${room}:${challenge}`), kp.privateKey).toString('base64url') });
  return { key, id: machineKey.idOf(key), proof, proofFor };
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
  return client.connect(a, { machine: m.id, machineKey: m.proof(host.code), signMachine: (ch: string) => m.proofFor(host.code, ch), ...opts });
}
const refused = async (p: Promise<unknown>): Promise<RoomError> => { try { await p; } catch (e) { return e as RoomError; } throw new Error('it was not refused'); };

/** The checkHost an invite line's joiner runs over ssh and a pipe (lib/remote/link-connect.ts). */
const checkHost = (code: RoomCode, word: string) => (host: { key: string; sig: string } | null, nonce: string) => {
  const d = must(inviteSecret.decode(word));
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
  assert.equal(inviteSecret.keyHolds(must(inviteSecret.decode(r.word)), 'machine', machineKey.publicKey()), true);
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
  const { host } = hostRoom(t);
  const r = mint(host);
  const carol = machine(), mallory = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  let now = Date.parse('2026-10-15T12:00:00Z');
  const redeem = (m: ReturnType<typeof machine>, pin?: string) => { try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as, pin, now }); return null; } catch (e) { return e as RoomError; } };
  assert.equal(must(redeem(carol)).reason, 'PIN_NEEDED');
  assert.match(must(redeem(carol)).message, /5 tries left/);
  assert.equal(recordOf(host, r.ref).tries, 5, 'asking for the PIN costs nothing');
  const wrong = String((Number(r.pin) + 1) % 10_000).padStart(4, '0');
  const w1 = must(redeem(mallory, wrong));
  assert.deepEqual([w1.code, w1.reason], ['AUTH', 'PIN_WRONG']);
  assert.match(w1.message, /4 tries left/);
  assert.match(String(w1.note), /^a wrong PIN for invite [0-9a-f]{12} \(4 tries left; it asked to join as carol\)$/, 'no label: a room line every Claude reads carries nothing the joiner chose but a checked name');
  assert.equal(must(redeem(carol, r.pin)).reason, 'PIN_THROTTLED', 'the invite takes no PIN for 2 s after a wrong one');
  assert.equal(recordOf(host, r.ref).tries, 4, 'a throttled PIN costs nothing');
  now += 2100;
  assert.equal(must(redeem(mallory, wrong)).reason, 'PIN_THROTTLED', 'the machine that was wrong waits one step longer (4 s)');
  const held = must(redeem(carol, r.pin));
  assert.deepEqual([held.code, held.reason], ['OFFLINE', 'ADMIT_WAITING'], 'another machine past the invite\'s wait: the right PIN holds');
  assert.match(String(held.note), /carol on carols-mbp typed invite [0-9a-f]{12}'s PIN; waiting for alice to let them in \(the card, or \/sub-human admit [0-9a-f]{12}\)/);
  const adm = admissionOf(host, r.id);
  assert.deepEqual([adm.admit, adm.machine, adm.name, adm.label, adm.key, adm.by], ['asked', carol.id, 'carol', 'carols-mbp', null, 'alice']);
  assert.equal(inviteSecret.admissionRef(r.secret), invites.admissionSlot(r.id).slice(0, 12), 'the joiner computes the request\'s ref itself');
  assert.ok(recordOf(host, r.ref).used_at, 'the invite is used: no more PINs');
  assert.equal(must(redeem(carol)).reason, 'ADMIT_WAITING', 'its redial without the PIN waits for the card');
  const second = must(redeem(mallory, r.pin));
  assert.equal(second.reason, 'INVITE_USED', 'another machine with the line and the PIN: used');
  // the check the card shows is the machine's, not the line's: a thief with the line and the PIN shows another one,
  // and the room hears of the second machine with both checks (once)
  const carolCheck = inviteSecret.joinCheck(carol.id), malloryCheck = inviteSecret.joinCheck(mallory.id);
  assert.notEqual(carolCheck, malloryCheck);
  assert.match(carolCheck, /^check [0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(admission.describe({ ...adm, slot: invites.admissionSlot(r.id), ref: adm.from }), `carol (${carolCheck}) on carols-mbp`);
  assert.ok(String(second.note).includes(malloryCheck) && String(second.note).includes(carolCheck), String(second.note));
  assert.match(String(second.note), /a second machine \(check .*\) presented invite [0-9a-f]{12}, which carol \(check .*\) used already: if carol's screen does not show .*, refuse the card and invite again/);
  assert.equal(must(redeem(mallory, r.pin)).note, undefined, 'one room line per machine');
  assert.equal(adm.from, r.ref, 'the request names the invite it came from');
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice', now });
  const made = invites.redeemInvite(host, r.id, { machine: carol.id, proven: carol.id, as, now });
  assert.deepEqual([made.link.seats, made.link.bound, made.link.machine, made.link.key], [['carol'], true, carol.id, undefined]);
  assert.equal(must(redeem(carol)).reason, 'INVITE_USED', 'once');
});

test('five wrong PINs burn the invite; the right one after that is refused; a 0.5.0-beta.15 short invite is refused as an older one', t => {
  const { host } = hostRoom(t);
  const r = mint(host);
  let now = Date.parse('2026-10-15T12:00:00Z');
  const wrong = String((Number(r.pin) + 3) % 10_000).padStart(4, '0');
  let last: RoomError | null = null;
  for (let i = 0; i < 5; i++) {
    const m = machine(); // a fresh source each time: the invite's own wait still applies
    try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: wrong, now }); } catch (e) { last = e as RoomError; }
    now += 60_000;
  }
  assert.equal(must(last).reason, 'PIN_LAST');
  assert.match(String(must(last).note), /burnt after its last wrong PIN/);
  const m = machine();
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: r.pin, now }), (e: RoomError) => e.reason === 'INVITE_BURNT');
  // no try left but no burnt_at (a record whose last wrong PIN was not marked): the right PIN is refused all the same
  const z = mint(host);
  host.kv.update(invites.INVITES_KEY, (cur: Invites | null) => { const k = crypto.createHash('sha256').update(z.id).digest('hex'); return { ...cur, [k]: { ...must(must(cur)[k]), tries: 0 } }; });
  assert.throws(() => invites.redeemInvite(host, z.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: z.pin, now: Date.now() }), (e: RoomError) => e.reason === 'INVITE_BURNT');
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
  const adm = admissionOf(host, r.id);
  assert.equal(adm.key, K);
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice' });
  const e2 = await refused(dial(t, host, carol, { invite: r.word }, web(K2)));
  assert.equal(e2.reason, 'KEY_MISMATCH', 'only the key the PIN came with redeems it');
  const c = await dial(t, host, carol, { invite: r.word }, web(K));
  assert.ok(c.token);
  const link = must(hostLinks.links(host)[must(c.link)]);
  assert.deepEqual([link.key, link.seats, link.bound], [K, ['carol'], true]);
  c.close();
  // the link is its key: the token over another key gets nowhere; over its own key it does
  assert.equal((await refused(dial(t, host, carol, { token: must(c.token) }, web(K2)))).reason, 'KEY_MISMATCH');
  (await dial(t, host, carol, { token: must(c.token) }, web(K))).close();
  // an invite line at protocol 2 (0.5.0-beta.15): SKEW, no try spent
  const r2 = mint(host, 'ws');
  assert.equal((await refused(dial(t, host, carol, { invite: r2.word, as, proto: { min: 1, max: 2 } }))).reason, 'SKEW');
  assert.equal(recordOf(host, r2.ref).tries, 5);
});

test('machine-key: an invite line\'s machine proof is bound to the session\'s challenge; a proof from another session, or a ts-only one, proves nothing', async t => {
  const { host } = hostRoom(t);
  const r = mint(host, 'ws');
  const carol = machine();
  const web = { via: 'ws' as const, peer: crypto.randomBytes(32).toString('base64url') };
  const as = { name: 'carol', label: 'carols-mbp' };
  // a proof carol signed for one session's challenge, replayed by someone who saw it (a former host) in a new session
  let seen: { key: string; ts: number; sig: string } | null = null;
  const e1 = await refused(dial(t, host, carol, { invite: r.word, as, signMachine: (ch: string) => (seen = carol.proofFor(host.code, ch)) }, web));
  assert.equal(e1.reason, 'PIN_NEEDED');
  const replay = await refused(dial(t, host, carol, { invite: r.word, pin: r.pin, as, signMachine: () => must(seen) }, web));
  assert.equal(replay.reason, 'SKEW', 'no proven machine: a PIN goes only with a key proved in this session');
  // the old proof over room:ts alone (what a 10-minute window let a former host replay) proves nothing for a line
  // @ts-expect-error -- deliberate: signMachine undefined overrides dial's own
  const tsOnly = await refused(dial(t, host, carol, { invite: r.word, pin: r.pin, as, signMachine: undefined }, web));
  assert.equal(tsOnly.reason, 'SKEW');
  assert.equal(recordOf(host, r.ref).tries, 5, 'neither cost a try');
  assert.equal(machineKey.verifyFor(carol.proofFor(host.code, 'a'.repeat(24)), host.code, 'b'.repeat(24)), null);
  assert.equal(machineKey.verifyFor(carol.proofFor(host.code, 'a'.repeat(24)), host.code, 'a'.repeat(24)), carol.id);
  // the joiner itself, in its own session: the PIN holds
  assert.equal((await refused(dial(t, host, carol, { invite: r.word, pin: r.pin, as }, web))).reason, 'ADMIT_WAITING');
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

test('the PIN\'s backoff and the card\'s wait take their SUB_HUMAN_* overrides only under the tests; a label is cut short', t => {
  const was = { T: process.env.SUB_HUMAN_TEST, B: process.env.SUB_HUMAN_PIN_BACKOFF_MS, A: process.env.SUB_HUMAN_ADMIT_TTL_MS };
  t.after(() => {
    for (const [k, v] of [['SUB_HUMAN_TEST', was.T], ['SUB_HUMAN_PIN_BACKOFF_MS', was.B], ['SUB_HUMAN_ADMIT_TTL_MS', was.A]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  process.env.SUB_HUMAN_PIN_BACKOFF_MS = '1';
  process.env.SUB_HUMAN_ADMIT_TTL_MS = '1';
  assert.equal(env.testMs('SUB_HUMAN_PIN_BACKOFF_MS'), 1, 'under the tests');
  delete process.env.SUB_HUMAN_TEST;
  assert.equal(env.testMs('SUB_HUMAN_PIN_BACKOFF_MS'), config.PIN_BACKOFF_MS, 'a person\'s env cannot make the backoff 1 ms');
  // a wrong PIN outside the tests: the invite's wait is the real one
  const { host } = hostRoom(t);
  const r = mint(host);
  const m = machine();
  const now = Date.parse('2026-10-15T12:00:00Z');
  const wrong = String((Number(r.pin) + 1) % 10_000).padStart(4, '0');
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'carol', label: 'x'.repeat(64) }, pin: wrong, now }));
  assert.equal(Date.parse(must(recordOf(host, r.ref).next_at)) - now, config.PIN_BACKOFF_MS);
  try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'carol', label: 'x'.repeat(64) }, pin: r.pin, now: now + 60_000 }); } catch { /* waiting */ }
  const adm = admissionOf(host, r.id);
  assert.equal(adm.label, 'x'.repeat(24), 'the card and the room line show 24 characters of it');
  assert.equal(Date.parse(adm.expires_at) - (now + 60_000), config.ADMIT_TTL_MS, 'the card\'s real wait');
});

test('R4 (live verify, verify6/11): a name that sits in the room from another machine: the card offers "Let in as NAME2" only, the link is bound to it, and the joiner\'s hello learns it', async t => {
  const { code, host } = hostRoom(t);
  const old = machine(), carol = machine();
  const at = new Date().toISOString();
  host.members.update(ms => ({ ...ms, carol: { name: sn('carol'), role: 'member', machine: old.id, joined_at: at, seen_at: at } }));
  const r = mint(host);
  const as = { name: 'carol', label: 'carols-new-mbp' };
  const held = await refused(dial(t, host, carol, { invite: r.word, pin: r.pin, as, checkHost: checkHost(code, r.word) }));
  assert.equal(held.reason, 'ADMIT_WAITING');
  const req = must(admission.pending(code)[0], 'the request');
  assert.equal(admission.taken(code, req), 'carol2');
  const options = must(admission.card(req, code).questions[0]).options.map(o => o.label);
  assert.deepEqual(options, ['Let in as carol2', admission.REFUSE], 'never "Let in" as the taken name: that seat would be refused');
  assert.throws(() => admission.letIn(code, req.ref, { by: 'alice', as: 'carol' }), /can be let in as carol2 only/);
  const res = admission.letIn(code, req.ref, { by: 'alice', as: 'carol2' });
  assert.match(res.text, /as carol2 only/);
  const c = await dial(t, host, carol, { invite: r.word, as, checkHost: checkHost(code, r.word) });
  assert.ok(c.token);
  assert.equal(c.as, 'carol2', 'the hello says the name the link is bound to');
  const link = must(Object.values(hostLinks.links(host)).find(l => l.machine === carol.id));
  assert.deepEqual(link.seats, ['carol2']);
  // the same machine as the seat's (a rejoin from its own home): the plain card, as before
  const r2 = mint(host);
  await refused(dial(t, host, old, { invite: r2.word, pin: r2.pin, as, checkHost: checkHost(code, r2.word) }));
  const req2 = must(admission.pending(code).find(q => q.machine === old.id));
  assert.equal(admission.taken(code, req2), null);
  assert.equal(must(must(admission.card(req2, code).questions[0]).options[0]).label, admission.LET_IN);
});
