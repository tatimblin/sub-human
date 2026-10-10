/**
 * plugin/sub-human/lib/cli/main.ts: the body of scripts/sub-human (a thin shim kept at its path: persisted artifacts
 * run it), the read-only CLI over the room. There is no post command: writes come only
 * from the plugin's hooks and the MCP server (the host's admit and kick add a line from the room itself, via
 * system). Without --room / CODE, the room is this session's
 * (identity.resolveSelf(): the session id env, then the nearest registered ancestor claude pid).
 *
 *   sub-human tail [--ndjson] [--max-seconds S]
 *       The hooks module's child (mod/deliver.ts starts it with $.process.spawn, CLAUDE_CODE_SESSION_ID set to the
 *       session's id; --ndjson is accepted for that argv and is the only output). Silent until this session has a
 *       seat: while it has none it looks the seat up by CLAUDE_CODE_SESSION_ID / CLAUDE_PID every
 *       SUB_HUMAN_UNSEATED_MS (10000; a `ps` ancestor walk only when neither is set). Once seated it re-resolves
 *       every SUB_HUMAN_RESOLVE_MS (2000), follows that room from the cursor deliver-<name> (without re-reading
 *       the log from byte 0) and writes one JSON event per line for the mod to route (seat, chat, pull, wake,
 *       rows, health; lib/tail.ts documents them), switching (or going silent) if the seat changes.
 *       Settle: entries are batched and written as ONE set of events (at most one wake) after
 *       SUB_HUMAN_SETTLE_MS (1500) of quiet or SUB_HUMAN_SETTLE_MAX_MS (5000) at most (the room's Claude: 3000 / 10000,
 *       SUB_HUMAN_ROOM_CLAUDE_SETTLE_MS / SUB_HUMAN_ROOM_CLAUDE_SETTLE_MAX_MS). Each entry is judged again against the log at
 *       send time (answered / decided entries are dropped). A member_left X is held
 *       SUB_HUMAN_LEAVE_MS (8000): if X rejoins in that time both notices are dropped.
 *       A member's chat is a group chat (room.chatLines, no ids): "bob: <exact words>", "bob's Claude: …",
 *       "bob joined", "bob left". Lines meant only for Claude start with "(for Claude)". The room Claude's wake opens
 *       with room.stateLine() ("room now: …"), then one room.line(e, {full}) per entry (ids kept: its tools take
 *       them), a leave marked "· away 8s+"; its member_joined is pushed when lib/rows.ts joinNote() says that
 *       member's row is not running (the line ends with the note and the Agent call).
 *       It never exits on an error: it logs to stderr (rate-limited), backs off and carries on. Every
 *       SUB_HUMAN_TAIL_HEALTH_MS (5000) it checks the log's hash chain and, as the room's Claude, runs roomClaude.watchdog(code).
 *       It exits on --max-seconds, SIGTERM / SIGINT / SIGHUP, when its parent goes (the ppid changes) or when
 *       stdout closes.
 *   sub-human read [N[,M] | --id N[,M]] [--json] [--room CODE]
 *       entries in full: by id, or this session's unseen entries (cursor read-<name>)
 *   sub-human digest [--room CODE]     the compaction digest (<= 9,500 chars)
 *   sub-human who                      this session's identity: "<name> (<role>) in <code>"
 *   sub-human tasks [--json] [--room CODE]
 *       the room's shared task list (lib/tasks.ts list(code), the room Claude's native list mirrored to
 *       the room document `tasks`): "#2 in_progress  bob  parser tests". --json prints the array.
 *   sub-human watch NAME [--room CODE] [--follow|--no-follow]
 *       NAME's thread: their own words, their Claude's posts (labelled "NAME's Claude"), their answers,
 *       their joins/leaves, and entries addressed to them. The room Claude's posts are labelled
 *       "claude". Follows live when stdout is a terminal (or with --follow).
 *   sub-human agent-statusline
 *       Claude Code's subagentStatusLine command (statusline/*). Never fails: on any error it prints
 *       nothing and exits 0.
 *   sub-human serve --stdio CODE [--link ID [--login]]
 *       One remote connection to room CODE hosted here (lib/remote/server.ts): protocol frames on stdin and
 *       stdout (lib/remote/transports/pipe.ts), errors on stderr; exits when stdin ends. A remote machine's
 *       link spawns it (a pipe), or sshd runs it as the forced command the host's admit wrote. Without a link token
 *       or an invite it answers hello and nothing else. --link ID: only that link's token (or the invite
 *       reserved for it) is accepted; any other is AUTH. A room this machine only mirrors is not served, unless
 *       the room moved away from here (lib/handoff.ts): then this machine's old log is served read-only, so a
 *       member that reconnects late still gets the line that moved the room and its invite to the new host.
 *       --login: run over this account's own ssh login (`/sub-human join USER@HOST ROOM` on the other machine
 *       names the shim, <home>/bin/serve, with it): a hello with no token makes link ID (lib/remote/server.ts), as
 *       a process of this account may. Refused under SSH_ORIGINAL_COMMAND (a forced command: a restricted key, whose
 *       line fixes its arguments without --login anyway, or a ForceCommand).
 *   sub-human serve --enroll CODE --kind ssh|ws|pipe
 *       One PIN attempt at room CODE hosted here (lib/remote/enroll.ts serveEnroll): the CPace exchange and
 *       nothing else; it never serves the room. The ssh enrollment door's forced command and the web listener run it.
 *   sub-human link CODE [--reset]
 *       The link daemon of room CODE, hosted on another machine (lib/remote/link.ts run): the join hook starts it
 *       detached; it exits on its own once this machine has no seat left in the room. --reset (with no daemon
 *       running, e.g. after a FORK): forget this machine's copy of the room and start the daemon to copy it again.
 *   sub-human invite [--room ROOM] [--ssh [USER@HOST[:PORT]] [--via JUMP] | --web | --public | --url URL [--port P]]
 *       An invite line and its PIN, as /sub-human invite shows them (lib/cli/host.ts; lib/remote/hosting.ts hostInvite,
 *       webhost.ts hostWeb). Over ssh by default, to this machine's own address (SUB_HUMAN_SSH_ADDR, else
 *       user@hostname): the PIN vouches for this machine's sshd Ed25519 host key. --web: Tailscale Serve (tailnet only),
 *       --public: Tailscale Funnel, --url: any HTTPS front of your own, to the listener. --pipe: a second home here
 *       (tests, the demo). The host's card lets the joiner in
 *   sub-human invite --stop [--room ROOM]        stop serving the room over the web
 *   sub-human invite --cancel [REF] [--room ROOM]   cancel an invite nobody used (no REF: the one open, or the list)
 *   sub-human admit [REF [--refuse] [--yes]] [--room ROOM]                    (lib/cli/host.ts)
 *       The join requests waiting for the host (no REF), or let one in (y/N first; --yes skips it), or --refuse it.
 *       The card in the host's session is the usual way; this is for a host with no session open.
 *   sub-human kick NAME [--room ROOM] [--file AUTHORIZED_KEYS]                (lib/cli/host.ts)
 *       End NAME's connection: token burnt, its authorized_keys lines removed, its seats leave, a room line says so.
 *   sub-human prime ROOM [--persist 8h]                                       (lib/cli/host.ts)
 *       On the joining machine: open a shared ssh connection (ControlMaster) for room ROOM's link, interactively,
 *       so an MFA bastion or host asks once; the link daemon then rides it.
 *   sub-human listen [--port 7420] | --start [--port P] | --stop | --status   (lib/cli/listen.ts)
 *       The host's WebSocket listener (lib/remote/listener.ts): 127.0.0.1 only, a Noise_NK handshake per connection,
 *       then `<home>/bin/serve --stdio CODE` for it. Without a flag it runs in this process.
 *   sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS]
 *       What is wrong on this machine and the fix for each (lib/cli/doctor.ts): node, the home's modes, the serve
 *       shim, authorized_keys lines that bypass it, ssh, each link (state, last error, a hello to its host with
 *       both protocol versions, clock skew), Claude Code against the internals, hooks, Remote Control. --bundle
 *       writes the same, redacted, for a bug report. Exit 1 when a check fails.
 *   sub-human handoff NAME [--room CODE] [--as SEAT] [--ssh USER@HOST[:PORT]] | handoff --status [--room CODE]
 *   sub-human promote CODE [--as SEAT] [--ssh USER@HOST[:PORT]] [--force] --confirm CODE
 *   sub-human demote CODE INVITE PIN
 *       Moving the room's host (lib/handoff.ts; the bodies are lib/cli/handoff.ts): a planned handoff to a member on
 *       another machine (their card decides), the manual promote of this machine's copy when the host is gone for
 *       good (it can fork the room), and each other machine's way to follow it with the invite promote printed for
 *       it (the old host's own lines kept aside as orphaned).
 *   Run invite, admit, kick, prime, listen, link, serve, handoff, promote and demote in your own shell: the Bash guard
 *   refuses them to a model. doctor without --fix or --bundle is read only.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as identity from '../identity.ts';
import * as room from '../room.ts';
import * as tasks from '../tasks.ts';
import * as config from '../config.ts';
import * as cc from '../cc.ts';
import * as tailLib from '../tail.ts';
import * as statusline from '../../statusline/index.ts';
import { readInput } from '../io.ts';
import { parse as parseArgs } from './args.ts';
import type { CliIo, FlagSpec, Flags, Parsed } from './types.ts';
import type { MirrorRoomStore } from '../room/store-mirror.ts';

// Each command's own modules load when it runs (createRequire: require(esm) is synchronous), so the tail and
// agent-statusline (run often) never load the remote stack, doctor or the host commands.
const require = createRequire(import.meta.url);


const NOT_IN_ROOM = 'not in a room; type /sub-human in your Claude Code session';

function die(msg: string, code = 2): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

/** lib/cli/args.ts parse, dying on its error (exit 2). */
function parseFlags<S extends FlagSpec>(args: readonly string[], spec: S): Parsed<S> {
  const p = parseArgs(args, spec);
  if (p.error) die(p.error);
  return p;
}

const intList = (s: string): number[] => String(s).split(',').filter(Boolean).map(x => {
  const n = Number(x.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) die(`bad id "${x}"`);
  return n;
});

type Entry = Parameters<typeof room.fmt>[0];

/** Open the room: an explicit code, else this session's. Returns {code, me|null, r: Room}. */
function openRoom(explicit?: string) {
  if (explicit) {
    if (!identity.roomExists(explicit)) die(`no room "${explicit}"`, 1);
    const me = identity.resolveSelf();
    return { code: explicit, me: me && me.code === explicit ? me : null, r: room.open(explicit) };
  }
  const me = identity.resolveSelf();
  if (!me) die(NOT_IN_ROOM, 1);
  return { code: me.code, me, r: room.open(me.code) };
}

// ---------- tail: lib/tail.ts runTail ----------
function tail(args: readonly string[]) {
  const { flags } = parseFlags(args, { 'max-seconds': 1, ndjson: 0 }); // --ndjson: the only output, accepted
  let maxSeconds: number | null = null;
  if (flags['max-seconds'] != null) {
    maxSeconds = Number(flags['max-seconds']);
    if (!(maxSeconds > 0)) die(`bad --max-seconds "${flags['max-seconds']}"`);
  }
  let handle: ReturnType<typeof tailLib.runTail> | null = null;
  // the reader is gone: nobody to notify
  process.stdout.on('error', () => {
    try { if (handle) handle.stop(); } catch { /* exiting */ }
    process.exit(0);
  });
  // A stray error is logged and the loop carries on (each restart by the mod costs a backoff).
  const lastResort = (e: unknown) => {
    const err = e as { stack?: unknown } | null | undefined;
    try { process.stderr.write(`sub-human tail: unexpected error: ${err && err.stack || e}\n`); } catch { /* closed */ }
  };
  process.on('uncaughtException', lastResort);
  process.on('unhandledRejection', lastResort);
  // Without a seat, look it up cheaply: the session id the mod sets, no `ps` walk (that runs only when neither
  // variable is set, e.g. a hand-run tail). After /clear the mod starts a new child under the new id.
  const sid = cc.sessionId(), pid = cc.claudePid();
  const lookup = sid || pid
    ? () => (sid && identity.resolveBySession(sid)) || (pid && identity.resolveByPid(pid)) || null
    : () => identity.resolveSelf();
  const h = tailLib.runTail({ write: (text: string, done?: (err?: Error | null) => void) => process.stdout.write(text, done), lookup, maxSeconds, sid });
  handle = h;
  // The mod's child: stop cleanly on the way out, and never outlive the session that started it.
  const quit = () => { try { h.stop(); } catch { /* exiting */ } process.exit(0); };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, quit);
  const ppid = process.ppid;
  setInterval(() => { if (process.ppid !== ppid) quit(); }, config.TAIL_HEALTH_MS).unref();
}

// ---------- agent-statusline: dispatch to statusline/* ----------
// lib/io.ts readInput, never hooks/common.ts: requiring that arms the seat-key signer (via=human writes), which
// the CLI and the tail must never load.

/** statusline agentStatusline(input) -> text ({"id","content"} lines); whatever goes wrong, print nothing and exit 0. */
function agentStatusline() {
  try {
    const out = statusline.agentStatusline(readInput({ strict: false }));
    if (typeof out === 'string' && out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  } catch { /* keep the default rendering */ }
}

// ---------- read / digest / who ----------
function read(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { id: 1, json: 0, room: 1 });
  if (!flags.id && rest.length) flags.id = rest.join(','); // `sub-human read 22`, as the cut marker says
  const { me, r } = openRoom(flags.room);
  const show = (es: Entry[]) => es.forEach(e => console.log(flags.json ? JSON.stringify(e) : room.fmt(e) + '\n'));
  if (flags.id) {
    const es = r.readById(intList(flags.id));
    if (!es.length) die('(no such entries)', 1);
    return show(es);
  }
  if (!me) return show(r.readAll().slice(-50));
  const cursor = `read-${me.name}`;
  const es = r.readAfter(r.getCursor(cursor));
  if (!es.length) return console.log('(no new messages)');
  show(es);
  r.setCursor(cursor, es.at(-1)!.id); // es is not empty
}

function digest(args: readonly string[]) {
  const { flags } = parseFlags(args, { room: 1 });
  const { r } = openRoom(flags.room);
  process.stdout.write(r.digest() + '\n');
}

function who() {
  const me = identity.resolveSelf();
  if (!me) die(NOT_IN_ROOM, 1);
  console.log(`${me.name} (${me.role}) in ${me.code}`);
}

// ---------- tasks ----------
/** lib/tasks.ts list(code): the room document `tasks` as the mirror writes it. */
const taskList = (code: string) => tasks.list(code) || [];

function tasksCmd(args: readonly string[]) {
  const { flags } = parseFlags(args, { json: 0, room: 1 });
  const { code } = openRoom(flags.room);
  let list;
  try { list = taskList(code); } catch (e) { die(`the room task list is unavailable: ${(e as Error).message}`, 1); }
  list = list.filter(t => t && !(t.metadata && t.metadata._internal));
  if (flags.json) return console.log(JSON.stringify(list));
  if (!list.length) return console.log(`(no tasks in room ${code})`);
  const w = Math.max(...list.map(t => String(t.status || '').length));
  const o = Math.max(...list.map(t => String(t.owner || '-').length));
  for (const t of list) {
    const blocked = Array.isArray(t.blockedBy) && t.blockedBy.length ? `  (blocked by ${t.blockedBy.map((b: string | number) => '#' + b).join(',')})` : '';
    const subject = String(t.subject ?? '').replace(/\s+/g, ' ');
    console.log(`#${t.id}  ${String(t.status || '').padEnd(w)}  ${String(t.owner || '-').padEnd(o)}  ${subject}${blocked}`);
  }
}

// ---------- watch NAME ----------
/** Who an entry is from, as a person reading a thread would say it. */
function label(e: Entry): string {
  if (e.via === 'system') return 'room';
  if (e.from === 'claude') return 'claude';
  return e.via === 'agent' ? `${e.from}'s Claude` : e.from;
}

function inThread(name: string) {
  return (e: Entry) => e.from === name || e.to === name || (e.kind === 'task' && e.owner === name);
}

function watch(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { room: 1, follow: 0, 'no-follow': 0 });
  const name = rest[0];
  if (!name) die('usage: sub-human watch NAME [--room CODE] [--follow|--no-follow]');
  if (!identity.NAME_RE.test(name)) die(`bad name "${name}"`);
  const { code, r } = openRoom(flags.room);
  const color = process.stdout.isTTY && !('NO_COLOR' in process.env);
  const c = (code_: string, s: string) => color ? `\x1b[${code_}m${s}\x1b[0m` : s;
  const kindColor: Record<string, string> = {
    decision: '1;32', signoff: '32', objection: '31', proposal: '1;34', task_req: '36', task: '36',
    member_joined: '2;32', member_left: '2;31',
  };
  const show = inThread(name);
  const print = (raw: Entry) => {
    const e = room.normalize(raw);
    if (!show(e)) return;
    const who = label(e) + (room.unverifiedHuman(e) ? ' (unverified)' : '');
    const whoStr = e.via === 'human' ? c('1', who) : who === 'claude' ? c('35', who) : c('2', who);
    const ph = e.hash || e.proposal_hash;
    const meta = [
      e.to && e.to !== 'room' && `→ ${e.to === name ? name : e.to}`,
      e.refs && e.refs.length && `refs ${e.refs.map((r: number) => '#' + r).join(',')}`,
      ph && `proposal ${ph.slice(0, 6)}`,
      e.task_id && `task #${e.task_id}`].filter(Boolean).join('  ');
    const head = c('2', `#${e.id} ${String(e.at || '').slice(11, 19)}`);
    console.log(`${head}  ${whoStr}  ${c(kindColor[e.kind] || '2', e.kind)}${meta ? '  ' + c('2', meta) : ''}`);
    console.log(String(e.text ?? '').split('\n').map(l => '    ' + l).join('\n') + '\n');
  };
  const follow = flags.follow ? true : flags['no-follow'] ? false : !!process.stdout.isTTY;
  if (!follow) {
    const es = r.readAll().filter((e: Entry) => show(room.normalize(e)));
    if (!es.length) return console.log(`(nothing from or to ${name} in room ${code})`);
    return es.forEach(print);
  }
  console.log(c('2', `${name}'s thread in room ${code} (Ctrl-C to stop)`) + '\n');
  process.stdout.on('error', () => process.exit(0));
  r.watch(print, { after: 0, intervalMs: config.WATCH_POLL_MS });
}

// ---------- serve --stdio CODE: lib/remote/server.ts ----------
const SERVE_FLAGS = { stdio: 0, link: 1, login: 0, enroll: 1, kind: 1 } as const;

function serve(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, SERVE_FLAGS);
  if (flags.enroll !== undefined) return serveEnroll(flags.enroll, flags, rest);
  const code = rest[0];
  if (!flags.stdio || !code || rest.length > 1) die('usage: sub-human serve --stdio CODE [--link ID [--login]]');
  const { LINK_ID_RE }: typeof import('../remote/auth.ts') = require('../remote/auth.ts');
  if (flags.link !== undefined && !LINK_ID_RE.test(flags.link)) die(`bad link id "${flags.link}"`);
  if (flags.login && flags.link === undefined) die('sub-human serve --login: names no --link ID');
  // sshd sets SSH_ORIGINAL_COMMAND only when a forced command runs (an authorized_keys command="…" or ForceCommand): a
  // key restricted that way is not the account's own login, whatever command it asked for
  if (flags.login && process.env.SSH_ORIGINAL_COMMAND !== undefined) {
    die('sub-human serve --login: refused: this connection came through a forced command (a restricted ssh key or ForceCommand), not your own ssh login; join with an invite (/sub-human invite on the host)', 1);
  }
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  const server: typeof import('../remote/server.ts') = require('../remote/server.ts');
  const pipe: typeof import('../remote/transports/pipe.ts') = require('../remote/transports/pipe.ts');
  let s = room.open(code).store;
  if (!s.isHost) {
    const handoff: typeof import('../handoff.ts') = require('../handoff.ts');
    const store: typeof import('../room/store.ts') = require('../room/store.ts');
    if (!handoff.movedAway(s)) die(`room "${code}" is not hosted on this machine (it holds a copy)`, 1);
    s = store.open(code, { dir: s.dir }); // the old log, read-only: it moved
  }
  const srv = server.serve(pipe.stdio(), { store: s, linkId: flags.link, login: !!flags.login, log: (msg: string) => process.stderr.write(msg + '\n') });
  // `sub-human kick` stops this with SIGTERM: tell the link it was revoked first, so its daemon stops, not redials
  process.once('SIGTERM', () => { const told = srv.revoked(); setTimeout(() => process.exit(0), told ? 200 : 0); });
}

// serve --enroll CODE --kind ssh|ws|pipe: one short-code attempt (lib/remote/enroll.ts), the PAKE and nothing else. The
// ssh enrollment door's forced command and the web listener run it; whatever command the other side asked for is ignored.
function serveEnroll(code: string, flags: Flags<typeof SERVE_FLAGS>, rest: string[]) {
  if (rest.length || flags.kind === undefined || !['ssh', 'ws', 'pipe'].includes(flags.kind) || !identity.CODE_RE.test(String(code))) die('usage: sub-human serve --enroll CODE --kind ssh|ws|pipe');
  if (!identity.roomExists(code) || !identity.isHost(code)) die(`no room "${code}" is hosted here`, 1);
  const enroll: typeof import('../remote/enroll.ts') = require('../remote/enroll.ts');
  const pipe: typeof import('../remote/transports/pipe.ts') = require('../remote/transports/pipe.ts');
  const s = room.open(code).store;
  enroll.serveEnroll(pipe.stdio(), { store: s, kind: flags.kind, log: (msg: string) => process.stderr.write(msg + '\n') })
    .then(() => process.stdout.write('', () => process.exit(0)), (e: Error) => die(e.message, 1));
}

// ---------- link CODE [--reset]: lib/remote/link.ts ----------
function linkCmd(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { reset: 0 });
  const code = rest[0];
  if (!code) die('usage: sub-human link CODE [--reset]');
  const opened = room.open(code).store;
  if (opened.isHost) die(`this machine hosts room "${code}"; there is no connection to start`, 1);
  const s = opened as MirrorRoomStore; // not the host: the room's mirror
  const link: typeof import('../remote/link.ts') = require('../remote/link.ts');
  if (!flags.reset) return link.run({ code }).then(() => process.exit(0), (e: Error) => die(e.message, 1));
  const st = link.status(code);
  if (st.running) die(`the connection to room ${code} is running (pid ${st.pid}); it copies the room afresh only once stopped (kill ${st.pid}, then run this again)`, 1);
  s.reset();
  const text: typeof import('../text.ts') = require('../text.ts');
  if (!link.start(code)) die(`the connection to room ${code} did not start; ${text.cliLine('doctor')} says why`, 1);
  console.log(`room ${code}: copying it again from the host`);
}

type Command = (args: readonly string[]) => unknown;
const doctor: Command = args => (require('./doctor.ts') as typeof import('./doctor.ts')).main(args).then(c => process.exit(c), (e: Error) => die(e.message, 2));
const cmds: Record<string, Command> = { doctor, tail, read, digest, who, tasks: tasksCmd, watch, serve, link: linkCmd, 'agent-statusline': agentStatusline };
// lib/cli/*: each returns the exit code
const viaCli = (fn: 'invite' | 'admit' | 'kick' | 'prime'): Command => a => process.exit((require('./host.ts') as typeof import('./host.ts'))[fn](a));
Object.assign(cmds, { invite: viaCli('invite'), admit: viaCli('admit'), kick: viaCli('kick'), prime: viaCli('prime') });
// listen without --start/--stop/--status is the daemon itself: it returns null and keeps running
Object.assign(cmds, { listen: (a: readonly string[]) => { const c = (require('./listen.ts') as typeof import('./listen.ts')).listen(a); if (c !== null) process.exit(c); } });
// handoff, promote, demote: lib/cli/handoff.ts
const handoffCli = (name: 'handoff' | 'promote' | 'demote'): Command => args => (require('./handoff.ts') as typeof import('./handoff.ts'))[name](args, { die, out: l => console.log(l), err: l => console.error(l) } satisfies CliIo);
Object.assign(cmds, { handoff: handoffCli('handoff'), promote: handoffCli('promote'), demote: handoffCli('demote') });

/** Run one command: argv is what follows `sub-human` (scripts/sub-human passes process.argv.slice(2)). */
function main([cmd, ...args]: string[] = process.argv.slice(2)) {
  // Keep the SSH serve shim's pointer on this install and node (lib/remote/shim.ts); not on the status line's hot
  // path, and never creating a home. Passive: a dev checkout's run never takes the pointer from another live install.
  if (cmd !== 'agent-statusline' && cmd !== 'doctor') { // doctor reports the shim as it is (--fix refreshes it)
    try { if (fs.existsSync(identity.home())) require('../remote/shim.ts').refresh(); } catch { /* best effort */ }
  }
  try {
    (cmds[cmd] || (() => die('usage: sub-human tail | read [--id N,M] | digest | who | tasks [--json] | watch NAME | serve --stdio CODE [--link ID [--login]] | link CODE [--reset] | invite [--ssh [USER@HOST]] [--via JUMP] | invite --web|--public|--url URL | invite --stop | invite --cancel [REF] | admit [REF] | kick NAME | prime ROOM | listen [--port P] [--start|--stop|--status] | handoff NAME | promote CODE | demote CODE INVITE PIN | doctor [--bundle [FILE]] | agent-statusline')))(args);
  } catch (e) {
    die((e as Error).message, 2);
  }
}

export { main };
