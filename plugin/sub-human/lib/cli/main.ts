/**
 * plugin/sub-human/lib/cli/main.ts: the body of scripts/sub-human (a thin shim kept at its path: persisted artifacts
 * run it), the read-only CLI over the room. There is no post command: writes come only
 * from the plugin's hooks and the MCP server (the host's admit and kick add a line from the room itself, via
 * system). Without --room / CODE, the room is this session's
 * (identity.resolveSelf(): the session id env, then the nearest registered ancestor claude pid).
 *
 * Subcommands (each one's usage error and the README carry the detail):
 *   tail        the hooks module's child (mod/deliver.ts): follows this session's seat, one JSON event per line for the
 *               mod to route (lib/tail.ts). Never exits on an error (logs, backs off, carries on); exits on
 *               --max-seconds, a signal, its parent going or stdout closing
 *   read, digest, who, show, tasks, watch   read-only views of the room (read and watch keep their own cursors)
 *   verify CODE         a room's hash chain and every person's line against the pinned keys (lib/cli/doctor/rooms.ts)
 *   agent-statusline    Claude Code's subagentStatusLine command: never fails (prints nothing, exits 0)
 *   serve --stdio CODE  one remote connection to a room hosted here (lib/remote/server.ts). A room this machine only
 *               mirrors is not served. --login (over this account's own
 *               ssh login) is refused under SSH_ORIGINAL_COMMAND: a forced command (a restricted key or a
 *               ForceCommand) is not the account's own login
 *   link CODE   the link daemon of a room hosted elsewhere (lib/remote/link.ts); --forget drops it for good (never automatic: a closed room can open again; the copy is set aside
 *               as rooms/<code>.forgotten-<time>, not a room code)
 *   invite, admit, kick, prime, listen   the host's steps (lib/cli/host.ts, lib/cli/listen.ts)
 *   doctor      what is wrong on this machine and the fix for each (lib/cli/doctor.ts)
 *   options     a hosted room's options (lib/room/options.ts)
 *   Run invite, admit, kick, prime, listen, link, serve and options in your own shell: the Bash guard
 *   refuses them to a model. doctor without --fix or --bundle is read only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REVOKED } from '../reasons.ts';
import * as identity from '../identity.ts';
import * as room from '../room.ts';
import * as tasks from '../tasks.ts';
import * as config from '../config.ts';
import * as cc from '../cc/env.ts';
import type * as TailLib from '../tail.ts';
import * as statusline from '../../statusline/index.ts';
import { readInput, sleepSync, lazy } from '../io.ts';
import * as store from '../room/store.ts';
import * as links from '../room/links.ts';
import * as linkState from '../room/link-state.ts';
import { roomsDir } from '../home.ts';
import { isObj } from '../decode.ts';
import { parse as parseArgs } from './args.ts';
import type { FlagSpec, Parsed } from './types.ts';
import type { MirrorRoomStore } from '../room/store-mirror.ts';
import { errCode, msgOf, stackOf } from '../errors.ts';
import type { RoomCode, EntryId } from '../brand.ts';
import { entryId } from '../room/validate.ts';
import type * as ProposalMod from '../proposal.ts';
import type * as HostLinksMod from '../remote/host-links.ts';
import type * as ServerMod from '../remote/server.ts';
import type * as PipeMod from '../remote/transports/pipe.ts';
import type * as LinkMod from '../remote/link.ts';
import type * as LinkSocketMod from '../remote/link-socket.ts';
import type * as OptionsMod from '../room/options.ts';
import type * as DoctorMod from './doctor.ts';
import type * as RoomsMod from './doctor/rooms.ts';
import type * as HostMod from './host.ts';
import type * as ListenMod from './listen.ts';
import type * as ShimMod from '../remote/shim.ts';

// Each command's own modules load when it runs (lazy, for start cost), so the tail and agent-statusline (run often)
// never load the remote stack, doctor or the host commands.
const hostLinksLib = lazy<typeof HostLinksMod>(import.meta.url, '../remote/host-links.ts');
const serverLib = lazy<typeof ServerMod>(import.meta.url, '../remote/server.ts');
const pipeLib = lazy<typeof PipeMod>(import.meta.url, '../remote/transports/pipe.ts');
const linkLib = lazy<typeof LinkMod>(import.meta.url, '../remote/link.ts');
const linkSocketLib = lazy<typeof LinkSocketMod>(import.meta.url, '../remote/link-socket.ts');
const optionsLib = lazy<typeof OptionsMod>(import.meta.url, '../room/options.ts');
const roomsLib = lazy<typeof RoomsMod>(import.meta.url, './doctor/rooms.ts');
const tailModule = lazy<typeof TailLib>(import.meta.url, '../tail.ts');
const proposalLib = lazy<typeof ProposalMod>(import.meta.url, '../proposal.ts');
const doctorLib = lazy<typeof DoctorMod>(import.meta.url, './doctor.ts');
const hostLib = lazy<typeof HostMod>(import.meta.url, './host.ts');
const listenLib = lazy<typeof ListenMod>(import.meta.url, './listen.ts');
const shimLib = lazy<typeof ShimMod>(import.meta.url, '../remote/shim.ts');

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

const intList = (s: string): EntryId[] => String(s).split(',').filter(Boolean).map(x => {
  const n = entryId(x.replace(/^#/, ''));
  if (n === null) die(`bad id "${x}"`);
  return n;
});

type FmtEntry = Parameters<typeof room.fmt>[0];

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
  const tailLib = tailModule(); // only the tail loads it (never the status line)
  let handle: ReturnType<typeof tailLib.runTail> | null = null;
  // the reader is gone: nobody to notify
  process.stdout.on('error', () => {
    try { if (handle) handle.stop(); } catch { /* exiting */ }
    process.exit(0);
  });
  // A stray error is logged and the loop carries on (each restart by the mod costs a backoff).
  const lastResort = (e: unknown) => {
    try { process.stderr.write(`sub-human tail: unexpected error: ${stackOf(e)}\n`); } catch { /* closed */ }
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
// lib/io.ts readInput, never a hook handler: the ones that sign arm the seat-key signer (via=human writes), which the
// CLI and the tail must never load.

/** statusline agentStatusline(input) -> text ({"id","content"} lines); whatever goes wrong, print nothing and exit 0. */
function agentStatusline() {
  try {
    const input = readInput({ strict: false });
    const out = statusline.agentStatusline(isObj(input) ? input : {});
    if (typeof out === 'string' && out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  } catch { /* keep the default rendering */ }
}

// ---------- read / digest / show / who ----------
function read(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { id: 1, json: 0, room: 1 });
  if (!flags.id && rest.length) flags.id = rest.join(','); // `sub-human read 22`, as the cut marker says
  const { me, r } = openRoom(flags.room);
  const show = (es: readonly FmtEntry[]) => es.forEach(e => console.log(flags.json ? JSON.stringify(e) : r.fmt(e) + '\n'));
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
  const last = es.at(-1);
  if (last) r.setCursor(cursor, last.id); // es is not empty
}

function digest(args: readonly string[]) {
  const { flags } = parseFlags(args, { room: 1 });
  const { r } = openRoom(flags.room);
  process.stdout.write(r.digest() + '\n');
}

function show(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { room: 1 });
  if (rest.length !== 1) die('usage: sub-human show HASH [--room CODE]');
  const { code } = openRoom(flags.room);
  const text = proposalLib().read(code, rest[0]);
  if (text == null) die(`no proposal ${rest[0]} in room ${code}`, 1);
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function who(args: readonly string[] = []) {
  const { flags, rest } = parseFlags(args, { room: 1 });
  if (rest.length) die('usage: sub-human who [--room CODE]');
  if (flags.room !== undefined) { // the room's people: who is in it, by name and role
    const { code } = openRoom(flags.room);
    const ms = Object.values(identity.readMembers(code) || {}).filter(m => m && m.name && !m.left_at);
    if (!ms.length) return console.log(`(nobody in room ${code})`);
    for (const m of ms) console.log(`${m.name} (${m.role}${m.lapsed_at ? ', away' : ''}) in ${code}`);
    return;
  }
  const me = identity.resolveSelf();
  if (!me) die(NOT_IN_ROOM, 1);
  console.log(`${me.name} (${me.role}) in ${me.code}`);
}

// ---------- tasks ----------
/** lib/tasks.ts list(code): the room document `tasks` as the mirror writes it. */
const taskList = (code: RoomCode) => tasks.list(code) || [];

function tasksCmd(args: readonly string[]) {
  const { flags } = parseFlags(args, { json: 0, room: 1 });
  const { code } = openRoom(flags.room);
  let list;
  try { list = taskList(code); } catch (e) { die(`the room task list is unavailable: ${msgOf(e)}`, 1); }
  list = list.filter(t => t && !(t.metadata && t.metadata._internal));
  if (flags.json) return console.log(JSON.stringify(list));
  if (!list.length) return console.log(`(no tasks in room ${code})`);
  // the rows' words (lib/tasks.ts summary: "tasks 3 open"): open, in progress, done
  const words: Record<string, string> = { pending: 'open', in_progress: 'in progress', completed: 'done' };
  const word = (s: unknown) => words[String(s)] || String(s || '');
  const w = Math.max(...list.map(t => word(t.status).length));
  const o = Math.max(...list.map(t => String(t.owner || '-').length));
  for (const t of list) {
    const blocked = Array.isArray(t.blockedBy) && t.blockedBy.length ? `  (blocked by ${t.blockedBy.map((b: string | number) => '#' + b).join(',')})` : '';
    const subject = String(t.subject ?? '').replace(/\s+/g, ' ');
    console.log(`#${t.id}  ${word(t.status).padEnd(w)}  ${String(t.owner || '-').padEnd(o)}  ${subject}${blocked}`);
  }
}

// ---------- watch NAME ----------
/** Who an entry is from, as a person reading a thread would say it. */
function label(e: FmtEntry): string {
  if (e.via === 'system') return 'room';
  if (e.from === 'claude') return 'claude';
  return e.via === 'agent' ? `${e.from}'s Claude` : e.from;
}

function inThread(name: string) {
  return (e: FmtEntry) => e.from === name || e.to === name || (e.kind === 'task' && e.owner === name);
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
  const print = (raw: FmtEntry) => {
    const e = room.normalize(raw);
    if (!show(e)) return;
    const who = label(e) + (raw.via === 'human' && r.trust(raw) !== 'verified' ? ' (unverified)' : '');
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
    const es = r.readAll().filter((e: FmtEntry) => show(room.normalize(e)));
    if (!es.length) return console.log(`(nothing from or to ${name} in room ${code})`);
    return es.forEach(print);
  }
  console.log(c('2', `${name}'s thread in room ${code} (Ctrl-C to stop)`) + '\n');
  process.stdout.on('error', () => process.exit(0));
  // the whole thread, then each new line: a tailer from the log's start (a reset log is read again from its start)
  const tl = r.tailer({ after: 0 });
  let seen = 0;
  const tick = () => {
    const { entries, reset } = tl.poll();
    if (reset) seen = 0;
    for (const e of entries) if (e.id > seen) { seen = e.id; print(e); }
  };
  tick();
  setInterval(tick, config.WATCH_POLL_MS);
}

// ---------- serve --stdio CODE: lib/remote/server.ts ----------
const SERVE_FLAGS = { stdio: 0, link: 1, login: 0, via: 1, peer: 1 } as const satisfies FlagSpec;

function serve(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, SERVE_FLAGS);
  const code = rest[0];
  if (!flags.stdio || !code || rest.length > 1) die('usage: sub-human serve --stdio CODE [--link ID [--login]] [--via ws [--peer KEY]]');
  const { LINK_ID_RE } = hostLinksLib();
  if (flags.link !== undefined && !LINK_ID_RE.test(flags.link)) die(`bad link id "${flags.link}"`);
  if (flags.login && flags.link === undefined) die('sub-human serve --login: names no --link ID');
  if (flags.link !== undefined && !flags.login) die('sub-human serve --link ID goes with --login (an ssh login)');
  // --via ws and --peer: the web listener's child (the key its Noise XK handshake proved); never with an ssh login
  if (flags.via !== undefined && flags.via !== 'ws') die(`sub-human serve: --via ${flags.via}: only ws (the web listener)`);
  if (flags.peer !== undefined && (flags.via !== 'ws' || !/^[A-Za-z0-9_-]{43}$/.test(flags.peer))) die('sub-human serve: --peer KEY goes with --via ws, a 32-byte key in base64url');
  if (flags.via !== undefined && flags.link !== undefined) die('sub-human serve: --via ws and --link are two ways in; the listener names no link');
  // sshd sets SSH_ORIGINAL_COMMAND only when a forced command runs (an authorized_keys command="…" or ForceCommand): a
  // key restricted that way is not the account's own login, whatever command it asked for
  if (flags.login && process.env.SSH_ORIGINAL_COMMAND !== undefined) {
    die('sub-human serve --login: refused: this connection came through a forced command (a restricted ssh key or ForceCommand), not your own ssh login; join with an invite (/sub-human invite on the host)', 1);
  }
  if (!identity.roomExists(code)) die(`no room "${code}"`, 1);
  const server = serverLib();
  const pipe = pipeLib();
  const s = room.open(code).store;
  if (!s.isHost) die(`room "${code}" is not hosted on this machine (it holds a copy)`, 1);
  const t = pipe.stdio();
  // the session closed its end (no link in time over the web, a silent peer): nothing is left for this process to do
  t.onClose(() => { setTimeout(() => process.exit(0), 200); });
  const srv = server.serve(t, {
    store: s, linkId: flags.link, login: !!flags.login, via: flags.via === 'ws' ? 'ws' : null, peer: flags.peer ?? null,
    log: (msg: string) => process.stderr.write(msg + '\n'),
  });
  // `sub-human kick` stops this with SIGTERM: tell the link it was revoked first, so its daemon stops, not redials
  process.once('SIGTERM', () => { const told = srv.revoked(); setTimeout(() => process.exit(0), told ? 200 : 0); });
}

// ---------- link CODE [--forget [--force]]: lib/remote/link.ts ----------
function linkCmd(args: readonly string[]) {
  const { flags, rest } = parseFlags(args, { forget: 0, force: 0 });
  const code = rest[0];
  if (!code || rest.length > 1) die('usage: sub-human link CODE [--forget [--force]]');
  if (!identity.isRoomCode(code)) die(`no room ${code} on this machine`, 1);
  // a folder a process still holding a forgotten room's seat wrote (no link, no members, no log): never a room hosted
  // here; --forget sets it aside
  if (flags.forget && store.isLeftover(code)) return forgetLeftover(code);
  // first: room.open on a code this machine does not know is a room hosted here, which it is not (forgotten already)
  if (!identity.roomExists(code)) die(`no room ${code} on this machine`, 1);
  const opened = room.open(code).store;
  if (opened.isHost) die(`this machine hosts room "${code}"; there is no connection to ${flags.forget ? 'forget' : 'start'}`, 1);
  const s = opened as MirrorRoomStore; // not the host: the room's mirror
  if (!flags.forget) {
    const link = linkLib();
    return link.run({ code }).then(() => process.exit(0), (e: unknown) => die(msgOf(e), 1));
  }
  const linkSocket = linkSocketLib();
  const st = linkSocket.status(code);
  if (st.running) {
    // the person asked to forget it: the daemon is this machine's own, so --forget stops it first, once the host
    // heard this machine's seats leave over it (else the host sees "connection lost" ~2 min later)
    const told = tellHostLeaving(code, s, st.state);
    if (!stopDaemon(st.pid)) die(`the connection to room ${code} is running (pid ${st.pid}) and did not stop; kill ${st.pid}, then run this again`, 1);
    return forgetLink(code, s, true, st.pid, told);
  }
  return forgetLink(code, s, !!flags.force);
}

// link CODE --forget: the copy moves before the link file goes, so no moment has a bare rooms/<code> (that opens as a
// room hosted here: a fork of the room)
/** SIGTERM to a link daemon, then up to LINK_STOP_WAIT_MS for it to go: whether it is gone. */
const LINK_STOP_WAIT_MS = 3000;
function stopDaemon(pid: number): boolean {
  try { process.kill(pid, 'SIGTERM'); } catch { return !identity.isAlive(pid); }
  for (const until = Date.now() + LINK_STOP_WAIT_MS; Date.now() < until; sleepSync(20)) if (!identity.isAlive(pid)) return true;
  return !identity.isAlive(pid);
}

/** How long --forget gives the host, in all, to hear this machine's seats leave before the daemon stops. */
const FORGET_TELL_MS = 3000;
/**
 * --forget on a running link: each seat of this machine in the room (the mirror's members of this machine, and the
 * seats a live claude process here holds) leaves over the link while it still runs, within FORGET_TELL_MS in all, so
 * the host logs "NAME left" now. A link that is not online is not tried. What to add to the forget's line: who the
 * host heard leave, or why it did not (it then sees the seat lapse).
 */
function tellHostLeaving(code: RoomCode, s: MirrorRoomStore, state: unknown): string {
  const names = new Set<string>(identity.localSeats(code));
  try {
    for (const m of Object.values(s.members.read())) if (m && m.role !== 'claude' && !m.left_at && m.machine && identity.isMine(m.machine)) names.add(m.name);
  } catch { /* the index's seats only */ }
  names.delete('claude');
  if (!names.size) return '';
  const who = [...names].join(', ');
  if (state !== 'online') return `; the host was not told ${who} left (the connection was ${typeof state === 'string' && state ? state : 'not online'}): it sees the seat lapse`;
  const until = Date.now() + FORGET_TELL_MS;
  const told: string[] = [];
  let why = '';
  for (const n of names) {
    const ms = until - Date.now();
    if (ms <= 0) { why = 'no answer in time'; break; }
    try { if (s.members.leave(n, { reason: 'left', deadlineMs: ms })) told.push(n); } catch (e) { why = (msgOf(e) || String(e)).split('\n')[0] ?? ''; break; }
  }
  const missed = [...names].filter(n => !told.includes(n));
  const heard = told.length ? `; the host was told ${told.join(', ')} left` : '';
  return missed.length && why ? `${heard}; the host was not told ${missed.join(', ')} left (${why}): it sees the seat lapse` : heard;
}

/** The link's own log and state files (<home>/links/CODE.log, CODE.state.json), into the archive beside the copy
 * (link.log, link.state.json), or deleted when there is no archive: nothing of the link stays in links/. */
function setAsideLinkFiles(code: RoomCode, archive: string | null) {
  for (const [file, name] of [[links.logFile(code), 'link.log'], [links.stateFile(code), 'link.state.json']] as const) {
    try {
      if (archive) fs.renameSync(file, path.join(archive, name)); else fs.rmSync(file, { force: true });
    } catch (e) { if (errCode(e) !== 'ENOENT') { try { fs.rmSync(file, { force: true }); } catch { /* left */ } } }
  }
}

function forgetLink(code: RoomCode, s: MirrorRoomStore, force: boolean, stopped?: number, told = '') {
  const st = linkState.read(code);
  const why = st?.lastError || '';
  // dormant (the room closed, no seat left) or spent (the host removed this machine: its token gets nowhere now)
  const r = String(st?.lastReason);
  if (!force && r !== 'ROOM_CLOSED' && r !== 'NO_SEAT' && !REVOKED.has(r)) {
    die(`room ${code}: the connection did not stop because the room closed, no seat of this machine is left or the host removed it (${why || 'no reason on record'}); add --force to forget it anyway`, 1);
  }
  s.setAside(); // the log is kept beside the outbox, never merged
  let archive: string | null = path.join(roomsDir(), `${code}.forgotten-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try { fs.renameSync(s.dir, archive); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; archive = null; }
  setAsideLinkFiles(code, archive);
  links.remove(code);
  store.forget(code);
  // every local seat there ends: a session, hold server or tail still running for it resolves none and writes nothing
  identity.dropSeatIndexes(code);
  const lead = stopped ? `room ${code}: its connection (pid ${stopped}) stopped, and ` : `room ${code}: `;
  console.log(archive ? `${lead}forgotten; this machine's copy is kept at ${archive}${told}` : `${lead}forgotten (this machine had no copy of it)${told}`);
}

/** link CODE --forget on a leftover folder: set aside as a forgotten copy is, and no seat names the room any more. */
function forgetLeftover(code: RoomCode) {
  const archive = store.setAsideLeftover(code);
  identity.dropSeatIndexes(code);
  console.log(`room ${code}: a leftover folder (no log, no connection: something still running wrote it after the room was forgotten) is set aside at ${archive}; this machine has no room ${code}`);
}

// ---------- options CODE [NAME on|off]: lib/room/options.ts ----------
function optionsCmd(args: readonly string[]) {
  const [code, name, value, ...more] = args;
  if (!code || more.length || (name !== undefined && value !== 'on' && value !== 'off')) die('usage: sub-human options CODE [login-same-person on|off]');
  if (!identity.roomExists(code)) die(`no room ${code} on this machine`, 1);
  const opts = optionsLib();
  const s = room.open(code).store;
  const cur = name === undefined ? opts.get(s) : opts.set(s, name, value === 'on');
  for (const n of opts.NAMES) console.log(`${n}: ${cur[n] ? 'on' : 'off'}`);
}

type Command = (args: readonly string[]) => unknown;

/** What an unknown command prints: one command per line, grouped (the header above lists them). */
const USAGE = [
  'usage: sub-human COMMAND',
  '  the room:   read [--id N,M] | digest | show HASH | who | tasks [--json] | watch NAME',
  '  host:       invite [--ssh [USER@HOST]] [--via JUMP]',
  '              invite --web | --public | --url URL',
  '              invite --stop | invite --cancel [REF]',
  '              admit [REF] | kick NAME | listen [--port P] [--start | --stop | --status]',
  '  joiner:     prime ROOM | link CODE [--forget [--force]]',
  '  room:       options CODE [login-same-person on|off]',
  '  checks:     doctor [--fix] [--bundle [FILE]] | verify CODE',
  '  internal:   tail | serve --stdio CODE [--link ID [--login]] | agent-statusline',
  '              serve --stdio CODE --via ws [--peer KEY] (the web listener\'s child)',
].join('\n');
const doctor: Command = args => doctorLib().main(args).then(c => process.exit(c), (e: unknown) => die(msgOf(e), 2));
/** verify CODE: a room's log checked (doctor/rooms.ts): its hash chain and every person's line; exit 1 when either fails. */
const verify: Command = args => {
  const code = args[0];
  if (!code || args.length > 1) die('usage: sub-human verify CODE');
  if (!identity.roomExists(code)) die(`no room ${code} on this machine`, 1);
  const r = roomsLib();
  const v = r.verifyRoom(code);
  console.log(`room ${code}: ${r.verifyText(v)}`);
  process.exit(v.chain.ok && !v.unverified.length ? 0 : 1);
};
const cmds: Record<string, Command> = { doctor, verify, tail, read, digest, show, who, tasks: tasksCmd, watch, serve, link: linkCmd, options: optionsCmd, 'agent-statusline': agentStatusline };
// lib/cli/*: each returns the exit code
const viaCli = (fn: 'invite' | 'admit' | 'kick' | 'prime'): Command => a => process.exit(hostLib()[fn](a));
Object.assign(cmds, { invite: viaCli('invite'), admit: viaCli('admit'), kick: viaCli('kick'), prime: viaCli('prime') });
// listen without --start/--stop/--status is the daemon itself: it returns null and keeps running
Object.assign(cmds, { listen: (a: readonly string[]) => { const c = listenLib().listen(a); if (c !== null) process.exit(c); } });

/** Run one command: argv is what follows `sub-human` (scripts/sub-human passes process.argv.slice(2)). */
function main([cmd, ...args]: string[] = process.argv.slice(2)): void {
  // Keep the SSH serve shim's pointer on this install and node (lib/remote/shim.ts); not on the status line's hot
  // path, and never creating a home. Passive: a dev checkout's run never takes the pointer from another live install.
  if (cmd !== 'agent-statusline' && cmd !== 'doctor') { // doctor reports the shim as it is (--fix refreshes it)
    try { if (fs.existsSync(identity.home())) shimLib().refresh(); } catch { /* best effort */ }
  }
  try {
    ((cmd === undefined ? undefined : cmds[cmd]) ?? (() => die(USAGE)))(args);
  } catch (e) {
    die(msgOf(e), 2);
  }
}

export { main };
