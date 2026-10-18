/**
 * plugin/sub-human/lib/commands/join.ts: the verbs that take a seat. The name: NAME, else --as NAME, else
 * identity.defaultName (git user.name, the local part of user.email, $USER; a taken default name is refused with the
 * hint to pick one). The seat itself is lib/seats.ts take; the link steps lib/remote/joining.ts.
 *
 *   bare      `/sub-human`: in a room, a short status (its link started if it stopped, the room's Claude started
 *             again if it failed or ended: seats.ensureRoomClaude), or the seat joined again over a re-pointed link;
 *             not in a room, the seat the session this one was forked from holds (← the agent view moved the
 *             conversation: identity.forkParent; restored, as session-restore does), else finish a join the host has
 *             let in (a link file's join_as), else join the one open room, or open one, as the default name. Never a
 *             new room while the default name's seat is live in another session of this folder (seats.liveSeatHere):
 *             that is refused with where the seat is. From the hooks module with a room (ctx.take: it seats a join the
 *             host let in on its own, mod/deliver.ts takeSeat): only that join's seat (letIn), else nothing
 *   named     `/sub-human NAME [ROOM]` (or `--as NAME`): join ROOM (else the one open room, else a new one) as NAME, leaving any other
 *             room; `/sub-human ROOM` (a room code alone): that room as the default name, never a person named after it.
 *             A word of digits is no name (it looks like a PIN)
 *   join      `/sub-human join …`: ROOM (a room code alone): that room on this machine, as `/sub-human ROOM`;
 *             HOST ROOM SECRET, URL#SECRET or URL SECRET, each with the PIN after it or not: an invite line
 *             (joining.linkLine: link only, never the seat in that step; a PIN typed with it goes in the first hello,
 *             once the host's key is checked; over ssh through the person's own ssh login, --home as the line says);
 *             PIN (4 digits alone): the PIN the host's machine asked for (joining.givePin; never the seat either); HOST ROOM: over
 *             the person's own ssh login (joining.linkLogin; the seat once linked); a pipe HOST with no SECRET is an
 *             invite line without its SECRET
 *   bindRoomClaude   the room Claude's own launch `/sub-human` (agent_type sub-human:room-claude + SUB_HUMAN_ROOM), or a
 *             debugging `/sub-human [ROOM]` in a room-claude agent session: binds the seat `claude`
 */
import * as identity from '../identity.ts';
import * as seats from '../seats.ts';
import * as linkSocket from '../remote/link-socket.ts';
import * as linkConnect from '../remote/link-connect.ts';
import * as links from '../room/links.ts';
import * as invites from '../remote/invites.ts';
import * as inviteSecret from '../remote/invite-secret.ts';
import * as joining from '../remote/joining.ts';
import { parse } from '../cli/args.ts';
import { SECRET_WORD, fragmentSecret } from '../../mod/core/command.ts';
import fs from 'node:fs';
import { projectDir } from '../cc/env.ts';
import { envStr } from '../env.ts';
import { HELP_HINT, USAGE, refused, say } from './answer.ts';
import type { Answer, VerbCtx, Verb } from './types.ts';
import type { Identity } from '../identity.ts';
import type { JoinStep, Wanted } from '../remote/joining.ts';
import type { RoomCode, SeatName, InviteSecret, Pin } from '../brand.ts';
import type * as WsMod from '../remote/transports/ws.ts';
import type * as SshMod from '../remote/transports/ssh.ts';
import { lazy } from '../io.ts';

// a transport only for a join by invite (start cost: /sub-human loads this file)
const wsT = lazy<typeof WsMod>(import.meta.url, '../remote/transports/ws.ts');
const sshT = lazy<typeof SshMod>(import.meta.url, '../remote/transports/ssh.ts');

export const JOIN_USAGE: string = `usage: /sub-human join LINE PIN (the line from an invite, the PIN the host told you after it; or the line alone, then /sub-human join PIN when it asks). ${HELP_HINT}`;
const NOT_WHOLE = 'the line\'s SECRET (its last long word) did not come through whole: paste the whole line the host sent you';
const PIN_WORD = /^[0-9]{3,10}$/;
const YOU_HINT = (d: string) => `"${d}" still has the example's placeholder: put your user name on that machine in place of ${d.split('@')[0]} (or just its ssh alias, e.g. dev)`;
const NOT_A_NAME = (n: string) => (PIN_WORD.test(n) ? `"${n}" looks like a PIN, not a name: a PIN goes in as /sub-human join PIN once an invite line asks for it`
  : `"${n}" isn't a name (letters, digits, . _ -, up to 32)`);

/** The seat: lib/seats.ts take, as an answer. */
function seat(want: Wanted, ctx: VerbCtx): Answer {
  const t = seats.take(want, { pid: ctx.pid, session_id: ctx.sid, cwd: ctx.cwd, cur: ctx.cur, pubkey: ctx.pubkey });
  if (!t.ok) return t.refused ? refused(t.text) : say(t.text);
  return { kind: 'joined', me: t.me, lead: t.lead, say: t.msg };
}

/** A link step's end: the seat to take, or what the person reads. */
const then = (step: JoinStep, ctx: VerbCtx): Answer => (step.kind === 'take' ? seat(step.want, ctx) : step.refused ? refused(step.text) : say(step.text));

/** A name typed with --as: checked; else the default name. */
function nameFor(as: string | undefined, cwd: string): { name: SeatName } | { error: string } {
  if (as !== undefined) {
    if (!identity.isSeatName(as) || PIN_WORD.test(as)) return { error: NOT_A_NAME(as) };
    if (identity.RESERVED.includes(as.toLowerCase())) return { error: `"${as}" is reserved; pick another name` };
    return { name: as };
  }
  const name = identity.defaultName({ cwd });
  return name ? { name } : { error: 'no name to join as (no git user.name or $USER): add --as NAME' };
}

/** Bare `/sub-human` in a room: who is here, and how to bring someone in (see the header). */
function status(cur: Identity, cwd: string): Answer {
  const host = identity.isHost(cur.code);
  if (!host) { try { linkSocket.start(cur.code); } catch { /* the doctor says why */ } } // its connection, if it stopped running
  return say(`you're ${cur.name} in room ${cur.code}, ${seats.withWhom(cur.code, cur.name)} · `
    + `${host ? 'another machine: /sub-human invite · ' : ''}leave: /sub-human leave${seats.ensureRoomClaude(cur.code, cwd, cur.name)}`);
}

/** The seat this session's conversation came from (← the agent view forked it), moved here; null when none. */
function forked(ctx: VerbCtx): Answer | null {
  let real = ctx.cwd;
  try { real = fs.realpathSync(ctx.cwd); } catch { /* as given */ }
  const from = ctx.sid ? identity.forkParent(ctx.sid, projectDir(real)) ?? (real !== ctx.cwd ? identity.forkParent(ctx.sid, projectDir(ctx.cwd)) : null) : null;
  if (!from || !ctx.sid) return null;
  if (!identity.isHost(from.code)) { try { linkSocket.start(from.code); } catch { /* the join below says why */ } }
  const r = identity.adoptFork(from, { pid: ctx.pid, session_id: ctx.sid, cwd: ctx.cwd });
  if (!r.ok) return refused(`could not take back ${from.name}'s seat in ${from.code}: ${r.error || 'unknown error'}`);
  const me: Identity = { code: from.code, name: from.name, role: from.role, pid: ctx.pid, session_id: ctx.sid, address: identity.address(from.name, from.code) };
  return { kind: 'joined', me, lead: 'restored after the agent view', say: `you're ${from.name} in room ${from.code} again (this session went on from the one that held the seat), ${seats.withWhom(from.code, from.name)}` };
}

/** The hooks module seating the join the host let in to room code (ctx.take): that join's seat, else nothing (say '':
 * the person took it first, or it is not this session's), never a status, another room or a new one. */
function letIn(code: RoomCode, ctx: VerbCtx): Answer {
  const l = ctx.cur ? null : joining.letIn(code, ctx.sid);
  return l ? then(joining.finishJoin(l), ctx) : say('');
}

export const bare: Verb = (_args, ctx) => {
  if (ctx.take) return letIn(ctx.take, ctx);
  const { cur, cwd } = ctx;
  if (cur) {
    const l = identity.isHost(cur.code) ? null : links.get(cur.code);
    return l && l.rebind ? seat({ name: cur.name, code: cur.code }, ctx) : status(cur, cwd);
  }
  const back = forked(ctx);
  if (back) return back;
  const pending = joining.pendingJoin();
  if (pending) return then(joining.finishJoin(pending), ctx);
  const name = identity.defaultName({ cwd });
  if (!name) return refused('no name to join as (no git user.name or $USER): /sub-human NAME');
  const here = seats.liveSeatHere(cwd, name);
  if (here) return refused(`you're already ${name} in room ${here} from another session in this folder, which is still running. Go back to it (in the agent view, ← : Enter on ${identity.address(name, here)}), or sit here as someone else: /sub-human NAME`);
  return seat({ name, code: null, isDefault: true }, ctx);
};

export const named: Verb = (args, ctx) => {
  // `/sub-human --as NAME`: the name the join flag gives, as `/sub-human NAME` (a PIN-shaped word is no name)
  if (args[0] === '--as') {
    if (args.length !== 2) return refused(USAGE);
    const n = nameFor(args[1], ctx.cwd);
    if ('error' in n) return refused(n.error);
    return seat({ name: n.name, code: ctx.cur && ctx.cur.name === n.name ? ctx.cur.code : null }, ctx);
  }
  if (args.length > 2) return refused(USAGE);
  if (args.length === 1 && identity.isRoomCode(args[0])) { // `/sub-human vole-8126`: that room, as the default name
    const name = identity.defaultName({ cwd: ctx.cwd });
    if (!name) return refused(`no name to join as (no git user.name or $USER): /sub-human NAME ${args[0]}`);
    return seat({ name, code: args[0], isDefault: true }, ctx);
  }
  const [name, code] = args;
  if (name === undefined) return refused(USAGE); // route() sends a bare /sub-human to bare
  // a SECRET-shaped word is never echoed, nor taken for a name or a room: it belongs in an invite line
  if (args.some(a => SECRET_WORD.test(a) || fragmentSecret(a) !== null)) return refused(`that looks like an invite line's SECRET: the whole line goes in as /sub-human join LINE PIN. ${USAGE}`);
  if (PIN_WORD.test(name)) return refused(NOT_A_NAME(name));
  if (code !== undefined && PIN_WORD.test(code)) return refused(`"${code}" looks like a PIN, not a room: a PIN goes in as /sub-human join PIN once an invite line asks for it`);
  if (name.startsWith('-')) return refused(`"${name}" goes with join (/sub-human join HOST ROOM SECRET ${name} …). ${USAGE}`);
  if (!identity.isSeatName(name)) return refused(`"${name}" isn't a command or a name. ${USAGE}`);
  if (identity.RESERVED.includes(name.toLowerCase())) return refused(`"${name}" is reserved; pick another name. ${USAGE}`);
  if (code !== undefined && !identity.isRoomCode(code)) return refused(`"${code}" isn't a room (like vole-8126). ${USAGE}`);
  return seat({ name, code: code || (ctx.cur && ctx.cur.name === name ? ctx.cur.code : null) }, ctx);
};

/** An invite line's SECRET word, or why it is not one (a cut paste). */
function secretOf(word: string | undefined): { word: InviteSecret } | { error: string } {
  if (word === undefined) return { error: JOIN_USAGE };
  const d = inviteSecret.decode(word);
  return d ? { word: inviteSecret.encode(d.secret, d.tag) } : { error: NOT_WHOLE };
}

/** The PIN typed after an invite line, or why it is not one; none typed: no PIN (the host's machine asks for it). */
function pinAfter(word: string | undefined): { pin?: Pin } | { error: string } {
  if (word === undefined) return {};
  if (invites.isShortPin(word)) return { pin: word };
  return { error: PIN_WORD.test(word) ? 'a PIN is 4 digits: /sub-human join LINE PIN' : JOIN_USAGE };
}

/** `/sub-human join URL#SECRET [PIN]` (or URL SECRET [PIN]): the web form of an invite line. */
function joinWeb(r: string[], flags: { as?: string; home?: string }, ctx: VerbCtx): Answer {
  const [typed = '', ...after] = r;
  const hash = typed.indexOf('#');
  const url = hash < 0 ? typed : typed.slice(0, hash);
  // the SECRET as the URL's fragment, else the word after it; then the PIN, if typed
  const [word, extra, ...more] = hash < 0 ? after : [typed.slice(hash + 1), ...after];
  if (word === undefined || word === '') return refused('a web join needs the SECRET the host sent with the address: /sub-human join URL#SECRET');
  if (more.length) return refused(JOIN_USAGE);
  if (flags.home !== undefined) return refused('--home goes with an ssh address, not a web one');
  const w = secretOf(word);
  if ('error' in w) return refused(w.error);
  const p = pinAfter(extra);
  if ('error' in p) return refused(p.error);
  const BAD = 'that isn\'t a join address (https://HOST/…/sub-human/ROOM). Paste the whole line the host sent you.';
  const [, scheme, where] = /^(https?):\/\/([^#\s]+)$/.exec(url) ?? [];
  const spec = where !== undefined ? wsT().parse(`//${where.replace(/\/+$/, '')}`) : null;
  const code = spec && spec.path.split('/').filter(Boolean).pop();
  if (!spec || !code || !identity.isRoomCode(code)) return refused(BAD);
  const n = nameFor(flags.as, ctx.cwd);
  if ('error' in n) return refused(n.error);
  const loc = wsT().locator(spec, scheme === 'https');
  const transport = loc && linkConnect.transportOf(loc);
  if (!transport) return refused(BAD);
  return then(joining.linkLine({ name: n.name, code, word: w.word, transport, sid: ctx.sid, ...p }), ctx);
}

export const join: Verb = (argv, ctx) => {
  const p = parse(argv, { as: 1, home: 1 });
  if (p.error) return refused(`${p.error}. ${JOIN_USAGE}`);
  const flag = p.rest.find(a => a.startsWith('--'));
  if (flag) return refused(`"${flag}" isn't a join option. ${JOIN_USAGE}`);
  const r = p.rest;
  const { home } = p.flags;
  if (/^https?:\/\//.test(r[0] || '')) return joinWeb(r, p.flags, ctx);
  if (r.length === 1 && invites.isShortPin(r[0])) { // `/sub-human join 4829`: the PIN an invite line's host asked for
    if (home !== undefined || p.flags.as !== undefined) return refused('the PIN goes alone: /sub-human join PIN (the name went with the line)');
    return then(joining.givePin(r[0], ctx.sid), ctx);
  }
  if (r.length === 1 && identity.isRoomCode(r[0])) { // `/sub-human join vole-8126`: that room on this machine
    if (home !== undefined) return refused(`--home goes with the other machine's address: /sub-human join HOST ${r[0]}`);
    const n = nameFor(p.flags.as, ctx.cwd);
    if ('error' in n) return refused(n.error);
    return seat({ name: n.name, code: r[0], isDefault: p.flags.as === undefined }, ctx);
  }
  const [dest, code, word, extra] = r;
  if (dest === undefined || code === undefined || r.length > 4) return refused(r.length === 1 && dest !== undefined ? (PIN_WORD.test(dest) ? 'a PIN is 4 digits: /sub-human join PIN' : `which room? ${JOIN_USAGE}`) : JOIN_USAGE);
  if (!identity.isRoomCode(code)) return refused(`"${code}" isn't a room (like vole-8126). ${JOIN_USAGE}`);
  const local = /^pipe:\//.test(dest) || dest.startsWith('/'); // a second home on this machine (tests, the demo)
  if (word !== undefined) {
    const w = secretOf(word);
    if ('error' in w) return refused(w.error);
    const pin = pinAfter(extra);
    if ('error' in pin) return refused(pin.error);
    const n = nameFor(p.flags.as, ctx.cwd);
    if ('error' in n) return refused(n.error);
    if (local) {
      if (home !== undefined) return refused('--home goes with an ssh address');
      const transport = linkConnect.transportOf(dest.startsWith('/') ? `pipe:${dest}` : dest);
      return transport ? then(joining.linkLine({ name: n.name, code, word: w.word, transport, sid: ctx.sid, ...pin }), ctx) : refused(`"${dest}" isn't a sub-human folder on this machine`);
    }
    if (sshT().placeholder(dest)) return refused(YOU_HINT(dest));
    const full = sshT().withUser(dest);
    if (!sshT().dest(full)) return refused(`"${dest}" isn't a plain USER@HOST[:PORT] or ssh alias`);
    // over ssh an invite line goes through the person's own ssh login to the host (a login spec), as the line says;
    // a jump host is the person's ~/.ssh/config's (ProxyJump on an alias), which ssh reads
    const transport = sshT().loginSpec(full, home !== undefined ? { home } : {});
    if (!transport) return refused(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
    return then(joining.linkLine({ name: n.name, code, word: w.word, transport, sid: ctx.sid, ...pin }), ctx);
  }
  // no SECRET: over the person's own ssh login (a second home on this machine has none: the line lost its SECRET)
  if (local) return refused(joining.noSecret(dest, code));
  if (sshT().placeholder(dest)) return refused(YOU_HINT(dest));
  if (!sshT().dest(sshT().withUser(dest))) return refused(`"${sshT().withUser(dest)}" isn't a plain USER@HOST[:PORT] or ssh alias. ${JOIN_USAGE}`);
  if (home !== undefined && !sshT().loginSpec(sshT().withUser(dest), { home })) return refused(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
  const n = nameFor(p.flags.as, ctx.cwd);
  if ('error' in n) return refused(n.error);
  return then(joining.linkLogin({ dest, code, home, name: n.name, isDefault: p.flags.as === undefined }), ctx);
};

/** The room Claude's own launch (see the header). */
export function bindRoomClaude(args: string[], ctx: VerbCtx): Answer {
  const { cur, pid, sid } = ctx;
  if (args.length > 1 || (args[0] && !identity.isRoomCode(args[0]))) {
    return refused('this session runs the room\'s Claude agent; people join from their own sessions with /sub-human.');
  }
  const code = envStr('SUB_HUMAN_ROOM') || args[0] || null;
  if (cur && cur.role === 'claude' && (!code || cur.code === code)) return { kind: 'joined', me: cur, lead: 'room already open', say: `claude of room ${cur.code}` };
  if (cur) return refused(`this session is already ${cur.name} in room ${cur.code}.`);
  const fresh = !code;
  const c = code || identity.newCode();
  if (!identity.roomExists(c)) return refused(`no room ${c}.`);
  if (identity.roomClosing(c)) return refused(`room ${c} is closing.`);
  const r = identity.join({ code: c, name: identity.ROOM_CLAUDE, role: 'claude', pid, session_id: sid, cwd: ctx.cwd });
  if (!r || !r.ok) return refused(`could not bind the room's Claude of ${c}: ${(r && r.error) || 'unknown error'}`);
  const me: Identity = { code: c, name: identity.ROOM_CLAUDE, role: 'claude', pid, session_id: sid || null, address: identity.address('claude', c) };
  return { kind: 'joined', me, lead: fresh ? 'room created' : 'claude started', say: fresh ? `room ${c} open · others join with: /sub-human` : `claude of room ${c}` };
}
