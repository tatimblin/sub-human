/**
 * plugin/sub-human/lib/remote/joining.ts: the joiner's side of `/sub-human join …` (lib/commands/join.ts parses it): the
 * link file, the link daemon's start and what the person reads next. An invite line only links this machine, in two
 * steps the person types (the line, then the PIN the host's machine asks for; lib/remote/link-connect.ts dials), and the
 * host's card lets it in: neither step ever takes the seat, so the seat's mechanics block never goes to the model with a
 * secret-bearing prompt. A join over the person's own ssh login (no invite) links and then takes the seat.
 *
 *   Step = {kind: 'take', want: Wanted} | {kind: 'say', text, refused}   what a join step ends in: a seat to take
 *       (lib/seats.ts take), or a line for the person (a refusal, or where the join stands)
 *   linkLine({name, code, word, transport, sid?}) -> Step   an invite line: link only (hosting.joinLine), the daemon
 *       started, its hellos watched for LINK_JOIN_WAIT_MS: the host asks for the PIN (say so), or a refusal; sid: the
 *       session that typed it (join_sid), whose tail tells the person what the host answered (pendingNews)
 *   givePin(pin, sid?) -> Step         the PIN, for the join waiting for one (this session's, else the newest): into
 *       its link file (hosting.givePin), the daemon started again, watched: the card asks (awaiting), a wrong or
 *       too-soon PIN (asked again), or a refusal (the last try)
 *   linkLogin({dest, code, via, home, name, isDefault}) -> Step   `/sub-human join HOST ROOM` over the person's own ssh
 *       login: the link file, the daemon, then the seat once linked. Said explicitly (no SECRET is no invite), and a
 *       refused login says that an invite line ends with its SECRET. Either join, for a room this machine is linked
 *       to live another way, is refused (`link CODE --forget` first); one that replaced a link that was down and
 *       was refused puts the old link file back
 *   pendingJoin() -> Link | null       the newest invite join this machine started, waiting to take its seat
 *   pinJoin(sid?) -> Link | null       the invite join waiting for its PIN (this session's first, else the newest)
 *   finishJoin(link) -> Step           bare `/sub-human` with a pending join: the seat once the link is up
 *   ensureLinked(code, name) -> Step | null   before a seat in a room hosted elsewhere: a join not let in yet is not
 *       started again after a refusal, a stopped link says why; null when the link runs
 *   dropJoinAs(code)                   the seat a pending join waited for is taken: its link file no longer says so
 *   restartLink(code)                  a daemon still dialing the old host is stopped (1 s at most)
 *   pendingNews(sid) -> {code, name, state, text} | null   the invite join this session started: 'waiting' (dialing,
 *       or the host's card has not answered), 'pin' (the host asks for the PIN: text says to type it), 'linked' (the
 *       host let this machine in: text says to type /sub-human) or 'refused' (text: its reason); null when there is
 *       none. The seatless session's tail (lib/tail.ts) says each once; text '' when the command's own answer said
 *       the same (join_told, written by the join step), so the person reads it once. A stop from before the join's
 *       line (the kicked link it replaced) is not its refusal
 *   noSecret(dest, code) -> string     a pipe join without its SECRET: the line the host sent has one
 */
import * as identity from '../identity.ts';
import * as linkSocket from './link-socket.ts';
import * as linkConnect from './link-connect.ts';
import * as links from '../room/links.ts';
import * as hosting from './hosting.ts';
import { sleepSync } from '../io.ts';
import { cliLine } from '../text.ts';
import { createRequire } from 'node:module';
import type { Link } from '../room/types.ts';
import type { LinkSpec, SshSpec } from './types-rest.ts';
import type { Outcome } from './hosting.ts';
import { msgOf } from '../errors.ts';
import type { RoomCode } from '../brand.ts';

const require = createRequire(import.meta.url);
const wsT = (): typeof import('./transports/ws.ts') => require('./transports/ws.ts');
const sshT = (): typeof import('./transports/ssh.ts') => require('./transports/ssh.ts');

/** The seat a command asks to take: code null for the one open room, else a new one. isDefault: the name was not
 * typed (a taken one says how to pick another). pending: a join the host let in. */
export interface Wanted { name: string; code: RoomCode | null; isDefault?: boolean; pending?: boolean }
/** What a join step ends in. */
export type Step = { kind: 'take'; want: Wanted } | { kind: 'say'; text: string; refused: boolean };

/** A stopped link whose token never gets in again (lib/remote/link.ts drops it): a new invite line replaces it. */
const SPENT_REASONS: ReadonlySet<string> = new Set(['LINK_REVOKED', 'TOKEN_UNKNOWN', 'KEY_REVOKED']);
const take = (want: Wanted): Step => ({ kind: 'take', want });
const say = (text: string, refused = false): Step => ({ kind: 'say', text, refused });
const refuse = (text: string): Step => say(text, true);

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

// the locator a link's transport came from (with its jump hosts: else every re-join over a bastion reads as a move)
const locatorOf = (t: LinkSpec | null | undefined): string | null => (t && t.kind === 'ssh' ? linkConnect.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`, t.via ? { via: t.via } : {}) : t && t.kind === 'pipe' ? linkConnect.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

/** Where a link goes, for a person: "ssh you@host", the URL, or another sub-human folder here. */
const whereOf = (t: LinkSpec | null | undefined): string => (!t ? 'another way' : t.kind === 'ssh' ? `ssh ${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}${t.via ? ` via ${t.via}` : ''}`
  : t.kind === 'pipe' ? 'another sub-human folder on this machine' : (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : 'another way');

/**
 * A join another way while this machine's link to code is live (a token, not spent, its daemon running and not
 * stopped): the refusal, or null. A join never tears down a live link (stage 8e C: a mistyped host cut the seated
 * person off and rewrote the link file); the person forgets the old link first, on purpose.
 */
function liveElsewhere(code: RoomCode, cur: Link | null, spent: boolean): Step | null {
  if (!cur || !cur.token || spent) return null;
  const st = linkSocket.status(code);
  if (!st.running || st.state === 'stopped' || st.state === 'fork') return null;
  return refuse(`this machine is already linked to room ${code} through ${whereOf(cur.transport)}; a join another way would cut that link. To replace it, run \`${cliLine(`link ${code} --forget`)}\` in a terminal first (it stops that connection and ends this machine's seats there), then join again.`);
}

/** After a join another way was refused: the link file that worked before is put back (and its daemon started again),
 * so a failed connect never leaves a link this machine had pointing at a host that refused it (stage 8e C). */
function putBack(code: RoomCode, cur: Link | null): void {
  if (!cur || !cur.token) return;
  try { restartLink(code); links.set(code, cur); linkSocket.start(code); } catch { /* doctor says what the link file holds */ }
}

const sameLogin = (a: LinkSpec | undefined, b: SshSpec) => !!a && !!b && a.kind === 'ssh' && a.login === true && (['user', 'host', 'port', 'via', 'remoteHome'] as const).every(k => a[k] === b[k]); // a login link is ssh

/** Where an invite join stands (hosting.joinText), as a step: a refusal when it was refused. tells: this session's tail
 * says what the host answers (the session that typed the line). */
function stands(code: RoomCode, name: string, o: Outcome, tells = false): Step {
  const text = hosting.joinText(code, name, o, { tells });
  told(code, text);
  return say(text, o.state === 'refused');
}

/** What the person was just told about this join (the command's own answer): the tail does not say it again. */
function told(code: RoomCode, text: string): void {
  try { const l = links.get(code); if (l) links.set(code, { ...l, join_told: text }); } catch { /* the tail may repeat it */ }
}

export function linkLine({ name, code, word, transport, sid }: { name: string; code: RoomCode; word: string; transport: LinkSpec; sid?: string | null }): Step {
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  // a link that stopped as spent (kicked: its token gets nowhere now) is replaced by the new line, never re-seated over
  const spent = !!cur && SPENT_REASONS.has(String((linkSocket.stopReason(linkSocket.status(code)) || {}).why || ''));
  if (cur && cur.token && !spent && locatorOf(cur.transport) === locatorOf(transport)) {
    return say(`this machine is in room ${code} already; /sub-human ${name} ${code} takes your place there.`);
  }
  const live = liveElsewhere(code, cur, spent);
  if (live) return live;
  if (cur) restartLink(code); // a pending join replaced, or a link that is down or stopped: dial with the new file
  try { hosting.joinLine({ code, transport, word, name, sid }); } catch (e) { putBack(code, cur); return refuse(msgOf(e)); }
  if (cur) links.set(code, { ...links.get(code)!, rebind: true }); // a seat here joins again over the new link (joinLine wrote it)
  if (!linkSocket.start(code)) { putBack(code, cur); return refuse(NO_START(code)); }
  const o = hosting.outcome(code);
  if (o.state === 'refused') putBack(code, cur);
  return stands(code, name, o, !!sid);
}

/** The invite joins this machine started that wait for their PIN (the host asked), this session's first, newest first. */
export function pinJoin(sid?: string | null): Link | null {
  const all = pendingJoins().filter(l => !!l.pin_wanted && typeof l.invite === 'string');
  return all.find(l => !!sid && l.join_sid === sid) || all[0] || null;
}

export function givePin(pin: string, sid?: string | null): Step {
  const l = pinJoin(sid);
  if (!l) {
    const any = pendingJoins().find(j => typeof j.invite === 'string' && !j.awaiting);
    return refuse(any ? `the host's machine has not asked for the PIN yet (room ${any.code}): wait a moment, then type it again` : 'no invite here is waiting for a PIN: type the invite line first (/sub-human join HOST ROOM SECRET), then the PIN when it asks');
  }
  const code = l.code, name = String(l.join_as);
  restartLink(code);
  try { hosting.givePin(code, pin); } catch (e) { return refuse(msgOf(e)); }
  if (!linkSocket.start(code)) return refuse(NO_START(code));
  return stands(code, name, hosting.outcome(code), l.join_sid === sid && !!sid);
}

export function linkLogin({ dest: typed, code, via, home, name, isDefault }: {
  dest: string; code: RoomCode; via: string | undefined; home: string | undefined; name: string; isDefault: boolean;
}): Step {
  const dest = sshT().withUser(typed);
  const spec = sshT().loginSpec(dest, { via, home });
  if (!spec) return refuse(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  const spent = (linkSocket.stopReason(linkSocket.status(code)) || {}).code === 'AUTH'; // kicked, or a host key changed: link anew
  if (cur && cur.token && sameLogin(cur.transport, spec) && !spent) return take({ name, code, isDefault }); // linked this way already: just the seat
  const live = liveElsewhere(code, cur, spent);
  if (live) return live;
  if (cur) restartLink(code); // a link replaced (one down, stopped or refused): dial with the new file
  const mux = cur && cur.transport && cur.transport.kind === 'ssh' && cur.transport.mux === true && cur.transport.user === spec.user && cur.transport.host === spec.host && cur.transport.port === spec.port;
  try {
    links.set(code, { code, transport: { ...spec, ...(mux ? { mux: true } : {}) }, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
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
export const noSecret = (dest: string, code: RoomCode): string => `that looks like an invite line without its SECRET: /sub-human join ${dest} ${code} SECRET (the long word the host sent with it). If the host's line ended with a 4-digit PIN instead, it comes from an older sub-human on the host: ask them to update (/plugin update sub-human) and invite you again.`;

/** The invite joins this machine started, waiting to take their seat (join_as), newest first. */
function pendingJoins(): Link[] {
  const all = links.list().map(c => links.get(c)).filter((l): l is Link => !!l && typeof l.join_as === 'string' && !identity.isHost(l.code));
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export const pendingJoin = (): Link | null => pendingJoins()[0] || null;

export function finishJoin(l: Link): Step {
  const code = l.code, name = String(l.join_as); // pendingJoin: a string
  const why = linkSocket.stopReason(linkSocket.status(code));
  if (l.pin_wanted && !l.token) return stands(code, name, { state: 'pin', ...(l.pin_wanted.message ? { reason: l.pin_wanted.message } : {}) });
  if (why && !l.token) {
    try { const { join_as: _gone, join_sid: _sid, join_told: _told, join_renamed: _renamed, ...rest } = links.get(code) || l; links.set(code, rest); } catch { /* no credential left: nothing to keep */ }
    return refuse(`could not join room ${code}: ${why.reason}`);
  }
  if (l.token) return take({ name, code, pending: true });
  if (!linkSocket.start(code)) return refuse(NO_START(code));
  const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
  if (o.state === 'linked') return take({ name, code, pending: true });
  return stands(code, name, o);
}

export function ensureLinked(code: RoomCode, name: string): Step | null {
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

/** What a seatless session's tail says about the invite join it started (see the header); waiting: nothing yet. */
export interface News { code: RoomCode; name: string; state: 'waiting' | 'pin' | 'linked' | 'refused'; text: string }

export function pendingNews(sid: string | null | undefined): News | null {
  if (!sid) return null;
  const l = pendingJoins().find(j => j.join_sid === sid);
  if (!l) return null;
  const code = l.code, name = String(l.join_as);
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
  if (l.token && st.state === 'online') return fresh({ code, name, state: 'linked', text: hosting.joinText(code, name, { state: 'linked' }) });
  return { code, name, state: 'waiting', text: '' };
}
