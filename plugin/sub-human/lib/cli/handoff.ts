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
 *   demote(args, ctx)    sub-human demote CODE [--from FILE]   the invite line and its PIN (one line, in either order) on
 *       stdin or in FILE, never in argv (ps and the shell's history would keep them)
 *       A machine follows a promoted room with the invite promote printed for it: a member's machine re-points its
 *       link (its seats join again with /sub-human); an old host the room was promoted away from sets its own log
 *       aside (kept in orphaned-<time>.jsonl, never merged), stops its room Claude, and mirrors the new host.
 * ctx = {die(msg, code?), out(line), err(line)}.
 * FORK_RISK(code, last) -> [line]   what promote prints before its --confirm
 */

import fs from 'node:fs';
import * as identity from '../identity.ts';
import * as store from '../room/store.ts';
import * as handoff from '../handoff.ts';
import * as links from '../room/links.ts';
import * as linkConnect from '../remote/link-connect.ts';
import { parse } from './args.ts';
import * as textMod from '../text.ts';
import { createRequire } from 'node:module';
import type { CliIo, FlagSpec, Flags, Parsed } from './types.ts';
import { errCode, msgOf } from '../errors.ts';
import type { RoomCode } from '../brand.ts';

const require = createRequire(import.meta.url);
const cli = (args: string) => textMod.cliLine(args);

/** args.parse, dying on its error (usage, exit 2). */
function flagsOf<S extends FlagSpec>(args: readonly string[], spec: S, die: CliIo['die']): Parsed<S> {
  const p = parse(args, spec);
  if (p.error) die(p.error);
  return p;
}

/** The room: --room, else this session's. */
function roomOf(flags: { room?: string }, die: CliIo['die']): RoomCode {
  if (flags.room) {
    if (!identity.roomExists(flags.room)) die(`no room "${flags.room}"`, 1);
    return flags.room;
  }
  const me = identity.resolveSelf();
  if (!me) die('not in a room; pass --room CODE', 1);
  return me.code;
}

/** Which seat of this machine speaks: --as, else this session's, else the first live one. */
function seatOf(code: RoomCode, as: string | undefined, die: CliIo['die']): string {
  if (as) return as;
  const me = identity.resolveSelf();
  if (me && me.code === code && me.role !== 'claude') return me.name;
  const local = identity.localSeats(code).filter(n => n !== 'claude');
  if (!local.length) die(`no seat of this machine is in room ${code}; join it first, or pass --as NAME`, 1);
  return local[0];
}

const LOCATOR_FLAGS = { ssh: 1, via: 1, url: 1 } as const satisfies FlagSpec;

/** Where the others will reach the next host: --url, or --ssh USER@HOST[:PORT] (a plain one) with --via JUMP. */
function locatorOf(flags: Flags<typeof LOCATOR_FLAGS>, die: CliIo['die'], code: RoomCode) {
  if (flags.url !== undefined) {
    if (flags.ssh !== undefined || flags.via !== undefined) die('--ssh/--via and --url are two ways in; pick one');
    const webhost: typeof import('../remote/webhost.ts') = require('../remote/webhost.ts');
    try { return webhost.webLocator(flags.url, code); } catch (e) { die(msgOf(e)); }
  }
  if (flags.ssh === undefined) {
    if (flags.via !== undefined) die('--via is for an ssh address (USER@HOST[:PORT] --via JUMP)');
    return undefined;
  }
  const l = linkConnect.sshLocator(flags.ssh, flags.via !== undefined ? { via: flags.via } : {});
  if (!l) die(linkConnect.sshLocator(flags.ssh) ? `--via needs a plain [USER@]HOST[:PORT] (comma-separated hops), not "${flags.via}"` : `--ssh needs a plain USER@HOST[:PORT], not "${flags.ssh}"`);
  return l;
}

const HANDOFF_USAGE = 'sub-human handoff NAME [USER@HOST[:PORT] | --ssh USER@HOST[:PORT]] [--via JUMP] [--room CODE] [--as SEAT] | handoff NAME --url https://FRONT';
const PROMOTE_USAGE = 'sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT] [--via JUMP] | --url https://FRONT] [--force] --confirm CODE';

function showStatus(code: RoomCode, { out }: CliIo) {
  // lib/handoff.ts status(code): the parts this prints
  const st: {
    host: { host?: string | undefined; id?: number };
    isHost: boolean;
    doc?: { from: string; to: string; state: string; expires_at?: string } | null;
    machines?: { seats: string[]; connected: boolean }[];
  } = handoff.status(code);
  const h = st.host;
  out(`room ${code}: ${st.isHost ? 'hosted on this machine' : 'hosted on another machine'}${h.host ? ` (${h.host}'s machine since #${h.id})` : ''}`);
  const d = st.doc;
  if (d) out(`last handoff ask: ${d.from} -> ${d.to}: ${d.state}${d.state === 'asked' ? ` until ${d.expires_at}` : ''}`);
  for (const m of st.machines || []) {
    out(`  ${m.seats.join(', ')}: ${m.connected ? 'reconnected here' : `not reconnected yet. If they cannot reach this machine, give them a new invite (/sub-human invite in the room here); they type the line it shows`}`);
  }
}

function handoffCmd(args: readonly string[], ctx: CliIo): void {
  const die: CliIo['die'] = ctx.die, out = ctx.out;
  const { flags, rest } = flagsOf(args, { ...LOCATOR_FLAGS, room: 1, as: 1, status: 0 }, die);
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
  try { d = handoff.ask(code, { from, to, locator: locatorOf(flags, die, code) }); } catch (e) { die(`could not hand room ${code} off: ${msgOf(e)}`, 1); }
  out(`asked ${to} to host room ${code}; their Claude shows them a card until ${d.expires_at}.`);
  out(`If ${to} agrees, the room and its Claude move to their machine (on ${to}'s Claude account), and this machine stays in it. ${cli(`handoff --status --room ${code}`)} shows how it went.`);
}

const FORK_RISK = (code: RoomCode, last: number): string[] => [
  `PROMOTE makes this machine's copy of room ${code} the room. Only do this when its host is gone for good.`,
  'If the old host is only slow, asleep or cut off, the room FORKS: lines it writes from now on reach nobody here,',
  `and lines it wrote after #${last} (the last one this machine has) are lost to the room. Members still linked to it`,
  'keep talking to it until they follow. When it comes back, its owner runs the line this prints for it, in a terminal there',
  '(its own lines are kept in orphaned-<time>.jsonl, never merged).',
];

function promoteCmd(args: readonly string[], ctx: CliIo): void {
  const die: CliIo['die'] = ctx.die, out = ctx.out;
  const { flags, rest } = flagsOf(args, { ...LOCATOR_FLAGS, as: 1, force: 0, confirm: 1 }, die);
  const code = rest[0];
  if (rest.length !== 1 || !identity.isRoomCode(code)) die(`usage: ${PROMOTE_USAGE}`);
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  const s = store.open(code);
  if (s.isHost) die(`this machine hosts room ${code} already`, 1);
  if (flags.confirm !== code) {
    for (const l of FORK_RISK(code, s.lastId())) out(l);
    die(`to go ahead, run it again with --confirm ${code}`, 1);
  }
  const name = seatOf(code, flags.as, die);
  let r;
  try { r = handoff.promote(code, { name, locator: locatorOf(flags, die, code), force: !!flags.force, cwd: process.cwd() }); } catch (e) { die(`could not promote: ${msgOf(e)}`, 1); }
  out(`this machine hosts room ${code} now${r.note}`);
  if (!r.invites.length) return out('no other machine had a seat in the room.');
  out('Give each machine its line, and its PIN some other way (each is single-use, lasts 15 minutes and only works on that machine); they run it in a terminal, then /sub-human in their session:');
  // inside Claude Code (its ! shell) the PINs are masked: that output would land in the conversation. The machine
  // runs demote CODE and pastes the line and its PIN: never in argv
  const lines = r.invites.map(x => `  ${x.seats.join(', ')}: run ${textMod.cliLine(`demote ${code}`, { elsewhere: true })} and paste: ${x.invite} ${x.pin}`);
  const host: typeof import('./host.ts') = require('./host.ts');
  out(host.maskPins(lines.join('\n'), r.invites.map(x => x.pin)));
  out('(the old host runs its line too when it is back: its own lines are kept aside, never merged)');
}

/** One line from stdin, read synchronously (a terminal hands it over at Enter; a pipe or a file to its first newline). */
function readLine(fd = 0): string {
  const buf = Buffer.alloc(4096);
  let text = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) {
      if (errCode(e) === 'EAGAIN') continue;
      if (errCode(e) === 'EOF') break;
      throw e;
    }
    if (!n) break;
    text += buf.subarray(0, n).toString('utf8');
    if (text.includes('\n') || text.length > 8192) break;
  }
  return text.split('\n')[0];
}

function demoteCmd(args: readonly string[], ctx: CliIo): void {
  const die: CliIo['die'] = ctx.die, out = ctx.out;
  const { flags, rest } = flagsOf(args, { from: 1 }, die);
  // the invite and its PIN never go in argv (ps shows it, the shell's history keeps it): stdin, or a file
  if (rest.length > 1) die('sub-human demote CODE takes the invite line and its PIN on stdin (or --from FILE), never as arguments: run it, then paste them');
  if (rest.length !== 1 || flags.from === '') die('usage: sub-human demote CODE [--from FILE]   (then paste: INVITE PIN)');
  const [code] = rest;
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  if (flags.from === undefined && process.stdin.isTTY) ctx.err(`paste the invite line for room ${code} and its PIN, then press Enter:`);
  let text = '';
  try { text = flags.from !== undefined ? fs.readFileSync(flags.from, 'utf8') : readLine(); } catch (e) { die(`could not read the invite: ${msgOf(e)}`, 1); }
  const words = text.trim().split(/\s+/).filter(Boolean);
  const invite = words.find(w => w.startsWith('sh2.')) || '', pin = words.find(w => /^[0-9]{6}$/.test(w));
  if (!invite) die('that is not an invite line (it starts sh2.); paste the line promote printed for this machine, then its PIN', 1);
  let r;
  try { r = handoff.demote(code, { invite, pin }); } catch (e) { die(`could not demote: ${msgOf(e)}`, 1); }
  out(`room ${code}: this machine follows its new host now${r.orphan ? `; its own log is kept in ${r.orphan}` : ''}.${r.follower ? ' Type /sub-human in your session to join it again.' : ''}`);
  const t = (links.get(code) || {}).transport;
  if (t && t.kind === 'ssh') out('Over ssh this machine reaches the new host through your own ssh login to it: if it cannot connect, ask them for an invite over the web (/sub-human invite --web there) and type the line it shows in your session.');
}

export { handoffCmd as handoff, promoteCmd as promote, demoteCmd as demote, FORK_RISK };
