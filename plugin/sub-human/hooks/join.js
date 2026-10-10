#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): every /sub-human command, run before the model and in place of it. The
// model never chooses an identity. The commands (HELP below has them all):
//   /sub-human                  in a room: a short status (and, after a re-pointed link, the seat joined again over
//                               it); not in a room: finish a join the host has let in (a link file's join_as), else
//                               join the one open room, or open one, as the default name
//   /sub-human NAME [ROOM]      join ROOM (else the one open room, else a new one) as NAME, leaving any other room
//   /sub-human invite …         (host) an invite line and its PIN (lib/remote/hosting.js hostInvite, webhost.js
//                               hostWeb); --stop stops serving over the web, --cancel [REF] cancels an unused invite
//   /sub-human join HOST ROOM [PIN] [--as NAME] [--via J] [--home P]    another machine's room: with a PIN, an invite
//                               (hosting.joinShort: the link daemon runs the PAKE, the host's card lets it in); with
//                               none, over the person's own ssh login (no invite, the seat taken in the same step)
//   /sub-human join URL PIN [--as NAME]                                   the same over the web
//   /sub-human kick NAME        (host) end NAME's connection (hosting.kick)
//   /sub-human leave            leave the room (lib/seats.js exit); the session stays open, its tail goes quiet
//   /sub-human admit [REF]      (host) the waiting join requests, or let one in, as the card does
//   /sub-human handoff NAME …   ask NAME to host the room (lib/handoff.js ask; NAME's card decides)
//   /sub-human doctor           `sub-human doctor --quick`, read only (--fix stays in a terminal)
//   /sub-human help             the full list
// The name: NAME, else --as NAME, else identity.defaultName (git user.name, the local part of user.email, $USER; a
// taken default name is refused with the hint to pick one). `/sub-human NAME` joins the open room or opens a new one
// and (re)starts the room's Claude without waiting for it (lib/room-claude.js claimSpawn). Bare `/sub-human` in the
// room Claude's own session (agent_type sub-human:room-claude + SUB_HUMAN_ROOM) binds it. Creates the seat key
// (hooks/seat-key.js), made before the seat: its public key rides on member_joined, which pins it for the room's life
// (lib/room/envelope.js); a join whose key differs from the one pinned for that name is refused (RoomError AUTH) and
// the seat given back. A seat needs the hooks module (its guard, prompt gate and delivery), so without a fresh hello
// lease for this session (identity.modLeaseOk) the join is refused with NO_MODULE.
// Out: a join that worked is the mechanics block (common.js contextBlock; a systemMessage only when the room's Claude
// did not start, or the bypass-permissions warning); the title comes on the next prompt (mod/prompt.mjs). Everything
// else is a block: no model turn. A PIN must never reach the model, so every `join`, `invite` and `admit` prompt, and
// any prompt with a word of digits, is answered with hidden(): the typed prompt is suppressed from the conversation
// (suppressOriginalPrompt travels with a block only), whatever form it turns out to be or whatever is wrong with it.
// For the same reason a join that carries a PIN never takes the seat in that step (the seat's mechanics block would
// go to the model with the prompt): once the host lets this machine in, a bare /sub-human (no PIN) takes it.
const { identity, room, out, run, whoami, presence, contextBlock } = require('./common.js');
const roomClaude = require('../lib/room-claude.js');
const seats = require('../lib/seats.js');
const auth = require('../lib/remote/auth.js');
const link = require('../lib/remote/link.js');
const links = require('../lib/room/links.js');
const hosting = require('../lib/remote/hosting.js');
const wsT = () => require('../lib/remote/transports/ws.js');
const sshT = () => require('../lib/remote/transports/ssh.js');
const parseArgs = (argv, spec) => require('../lib/cli/args.js').parse(argv, spec);
const seatKey = require('./seat-key.js');
const handoff = require('../lib/handoff.js');
const envelope = require('../lib/room/envelope.js');
const store = require('../lib/room/store.js');
const { roomClaudePresence } = require('../lib/room/members.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ROOM_CLAUDE_AGENT = 'sub-human:room-claude';
const USAGE = 'usage: /sub-human [NAME [ROOM]] opens or joins a room (your name defaults to your git name); /sub-human invite gives a line for someone on another machine. All commands: /sub-human help';
const HELP = [
  'sub-human commands:',
  '  /sub-human                    in a room: who is here and how to invite; else join the open room, or open one, as your git name',
  '  /sub-human NAME [ROOM]        join (or open) a room as NAME; ROOM only when more than one is open',
  '  /sub-human invite             a line for someone on another machine to join this room (over ssh to this machine)',
  '      --ssh USER@HOST [--via JUMP]   the address they reach this machine at (default: SUB_HUMAN_SSH_ADDR, else you@this-host)',
  '      --web | --public | --url URL   over the web: Tailscale Serve (your tailnet), Tailscale Funnel (public), or your own HTTPS front',
  '      --stop                         stop serving this room over the web',
  '      --cancel [REF]                 cancel an invite nobody used yet',
  '  /sub-human join HOST ROOM PIN [--as NAME] [--via JUMP]   the line from an invite; the host\'s card lets you in',
  '  /sub-human join URL PIN [--as NAME]                       the same over the web',
  '  /sub-human join HOST ROOM [--as NAME] [--via JUMP] [--home PATH]   a room on a machine you can already ssh to: no invite',
  '  /sub-human admit [REF]        (host) who is waiting to join; let one in (the card does the same)',
  '  /sub-human kick NAME          (host) end NAME\'s connection to the room',
  '  /sub-human leave              leave the room (the session stays open)',
  '  /sub-human handoff NAME [USER@HOST [--via JUMP] | https://FRONT]   ask NAME to host the room',
  '  /sub-human doctor             what is wrong on this machine, read only (sub-human doctor --fix in a terminal fixes it)',
  '  /sub-human help               this list',
  '  @room TEXT    post your exact words to the room       @claude TEXT    the same, and wake the room\'s Claude',
].join('\n');
const JOIN_USAGE = 'usage: /sub-human join HOST ROOM PIN (the line from an invite), /sub-human join URL PIN, or /sub-human join HOST ROOM over your own ssh login. All commands: /sub-human help';
const INVITE_USAGE = 'usage: /sub-human invite [--ssh USER@HOST [--via JUMP] | --web | --public | --url https://FRONT] | --stop | --cancel [REF]';
const BYPASS = ' · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live';
const NO_MODULE = 'sub-human needs Claude Code 2.1.292+ with function hooks on; not in --bare or safe mode';
const DIGITS = /^[0-9]{3,10}$/;

// A refusal is also the systemMessage: Remote Control shows a hook's systemMessage, not a block reason.
const block = reason => out({ decision: 'block', reason: `sub-human: ${reason}`, systemMessage: `sub-human: ${reason}` });
// What only the person may read (an invite, a PIN they typed): the block reason alone, and the typed prompt hidden
// from the conversation (suppressOriginalPrompt travels with a block only). shareable: also the systemMessage
// (Remote Control shows it), for text that holds no secret and echoes nothing typed.
const hidden = (reason, { shareable = false } = {}) => out({
  decision: 'block', reason: `sub-human: ${reason}`, ...(shareable ? { systemMessage: `sub-human: ${reason}` } : {}),
  hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true },
});
// How this prompt's refusals go out: hidden() when it could carry a PIN (set once per prompt, before any parsing)
let refuse = block;
const fail = msg => { refuse(msg); return null; };

/** A note in a join's message that the person must hear: the room's Claude could not start, or its last start failed. */
const TROUBLE = /· no claude \(|the last start failed: /;

/**
 * A join that worked: the mechanics block for the model. No systemMessage, which Claude Code draws as a warning (the
 * session title and the room row say it worked), unless something in it is one: the room's Claude
 * did not start, or the bypass-permissions warning.
 */
function success(me, lead, msg, input) {
  presence(me, 'working');
  const bypass = input.permission_mode === 'bypassPermissions' && me.role !== 'claude' ? BYPASS : '';
  const warn = bypass || TROUBLE.test(msg) ? `sub-human: ${msg}${bypass}` : null;
  out({
    ...(warn ? { systemMessage: warn } : {}),
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) },
  });
}

/** Close rooms where only the room's Claude is left once they have been orphaned long enough (best effort; host only). */
function sweep() {
  try { identity.pruneModLeases(); } catch { /* the next join retries */ }
  for (const c of identity.orphanRooms()) { try { roomClaude.watchdog(c); } catch { /* next join retries */ } }
}

function others(code, name) {
  const ms = Object.values(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at
    && (m.role !== 'claude' || roomClaudePresence(m) === 'live'));
  return ms.map(m => m.name).join(', ');
}

/** The room Claude's own launch `/sub-human` (or a debugging `/sub-human [ROOM]` in a room-claude agent session). */
function bindRoomClaude(input, base, cur, args) {
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
  const me = { code: c, name: 'claude', role: 'claude', pid: base.pid, session_id: base.session_id || null, address: identity.address('claude', c) };
  return success(me, fresh ? 'room created' : 'claude started', fresh ? `room ${c} open · others join with: /sub-human` : `claude of room ${c}`, input);
}

const hostOnly = (cur, what) => (!cur ? `join a room first (/sub-human); then /sub-human ${what}.`
  : !identity.isHost(cur.code) ? `room ${cur.code} is hosted on another machine; its host does that.` : null);

// ---------- invite ----------
/** `/sub-human invite [--ssh [DEST]] [--via J] | --web | --public | --url U [--port P] | --pipe | --stop | --cancel [REF]`. */
function invite(cur, argv) {
  const why = hostOnly(cur, 'invite gives an invite to it');
  if (why) return refuse(why);
  const p = parseArgs(argv, { ssh: '?', via: 1, web: 0, public: 0, url: 1, port: 1, pipe: 0, stop: 0, cancel: '?' });
  const f = p.flags;
  const bad = p.error ? p.error.split(' ')[0] : p.rest.length ? p.rest[0] : f.port !== undefined && !/^[0-9]{1,5}$/.test(f.port) ? '--port' : null;
  if (bad !== null) return refuse(`${INVITE_USAGE} ("${bad}"?)`);
  const web = !!(f.web || f.public || f.url !== undefined);
  const ways = [f.ssh !== undefined || f.via !== undefined, web, !!f.pipe, !!f.stop, f.cancel !== undefined].filter(Boolean).length;
  if (ways > 1) return refuse(`pick one: ${INVITE_USAGE}`);
  try {
    if (f.stop) return hidden(require('../lib/remote/webhost.js').unhost(cur.code).text, { shareable: true });
    if (f.cancel !== undefined) return hidden(hosting.cancelInvite(cur.code, f.cancel === true ? undefined : f.cancel).text, { shareable: true });
    const r = web
      ? require('../lib/remote/webhost.js').hostWeb(cur.code, { tailscale: !!(f.web || f.public), funnel: !!f.public, url: f.url, port: f.port !== undefined ? Number(f.port) : undefined, by: cur.name })
      : hosting.hostInvite(cur.code, { ssh: f.pipe ? undefined : f.ssh === undefined ? true : f.ssh, via: f.via, pipe: !!f.pipe, by: cur.name });
    // the block reason only (this terminal, never the model): not a systemMessage, which Remote Control would carry off
    return hidden(r.text);
  } catch (e) { return refuse(e.message); }
}

// ---------- admit, kick, leave ----------
/** `/sub-human admit [REF]`: the host's consent, as the card gives it. */
function admit(cur, argv) {
  const why = hostOnly(cur, 'admit lets in someone waiting to join it');
  if (why) return refuse(why);
  if (argv.length > 1 || (argv[0] && !/^[0-9a-f]{6,12}$/.test(argv[0]))) return refuse('usage: /sub-human admit [REF] (no REF: who is waiting)');
  try {
    const adm = require('../lib/remote/admission.js');
    if (!argv.length) {
      const reqs = adm.pending(cur.code);
      return hidden(reqs.length ? `waiting to join room ${cur.code}: ${reqs.map(q => `${adm.describe(q)}: /sub-human admit ${q.ref}`).join('; ')}` : `nobody is waiting to join room ${cur.code}.`, { shareable: true });
    }
    const sign = p => envelope.sign(p, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name });
    return hidden(adm.letIn(cur.code, argv[0], { by: cur.name, sign }).text, { shareable: true });
  } catch (e) { return refuse(e.message); }
}

/** `/sub-human kick NAME`: end the connection NAME joined over. */
function kick(cur, argv) {
  const why = hostOnly(cur, 'kick NAME ends their connection');
  if (why) return refuse(why);
  if (argv.length !== 1) return refuse('usage: /sub-human kick NAME (someone who joined from another machine)');
  if (argv[0] === cur.name) return refuse('that is you; /sub-human leave leaves the room.');
  try { return hidden(hosting.kick(cur.code, argv[0]).text, { shareable: true }); } catch (e) { return refuse(e.message); }
}

/** `/sub-human leave`: exactly as exiting the session would, without /exit. The tail goes quiet with the seat. */
function leave(cur, argv) {
  if (argv.length) return refuse('usage: /sub-human leave');
  if (!cur) return refuse('this session is not in a room.');
  seats.exit(cur.code, cur.name, 'left');
  return block(`you left room ${cur.code}. /sub-human joins again.`);
}

// ---------- doctor, help ----------
function doctor(argv) {
  if (argv.includes('--fix') || argv.includes('--bundle')) return refuse(`${argv.includes('--fix') ? '--fix' : '--bundle'} changes or writes files: run sub-human doctor ${argv.join(' ')} in a terminal outside Claude Code.`);
  if (argv.length) return refuse('usage: /sub-human doctor');
  const path = require('node:path');
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sub-human'), 'doctor', '--quick'], {
    encoding: 'utf8', timeout: 8000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return hidden(text || `doctor did not finish (${r.error ? r.error.message : `exit ${r.status}`}); run sub-human doctor in a terminal.`, { shareable: true });
}

// ---------- handoff ----------
/** `/sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]`: ask NAME to host the room cur is in. */
function askHandoff(cur, argv) {
  if (!cur) return block('join a room first; /sub-human handoff NAME then asks NAME to host it.');
  const p = parseArgs(argv, { via: 1 });
  if (p.error || p.rest.length < 1 || p.rest.length > 2) return block('usage: /sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]');
  const [to, dest] = p.rest;
  const via = p.flags.via;
  let locator;
  if (/^https?:\/\//.test(dest || '')) { // a front to the new host's web listener (lib/remote/webhost.js)
    if (via !== undefined) return block('--via is for an ssh address (USER@HOST[:PORT] --via JUMP), not a web front.');
    try { locator = require('../lib/remote/webhost.js').webLocator(dest, cur.code); } catch (e) { return block(e.message); }
  } else {
    if (via !== undefined && dest === undefined) return block('--via goes with the ssh address the others reach the new host at: /sub-human handoff NAME USER@HOST --via JUMP');
    locator = dest === undefined ? undefined : link.sshLocator(dest, via !== undefined ? { via } : {});
  }
  if (dest !== undefined && !locator) {
    return block(via !== undefined && link.sshLocator(dest)
      ? `--via "${via}" is not a plain [USER@]HOST[:PORT] (comma-separated hops).`
      : `"${dest}" is not a plain USER@HOST[:PORT] (or https://FRONT) the others can reach ${to}'s machine at.`);
  }
  let d;
  try {
    d = handoff.ask(cur.code, { from: cur.name, to, locator, sign: q => envelope.sign(q, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name }) });
  } catch (e) {
    if (!(e instanceof room.RoomError)) throw e;
    return block(`could not hand room ${cur.code} off: ${e.message}.`);
  }
  return out({ decision: 'block', reason: `sub-human: asked ${to} to host room ${cur.code}. Their Claude shows them a card; nothing moves unless they agree there (until ${d.expires_at.slice(11, 16)} UTC). If they do, the room's log, links and claude move to their machine, the room's Claude then runs on ${to}'s model account, and this machine follows as a member.` });
}

// ---------- join ----------
const YOU_HINT = d => `"${d}" still has the example's placeholder: put your user name on that machine in place of ${d.split('@')[0]} (or just the ssh alias, e.g. dev)`;
const sameLogin = (a, b) => !!a && !!b && a.login === true && ['user', 'host', 'port', 'via', 'remoteHome'].every(k => a[k] === b[k]);

/** A daemon still dialing the old host: stop it, so the start that follows dials the link file's new one. */
function restartLink(code) {
  const st = link.status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  for (const until = Date.now() + 2000; Date.now() < until && identity.isAlive(st.pid);) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

// the locator a link's transport came from (with its jump hosts: else every re-join over a bastion reads as a move)
const locatorOf = t => (t && t.kind === 'ssh' ? link.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`, t.via ? { via: t.via } : {}) : t && t.kind === 'pipe' ? link.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

/** A name typed with --as: checked; else the default name. null after a refuse(). */
function nameFor(as, cwd) {
  if (as !== undefined) {
    if (!identity.NAME_RE.test(as)) return fail(`invalid name "${as}" (letters, digits, . _ -, up to 32)`);
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
function join(argv, cwd) {
  const p = parseArgs(argv, { as: 1, via: 1, home: 1 });
  if (p.error) return fail(`${p.error}. ${JOIN_USAGE}`);
  const flag = p.rest.find(a => a.startsWith('--'));
  if (flag) return fail(`"${flag}" is not a join flag. ${JOIN_USAGE}`);
  const r = p.rest;
  const { via, home } = p.flags;
  if (/^https?:\/\//.test(r[0] || '')) {
    if (r.length !== 2) return fail(r.length < 2 ? 'a web join needs the PIN the host sent with the URL: /sub-human join URL PIN' : JOIN_USAGE);
    if (via !== undefined || home !== undefined) return fail('--via and --home are for an ssh address, not a URL');
    if (!auth.SHORT_PIN_RE.test(r[1])) return fail('the PIN is the 4 digits that came with the invite: /sub-human join URL PIN');
    const m = /^(https?):\/\/([^#\s]+)$/.exec(r[0]);
    const spec = m && wsT().parse(`//${m[2].replace(/\/+$/, '')}`);
    const code = spec && spec.path.split('/').filter(Boolean).pop();
    if (!spec || !identity.CODE_RE.test(code || '')) return fail('that is not a join URL (https://HOST/…/sub-human/ROOM); ask the host to copy the whole line');
    const name = nameFor(p.flags.as, cwd);
    if (!name) return null;
    return linkShort({ name, code, pin: r[1], transport: link.transportOf(wsT().locator(spec, m[1] === 'https')) });
  }
  if (r.length < 2 || r.length > 3) return fail(r.length === 1 ? `which room? ${JOIN_USAGE}` : JOIN_USAGE);
  const [dest, code, pin] = r;
  if (!identity.CODE_RE.test(code)) return fail(`"${code}" is not a room (like vole-8126). ${JOIN_USAGE}`);
  if (pin !== undefined) {
    if (!auth.SHORT_PIN_RE.test(pin)) return fail('the PIN is the 4 digits that came with the invite: /sub-human join HOST ROOM PIN');
    if (home !== undefined) return fail('--home is for a join over your own ssh login (no PIN): /sub-human join HOST ROOM --home PATH');
    const name = nameFor(p.flags.as, cwd);
    if (!name) return null;
    if (/^pipe:\//.test(dest) || dest.startsWith('/')) { // a second home on this machine (tests, the demo)
      if (via !== undefined) return fail('--via is for an ssh address');
      const transport = link.transportOf(dest.startsWith('/') ? `pipe:${dest}` : dest);
      return transport ? linkShort({ name, code, pin, transport }) : fail(`"${dest}" is not a sub-human home on this machine`);
    }
    if (sshT().placeholder(dest)) return fail(YOU_HINT(dest));
    const loc = link.sshLocator(sshT().withUser(dest), via !== undefined ? { via } : {});
    if (!loc) return fail(via !== undefined && link.sshLocator(dest) ? `--via "${via}" is not a plain [USER@]HOST[:PORT] list` : `"${dest}" is not a plain USER@HOST[:PORT] or ssh alias`);
    return linkShort({ name, code, pin, transport: link.transportOf(loc) });
  }
  return linkLogin({ dest, code, via, home, as: p.flags.as, cwd });
}

/** An invite's PIN: link only, the PAKE in the link daemon; always a hidden reply. */
function linkShort({ name, code, pin, transport }) {
  if (identity.roomExists(code) && identity.isHost(code)) return fail(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur = links.get(code);
  if (cur && cur.token && locatorOf(cur.transport) === locatorOf(transport)) {
    return hidden(`this machine is linked to room ${code} already: /sub-human ${name} ${code}`);
  }
  if (cur) restartLink(code); // a pending join replaced, or the room's host moved: dial with the new file
  try { hosting.joinShort({ code, transport, pin, name }); } catch (e) { return fail(e.message); }
  if (cur) links.set(code, { ...links.get(code), rebind: true }); // a seat here joins again over the new link
  if (!link.start(code)) return fail(`the link to room ${code} did not start; run /sub-human doctor`);
  hidden(hosting.joinText(code, name, hosting.outcome(code)));
  return null;
}

/** `/sub-human join HOST ROOM [--via J] [--home P]`: link over the person's own ssh login; {name, code} once linked
 * (the caller takes the seat), or null after a refusal. */
function linkLogin({ dest: typed, code, via, home, as, cwd }) {
  if (sshT().placeholder(typed)) return fail(YOU_HINT(typed));
  const dest = sshT().withUser(typed);
  if (!sshT().dest(dest)) return fail(`"${dest}" is not a plain USER@HOST[:PORT] or ssh alias. ${JOIN_USAGE}`);
  if (via !== undefined && !sshT().jump(via)) return fail(`--via "${via}" is not a plain [USER@]HOST[:PORT] (comma-separated hops).`);
  const spec = sshT().loginSpec(dest, { via, home });
  if (!spec) return fail(`--home "${home}" is not a plain absolute path (the host's sub-human home, e.g. /home/you/.sub-human).`);
  const name = nameFor(as, cwd);
  if (!name) return null;
  if (identity.roomExists(code) && identity.isHost(code)) return fail(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  const spent = (link.stopReason(link.status(code)) || {}).code === 'AUTH'; // kicked, or a host key changed: link anew
  if (cur && cur.token && sameLogin(cur.transport, spec) && !spent) return { name, code, isDefault: as === undefined }; // linked this way already: just the seat
  if (cur) restartLink(code); // a link replaced (another way in, or a refused one): dial with the new file
  const mux = cur && cur.transport && cur.transport.mux === true && cur.transport.user === spec.user && cur.transport.host === spec.host && cur.transport.port === spec.port;
  try {
    links.set(code, { code, transport: { ...spec, ...(mux ? { mux: true } : {}) }, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
  } catch (e) { return fail(e.message); }
  if (!link.start(code)) return fail(`the link to room ${code} did not start; run /sub-human doctor`);
  const o = hosting.outcome(code);
  if (o.state === 'refused') return fail(`could not link to room ${code} over ${at}: ${o.reason}`);
  if (o.state !== 'linked') return fail(`the link to room ${code} over ${at} is still connecting${o.reason ? ` (${o.reason})` : ''}; type /sub-human ${name} ${code} in a moment (/sub-human doctor says why if it does not come up)`);
  return { name, code, isDefault: as === undefined };
}

/** A join this machine started with a PIN, waiting to take its seat (join_as): the newest, or null. */
function pendingJoin() {
  const all = links.list().map(c => links.get(c)).filter(l => l && typeof l.join_as === 'string' && !identity.isHost(l.code));
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

/** Bare `/sub-human` with a pending join: {name, code} once the link is up (the caller takes the seat), else null
 * after saying where it stands. */
function finishJoin(l) {
  const code = l.code, name = l.join_as;
  const why = link.stopReason(link.status(code));
  if (why && !l.token) {
    try { const { join_as: _gone, ...rest } = links.get(code) || l; links.set(code, rest); } catch { /* no credential left: nothing to keep */ }
    return fail(`could not join room ${code}: ${why.reason}`);
  }
  if (l.token) return { name, code, pending: true };
  if (!link.start(code)) return fail(`the link to room ${code} did not start; run /sub-human doctor`);
  const o = hosting.outcome(code, { waitMs: 2000 });
  if (o.state === 'linked') return { name, code, pending: true };
  refuse(hosting.joinText(code, name, o));
  return null;
}

/** The single open room, null for none (the caller creates one), or a refusal for several. */
function pickRoom() {
  sweep();
  const open = identity.openRooms();
  if (open.length <= 1) return { code: open[0] || null };
  return fail(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human ${'NAME ROOM'}.`);
}

/** Bare `/sub-human` in a room: who is here, and how to bring someone in. */
function status(cur) {
  const here = others(cur.code, cur.name);
  const host = identity.isHost(cur.code);
  return block(`you are ${cur.name} in room ${cur.code}${here ? ` with ${here}` : ' (nobody else yet)'}. `
    + `${host ? 'Someone on this machine: /sub-human (in their session). Another machine: /sub-human invite. ' : ''}Leave: /sub-human leave. All commands: /sub-human help`);
}

/**
 * Take the seat NAME in ROOM (null: the one open room, else a new one). isDefault: the name was not typed (a taken one
 * says how to pick another). The mechanics block on success.
 */
function take({ name, code, isDefault = false }, { input, base, cur, cwd }) {
  let created = false;
  if (!code) {
    const pick = pickRoom();
    if (!pick) return;
    code = pick.code;
  }
  if (!code) {
    // Check the name before making a room for it.
    if (!identity.NAME_RE.test(name)) return refuse(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(name.toLowerCase())) return refuse(`"${name}" is reserved; pick another name`);
    code = identity.newCode();
    created = true;
  } else {
    if (!identity.roomExists(code)) return refuse(`no room ${code}. Check it, or run /sub-human to open a new room.`);
    if (identity.roomClosing(code)) return refuse(`room ${code} is closing; run /sub-human to open a new room.`);
    const pending = identity.isHost(code) ? null : links.get(code);
    if (pending && !pending.token && (pending.pin !== undefined || pending.enroll || pending.awaiting)) {
      // a join not let in yet: never start it again after a refusal (that would spend another try)
      const why = link.stopReason(link.status(code));
      if (why) return refuse(`could not join ${code}: ${why.reason}`);
      if (!link.start(code)) return refuse(`the link to room ${code} did not start; run /sub-human doctor`);
      const o = hosting.outcome(code, { waitMs: 2000 });
      if (o.state !== 'linked') return refuse(hosting.joinText(code, name, o));
    }
    if (!identity.isHost(code) && !link.start(code)) {
      const why = link.stopReason(link.status(code));
      return refuse(why ? `could not join ${code}: the link to it stopped: ${why.reason}.` : `the link to room ${code} did not start; run /sub-human doctor`);
    }
  }
  const same = cur && cur.code === code && cur.name === name;
  // a link whose credentials a re-point replaced (lib/handoff.js): the seat joins again over it, even if seated
  const rebind = !identity.isHost(code) && !!(links.get(code) || {}).rebind;
  if (same && !rebind) {
    dropJoinAs(code);
    return success(cur, 'already joined', `in room ${cur.code} as ${name}${seats.ensureRoomClaude(code, cwd, name)}`, input);
  }
  // The seat's key (hooks/seat-key.js): via=human posts and answers are signed with it, and the log pins it.
  let pubkey;
  try { pubkey = seatKey.publicPem(code, name); } catch (e) { return refuse(`could not create the seat key for ${name}: ${e.message}`); }
  if (cur && !same) seats.exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  const r = seats.enter({ code, name, ...base, pubkey });
  if (!r.ok) {
    if (isDefault && /^name taken/.test(r.error || '')) return refuse(`"${name}" is taken in room ${code}; pick one: /sub-human NAME${created ? '' : ` ${code}`}`);
    return refuse(`could not join ${code} as ${name}: ${r.error || 'unknown error'}`);
  }
  if (rebind) { const { rebind: _done, ...l } = links.get(code); links.set(code, l); }
  dropJoinAs(code);
  if (identity.isHost(code)) {
    try { require('../lib/remote/webhost.js').ensure(code); } catch { /* best effort */ } // the listener after a reboot
    try { require('../lib/remote/shim.js').refresh(); } catch { /* best effort */ } // the serve shim a login link runs
  }
  const me = { code, name, role: 'member', pid: base.pid, session_id: input.session_id || null, address: identity.address(name, code) };
  const here = others(code, name);
  const msg = created
    ? `opened room ${code} as ${name} · others: /sub-human`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}${here ? ` (${here} here)` : ''}`;
  return success(me, created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', `${msg}${r.note}`, input);
}

/** The seat a pending join waited for is taken: its link file no longer says so. */
function dropJoinAs(code) {
  try {
    const l = identity.isHost(code) ? null : links.get(code);
    if (l && l.join_as !== undefined) { const { join_as: _done, ...rest } = l; links.set(code, rest); }
  } catch { /* a stale join_as only names the seat again */ }
}

run(input => {
  if (!COMMANDS.has(input.command_name)) return;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  // Before anything else: a prompt that could carry a PIN is answered hidden, whatever goes wrong with it.
  refuse = ['join', 'invite', 'admit'].includes(args[0]) || args.some(a => DIGITS.test(a)) ? hidden : block;
  if (!identity.modLeaseOk(input.session_id, identity.claudePid())) {
    return refuse === hidden ? hidden(NO_MODULE) : out({ decision: 'block', reason: NO_MODULE });
  }
  const pid = identity.claudePid();
  if (!pid) return refuse('could not identify this Claude Code process (CLAUDE_PID is not set).');
  const cwd = input.cwd || process.cwd();
  const base = { pid, session_id: input.session_id, cwd };
  const cur = whoami(input);
  const ctx = { input, base, cur, cwd };

  if (input.agent_type === ROOM_CLAUDE_AGENT) return bindRoomClaude(input, base, cur, args);
  if (cur && cur.role === 'claude') return refuse(`this session is the room's Claude of room ${cur.code}; join from another session.`);
  const [verb, ...rest] = args;
  switch (verb) {
    case undefined: {
      if (cur) {
        const l = identity.isHost(cur.code) ? null : links.get(cur.code);
        return l && l.rebind ? take({ name: cur.name, code: cur.code }, ctx) : status(cur);
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
    case 'help': return hidden(HELP, { shareable: true });
    case 'invite': return invite(cur, rest);
    case 'admit': return admit(cur, rest);
    case 'kick': return kick(cur, rest);
    case 'leave': return leave(cur, rest);
    case 'doctor': return doctor(rest);
    case 'handoff': return askHandoff(cur, rest);
    case 'join': {
      const j = join(rest, cwd);
      return j ? take(j, ctx) : undefined;
    }
    default: {
      if (args.length > 2) return refuse(USAGE);
      const [name, code] = args;
      if (!identity.NAME_RE.test(name)) return refuse(`invalid name "${name}" (letters, digits, . _ -, up to 32). ${USAGE}`);
      if (identity.RESERVED.includes(name.toLowerCase())) return refuse(`"${name}" is reserved; pick another name. ${USAGE}`);
      if (code !== undefined && !identity.CODE_RE.test(code)) return refuse(`"${code}" is not a room (like vole-8126). ${USAGE}`);
      return take({ name, code: code || (cur && cur.name === name ? cur.code : null) }, ctx);
    }
  }
});

module.exports = { HELP };
