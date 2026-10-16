#!/usr/bin/env node
// UserPromptExpansion(sub-human:sub-human): every /sub-human command, run before the model and in place of it. The
// model never chooses an identity. The commands (HELP below has them all):
//   /sub-human                  in a room: a short status, starting the room's Claude again if it failed or ended
//                               (and, after a re-pointed link, the seat joined again over it); not in a room: finish a join the host has let in (a link file's join_as), else
//                               join the one open room, or open one, as the default name
//   /sub-human NAME [ROOM]      join ROOM (else the one open room, else a new one) as NAME, leaving any other room
//   /sub-human invite …         (host) an invite line and its PIN (lib/remote/hosting.ts hostInvite, webhost.ts
//                               hostWeb); --stop stops serving over the web, --cancel [REF] cancels an unused invite
//   /sub-human join HOST ROOM [PIN] [--as NAME] [--via J] [--home P]    another machine's room: with a PIN, an invite
//                               (hosting.joinShort: the link daemon runs the PAKE, the host's card lets it in); with
//                               none, over the person's own ssh login (no invite, the seat taken in the same step)
//   /sub-human join URL PIN [--as NAME]                                   the same over the web
//   /sub-human kick NAME        (host) end NAME's connection (hosting.kick)
//   /sub-human leave            leave the room (lib/seats.ts exit); the session stays open, its tail goes quiet
//   /sub-human admit [REF]      (host) the waiting join requests, or let one in, as the card does
//   /sub-human handoff NAME …   ask NAME to host the room (lib/handoff.ts ask; NAME's card decides)
//   /sub-human doctor           `sub-human doctor --quick`, read only (--fix stays in a terminal)
//   /sub-human help             the full list
// The name: NAME, else --as NAME, else identity.defaultName (git user.name, the local part of user.email, $USER; a
// taken default name is refused with the hint to pick one). `/sub-human NAME` joins the open room or opens a new one
// and (re)starts the room's Claude without waiting for it (lib/room-claude.ts claimSpawn). Bare `/sub-human` in the
// room Claude's own session (agent_type sub-human:room-claude + SUB_HUMAN_ROOM) binds it. Creates the seat key
// (hooks/seat-key.ts), made before the seat: its public key rides on member_joined, which pins it for the room's life
// (lib/room/envelope.ts); a join whose key differs from the one pinned for that name is refused (RoomError AUTH) and
// the seat given back. A seat needs the hooks module (its guard, prompt gate and delivery), so without a fresh hello
// lease for this session (identity.modLeaseOk) the join is refused with noModule(): why, as far as it can tell.
// Two ways in. Normally the hooks module runs this script for the command first (mod/command.ts, command.run;
// sub_human_via "command.run" with the session's nonce) and shows what it says itself: a reply is
// {subHuman: {say, refused, shareable}}, which the module draws as a plain notice or as the command's own output, never
// as "blocked by hook", and a join that worked also carries the mechanics block (the module then lets the command
// expand and hands that block to the model). Without the module (classic: Claude Code runs this hooks.json hook itself)
// a reply is a block, drawn "UserPromptExpansion operation blocked by hook: sub-human: …".
// Out: a join that worked is the mechanics block (common.ts contextBlock) plus a one-line confirmation for the person
// (module) or a systemMessage only when something in it is a warning (classic); the title comes on the next prompt
// (mod/prompt.ts). Everything else is a reply: no model turn. A PIN must never reach the model, so every `join`,
// `invite` and `admit` prompt, and any prompt with a word of digits, is answered with hidden(): the typed prompt is
// suppressed from the conversation, whatever form it turns out to be or whatever is wrong with it.
// For the same reason a join that carries a PIN never takes the seat in that step (the seat's mechanics block would
// go to the model with the prompt): once the host lets this machine in, a bare /sub-human (no PIN) takes it.
import { identity, room, out, run, whoami, presence, contextBlock } from './common.ts';
import * as roomClaude from '../lib/room-claude.ts';
import * as seats from '../lib/seats.ts';
import * as auth from '../lib/remote/auth.ts';
import * as link from '../lib/remote/link.ts';
import * as links from '../lib/room/links.ts';
import * as hosting from '../lib/remote/hosting.ts';
const wsT = (): typeof import('../lib/remote/transports/ws.ts') => require('../lib/remote/transports/ws.ts');
const sshT = (): typeof import('../lib/remote/transports/ssh.ts') => require('../lib/remote/transports/ssh.ts');
const parseArgs = <const S extends FlagSpec>(argv: string[], spec: S): Parsed<S> => (require('../lib/cli/args.ts') as typeof import('../lib/cli/args.ts')).parse(argv, spec);
import * as seatKey from './seat-key.ts';
import * as handoff from '../lib/handoff.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as store from '../lib/room/store.ts';
import { roomClaudePresence } from '../lib/room/members.ts';
import * as textMod from '../lib/text.ts';
import PathMod from 'node:path';
import childProcess from 'node:child_process';
import * as ccMod from '../lib/cc.ts';
import { createRequire } from 'node:module';
import type { JoinIn } from './types.ts';
import type { FlagSpec, Parsed } from '../lib/cli/types.ts';
import type { Link, Member } from '../lib/room/types.ts';
import type { LinkSpec, SshSpec } from '../lib/remote/types-rest.ts';
import type { Outcome } from '../lib/remote/hosting.ts';
import type { Signer } from '../lib/remote/admission.ts';
import type { Identity } from '../lib/identity.ts';

/** The seat a command asks to take: code null for the one open room, else a new one. */
interface Wanted { name: string; code: string | null; isDefault?: boolean; pending?: boolean }
/** The seat's process, as identity.join takes it. */
interface Base { pid: number; session_id: string | undefined; cwd: string }
/** What take() needs besides the seat. */
interface TakeCtx { input: JoinIn; base: Base; cur: Identity | null; cwd: string }

const require = createRequire(import.meta.url);
const webhost = (): typeof import('../lib/remote/webhost.ts') => require('../lib/remote/webhost.ts');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ROOM_CLAUDE_AGENT = 'sub-human:room-claude';
const HELP_HINT = 'All commands: /sub-human help';
const USAGE = `usage: /sub-human [NAME] joins or opens a room. ${HELP_HINT}`;
const HELP = [
  'commands:',
  '  /sub-human                    in a room: who is here; else join the open room, or open one, as your git name',
  '  /sub-human NAME [ROOM]        join (or open) a room as NAME; ROOM (like vole-8126) only when more than one is open',
  '  /sub-human invite             a line for someone on another machine to join this room (over ssh to this machine)',
  '      --ssh USER@HOST [--via JUMP]   the address they reach this machine at (default: SUB_HUMAN_SSH_ADDR, else you@this-host)',
  '      --web | --public | --url URL   over the web: Tailscale Serve (your tailnet), Tailscale Funnel (public), or your own HTTPS front',
  '      --stop                         stop serving this room over the web',
  '      --cancel [ID]                  cancel an invite nobody used yet (ID: only when several are open; it lists them)',
  '  /sub-human join HOST ROOM PIN [--as NAME] [--via JUMP]   the line from an invite; the host lets you in',
  '  /sub-human join URL PIN [--as NAME]                       the same over the web',
  '  /sub-human join HOST ROOM [--as NAME] [--via JUMP] [--home PATH]   a room on a machine you can already ssh to: no invite',
  '  /sub-human admit [ID]         (host) who is waiting to join, and the ID that lets one in (the card does the same)',
  '  /sub-human kick NAME          (host) end the connection NAME joined over',
  '  /sub-human leave              leave the room (the session stays open)',
  '  /sub-human handoff NAME [USER@HOST [--via JUMP] | https://FRONT]   ask NAME to host the room',
  '  /sub-human doctor             what is wrong on this machine, and how to fix it (read only)',
  '  /sub-human help               this list',
  '  @room TEXT    post your exact words to the room       @claude TEXT    the same, and wake the room\'s Claude',
].join('\n');
const JOIN_USAGE = `usage: /sub-human join HOST ROOM PIN (the line from an invite). ${HELP_HINT}`;
const INVITE_USAGE = `usage: /sub-human invite (an ssh line; --web for the web). ${HELP_HINT}`;
const BYPASS = ' · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live';
const DIGITS = /^[0-9]{3,10}$/;

// Through the module (mod/command.ts): set once per prompt, before any reply, from an attested sub_human_via.
let viaModule = false;
/**
 * The one reply to this prompt. Through the module: {subHuman: {say, refused, shareable}} (the module shows it; shareable:
 * no secret and nothing typed in it, so it may be the command's output, which Remote Control and the model also see).
 * Classic: a block, its reason the text after "sub-human: " (Claude Code shows only the reason, never a systemMessage
 * beside it, and never to the model); suppress: the typed prompt is kept out of the conversation as well.
 */
let replied = false;
function reply(text: string, { refused = false, shareable = true, suppress = false } = {}) {
  replied = true;
  const t = `${refused ? '✗ ' : ''}${text}`;
  if (viaModule) return out({ subHuman: { say: t, refused, shareable: shareable && !suppress } });
  return out({
    decision: 'block', reason: `sub-human: ${t}`,
    ...(suppress ? { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true } } : {}),
  });
}
/** A refusal of a prompt that holds no secret. */
const block = (reason: string) => reply(reason, { refused: true });
/** What only the person may read (an invite, a PIN they typed): never the model's, the typed prompt hidden too.
 * shareable: the text itself holds no secret and echoes nothing typed (still kept off the model with the prompt). */
const hidden = (text: string, { refused = true } = {}) => reply(text, { refused, suppress: true });
/** Not a refusal: what the person asked for (help, who is here, an invite, done). */
const notice = (text: string, { secret = false } = {}) => reply(text, { suppress: secret || refuse === hiddenRefusal });
const hiddenRefusal = (r: string) => hidden(r);
// How this prompt's refusals go out: hidden() when it could carry a PIN (set once per prompt, before any parsing).
// Hidden until then: a prompt whose stdin cannot be read may hold a PIN too (onError answers with this).
let refuse: (msg: string) => void = hiddenRefusal;
const fail = (msg: string): null => { refuse(msg); return null; };
/** A caught error's message (what a refusal says). */
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A note in a join's message that the person must hear: the room's Claude could not start, or its last start failed. */
const TROUBLE = /could not start|the last start failed: /;

/**
 * A join that worked: the mechanics block for the model, and msg (one line: "joined vole-8126 as alice · …") for the
 * person. Through the module msg is a notice. Classic: no systemMessage, which Claude Code draws as a warning (the
 * session title and the room row say it worked), unless something in it is one: the room's Claude did not start, or
 * the bypass-permissions warning.
 */
function success(me: Identity, lead: string, msg: string, input: JoinIn) {
  presence(me, 'working');
  const bypass = input.permission_mode === 'bypassPermissions' && me.role !== 'claude' ? BYPASS : '';
  const warn = bypass || TROUBLE.test(msg) ? `sub-human: ${msg}${bypass}` : null;
  const hso = { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) };
  if (viaModule) return out({ hookSpecificOutput: hso, subHuman: { say: `${msg}${bypass}`, joined: true, shareable: true } });
  out({ ...(warn ? { systemMessage: warn } : {}), hookSpecificOutput: hso });
}

/** Close rooms where only the room's Claude is left once they have been orphaned long enough (best effort; host only). */
function sweep() {
  try { identity.pruneModLeases(); } catch { /* the next join retries */ }
  for (const c of identity.orphanRooms()) { try { roomClaude.watchdog(c); } catch { /* next join retries */ } }
}

function others(code: string, name: string): string {
  const ms = Object.values<Member>(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at
    && (m.role !== 'claude' || roomClaudePresence(m) === 'live'));
  return ms.map(m => m.name).join(', ');
}

/** The room Claude's own launch `/sub-human` (or a debugging `/sub-human [ROOM]` in a room-claude agent session). */
function bindRoomClaude(input: JoinIn, base: Base, cur: Identity | null, args: string[]) {
  if (args.length > 1 || (args[0] && !identity.CODE_RE.test(args[0]))) {
    return block('this session runs the room\'s Claude agent; people join from their own sessions with /sub-human.');
  }
  const code = process.env.SUB_HUMAN_ROOM || args[0] || null;
  if (cur && cur.role === 'claude' && (!code || cur.code === code)) return success(cur, 'room already open', `claude of room ${cur.code}`, input);
  if (cur) return block(`this session is already ${cur.name} in room ${cur.code}.`);
  const fresh = !code;
  const c = code || identity.newCode();
  if (!identity.roomExists(c)) return block(`no room ${c}.`);
  if (identity.roomClosing(c)) return block(`room ${c} is closing.`);
  const r = identity.join({ code: c, name: 'claude', role: 'claude', ...base });
  if (!r || !r.ok) return block(`could not bind the room's Claude of ${c}: ${(r && r.error) || 'unknown error'}`);
  const me: Identity = { code: c, name: 'claude', role: 'claude', pid: base.pid, session_id: base.session_id || null, address: identity.address('claude', c) };
  return success(me, fresh ? 'room created' : 'claude started', fresh ? `room ${c} open · others join with: /sub-human` : `claude of room ${c}`, input);
}

const hostOnly = (cur: Identity | null, what: string): string | null => (!cur ? `join a room first (/sub-human); then /sub-human ${what}.`
  : !identity.isHost(cur.code) ? `room ${cur.code} is hosted on another machine; only its host can do that.` : null);

// ---------- invite ----------
/** `/sub-human invite [--ssh [DEST]] [--via J] | --web | --public | --url U [--port P] | --pipe | --stop | --cancel [ID]`. */
function invite(cur: Identity | null, argv: string[]) {
  const why = hostOnly(cur, 'invite');
  if (why) return refuse(why);
  if (!cur) return; // hostOnly refused it
  const p = parseArgs(argv, { ssh: '?', via: 1, web: 0, public: 0, url: 1, port: 1, pipe: 0, stop: 0, cancel: '?' });
  const f = p.flags;
  const bad = p.error ? p.error.split(' ')[0] : p.rest.length ? p.rest[0] : f.port !== undefined && !/^[0-9]{1,5}$/.test(f.port) ? '--port' : null;
  if (bad !== null) return refuse(`"${bad}" isn't an invite option. ${INVITE_USAGE}`);
  const web = !!(f.web || f.public || f.url !== undefined);
  const ways = [f.ssh !== undefined || f.via !== undefined, web, !!f.pipe, !!f.stop, f.cancel !== undefined].filter(Boolean).length;
  if (ways > 1) return refuse(`pick one way at a time. ${INVITE_USAGE}`);
  try {
    if (f.stop) return notice(webhost().unhost(cur.code).text);
    if (f.cancel !== undefined) return notice(hosting.cancelInvite(cur.code, f.cancel === true ? undefined : f.cancel).text);
    const r = web
      ? webhost().hostWeb(cur.code, { tailscale: !!(f.web || f.public), funnel: !!f.public, url: f.url, port: f.port !== undefined ? Number(f.port) : undefined, by: cur.name })
      : hosting.hostInvite(cur.code, { ssh: f.pipe ? undefined : f.ssh === undefined ? true : f.ssh, via: f.via, pipe: !!f.pipe, by: cur.name });
    // for this terminal only, never the model, nor Remote Control: it holds the PIN
    return notice(r.text, { secret: true });
  } catch (e) { return refuse(msgOf(e)); }
}

// ---------- admit, kick, leave ----------
/** `/sub-human admit [ID]`: the host's consent, as the card gives it. */
function admit(cur: Identity | null, argv: string[]) {
  const why = hostOnly(cur, 'admit');
  if (why) return refuse(why);
  if (!cur) return; // hostOnly refused it
  if (argv.length > 1 || (argv[0] && !/^[0-9a-f]{6,12}$/.test(argv[0]))) return refuse(`usage: /sub-human admit (who is waiting), then /sub-human admit ID from that list. ${HELP_HINT}`);
  try {
    const adm: typeof import('../lib/remote/admission.ts') = require('../lib/remote/admission.ts');
    if (!argv.length) {
      const reqs = adm.pending(cur.code);
      return notice(reqs.length ? `waiting to join room ${cur.code}: ${reqs.map(q => `${adm.describe(q)}: let them in with /sub-human admit ${q.ref}`).join('; ')}` : `nobody is waiting to join room ${cur.code}.`);
    }
    const sign: Signer = p => envelope.sign(p, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name });
    return notice(adm.letIn(cur.code, argv[0], { by: cur.name, sign }).text);
  } catch (e) { return refuse(msgOf(e)); }
}

/** `/sub-human kick NAME`: end the connection NAME joined over. */
function kick(cur: Identity | null, argv: string[]) {
  const why = hostOnly(cur, 'kick NAME');
  if (why) return refuse(why);
  if (!cur) return; // hostOnly refused it
  if (argv.length !== 1) return refuse(`usage: /sub-human kick NAME (someone who joined from another machine). ${HELP_HINT}`);
  if (argv[0] === cur.name) return refuse('that is you; /sub-human leave leaves the room.');
  try { return notice(hosting.kick(cur.code, argv[0]).text); } catch (e) { return refuse(msgOf(e)); }
}

/** `/sub-human leave`: exactly as exiting the session would, without /exit. The tail goes quiet with the seat. */
function leave(cur: Identity | null, argv: string[]) {
  if (argv.length) return refuse(`usage: /sub-human leave. ${HELP_HINT}`);
  if (!cur) return refuse('this session is not in a room; /sub-human joins one.');
  seats.exit(cur.code, cur.name, 'left');
  return notice(`left ${cur.code} · /sub-human joins again`);
}

// ---------- doctor, help ----------
function doctor(argv: string[]) {
  const { cliLine } = textMod;
  if (argv.includes('--fix') || argv.includes('--bundle')) return refuse(`${argv.includes('--fix') ? '--fix' : '--bundle'} changes or writes files, so it runs in a terminal outside Claude Code: ${cliLine(`doctor ${argv.join(' ')}`)}`);
  if (argv.length) return refuse(`usage: /sub-human doctor. ${HELP_HINT}`);
  const path = PathMod;
  const r = childProcess.spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'sub-human'), 'doctor', '--quick'], {
    encoding: 'utf8', timeout: 8000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return text ? notice(text) : refuse(`the check did not finish (${r.error ? r.error.message : `exit ${r.status}`}). Run it in a terminal: ${cliLine('doctor')}`);
}

// ---------- handoff ----------
/** `/sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]`: ask NAME to host the room cur is in. */
function askHandoff(cur: Identity | null, argv: string[]) {
  if (!cur) return block('join a room first (/sub-human); then /sub-human handoff NAME asks NAME to host it.');
  const p = parseArgs(argv, { via: 1 });
  if (p.error || p.rest.length < 1 || p.rest.length > 2) return block(`usage: /sub-human handoff NAME. ${HELP_HINT}`);
  const [to, dest] = p.rest;
  const via = p.flags.via;
  let locator: string | undefined | null;
  if (/^https?:\/\//.test(dest || '')) { // a front to the new host's web listener (lib/remote/webhost.ts)
    if (via !== undefined) return block('--via goes with an ssh address (USER@HOST --via JUMP), not a web address.');
    try { locator = webhost().webLocator(dest, cur.code); } catch (e) { return block(msgOf(e)); }
  } else {
    if (via !== undefined && dest === undefined) return block('--via goes with the ssh address the others reach the new host at: /sub-human handoff NAME USER@HOST --via JUMP');
    locator = dest === undefined ? undefined : link.sshLocator(dest, via !== undefined ? { via } : {});
  }
  if (dest !== undefined && !locator) {
    return block(via !== undefined && link.sshLocator(dest)
      ? `--via "${via}" isn't a plain [USER@]HOST[:PORT] (several hops: comma-separated).`
      : `"${dest}" isn't a plain USER@HOST[:PORT] (or https://ADDRESS) the others can reach ${to}'s machine at.`);
  }
  let d: { expires_at: string };
  try {
    d = handoff.ask(cur.code, { from: cur.name, to, locator: locator ?? undefined, sign: (q: Record<string, unknown>) => envelope.sign(q, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name }) });
  } catch (e) {
    if (!(e instanceof room.RoomError)) throw e;
    return block(`could not hand room ${cur.code} over: ${e.message}.`);
  }
  return notice(`asked ${to} to host room ${cur.code}: a card asks them until ${d.expires_at.slice(11, 16)} UTC, and nothing moves unless they agree. If they do, the room and its Claude move to ${to}'s machine (on ${to}'s Claude account), and you stay in it.`);
}

// ---------- join ----------
const YOU_HINT = (d: string) => `"${d}" still has the example's placeholder: put your user name on that machine in place of ${d.split('@')[0]} (or just its ssh alias, e.g. dev)`;
const sameLogin = (a: LinkSpec | undefined, b: SshSpec) => !!a && !!b && a.kind === 'ssh' && a.login === true && (['user', 'host', 'port', 'via', 'remoteHome'] as const).every(k => a[k] === b[k]); // a login link is ssh
const NO_START = (code: string) => `the connection to room ${code} did not start. Run /sub-human doctor.`;

/** A daemon still dialing the old host: stop it, so the start that follows dials the link file's new one. */
function restartLink(code: string) {
  const st = link.status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  // 1 s: with LINK_START_MS and LINK_JOIN_WAIT_MS this fits the hook's 10 s (hooks.json) with the node start to spare
  for (const until = Date.now() + 1000; Date.now() < until && identity.isAlive(st.pid);) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

// the locator a link's transport came from (with its jump hosts: else every re-join over a bastion reads as a move)
const locatorOf = (t: LinkSpec | null | undefined): string | null => (t && t.kind === 'ssh' ? link.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`, t.via ? { via: t.via } : {}) : t && t.kind === 'pipe' ? link.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

/** A name typed with --as: checked; else the default name. null after a refuse(). */
function nameFor(as: string | undefined, cwd: string): string | null {
  if (as !== undefined) {
    if (!identity.NAME_RE.test(as)) return fail(`"${as}" isn't a name (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(as.toLowerCase())) return fail(`"${as}" is reserved; pick another name`);
    return as;
  }
  return identity.defaultName({ cwd }) || fail('no name to join as (no git user.name or $USER): add --as NAME');
}

/**
 * `/sub-human join …`: always parsed in hidden mode (refuse is hidden()). The forms: URL PIN; HOST ROOM PIN (an
 * invite: link only, the PAKE in the link daemon); HOST ROOM (the person's own ssh login: {name, code} once linked,
 * and the caller takes the seat). null after a refusal or a reply.
 */
function join(argv: string[], cwd: string): Wanted | null {
  const p = parseArgs(argv, { as: 1, via: 1, home: 1 });
  if (p.error) return fail(`${p.error}. ${JOIN_USAGE}`);
  const flag = p.rest.find(a => a.startsWith('--'));
  if (flag) return fail(`"${flag}" isn't a join option. ${JOIN_USAGE}`);
  const r = p.rest;
  const { via, home } = p.flags;
  if (/^https?:\/\//.test(r[0] || '')) {
    if (r.length !== 2) return fail(r.length < 2 ? 'a web join needs the PIN the host sent with the address: /sub-human join URL PIN' : JOIN_USAGE);
    if (via !== undefined || home !== undefined) return fail('--via and --home go with an ssh address, not a web one');
    if (!auth.SHORT_PIN_RE.test(r[1])) return fail('the PIN is the 4 digits that came with the invite: /sub-human join URL PIN');
    const m = /^(https?):\/\/([^#\s]+)$/.exec(r[0]);
    const spec = m && wsT().parse(`//${m[2].replace(/\/+$/, '')}`);
    const code = spec && spec.path.split('/').filter(Boolean).pop();
    if (!spec || !code || !identity.CODE_RE.test(code)) return fail('that isn\'t a join address (https://HOST/…/sub-human/ROOM). Paste the whole line the host sent you.');
    const name = nameFor(p.flags.as, cwd);
    if (!name) return null;
    const loc = wsT().locator(spec, m[1] === 'https');
    const transport = loc && link.transportOf(loc);
    if (!transport) return fail('that isn\'t a join address (https://HOST/…/sub-human/ROOM). Paste the whole line the host sent you.');
    return linkShort({ name, code, pin: r[1], transport });
  }
  if (r.length < 2 || r.length > 3) return fail(r.length === 1 ? `which room? ${JOIN_USAGE}` : JOIN_USAGE);
  const [dest, code, pin] = r;
  if (!identity.CODE_RE.test(code)) return fail(`"${code}" isn't a room (like vole-8126). ${JOIN_USAGE}`);
  if (pin !== undefined) {
    if (!auth.SHORT_PIN_RE.test(pin)) return fail('the PIN is the 4 digits that came with the invite: /sub-human join HOST ROOM PIN');
    if (home !== undefined) return fail('--home goes with a join over your own ssh login (no PIN): /sub-human join HOST ROOM --home PATH');
    const name = nameFor(p.flags.as, cwd);
    if (!name) return null;
    if (/^pipe:\//.test(dest) || dest.startsWith('/')) { // a second home on this machine (tests, the demo)
      if (via !== undefined) return fail('--via goes with an ssh address');
      const transport = link.transportOf(dest.startsWith('/') ? `pipe:${dest}` : dest);
      return transport ? linkShort({ name, code, pin, transport }) : fail(`"${dest}" isn't a sub-human folder on this machine`);
    }
    if (sshT().placeholder(dest)) return fail(YOU_HINT(dest));
    const loc = link.sshLocator(sshT().withUser(dest), via !== undefined ? { via } : {});
    if (!loc) return fail(via !== undefined && link.sshLocator(dest) ? `--via "${via}" isn't a plain [USER@]HOST[:PORT] list` : `"${dest}" isn't a plain USER@HOST[:PORT] or ssh alias`);
    const transport = link.transportOf(loc);
    if (!transport) return fail(`"${dest}" isn't a plain USER@HOST[:PORT] or ssh alias`);
    return linkShort({ name, code, pin, transport });
  }
  return linkLogin({ dest, code, via, home, as: p.flags.as, cwd });
}

/** Where a join started with a PIN stands (hosting.joinText): a refusal when it was refused, else a notice. */
function joinReply(code: string, name: string, o: Outcome) {
  const text = hosting.joinText(code, name, o);
  return o.state === 'refused' ? refuse(text) : notice(text);
}

/** An invite's PIN: link only, the PAKE in the link daemon; always a hidden reply. */
function linkShort({ name, code, pin, transport }: { name: string; code: string; pin: string; transport: LinkSpec }): null {
  if (identity.roomExists(code) && identity.isHost(code)) return fail(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  if (cur && cur.token && locatorOf(cur.transport) === locatorOf(transport)) {
    notice(`this machine is in room ${code} already; /sub-human ${name} ${code} takes your place there.`);
    return null;
  }
  if (cur) restartLink(code); // a pending join replaced, or the room's host moved: dial with the new file
  try { hosting.joinShort({ code, transport, pin, name }); } catch (e) { return fail(msgOf(e)); }
  if (cur) links.set(code, { ...links.get(code)!, rebind: true }); // a seat here joins again over the new link (joinShort wrote it)
  if (!link.start(code)) return fail(NO_START(code));
  joinReply(code, name, hosting.outcome(code));
  return null;
}

/** `/sub-human join HOST ROOM [--via J] [--home P]`: link over the person's own ssh login; {name, code} once linked
 * (the caller takes the seat), or null after a refusal. */
function linkLogin({ dest: typed, code, via, home, as, cwd }: {
  dest: string; code: string; via: string | undefined; home: string | undefined; as: string | undefined; cwd: string;
}): Wanted | null {
  if (sshT().placeholder(typed)) return fail(YOU_HINT(typed));
  const dest = sshT().withUser(typed);
  if (!sshT().dest(dest)) return fail(`"${dest}" isn't a plain USER@HOST[:PORT] or ssh alias. ${JOIN_USAGE}`);
  if (via !== undefined && !sshT().jump(via)) return fail(`--via "${via}" isn't a plain [USER@]HOST[:PORT] (several hops: comma-separated).`);
  const spec = sshT().loginSpec(dest, { via, home });
  if (!spec) return fail(`--home "${home}" isn't a plain absolute path (the sub-human folder on that machine, e.g. /home/you/.sub-human).`);
  const name = nameFor(as, cwd);
  if (!name) return null;
  if (identity.roomExists(code) && identity.isHost(code)) return fail(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur: Link | null = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  const spent = (link.stopReason(link.status(code)) || {}).code === 'AUTH'; // kicked, or a host key changed: link anew
  if (cur && cur.token && sameLogin(cur.transport, spec) && !spent) return { name, code, isDefault: as === undefined }; // linked this way already: just the seat
  if (cur) restartLink(code); // a link replaced (another way in, or a refused one): dial with the new file
  const mux = cur && cur.transport && cur.transport.kind === 'ssh' && cur.transport.mux === true && cur.transport.user === spec.user && cur.transport.host === spec.host && cur.transport.port === spec.port;
  try {
    links.set(code, { code, transport: { ...spec, ...(mux ? { mux: true } : {}) }, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
  } catch (e) { return fail(msgOf(e)); }
  if (!link.start(code)) return fail(NO_START(code));
  const o: Outcome = hosting.outcome(code);
  if (o.state === 'refused') return fail(`could not reach room ${code} over ${at}: ${o.reason}`);
  if (o.state !== 'linked') {
    notice(`still connecting to room ${code} over ${at}${o.reason ? ` (${o.reason})` : ''}. Type /sub-human ${name} ${code} in a moment; if it doesn't come up, /sub-human doctor says why.`);
    return null;
  }
  return { name, code, isDefault: as === undefined };
}

/** A join this machine started with a PIN, waiting to take its seat (join_as): the newest, or null. */
function pendingJoin(): Link | null {
  const all = links.list().map(c => links.get(c)).filter((l): l is Link => !!l && typeof l.join_as === 'string' && !identity.isHost(l.code));
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

/** Bare `/sub-human` with a pending join: {name, code} once the link is up (the caller takes the seat), else null
 * after saying where it stands. */
function finishJoin(l: Link): Wanted | null {
  const code = l.code, name = String(l.join_as); // pendingJoin: a string
  const why = link.stopReason(link.status(code));
  if (why && !l.token) {
    try { const { join_as: _gone, ...rest } = links.get(code) || l; links.set(code, rest); } catch { /* no credential left: nothing to keep */ }
    return fail(`could not join room ${code}: ${why.reason}`);
  }
  if (l.token) return { name, code, pending: true };
  if (!link.start(code)) return fail(NO_START(code));
  const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
  if (o.state === 'linked') return { name, code, pending: true };
  joinReply(code, name, o);
  return null;
}

/** The single open room, null for none (the caller creates one), or a refusal for several. */
function pickRoom(): { code: string | null } | null {
  sweep();
  const open: string[] = identity.openRooms();
  if (open.length <= 1) return { code: open[0] || null };
  return fail(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human NAME ROOM.`);
}

/** Who else is in the room, for a line: "with bob, carol", or how many beyond three; the people only (the room's
 * Claude is named where it matters: "@claude to ask the room's Claude"). */
function withWhom(code: string, name: string): string {
  const names = others(code, name).split(', ').filter(n => n && n !== identity.ROOM_CLAUDE);
  const here = names.join(', ');
  if (!here) return 'nobody else here yet';
  return names.length > 3 ? `${names.length} others here` : `with ${here}`;
}

/**
 * Bare `/sub-human` in a room: who is here, and how to bring someone in; a connection that stopped running starts again,
 * and so does a room's Claude that failed to start or ended (seats.ensureRoomClaude: host only, never a live one).
 */
function status(cur: Identity, cwd: string) {
  const host = identity.isHost(cur.code);
  if (!host) { try { link.start(cur.code); } catch { /* the doctor says why */ } } // its connection, if it stopped running
  return notice(`you're ${cur.name} in room ${cur.code}, ${withWhom(cur.code, cur.name)} · `
    + `${host ? 'another machine: /sub-human invite · ' : ''}leave: /sub-human leave${seats.ensureRoomClaude(cur.code, cwd, cur.name)}`);
}

/**
 * Take the seat NAME in ROOM (null: the one open room, else a new one). isDefault: the name was not typed (a taken one
 * says how to pick another). The mechanics block on success.
 */
function take({ name, code, isDefault = false }: Wanted, { input, base, cur, cwd }: TakeCtx) {
  let created = false;
  if (!code) {
    const pick = pickRoom();
    if (!pick) return;
    code = pick.code;
  }
  if (!code) {
    // Check the name before making a room for it.
    if (!identity.NAME_RE.test(name)) return refuse(`"${name}" isn't a name (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(name.toLowerCase())) return refuse(`"${name}" is reserved; pick another name`);
    code = identity.newCode();
    created = true;
  } else {
    if (!identity.roomExists(code)) return refuse(`there's no room ${code} on this machine. Check the name, or type /sub-human to open a new room.`);
    if (identity.roomClosing(code)) return refuse(`room ${code} is closing; type /sub-human to open a new room.`);
    const pending = identity.isHost(code) ? null : links.get(code);
    if (pending && !pending.token && (pending.pin !== undefined || pending.enroll || pending.awaiting)) {
      // a join not let in yet: never start it again after a refusal (that would spend another try)
      const why = link.stopReason(link.status(code));
      if (why) return refuse(`could not join ${code}: ${why.reason}`);
      if (!link.start(code)) return refuse(NO_START(code));
      const o: Outcome = hosting.outcome(code, { waitMs: 2000 });
      if (o.state !== 'linked') return joinReply(code, name, o);
    }
    if (!identity.isHost(code) && !link.start(code)) {
      const why = link.stopReason(link.status(code));
      return refuse(why ? `could not join ${code}: its connection stopped (${why.reason}). Run /sub-human doctor.` : NO_START(code));
    }
  }
  const same = cur && cur.code === code && cur.name === name;
  // a link whose credentials a re-point replaced (lib/handoff.ts): the seat joins again over it, even if seated
  const rebind = !identity.isHost(code) && !!(links.get(code) || {}).rebind;
  if (same && !rebind) {
    dropJoinAs(code);
    return success(cur, 'already joined', `you're already in ${cur.code} as ${name}, ${withWhom(code, name)}${seats.ensureRoomClaude(code, cwd, name)}`, input);
  }
  // The seat's key (hooks/seat-key.ts): via=human posts and answers are signed with it, and the log pins it.
  let pubkey: string;
  try { pubkey = seatKey.publicPem(code, name); } catch (e) { return refuse(`could not make ${name}'s signing key (${msgOf(e)}). Run /sub-human doctor.`); }
  if (cur && !same) seats.exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  const r = seats.enter({ code, name, ...base, pubkey });
  if (!r.ok) {
    if (isDefault && /^name taken/.test(r.error || '')) return refuse(`"${name}" is taken in room ${code}; pick another: /sub-human NAME${created ? '' : ` ${code}`}`);
    return refuse(`could not join ${code} as ${name}: ${r.error || 'unknown error'}`);
  }
  if (rebind) { const { rebind: _done, ...l } = links.get(code)!; links.set(code, l); } // rebind: read from it
  dropJoinAs(code);
  if (identity.isHost(code)) {
    try { webhost().ensure(code); } catch { /* best effort */ } // the listener after a reboot
    try { (require('../lib/remote/shim.ts') as typeof import('../lib/remote/shim.ts')).refresh(); } catch { /* best effort */ } // the serve shim a login link runs
  }
  const me: Identity = { code, name, role: 'member', pid: base.pid, session_id: input.session_id || null, address: identity.address(name, code) };
  const msg = created
    ? `opened room ${code} as ${name} · on this machine others join with /sub-human; another machine: /sub-human invite`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}, ${withWhom(code, name)} · @room to talk, @claude to ask the room's Claude`;
  return success(me, created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', `${msg}${r.note}`, input);
}

/** The seat a pending join waited for is taken: its link file no longer says so. */
function dropJoinAs(code: string) {
  try {
    const l = identity.isHost(code) ? null : links.get(code);
    if (l && l.join_as !== undefined) { const { join_as: _done, ...rest } = l; links.set(code, rest); }
  } catch { /* a stale join_as only names the seat again */ }
}

/** True when the input carries this session's module nonce (its lease's): the module's command.run hook ran it. */
function attested(input: JoinIn): boolean {
  const sid = input.session_id;
  if (input.sub_human_via !== 'command.run' || typeof sid !== 'string' || typeof input.sub_human_nonce !== 'string') return false;
  const lease = identity.readModLease(sid);
  return !!lease && lease.session_id === sid && typeof lease.nonce === 'string' && lease.nonce === input.sub_human_nonce;
}

/**
 * Why this session has no hooks module (no fresh lease from mod-hello), in words the person can act on: an old Claude
 * Code (the running binary's version), its modules switch off (cc.modulesSwitch), else the doctor.
 */
function noModule(pid: number | null): string {
  const cc = ccMod;
  let v: string | null = null;
  try { v = cc.runningVersion(pid); } catch { /* unknown */ }
  if (v && (cc.compareVersions(v, cc.MIN_VERSION) ?? 0) < 0) return `sub-human needs Claude Code ${cc.MIN_VERSION} or newer, and this is ${v}. Update it (claude update), restart claude, then type /sub-human again.`;
  let sw: boolean | undefined;
  try { sw = cc.modulesSwitch(); } catch { /* unknown */ }
  if (sw === false) return 'Claude Code has plugin hooks modules switched off for now, and sub-human needs them. Restart claude with network access, then type /sub-human again; /sub-human doctor says more.';
  return 'sub-human\'s hooks module isn\'t running in this session (safe mode, --bare, a managed policy or an untrusted folder turns it off). Run /sub-human doctor.';
}

/** A throw anywhere below: still one reply, hidden when the prompt may carry a PIN (refuse was set first), so a
 *  PIN-bearing prompt never reaches the model as a plain expansion. A reply already made stands. */
function onError(err: unknown): void {
  if (replied) return;
  const m = err instanceof Error ? err.message : String(err);
  refuse(`sub-human could not run that (${m.split('\n')[0].slice(0, 200)}). Run /sub-human doctor.`);
}

run((input: JoinIn) => {
  if (!COMMANDS.has(String(input.command_name))) return;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  // Before anything else: a prompt that could carry a PIN is answered hidden, whatever goes wrong with it.
  refuse = ['join', 'invite', 'admit'].includes(args[0]) || args.some(a => DIGITS.test(a)) ? hiddenRefusal : block;
  viaModule = attested(input);
  // the module's $.process.run child has no CLAUDE_PID of this session: its parent is the claude process
  const pid = identity.claudePid() || (viaModule ? process.ppid : null);
  // read only, and what a refusal below points to: these work without the module
  if (args[0] === 'help' && args.length === 1) return notice(HELP);
  if (args[0] === 'doctor') return doctor(args.slice(1));
  if (!identity.modLeaseOk(input.session_id, pid)) return refuse(noModule(pid || identity.claudePid()));
  if (!pid) return refuse('could not tell which Claude Code session this is. Run /sub-human doctor.');
  const cwd = input.cwd || process.cwd();
  const base: Base = { pid, session_id: input.session_id, cwd };
  const cur = whoami(input);
  const ctx = { input, base, cur, cwd };

  if (input.agent_type === ROOM_CLAUDE_AGENT) return bindRoomClaude(input, base, cur, args);
  if (cur && cur.role === 'claude') return refuse(`this session is the room's Claude of room ${cur.code}; join from another session.`);
  const [verb, ...rest] = args;
  switch (verb) {
    case undefined: {
      if (cur) {
        const l = identity.isHost(cur.code) ? null : links.get(cur.code);
        return l && l.rebind ? take({ name: cur.name, code: cur.code }, ctx) : status(cur, cwd);
      }
      const l = pendingJoin();
      if (l) {
        const j = finishJoin(l);
        return j ? take(j, ctx) : undefined;
      }
      const name = identity.defaultName({ cwd });
      if (!name) return refuse('no name to join as (no git user.name or $USER): /sub-human NAME');
      return take({ name, code: null, isDefault: true }, ctx);
    }
    case 'help': return refuse(`usage: /sub-human help. ${HELP_HINT}`);
    case 'invite': return invite(cur, rest);
    case 'admit': return admit(cur, rest);
    case 'kick': return kick(cur, rest);
    case 'leave': return leave(cur, rest);
    case 'handoff': return askHandoff(cur, rest);
    case 'join': {
      const j = join(rest, cwd);
      return j ? take(j, ctx) : undefined;
    }
    default: {
      if (args.length > 2) return refuse(USAGE);
      if (args.length === 1 && identity.CODE_RE.test(args[0])) { // `/sub-human vole-8126`: that room, as the default name
        const name = identity.defaultName({ cwd });
        if (!name) return refuse(`no name to join as (no git user.name or $USER): /sub-human NAME ${args[0]}`);
        return take({ name, code: args[0], isDefault: true }, ctx);
      }
      const [name, code] = args;
      if (!identity.NAME_RE.test(name)) return refuse(`"${name}" isn't a command or a name. ${USAGE}`);
      if (identity.RESERVED.includes(name.toLowerCase())) return refuse(`"${name}" is reserved; pick another name. ${USAGE}`);
      if (code !== undefined && !identity.CODE_RE.test(code)) return refuse(`"${code}" isn't a room (like vole-8126). ${USAGE}`);
      return take({ name, code: code || (cur && cur.name === name ? cur.code : null) }, ctx);
    }
  }
}, onError);

export { HELP };
