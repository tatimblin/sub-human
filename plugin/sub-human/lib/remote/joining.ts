/**
 * plugin/sub-human/lib/remote/joining.ts: the joiner's side of `/sub-human join …` (lib/commands/join.ts parses it): the
 * link file, the link daemon's start and what the person reads next. A join with a PIN only links this machine (the
 * PAKE runs in the link daemon, lib/remote/enroll.ts; the host's card lets it in): it never takes the seat in that
 * step, so the seat's mechanics block never goes to the model with a PIN-bearing prompt. A join over the person's own
 * ssh login (no PIN) links and then takes the seat.
 *
 *   Step = {kind: 'take', want: Wanted} | {kind: 'say', text, refused}   what a join step ends in: a seat to take
 *       (lib/seats.ts take), or a line for the person (a refusal, or where the join stands)
 *   linkShort({name, code, pin, transport, sid?}) -> Step   an invite's PIN: link only (hosting.joinShort), the daemon
 *       started, the first hello watched for LINK_JOIN_WAIT_MS; sid: the session that typed it (join_sid), whose tail
 *       tells the person when the host's card let them in (pendingNews)
 *   linkLogin({dest, code, via, home, name, isDefault}) -> Step   `/sub-human join HOST ROOM` over the person's own ssh
 *       login: the link file, the daemon, then the seat once linked. Said explicitly (no PIN is no invite), and a
 *       refused login says that an invite line ends with its PIN
 *   pendingJoin() -> Link | null       the newest join this machine started with a PIN, waiting to take its seat
 *   finishJoin(link) -> Step           bare `/sub-human` with a pending join: the seat once the link is up
 *   ensureLinked(code, name) -> Step | null   before a seat in a room hosted elsewhere: a join not let in yet is not
 *       started again after a refusal, a stopped link says why; null when the link runs
 *   dropJoinAs(code)                   the seat a pending join waited for is taken: its link file no longer says so
 *   restartLink(code)                  a daemon still dialing the old host is stopped (1 s at most)
 *   pendingNews(sid) -> {code, name, state, text} | null   the join this session started with a PIN: 'waiting' (the
 *       host's card has not answered), 'linked' (the host let this machine in: text says to type /sub-human) or
 *       'refused' (text: its reason); null when there is none. The seatless session's tail (lib/tail.ts) says it once
 *   noPin(dest, code) -> string        a pipe join without its PIN: the line the host sent has one
 */
import * as identity from '../identity.ts';
import * as link from './link.ts';
import * as links from '../room/links.ts';
import * as hosting from './hosting.ts';
import { sleepSync } from '../io.ts';
import { createRequire } from 'node:module';
import type { Link } from '../room/types.ts';
import type { LinkSpec, SshSpec } from './types-rest.ts';
import type { Outcome } from './hosting.ts';

const require = createRequire(import.meta.url);
const wsT = (): typeof import('./transports/ws.ts') => require('./transports/ws.ts');
const sshT = (): typeof import('./transports/ssh.ts') => require('./transports/ssh.ts');

/** The seat a command asks to take: code null for the one open room, else a new one. isDefault: the name was not
 * typed (a taken one says how to pick another). pending: a join the host let in. */
export interface Wanted { name: string; code: string | null; isDefault?: boolean; pending?: boolean }
/** What a join step ends in. */
export type Step = { kind: 'take'; want: Wanted } | { kind: 'say'; text: string; refused: boolean };

const take = (want: Wanted): Step => ({ kind: 'take', want });
const say = (text: string, refused = false): Step => ({ kind: 'say', text, refused });
const refuse = (text: string): Step => say(text, true);
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const NO_START = (code: string) => `the connection to room ${code} did not start. Run /sub-human doctor.`;
const PIN_HINT = (dest: string, code: string) => `If the host sent you an invite, its line ends with a 4-digit PIN: /sub-human join ${dest} ${code} PIN`;

/** A daemon still dialing the old host: stop it, so the start that follows dials the link file's new one. */
export function restartLink(code: string): void {
  const st = link.status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  // 1 s: with LINK_START_MS and LINK_JOIN_WAIT_MS this fits the hook's 10 s (hooks.json) with the node start to spare
  for (const until = Date.now() + 1000; Date.now() < until && identity.isAlive(st.pid);) sleepSync(20);
}

// the locator a link's transport came from (with its jump hosts: else every re-join over a bastion reads as a move)
const locatorOf = (t: LinkSpec | null | undefined): string | null => (t && t.kind === 'ssh' ? link.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`, t.via ? { via: t.via } : {}) : t && t.kind === 'pipe' ? link.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

const sameLogin = (a: LinkSpec | undefined, b: SshSpec) => !!a && !!b && a.kind === 'ssh' && a.login === true && (['user', 'host', 'port', 'via', 'remoteHome'] as const).every(k => a[k] === b[k]); // a login link is ssh

/** Where a join started with a PIN stands (hosting.joinText), as a step: a refusal when it was refused. tells: this
 * session's tail says when the host lets it in (the session that typed the PIN). */
function stands(code: string, name: string, o: Outcome, tells = false): Step {
  return say(hosting.joinText(code, name, o, { tells }), o.state === 'refused');
}

export function linkShort({ name, code, pin, transport, sid }: { name: string; code: string; pin: string; transport: LinkSpec; sid?: string | null }): Step {
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  if (cur && cur.token && locatorOf(cur.transport) === locatorOf(transport)) {
    return say(`this machine is in room ${code} already; /sub-human ${name} ${code} takes your place there.`);
  }
  if (cur) restartLink(code); // a pending join replaced, or the room's host moved: dial with the new file
  try { hosting.joinShort({ code, transport, pin, name, sid }); } catch (e) { return refuse(msgOf(e)); }
  if (cur) links.set(code, { ...links.get(code)!, rebind: true }); // a seat here joins again over the new link (joinShort wrote it)
  if (!link.start(code)) return refuse(NO_START(code));
  return stands(code, name, hosting.outcome(code), !!sid);
}

export function linkLogin({ dest: typed, code, via, home, name, isDefault }: {
  dest: string; code: string; via: string | undefined; home: string | undefined; name: string; isDefault: boolean;
}): Step {
  const dest = sshT().withUser(typed);
  const spec = sshT().loginSpec(dest, { via, home });
  if (!spec) return refuse(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
  if (identity.roomExists(code) && identity.isHost(code)) return refuse(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  const spent = (link.stopReason(link.status(code)) || {}).code === 'AUTH'; // kicked, or a host key changed: link anew
  if (cur && cur.token && sameLogin(cur.transport, spec) && !spent) return take({ name, code, isDefault }); // linked this way already: just the seat
  if (cur) restartLink(code); // a link replaced (another way in, or a refused one): dial with the new file
  const mux = cur && cur.transport && cur.transport.kind === 'ssh' && cur.transport.mux === true && cur.transport.user === spec.user && cur.transport.host === spec.host && cur.transport.port === spec.port;
  try {
    links.set(code, { code, transport: { ...spec, ...(mux ? { mux: true } : {}) }, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
  } catch (e) { return refuse(msgOf(e)); }
  if (!link.start(code)) return refuse(NO_START(code));
  const o: Outcome = hosting.outcome(code);
  // no PIN is no invite: the person's own ssh login is the way in, so a refusal says where an invite line differs
  if (o.state === 'refused') return refuse(`could not join room ${code} over your own ssh login (no PIN, so no invite): ${at}: ${o.reason}. ${PIN_HINT(typed, code)}`);
  if (o.state !== 'linked') {
    return say(`joining room ${code} over your own ssh login (no PIN, so no invite): still connecting over ${at}${o.reason ? ` (${o.reason})` : ''}. Type /sub-human ${name} ${code} in a moment; if it doesn't come up, /sub-human doctor says why. ${PIN_HINT(typed, code)}`);
  }
  return take({ name, code, isDefault });
}

/** A pipe join (a second sub-human folder on this machine) has no login path: the invite line has a PIN. */
export const noPin = (dest: string, code: string): string => `that looks like an invite line without its PIN: /sub-human join ${dest} ${code} PIN (the 4 digits the host sent with it).`;

/** The joins this machine started with a PIN, waiting to take their seat (join_as), newest first. */
function pendingJoins(): Link[] {
  const all = links.list().map(c => links.get(c)).filter((l): l is Link => !!l && typeof l.join_as === 'string' && !identity.isHost(l.code));
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export const pendingJoin = (): Link | null => pendingJoins()[0] || null;

export function finishJoin(l: Link): Step {
  const code = l.code, name = String(l.join_as); // pendingJoin: a string
  const why = link.stopReason(link.status(code));
  if (why && !l.token) {
    try { const { join_as: _gone, join_sid: _sid, ...rest } = links.get(code) || l; links.set(code, rest); } catch { /* no credential left: nothing to keep */ }
    return refuse(`could not join room ${code}: ${why.reason}`);
  }
  if (l.token) return take({ name, code, pending: true });
  if (!link.start(code)) return refuse(NO_START(code));
  const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
  if (o.state === 'linked') return take({ name, code, pending: true });
  return stands(code, name, o);
}

export function ensureLinked(code: string, name: string): Step | null {
  if (identity.isHost(code)) return null;
  const pending = links.get(code);
  if (pending && !pending.token && (pending.pin !== undefined || pending.enroll || pending.awaiting)) {
    // a join not let in yet: never start it again after a refusal (that would spend another try)
    const why = link.stopReason(link.status(code));
    if (why) return refuse(`could not join ${code}: ${why.reason}`);
    if (!link.start(code)) return refuse(NO_START(code));
    const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
    if (o.state !== 'linked') return stands(code, name, o);
  }
  if (!link.start(code)) {
    const why = link.stopReason(link.status(code));
    return refuse(why ? `could not join ${code}: its connection stopped (${why.reason}). Run /sub-human doctor.` : NO_START(code));
  }
  return null;
}

export function dropJoinAs(code: string): void {
  try {
    const l = identity.isHost(code) ? null : links.get(code);
    if (l && (l.join_as !== undefined || l.join_sid !== undefined)) { const { join_as: _done, join_sid: _sid, ...rest } = l; links.set(code, rest); }
  } catch { /* a stale join_as only names the seat again */ }
}

/** What a seatless session's tail says about the join it started with a PIN (see the header); waiting: nothing yet. */
export interface News { code: string; name: string; state: 'waiting' | 'linked' | 'refused'; text: string }

export function pendingNews(sid: string | null | undefined): News | null {
  if (!sid) return null;
  const l = pendingJoins().find(j => j.join_sid === sid);
  if (!l) return null;
  const code = l.code, name = String(l.join_as);
  const st = link.status(code);
  const stopped = link.stopReason(st);
  if (stopped && !l.token) return { code, name, state: 'refused', text: `could not join room ${code}: ${stopped.reason}` };
  if (l.token && st.state === 'online') return { code, name, state: 'linked', text: hosting.joinText(code, name, { state: 'linked' }) };
  return { code, name, state: 'waiting', text: '' };
}
