// An invite line (protocol 3) at the wire, the host's end on a real hosted store and the joiner's as client.connect
// over the memory transport: the host keeps no PIN in clear; a hello with the SECRET and no PIN is asked for the PIN and
// charged nothing; a wrong PIN costs a try, waits (per invite, longer per source machine) and the fifth burns the
// invite, and none makes a card; the right PIN lets in the machine its key proves (and, over the web, the Noise key its
// connection proved) and links it in the same hello, for the one name, with a room line naming its check and the kick.
// A hello with no PIN and knock: true uses the invite (one knock per invite), spends no try and waits for the card;
// once let in, that machine (and key) alone redeems it, and the right PIN typed meanwhile lets it in at once. A machine
// that typed a wrong PIN, nor another once one was typed, knocks its way to a card. The right PIN from another machine
// replaces a waiting knock (the line alone may have leaked): its card goes and its link is refused; a knock replaces
// nothing. A hello with neither (an older joiner) is asked for the PIN. Over ssh and a pipe the host proves its machine key over the joiner's nonce first: a host the line does not
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
import { RoomError } from '../lib/room/validate.ts';
import type { ConnectOpts } from '../lib/remote/client.ts';
import type { RoomCode, MachineId } from '../lib/brand.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0' });

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
/** Every admission record of the room, whatever its state. */
const allAdmissions = (host: RoomStore) => Object.values(records(host)).filter(i => i.admission === true);

/** A knock: the line with no PIN and the hello's knock (lib/remote/link-connect.ts sends it), answered ADMIT_WAITING;
 * the admission it asks the card for. */
function ask(host: RoomStore, r: { id: string }, m: { id: MachineId }, { name = 'carol', label = 'carols-mbp', key = null, now }: { name?: string; label?: string; key?: string | null; now?: number } = {}): AdmissionRecord {
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, knock: true, as: { name, label }, peerKey: key, ...(now !== undefined ? { now } : {}) }),
    (e: RoomError) => e.code === 'OFFLINE' && e.reason === 'ADMIT_WAITING');
  return admissionOf(host, r.id);
}

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

test('the PIN online: none asked for (free), a wrong one costs a try and a room line and makes no card, the right one links in that hello (no card); the throttle per invite and per source', async t => {
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
  assert.deepEqual(allAdmissions(host), [], 'a wrong PIN never makes a card');
  // another machine past the invite's wait: the right PIN lets it in and links it in the same hello
  const made = invites.redeemInvite(host, r.id, { machine: carol.id, proven: carol.id, as, pin: r.pin, now });
  assert.deepEqual([made.link.seats, made.link.bound, made.link.machine, made.link.key], [['carol'], true, carol.id, undefined]);
  assert.ok(made.token, 'the link\'s token, in this hello');
  const adm = admissionOf(host, r.id);
  assert.deepEqual([adm.admit, adm.admitted_by, adm.machine, adm.name, adm.label, adm.key, adm.by, adm.link], ['let-in', 'pin', carol.id, 'carol', 'carols-mbp', null, 'alice', made.link.id]);
  assert.equal(adm.admit_sig, undefined, 'no person signed it: the PIN let it in');
  assert.ok(adm.used_at, 'redeemed already');
  assert.equal(made.admission?.admitted_by, 'pin', 'the server\'s room line reads how it got in');
  assert.deepEqual(admission.admissions(host), [], 'no card: nothing waits for the host person');
  assert.equal(inviteSecret.admissionRef(r.secret), invites.admissionSlot(r.id).slice(0, 12), 'the joiner computes the record\'s ref itself');
  assert.ok(recordOf(host, r.ref).used_at, 'the invite is used: no more PINs');
  assert.equal(must(redeem(carol)).reason, 'INVITE_USED', 'the line again from the same machine: used (its token is the credential now)');
  const second = must(redeem(mallory, r.pin));
  assert.equal(second.reason, 'INVITE_USED', 'another machine with the line and the PIN: used');
  // the check the card shows is the machine's, not the line's: a thief with the line and the PIN shows another one,
  // and the room hears of the second machine with both checks (once)
  const carolCheck = inviteSecret.joinCheck(carol.id), malloryCheck = inviteSecret.joinCheck(mallory.id);
  assert.notEqual(carolCheck, malloryCheck);
  assert.match(carolCheck, /^check [0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(admission.describe({ ...adm, slot: invites.admissionSlot(r.id), ref: adm.from }), `carol (${carolCheck}) on carols-mbp`);
  assert.ok(String(second.note).includes(malloryCheck) && String(second.note).includes(carolCheck), String(second.note));
  assert.match(String(second.note), /a second machine \(check .*\) presented invite [0-9a-f]{12}, which carol \(check .*\) used already: if carol's screen does not show .*, kick them \(\/sub-human kick carol\) and invite again/);
  assert.equal(must(redeem(mallory, r.pin)).note, undefined, 'one room line per machine');
  assert.equal(adm.from, r.ref, 'the record names the invite it came from');
  assert.deepEqual(Object.keys(hostLinks.links(host)), [made.link.id], 'one link: the second machine got none');
});

test('a knock (no PIN, knock: true) asks the card and spends no try: ADMIT_WAITING until let in, then that machine alone redeems it, once; an older joiner\'s hello (no knock) is asked for the PIN', async t => {
  const { host } = hostRoom(t);
  const r = mint(host);
  const carol = machine(), mallory = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  const redeem = (m: ReturnType<typeof machine>, more: { knock?: boolean } = {}) => { try { invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as, ...more }); return null; } catch (e) { return e as RoomError; } };
  // a hello with no PIN and no knock (a joiner before the knock): asked for the PIN, as ever, and nothing written
  const old = await refused(dial(t, host, carol, { invite: r.word, as }));
  assert.deepEqual([old.code, old.reason], ['AUTH', 'PIN_NEEDED']);
  assert.deepEqual(allAdmissions(host), [], 'no card for a hello that did not knock');
  // the knock over the wire: the host's card asks, the invite is used, no try spent
  const w = await refused(dial(t, host, carol, { invite: r.word, knock: true, as }));
  assert.deepEqual([w.code, w.reason], ['OFFLINE', 'ADMIT_WAITING']);
  const req = admissionOf(host, r.id);
  assert.deepEqual([req.admit, req.machine, req.name, req.label, req.by, req.from], ['asked', carol.id, 'carol', 'carols-mbp', 'alice', r.ref]);
  assert.equal(Date.parse(req.expires_at) - Date.parse(req.created_at), env.testMs('SUB_HUMAN_ADMIT_TTL_MS'), 'it waits ADMIT_TTL_MS');
  assert.deepEqual([recordOf(host, r.ref).tries, !!recordOf(host, r.ref).used_at, recordOf(host, r.ref).link], [5, true, req.link], 'the knock uses the invite and spends no try');
  assert.equal(must(admission.admissions(host)[0], 'the request').link, req.link, 'the card asks');
  assert.equal(must(redeem(carol)).reason, 'ADMIT_WAITING');
  assert.equal(must(redeem(carol, { knock: true })).reason, 'ADMIT_WAITING', 'a redial knocks again: still the one request');
  assert.equal(allAdmissions(host).length, 1);
  // one knock per invite: a second machine knocking on it gets INVITE_USED, and the room hears of it
  const second = must(redeem(mallory, { knock: true }));
  assert.equal(second.reason, 'INVITE_USED');
  assert.match(String(second.note), /if carol's screen does not show .*, refuse the card and invite again/);
  assert.equal(admissionOf(host, r.id).machine, carol.id, 'the request stays carol\'s');
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice' });
  const made = invites.redeemInvite(host, r.id, { machine: carol.id, proven: carol.id, as });
  assert.deepEqual([made.link.seats, made.link.bound, made.link.machine, made.link.id], [['carol'], true, carol.id, req.link]);
  assert.equal(made.admission?.admitted_by, 'alice');
  assert.equal(must(redeem(carol)).reason, 'INVITE_USED', 'once');
});

test('a knock and the PIN: a machine that typed a wrong PIN waits, then is asked for the PIN (a miss never turns into a card); the right PIN while the card waits links at once; a wrong one costs a try, and the last burns the knock', t => {
  const { host } = hostRoom(t);
  const carol = machine(), mallory = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  let now = Date.parse('2026-10-15T12:00:00Z');
  const redeemOf = (r: { id: string }) => (m: ReturnType<typeof machine>, more: { knock?: boolean; pin?: string } = {}) => {
    try { return invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as, now, ...more }); } catch (e) { assert.ok(e instanceof RoomError); return e; }
  };
  const errOf = (x: unknown): RoomError => { assert.ok(x instanceof RoomError, JSON.stringify(x)); return x; };
  // the throttle per machine: a wrong PIN, then a knock from that machine waits; past the wait it is asked for the PIN
  const r = mint(host);
  const redeem = redeemOf(r);
  const wrong = String((Number(r.pin) + 1) % 10_000).padStart(4, '0');
  assert.equal(errOf(redeem(mallory, { pin: wrong })).reason, 'PIN_WRONG');
  assert.equal(errOf(redeem(mallory, { knock: true })).reason, 'PIN_THROTTLED', 'the machine that was wrong waits');
  now += 60_000;
  const after = errOf(redeem(mallory, { knock: true }));
  assert.equal(after.reason, 'PIN_NEEDED');
  assert.match(after.message, /this machine typed a wrong PIN for it/);
  assert.deepEqual(allAdmissions(host), [], 'a wrong PIN, and a knock after it, never make a card');
  assert.equal(recordOf(host, r.ref).tries, 4, 'the knocks cost nothing');
  // nor does another machine knock its way to a card once a wrong PIN was typed for the invite (the guesser's second
  // machine): it is asked for the PIN, during the invite's wait and after it
  const other = errOf(redeem(machine(), { knock: true }));
  assert.equal(other.reason, 'PIN_NEEDED');
  assert.match(other.message, /a wrong PIN was typed for it: this invite needs its PIN now/);
  assert.deepEqual(allAdmissions(host), [], 'no card for a knock after a wrong PIN, from any machine');
  assert.ok(!recordOf(host, r.ref).used_at, 'the refused knock did not use the invite');
  // a knock on a fresh invite, then the right PIN while it waits (a wrong one first costs a try and waits)
  const fresh = mint(host);
  const rk = redeemOf(fresh);
  const kWrong = String((Number(fresh.pin) + 1) % 10_000).padStart(4, '0');
  ask(host, fresh, carol, { now });
  now += 1000;
  assert.equal(errOf(rk(carol, { pin: kWrong })).reason, 'PIN_WRONG', 'a wrong PIN after a knock costs a try');
  assert.equal(recordOf(host, fresh.ref).tries, 4);
  assert.equal(errOf(rk(carol, { pin: fresh.pin })).reason, 'PIN_THROTTLED', 'and waits, as on the line');
  assert.equal(admission.admissions(host, { now }).length, 1, 'the card still waits');
  now += 60_000;
  const made = rk(carol, { pin: fresh.pin });
  assert.ok(!(made instanceof Error), String(made));
  const adm = admissionOf(host, fresh.id);
  assert.deepEqual([adm.admit, adm.admitted_by, adm.link, made.link.id, made.link.seats, adm.replaced], ['let-in', 'pin', adm.link, adm.link, ['carol'], undefined]);
  assert.equal(made.admission?.admitted_by, 'pin', 'the room line says it joined by its PIN');
  assert.deepEqual(admission.admissions(host), [], 'the card is gone: nothing waits for the host person');
  assert.throws(() => admission.decide(host, invites.admissionSlot(fresh.id).slice(0, 12), { decision: 'let-in', by: 'alice', now }), /let in already/);
  // the last wrong PIN after a knock burns the invite and the knock
  const z = mint(host);
  const rz = redeemOf(z);
  ask(host, z, carol, { now });
  // past the waits (the invite's and this machine's), as a patient guesser would be
  const unwait = () => host.kv.update(invites.INVITES_KEY, (cur: Invites | null) => { const k = crypto.createHash('sha256').update(z.id).digest('hex'); return { ...cur, [k]: { ...must(must(cur)[k]), next_at: new Date(0).toISOString(), sources: {} } }; });
  for (let i = 0; i < 4; i++) {
    now += 1000;
    unwait();
    assert.equal(errOf(rz(carol, { pin: wrong })).reason, 'PIN_WRONG', `try ${i + 1}`);
  }
  unwait();
  assert.equal(errOf(rz(carol, { pin: wrong })).reason, 'PIN_LAST');
  assert.ok(admissionOf(host, z.id).burnt_at, 'the knock burns with the invite');
  assert.deepEqual(admission.admissions(host, { now }), [], 'no card left');
  assert.equal(errOf(rz(carol, { pin: z.pin })).reason, 'INVITE_BURNT');
});

test('a knock: Refuse stops it; nobody answering lapses it', t => {
  const { host } = hostRoom(t);
  const carol = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  const r = mint(host);
  ask(host, r, carol);
  admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'refused', by: 'alice' });
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: carol.id, proven: carol.id, as, knock: true }), (e: RoomError) => e.reason === 'ADMIT_REFUSED');
  const z = mint(host);
  const req = ask(host, z, carol);
  const late = Date.parse(req.expires_at) + 1;
  assert.deepEqual(admission.lapseAdmissions(host, { now: late }).map(q => q.name), ['carol']);
  assert.throws(() => invites.redeemInvite(host, z.id, { machine: carol.id, proven: carol.id, as, knock: true, now: late }), (e: RoomError) => e.reason === 'ADMIT_LAPSED');
});

test('a knock from a machine with the leaked line, then the right PIN from another: the PIN replaces the knock (its card goes, its link is refused, the room hears both checks); a wrong one costs a try and makes no card; a knock never replaces anything', async t => {
  const { code, host } = hostRoom(t);
  const mallory = machine(), carol = machine(), third = machine();
  const as = { name: 'carol', label: 'carols-mbp' };
  const errOf = (f: () => unknown): RoomError => { try { f(); } catch (e) { assert.ok(e instanceof RoomError); return e; } throw new Error('it was not refused'); };
  // the leaked line alone, first, as "cameron": the card asks
  const r = mint(host);
  ask(host, r, mallory, { name: 'cameron', label: 'mbp' });
  // a knock from a third machine replaces nothing
  assert.equal(errOf(() => invites.redeemInvite(host, r.id, { machine: third.id, proven: third.id, as, knock: true })).reason, 'INVITE_USED');
  assert.equal(admissionOf(host, r.id).machine, mallory.id, 'the knock stays the one waiting');
  // the real joiner, over the wire, with the line and the right PIN: in, in this hello
  const c = await dial(t, host, carol, { invite: r.word, pin: r.pin, as, checkHost: checkHost(code, r.word) });
  assert.ok(c.token, 'linked in this hello');
  c.close();
  const adm = admissionOf(host, r.id);
  assert.deepEqual([adm.admit, adm.admitted_by, adm.machine, adm.name, adm.link], ['let-in', 'pin', carol.id, 'carol', c.link]);
  assert.deepEqual(adm.replaced, { machine: mallory.id, key: null, name: 'cameron' });
  assert.deepEqual(admission.admissions(host), [], 'the knock\'s card is gone');
  assert.throws(() => admission.decide(host, invites.admissionSlot(r.id).slice(0, 12), { decision: 'let-in', by: 'alice' }), /let in already/, 'a card shown already lets nothing in');
  const knocked = inviteSecret.joinCheck(mallory.id), joined = inviteSecret.joinCheck(carol.id);
  const line = must(roomLines(host).find(l => !!l?.startsWith('a machine that knocked without the PIN')), JSON.stringify(roomLines(host)));
  assert.equal(line, `a machine that knocked without the PIN (cameron, ${knocked}) was replaced by the one with the PIN (carol, ${joined}): its card is gone, and its join stops`);
  assert.ok(roomLines(host).includes(`carol joined from carols-mbp (${joined}) · not them? /sub-human kick carol`));
  // the knocking machine's link ends refused, with the PIN or without, and takes nothing back
  for (const more of [{ knock: true }, { pin: r.pin }]) {
    assert.equal(errOf(() => invites.redeemInvite(host, r.id, { machine: mallory.id, proven: mallory.id, as: { name: 'cameron', label: 'mbp' }, ...more })).reason, 'ADMIT_REFUSED');
  }
  assert.equal(admissionOf(host, r.id).machine, carol.id);
  assert.deepEqual(Object.keys(hostLinks.links(host)), [c.link], 'one link: carol\'s');

  // a wrong PIN from another machine while a knock waits: a try and a room line, never a card; too soon waits; the last
  // burns the knock with the invite
  let now = Date.parse('2026-10-15T12:00:00Z');
  const z = mint(host);
  const wrong = String((Number(z.pin) + 1) % 10_000).padStart(4, '0');
  const rz = (m: ReturnType<typeof machine>, pin: string) => errOf(() => invites.redeemInvite(host, z.id, { machine: m.id, proven: m.id, as, pin, now }));
  ask(host, z, mallory, { name: 'cameron', label: 'mbp', now });
  const w = rz(carol, wrong);
  assert.equal(w.reason, 'PIN_WRONG');
  assert.match(String(w.note), /a wrong PIN for invite [0-9a-f]{12} \(4 tries left; it asked to join as carol\)/);
  assert.equal(rz(carol, z.pin).reason, 'PIN_THROTTLED', 'the right one too soon waits, as on the line');
  assert.deepEqual([recordOf(host, z.ref).tries, allAdmissions(host).filter(a => a.from === z.ref).length, admissionOf(host, z.id).machine, admissionOf(host, z.id).admit], [4, 1, mallory.id, 'asked'], 'no card of its own: the knock still waits');
  const unwait = () => host.kv.update(invites.INVITES_KEY, (cur: Invites | null) => { const k = crypto.createHash('sha256').update(z.id).digest('hex'); return { ...cur, [k]: { ...must(must(cur)[k]), next_at: new Date(0).toISOString(), sources: {} } }; });
  for (let i = 0; i < 3; i++) { now += 1000; unwait(); assert.equal(rz(carol, wrong).reason, 'PIN_WRONG'); }
  now += 1000;
  unwait();
  assert.equal(rz(carol, wrong).reason, 'PIN_LAST');
  assert.ok(admissionOf(host, z.id).burnt_at, 'the knock burns with the invite');
  assert.equal(admissionOf(host, z.id).machine, mallory.id, 'and was never replaced');
  assert.deepEqual(admission.admissions(host, { now }), [], 'no card left');
});

test('five wrong PINs burn the invite; the right one after that is refused', t => {
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
  assert.deepEqual(allAdmissions(host), [], 'no wrong PIN, nor the last, falls back to a card');
  const m = machine();
  assert.throws(() => invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: r.pin, now }), (e: RoomError) => e.reason === 'INVITE_BURNT');
  // no try left but no burnt_at (a record whose last wrong PIN was not marked): the right PIN is refused all the same
  const z = mint(host);
  host.kv.update(invites.INVITES_KEY, (cur: Invites | null) => { const k = crypto.createHash('sha256').update(z.id).digest('hex'); return { ...cur, [k]: { ...must(must(cur)[k]), tries: 0 } }; });
  assert.throws(() => invites.redeemInvite(host, z.id, { machine: m.id, proven: m.id, as: { name: 'x', label: 'x' }, pin: z.pin, now: Date.now() }), (e: RoomError) => e.reason === 'INVITE_BURNT');
});

test('over the web: the link the right PIN makes is bound to the Noise key its connection proved, and a card\'s too; the room line names the check; an invite line needs protocol 3', async t => {
  const { host } = hostRoom(t);
  const r = mint(host, 'ws');
  const carol = machine();
  const K = crypto.randomBytes(32).toString('base64url'), K2 = crypto.randomBytes(32).toString('base64url');
  const web = (peer: string | null) => ({ via: 'ws' as const, peer });
  const as = { name: 'carol', label: 'carols-mbp' };
  const c = await dial(t, host, carol, { invite: r.word, pin: r.pin, as }, web(K));
  assert.ok(c.token, 'the right PIN: linked in this hello');
  assert.equal(admissionOf(host, r.id).key, K);
  const link = must(hostLinks.links(host)[must(c.link)]);
  assert.deepEqual([link.key, link.seats, link.bound], [K, ['carol'], true]);
  const check = inviteSecret.joinCheck(carol.id, K);
  assert.ok(roomLines(host).includes(`carol joined from carols-mbp (${check}) · not them? /sub-human kick carol`), JSON.stringify(roomLines(host)));
  assert.deepEqual(admission.admissions(host), [], 'no card');
  c.close();
  // a knock's admission is bound to the key its connection proved: only that key redeems it once the card lets it in
  const k = mint(host, 'ws');
  assert.equal((await refused(dial(t, host, carol, { invite: k.word, knock: true, as }, web(K)))).reason, 'ADMIT_WAITING');
  assert.equal(admissionOf(host, k.id).key, K);
  admission.decide(host, invites.admissionSlot(k.id).slice(0, 12), { decision: 'let-in', by: 'alice' });
  assert.equal((await refused(dial(t, host, carol, { invite: k.word }, web(K2)))).reason, 'KEY_MISMATCH', 'only the key the request came with redeems it');
  const c2 = await dial(t, host, carol, { invite: k.word }, web(K));
  assert.ok(c2.token);
  c2.close();
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
  // the joiner itself, in its own session: the PIN holds, and links it
  const c = await dial(t, host, carol, { invite: r.word, pin: r.pin, as }, web);
  assert.ok(c.token);
  c.close();
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
  invites.redeemInvite(host, r.id, { machine: m.id, proven: m.id, as: { name: 'carol', label: 'x'.repeat(64) }, pin: r.pin, now: now + 60_000 });
  const adm = admissionOf(host, r.id);
  assert.equal(adm.label, 'x'.repeat(24), 'the card and the room line show 24 characters of it');
  assert.equal(env.testMs('SUB_HUMAN_ADMIT_TTL_MS'), config.ADMIT_TTL_MS, 'the card\'s real wait');
});

test('R4 (live verify, verify6/11): a name that sits in the room from another machine: the right PIN lets it in as NAME2 (no card), the card offers "Let in as NAME2" only; the link is bound to it, and the joiner\'s hello learns it', async t => {
  const { code, host } = hostRoom(t);
  const old = machine(), carol = machine(), dave = machine();
  const at = new Date().toISOString();
  host.members.update(ms => ({ ...ms, carol: { name: sn('carol'), role: 'member', machine: old.id, joined_at: at, seen_at: at } }));
  const as = { name: 'carol', label: 'carols-new-mbp' };
  // the right PIN: renamed as the card would, with no card
  const p = mint(host);
  const byPin = await dial(t, host, dave, { invite: p.word, pin: p.pin, as, checkHost: checkHost(code, p.word) });
  assert.equal(byPin.as, 'carol2', 'the hello says the name the link is bound to');
  assert.deepEqual(must(hostLinks.links(host)[must(byPin.link)]).seats, ['carol2']);
  assert.deepEqual([admissionOf(host, p.id).name, admissionOf(host, p.id).asked_as], ['carol2', 'carol']);
  assert.ok(roomLines(host).includes(`carol2 joined from carols-new-mbp (${inviteSecret.joinCheck(dave.id)}; asked as carol, who sits here from another machine) · not them? /sub-human kick carol2`), JSON.stringify(roomLines(host)));
  byPin.close();
  // a join request with no PIN: the card
  const r = mint(host);
  ask(host, r, carol, { label: 'carols-new-mbp' });
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
  ask(host, r2, old);
  const req2 = must(admission.pending(code).find(q => q.machine === old.id));
  assert.equal(admission.taken(code, req2), null);
  assert.equal(must(must(admission.card(req2, code).questions[0]).options[0]).label, admission.LET_IN);
});
