'use strict';
/**
 * plugin/sub-human/lib/remote/hosting.js: the host's side of an sh2 link, one step each, shared by the join hook
 * (`/sub-human host`, `/sub-human admit`, `/sub-human revoke`: their output is a block reason, shown to the person
 * and never to the model) and the CLI (lib/cli/host.js). The joiner's side is joinInvite() below; the
 * key material is lib/remote/sshkeys.js.
 *
 *   hostInvite(code, {ssh?, via?, long?, short?, by?, now?}) -> {pin, ref, expires_at, short: true, line, text} | {invite, pin, …}
 *       Over ssh, a SHORT invite by default (lib/remote/enroll.js): `/sub-human join NAME DEST [--via J] CODE PIN`, the
 *       6-digit code the whole secret (auth.mintShort, kind ssh, vouching for sshd's host key), and the enrollment door
 *       in authorized_keys (enroll.openDoor); by: the seat whose card admits the joiner. long: the sh2 invite below.
 *       A pipe invite is sh2 unless short (then `/sub-human join NAME pipe:HOME CODE PIN`). The sh2 form:
 *       an sh2 invite to room CODE (hosted here) and its PIN (lib/remote/auth.js mintInvite). ssh: undefined for a
 *       pipe invite (a second home on this machine); true for this machine's own address (SUB_HUMAN_SSH_ADDR, else
 *       <user>@<hostname>); or "user@host[:port]". via: a ProxyJump for the joiner ("bastion", "me@jump:2222"). Over
 *       ssh the invite pins this machine's sshd Ed25519 host key (sshkeys.hostKey), and the stable serve shim must
 *       be writable (lib/remote/shim.js refresh). text: the copyable block for the person
 *   admit(request, {file?, now?}) -> {code, id, name, fingerprint, result, text}
 *       the person's consent to an admit request (sshkeys.parseRequest): the invite it names is reserved for a link
 *       (auth.reserveRef) and the joiner's key gets the forced-command line for that link and room only
 *       (shim.authorizedLine, sshkeys.appendAuthorized into file, default sshkeys.authorizedKeysFile()). A room line
 *       says so. The PIN is still checked at the link's first hello
 *   revoke(code, target, {file?}) -> {id, ref?, seats, keys, text}
 *       target: a link id, the name of a seat that joined over a link, or one invite: its ref (the 12 hex shown with
 *       it) or the invite itself (sh1/sh2 or a join URL). A link: its token stops working (auth.revokeLink, which also
 *       burns an invite reserved for it), its authorized_keys lines go, its seats leave ("revoked by the host"), its
 *       running `serve` processes are stopped, and a room line says so. An invite no link holds: just it is burnt
 *       (auth.burnInvite), with a room line; one reserved for or used by a link revokes that link. A link made over this
 *       account's own ssh login (auth.loginLink) has no key line: its token goes and its serve is stopped, and the text
 *       says that login can link again
 *   joinInvite({inv, invite, pin, name, now?}) -> {code, request?}   the joiner's link file for an sh2 invite: over
 *       ssh, the link's own key (sshkeys.linkKey in links.dirOf(code)) and, when the invite carries one, the host
 *       key pinned in a known_hosts of the link's own; over ws/wss, the listener's X25519 key the invite carries,
 *       pinned in the link file's transport (hostKey; no admit step); request: the admit request for the host. RoomError INVALID
 *       for a locator this machine cannot use
 *   linkTransport({inv, name, cur?}) -> {transport, request} | null   joinInvite's link transport, also the one a handoff's
 *       follower (lib/handoff.js onMoved, afterMoved, demote) builds: over ssh the link's own key (made once, kept),
 *       the invite's host key pinned (else the old pin for the same destination), mux from cur kept, and the admit
 *       request; over ws/wss the pinned listener key. null for a locator this machine cannot use
 *   shimReady() -> {shim, h}   the stable serve shim written and the plain home path it carries (admit, authorize);
 *       RoomError INVALID under a temp plugin root or a home path a forced command cannot carry
 *   outcome(code, {waitMs?}) -> {state: 'linked' | 'refused' | 'waiting', reason?}   the link daemon's first hello,
 *       watched for up to waitMs (LINK_JOIN_WAIT_MS): linked (the PIN held), refused (its reason: a wrong PIN, an
 *       expired invite, a protocol skew), or waiting (ssh not admitted yet, or slow)
 *   joinShort({code, transport, pin, name}) -> {code}   a short code's link file before the PAKE (the daemon runs it)
 *   joinText(code, name, outcome, request?) -> string   what the joiner's person reads next (a short code: the host's
 *       card names them and the check their screen shows)
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const auth = require('./auth.js');
const sshkeys = require('./sshkeys.js');
const { RoomError } = require('../room/validate.js');
const { INVITE_TTL_MS, LINK_JOIN_WAIT_MS } = require('../config.js');

const sshT = () => require('./transports/ssh.js');
const linkLib = () => require('./link.js');
const links = () => require('../room/links.js');
const roomOf = code => require('../room.js').open(code);
const minutes = ms => Math.round(ms / 60_000);

function hostStore(code) {
  const identity = require('../identity.js');
  if (!identity.roomExists(code)) throw new RoomError('NO_ROOM', `no room "${code}"`);
  const s = roomOf(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; its host does this`);
  return s;
}

/** A line in the room from the room itself, best effort. */
function roomLine(code, text) {
  try { roomOf(code).append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch { /* the action stands */ }
}

/** The stable serve shim (an ssh forced command names it); the home path it carries. */
function shimReady() {
  const shim = require('./shim.js');
  if (!shim.refresh({ force: true })) throw new RoomError('INVALID', `the plugin root ${shim.pluginRoot()} is under a temp dir; sshd would run whatever sits there (set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow)`);
  const h = path.resolve(require('../home.js').home());
  if (!shim.PLAIN_PATH_RE.test(h)) throw new RoomError('INVALID', `the home path "${h}" has characters a forced command cannot carry plainly; move it`);
  return { shim, h };
}

const selfAddress = () => process.env.SUB_HUMAN_SSH_ADDR || `${os.userInfo().username}@${os.hostname()}`;

/**
 * The text a short invite is shown with: the one line the joiner types (the code is the whole secret), and what
 * happens next on this side (the card).
 */
function shortText({ code, how, line, ref, extra = [] }) {
  return [
    `invite to room ${code}, for one machine, ${how}. Shown once; it lasts ${minutes(INVITE_TTL_MS)} minutes.`,
    '',
    `  ${line}`,
    '',
    'The 6-digit code is the whole secret: send this line privately (a direct message), or send it without the code and say the code. 5 wrong codes burn it.',
    'When they type it, a card here asks you to let them in (or refuse); nothing gets in before you answer. In a shell: sub-human admit.',
    `Leaked? /sub-human revoke ${ref} burns just this invite (its ref; the room and its links stay).`,
    ...extra,
  ].join('\n');
}

function hostInvite(code, { ssh, via, long = false, short = false, by = null, now = Date.now() } = {}) {
  const store = hostStore(code);
  let locator, hostKey = null, dest = null;
  if (ssh === undefined || ssh === false) {
    if (via !== undefined) throw new RoomError('INVALID', '--via is for an ssh invite (--ssh)');
    locator = linkLib().pipeLocator();
    if (short && !long) { // a second home on this machine, by a short code (tests, and anyone who wants it)
      const r = auth.mintShort(store, { kind: 'pipe', locator, by, now });
      const line = `/sub-human join NAME ${locator} ${code} ${r.pin}`;
      return { ...r, short: true, locator, line, text: shortText({ code, how: '(a second home on this machine)', line, ref: r.ref }) };
    }
  } else {
    dest = ssh === true ? selfAddress() : String(ssh);
    locator = sshT().locator(dest, via !== undefined ? { via } : {});
    if (!locator) {
      throw new RoomError('INVALID', sshT().dest(dest) ? `--via "${via}" is not a plain [user@]host[:port]` : `"${dest}" is not a plain user@host[:port]${ssh === true ? ' (set SUB_HUMAN_SSH_ADDR, or give --ssh USER@HOST)' : ''}`);
    }
    shimReady();
    hostKey = sshkeys.hostKey();
    if (!long) return hostShortSsh(code, store, { dest, via, locator, hostKey, by, now });
  }
  const r = auth.mintInvite(store, { locator, pin: true, hostKey, now });
  const lines = [
    `invite to room ${code}, for one machine${dest ? `, over ssh ${dest}${via ? ` via ${via}` : ''}` : ' (a second home on this machine)'}. Shown once; it lasts ${minutes(INVITE_TTL_MS)} minutes.`,
    '',
    `  /sub-human join NAME ${r.invite} PIN`,
    '',
    `PIN ${r.pin}  (send it apart from the invite, e.g. say it; 5 wrong tries burn the invite)`,
    `Leaked? /sub-human revoke ${auth.inviteRef(r.secret)} burns just this invite (its ref; the room and its links stay).`,
  ];
  if (dest) {
    lines.push(hostKey
      ? `The invite pins this machine's ssh host key ${sshkeys.fingerprint(hostKey)}.`
      : 'No ssh host key was readable here (/etc/ssh/ssh_host_ed25519_key.pub), so the joiner\'s own known_hosts decides.');
    lines.push('Their join then shows them a line to send back to you: paste it here, /sub-human admit shk1.…, to let their key in.');
  }
  return { ...r, locator, hostKey, text: lines.join('\n') };
}

/** host --ssh's short invite: the code, and the enrollment door in authorized_keys (lib/remote/enroll.js). */
function hostShortSsh(code, store, { dest, via, locator, hostKey, by, now }) {
  if (!hostKey) {
    throw new RoomError('INVALID', 'no ssh host key is readable here (/etc/ssh/ssh_host_ed25519_key.pub, or SUB_HUMAN_SSH_HOST_KEY), and a short code needs one to vouch for; use /sub-human host --ssh --long (an sh2 invite)');
  }
  const file = path.resolve(sshkeys.authorizedKeysFile());
  const r = auth.mintShort(store, { kind: 'ssh', locator, hostKey, by, doorFile: file, now });
  try { require('./enroll.js').openDoor(code, { file }); } catch (e) {
    try { auth.burnInvite(store, r.ref); } catch { /* it lapses */ }
    throw e;
  }
  const line = `/sub-human join NAME ${dest}${via ? ` --via ${via}` : ''} ${code} ${r.pin}`;
  return {
    ...r, short: true, locator, hostKey, line,
    text: shortText({
      code, how: `over ssh ${dest}${via ? ` via ${via}` : ''}`, line, ref: r.ref,
      extra: [`Their machine checks it reached this one (ssh host key ${sshkeys.fingerprint(hostKey)}) inside the code's handshake, and makes its own key; until you let it in, that key opens nothing (an authorized_keys line that only runs the code check is there while the invite is open).`],
    }),
  };
}

function admit(request, { file = sshkeys.authorizedKeysFile(), now = Date.now() } = {}) {
  const req = sshkeys.parseRequest(request);
  if (!req) throw new RoomError('INVALID', 'that is not an admit request (shk1.CODE.REF.KEY.NAME, from the joiner\'s /sub-human join)');
  const store = hostStore(req.code);
  const inv = Object.entries(store.kv.get(auth.INVITES_KEY, null) || {}).find(([k]) => k.startsWith(req.ref));
  const { id } = auth.reserveRef(store, req.ref, { now });
  const { shim, h } = shimReady();
  const key = sshkeys.openssh(req.key);
  const line = shim.authorizedLine(req.code, id, key, h);
  const result = sshkeys.appendAuthorized(path.resolve(file), line, key);
  const fp = sshkeys.fingerprint(req.key);
  const left = inv && inv[1].expires_at ? Math.max(0, Date.parse(inv[1].expires_at) - now) : null;
  if (result === 'added') roomLine(req.code, `the host admitted a key for ${req.name} (${fp}) to link ${id}; its first hello still needs the invite's PIN`);
  const text = `${result === 'added' ? 'admitted' : 'already admitted'}: ${req.name}'s key ${fp} may reach room ${req.code} as link ${id}, `
    + `and nothing else (a forced command in ${file}). The invite's PIN is still checked when they connect${left !== null ? ` (${minutes(left)} min left)` : ''}. `
    + `Undo: sub-human revoke ${id}`;
  return { code: req.code, id, name: req.name, fingerprint: fp, result, text };
}

function linkIdOf(store, target) {
  const all = auth.links(store);
  if (auth.LINK_ID_RE.test(target) && auth.linkKnown(store, target)) return target;
  const hits = Object.values(all).filter(l => Array.isArray(l.seats) && l.seats.includes(target));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new RoomError('INVALID', `${target} joined over ${hits.length} links (${hits.map(l => l.id).join(', ')}); name one`);
  // a short code's joiner not linked yet (waiting for the card, or let in and not connected): its reserved link
  const asked = auth.admissions(store, { all: true }).filter(a => a.name === target && !a.used_at && !a.burnt_at);
  if (asked.length === 1) return asked[0].link;
  throw new RoomError('INVALID', `"${target}" is neither a link or an invite of room ${store.code} nor a seat that joined over a link`);
}

/** The ref of the invite target names: the invite itself (sh1/sh2 or a join URL), or its ref when no link has that
 * id. null: target names no invite (a link id or a seat name, then). */
function inviteRefOf(store, target) {
  const parsed = auth.parseInvite(target) || (/^https?:\/\//.test(target) ? require('./transports/ws.js').parseJoinUrl(target) : null);
  if (parsed) {
    if (parsed.code !== store.code) throw new RoomError('INVALID', `that invite is for room ${parsed.code}, not ${store.code}`);
    const ref = auth.inviteRef(parsed.secret);
    if (!auth.findInvite(store, ref)) throw new RoomError('INVALID', `that invite is not one room ${store.code} minted`);
    return ref;
  }
  if (auth.LINK_ID_RE.test(target) && (auth.links(store)[target])) return null;
  return auth.findInvite(store, target) ? target : null;
}

/** Burn one invite (a leaked one) by its ref; one reserved for or used by a link ends that link (revoke). */
function revokeInvite(code, store, ref, opts) {
  const { invite } = auth.findInvite(store, ref);
  if (invite.link) {
    const r = revoke(code, invite.link, opts);
    return { ...r, ref, text: `invite ${ref} ${invite.used_at ? 'was used already, by' : 'was reserved for'} link ${invite.link}; ${r.text}` };
  }
  const { state } = auth.burnInvite(store, ref);
  try { require('./enroll.js').sweepDoors(code); } catch { /* the tail sweeps it */ }
  if (state === 'burnt') roomLine(code, `the host revoked an unused invite (ref ${ref}): it no longer lets anyone in`);
  const text = state === 'burnt'
    ? `revoked invite ${ref} of room ${code}: it is burnt and lets no one in; every other invite and link stays`
    : `invite ${ref} of room ${code} was burnt already (a wrong PIN, expired, or revoked); nothing changed`;
  return { id: null, ref, seats: [], keys: 0, text };
}

function revoke(code, target, { file = sshkeys.authorizedKeysFile() } = {}) {
  const store = hostStore(code);
  const ref = inviteRefOf(store, String(target).trim());
  if (ref) return revokeInvite(code, store, ref, { file });
  const id = linkIdOf(store, String(target));
  const r = auth.revokeLink(store, id) || { link: null, invites: 0 };
  const doors = new Set([path.resolve(file), ...auth.admissions(store, { all: true }).filter(a => a.link === id && a.door_file).map(a => path.resolve(a.door_file))]);
  let keys = 0;
  for (const f of doors) keys += sshkeys.removeAuthorized(f, code, id);
  try { require('./enroll.js').sweepDoors(code); } catch { /* the tail sweeps it */ }
  spawnSync('pkill', ['-f', '--', `--stdio ${code} --link ${id}`], { stdio: 'ignore' });
  const seats = r.link ? r.link.seats || [] : [];
  const seatsLib = require('../seats.js');
  for (const name of seats) { try { seatsLib.exit(code, name, 'revoked by the host'); } catch { /* gone already */ } }
  const login = !!(r.link && r.link.login); // a link made over this account's own ssh login (no key line of its own)
  roomLine(code, `the host revoked link ${id}${seats.length ? ` (${seats.join(', ')})` : ''}: its ${login ? 'token no longer reaches' : 'token and key no longer reach'} the room`);
  const text = `revoked link ${id} of room ${code}: token burnt${r.invites ? `, ${r.invites} invite(s) burnt` : ''}, `
    + (login ? 'its serve stopped' : `${keys} authorized_keys line(s) removed from ${file}`) + (seats.length ? `, ${seats.join(', ')} left` : '')
    + (login ? `. It came over an ssh login to this account, which can link again: to shut that, take its key out of ${file}` : '');
  return { id, seats, keys, text };
}

// ---------- the joiner ----------
/**
 * The link file's transport for an sh2 invite, with what this machine adds to it. Over ssh: the link's own key
 * (sshkeys.linkKey in links.dirOf(code): made once, kept across a re-point), the host key the invite pins (a
 * known_hosts of the link's own; without one, the old pin is kept only for the same user@host[:port]), and mux (a
 * `sub-human prime` master) carried over from cur; request: the admit request for the invite's host. Over ws/wss: the
 * listener's X25519 key the invite carries. null for a locator this machine cannot use.
 */
function linkTransport({ inv, name, cur = null }) {
  let transport = linkLib().transportOf(inv.locator);
  if (!transport) return null;
  const prev = (cur && cur.transport) || {};
  let request = null;
  if (transport.kind === 'ssh') {
    const dir = links().dirOf(inv.code);
    const key = sshkeys.linkKey(dir, `sub-human:${inv.code}:${name}`);
    transport = { ...transport, key: key.file };
    const sameDest = prev.kind === 'ssh' && prev.user === transport.user && prev.host === transport.host && prev.port === transport.port;
    if (inv.hostKey) {
      const alias = `sub-human-${inv.code}`;
      const knownHosts = path.join(dir, 'known_hosts');
      fs.writeFileSync(knownHosts, sshkeys.knownHostsLine(alias, inv.hostKey) + '\n', { mode: 0o600 });
      transport = { ...transport, knownHosts, alias };
    } else if (sameDest && prev.knownHosts && prev.alias) transport = { ...transport, knownHosts: prev.knownHosts, alias: prev.alias };
    if (prev.mux === true) transport = { ...transport, mux: true };
    request = sshkeys.formatRequest({ code: inv.code, ref: auth.inviteRef(inv.secret), key: key.raw, name });
  }
  if (transport.kind === 'wss' || transport.kind === 'ws') { // the listener's X25519 key, pinned (transports/ws.js)
    if (!inv.hostKey) throw new RoomError('INVALID', 'this web invite pins no host key; ask the host for a new one');
    transport = { ...transport, hostKey: inv.hostKey };
  }
  return { transport, request };
}

function joinInvite({ inv, invite, pin, name }) {
  const lt = linkTransport({ inv, name, cur: links().get(inv.code) });
  if (!lt) throw new RoomError('INVALID', `this invite reaches its room through "${inv.locator.split(':')[0]}", which this machine cannot use`);
  const { transport, request } = lt;
  links().set(inv.code, { code: inv.code, transport, invite, pin, ...(request ? { request } : {}), created_at: new Date().toISOString() });
  return { code: inv.code, request };
}

function outcome(code, { waitMs = LINK_JOIN_WAIT_MS } = {}) {
  const { sleepSync } = require('../io.js');
  const l = linkLib();
  for (const until = Date.now() + waitMs; ; sleepSync(50)) {
    const st = l.status(code);
    const stopped = l.stopReason(st);
    if (stopped) return { state: 'refused', reason: stopped.reason };
    const lf = links().get(code);
    if (st.state === 'online' && lf && lf.token) return { state: 'linked' };
    if (st.state === 'offline' && lf && (lf.request || lf.awaiting)) return { state: 'waiting', reason: st.reason };
    if (Date.now() >= until) return { state: 'waiting', reason: st.reason };
  }
}

function joinText(code, name, o, request) {
  const lf = links().get(code) || {};
  if (o.state === 'linked') return `linked to room ${code}: ${lf.awaiting || o.short ? 'the host let this machine in' : 'the host checked your PIN'}. Now type: /sub-human ${name} ${code}`;
  if (o.state === 'refused') return `could not link to room ${code}: ${o.reason}`;
  if (lf.awaiting) {
    return `the host's machine checked your code. A card there now asks them to let you in; it names ${name} (${lf.awaiting.check}). `
      + `Once they do, type: /sub-human ${name} ${code}  (the link keeps trying for ${minutes(require('../config.js').ADMIT_TTL_MS)} minutes)`;
  }
  if (request) {
    return `this machine made a key of its own for room ${code}; the host has to let it in first. Send them this line (it holds no secret):\n\n`
      + `  /sub-human admit ${request}\n\n`
      + `Once they have, type: /sub-human ${name} ${code}  (the link keeps trying for ${minutes(INVITE_TTL_MS)} minutes; your PIN is checked when it gets through)`;
  }
  const t = (links().get(code) || {}).transport || {};
  const cert = t.kind === 'wss' && /\.ts\.net$/i.test(String(t.host || '')) && !o.reason
    ? ' (Tailscale may be issuing a certificate: the first connection to a ts.net name can take ~20 s; the link keeps trying)' : '';
  return `the link to room ${code} is still connecting${o.reason ? ` (${o.reason})` : cert}; type /sub-human ${name} ${code} in a moment`;
}

/**
 * `/sub-human join NAME DEST CODE PIN` (or URL PIN): the link file for a short code, before any attempt: the
 * transport to the host's door, and the code (enroll, 0600, dropped once the host answered). The daemon runs the
 * PAKE (lib/remote/enroll.js enrollLink).
 */
function joinShort({ code, transport, pin, name }) {
  links().set(code, { code, transport, enroll: { pin, name }, created_at: new Date().toISOString() });
  return { code };
}

module.exports = { hostInvite, admit, revoke, linkTransport, joinInvite, joinShort, outcome, joinText, shimReady, shortText };
