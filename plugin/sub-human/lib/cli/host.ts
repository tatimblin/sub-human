/**
 * plugin/sub-human/lib/cli/host.ts: the host's and the joiner's setup commands of scripts/sub-human, in the person's
 * own shell (the Bash guard refuses them to a model). The work is lib/remote/hosting.ts and webhost.ts; this file
 * parses arguments and prints. Each export takes argv (after the command) and returns the exit code; a RoomError is
 * printed on stderr (exit 1), a usage error exits 2.
 *
 *   invite(args) sub-human invite [--room ROOM] [--ssh [USER@HOST[:PORT]] [--via JUMP] | --web | --public | --url URL
 *                [--port P] | --pipe] | --stop | --cancel [REF]
 *                the invite line and its PIN, as /sub-human invite shows them (hosting.hostInvite, webhost.hostWeb):
 *                over ssh by default; --web Tailscale Serve, --public Tailscale Funnel, --url a front of your own;
 *                --stop stops serving the room over the web (webhost.unhost); --cancel [REF] cancels an unused
 *                invite (hosting.cancelInvite). Without --room, the one room hosted here with a live seat
 *   kick(args)   sub-human kick NAME [--room ROOM] [--file AUTHORIZED_KEYS]: end NAME's connection (hosting.kick)
 *   admit(args)  sub-human admit [REF [--refuse] [--yes]] [--room ROOM]: the join requests waiting (no REF: list
 *                them); REF: let that one in after y/N (lib/remote/admission.ts letIn), or --refuse. The card in the
 *                host's session is the usual way; this is for a host with no session open
 *   prime(args)  sub-human prime ROOM [--persist 8h]
 *                the joiner's side, for an MFA bastion or host: open an ssh master for room ROOM's link once,
 *                interactively (ssh -M -N -f, ControlPersist), and mark the link to ride it (its transport's mux), so
 *                the link daemon's BatchMode ssh reuses it without a prompt (lib/remote/transports/ssh.ts)
 *   hostedRoom(explicit?) -> code   --room, else the one open room hosted here (Error NO_ROOM otherwise)
 *   inClaudeCode(env?) -> bool      run inside Claude Code (CLAUDECODE=1 or CLAUDE_CODE_SESSION_ID): its ! shell, whose
 *                output becomes part of the conversation
 *   maskPins(text, pins, env?) -> text   inside Claude Code every PIN (and an invite line's SECRET) masked and PIN_HIDDEN
 *                appended; else text
 *                (invite here, promote in lib/cli/handoff.ts)
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from './args.ts';
import PathMod from 'node:path';
import { createRequire } from 'node:module';
import { msgOf } from '../errors.ts';

const require = createRequire(import.meta.url);

const say = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (s: string, code = 1) => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); return code; };

/** Run inside Claude Code (its `!` shell, a Bash tool): whatever is printed lands in the conversation, model input. */
const inClaudeCode = (env = process.env) => env.CLAUDECODE === '1' || !!env.CLAUDE_CODE_SESSION_ID;
const PIN_HIDDEN = 'PIN and SECRET hidden: this ran inside Claude Code, where the output becomes part of the conversation. Run it in a terminal outside Claude Code, or use /sub-human invite in the room (its reply is shown to you only).';

/** text with every PIN in it masked, and why, when run inside Claude Code; else text as it is. */
function maskPins(text: string, pins: readonly (string | null | undefined)[], env: NodeJS.ProcessEnv = process.env): string {
  if (!inClaudeCode(env)) return text;
  let out = text;
  for (const p of pins) if (p) out = out.split(p).join('####');
  return `${out}\n${PIN_HIDDEN}`;
}

/** The room: --room, else the one open room hosted here. */
function hostedRoom(explicit?: string): string {
  const identity: typeof import('../identity.ts') = require('../identity.ts');
  if (explicit) return explicit;
  const open = identity.openRooms().filter(c => identity.isHost(c));
  if (open.length === 1) return open[0];
  throw Object.assign(new Error(open.length ? `${open.length} rooms are open here (${open.join(', ')}); name one with --room ROOM` : 'no room is open here; name one with --room ROOM'), { code: 'NO_ROOM' });
}

const INVITE_USAGE = 'usage: sub-human invite [--room ROOM] [--ssh [USER@HOST[:PORT]] [--via JUMP] | --web | --public | --url URL [--port P] | --pipe] | --stop | --cancel [REF]';

function invite(args: readonly string[]): number {
  // --ssh takes a value only when one follows that is not another flag
  const p = parse(args, { ssh: '?', room: 1, via: 1, url: 1, port: 1, web: 0, public: 0, pipe: 0, stop: 0, cancel: '?' });
  const f = p.flags;
  if (p.error || p.rest.length) return fail(p.error || INVITE_USAGE, 2);
  const web = !!(f.web || f.public || f.url !== undefined);
  const ways = [f.ssh !== undefined || f.via !== undefined, web, !!f.pipe, !!f.stop, f.cancel !== undefined].filter(Boolean).length;
  if (ways > 1) return fail(`pick one way: ${INVITE_USAGE}`, 2);
  try {
    const code = hostedRoom(f.room);
    const webhost: typeof import('../remote/webhost.ts') = require('../remote/webhost.ts');
    const hosting: typeof import('../remote/hosting.ts') = require('../remote/hosting.ts');
    if (f.stop) { say(webhost.unhost(code).text); return 0; }
    if (f.cancel !== undefined) { say(hosting.cancelInvite(code, f.cancel === true ? undefined : f.cancel).text); return 0; }
    const r = web
      ? webhost.hostWeb(code, { tailscale: !!(f.web || f.public), funnel: !!f.public, url: f.url, ...(f.port ? { port: Number(f.port) } : {}) })
      : hosting.hostInvite(code, { ssh: f.pipe ? undefined : f.ssh === undefined ? true : f.ssh, via: f.via, pipe: !!f.pipe });
    say(maskPins(r.text, [r.pin, r.word]));
    return 0;
  } catch (e) { return fail(msgOf(e)); }
}

function kick(args: readonly string[]): number {
  const { flags: f, rest, error } = parse(args, { room: 1, file: 1 });
  if (error || rest.length !== 1) return fail('usage: sub-human kick NAME [--room ROOM] [--file AUTHORIZED_KEYS]', 2);
  try {
    const hosting: typeof import('../remote/hosting.ts') = require('../remote/hosting.ts');
    say(hosting.kick(hostedRoom(f.room), rest[0], f.file ? { file: f.file } : {}).text);
    return 0;
  } catch (e) { return fail(msgOf(e)); }
}

function ask(question: string): string {
  process.stderr.write(question);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { return ''; }
  return buf.subarray(0, n).toString('utf8').trim();
}

/** `sub-human admit [REF [--refuse]]`: a join request (the card's, in a shell: headless hosts). */
function admit(args: readonly string[]): number {
  const p = parse(args, { yes: 0, room: 1, refuse: 0 });
  if (p.error || p.rest.length > 1 || (p.rest.length && !/^[0-9a-f]{6,12}$/.test(p.rest[0]))) return fail(p.error || 'usage: sub-human admit [REF [--refuse] [--yes]] [--room ROOM]', 2);
  const adm: typeof import('../remote/admission.ts') = require('../remote/admission.ts');
  const text: typeof import('../text.ts') = require('../text.ts');
  let code;
  try { code = hostedRoom(p.flags.room); } catch (e) { return fail(msgOf(e)); }
  if (!p.rest.length) {
    const reqs = adm.pending(code);
    if (!reqs.length) { say(`nobody is waiting to join room ${code}`); return 0; }
    for (const q of reqs) say(`${adm.describe(q)} wants to join room ${code} (until ${text.localHm(q.expires_at)}): ${text.cliLine(`admit ${q.ref}`)} [--refuse]`);
    return 0;
  }
  const req = adm.find(code, p.rest[0]);
  if (!req) return fail(`room ${code} has no join request ${p.rest[0]} (admit with no ID lists them)`);
  if (!p.flags.yes && !p.flags.refuse) {
    if (!process.stdin.isTTY) return fail('not a terminal: add --yes to let them in (or --refuse)');
    const yes = ask(`${adm.describe(req)} typed your PIN and wants to join room ${code}.\nLet them in? That machine joins the room and can post only as the people it brings. [y/N] `);
    if (!/^y(es)?$/i.test(yes)) return fail(`not let in; the request still waits (${text.cliLine(`admit ${req.ref} --refuse`)} ends it)`);
  }
  try {
    say((p.flags.refuse ? adm.refuse(code, req.ref, { by: null }) : adm.letIn(code, req.ref, { by: null })).text);
    return 0;
  } catch (e) { return fail(msgOf(e)); }
}

function prime(args: readonly string[]): number {
  const p = parse(args, { persist: 1 });
  if (p.error || p.rest.length !== 1) return fail(p.error || 'usage: sub-human prime ROOM [--persist 8h]', 2);
  const code = p.rest[0];
  const links: typeof import('../room/links.ts') = require('../room/links.ts');
  const l = links.get(code);
  if (!l || !l.transport || l.transport.kind !== 'ssh') return fail(`this machine isn't connected to room ${code} over ssh`);
  try {
    const ssh: typeof import('../remote/transports/ssh.ts') = require('../remote/transports/ssh.ts');
    fs.mkdirSync(PathMod.dirname(ssh.controlPath()), { recursive: true, mode: 0o700 });
    const [cmd, ...rest] = ssh.primeCommand(l.transport, code, p.flags.persist ? { persist: p.flags.persist } : {});
    links.set(code, { ...l, transport: { ...l.transport, mux: true } });
    process.stderr.write(`opening a shared ssh connection for room ${code} (answer any prompt once)…\n`);
    const r = spawnSync(cmd, rest, { stdio: 'inherit' });
    if (r.status !== 0) return fail(`ssh exited ${r.status}; the room still connects on its own, without the shared connection`);
    say(`room ${code}: its connection now rides this ssh login for ${p.flags.persist || '8h'} (after that it reconnects on its own; prime again for another MFA prompt)`);
    return 0;
  } catch (e) { return fail(msgOf(e)); }
}

export { invite, kick, admit, prime, hostedRoom, inClaudeCode, maskPins, PIN_HIDDEN };
