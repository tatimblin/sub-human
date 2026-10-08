'use strict';
/**
 * plugin/sub-human/lib/handoff.js: moving a room's host to another member's machine. The host's machine holds the
 * room's log, serves its links and runs its orch (billed to the host person's model account); a planned handoff
 * moves all three before the host closes their laptop. There is no automatic failover (it would split the room);
 * `promote` is the manual way out when the host is gone for good, and it can fork.
 *
 * Authority is the log's: a host_changed entry (via system, lib/room/validate.js) {epoch, host, machine, locator,
 * accept?, ask?, promoted?} moves it; store.hostState() reads the last one (epoch 0 before any). The old host's
 * FsRoomStore takes no more lines once its log says the room moved (STALE), a server refuses a hello from a mirror
 * at a later epoch than its own and an append from another epoch (STALE, lib/remote/server.js), so a stale host and
 * a stale copy are refused, never merged.
 *
 * A planned handoff, A (the host, person `from`) to B (person `to`, on another machine, linked), C following:
 *   1. ask (A: `/sub-human handoff B` or `sub-human handoff B`): the host document remote/handoff (host-only, never
 *      streamed) {id, state: 'asked', from, to, epoch: next, locator?, ask?, at, expires_at}. A's server sends it to
 *      B's link only, as a private 'handoff' event (lib/remote/protocol.js); B's daemon keeps it in B's mirror
 *      (onAsk: the session-local document `handoff`); B's tail wakes B's Claude, which opens the card.
 *   2. the card (hooks/consent.js, AskUserQuestion; only B's own answer on the card as the hooks built it counts):
 *      it says the room's orch then runs on B's model account (billing, rate limits) and that B's machine must stay
 *      reachable. "Not now": refuse (op handoff.refuse; A's tail tells the asker). "Host it here": accept.
 *   3. accept (B's hook): mints one single-use invite to B per other machine with a seat in the room (A's included;
 *      auth.mintFor: bound to that machine, its seats pre-bound), signs {kind: 'host_accept', id, epoch, locator}
 *      with B's seat key, and sends op handoff.accept. A's server (serverAccept) checks the ask, the signature
 *      against B's pinned key and the invites, appends host_changed (from A's seat, with B's signed acceptance and
 *      A's signed ask when the hook made it), marks the orch left and the document 'moved' with the invites; after
 *      the reply (afterMoved) it stops A's orch job and turns A into a mirror of B (a link file holding A's invite,
 *      its daemon started).
 *   4. B, once the reply is back (its mirror holds host_changed: read-your-writes): takeOver: the chain checked, its
 *      daemon stopped, the link file removed (B's store is an FsRoomStore now), its seats' local fields back from the
 *      session indexes, the old orch record retired, the orch started here (lib/seats.js ensureOrch).
 *   5. every other link of A gets a private 'moved' event after the host_changed line, with its machine's invite
 *      (A's server, streamEvent); its daemon (onMoved) re-points its link file at B and reconnects. A member offline
 *      during the handoff gets it when it reconnects to A, as long as A is up (HANDOFF_INVITE_MS). A member that
 *      cannot reach B stays offline with a reason that says what to do (whyOffline); nothing hangs.
 *
 *   ask(code, {from, to, locator?, sign?, now?}) -> doc        host only. sign(payload) -> signed (the hook's seat
 *       key): doc.ask = sign({kind: 'host_ask', id, epoch, to, locator}). RoomError INVALID / OFFLINE / HOST_ONLY /
 *       STALE with a reason for the person
 *   hostDoc(store) -> doc | null                               the host document remote/handoff
 *   streamEvent(store, link, sent) -> {ev, data, end?} | null  the next private event for a link's subscribe stream
 *       (lib/remote/server.js): the ask to the link holding its target, or 'moved' once the host_changed line
 *       (sent.lastId: the last id this stream sent) went out; end: the stream ends after it ({reason: 'moved'})
 *   serverAccept(store, link, {id, accept, locator, invites}) -> {entry, epoch, job}   A's server: see 3
 *   serverRefuse(store, link, {id}) -> {ok}
 *   afterMoved(store, {job}) -> bool                           A's server, after the accept's reply: see 3
 *   movedAway(store) -> bool                                   the log says the room moved to another machine
 *   onAsk(mirror, data), onMoved(mirror, data) -> {self?, stop?, reason}   the link daemon's (lib/remote/link.js)
 *   whyOffline(code, message) -> string                        the offline reason of a re-pointed link
 *   pendingAsk(code, name, now?) -> ask | null                 B's mirror: the ask waiting for name
 *   markTold(code, id)                                         the tail woke the target's Claude for it
 *   card(ask, code) -> AskUserQuestion input; question(ask, code) -> string; YES, NO
 *   accept(me, {cwd, sign}) -> {ok, epoch?, note?, error?}     B's hook: see 3 and 4
 *   refuse(me) -> {ok, error?}
 *   takeOver(code, {by, cwd, entry?}) -> string                this machine becomes the room's host (see 4);
 *       entry: append it once the store is this machine's (promote)
 *   promote(code, {name, locator?, force?, now?}) -> {epoch, entry, invites: [{machine, seats, invite}], note}
 *       a member's machine with a full mirror declares itself host at epoch + 1 (the person's own shell,
 *       lib/cli/handoff.js, after a confirmation): refused while the link is online, or down for less than
 *       PROMOTE_OFFLINE_MS without force. The other machines get sh2 invites with a PIN each, to hand out by hand.
 *   demote(code, invite, pin?) -> {orphan, request?}            an old host that was promoted away: its log is set
 *       aside (orphaned-<time>.jsonl, kept, never merged), its orch stopped, and it mirrors the new host
 *   status(code) -> {host: hostState, doc, machines?}          for `sub-human handoff --status`
 *   HOST_DOC, ASK_DOC
 * A next host's locator may be a web one (wss://FRONT/…/sub-human/CODE, `--url`): it serves the room on its listener
 * (lib/remote/webhost.js serveAt) before it accepts, and every invite it mints pins its listener's X25519 key.
 */

const crypto = require('node:crypto');
const store = require('./room/store.js');
const links = require('./room/links.js');
const envelope = require('./room/envelope.js');
const members = require('./room/members.js');
const auth = require('./remote/auth.js');
const { RoomError } = require('./room/validate.js');
const { machineId } = require('./home.js');
const { isAlive, sleepSync } = require('./io.js');
const config = require('./config.js');

const HOST_DOC = 'remote/handoff';
const ASK_DOC = 'handoff';
const WORKDIR = 'workdir';
const YES = 'Host it here';
const NO = 'Not now';
const ID_RE = /^[0-9a-f]{12}$/;
const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const iso = ms => new Date(ms).toISOString();
const err = (code, msg) => new RoomError(code, msg);
const linkLib = () => require('./remote/link.js');
const identity = () => require('./identity.js');
const transportOf = locator => (typeof locator === 'string' ? linkLib().transportOf(locator) : null);
// A next host reached over the web (wss/ws, lib/remote/transports/ws.js): its invites pin its listener's X25519 key,
// and the link file that follows one carries that key.
const isWeb = locator => /^wss?:/.test(String(locator));
const webKeyFor = locator => (isWeb(locator) ? require('./remote/listener.js').hostKey() : null);
function transportWith(locator, invite) {
  const t = transportOf(locator);
  if (!t || !isWeb(locator)) return t;
  const inv = typeof invite === 'string' ? auth.parseInvite(invite) : null;
  return inv && inv.hostKey ? { ...t, hostKey: inv.hostKey } : t;
}
/** This machine, about to host CODE at a web locator: its listener up, the room in its served set. */
function serveWeb(code, locator) {
  if (isWeb(locator)) require('./remote/webhost.js').serveAt(code, locator);
}
const askMs = () => config.envMs('SUB_HUMAN_HANDOFF_ASK_MS', config.HANDOFF_ASK_MS);
const expired = (doc, now = Date.now()) => !(Date.parse(doc && doc.expires_at) > now);

// ---------- the old host ----------
function ask(code, { from, to, locator, sign, now = Date.now() }) {
  const s = store.open(code);
  if (!s.isHost) throw err('HOST_ONLY', `room ${code} is hosted on another machine; only its host hands it off`);
  if (movedAway(s)) throw err('STALE', `room ${code} moved to another machine already`);
  const m = s.members.read()[to];
  if (!m || m.left_at || m.role === 'orch') throw err('INVALID', `${to} is not in room ${code}`);
  if ((m.machine || machineId()) === machineId()) throw err('INVALID', `${to} is on this machine; a handoff moves the room to another machine`);
  if (!members.seatAlive(m)) throw err('OFFLINE', `${to} is not online; a handoff needs their answer`);
  const linked = Object.values(s.kv.get(auth.LINKS_KEY) || {}).some(l => l && l.machine === m.machine && (l.seats || []).includes(to));
  if (!linked) throw err('INVALID', `${to} is not connected to room ${code} over a link`);
  if (locator !== undefined && !transportOf(locator)) throw err('INVALID', `"${locator}" is not a locator this machine knows (pipe:/HOME, ssh:user@host[:port] or wss://host/…/sub-human/CODE)`);
  const doc = { id: crypto.randomBytes(6).toString('hex'), state: 'asked', from, to, epoch: s.hostState().epoch + 1, at: iso(now), expires_at: iso(now + askMs()) };
  if (locator) doc.locator = locator;
  if (sign) doc.ask = sign({ kind: 'host_ask', id: doc.id, epoch: doc.epoch, to, ...(locator ? { locator } : {}) });
  s.kv.set(HOST_DOC, doc);
  return doc;
}

const hostDoc = s => { try { return s.kv.get(HOST_DOC); } catch { return null; } };

function movedAway(s) {
  const h = typeof s.hostState === 'function' ? s.hostState() : { epoch: 0 };
  return !!h.machine && h.machine !== machineId();
}

/** The ask as the target's machine sees it: no signatures, no invites. */
const askView = d => ({ id: d.id, from: d.from, to: d.to, epoch: d.epoch, expires_at: d.expires_at, ...(d.locator ? { locator: d.locator } : {}) });

function streamEvent(s, link, sent) {
  const d = link && hostDoc(s);
  if (!d) return null;
  if (d.state === 'asked' && sent.ask !== d.id && (link.seats || []).includes(d.to) && !expired(d)) {
    sent.ask = d.id;
    return { ev: 'handoff', data: askView(d) };
  }
  if (d.state === 'moved' && !sent.moved && Number.isInteger(d.host_id) && sent.lastId >= d.host_id) {
    sent.moved = true;
    const invite = (!expired({ expires_at: d.invites_expire_at }) && d.invites && d.invites[link.machine]) || null;
    return { ev: 'moved', data: { epoch: d.epoch, host: d.to, machine: d.machine, locator: d.locator, invite }, end: true };
  }
  return null;
}

function checkInvites(code, locator, invites) {
  if (!invites || typeof invites !== 'object' || Array.isArray(invites)) throw err('INVALID', 'handoff.accept needs {invites: {machine: invite}}');
  for (const [m, inv] of Object.entries(invites)) {
    const p = auth.parseInvite(inv);
    if (!MACHINE_RE.test(m) || !p || p.code !== code || p.locator !== locator) throw err('INVALID', `the invite for machine ${m} is not one to room ${code} at ${locator}`);
  }
}

function checkAccept(s, d, proof, locator) {
  const pub = store.publicKey(d.to, s);
  const ok = !!proof && proof.kind === 'host_accept' && proof.room === s.code && proof.from === d.to && proof.id === d.id
    && proof.epoch === d.epoch && proof.locator === locator && envelope.isV2(proof) && envelope.freshTs(proof) && envelope.verify(proof, pub);
  if (!ok) throw err('AUTH', `a handoff needs ${d.to}'s acceptance signed with their seat key`);
}

function serverAccept(s, link, { id, accept: proof, locator, invites } = {}, now = Date.now()) {
  const d = hostDoc(s);
  if (!d || d.id !== id) throw err('INVALID', 'no such handoff is waiting (it was replaced or withdrawn)');
  if (!auth.mayWriteAs(link, d.to)) throw err('AUTH', `${d.to} has not joined over this link`);
  if (d.state !== 'asked') throw err('INVALID', `this handoff was ${d.state} already`);
  if (expired(d, now)) throw err('INVALID', `the handoff ask expired; ask ${d.from} to hand off again`);
  if (s.hostState().epoch + 1 !== d.epoch) throw err('STALE', 'the room changed hosts since this ask');
  const loc = d.locator || locator;
  if (!transportOf(loc)) throw err('INVALID', `"${loc}" is not a locator the host knows`);
  checkAccept(s, d, proof, loc);
  checkInvites(s.code, loc, invites);
  const entry = s.append({
    kind: 'host_changed', text: `room ${s.code} moved to ${d.to}'s machine (host epoch ${d.epoch}); its orch restarts there`,
    epoch: d.epoch, host: d.to, machine: link.machine, locator: loc, accept: proof, ...(d.ask ? { ask: d.ask } : {}),
  }, { via: 'system', from: d.from, system: true });
  let job = null;
  identity().updateOrch(s.code, o => {
    if (!o) return null;
    job = o.job && o.job !== 'pending' ? o.job : null;
    return { job: null, claim: undefined, left_at: iso(now), moved_at: iso(now) };
  });
  const rest = { ...invites };
  delete rest[link.machine];
  s.kv.set(HOST_DOC, {
    ...d, state: 'moved', machine: link.machine, locator: loc, host_id: entry.id, moved_at: iso(now),
    invites: rest, invites_expire_at: iso(now + config.HANDOFF_INVITE_MS),
  });
  return { entry, epoch: d.epoch, job };
}

function serverRefuse(s, link, { id } = {}, now = Date.now()) {
  const d = hostDoc(s);
  if (!d || d.id !== id || d.state !== 'asked') throw err('INVALID', 'no such handoff is waiting');
  if (!auth.mayWriteAs(link, d.to)) throw err('AUTH', `${d.to} has not joined over this link`);
  s.kv.set(HOST_DOC, { ...d, state: 'refused', refused_at: iso(now) });
  return { ok: true };
}

/** The old host after its reply: stop its orch job, then mirror the new host (a link holding its own invite). */
function afterMoved(s, { job } = {}) {
  if (job) { try { require('./orch.js').releaseDetached(s.code, job); } catch { /* the job ends with its session */ } }
  const d = hostDoc(s);
  const invite = d && d.invites && d.invites[machineId()];
  if (!invite) return false;
  links.set(s.code, { code: s.code, transport: transportWith(d.locator, invite), invite, created_at: iso(Date.now()), moved: { epoch: d.epoch, host: d.to, locator: d.locator } });
  store.forget(s.code);
  try { return linkLib().start(s.code); } catch { return false; }
}

// ---------- the link daemon of a mirror ----------
function onAsk(mirror, data) {
  if (!data || !ID_RE.test(String(data.id)) || !Number.isInteger(data.epoch)) return;
  mirror.kv.set(ASK_DOC, { ...askView(data), at: iso(Date.now()) });
}

function onMoved(mirror, data) {
  const code = mirror.code;
  const h = mirror.hostState();
  if (!data || h.epoch !== data.epoch || h.machine !== data.machine) {
    return { reason: `the host said room ${code} moved (epoch ${data && data.epoch}), but this copy does not hold that line yet` };
  }
  if (data.machine === machineId()) return { self: true, stop: true, reason: `this machine hosts room ${code} now (host epoch ${h.epoch})` };
  const how = `ask ${data.host} for an invite (/sub-human host, there), then here: /sub-human join NAME INVITE PIN`;
  if (!data.invite) return { stop: true, reason: `room ${code} moved to ${data.host}'s machine, and no invite came for this machine; ${how}` };
  const transport = transportWith(data.locator, data.invite);
  if (!transport) return { stop: true, reason: `room ${code} moved to ${data.host}'s machine at "${data.locator}", which this machine cannot use; ${how}` };
  const cur = links.get(code) || {};
  links.set(code, {
    code, transport, invite: data.invite, created_at: cur.created_at || iso(Date.now()),
    moved: { epoch: data.epoch, host: data.host, locator: data.locator, at: iso(Date.now()) },
  });
  if (cur.token === undefined && cur.invite === undefined) return { reason: 'repointed' };
  return { reason: `room ${code} moved to ${data.host}'s machine (host epoch ${data.epoch}); reconnecting there` };
}

function whyOffline(code, message) {
  const l = links.get(code);
  if (!l || !l.moved || l.token) return message;
  return `room ${code} moved to ${l.moved.host}'s machine (${l.moved.locator}), which this machine cannot reach yet (${message}). `
    + `If it never can, ask ${l.moved.host} for an invite this machine can use (/sub-human host there), then: /sub-human join NAME INVITE PIN`;
}

// ---------- the target ----------
function pendingAsk(code, name, now = Date.now()) {
  let a;
  try { a = store.open(code).kv.get(ASK_DOC); } catch { return null; }
  if (!a || a.to !== name || expired(a, now)) return null;
  return a;
}

function markTold(code, id) {
  try { store.open(code).kv.update(ASK_DOC, a => (a && a.id === id && !a.told_at ? { ...a, told_at: iso(Date.now()) } : undefined)); } catch { /* told again */ }
}

const question = (a, code) => `Host room ${code} on this machine? (handoff ${a.id})`;

function card(a, code) {
  return {
    questions: [{
      question: question(a, code),
      header: 'Handoff',
      multiSelect: false,
      options: [
        { label: YES, description: `${a.from} asks to move the room here. Its orch (the room's Claude helper) then runs on YOUR model account: your Claude or Bedrock billing and rate limits. This machine must stay on and reachable for the others.` },
        { label: NO, description: `${a.from} stays the host; nothing changes.` },
      ],
    }],
  };
}

/** Every other machine with a seat in the room: machine -> [seat names] (the old host's included). */
function machinesOf(s) {
  const by = new Map();
  for (const m of Object.values(s.members.read())) {
    if (!m || !m.name || m.left_at || m.role === 'orch' || !m.machine || m.machine === machineId()) continue;
    if (!by.has(m.machine)) by.set(m.machine, []);
    by.get(m.machine).push(m.name);
  }
  return by;
}

/** One sh2 invite per other machine (auth.mintFor): PIN-less over a link (a handoff), with a PIN by hand (promote). */
function mintAll(s, locator, { pin = false, machines = machinesOf(s) } = {}) {
  const out = [];
  for (const [machine, seats] of machines) {
    const m = auth.mintFor(s, { locator, machine, seats, pin, hostKey: webKeyFor(locator) });
    out.push({ machine, seats, invite: m.invite, ...(m.pin ? { pin: m.pin } : {}) });
  }
  return out;
}

function accept(me, { cwd, sign } = {}) {
  const code = me.code;
  const s = store.open(code);
  if (s.isHost) return { ok: false, error: `this machine hosts room ${code} already` };
  const a = pendingAsk(code, me.name);
  if (!a) return { ok: false, error: 'no handoff is waiting for you (it expired or was withdrawn)' };
  if (s.hostState().epoch + 1 !== a.epoch) return { ok: false, error: 'the room changed hosts since this ask' };
  const locator = a.locator || linkLib().pipeLocator();
  if (!transportOf(locator)) return { ok: false, error: `"${locator}" is not a locator this machine knows` };
  try { serveWeb(code, locator); } catch (e) { return { ok: false, error: `could not serve room ${code} over the web here: ${e.message}` }; }
  const invites = Object.fromEntries(mintAll(s, locator).map(x => [x.machine, x.invite]));
  const proof = sign({ kind: 'host_accept', id: a.id, epoch: a.epoch, locator });
  try {
    s.request('handoff.accept', { id: a.id, accept: proof, locator, invites }, { deadlineMs: config.HANDOFF_CALL_MS });
  } catch (e) {
    if (!(e instanceof RoomError)) throw e;
    return { ok: false, error: e.message };
  }
  try { s.kv.delete(ASK_DOC); } catch { /* gone with the link */ }
  return { ok: true, epoch: a.epoch, note: takeOver(code, { by: me.name, cwd, epoch: a.epoch }) };
}

function refuse(me) {
  const s = store.open(me.code);
  const a = pendingAsk(me.code, me.name);
  if (!a) return { ok: false, error: 'no handoff is waiting for you' };
  try { s.request('handoff.refuse', { id: a.id }); } catch (e) {
    if (!(e instanceof RoomError)) throw e;
    return { ok: false, error: e.message };
  }
  s.kv.delete(ASK_DOC);
  return { ok: true };
}

/** Stop this room's link daemon (it may have stopped itself on the 'moved' event) and wait for it to exit. */
function stopDaemon(code) {
  const st = linkLib().status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  for (const until = Date.now() + 3000; Date.now() < until && isAlive(st.pid); sleepSync(20));
}

function takeOver(code, { by, cwd, epoch, entry } = {}) {
  const mirror = store.open(code);
  if (!entry) {
    const h = mirror.hostState();
    if (h.machine !== machineId() || (epoch && h.epoch !== epoch)) throw err('FORK', `this copy of room ${code} does not hold the line that moves it here`);
  }
  const v = mirror.verifyChain();
  if (!v.ok) throw err('FORK', `this copy of room ${code} does not chain at ${v.badAt != null ? `#${v.badAt}` : `line ${v.line}`}`);
  stopDaemon(code);
  links.remove(code);
  store.forget(code);
  const s = store.open(code);
  if (!s.isHost) throw err('INVALID', `room ${code} is still linked from this machine`);
  try { s.kv.delete('link'); } catch { /* none */ }
  if (entry) s.append(entry, { via: 'system', from: by, system: true });
  identity().adoptLocalSeats(code);
  s.kv.delete(auth.LINKS_KEY); // links from an earlier time this machine hosted: their tokens are not this epoch's
  s.kv.delete(HOST_DOC);
  if (cwd && !s.kv.get(WORKDIR)) s.kv.set(WORKDIR, { cwd });
  const now = iso(Date.now());
  identity().updateOrch(code, () => ({ job: null, pid: null, pid_start: undefined, claim: undefined, closing: undefined, left_at: now, stopped_at: now }));
  return require('./seats.js').ensureOrch(code, cwd, by);
}

// ---------- promote / demote ----------
function promote(code, { name, locator, force = false, cwd, now = Date.now() } = {}) {
  const s = store.open(code);
  if (s.isHost) throw err('INVALID', `this machine hosts room ${code} already`);
  const st = linkLib().status(code);
  if (st.running && st.state === 'online') throw err('INVALID', `the host of room ${code} is reachable (the link is online): use a planned handoff, the host runs /sub-human handoff ${name}`);
  const gate = config.envMs('SUB_HUMAN_PROMOTE_OFFLINE_MS', config.PROMOTE_OFFLINE_MS, { allowZero: true });
  const down = now - (Date.parse(st.since || '') || now);
  if (!force && down < gate) throw err('INVALID', `the link to room ${code}'s host has been down ${Math.round(down / 1000)} s; promote only after ${Math.round(gate / 60_000)} min (or --force)`);
  const m = s.members.read()[name];
  if (!m || m.left_at || m.machine !== machineId()) throw err('INVALID', `${name} is not a seat of this machine in room ${code}`);
  const full = s.validateChain();
  if (!full.ok || !s.lastId()) throw err('FORK', `this machine's copy of room ${code} is empty or does not chain; it cannot become the room`);
  locator = locator || linkLib().pipeLocator();
  if (!transportOf(locator)) throw err('INVALID', `"${locator}" is not a locator this machine knows`);
  const h = s.hostState();
  const epoch = h.epoch + 1;
  const last = s.lastId();
  const machines = machinesOf(s);
  const entry = {
    kind: 'host_changed', epoch, host: name, machine: machineId(), locator, promoted: true,
    text: `${name} promoted this machine to host room ${code} (host epoch ${epoch}): the old host was unreachable; lines it wrote after #${last} are not in the room`,
  };
  serveWeb(code, locator);
  const note = takeOver(code, { by: name, cwd, entry });
  const invites = mintAll(store.open(code), locator, { pin: true, machines }); // handed out by hand: each with its PIN
  const placed = store.open(code).readAll().at(-1);
  return { epoch, entry: placed, invites, note, last };
}

function demote(code, invite, pin) {
  const s = store.open(code);
  if (!s.isHost) throw err('INVALID', `room ${code} is not hosted on this machine`);
  const inv = auth.parseInvite(invite);
  if (!inv || inv.code !== code) throw err('INVALID', `that is not an invite to room ${code}`);
  const transport = transportOf(inv.locator);
  if (!transport) throw err('INVALID', `this machine cannot use "${inv.locator}"`);
  const o = s.members.read().orch;
  if (o && o.job && o.job !== 'pending') { try { require('./orch.js').releaseDetached(code, o.job); } catch { /* ends with its session */ } }
  const orphan = s.setAside();
  for (const k of [auth.LINKS_KEY, auth.INVITES_KEY, HOST_DOC, WORKDIR, 'tasks']) s.kv.delete(k);
  for (const k of s.kv.list('presence/')) s.kv.delete(k);
  const moved = { demoted: true, locator: inv.locator, host: 'the new host' };
  let request = null;
  if (inv.v === 2) {
    // the joiner's side of an sh2 invite (its PIN; over ssh the link's own key and the pinned host key)
    const name = identity().localSeats(code).find(n => n !== 'orch') || 'host';
    request = require('./remote/hosting.js').joinInvite({ inv, invite, pin, name }).request || null;
    links.set(code, { ...links.get(code), moved });
  } else links.set(code, { code, transport, invite, created_at: iso(Date.now()), moved });
  store.forget(code);
  linkLib().start(code);
  return { orphan, request };
}

function status(code) {
  const s = store.open(code);
  const out = { host: s.hostState(), isHost: s.isHost, doc: hostDoc(s) };
  if (s.isHost) {
    const linksNow = Object.values(s.kv.get(auth.LINKS_KEY) || {});
    const inv = Object.values(s.kv.get(auth.INVITES_KEY) || {}).filter(i => i.handoff);
    out.machines = inv.map(i => ({ machine: i.machine, seats: i.seats, connected: !!i.used_at || linksNow.some(l => l.machine === i.machine) }));
  }
  return out;
}

module.exports = {
  HOST_DOC, ASK_DOC, YES, NO,
  ask, hostDoc, streamEvent, serverAccept, serverRefuse, afterMoved, movedAway,
  onAsk, onMoved, whyOffline, pendingAsk, markTold, question, card, accept, refuse, takeOver, promote, demote, status,
};
