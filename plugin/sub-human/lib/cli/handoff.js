'use strict';
/**
 * plugin/sub-human/lib/cli/handoff.js: the CLI bodies of moving a room's host (lib/handoff.js), for
 * scripts/sub-human. A person runs them in their own shell; the Bash guard refuses them to a model.
 *
 *   handoff(args, ctx)   sub-human handoff NAME [--room CODE] [--as SEAT] [--ssh USER@HOST[:PORT]]
 *                        sub-human handoff --status [--room CODE]
 *       Ask NAME (a member on another machine, linked) to host the room. Their Claude shows them a card; the move
 *       happens only on their own answer there. --ssh: how the others will reach NAME's machine (default: a second
 *       home on this machine, pipe:, the tests and the demo). --as: which seat of this machine asks (default this
 *       session's, else the first). --status: who hosts the room at which epoch, the last ask, and on a new host
 *       which machines have not reconnected yet, with what to tell them.
 *   promote(args, ctx)   sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT]] [--force] [--confirm CODE]
 *       When the host is gone for good: this machine's full copy becomes the room at the next epoch. Prints what
 *       it risks and needs --confirm CODE (the room code typed back). Prints one invite per other machine to hand
 *       out by hand.
 *   demote(args, ctx)    sub-human demote CODE INVITE [PIN]
 *       On an old host the room was promoted away from: set its own log aside (kept in orphaned-<time>.jsonl,
 *       never merged), stop its orch, and mirror the new host with INVITE.
 * ctx = {die(msg, code?), out(line), err(line)}.
 */

const identity = require('../identity.js');
const store = require('../room/store.js');
const handoff = require('../handoff.js');
const link = require('../remote/link.js');

function flagsOf(args, spec, die) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.slice(2) in spec) {
      flags[a.slice(2)] = spec[a.slice(2)] ? args[++i] : true;
      if (flags[a.slice(2)] === undefined) die(`${a} needs a value`);
    } else rest.push(a);
  }
  return { flags, rest };
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
  if (me && me.code === code && me.role !== 'orch') return me.name;
  const local = identity.localSeats(code).filter(n => n !== 'orch');
  if (!local.length) die(`no seat of this machine is in room ${code}; join it first, or pass --as NAME`, 1);
  return local[0];
}

function locatorOf(flags, die) {
  if (flags.ssh === undefined) return undefined;
  const l = link.sshLocator(flags.ssh);
  if (!l) die(`--ssh needs a plain USER@HOST[:PORT], not "${flags.ssh}"`);
  return l;
}

function showStatus(code, { out }) {
  const st = handoff.status(code);
  const h = st.host;
  out(`room ${code}: ${st.isHost ? 'hosted on this machine' : 'hosted on another machine'}; host epoch ${h.epoch}${h.host ? ` (${h.host}'s machine since #${h.id})` : ''}`);
  const d = st.doc;
  if (d) out(`last handoff ask: ${d.from} -> ${d.to}, epoch ${d.epoch}: ${d.state}${d.state === 'asked' ? ` until ${d.expires_at}` : ''}`);
  for (const m of st.machines || []) {
    out(`  ${m.seats.join(', ')}: ${m.connected ? 'reconnected here' : `not reconnected yet. If they cannot reach this machine, give them a new invite (sub-human host --room ${code} [--ssh]); they run /sub-human join ${m.seats[0]} INVITE PIN, then /sub-human ${m.seats[0]} ${code}`}`);
  }
}

function handoffCmd(args, ctx) {
  const { die, out } = ctx;
  const { flags, rest } = flagsOf(args, { room: 1, as: 1, ssh: 1, status: 0 }, die);
  const code = roomOf(flags, die);
  if (flags.status) return showStatus(code, ctx);
  if (rest.length !== 1) die('usage: sub-human handoff NAME [--room CODE] [--as SEAT] [--ssh USER@HOST[:PORT]] | handoff --status [--room CODE]');
  const to = rest[0];
  const from = seatOf(code, flags.as, die);
  let d;
  try { d = handoff.ask(code, { from, to, locator: locatorOf(flags, die) }); } catch (e) { die(`could not hand room ${code} off: ${e.message}`, 1); }
  out(`asked ${to} to host room ${code} (host epoch ${d.epoch}); their Claude shows them a card until ${d.expires_at}.`);
  out(`If ${to} agrees, the log, the links and the orch move to their machine (the orch then runs on ${to}'s model account), and this machine follows as a member. sub-human handoff --status --room ${code} shows how it went.`);
}

const FORK_RISK = (code, last) => [
  `PROMOTE makes this machine's copy of room ${code} the room. Only do this when its host is gone for good.`,
  'If the old host is only slow, asleep or cut off, the room FORKS: lines it writes from now on reach nobody here,',
  `and lines it wrote after #${last} (the last one this machine has) are lost to the room. Members still linked to it`,
  'keep talking to it until they get a new invite. When it comes back, its owner runs: sub-human demote CODE INVITE',
  '(its own lines are kept in orphaned-<time>.jsonl, never merged).',
];

function promoteCmd(args, ctx) {
  const { die, out } = ctx;
  const { flags, rest } = flagsOf(args, { as: 1, ssh: 1, force: 0, confirm: 1 }, die);
  const code = rest[0];
  if (rest.length !== 1 || !identity.CODE_RE.test(String(code))) die('usage: sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT]] [--force] --confirm CODE');
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  const s = store.open(code);
  if (s.isHost) die(`this machine hosts room ${code} already`, 1);
  if (flags.confirm !== code) {
    for (const l of FORK_RISK(code, s.lastId())) out(l);
    die(`to go ahead, run it again with --confirm ${code}`, 1);
  }
  const name = seatOf(code, flags.as, die);
  let r;
  try { r = handoff.promote(code, { name, locator: locatorOf(flags, die), force: !!flags.force, cwd: process.cwd() }); } catch (e) { die(`could not promote: ${e.message}`, 1); }
  out(`this machine hosts room ${code} now (host epoch ${r.epoch})${r.note}`);
  if (!r.invites.length) return out('no other machine had a seat in the room.');
  out('Give each machine its invite, and its PIN some other way (each is single-use, lasts 15 minutes and only works on that machine):');
  for (const x of r.invites) out(`  ${x.seats.join(', ')}: /sub-human join ${x.seats[0]} ${x.invite} ${x.pin}   (then /sub-human ${x.seats[0]} ${code})`);
  out(`The old host, when it is back: sub-human demote ${code} <its invite above> <its PIN>`);
}

function demoteCmd(args, ctx) {
  const { die, out } = ctx;
  const { rest } = flagsOf(args, {}, die);
  if (rest.length !== 2 && rest.length !== 3) die('usage: sub-human demote CODE INVITE [PIN]');
  const [code, invite, pin] = rest;
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  let r;
  try { r = handoff.demote(code, invite, pin); } catch (e) { die(`could not demote: ${e.message}`, 1); }
  out(`room ${code}: this machine mirrors its new host now${r.orphan ? `; its own log is kept in ${r.orphan}` : ''}.`);
  if (r.request) out(`Over SSH the new host must let this machine's key in first: send them this line (it holds no secret):\n  /sub-human admit ${r.request}`);
}

module.exports = { handoff: handoffCmd, promote: promoteCmd, demote: demoteCmd, FORK_RISK };
