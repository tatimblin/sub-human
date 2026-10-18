/**
 * plugin/sub-human/lib/remote/joining.ts: the joiner's side of `/sub-human join …` (lib/commands/join.ts parses it): the
 * link file, the link daemon's start and what the person reads next. An invite line only links this machine, in one
 * step the person types (the line with the PIN after it) or two (the line, then the PIN the host's machine asks for;
 * lib/remote/link-connect.ts dials, and sends a PIN only once the host's key is checked); the right PIN lets it in in
 * that hello (a line with no PIN knocks and waits for the host's card; a host before the knock asks for the PIN): no step ever takes the seat, so the seat's mechanics block never goes to the model with a secret-bearing prompt. Once let in, the hooks module takes it in a turn of its own (the tail's take, mod/deliver.ts takeSeat: letIn), else a bare /sub-human does. A join over the person's own ssh login (no invite) links and then takes the seat.
 *
 * A join over the person's own ssh login is said explicitly (no SECRET is no invite), and its refusal says that an
 * invite line ends with its SECRET. Either join, for a room this machine is linked to live another way, is refused
 * (`link CODE --forget` first); one that replaced a link that was down and was refused puts the old link file back.
 *
 * pendingNews: the invite join this session started, for the seatless session's tail (lib/tail.ts), which says each
 * state once: 'waiting' (dialing, or the card not answered), 'pin', 'linked' or 'refused'. text is '' when the
 * command's own answer said the same (join_told), so the person reads it once; 'linked' is the tail's take whatever
 * its text, with this machine's join check (checkOf) for the line that says the seat was taken. A stop from before the join's line
 * (the kicked link it replaced) is not its refusal.
 */
import * as identity from '../identity.ts';
import * as linkSocket from './link-socket.ts';
import * as linkConnect from './link-connect.ts';
import * as links from '../room/links.ts';
import * as hosting from './hosting.ts';
import { sleepSync, lazy } from '../io.ts';
import { cliLine } from '../text.ts';
import type { Link } from '../room/types.ts';
import type { LinkSpec, SshSpec } from './types-rest.ts';
import type { Outcome } from './hosting.ts';
import { msgOf } from '../errors.ts';
import { REVOKED } from '../reasons.ts';
import type { RoomCode, SeatName, InviteSecret, Pin } from '../brand.ts';
import type * as WsMod from './transports/ws.ts';
import type * as SshMod from './transports/ssh.ts';
import type * as SecretMod from './invite-secret.ts';
import type * as MachineKeyMod from './machine-key.ts';

// a transport only for the join that uses it (start cost)
const wsT = lazy<typeof WsMod>(import.meta.url, './transports/ws.ts');
const sshT = lazy<typeof SshMod>(import.meta.url, './transports/ssh.ts');
// the check, only once a join is let in (the tail's news)
const secretLib = lazy<typeof SecretMod>(import.meta.url, './invite-secret.ts');
const machineKeyLib = lazy<typeof MachineKeyMod>(import.meta.url, './machine-key.ts');

/** The seat a command asks to take: code null for the one open room, else a new one. isDefault: the name was not
 * typed (a taken one says how to pick another). pending: a join the host let in. */
export interface Wanted { name: SeatName; code: RoomCode | null; isDefault?: boolean; pending?: boolean }
/** What a join step ends in. */
export type JoinStep = { kind: 'take'; want: Wanted } | { kind: 'say'; text: string; refused: boolean };

const take = (want: Wanted): JoinStep => ({ kind: 'take', want });
const say = (text: string, refused = false): JoinStep => ({ kind: 'say', text, refused });
const refuse = (text: string): JoinStep => say(text, true);

export const NO_START = (code: RoomCode) => `the connection to room ${code} did not start. Run /sub-human doctor.`;
const SECRET_HINT = (dest: string, code: RoomCode) => `No invite, so this went over your own ssh login; if the host sent you an invite line, it ends with a long SECRET: /sub-human join ${dest} ${code} SECRET`;

/** A daemon still dialing the old host: stop it, so the start that follows dials the link file's new one. */
export function restartLink(code: RoomCode): void {
  const st = linkSocket.status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  // 1 s: with LINK_START_MS and LINK_JOIN_WAIT_MS this fits the hook's 10 s (hooks.json) with the node start to spare
  for (const until = Date.now() + 1000; Date.now() < until && identity.isAlive(st.pid);) sleepSync(20);
}

// the locator a link's transport came from
const locatorOf = (t: LinkSpec | null | undefined): string | null => (t && t.kind === 'ssh' ? linkConnect.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`) : t && t.kind === 'pipe' ? linkConnect.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

/** Where a link goes, for a person: "ssh you@host", the URL, or another sub-human folder here. */
const whereOf = (t: LinkSpec | null | undefined): string => (!t ? 'another way' : t.kind === 'ssh' ? `ssh ${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`
  : t.kind === 'pipe' ? 'another sub-human folder on this machine' : (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : 'another way');

/**
 * A join another way while this machine's link to code is live (a token, not spent, its daemon running and not
 * stopped): the refusal, or null. A join never tears down a live link (a mistyped host would cut the seated person
 * off); the person forgets the old link first, on purpose.
 */
function liveElsewhere(code: RoomCode, cur: Link | null, spent: boolean): JoinStep | null {
  if (!cur || !cur.token || spent) return null;
  const st = linkSocket.status(code);
  if (!st.running || st.state === 'stopped' || st.state === 'fork') return null;
  return refuse(`this machine is already linked to room ${code} through ${whereOf(cur.transport)}; a join another way would cut that link. To replace it, run \`${cliLine(`link ${code} --forget`)}\` in a terminal first (it stops that connection and ends this machine's seats there), then join again.`);
}

/** After a join another way was refused: the link file that worked before is put back (and its daemon started again),
 * so a failed connect never leaves a link this machine had pointing at a host that refused it. */
function putBack(code: RoomCode, cur: Link | null): void {
  if (!cur || !cur.token) return;
  try { restartLink(code); links.set(code, cur); linkSocket.start(code); } catch { /* doctor says what the link file holds */ }
}

const sameLogin = (a: LinkSpec | undefined, b: SshSpec) => !!a && !!b && a.kind === 'ssh' && a.login === true && (['user', 'host', 'port', 'remoteHome'] as const).every(k => a[k] === b[k]); // a login link is ssh

/** Where an invite join stands (hosting.joinText), as a step: a refusal when it was refused. tells: this session's tail
 * says what the host answers (the session that typed the line). */
function stands(code: RoomCode, name: SeatName, o: Outcome, tells = false): JoinStep {
  const text = hosting.joinText(code, name, o, { tells });
  told(code, text);
  return say(text, o.state === 'refused');
}

/** What the person was just told about this join (the command's own answer): the tail does not say it again. */
function told(code: RoomCode, text: string): void {
  try { const l = links.get(code); if (l) links.set(code, { ...l, join_told: text }); } catch { /* the tail may repeat it */ }
}

export function linkLine({ name, code, word, transport, sid, pin }: { name: SeatName; code: RoomCode; word: InviteSecret; transport: LinkSpec; sid?: string | null | undefined; pin?: Pin | undefined }): JoinStep {
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  // a link that stopped as spent (kicked: its token gets nowhere now) is replaced by the new line, never re-seated over
  const spent = !!cur && REVOKED.has(String((linkSocket.stopReason(linkSocket.status(code)) ?? {}).why || ''));
  if (cur && cur.token && !spent && locatorOf(cur.transport) === locatorOf(transport)) {
    return say(`this machine is in room ${code} already; /sub-human ${name} ${code} takes your place there.`);
  }
  const live = liveElsewhere(code, cur, spent);
  if (live) return live;
  if (cur) restartLink(code); // a pending join replaced, or a link that is down or stopped: dial with the new file
  try { hosting.joinLine({ code, transport, word, name, sid, pin }); } catch (e) { putBack(code, cur); return refuse(msgOf(e)); }
  const wrote = cur ? links.get(code) : null; // joinLine wrote it
  if (wrote) links.set(code, { ...wrote, rebind: true }); // a seat here joins again over the new link
  if (!linkSocket.start(code)) { putBack(code, cur); return refuse(NO_START(code)); }
  const o = hosting.outcome(code);
  if (o.state === 'refused') putBack(code, cur);
  return stands(code, name, o, !!sid);
}

/** The invite joins this machine started that take a PIN (the host asked for it, or a knock waits for the card: the
 * right PIN lets it in without the card), this session's first, newest first. */
export function pinJoin(sid?: string | null): PendingLink | null {
  const all = pendingJoins().filter(l => (!!l.pin_wanted || !!l.awaiting) && typeof l.invite === 'string');
  return all.find(l => !!sid && l.join_sid === sid) ?? all[0] ?? null;
}

export function givePin(pin: Pin, sid?: string | null): JoinStep {
  const l = pinJoin(sid);
  if (!l) {
    const any = pendingJoins().find(j => typeof j.invite === 'string' && !j.awaiting);
    return refuse(any ? `the host's machine has not asked for the PIN yet (room ${any.code}): wait a moment, then type it again` : 'no invite here is waiting for a PIN: type the invite line first (/sub-human join HOST ROOM SECRET), then the PIN when it asks');
  }
  const code = l.code, name = l.join_as;
  restartLink(code);
  try { hosting.givePin(code, pin); } catch (e) { return refuse(msgOf(e)); }
  if (!linkSocket.start(code)) return refuse(NO_START(code));
  return stands(code, name, hosting.outcome(code), l.join_sid === sid && !!sid);
}

export function linkLogin({ dest: typed, code, home, name, isDefault }: {
  dest: string; code: RoomCode; home: string | undefined; name: SeatName; isDefault: boolean;
}): JoinStep {
  const dest = sshT().withUser(typed);
  const spec = sshT().loginSpec(dest, { home });
  if (!spec) return refuse(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  const spent = (linkSocket.stopReason(linkSocket.status(code)) ?? {}).code === 'AUTH'; // kicked, or a host key changed: link anew
  if (cur && cur.token && sameLogin(cur.transport, spec) && !spent) return take({ name, code, isDefault }); // linked this way already: just the seat
  const live = liveElsewhere(code, cur, spent);
  if (live) return live;
  if (cur) restartLink(code); // a link replaced (one down, stopped or refused): dial with the new file
  try {
    links.set(code, { code, transport: spec, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
  } catch (e) { return refuse(msgOf(e)); }
  if (!linkSocket.start(code)) { putBack(code, cur); return refuse(NO_START(code)); }
  const o: Outcome = hosting.outcome(code);
  // no SECRET is no invite: the person's own ssh login is the way in, so a refusal says where an invite line differs
  if (o.state === 'refused') putBack(code, cur);
  if (o.state === 'refused') return refuse(`could not reach room ${code} over ${at}: ${o.reason}. ${SECRET_HINT(typed, code)}`);
  if (o.state !== 'linked') {
    return say(`still connecting to room ${code} over ${at}${o.reason ? ` (${o.reason})` : ''}: no SECRET, so no invite. Type /sub-human ${name} ${code} in a moment; if it doesn't come up, /sub-human doctor says why.`);
  }
  return take({ name, code, isDefault });
}

/** A pipe join (a second sub-human folder on this machine) has no login path: the invite line has a SECRET. */
export const noSecret = (dest: string, code: RoomCode): string => `that looks like an invite line without its SECRET: /sub-human join ${dest} ${code} SECRET (the long word the host sent with it).`;

/** A link this machine's invite join is waiting on: join_as names the seat it asked for. */
export type PendingLink = Link & { join_as: SeatName };

/** The invite joins this machine started, waiting to take their seat (join_as), newest first. */
function pendingJoins(): PendingLink[] {
  const all = links.list().map(c => links.get(c)).filter((l): l is PendingLink => !!l && identity.isSeatName(l.join_as) && !identity.isHost(l.code));
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export const pendingJoin = (): PendingLink | null => pendingJoins()[0] ?? null;

/** The join this session (sid) started for room code that the host let in (a token): the one the hooks module seats on
 * its own (lib/commands/join.ts letIn), else null. */
export const letIn = (code: RoomCode, sid: string | undefined): PendingLink | null =>
  (sid ? pendingJoins().find(l => l.code === code && l.join_sid === sid && !!l.token) ?? null : null);

/** The check this machine proved itself with (lib/remote/invite-secret.ts joinCheck: its machine id and, over the web,
 * the link's own key), as the host's card and room line show it; null when it cannot be read. */
function checkOf(l: Link): string | null {
  try {
    const t = l.transport;
    const key = t && (t.kind === 'wss' || t.kind === 'ws') && typeof t.clientKey === 'string' ? t.clientKey : null;
    return secretLib().joinCheck(machineKeyLib().idOf(machineKeyLib().publicKey()), key);
  } catch { return null; }
}

export function finishJoin(l: PendingLink): JoinStep {
  const code = l.code, name = l.join_as; // pendingJoin: a seat name
  const why = linkSocket.stopReason(linkSocket.status(code));
  if (l.pin_wanted && !l.token) return stands(code, name, { state: 'pin', ...(l.pin_wanted.message ? { reason: l.pin_wanted.message } : {}) });
  if (why && !l.token) {
    try { const { join_as: _gone, join_sid: _sid, join_told: _told, join_renamed: _renamed, ...rest } = links.get(code) ?? l; links.set(code, rest); } catch { /* no credential left: nothing to keep */ }
    return refuse(`could not join room ${code}: ${why.reason}`);
  }
  if (l.token) return take({ name, code, pending: true });
  if (!linkSocket.start(code)) return refuse(NO_START(code));
  const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
  if (o.state === 'linked') return take({ name, code, pending: true });
  return stands(code, name, o);
}

export function ensureLinked(code: RoomCode, name: SeatName): JoinStep | null {
  if (identity.isHost(code)) return null;
  const pending = links.get(code);
  // a link the host ended (kicked: lib/remote/link.ts dropped its token): no seat over it; a new invite line replaces it
  if (pending && !pending.token && pending.refused && typeof pending.invite !== 'string' && !(pending.transport && 'login' in pending.transport && pending.transport.login === true)) {
    return refuse(`could not join ${code}: ${pending.refused.reason}`);
  }
  if (pending && !pending.token && (pending.pin !== undefined || pending.pin_wanted || pending.awaiting || typeof pending.invite === 'string')) {
    // a join not let in yet: never started again after a refusal or while it waits for its PIN (a PIN is typed)
    if (pending.pin_wanted && pending.pin === undefined) return stands(code, name, { state: 'pin', ...(pending.pin_wanted.message ? { reason: pending.pin_wanted.message } : {}) });
    const why = linkSocket.stopReason(linkSocket.status(code));
    if (why) return refuse(`could not join ${code}: ${why.reason}`);
    if (!linkSocket.start(code)) return refuse(NO_START(code));
    const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
    if (o.state !== 'linked') return stands(code, name, o);
  }
  if (!linkSocket.start(code)) {
    const why = linkSocket.stopReason(linkSocket.status(code));
    return refuse(why ? `could not join ${code}: its connection stopped (${why.reason}). Run /sub-human doctor.` : NO_START(code));
  }
  return null;
}

export function dropJoinAs(code: RoomCode): void {
  try {
    const l = identity.isHost(code) ? null : links.get(code);
    if (l && (l.join_as !== undefined || l.join_sid !== undefined)) { const { join_as: _done, join_sid: _sid, join_told: _told, join_renamed: _renamed, ...rest } = l; links.set(code, rest); }
  } catch { /* a stale join_as only names the seat again */ }
}

/** What a seatless session's tail says about the invite join it started (see the header); waiting: nothing yet.
 * linked also carries line, its text even when told (what the person reads when the module cannot take the seat), and
 * check, this machine's (checkOf). */
export interface News { code: RoomCode; name: string; state: 'waiting' | 'pin' | 'linked' | 'refused'; text: string; line?: string; check?: string }

export function pendingNews(sid: string | null | undefined): News | null {
  if (!sid) return null;
  const l = pendingJoins().find(j => j.join_sid === sid);
  if (!l) return null;
  const code = l.code, name = l.join_as;
  // the command's own answer said it already (join_told): nothing new for the tail to say
  const fresh = (n: News): News => (n.text && n.text.replace(/^✗ /, '') === l.join_told ? { ...n, text: '' } : n);
  if (l.pin_wanted && !l.token && l.pin === undefined) {
    return fresh({ code, name, state: 'pin', text: hosting.joinText(code, name, { state: 'pin', ...(l.pin_wanted.message ? { reason: l.pin_wanted.message } : {}) }) });
  }
  const st = linkSocket.status(code);
  // a stop from before this join's line (the link it replaced: a kick's) is no answer to it: the new daemon has not
  // written its own state yet
  const old = !!st.since && typeof l.created_at === 'string' && Date.parse(st.since) < Date.parse(l.created_at);
  const stopped = old ? null : linkSocket.stopReason(st);
  if (stopped && !l.token) return fresh({ code, name, state: 'refused', text: `✗ could not join room ${code}: ${stopped.reason}` });
  if (l.token && st.state === 'online') {
    const line = hosting.joinText(code, name, { state: 'linked' });
    const check = checkOf(l);
    return { ...fresh({ code, name, state: 'linked', text: line }), line, ...(check ? { check } : {}) };
  }
  return { code, name, state: 'waiting', text: '' };
}
