'use strict';
/**
 * plugin/sub-human/lib/remote/hosting.js: the host's side of an invite, one step each, shared by the join hook
 * (`/sub-human invite`, `/sub-human kick`: their output is a block reason, shown to the person and never to the
 * model) and the CLI (lib/cli/host.js). The joiner's side is joinShort() below (the PAKE runs in the link daemon,
 * lib/remote/enroll.js); the key material is lib/remote/sshkeys.js.
 *
 *   hostInvite(code, {ssh?, via?, pipe?, by?, now?}) -> {pin, ref, expires_at, short: true, locator, line, text}
 *       A short invite: the line the joiner types, `/sub-human join DEST ROOM PIN [--via J]`, the 4-digit PIN the
 *       whole secret (auth.mintShort). ssh (the default): true for this machine's own address (SUB_HUMAN_SSH_ADDR, else
 *       <user>@<hostname>), or "user@host[:port]"; via: a ProxyJump for the joiner ("bastion", "me@jump:2222"). Over ssh
 *       the PIN vouches for sshd's Ed25519 host key (sshkeys.hostKey), the stable serve shim must be writable
 *       (lib/remote/shim.js refresh) and the enrollment door goes into authorized_keys (enroll.openDoor). pipe: a
 *       second home on this machine (`/sub-human join pipe:HOME ROOM PIN`; tests and the demo). by: the seat whose
 *       card admits the joiner (lib/remote/admission.js). text: the copyable block for the person
 *   cancelInvite(code, ref?) -> {ref?, refs?, text}   burn one unused invite (a leaked one) by its ref; with no ref, the
 *       one open invite, or the list of them when there are several. One reserved for or used by a link ends that
 *       link (kick)
 *   kick(code, name, {file?}) -> {id, seats, keys, text}   end the link NAME joined over: its token stops working
 *       (auth.revokeLink, which also burns an invite reserved for it), its authorized_keys lines go, its seats leave
 *       ("removed by the host"), its running `serve` processes are stopped, and a room line says so. A joiner still
 *       waiting for the card: its reserved link. A link made over this account's own ssh login (auth.loginLink) has no
 *       key line: its token goes and its serve is stopped, and the text says that login can link again
 *   linkTransport({inv, name, cur?}) -> {transport, request} | null   the link transport for an sh2 invite (internal:
 *       a handoff's follower, lib/handoff.js onMoved, afterMoved, demote): over ssh the link's own key (made once,
 *       kept), the invite's host key pinned (else the old pin for the same destination), mux from cur kept, and the
 *       request (no secret: it marks a key the new host has not let in); over ws/wss the pinned listener key. null for
 *       a locator this machine cannot use
 *   joinInvite({inv, invite, pin, name}) -> {code, request?}   the link file for an sh2 invite (demote: a machine
 *       follows a promoted room with the invite promote printed for it). RoomError INVALID for a locator this machine
 *       cannot use
 *   shimReady() -> {shim, h}   the stable serve shim written and the plain home path it carries (the card's admit);
 *       RoomError INVALID under a temp plugin root or a home path a forced command cannot carry
 *   outcome(code, {waitMs?}) -> {state: 'linked' | 'refused' | 'waiting', reason?}   the link daemon's first hello,
 *       watched for up to waitMs (LINK_JOIN_WAIT_MS): linked, refused (its reason: a wrong PIN, an expired invite, a
 *       protocol skew), or waiting (the host's card not answered yet, or slow)
 *   joinShort({code, transport, pin, name}) -> {code}   a short invite's link file before the PAKE (the daemon runs it);
 *       join_as: the name the seat takes once the host lets this machine in (a bare /sub-human finishes the join)
 *   joinText(code, name, outcome) -> string   what the joiner's person reads next
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
 * The text a short invite is shown with: the one line the joiner types (the PIN is the whole secret), and what
 * happens next on this side (the card).
 */
function shortText({ code, how, line, ref, extra = [] }) {
  return [
    `invite to room ${code}, for one machine, ${how}. Shown once; it lasts ${minutes(INVITE_TTL_MS)} minutes.`,
    '',
    `  ${line}`,
    '',
    'The 4-digit PIN is the whole secret: send this line privately (a direct message), or send it without the PIN and say the PIN. 5 wrong PINs burn it.',
    'When they type it, a card here asks you to let them in (or refuse); nothing gets in before you answer.',
    `Leaked? /sub-human invite --cancel ${ref} cancels just this invite.`,
    ...extra,
  ].join('\n');
}

function hostInvite(code, { ssh = true, via, pipe = false, by = null, now = Date.now() } = {}) {
  const store = hostStore(code);
  if (pipe) { // a second home on this machine (tests, the demo)
    if (via !== undefined) throw new RoomError('INVALID', '--via is for an ssh invite');
    const locator = linkLib().pipeLocator();
    const r = auth.mintShort(store, { kind: 'pipe', locator, by, now });
    const line = `/sub-human join ${locator} ${code} ${r.pin}`;
    return { ...r, short: true, locator, line, text: shortText({ code, how: '(a second home on this machine)', line, ref: r.ref }) };
  }
  const dest = ssh === true ? selfAddress() : String(ssh);
  if (sshT().placeholder(dest)) throw new RoomError('INVALID', `"${dest}" still has an example's placeholder: give the address the other machine reaches this one at (user@host, or set SUB_HUMAN_SSH_ADDR)`);
  const locator = sshT().locator(dest, via !== undefined ? { via } : {});
  if (!locator) {
    throw new RoomError('INVALID', sshT().dest(dest) ? `--via "${via}" is not a plain [user@]host[:port]` : `"${dest}" is not a plain user@host[:port]${ssh === true ? ' (set SUB_HUMAN_SSH_ADDR, or give --ssh USER@HOST)' : ''}`);
  }
  shimReady();
  const hostKey = sshkeys.hostKey();
  if (!hostKey) {
    throw new RoomError('INVALID', 'no ssh host key is readable here (/etc/ssh/ssh_host_ed25519_key.pub, or SUB_HUMAN_SSH_HOST_KEY), and an ssh invite needs one to vouch for; the other machine can join over its own ssh login instead (/sub-human join HOST ROOM), or use /sub-human invite --web');
  }
  const file = path.resolve(sshkeys.authorizedKeysFile());
  const r = auth.mintShort(store, { kind: 'ssh', locator, hostKey, by, doorFile: file, now });
  try { require('./enroll.js').openDoor(code, { file }); } catch (e) {
    try { auth.burnInvite(store, r.ref); } catch { /* it lapses */ }
    throw e;
  }
  const line = `/sub-human join ${dest} ${code} ${r.pin}${via ? ` --via ${via}` : ''}`;
  return {
    ...r, short: true, locator, hostKey, line,
    text: shortText({
      code, how: `over ssh ${dest}${via ? ` via ${via}` : ''}`, line, ref: r.ref,
      extra: [`Their machine checks it reached this one (ssh host key ${sshkeys.fingerprint(hostKey)}) inside the PIN's handshake, and makes its own key; until you let it in, that key opens nothing (an authorized_keys line that only runs the PIN check is there while the invite is open).`],
    }),
  };
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
  throw new RoomError('INVALID', `nobody called "${target}" joined room ${store.code} from another machine`);
}

/** Burn one invite (a leaked one) by its ref; one reserved for or used by a link ends that link. */
function revokeInvite(code, store, ref, opts) {
  const { invite } = auth.findInvite(store, ref);
  if (invite.link) {
    const r = endLink(code, store, invite.link, opts);
    return { ...r, ref, text: `invite ${ref} ${invite.used_at ? 'was used already, by' : 'was reserved for'} link ${invite.link}; ${r.text}` };
  }
  const { state } = auth.burnInvite(store, ref);
  try { require('./enroll.js').sweepDoors(code); } catch { /* the tail sweeps it */ }
  if (state === 'burnt') roomLine(code, `the host cancelled an unused invite (ref ${ref}): it no longer lets anyone in`);
  const text = state === 'burnt'
    ? `cancelled invite ${ref} of room ${code}: it lets no one in; every other invite and connection stays`
    : `invite ${ref} of room ${code} was burnt already (a wrong PIN, expired, or cancelled); nothing changed`;
  return { id: null, ref, seats: [], keys: 0, text };
}

/** The open invites of the room: [{ref, expires_at}], oldest first. */
function openInvites(store, now = Date.now()) {
  return Object.entries(store.kv.get(auth.INVITES_KEY, null) || {})
    .filter(([, i]) => i && i.short && auth.shortLive(i, now))
    .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at))
    .map(([k, i]) => ({ ref: k.slice(0, 12), expires_at: i.expires_at }));
}

function cancelInvite(code, ref, { file = sshkeys.authorizedKeysFile(), now = Date.now() } = {}) {
  const store = hostStore(code);
  if (ref === undefined || ref === null || ref === '') {
    const open = openInvites(store, now);
    if (!open.length) return { refs: [], text: `room ${code} has no open invite` };
    if (open.length > 1) return { refs: open.map(o => o.ref), text: `room ${code} has ${open.length} open invites; cancel one: ${open.map(o => `/sub-human invite --cancel ${o.ref}`).join(', ')}` };
    ref = open[0].ref;
  }
  if (!/^[0-9a-f]{12}$/.test(String(ref)) || !auth.findInvite(store, ref)) throw new RoomError('INVALID', `room ${code} has no invite ${ref} (/sub-human invite --cancel lists the open ones)`);
  return revokeInvite(code, store, ref, { file });
}

/** End link id of the room: its token, its key lines, its seats, its serve processes; a room line. */
function endLink(code, store, id, { file = sshkeys.authorizedKeysFile() } = {}) {
  const r = auth.revokeLink(store, id) || { link: null, invites: 0 };
  const doors = new Set([path.resolve(file), ...auth.admissions(store, { all: true }).filter(a => a.link === id && a.door_file).map(a => path.resolve(a.door_file))]);
  let keys = 0;
  for (const f of doors) keys += sshkeys.removeAuthorized(f, code, id);
  try { require('./enroll.js').sweepDoors(code); } catch { /* the tail sweeps it */ }
  spawnSync('pkill', ['-f', '--', `--stdio ${code} --link ${id}`], { stdio: 'ignore' });
  const seats = r.link ? r.link.seats || [] : [];
  const seatsLib = require('../seats.js');
  for (const name of seats) { try { seatsLib.exit(code, name, 'removed by the host'); } catch { /* gone already */ } }
  const login = !!(r.link && r.link.login); // a link made over this account's own ssh login (no key line of its own)
  roomLine(code, `the host ended link ${id}${seats.length ? ` (${seats.join(', ')})` : ''}: its ${login ? 'token no longer reaches' : 'token and key no longer reach'} the room`);
  const text = `${seats.length ? `${seats.join(', ')} ${seats.length === 1 ? 'is' : 'are'} out of room ${code}` : `ended link ${id} of room ${code}`}: its connection no longer reaches the room`
    + (login ? `. It came over an ssh login to this account, which can join again: to shut that, take its key out of ${file}` : '');
  return { id, seats, keys, text };
}

function kick(code, name, opts = {}) {
  const store = hostStore(code);
  return endLink(code, store, linkIdOf(store, String(name).trim()), opts);
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

function joinText(code, name, o) {
  const lf = links().get(code) || {};
  if (o.state === 'linked') return `the host let you in to room ${code}: type /sub-human to take your seat as ${name}`;
  if (o.state === 'refused') return `could not join room ${code}: ${o.reason}`;
  if (lf.awaiting) {
    return `the host's machine checked your PIN. A card there now asks them to let you in as ${name} (${lf.awaiting.check}). `
      + `Once they do, type /sub-human to take your seat (the request waits ${minutes(require('../config.js').ADMIT_TTL_MS)} minutes)`;
  }
  const t = lf.transport || {};
  const cert = t.kind === 'wss' && /\.ts\.net$/i.test(String(t.host || '')) && !o.reason
    ? ' (Tailscale may be issuing a certificate: the first connection to a ts.net name can take ~20 s; it keeps trying)' : '';
  return `still connecting to room ${code}${o.reason ? ` (${o.reason})` : cert}; type /sub-human in a moment`;
}

/**
 * `/sub-human join DEST ROOM PIN` (or URL PIN): the link file for a short invite, before any attempt: the transport to
 * the host's door, the PIN (enroll, 0600, dropped once the host answered) and join_as, the seat's name. The daemon
 * runs the PAKE (lib/remote/enroll.js enrollLink).
 */
function joinShort({ code, transport, pin, name }) {
  links().set(code, { code, transport, enroll: { pin, name }, join_as: name, created_at: new Date().toISOString() });
  return { code };
}

module.exports = { hostInvite, cancelInvite, kick, linkTransport, joinInvite, joinShort, outcome, joinText, shimReady, shortText };
