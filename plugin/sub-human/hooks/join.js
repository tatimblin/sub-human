#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): bind this session's identity before the model runs; the model never
// chooses it. `/sub-human NAME [CODE]` joins CODE (else the one open room, else a new one) as NAME, leaving any other
// room, and (re)starts a room's orch without waiting for it (lib/orch.js claimSpawn). Bare `/sub-human` binds the
// orch's own session (agent_type sub-human:orchestrator + SUB_HUMAN_ROOM), else explains usage. Creates the seat
// key (hooks/seat-key.js). Out: the mechanics block (common.js contextBlock; a systemMessage only for a refusal or the
// bypass-permissions warning: Claude Code draws one as a warning, and Remote Control shows it); the title
// comes on the next prompt (mod/prompt.mjs), since UserPromptExpansion has no sessionTitle. Failure blocks the
// prompt with a reason, no model turn. A seat needs the hooks module (its guard, prompt gate and delivery), so
// without a fresh hello lease for this session (identity.modLeaseOk) the join is refused with NO_MODULE.
// The seat key is made before the seat; its public key rides on member_joined, which pins it for the room's life
// (lib/room/envelope.js): a join whose key differs from the one pinned for that name is refused (RoomError AUTH)
// and the seat is given back. Entering and leaving are lib/seats.js (enter, exit, ensureOrch); orch, room, all,
// system, host, join, admit, revoke and unhost are reserved names.
// `/sub-human host [--ssh [USER@HOST[:PORT]]] [--via JUMP]`: an sh2 invite to the room this session is in and its
// PIN (host only; lib/remote/hosting.js hostInvite), for one machine, shown to the person once: a block reason
// (with suppressOriginalPrompt) never reaches the model. `/sub-human admit REQUEST` (host): let a joiner's ssh key
// in for the invite it names (hosting.admit); `/sub-human revoke LINK|NAME` (host): end a link (hosting.revoke).
// `/sub-human host --tailscale [--funnel]` / `--url URL`: the same over the web (lib/remote/webhost.js hostWeb): the
// listener, Tailscale Serve (or opt-in Funnel) or a front of the person's own, and a join URL
// https://HOST/…/sub-human/CODE#SECRET.HOSTKEY with its PIN, hidden from the model the same way; `/sub-human unhost`
// stops serving the room over the web. A join URL is an sh2 invite in another form
// (lib/remote/transports/ws.js parseJoinUrl): `/sub-human join NAME https://… PIN` takes the sh2 path below, with
// no admit step (the secret, the PIN and the pinned listener key are the admission).
// `/sub-human join NAME INVITE [PIN]`: a room hosted on another machine (an invite over ssh:, or pipe: for a
// second home here). sh1 (no PIN): the link file (lib/room/links.js) from the invite, the link daemon started
// (lib/remote/link.js start; it redeems the invite), then the join as above over the link (the host logs it and
// runs the orch). sh2 (a PIN): the typed prompt holds the PIN, so this step always blocks with suppressOriginalPrompt
// and the model never sees the invite or the PIN: the link file (with the PIN, until the host has checked it) and,
// over ssh, the link's own key and the pinned host key (hosting.joinInvite), the daemon started and its first hello
// watched (hosting.outcome); the block says what next: "/sub-human NAME CODE" once linked, the admit line to send
// the host over ssh, or the refusal (a wrong PIN and the tries left). A room this machine links to is joined with
// `/sub-human NAME CODE`. OFFLINE, AUTH and the like block the prompt with the reason.
const { identity, room, out, run, whoami, presence, contextBlock } = require('./common.js');
const orch = require('../lib/orch.js');
const seats = require('../lib/seats.js');
const auth = require('../lib/remote/auth.js');
const link = require('../lib/remote/link.js');
const links = require('../lib/room/links.js');
const hosting = require('../lib/remote/hosting.js');
const wsT = () => require('../lib/remote/transports/ws.js');
const seatKey = require('./seat-key.js');
const { orchPresence } = require('../lib/room/members.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ORCH_AGENT = 'sub-human:orchestrator';
const USAGE = 'usage: /sub-human NAME [CODE]. It joins the open room as NAME, or opens one and starts its orch for you (the orch is never launched by hand). '
  + '/sub-human host [--ssh [USER@HOST]] gives an invite and its PIN for your room; /sub-human join NAME INVITE PIN joins a room on another machine.';
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

/** A note in a join's message that the person must hear: the orch could not start, or its last start failed. */
const TROUBLE = /· no orch \(|the last start failed: /;

/**
 * A join that worked: the mechanics block for the model. No systemMessage, which Claude Code draws as a warning (the
 * session title and the room row say it worked), unless something in it is one: the orch
 * did not start, or the bypass-permissions warning.
 */
function success(me, lead, msg, input) {
  presence(me, 'working');
  const bypass = input.permission_mode === 'bypassPermissions' && me.role !== 'orch' ? BYPASS : '';
  const warn = bypass || TROUBLE.test(msg) ? `sub-human: ${msg}${bypass}` : null;
  out({
    ...(warn ? { systemMessage: warn } : {}),
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) },
  });
}

/** Close rooms where only the orch is left once they have been orphaned long enough (best effort; host only). */
function sweep() {
  try { identity.pruneModLeases(); } catch { /* the next join retries */ }
  for (const c of identity.orphanRooms()) { try { orch.watchdog(c); } catch { /* next join retries */ } }
}

function others(code, name) {
  const ms = Object.values(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at
    && (m.role !== 'orch' || orchPresence(m) === 'live'));
  return ms.map(m => m.name).join(', ');
}

/** The orch's own launch `/sub-human` (or a debugging `/sub-human [CODE]` in an orch-agent session). */
function bindOrch(input, base, cur, args) {
  if (args.length > 1 || (args[0] && !identity.CODE_RE.test(args[0]))) {
    return block('this session runs the orchestrator agent; members join from their own sessions with /sub-human NAME.');
  }
  const code = process.env.SUB_HUMAN_ROOM || args[0] || null;
  if (cur && cur.role === 'orch' && (!code || cur.code === code)) return success(cur, 'room already open', `orch of room ${cur.code}`, input);
  if (cur) return block(`this session is already ${cur.name} in room ${cur.code}.`);
  const fresh = !code;
  const c = code || identity.newCode();
  if (!identity.roomExists(c)) return block(`no room ${c}.`);
  if (identity.roomClosing(c)) return block(`room ${c} is closing.`);
  const r = identity.join({ code: c, name: 'orch', role: 'orch', ...base });
  if (!r || !r.ok) return block(`could not bind the orch of ${c}: ${(r && r.error) || 'unknown error'}`);
  const me = { code: c, name: 'orch', role: 'orch', pid: base.pid, session_id: base.session_id || null, address: identity.address('orch', c) };
  return success(me, fresh ? 'room created' : 'orch started', fresh ? `room ${c} open · others join with: /sub-human NAME ${c}` : `orch of room ${c}`, input);
}

/** `--ssh [DEST] --via JUMP` (or `--tailscale [--funnel]`, `--url URL`, `--port P`) of /sub-human host: the flags,
 * or null after a block(). */
function hostFlags(rest) {
  const f = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--ssh') f.ssh = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    else if (rest[i] === '--via' && rest[i + 1]) f.via = rest[++i];
    else if (rest[i] === '--tailscale' || rest[i] === '--funnel') f[rest[i].slice(2)] = true;
    else if (rest[i] === '--url' && rest[i + 1]) f.url = rest[++i];
    else if (rest[i] === '--port' && /^[0-9]{1,5}$/.test(rest[i + 1] || '')) f.port = Number(rest[++i]);
    else { block(`usage: /sub-human host [--ssh [USER@HOST[:PORT]]] [--via JUMP] | --tailscale [--funnel] | --url https://FRONT ("${rest[i]}"?)`); return null; }
  }
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

/** `/sub-human admit REQUEST`, `/sub-human revoke LINK|NAME`: the host's consent, and its undo. */
function hostAction(cur, args) {
  try {
    if (args[0] === 'admit') {
      if (args.length !== 2) return block('usage: /sub-human admit shk1.CODE.REF.KEY.NAME (the line a joiner\'s /sub-human join showed them)');
      return hidden(hosting.admit(args[1]).text, { shareable: true });
    }
    if (args.length !== 2) return block('usage: /sub-human revoke LINK_ID|NAME (in the room hosted here)');
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
  if (cur && cur.token) {
    return hidden(`this machine is linked to room ${inv.code} already: /sub-human ${name} ${inv.code}`, { shareable: true });
  }
  let j;
  try { j = hosting.joinInvite({ inv, invite, pin, name }); } catch (e) { return hidden(e.message, { shareable: true }); }
  if (!link.start(inv.code)) return hidden(`the link to room ${inv.code} did not start; its log is ${links.logFile(inv.code)}.`, { shareable: true });
  return hidden(hosting.joinText(inv.code, name, hosting.outcome(inv.code), j.request), { shareable: true });
}

/** The link file for an invite's room (kept once it holds a token); its code, or null after a block(). */
function linkRoom(invite) {
  const inv = auth.parseInvite(invite);
  if (!inv) return block('that is not an invite (sh2.CODE.LOCATOR.SECRET.KEY, or sh1); ask the host for one: /sub-human host.');
  const transport = link.transportOf(inv.locator);
  if (!transport && inv.locator.startsWith('ssh:')) return block('this invite names an ssh destination that is not a plain user@host[:port]; ask the host for a new one.');
  if (!transport) return block(`this invite reaches its room through "${inv.locator.split(':')[0]}", which this machine does not support yet.`);
  if (transport.kind === 'wss' || transport.kind === 'ws') return block('a web invite comes with its PIN and a pinned key (sh2); ask the host for one: /sub-human host --tailscale.');
  if (identity.roomExists(inv.code) && identity.isHost(inv.code)) return block(`room ${inv.code} is hosted on this machine; join it with /sub-human NAME ${inv.code}.`);
  const cur = links.get(inv.code);
  if (!cur || !cur.token) links.set(inv.code, { code: inv.code, transport, invite, created_at: new Date().toISOString() });
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

  if (input.agent_type === ORCH_AGENT) return bindOrch(input, base, cur, args);
  if (args.length === 0) {
    if (cur && cur.role !== 'orch') return block(`you are ${cur.name} in room ${cur.code} (address ${cur.name}.${cur.code}). ${USAGE}`);
    return block(USAGE);
  }
  if (cur && cur.role === 'orch') return block(`this session is the orch of room ${cur.code}; join from another session.`);
  if (args[0] === 'host') return host(cur, args.slice(1));
  if (args[0] === 'admit' || args[0] === 'revoke') return hostAction(cur, args);
  if (args[0] === 'unhost') {
    if (!cur) return block('unhost from a session in the room: /sub-human NAME first.');
    if (args.length !== 1) return block('usage: /sub-human unhost (stops serving this room over the web)');
    try { return hidden(require('../lib/remote/webhost.js').unhost(cur.code).text, { shareable: true }); } catch (e) { return block(e.message); }
  }
  const remote = args[0] === 'join';
  if (remote && args.length >= 3) {
    // a PIN may be in this prompt: whatever happens, it is hidden from the model
    const url = /^https?:\/\//.test(args[2]) ? wsT().parseJoinUrl(args[2]) : null; // a join URL: an sh2 invite
    const inv = url || auth.parseInvite(args[2]);
    if (args.length > 4) return hidden('usage: /sub-human join NAME INVITE PIN');
    if (/^https?:\/\//.test(args[2]) && !url) return hidden('that link is not a whole join URL (https://HOST/…/CODE#SECRET.KEY); ask the host to copy all of it');
    if (inv && inv.v === 2) return linkInvite2(inv, url ? url.invite : args[2], args[3], args[1]);
    if (args.length === 4) return hidden(inv ? 'this invite (sh1) takes no PIN: /sub-human join NAME INVITE' : 'that is not an invite (sh2.…); ask the host for one: /sub-human host.');
  }
  if (remote ? args.length !== 3 : args.length > 2) return block(USAGE);
  const name = remote ? args[1] : args[0];

  let code = remote ? linkRoom(args[2]) : args[1] || (cur && cur.name === name ? cur.code : null);
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
  if (cur && cur.code === code && cur.name === name) {
    return success(cur, 'already joined', `in room ${cur.code} as ${name}${seats.ensureOrch(code, cwd, name)}`, input);
  }
  if (cur) seats.exit(cur.code, cur.name, 'switched rooms'); // exactly as exiting the session would
  // The seat's key (hooks/seat-key.js): via=human posts and answers are signed with it, and the log pins it.
  let pubkey;
  try { pubkey = seatKey.publicPem(code, name); } catch (e) { return block(`could not create the seat key for ${name}: ${e.message}`); }
  const r = seats.enter({ code, name, ...base, pubkey });
  if (!r.ok) return block(`could not join ${code} as ${name}: ${r.error || 'unknown error'}`);
  const me = { code, name, role: 'member', pid, session_id: input.session_id || null, address: identity.address(name, code) };
  const here = others(code, name);
  const msg = created
    ? `opened room ${code} as ${name} · others: /sub-human NAME`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}${here ? ` (${here} here)` : ''}`;
  success(me, created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', `${msg}${r.note}`, input);
});
