#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): bind this session's identity before the model runs; the model never
// chooses it. `/sub-human NAME [CODE]` joins CODE (else the one open room, else a new one) as NAME, leaving any other
// room, and (re)starts the room's Claude without waiting for it (lib/room-claude.js claimSpawn). Bare `/sub-human` binds the
// room Claude's own session (agent_type sub-human:room-claude + SUB_HUMAN_ROOM), else explains usage. Creates the seat
// key (hooks/seat-key.js). Out: the mechanics block (common.js contextBlock; a systemMessage only for a refusal or the
// bypass-permissions warning: Claude Code draws one as a warning, and Remote Control shows it); the title
// comes on the next prompt (mod/prompt.mjs), since UserPromptExpansion has no sessionTitle. Failure blocks the
// prompt with a reason, no model turn. A seat needs the hooks module (its guard, prompt gate and delivery), so
// without a fresh hello lease for this session (identity.modLeaseOk) the join is refused with NO_MODULE.
// The seat key is made before the seat; its public key rides on member_joined, which pins it for the room's life
// (lib/room/envelope.js): a join whose key differs from the one pinned for that name is refused (RoomError AUTH)
// and the seat is given back. Entering and leaving are lib/seats.js (enter, exit, ensureRoomClaude); claude, orch, room, all,
// system, host, join, admit, revoke, handoff and unhost are reserved names.
// `/sub-human host [--ssh [USER@HOST[:PORT]]] [--via JUMP]`: an sh2 invite to the room this session is in and its
// PIN (host only; lib/remote/hosting.js hostInvite), for one machine, shown to the person once: a block reason
// (with suppressOriginalPrompt) never reaches the model. `/sub-human admit REQUEST` (host): let a joiner's ssh key
// in for the invite it names (hosting.admit); `/sub-human revoke LINK|NAME|INVITE_REF|INVITE` (host): end a link, or burn one unused invite (hosting.revoke).
// `/sub-human host --tailscale [--funnel]` / `--url URL`: the same over the web (lib/remote/webhost.js hostWeb): the
// listener, Tailscale Serve (or opt-in Funnel) or a front of the person's own, and a join URL
// https://HOST/…/sub-human/CODE#SECRET.HOSTKEY with its PIN, hidden from the model the same way; `/sub-human unhost`
// stops serving the room over the web. A join URL is an sh2 invite in another form
// (lib/remote/transports/ws.js parseJoinUrl): `/sub-human join NAME https://… PIN` takes the sh2 path below, with
// no admit step (the secret, the PIN and the pinned listener key are the admission).
// `/sub-human join NAME INVITE [PIN]`: a room hosted on another machine (an invite over ssh:, or pipe: for a
// second home here). sh1 (no PIN): the link file (lib/room/links.js) from the invite, the link daemon started
// (lib/remote/link.js start; it redeems the invite), then the join as above over the link (the host logs it and
// runs the room's Claude). sh2 (a PIN): the typed prompt holds the PIN, so this step always blocks with suppressOriginalPrompt
// and the model never sees the invite or the PIN: the link file (with the PIN, until the host has checked it) and,
// over ssh, the link's own key and the pinned host key (hosting.joinInvite), the daemon started and its first hello
// watched (hosting.outcome); the block says what next: "/sub-human NAME CODE" once linked, the admit line to send
// the host over ssh, or the refusal (a wrong PIN and the tries left). A room this machine links to is joined with
// `/sub-human NAME CODE`. OFFLINE, AUTH and the like block the prompt with the reason. An invite whose locator is not
// the link's (the room moved to another host, lib/handoff.js) replaces the link's credentials, and the seat joins again
// over it; an invite to a room this machine hosts says how to demote it (an old host the room was promoted away from).
// `/sub-human join NAME USER@HOST[:PORT] CODE [--via JUMP] [--home PATH]` (the third word holds an "@" and is no invite
// or URL): the person can already ssh to the host's account, so that login is the admission: no invite, PIN or admit.
// The link file names the host's stable shim (lib/remote/transports/ssh.js loginSpec; --home: the host's sub-human
// home when it is not ~/.sub-human), the daemon is started and its first hello watched (hosting.outcome); once
// linked, the seat is taken in the same step (nothing secret is in this prompt, and no host step waits), else the
// block says why (an unknown host key: the exact `ssh USER@HOST` to run once; no shim on the host: what to run there).
// A host joining its own room refreshes the stable serve shim passively (lib/remote/shim.js), so a login link finds it.
// `/sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]`: the host asks NAME (a member on another machine) to host the room
// (lib/handoff.js ask, signed with this seat's key); NAME's Claude shows them a card, and only their answer there
// moves the room. The reply is a block reason, to the person only.
const { identity, room, out, run, whoami, presence, contextBlock } = require('./common.js');
const roomClaude = require('../lib/room-claude.js');
const seats = require('../lib/seats.js');
const auth = require('../lib/remote/auth.js');
const link = require('../lib/remote/link.js');
const links = require('../lib/room/links.js');
const hosting = require('../lib/remote/hosting.js');
const wsT = () => require('../lib/remote/transports/ws.js');
const seatKey = require('./seat-key.js');
const handoff = require('../lib/handoff.js');
const envelope = require('../lib/room/envelope.js');
const store = require('../lib/room/store.js');
const { roomClaudePresence } = require('../lib/room/members.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ROOM_CLAUDE_AGENT = 'sub-human:room-claude';
const USAGE = 'usage: /sub-human NAME [CODE]. It joins the open room as NAME, or opens one and starts the room\'s Claude for you (it is never launched by hand). '
  + '/sub-human host [--ssh [USER@HOST]] [--via JUMP] gives an invite and its PIN for your room; /sub-human admit shk1.… lets a joiner\'s key in, /sub-human revoke NAME ends its link (or revoke REF, one leaked invite); /sub-human join NAME USER@HOST CODE joins a room on a machine you can already ssh to, /sub-human join NAME INVITE PIN one you were invited to; /sub-human handoff NAME asks NAME to host your room.';
const BYPASS = ' · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live';
// A refusal is also the systemMessage: Remote Control shows a hook's systemMessage, not a block reason.
const block = reason => out({ decision: 'block', reason: `sub-human: ${reason}`, systemMessage: `sub-human: ${reason}` });
// What only the person may read (an invite, a PIN they typed): the block reason alone, and the typed prompt hidden
// from the conversation (suppressOriginalPrompt travels with a block only). shareable: also the systemMessage
// (Remote Control shows it), for text that holds no secret.
const hidden = (reason, { shareable = false } = {}) => out({
  decision: 'block', reason: `sub-human: ${reason}`, ...(shareable ? { systemMessage: `sub-human: ${reason}` } : {}),
  hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true },
});
const NO_MODULE = 'sub-human needs Claude Code 2.1.292+ with function hooks on; not in --bare or safe mode';

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

/** The room Claude's own launch `/sub-human` (or a debugging `/sub-human [CODE]` in a room-claude agent session). */
function bindRoomClaude(input, base, cur, args) {
  if (args.length > 1 || (args[0] && !identity.CODE_RE.test(args[0]))) {
    return block('this session runs the room\'s Claude agent; members join from their own sessions with /sub-human NAME.');
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
  return success(me, fresh ? 'room created' : 'claude started', fresh ? `room ${c} open · others join with: /sub-human NAME ${c}` : `claude of room ${c}`, input);
}

/** `--ssh [DEST] --via JUMP` (or `--tailscale [--funnel]`, `--url URL`, `--port P`) of /sub-human host: the flags,
 * or null after a block(). */
function hostFlags(rest) {
  const p = require('../lib/cli/args.js').parse(rest, { ssh: '?', via: 1, tailscale: 0, funnel: 0, url: 1, port: 1 });
  const f = p.flags;
  const bad = p.error ? p.error.split(' ')[0] : p.rest.length ? p.rest[0] : f.port !== undefined && !/^[0-9]{1,5}$/.test(f.port) ? '--port' : null;
  if (bad !== null) { block(`usage: /sub-human host [--ssh [USER@HOST[:PORT]]] [--via JUMP] | --tailscale [--funnel] | --url https://FRONT ("${bad}"?)`); return null; }
  if (f.port !== undefined) f.port = Number(f.port);
  const web = f.tailscale || f.funnel || f.url !== undefined;
  if (web && (f.ssh !== undefined || f.via !== undefined)) { block('--ssh and --tailscale / --url are different ways in; pick one'); return null; }
  return { ...f, web };
}

/** `/sub-human host [--ssh [DEST]] [--via JUMP]`: an sh2 invite and its PIN to the room cur is in, for one machine. */
function host(cur, rest) {
  if (!cur) return block('join a room first (/sub-human NAME); /sub-human host then gives an invite to it.');
  if (!identity.isHost(cur.code)) return block(`room ${cur.code} is hosted on another machine; its host gives the invites.`);
  const f = hostFlags(rest);
  if (!f) return undefined;
  let r;
  try {
    r = f.web
      ? require('../lib/remote/webhost.js').hostWeb(cur.code, { tailscale: !!f.tailscale, funnel: !!f.funnel, url: f.url, port: f.port })
      : hosting.hostInvite(cur.code, { ssh: f.ssh, via: f.via });
  } catch (e) { return block(e.message); }
  // the block reason only (this terminal, never the model): not a systemMessage, which Remote Control would carry off
  return hidden(r.text);
}

/** `/sub-human admit REQUEST`, `/sub-human revoke LINK|NAME|INVITE_REF|INVITE`: the host's consent, and its undo. */
function hostAction(cur, args) {
  try {
    if (args[0] === 'admit') {
      if (args.length !== 2) return block('usage: /sub-human admit shk1.CODE.REF.KEY.NAME (the line a joiner\'s /sub-human join showed them)');
      return hidden(hosting.admit(args[1]).text, { shareable: true });
    }
    if (args.length !== 2) return block('usage: /sub-human revoke LINK_ID|NAME|INVITE_REF|INVITE (in the room hosted here)');
    if (!cur) return block('revoke from a session in the room: /sub-human NAME first.');
    return hidden(hosting.revoke(cur.code, args[1]).text, { shareable: true });
  } catch (e) { return block(e.message); }
}

/** `/sub-human join NAME sh2… PIN`: link only, then tell the person the next step. Always a hidden block. */
function linkInvite2(inv, invite, pin, name) {
  if (!identity.NAME_RE.test(name)) return hidden(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (!pin) return hidden('this invite needs the 6-digit PIN the host was shown with it: /sub-human join NAME INVITE PIN');
  if (!auth.PIN_RE.test(pin)) return hidden('the PIN is 6 digits: /sub-human join NAME INVITE PIN');
  if (identity.roomExists(inv.code) && identity.isHost(inv.code)) return hidden(`room ${inv.code} is hosted on this machine; join it with /sub-human ${name} ${inv.code}.`);
  const cur = links.get(inv.code);
  const moved = !!cur && !!cur.token && locatorOf(cur.transport) !== inv.locator; // the room moved (lib/handoff.js)
  if (cur && cur.token && !moved) {
    return hidden(`this machine is linked to room ${inv.code} already: /sub-human ${name} ${inv.code}`, { shareable: true });
  }
  if (cur) restartLink(inv.code); // a link replaced (a pending invite, or the room moved): dial with the new file
  let j;
  try { j = hosting.joinInvite({ inv, invite, pin, name }); } catch (e) { return hidden(e.message, { shareable: true }); }
  if (cur) links.set(inv.code, { ...links.get(inv.code), rebind: true }); // the seat joins again over the new link
  if (!link.start(inv.code)) return hidden(`the link to room ${inv.code} did not start; its log is ${links.logFile(inv.code)}.`, { shareable: true });
  return hidden(hosting.joinText(inv.code, name, hosting.outcome(inv.code), j.request), { shareable: true });
}

/** `/sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]`: ask NAME to host the room cur is in. */
function askHandoff(cur, argv) {
  if (!cur) return block('join a room first; /sub-human handoff NAME then asks NAME to host it.');
  const p = require('../lib/cli/args.js').parse(argv, { via: 1 });
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
    d = handoff.ask(cur.code, { from: cur.name, to, locator, sign: p => envelope.sign(p, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name }) });
  } catch (e) {
    if (!(e instanceof room.RoomError)) throw e;
    return block(`could not hand room ${cur.code} off: ${e.message}.`);
  }
  return out({ decision: 'block', reason: `sub-human: asked ${to} to host room ${cur.code}. Their Claude shows them a card; nothing moves unless they agree there (until ${d.expires_at.slice(11, 16)} UTC). If they do, the room's log, links and claude move to their machine, the room's Claude then runs on ${to}'s model account, and this machine follows as a member.` });
}

const sshT = () => require('../lib/remote/transports/ssh.js');
/** The third word of `/sub-human join NAME X …` names an ssh login (USER@HOST[:PORT]), not an invite or a join URL. */
const loginForm = word => /@/.test(word) && !/^https?:\/\//.test(word) && !auth.parseInvite(word);
const LOGIN_USAGE = 'usage: /sub-human join NAME USER@HOST[:PORT] CODE [--via JUMP] [--home PATH] (when you can already ssh to USER@HOST; else ask the host for an invite: /sub-human join NAME INVITE PIN)';
const sameLogin = (a, b) => !!a && !!b && a.login === true && ['user', 'host', 'port', 'via', 'remoteHome'].every(k => a[k] === b[k]);

/** `/sub-human join NAME USER@HOST[:PORT] CODE [--via J] [--home P]`: link over the person's own ssh login; {name, code}
 * once linked (the caller takes the seat), or null after a block(). */
function linkLogin(argv) {
  const p = require('../lib/cli/args.js').parse(argv, { via: 1, home: 1 });
  if (p.error || p.rest.length !== 3) { block(LOGIN_USAGE); return null; }
  const [name, dest, code] = p.rest;
  const { via, home } = p.flags;
  const fail = msg => { block(msg); return null; };
  if (!identity.NAME_RE.test(name)) return fail(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (identity.RESERVED.includes(name.toLowerCase())) return fail(`"${name}" is reserved`);
  if (!identity.CODE_RE.test(code)) return fail(`"${code}" is not a room code (like vole-8126). ${LOGIN_USAGE}`);
  if (!sshT().dest(dest)) return fail(`"${dest}" is not a plain USER@HOST[:PORT]. ${LOGIN_USAGE}`);
  if (via !== undefined && !sshT().jump(via)) return fail(`--via "${via}" is not a plain [USER@]HOST[:PORT] (comma-separated hops).`);
  const spec = sshT().loginSpec(dest, { via, home });
  if (!spec) return fail(`--home "${home}" is not a plain absolute path (the host's sub-human home, e.g. /home/you/.sub-human).`);
  if (identity.roomExists(code) && identity.isHost(code)) return fail(`room ${code} is hosted on this machine; join it with /sub-human ${name} ${code}.`);
  const cur = links.get(code);
  const at = sshT().kind.describe(spec); // "ssh you@host … (your ssh login)"
  if (cur && cur.token && sameLogin(cur.transport, spec)) return { name, code }; // linked this way already: just the seat
  if (cur) restartLink(code); // a link replaced (another way in, or a refused one): dial with the new file
  const mux = cur && cur.transport && cur.transport.mux === true && cur.transport.user === spec.user && cur.transport.host === spec.host && cur.transport.port === spec.port;
  try {
    links.set(code, { code, transport: { ...spec, ...(mux ? { mux: true } : {}) }, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
  } catch (e) { return fail(e.message); }
  if (!link.start(code)) return fail(`the link to room ${code} did not start; its log is ${links.logFile(code)}.`);
  const o = hosting.outcome(code);
  if (o.state === 'refused') return fail(`could not link to room ${code} over ${at}: ${o.reason}`);
  if (o.state !== 'linked') return fail(`the link to room ${code} over ${at} is still connecting${o.reason ? ` (${o.reason})` : ''}; type /sub-human ${name} ${code} in a moment (sub-human doctor says why if it does not come up)`);
  return { name, code };
}

/** A daemon still dialing the old host: stop it, so the start that follows dials the link file's new one. */
function restartLink(code) {
  const st = link.status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  for (const until = Date.now() + 2000; Date.now() < until && identity.isAlive(st.pid);) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

// the invite locator a link's transport came from (with its jump hosts: else every re-join over a bastion reads as a move)
const locatorOf = t => (t && t.kind === 'ssh' ? link.sshLocator(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`, t.via ? { via: t.via } : {}) : t && t.kind === 'pipe' ? link.pipeLocator(t.home)
  : t && (t.kind === 'wss' || t.kind === 'ws') ? wsT().urlOf(t) : null);

/** The link file for an invite's room (kept once it holds a token, unless the invite is to another host); its code, or null after a block(). */
function linkRoom(invite) {
  const inv = auth.parseInvite(invite);
  if (!inv) return block('that is not an invite (sh2.CODE.LOCATOR.SECRET.KEY, or sh1); ask the host for one: /sub-human host.');
  const transport = link.transportOf(inv.locator);
  if (!transport && inv.locator.startsWith('ssh:')) return block('this invite names an ssh destination that is not a plain user@host[:port]; ask the host for a new one.');
  if (!transport) return block(`this invite reaches its room through "${inv.locator.split(':')[0]}", which this machine does not support yet.`);
  if (transport.kind === 'wss' || transport.kind === 'ws') return block('a web invite comes with its PIN and a pinned key (sh2); ask the host for one: /sub-human host --tailscale.');
  if (identity.roomExists(inv.code) && identity.isHost(inv.code)) {
    return block(`room ${inv.code} is hosted on this machine; join it with /sub-human NAME ${inv.code}. If it was promoted on another machine while this one was away, run in a terminal outside Claude Code (not with !): sub-human demote ${inv.code} INVITE PIN (this machine's own lines are kept aside, never merged).`);
  }
  const cur = links.get(inv.code);
  const moved = !!cur && !!cur.token && locatorOf(cur.transport) !== inv.locator;
  if (!cur || !cur.token || moved) {
    links.set(inv.code, { code: inv.code, transport, invite, created_at: new Date().toISOString(), ...(cur ? { rebind: true } : {}) });
    if (cur) restartLink(inv.code);
  }
  return inv.code;
}

/** The single open room, null for none (the caller creates one), or a block() for several. */
function pickRoom() {
  sweep();
  const open = identity.openRooms();
  if (open.length <= 1) return { code: open[0] || null };
  block(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human NAME CODE.`);
  return null;
}

run(input => {
  if (!COMMANDS.has(input.command_name)) return;
  if (!identity.modLeaseOk(input.session_id, identity.claudePid())) return out({ decision: 'block', reason: NO_MODULE });
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  const pid = identity.claudePid();
  if (!pid) return block('could not identify this Claude Code process (CLAUDE_PID is not set).');
  const cwd = input.cwd || process.cwd();
  const base = { pid, session_id: input.session_id, cwd };
  const cur = whoami(input);

  if (input.agent_type === ROOM_CLAUDE_AGENT) return bindRoomClaude(input, base, cur, args);
  if (args.length === 0) {
    if (cur && cur.role !== 'claude') return block(`you are ${cur.name} in room ${cur.code} (address ${cur.name}.${cur.code}). ${USAGE}`);
    return block(USAGE);
  }
  if (cur && cur.role === 'claude') return block(`this session is the room's Claude of room ${cur.code}; join from another session.`);
  if (args[0] === 'handoff' && args.length >= 2) return askHandoff(cur, args.slice(1));
  if (args[0] === 'host') return host(cur, args.slice(1));
  if (args[0] === 'admit' || args[0] === 'revoke') return hostAction(cur, args);
  if (args[0] === 'unhost') {
    if (!cur) return block('unhost from a session in the room: /sub-human NAME first.');
    if (args.length !== 1) return block('usage: /sub-human unhost (stops serving this room over the web)');
    try { return hidden(require('../lib/remote/webhost.js').unhost(cur.code).text, { shareable: true }); } catch (e) { return block(e.message); }
  }
  const remote = args[0] === 'join';
  let login = null;
  if (remote && args.length >= 3 && loginForm(args[2])) {
    login = linkLogin(args.slice(1));
    if (!login) return;
  } else if (remote && args.length >= 3) {
    // a PIN may be in this prompt: whatever happens, it is hidden from the model
    const url = /^https?:\/\//.test(args[2]) ? wsT().parseJoinUrl(args[2]) : null; // a join URL: an sh2 invite
    const inv = url || auth.parseInvite(args[2]);
    if (args.length > 4) return hidden('usage: /sub-human join NAME INVITE PIN');
    if (/^https?:\/\//.test(args[2]) && !url) return hidden('that link is not a whole join URL (https://HOST/…/CODE#SECRET.KEY); ask the host to copy all of it');
    if (inv && inv.v === 2) return linkInvite2(inv, url ? url.invite : args[2], args[3], args[1]);
    if (args.length === 4) return hidden(inv ? 'this invite (sh1) takes no PIN: /sub-human join NAME INVITE' : 'that is not an invite (sh2.…); ask the host for one: /sub-human host.');
  }
  if (!login && (remote ? args.length !== 3 : args.length > 2)) return block(USAGE);
  const name = login ? login.name : remote ? args[1] : args[0];

  let code = login ? login.code : remote ? linkRoom(args[2]) : args[1] || (cur && cur.name === name ? cur.code : null);
  if (remote && !code) return;
  let created = false;
  if (!code) {
    const pick = pickRoom();
    if (!pick) return;
    code = pick.code;
  }
  if (!code) {
    // Check the name before making a room for it.
    if (!identity.NAME_RE.test(name)) return block(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(name.toLowerCase())) return block(`"${name}" is reserved`);
    code = identity.newCode();
    created = true;
  } else {
    if (!identity.roomExists(code)) return block(`no room ${code}. Check the code, or run /sub-human ${name} to open a new room.`);
    if (identity.roomClosing(code)) return block(`room ${code} is closing; run /sub-human ${name} to open a new room.`);
    const pending = identity.isHost(code) ? null : links.get(code);
    if (pending && !pending.token && pending.pin !== undefined) {
      // an sh2 link not redeemed yet: never start it again after a refusal (that would spend another PIN try)
      const why = link.stopReason(link.status(code));
      if (why) return block(`could not join ${code}: ${why.reason}`);
      if (!link.start(code)) return block(`the link to room ${code} did not start; its log is ${links.logFile(code)}.`);
      const o = hosting.outcome(code, { waitMs: 2000 });
      if (o.state !== 'linked') return block(hosting.joinText(code, name, o, pending.request));
    }
    if (!identity.isHost(code) && !link.start(code)) {
      const why = link.stopReason(link.status(code));
      return block(why ? `could not join ${code}: the link to it stopped: ${why.reason}.` : `the link to room ${code} did not start; its log is ${links.logFile(code)}.`);
    }
  }
  const same = cur && cur.code === code && cur.name === name;
  // a link whose credentials a re-point replaced (lib/handoff.js): the seat joins again over it, even if seated
  const rebind = !identity.isHost(code) && !!(links.get(code) || {}).rebind;
  if (same && !rebind) {
    return success(cur, 'already joined', `in room ${cur.code} as ${name}${seats.ensureRoomClaude(code, cwd, name)}`, input);
  }
  if (cur && !same) seats.exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  // The seat's key (hooks/seat-key.js): via=human posts and answers are signed with it, and the log pins it.
  let pubkey;
  try { pubkey = seatKey.publicPem(code, name); } catch (e) { return block(`could not create the seat key for ${name}: ${e.message}`); }
  const r = seats.enter({ code, name, ...base, pubkey });
  if (!r.ok) return block(`could not join ${code} as ${name}: ${r.error || 'unknown error'}`);
  if (rebind) { const { rebind: _done, ...l } = links.get(code); links.set(code, l); }
  if (identity.isHost(code)) {
    try { require('../lib/remote/webhost.js').ensure(code); } catch { /* best effort */ } // the listener after a reboot
    try { require('../lib/remote/shim.js').refresh(); } catch { /* best effort */ } // the serve shim a login link runs
  }
  const me = { code, name, role: 'member', pid, session_id: input.session_id || null, address: identity.address(name, code) };
  const here = others(code, name);
  const msg = created
    ? `opened room ${code} as ${name} · others: /sub-human NAME`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}${here ? ` (${here} here)` : ''}`;
  success(me, created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', `${msg}${r.note}`, input);
});
