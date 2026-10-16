'use strict';
// The short code's enrollment (lib/remote/enroll.ts) over the memory transport, the host's end on a real hosted store:
// the right code gets the joiner a sealed admission secret and the host an admission waiting for its person; a wrong
// code costs exactly one try (counted before the host answers, so an attempt abandoned after the answer costs it too)
// and the fifth burns the invite; key confirmation both ways (a bad tag either side is a wrong PIN); someone posing
// as the host gets one guess and never the joiner's tag; a vouched key the joiner cannot match stops it before its tag
// goes out; several open codes are each charged and the others refunded on success; the door answers nothing but the
// PAKE; and its authorized_keys line goes once no ssh code is live (used, burnt or expired).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const auth = require(path.join(h.LIB, 'remote', 'auth.ts'));
const enroll = require(path.join(h.LIB, 'remote', 'enroll.ts'));
const cpace = require(path.join(h.LIB, 'remote', 'cpace.ts'));
const sshkeys = require(path.join(h.LIB, 'remote', 'sshkeys.ts'));
const protocol = require(path.join(h.LIB, 'remote', 'protocol.ts'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.ts'));

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const JOINER = { name: 'carol', machine: 'carolmachine0001', label: 'carols-mbp', key: null };
const HOSTKEY = Buffer.alloc(32, 7).toString('base64url');

function hostRoom(t) {
  h.freshHome(t);
  const code = h.newRoom();
  return { code, host: store.open(code) };
}
const invites = host => host.kv.get(auth.INVITES_KEY, null) || {};
const shortOf = (host, ref) => Object.entries(invites(host)).find(([k]) => k.startsWith(ref))[1];

/** One attempt: the host's serveEnroll on one end of a memory pair; returns {joined: Promise, served: Promise}. */
function attempt(host, { kind = 'ws', pin, joiner = JOINER, checkKey } = {}) {
  const [a, b] = memory.pair();
  const served = enroll.serveEnroll(b, { store: host, kind });
  const joined = enroll.joinEnroll({ code: host.code, kind, pin, joiner, transport: a, ...(checkKey ? { checkKey } : {}) });
  return { joined, served };
}

/** A raw client end: send frames by hand, collect what comes back. */
function raw(host, kind = 'ws') {
  const [a, b] = memory.pair();
  const served = enroll.serveEnroll(b, { store: host, kind });
  const got = [];
  let wake = null;
  a.onFrame(f => { got.push(f); if (wake) wake(); });
  const next = () => new Promise(r => { if (got.length) return r(got.shift()); wake = () => { wake = null; r(got.shift()); }; });
  return { a, next, served, send: (id, op, params) => a.send(protocol.request(id, op, params)) };
}

function startParams(code, pin, kind = 'ws', joiner = JOINER) {
  const sid = Buffer.alloc(16, 3);
  const ada = Buffer.from(JSON.stringify({ v: 1, ...joiner }));
  const i = cpace.initiator({ prs: Buffer.from(pin), ci: enroll.ci(code, kind), sid, ad: ada });
  return { i, ada, params: { v: 1, room: code, sid: sid.toString('base64url'), ya: i.Y.toString('base64url'), ada: ada.toString('base64url') } };
}

test('enroll: the right code gets the joiner a sealed admission secret and the vouched key; the host an admission waiting for its person', async t => {
  const { code, host } = hostRoom(t);
  const r = auth.mintShort(host, { kind: 'ws', locator: 'wss://box/sub-human/x', hostKey: HOSTKEY, by: 'alice' });
  const { joined, served } = attempt(host, { pin: r.pin });
  const got = await joined;
  assert.equal(await served, 'enrolled');
  assert.equal(got.key, HOSTKEY, 'the joiner pins the key the host vouched for');
  assert.match(got.secret, /^[A-Za-z0-9_-]{22}$/);
  const inv = shortOf(host, r.ref);
  assert.ok(inv.used_at && !('prs' in inv), 'the invite is used and its code forgotten');
  const adm = auth.admissions(host);
  assert.equal(adm.length, 1);
  assert.deepEqual([adm[0].name, adm[0].machine, adm[0].label, adm[0].admit, adm[0].by, adm[0].link], ['carol', JOINER.machine, 'carols-mbp', 'asked', 'alice', got.link]);
  assert.equal(adm[0].ref, got.ref);
  // the secret redeems nothing before the host person answers, then only on that machine
  assert.throws(() => auth.redeemInvite(host, got.secret, { machine: JOINER.machine }), e => e.code === 'OFFLINE' && /waiting for the host to let this machine in/.test(e.message));
  auth.decideAdmission(host, got.ref, { decision: 'let-in', by: 'alice' });
  assert.throws(() => auth.redeemInvite(host, got.secret, { machine: 'someoneelse00001' }), e => e.code === 'AUTH' && /another machine/.test(e.message));
  const red = auth.redeemInvite(host, got.secret, { machine: JOINER.machine });
  assert.equal(red.link.id, got.link);
  assert.deepEqual([red.link.seats, red.link.bound], [['carol'], true], 'the link is bound to the one name the card let in');
  assert.ok(auth.mayJoinAs(red.link, 'carol') && !auth.mayJoinAs(red.link, 'bob'));
  assert.throws(() => auth.bindSeat(host, red.link.id, 'bob'), e => e.code === 'AUTH' && /let in as carol, not bob/.test(e.message));
  assert.throws(() => auth.redeemInvite(host, got.secret, { machine: JOINER.machine }), e => e.code === 'AUTH' && /used already/.test(e.message));
});

test('enroll: a wrong PIN costs one try (room line, tries left), the fifth burns; an attempt abandoned after the host answered still costs its try', async t => {
  const { code, host } = hostRoom(t);
  const r = auth.mintShort(host, { kind: 'ws', locator: 'wss://box/x', hostKey: HOSTKEY });
  const wrong = r.pin === '0000' ? '0001' : '0000';
  const one = attempt(host, { pin: wrong });
  await assert.rejects(one.joined, e => e.code === 'AUTH' && /^wrong PIN \(4 tries left\)/.test(e.message) && e.spent === true);
  assert.equal(await one.served, 'wrong PIN');
  assert.equal(shortOf(host, r.ref).tries, 4);
  // a prober takes the host's answer and leaves: the try is gone all the same
  const p = raw(host);
  p.send(1, 'enroll.start', startParams(code, wrong).params);
  const m2 = await p.next();
  assert.equal(m2.result.offers.length, 1);
  p.a.close();
  await p.served;
  assert.equal(shortOf(host, r.ref).tries, 3, 'charged before the host answered');
  for (let i = 0; i < 2; i++) await attempt(host, { pin: wrong }).joined.catch(() => {});
  const last = attempt(host, { pin: wrong });
  await assert.rejects(last.joined, e => e.code === 'AUTH' && /that was the last try: this invite no longer works\. Ask the host for a new one/.test(e.message));
  const inv = shortOf(host, r.ref);
  assert.ok(inv.burnt_at && !('prs' in inv), 'burnt, and its code forgotten');
  await assert.rejects(attempt(host, { pin: r.pin }).joined, e => e.code === 'AUTH' && /no invite for room .* is open here/.test(e.message));
  const said = host.readAll().filter(e => e.from === 'room').map(e => e.text);
  assert.ok(said.some(x => /a wrong PIN for an invite to this room \(4 tries left\)/.test(x)));
  assert.ok(said.some(x => /its last try: the invite no longer works/.test(x)));
  assert.ok(!said.join('\n').includes(r.pin) && !said.join('\n').includes(wrong));
});

test('enroll: key confirmation both ways: a host tag that does not check is a wrong PIN, and so is a joiner tag', async t => {
  const { code, host } = hostRoom(t);
  const r = auth.mintShort(host, { kind: 'ws', locator: 'wss://box/x', hostKey: HOSTKEY });
  // the joiner's side: a tampered Tb (a relay that changes the vouched key, say) never matches
  const [a, b] = memory.pair();
  const served = enroll.serveEnroll(b, { store: host, kind: 'ws' });
  const send = a.send.bind(a);
  const tamper = { send: f => send(f), onFrame: fn => a.onFrame(f => { if (f.result && f.result.offers) f.result.offers[0].adb = Buffer.from(JSON.stringify({ v: 1, kind: 'ws', room: code, key: Buffer.alloc(32, 9).toString('base64url') })).toString('base64url'); fn(f); }), onClose: fn => a.onClose(fn), close: () => a.close() };
  await assert.rejects(enroll.joinEnroll({ code, kind: 'ws', pin: r.pin, joiner: JOINER, transport: tamper }), e => e.code === 'AUTH' && /wrong PIN/.test(e.message));
  await served;
  assert.equal(shortOf(host, r.ref).tries, 4, 'that attempt cost its try');
  // the host's side: a Ta that does not check (a joiner that never knew the code) is a wrong PIN
  const p = raw(host);
  const s = startParams(code, r.pin);
  p.send(1, 'enroll.start', s.params);
  await p.next();
  p.send(2, 'enroll.finish', { i: 0, ta: Buffer.alloc(64, 1).toString('base64url') });
  const m4 = await p.next();
  assert.equal(m4.error.code, 'AUTH');
  assert.match(m4.error.message, /^wrong PIN \(3 tries left\)/);
  assert.equal(auth.admissions(host).length, 0, 'nothing waits for the host person');
});

test('enroll: someone posing as the host gets one guess and never the joiner\'s tag; a vouched key the joiner cannot match stops it first', async t => {
  const { code } = hostRoom(t);
  // the impostor answers with its guess; it learns only that the guess was wrong (the joiner says enroll.fail)
  const [a, b] = memory.pair();
  const seen = [];
  let Ya = null;
  b.onFrame(f => {
    seen.push(f.op);
    if (f.op === 'enroll.start') {
      Ya = Buffer.from(f.params.ya, 'base64url');
      const adb = Buffer.from(JSON.stringify({ v: 1, kind: 'ws', room: code, key: HOSTKEY }));
      const r = cpace.responder({ prs: Buffer.from('1234'), ci: enroll.ci(code, 'ws'), sid: Buffer.from(f.params.sid, 'base64url'), ad: adb, Ya, ADa: Buffer.from(f.params.ada, 'base64url') });
      b.send(protocol.reply(f.id, { offers: [{ yb: r.Y.toString('base64url'), adb: adb.toString('base64url'), tb: cpace.tag(r.macKey, r.Y, adb).toString('base64url') }] }));
    } else b.send(protocol.error(f.id, 'AUTH', 'wrong PIN (4 tries left)'));
  });
  await assert.rejects(enroll.joinEnroll({ code, kind: 'ws', pin: '6543', joiner: JOINER, transport: a }), e => e.code === 'AUTH');
  assert.deepEqual(seen, ['enroll.start', 'enroll.fail'], 'no enroll.finish, so no Ta to test more guesses against offline');
  // the right code, but the vouched key is not the one ssh saw: the joiner stops before its tag goes out
  const { host } = hostRoom(t);
  const r = auth.mintShort(host, { kind: 'ssh', locator: 'ssh:me@box', hostKey: HOSTKEY });
  const sent = [];
  const [c, d] = memory.pair();
  const served = enroll.serveEnroll(d, { store: host, kind: 'ssh' });
  const watch = { send: f => { sent.push(f.op); c.send(f); }, onFrame: fn => c.onFrame(fn), onClose: fn => c.onClose(fn), close: () => c.close() };
  const key = Buffer.alloc(32, 5).toString('base64url');
  await assert.rejects(enroll.joinEnroll({ code: host.code, kind: 'ssh', pin: r.pin, joiner: { ...JOINER, key }, transport: watch, checkKey: () => { throw Object.assign(new Error('the ssh server that answered is not the one that holds your PIN'), { code: 'AUTH' }); } }), /not the one that holds your PIN/);
  await served;
  assert.deepEqual(sent, ['enroll.start']);
  assert.equal(auth.admissions(host).length, 0);
});

test('enroll: several open codes: an attempt is charged on each, a success refunds the others; at most SHORT_LIVE_MAX open', async t => {
  const { host } = hostRoom(t);
  const mint = () => auth.mintShort(host, { kind: 'ws', locator: 'wss://box/x', hostKey: HOSTKEY });
  const a = mint(), b = mint();
  const wrong = ['0000', '0001', '0002'].find(x => x !== a.pin && x !== b.pin);
  await attempt(host, { pin: wrong }).joined.catch(() => {});
  assert.deepEqual([shortOf(host, a.ref).tries, shortOf(host, b.ref).tries], [4, 4]);
  await attempt(host, { pin: b.pin }).joined;
  assert.ok(shortOf(host, b.ref).used_at);
  assert.equal(shortOf(host, a.ref).tries, 4, 'a\'s try back after b held');
  mint(); mint(); mint();
  assert.throws(mint, e => e.code === 'INVALID' && /4 short invites .* are open already/.test(e.message));
  // a code of another transport is never tried: an ssh code over the web door finds none open
  const { host: h2 } = hostRoom(t);
  const s = auth.mintShort(h2, { kind: 'ssh', locator: 'ssh:me@box', hostKey: HOSTKEY });
  await assert.rejects(attempt(h2, { pin: s.pin, kind: 'ws' }).joined, e => /no invite for room .* is open here/.test(e.message));
  assert.equal(shortOf(h2, s.ref).tries, 5);
});

test('enroll: the door answers nothing but the PAKE: no hello, no room op, no second start, no other room; the CLI serves no room ops', async t => {
  const { code, host } = hostRoom(t);
  auth.mintShort(host, { kind: 'ssh', locator: 'ssh:me@box', hostKey: HOSTKEY });
  for (const [op, params] of [['hello', { v: 2, machine: 'x' }], ['append', { payload: {} }], ['subscribe', { after: 0 }], ['enroll.finish', { i: 0, ta: '' }]]) {
    const p = raw(host, 'ssh');
    p.send(1, op, params);
    const f = await p.next();
    assert.equal(f.error.code, 'PROTOCOL', op);
    await p.served;
  }
  const other = raw(host, 'ssh');
  other.send(1, 'enroll.start', { ...startParams(code, '1234', 'ssh', { ...JOINER, key: HOSTKEY }).params, room: 'otter-0000' });
  assert.equal((await other.next()).error.code, 'AUTH');
  const noKey = raw(host, 'ssh');
  noKey.send(1, 'enroll.start', startParams(code, '1234', 'ssh').params);
  assert.match((await noKey.next()).error.message, /not well formed/, 'over ssh the joiner must bring its link key');
  const twice = raw(host, 'ssh');
  const sp = startParams(code, '1234', 'ssh', { ...JOINER, key: HOSTKEY }).params;
  twice.send(1, 'enroll.start', sp);
  await twice.next();
  twice.send(2, 'enroll.start', sp);
  assert.equal((await twice.next()).error.code, 'PROTOCOL');
  // the CLI: a hello on `serve --enroll` is refused; it never runs the room server
  const r = spawnSync(process.execPath, [h.BIN, 'serve', '--enroll', code, '--kind', 'ssh'], { input: protocol.encode(protocol.request(1, 'hello', { v: 2, machine: 'x' })), env: h.childEnv({}), encoding: 'utf8', timeout: 10_000 });
  assert.equal(JSON.parse(r.stdout.trim()).error.code, 'PROTOCOL');
  const bad = spawnSync(process.execPath, [h.BIN, 'serve', '--enroll', code, '--kind', 'shell'], { env: h.childEnv({}), encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  const none = spawnSync(process.execPath, [h.BIN, 'serve', '--enroll', 'otter-0000', '--kind', 'ssh'], { env: h.childEnv({}), encoding: 'utf8' });
  assert.equal(none.status, 1);
});

test('enroll: the door line is in authorized_keys while an ssh code is live, and goes once it is used, burnt or expired', t => {
  const { code, host } = hostRoom(t);
  const file = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  fs.writeFileSync(file, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKey me@else\n', { mode: 0o600 });
  const r = auth.mintShort(host, { kind: 'ssh', locator: 'ssh:me@box', hostKey: HOSTKEY, doorFile: file });
  enroll.openDoor(code, { file });
  const door = () => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.endsWith(` sub-human-enroll:${code}`));
  assert.equal(door().length, 1);
  assert.match(door()[0], new RegExp(`^command="SUB_HUMAN_HOME=\\S+ \\S+/bin/serve --enroll ${code} --kind ssh",restrict ssh-ed25519 \\S+ sub-human-enroll:${code}$`));
  assert.equal(door()[0].split(' ').slice(-2, -1)[0], sshkeys.enrollKey(code).pub.split(' ')[1], 'the room\'s public enrollment key');
  enroll.openDoor(code, { file });
  assert.equal(door().length, 1, 'opening it again adds nothing');
  assert.equal(enroll.sweepDoors(code), 0, 'kept while the code is live');
  assert.equal(enroll.sweepDoors(code, { now: Date.now() + 16 * 60_000 }), 1, 'gone once it expired');
  assert.equal(door().length, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /me@else/, 'other lines stay');
  // burnt (revoked): gone too
  const r2 = auth.mintShort(host, { kind: 'ssh', locator: 'ssh:me@box', hostKey: HOSTKEY, doorFile: file });
  enroll.openDoor(code, { file });
  auth.burnInvite(host, r2.ref);
  assert.equal(enroll.sweepDoors(code), 0, 'r is still live (only the clock above moved)');
  auth.burnInvite(host, r.ref);
  assert.equal(enroll.sweepDoors(code), 1, 'none live: gone');
});

test('doctor --bundle redacts a short invite\'s code wherever it shows', () => {
  const doctor = require(path.join(h.LIB, 'cli', 'doctor.ts'));
  const red = doctor.redactor({ salt: 'x' });
  const out = red('could not link: /sub-human join NAME me@box vole-8126 482913 (wrong PIN); the URL https://box/sub-human/vole-8126 004211');
  assert.ok(!out.includes('482913') && !out.includes('004211'), out);
});

test('enrollment key: derived from the room code only, an openssh file ssh-keygen reads, never from the 6-digit code', t => {
  const a = sshkeys.enrollKey('vole-8126'), b = sshkeys.enrollKey('vole-8126'), c = sshkeys.enrollKey('vole-8127');
  assert.equal(a.raw, b.raw);
  assert.notEqual(a.raw, c.raw);
  const dir = h.tmpDir('sh-ek-', t);
  const file = sshkeys.writeEnrollKey(dir, 'vole-8126');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const kg = spawnSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' });
  if (kg.error) return t.skip('no ssh-keygen here');
  assert.equal(kg.stdout.trim().split(' ').slice(0, 2).join(' '), a.pub);
});

test('joinerLabel: the short host name, or SUB_HUMAN_MACHINE_LABEL; anything unplain is made plain', () => {
  assert.equal(enroll.joinerLabel({ SUB_HUMAN_MACHINE_LABEL: 'laptop' }), 'laptop');
  assert.equal(enroll.joinerLabel({ SUB_HUMAN_MACHINE_LABEL: 'jess laptop.local' }), 'jess-laptop');
  assert.match(enroll.joinerLabel({}), /^[A-Za-z0-9._-]{1,64}$/);
});
