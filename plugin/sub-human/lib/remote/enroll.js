'use strict';
/**
 * plugin/sub-human/lib/remote/enroll.js: the short invite's join. The host shows `/sub-human join you@box vole-8126
 * 4829` (or a URL and the PIN); the 4-digit PIN is the whole secret, and it never travels: both ends run CPace
 * (lib/remote/cpace.js, ristretto255 + SHA-512, initiator-responder, explicit key confirmation) with it. Guessing is
 * online only: the host charges one of the invite's 5 tries for each attempt it answers (before it answers), so a
 * man in the middle or a prober gets one guess per attempt and the invite burns after 5 (lib/remote/auth.js
 * startShort, failShort). Inside the PAKE the host vouches for the key the joiner then pins (sshd's Ed25519 host key over
 * ssh, the listener's X25519 key over the web), and hands over a fresh 128-bit secret (sealed with a key derived from
 * ISK) bound to the joiner's machine and its new link key. That secret redeems nothing until the host PERSON answers
 * the card (lib/remote/admission.js).
 *
 * Frames (lib/remote/protocol.js line codec), one attempt per connection:
 *   joiner -> {id: 1, op: 'enroll.start', params: {v: 1, room, sid, ya, ada}}   sid 16 random bytes, ya the CPace share,
 *            ada the joiner's associated data: JSON {v, name, machine, label, key} (key: its new ssh link key, or null),
 *            authenticated by the PAKE (the host acts on it only after the joiner's tag checks)
 *   host   -> {id: 1, result: {offers: [{yb, adb, tb}]}}   one per open short invite of this room and transport (at most
 *            SHORT_LIVE_MAX; each charged a try): its share, its associated data JSON {v, kind, room, key} (key: what
 *            the host vouches for) and its tag Tb = HMAC(mac_key, lv_cat(yb, adb)). An error: AUTH (no open invite)
 *   joiner -> {id: 2, op: 'enroll.finish', params: {i, ta}}   the offer whose Tb checked, and Ta = HMAC(mac_key,
 *            lv_cat(ya, ada)); or {id: 2, op: 'enroll.fail'} when none did (the joiner's PIN is wrong)
 *   host   -> {id: 2, result: {box}}   ChaCha20-Poly1305 under HKDF-SHA512(ISK, sid, "sub-human enroll box v1") of
 *            {secret, link, ref, expires_at}; or AUTH "wrong PIN (N tries left)" (the invite burns at the last)
 * CI = lv_cat("sub-human enroll v1", "joiner", "host", ROOM, KIND): a PIN minted for ssh never works over the web.
 *
 * Transports: pipe (`serve --enroll CODE --kind pipe` with the host's home), ssh (the enrollment door: the room's
 * public enrollment key, lib/remote/sshkeys.js enrollKey, whose authorized_keys line forces `serve --enroll CODE --kind
 * ssh`; the joiner's ssh records the host key it is shown, lib/remote/transports/ssh.js enrollCommand, and the attempt
 * stops unless the PAKE-vouched key is that one), ws/wss (the listener: a WebSocket whose first message is TEXT runs
 * `serve --enroll CODE --kind ws`; each text message is one frame).
 *
 *   ci(code, kind) -> Buffer
 *   serveEnroll(transport, {store, kind, log?, timeoutMs?, now?}) -> Promise<outcome>   the host's end of one attempt
 *       ('enrolled', 'wrong PIN', 'closed', 'timeout', or an error's message); the door is swept after
 *   joinEnroll({code, kind, pin, joiner, transport, checkKey?, timeoutMs?}) -> Promise<{secret, link, ref, expires_at,
 *       key}>   the joiner's end. checkKey(key) throws to stop before the joiner's tag goes out (ssh: the vouched key is
 *       not the one ssh saw). RoomError AUTH for a wrong PIN or a refusal (its message says what is left); OFFLINE
 *       when the host could not be reached; an error after the host answered start carries spent: true (a try is gone)
 *   openTransport(spec, code, {dir}) -> Promise<{transport, sawKey()}>   the joiner's connection for a link spec
 *   enrollLink(code) -> Promise<void>   the link daemon's first step for a link file with `enroll` (lib/remote/link.js
 *       connectLink): the attempt, then the link file holds the pinned key, the admission secret as its invite, and
 *       `awaiting`; the PIN is dropped once the host answered (held or wrong). At most MAX_SPENT attempts that reached
 *       the host without an answer are made; then it stops (AUTH)
 *   openDoor(code, {file?}) -> file     the host's door line for room CODE in authorized_keys (shim.enrollLine)
 *   sweepDoors(code, {now?}) -> n       remove the door line when no short ssh invite of the room is live (used,
 *       burnt, cancelled or expired): after each attempt, from the host's room tail, kick, invite --cancel and invite
 *   joinerLabel() -> string             this machine's short host name, as the host's card shows it (not trusted)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const protocol = require('./protocol.js');
const cpace = require('./cpace.js');
const auth = require('./auth.js');
const { RoomError } = require('../room/validate.js');
const config = require('../config.js');
const { CODE_RE, NAME_RE } = require('../text.js');

const V = 1;
const KINDS = new Set(['ssh', 'ws', 'pipe']);
const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ADA_MAX = 1024;
const MAX_SPENT = 3;
const BIN = path.join(__dirname, '..', '..', 'scripts', 'sub-human');

const b64 = b => Buffer.from(b).toString('base64url');
const unb64 = (s, n) => {
  const b = typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null;
  if (!b || (n !== undefined && b.length !== n)) throw new RoomError('PROTOCOL', 'an enrollment field of the wrong size');
  return b;
};
const ci = (code, kind) => cpace.lvCat(Buffer.from('sub-human enroll v1'), Buffer.from('joiner'), Buffer.from('host'), Buffer.from(code), Buffer.from(kind));
const enrollMs = () => config.envMs('SUB_HUMAN_ENROLL_MS', config.ENROLL_MS);

// ---------- the sealed answer ----------
const boxKey = (isk, sid) => Buffer.from(crypto.hkdfSync('sha512', isk, sid, Buffer.from('sub-human enroll box v1'), 32));
function seal(key, obj, aad) {
  const n = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, n, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: Buffer.byteLength(JSON.stringify(obj)) });
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final(), c.getAuthTag()]);
  return b64(Buffer.concat([n, body]));
}
function unseal(key, box, aad) {
  const b = unb64(box);
  if (b.length < 12 + 16) throw new RoomError('PROTOCOL', 'a sealed answer too short');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: b.length - 28 });
  d.setAuthTag(b.subarray(b.length - 16));
  try { return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')); } catch {
    throw new RoomError('PROTOCOL', 'the host\'s sealed answer does not open');
  }
}

function joinerOf(ada, kind) {
  let j;
  try { j = JSON.parse(ada.toString('utf8')); } catch { j = null; }
  const ok = j && j.v === V && NAME_RE.test(j.name) && MACHINE_RE.test(j.machine) && LABEL_RE.test(j.label)
    && (j.key === null || KEY_RE.test(j.key)) && (kind !== 'ssh' || j.key !== null);
  if (!ok) throw new RoomError('PROTOCOL', 'the joiner\'s details are not well formed');
  return { name: j.name, machine: j.machine, label: j.label, key: j.key };
}

const fingerprint = key => (key ? require('./sshkeys.js').fingerprint(key) : null);

// ---------- the host ----------
/** A line in the room from the room itself, best effort. */
function roomLine(store, text, log) {
  try { store.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch (e) { log(`room line: ${e && e.message}`); }
}

function serveEnroll(transport, { store, kind, log = () => {}, timeoutMs = enrollMs(), now = () => Date.now() }) {
  if (!KINDS.has(kind)) throw new RoomError('INVALID', `no enrollment over "${kind}"`);
  return new Promise(resolve => {
    let st = null, over = false;
    const finish = why => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      setImmediate(() => { transport.close(); try { sweepDoors(store.code, { now: now() }); } catch (e) { log(`door sweep: ${e.message}`); } resolve(why); });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    transport.onClose(() => finish('closed'));

    function start(p) {
      if (!p || p.v !== V) throw new RoomError('PROTOCOL', `this host speaks enrollment v${V}; one of you needs to update sub-human (/plugin update sub-human)`);
      if (p.room !== store.code) throw new RoomError('AUTH', `this door is for room ${store.code}`);
      const sid = unb64(p.sid, 16), Ya = unb64(p.ya, 32), ADa = unb64(p.ada);
      if (ADa.length > ADA_MAX) throw new RoomError('PROTOCOL', 'the joiner\'s details are too long');
      const joiner = joinerOf(ADa, kind);
      const open = auth.startShort(store, { kind, now: now() });
      if (!open.length) {
        throw new RoomError('AUTH', `no invite for room ${store.code} is open here (used, burnt, cancelled or expired); ask the host for a new one`);
      }
      const offers = [];
      for (const o of open) {
        const adb = Buffer.from(JSON.stringify({ v: V, kind, room: store.code, key: o.hostKey }));
        const r = cpace.responder({ prs: Buffer.from(o.prs), ci: ci(store.code, kind), sid, ad: adb, Ya, ADa });
        if (!r) {
          auth.failShort(store, open.map(x => x.key), { now: now() });
          throw new RoomError('PROTOCOL', 'the joiner\'s share is not a valid group element');
        }
        offers.push({ ...o, adb, Yb: r.Y, isk: r.isk, macKey: r.macKey });
      }
      st = { sid, Ya, ADa, joiner, offers };
      return { offers: offers.map(o => ({ yb: b64(o.Yb), adb: b64(o.adb), tb: b64(cpace.tag(o.macKey, o.Yb, o.adb)) })) };
    }

    function wrong() {
      const { left, burnt } = auth.failShort(store, st.offers.map(o => o.key), { now: now() });
      roomLine(store, burnt ? `someone typed a wrong PIN for an invite to this room, its last try: the invite no longer works` : `someone typed a wrong PIN for an invite to this room (${left} ${left === 1 ? 'try' : 'tries'} left)`, log);
      throw new RoomError('AUTH', burnt || !left
        ? 'wrong PIN, and that was the last try: this invite no longer works. Ask the host for a new one (/sub-human invite on their side)'
        : `wrong PIN (${left} ${left === 1 ? 'try' : 'tries'} left). Check the digits with the host, then type the join line again`);
    }

    function done({ i, ta }) {
      const o = Number.isInteger(i) ? st.offers[i] : null;
      if (!o) throw new RoomError('PROTOCOL', 'enroll.finish names no offer');
      if (!cpace.equal(unb64(ta, 64), cpace.tag(o.macKey, st.Ya, st.ADa))) return wrong();
      const r = auth.enrollShort(store, o.key, { tried: st.offers.map(x => x.key), joiner: st.joiner, now: now(), admitMs: config.envMs('SUB_HUMAN_ADMIT_TTL_MS', config.ADMIT_TTL_MS) });
      const j = st.joiner, fp = fingerprint(j.key);
      roomLine(store, `${j.name} on ${j.label}${fp ? ` (${fp})` : ''} typed an invite's PIN; waiting for ${o.by || 'the host'} to let them in (the card, or /sub-human admit ${r.ref})`, log);
      return { box: seal(boxKey(o.isk, st.sid), { secret: r.secret, link: r.id, ref: r.ref, expires_at: r.expires_at }, st.sid) };
    }

    transport.onFrame(f => {
      if (over) return;
      const id = f && f.id !== undefined ? f.id : null;
      try {
        if (!protocol.isRequest(f)) throw new RoomError('PROTOCOL', 'expected a request');
        if (f.op === 'enroll.start' && !st) { transport.send(protocol.reply(id, start(f.params))); return; }
        if (f.op === 'enroll.finish' && st && !st.over) {
          st.over = true;
          const answer = done(f.params || {});
          // the code is spent: close the door before the joiner hears back, so it never outlives the code
          try { sweepDoors(store.code, { now: now() }); } catch (e) { log(`door sweep: ${e.message}`); }
          transport.send(protocol.reply(id, answer));
          return finish('enrolled');
        }
        if (f.op === 'enroll.fail' && st && !st.over) { st.over = true; wrong(); }
        throw new RoomError('PROTOCOL', `enrollment: an unexpected ${f.op}`);
      } catch (e) {
        const code = e && Object.values(protocol.CODES).includes(e.code) ? e.code : 'INVALID';
        if (code === 'INVALID') log(`enroll: ${e && e.stack || e}`);
        try { sweepDoors(store.code, { now: now() }); } catch (e2) { log(`door sweep: ${e2.message}`); } // a burn closes it now
        transport.send(protocol.error(id, code, e.message));
        finish(/^wrong PIN/.test(e.message) ? 'wrong PIN' : e.message);
      }
    });
  });
}

// ---------- the joiner ----------
function requester(t, timeoutMs) {
  const waiting = new Map();
  let closed = false;
  t.onFrame(f => {
    const w = protocol.isReply(f) && waiting.get(f.id);
    if (!w) return;
    waiting.delete(f.id);
    clearTimeout(w.timer);
    if (f.error) w.reject(new RoomError(f.error.code, f.error.message));
    else w.resolve(f.result);
  });
  t.onClose(() => { closed = true; for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new RoomError('OFFLINE', 'the host closed the enrollment')); } waiting.clear(); });
  return (id, op, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new RoomError('OFFLINE', 'the host closed the enrollment'));
    const timer = setTimeout(() => { waiting.delete(id); reject(new RoomError('OFFLINE', `the host did not answer the enrollment within ${timeoutMs} ms`)); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    t.send(protocol.request(id, op, params));
  });
}

async function joinEnroll({ code, kind, pin, joiner, transport, checkKey = () => {}, timeoutMs = enrollMs() }) {
  if (!KINDS.has(kind) || !CODE_RE.test(code) || !auth.SHORT_PIN_RE.test(String(pin))) throw new RoomError('INVALID', 'enrollment needs a room, a transport and a 4-digit PIN');
  const t = await transport;
  const ask = requester(t, timeoutMs);
  const sid = crypto.randomBytes(16);
  const ADa = Buffer.from(JSON.stringify({ v: V, name: joiner.name, machine: joiner.machine, label: joiner.label, key: joiner.key || null }));
  const a = cpace.initiator({ prs: Buffer.from(String(pin)), ci: ci(code, kind), sid, ad: ADa });
  let spent = false;
  try {
    const r1 = await ask(1, 'enroll.start', { v: V, room: code, sid: b64(sid), ya: b64(a.Y), ada: b64(ADa) });
    spent = true; // the host charged a try for this attempt
    const offers = Array.isArray(r1 && r1.offers) ? r1.offers.slice(0, config.SHORT_LIVE_MAX) : [];
    let hit = null;
    offers.forEach((o, i) => {
      if (hit) return;
      let Yb, adb, tb;
      try { Yb = unb64(o.yb, 32); adb = unb64(o.adb); tb = unb64(o.tb, 64); } catch { return; }
      const k = a.finish(Yb, adb);
      if (k && cpace.equal(cpace.tag(k.macKey, Yb, adb), tb)) hit = { i, Yb, adb, ...k };
    });
    if (!hit) {
      await ask(2, 'enroll.fail', {}); // answered AUTH with the tries left
      throw new RoomError('AUTH', 'wrong PIN');
    }
    let vouched;
    try { vouched = JSON.parse(hit.adb.toString('utf8')); } catch { vouched = null; }
    if (!vouched || vouched.v !== V || vouched.kind !== kind || vouched.room !== code || (vouched.key !== null && !KEY_RE.test(vouched.key))) {
      throw new RoomError('PROTOCOL', 'the host vouched for nothing this machine can pin');
    }
    await checkKey(vouched.key); // before our tag goes out: an attempt through someone in between stops here
    const r2 = await ask(2, 'enroll.finish', { i: hit.i, ta: b64(cpace.tag(hit.macKey, a.Y, ADa)) });
    const body = unseal(boxKey(hit.isk, sid), r2 && r2.box, sid);
    if (typeof body.secret !== 'string' || !auth.LINK_ID_RE.test(body.link) || typeof body.ref !== 'string') throw new RoomError('PROTOCOL', 'the host\'s answer is not well formed');
    return { secret: body.secret, link: body.link, ref: body.ref, expires_at: body.expires_at, key: vouched.key };
  } catch (e) {
    if (spent && e && typeof e === 'object') e.spent = true;
    throw e;
  } finally {
    t.close();
  }
}

/** This machine's short name, for the host's card ("carol on carols-mbp"): what the joiner says, never trusted. */
function joinerLabel() {
  const n = String(os.hostname() || '').split('.')[0].replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return LABEL_RE.test(n) ? n : 'a-machine';
}

/** The text-message transport of a WebSocket: one frame per text message. */
function wsTransport(conn) {
  const { lineTransport } = require('./transports/index.js');
  const { transport, receive, end } = lineTransport({ write: line => conn.send(line.replace(/\n$/, '')), shut: () => conn.close(1000, 'done') });
  conn.on('message', (data, binary) => { if (binary) { conn.close(1003, 'text frames only'); return; } receive(`${data.toString('utf8')}\n`); });
  conn.on('close', end);
  conn.on('error', end);
  return transport;
}

async function openTransport(spec, code, { dir }) {
  if (spec.kind === 'pipe') {
    if (typeof spec.home !== 'string' || !spec.home.startsWith('/')) throw new RoomError('INVALID', 'the link\'s pipe names no home');
    const pipe = require('./transports/pipe.js');
    return { transport: pipe.spawn(process.execPath, [BIN, 'serve', '--enroll', code, '--kind', 'pipe'], { env: { ...process.env, SUB_HUMAN_HOME: spec.home } }) };
  }
  if (spec.kind === 'ssh') {
    const sshkeys = require('./sshkeys.js');
    const key = sshkeys.writeEnrollKey(dir, code);
    const knownHosts = path.join(dir, 'enroll_known_hosts');
    fs.writeFileSync(knownHosts, '', { mode: 0o600 }); // empty each time: ssh writes the key it is shown
    const [cmd, ...args] = require('./transports/ssh.js').enrollCommand(spec, code, { key, knownHosts });
    const transport = require('./transports/pipe.js').spawn(cmd, args);
    const sawKey = () => {
      const alias = `sub-human-enroll-${code}`;
      const line = (fs.readFileSync(knownHosts, 'utf8').split('\n').find(l => l.startsWith(`${alias} `)) || '');
      return sshkeys.ed25519Raw(line.slice(alias.length + 1));
    };
    return { transport, sawKey };
  }
  if (spec.kind === 'wss' || spec.kind === 'ws') {
    const wsT = require('./transports/ws.js');
    const s = wsT.parse(`//${spec.host}${spec.port ? `:${spec.port}` : ''}${spec.path}`);
    if (!s) throw new RoomError('INVALID', 'the link\'s WebSocket URL is not a plain host[:port]/path');
    let conn;
    try {
      conn = await require('./ws.js').connect(wsT.urlOf({ ...s, kind: spec.kind }), { maxPayload: 64 * 1024, timeoutMs: config.envMs('SUB_HUMAN_WS_CONNECT_MS', config.WS_CONNECT_MS) });
    } catch (e) { throw new RoomError('OFFLINE', e.message); }
    return { transport: wsTransport(conn) };
  }
  throw new RoomError('INVALID', `no short-code join over "${spec.kind}"`);
}

const kindOf = spec => (spec.kind === 'wss' || spec.kind === 'ws' ? 'ws' : spec.kind);

/** The link file's invite after enrollment: an sh2 invite string with the admission secret (never shown to anyone). */
function inviteFor(code, spec, secret, key) {
  const link = require('./link.js');
  const loc = spec.kind === 'ssh' ? link.sshLocator(`${spec.user}@${spec.host}${spec.port ? `:${spec.port}` : ''}`, spec.via ? { via: spec.via } : {})
    : spec.kind === 'pipe' ? link.pipeLocator(spec.home) : require('./transports/ws.js').urlOf(spec);
  return auth.formatInvite({ v: 2, code, locator: loc, secret, hostKey: spec.kind === 'pipe' ? null : key });
}

async function enrollLink(code) {
  const links = require('../room/links.js');
  const l = links.get(code);
  if (!l || !l.enroll || typeof l.enroll.pin !== 'string') throw new RoomError('AUTH', `this machine has no PIN for room ${code}; type the join line again`);
  if ((l.enroll.attempts || 0) >= MAX_SPENT) {
    const { enroll, ...rest } = l;
    links.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: 'the host never answered' } });
    throw new RoomError('AUTH', `${MAX_SPENT} attempts reached the host without an answer (each costs one of the invite's tries); type the join again`);
  }
  const spec = l.transport;
  const kind = kindOf(spec);
  const dir = links.dirOf(code);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sshkeys = require('./sshkeys.js');
  const linkKey = spec.kind === 'ssh' ? sshkeys.linkKey(dir, `sub-human:${code}:${l.enroll.name}`) : null;
  const joiner = { name: l.enroll.name, machine: require('../home.js').machineId(), label: joinerLabel(), key: linkKey ? linkKey.raw : null };
  const { transport, sawKey } = await openTransport(spec, code, { dir });
  const checkKey = vouched => {
    if (spec.kind === 'ssh') {
      if (!vouched) throw new RoomError('AUTH', 'the host vouched for no ssh host key, so this machine cannot pin it; ask the host to update');
      const saw = sawKey();
      if (saw !== vouched) {
        throw new RoomError('AUTH', `the ssh server that answered is not the one that holds your PIN (its host key ${saw ? sshkeys.fingerprint(saw) : '(none read)'} is not the ${sshkeys.fingerprint(vouched)} the host vouched for): someone may be in between, so nothing more was sent. Check with the host before you try again`);
      }
    }
    if ((spec.kind === 'wss' || spec.kind === 'ws') && !vouched) throw new RoomError('AUTH', 'the host vouched for no listener key; ask the host to update');
  };
  let r;
  try {
    r = await joinEnroll({ code, kind, pin: l.enroll.pin, joiner, transport, checkKey }).catch(async e => {
      // sshd refused the room's enrollment key: no door (the code was used, burnt, revoked or expired), so retrying
      // cannot help. Anything else before the host answered stays OFFLINE (the link retries)
      if (e && e.code === 'OFFLINE' && !e.spent && spec.kind === 'ssh' && typeof transport.stderr === 'function') {
        await new Promise(res => setTimeout(res, 100)); // ssh's last words may come just after its exit
        if (/Permission denied \(publickey/.test(transport.stderr())) {
          throw new RoomError('AUTH', `the invite to room ${code} no longer works (used, cancelled, expired or too many wrong PINs, or this isn't the machine that made it); ask the host for a new one`);
        }
      }
      throw e;
    });
  } catch (e) {
    const cur = links.get(code) || l;
    if (e && (e.code === 'AUTH' || e.code === 'PROTOCOL')) {
      const { enroll, ...rest } = cur; // the code is spent here: a refusal never leaves it on disk
      links.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: String(e.message).slice(0, 300) } });
    } else if (e && e.spent && cur.enroll) {
      links.set(code, { ...cur, enroll: { ...cur.enroll, attempts: (cur.enroll.attempts || 0) + 1 } });
    }
    throw e;
  }
  let transportOut = spec;
  if (spec.kind === 'ssh') {
    const alias = `sub-human-${code}`;
    const knownHosts = path.join(dir, 'known_hosts');
    fs.writeFileSync(knownHosts, sshkeys.knownHostsLine(alias, r.key) + '\n', { mode: 0o600 });
    transportOut = { ...spec, key: linkKey.file, knownHosts, alias };
  } else if (spec.kind === 'wss' || spec.kind === 'ws') transportOut = { ...spec, hostKey: r.key };
  const cur = links.get(code) || l;
  const { enroll, refused, ...rest } = cur;
  const check = linkKey ? sshkeys.fingerprint(linkKey.raw) : `request ${r.ref.slice(0, 6)}`;
  links.set(code, { ...rest, transport: transportOut, invite: inviteFor(code, spec, r.secret, r.key), awaiting: { at: new Date().toISOString(), ref: r.ref, check, expires_at: r.expires_at } });
}

// ---------- the door (ssh) ----------
function storeOf(code) {
  const s = require('../room.js').open(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine`);
  return s;
}

function openDoor(code, { file = require('./sshkeys.js').authorizedKeysFile() } = {}) {
  const sshkeys = require('./sshkeys.js');
  const { shim, h } = require('./hosting.js').shimReady();
  const k = sshkeys.enrollKey(code);
  const line = shim.enrollLine(code, k.pub, h);
  const f = path.resolve(file);
  const cur = (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })();
  if (!cur.split('\n').includes(line)) sshkeys.removeTagged(f, sshkeys.ENROLL_TAG(code)); // an older door (another home path)
  sshkeys.appendAuthorized(f, line, k.pub);
  return f;
}

function sweepDoors(code, { now = Date.now() } = {}) {
  const s = storeOf(code);
  const all = Object.values(s.kv.get(auth.INVITES_KEY, null) || {}).filter(i => i && i.short && i.kind === 'ssh');
  if (!all.length || all.some(i => auth.shortLive(i, now))) return 0;
  const sshkeys = require('./sshkeys.js');
  let n = 0;
  for (const f of new Set(all.map(i => i.door_file).filter(Boolean))) {
    try { n += sshkeys.removeTagged(f, sshkeys.ENROLL_TAG(code)); } catch { /* the next sweep */ }
  }
  return n;
}

module.exports = { V, ci, serveEnroll, joinEnroll, openTransport, enrollLink, openDoor, sweepDoors, joinerLabel, wsTransport, MAX_SPENT };
