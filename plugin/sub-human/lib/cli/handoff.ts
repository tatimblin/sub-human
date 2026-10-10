/**
 * plugin/sub-human/lib/cli/handoff.ts: the CLI bodies of moving a room's host (lib/handoff.ts), for
 * scripts/sub-human. A person runs them in their own shell; the Bash guard refuses them to a model.
 *
 *   handoff(args, ctx)   sub-human handoff NAME [USER@HOST[:PORT] | --ssh USER@HOST[:PORT]] [--via JUMP] [--room CODE] [--as SEAT]
 *                        sub-human handoff NAME --url https://FRONT   (or NAME https://FRONT)
 *                        sub-human handoff --status [--room CODE]
 *       Ask NAME (a member on another machine, linked) to host the room. Their Claude shows them a card; the move
 *       happens only on their own answer there. USER@HOST / --ssh: how the others will reach NAME's machine (default:
 *       a second home on this machine, pipe:, the tests and the demo); --via: through that ProxyJump, as
 *       `invite --ssh --via`. --as: which seat of this machine asks (default this session's, else the first). --status:
 *       who hosts the room at which epoch, the last ask, and on a new host which machines have not reconnected yet,
 *       with what to tell them.
 *   promote(args, ctx)   sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT] [--via JUMP] | --url https://FRONT] [--force] [--confirm CODE]
 *       When the host is gone for good: this machine's full copy becomes the room at the next epoch. Prints what
 *       it risks and needs --confirm CODE (the room code typed back). Prints one invite per other machine to hand
 *       out by hand (each machine runs demote with its own).
 *   demote(args, ctx)    sub-human demote CODE INVITE PIN
 *       A machine follows a promoted room with the invite promote printed for it: a member's machine re-points its
 *       link (its seats join again with /sub-human); an old host the room was promoted away from sets its own log
 *       aside (kept in orphaned-<time>.jsonl, never merged), stops its room Claude, and mirrors the new host.
 * ctx = {die(msg, code?), out(line), err(line)}.
 * FORK_RISK(code, last) -> [line]   what promote prints before its --confirm
 */

import * as identity from '../identity.ts';
import * as store from '../room/store.ts';
import * as handoff from '../handoff.ts';
import * as link from '../remote/link.ts';
import { parse } from './args.ts';
import * as textMod from '../text.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = args => textMod.cliLine(args);

/** args.parse, dying on its error (usage, exit 2). */
function flagsOf(args, spec, die) {
  const p = parse(args, spec);
  if (p.error) die(p.error);
  return p;
}

/** The room: --room, else this session's. */
function roomOf(flags, die) {
  if (flags.room) {
    if (!identity.roomExists(flags.room)) die(`no room "${flags.room}"`, 1);
    return flags.room;
  }
  const me = identity.resolveSelf();
  if (!me) die('not in a room; pass --room CODE', 1);
  return me.code;
}

/** Which seat of this machine speaks: --as, else this session's, else the first live one. */
function seatOf(code, as, die) {
  if (as) return as;
  const me = identity.resolveSelf();
  if (me && me.code === code && me.role !== 'claude') return me.name;
  const local = identity.localSeats(code).filter(n => n !== 'claude');
  if (!local.length) die(`no seat of this machine is in room ${code}; join it first, or pass --as NAME`, 1);
  return local[0];
}

/** Where the others will reach the next host: --url, or --ssh USER@HOST[:PORT] (a plain one) with --via JUMP. */
function locatorOf(flags, die, code) {
  if (flags.url !== undefined) {
    if (flags.ssh !== undefined || flags.via !== undefined) die('--ssh/--via and --url are two ways in; pick one');
    try { return require('../remote/webhost.ts').webLocator(flags.url, code); } catch (e) { die(e.message); }
  }
  if (flags.ssh === undefined) {
    if (flags.via !== undefined) die('--via is for an ssh address (USER@HOST[:PORT] --via JUMP)');
    return undefined;
  }
  const l = link.sshLocator(flags.ssh, flags.via !== undefined ? { via: flags.via } : {});
  if (!l) die(link.sshLocator(flags.ssh) ? `--via needs a plain [USER@]HOST[:PORT] (comma-separated hops), not "${flags.via}"` : `--ssh needs a plain USER@HOST[:PORT], not "${flags.ssh}"`);
  return l;
}

const HANDOFF_USAGE = 'sub-human handoff NAME [USER@HOST[:PORT] | --ssh USER@HOST[:PORT]] [--via JUMP] [--room CODE] [--as SEAT] | handoff NAME --url https://FRONT';
const PROMOTE_USAGE = 'sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT] [--via JUMP] | --url https://FRONT] [--force] --confirm CODE';

function showStatus(code, { out }) {
  const st = handoff.status(code);
  const h = st.host;
  out(`room ${code}: ${st.isHost ? 'hosted on this machine' : 'hosted on another machine'}${h.host ? ` (${h.host}'s machine since #${h.id})` : ''}`);
  const d = st.doc;
  if (d) out(`last handoff ask: ${d.from} -> ${d.to}: ${d.state}${d.state === 'asked' ? ` until ${d.expires_at}` : ''}`);
  for (const m of st.machines || []) {
    out(`  ${m.seats.join(', ')}: ${m.connected ? 'reconnected here' : `not reconnected yet. If they cannot reach this machine, give them a new invite (/sub-human invite in the room here); they type the line it shows`}`);
  }
}

function handoffCmd(args, ctx) {
  const { die, out } = ctx;
  const { flags, rest } = flagsOf(args, { room: 1, as: 1, ssh: 1, via: 1, url: 1, status: 0 }, die);
  const code = roomOf(flags, die);
  if (flags.status) return showStatus(code, ctx);
  if (rest.length === 2 && flags.ssh === undefined && flags.url === undefined) { // handoff NAME USER@HOST | https://FRONT
    if (/^https?:\/\//.test(rest[1])) flags.url = rest[1]; else flags.ssh = rest[1];
    rest.pop();
  }
  if (rest.length !== 1) die(`usage: ${HANDOFF_USAGE} | handoff --status [--room CODE]`);
  const to = rest[0];
  const from = seatOf(code, flags.as, die);
  let d;
  try { d = handoff.ask(code, { from, to, locator: locatorOf(flags, die, code) }); } catch (e) { die(`could not hand room ${code} off: ${e.message}`, 1); }
  out(`asked ${to} to host room ${code}; their Claude shows them a card until ${d.expires_at}.`);
  out(`If ${to} agrees, the room and its Claude move to their machine (on ${to}'s Claude account), and this machine stays in it. ${cli(`handoff --status --room ${code}`)} shows how it went.`);
}

const FORK_RISK = (code, last) => [
  `PROMOTE makes this machine's copy of room ${code} the room. Only do this when its host is gone for good.`,
  'If the old host is only slow, asleep or cut off, the room FORKS: lines it writes from now on reach nobody here,',
  `and lines it wrote after #${last} (the last one this machine has) are lost to the room. Members still linked to it`,
  'keep talking to it until they follow. When it comes back, its owner runs the line this prints for it, in a terminal there',
  '(its own lines are kept in orphaned-<time>.jsonl, never merged).',
];

function promoteCmd(args, ctx) {
  const { die, out } = ctx;
  const { flags, rest } = flagsOf(args, { as: 1, ssh: 1, via: 1, url: 1, force: 0, confirm: 1 }, die);
  const code = rest[0];
  if (rest.length !== 1 || !identity.CODE_RE.test(String(code))) die(`usage: ${PROMOTE_USAGE}`);
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  const s = store.open(code);
  if (s.isHost) die(`this machine hosts room ${code} already`, 1);
  if (flags.confirm !== code) {
    for (const l of FORK_RISK(code, s.lastId())) out(l);
    die(`to go ahead, run it again with --confirm ${code}`, 1);
  }
  const name = seatOf(code, flags.as, die);
  let r;
  try { r = handoff.promote(code, { name, locator: locatorOf(flags, die, code), force: !!flags.force, cwd: process.cwd() }); } catch (e) { die(`could not promote: ${e.message}`, 1); }
  out(`this machine hosts room ${code} now${r.note}`);
  if (!r.invites.length) return out('no other machine had a seat in the room.');
  out('Give each machine its line, and its PIN some other way (each is single-use, lasts 15 minutes and only works on that machine); they run it in a terminal, then /sub-human in their session:');
  // inside Claude Code (its ! shell) the PINs are masked: that output would land in the conversation
  const lines = r.invites.map(x => `  ${x.seats.join(', ')}: ${cli(`demote ${code} ${x.invite} ${x.pin}`)}`);
  out(require('./host.ts').maskPins(lines.join('\n'), r.invites.map(x => x.pin)));
  out('(the old host runs its line too when it is back: its own lines are kept aside, never merged)');
}

function demoteCmd(args, ctx) {
  const { die, out } = ctx;
  const { rest } = flagsOf(args, {}, die);
  if (rest.length !== 2 && rest.length !== 3) die('usage: sub-human demote CODE INVITE PIN');
  const [code, invite, pin] = rest;
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  let r;
  try { r = handoff.demote(code, invite, pin); } catch (e) { die(`could not demote: ${e.message}`, 1); }
  out(`room ${code}: this machine follows its new host now${r.orphan ? `; its own log is kept in ${r.orphan}` : ''}.${r.follower ? ' Type /sub-human in your session to join it again.' : ''}`);
  if (r.request) out('Over ssh the new host has not let this machine in yet: if it cannot connect, ask them for an invite (/sub-human invite there) and type the line it shows in your session.');
}

export { handoffCmd as handoff, promoteCmd as promote, demoteCmd as demote, FORK_RISK };
