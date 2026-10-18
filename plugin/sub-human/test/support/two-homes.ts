/**
 * test/support/two-homes.ts: one machine of a two-machine test on one machine: its
 * own SUB_HUMAN_HOME, user home and working directory. The real hooks and the CLI run as child processes with that
 * home; seats are live sleepers standing in for claude processes. test/remote-e2e.node-test.ts and
 * test/support/link-bench.ts use it.
 *
 *   new Machine(t?, name, env?)   env: extra variables for every child (e.g. SUB_HUMAN_LINK_RETRY_MS)
 *     seat(name) -> {name, pid, sid}
 *     hook(handler, input, seat, {env}?) -> spawnSync result + json   hooks/run.ts <handler> as seat
 *     lease(seat)                     the hooks module's hello lease for the seat's session (with its nonce), as
 *                                     hooks/handlers/mod-hello.ts writes it; join and every prompt write it first
 *     join(seat, args, env?), say(seat, text), plain(seat, text)    the join expansion (env: e.g. SUB_HUMAN_WEB_FRONT
 *                                     for `invite --web`); an @room post; a prompt
 *     linkFor(code, joiner)           a link to a room hosted here for the second home `joiner`, its token written
 *                                     to the joiner's link file (no invite, no PIN, no card: no command makes one;
 *                                     the robustness tests link with it); then joiner.join(seat, `NAME CODE`)
 *     joinVia(host, hostSeat, seat, {as?, line?, pin?, invite?, front?}) -> Promise<{shown, line, code, pin, typed, gave, admitted, seated}>
 *                                     (once seated, it waits until the seat resolves here: the mirror's members)
 *                                     the whole join from a second home: `/sub-human invite --pipe` (or invite: other
 *                                     invite args; front: `invite --web` behind that test front, lib/env.ts webFront) on the host, unless line (and its pin) is
 *                                     given; the line typed here (a hidden step), the PIN once the host asks for it
 *                                     (`/sub-human join PIN`, hidden too), the host's `/sub-human admit REF`, the link
 *                                     online, then a bare /sub-human (the seat)
 *   shownInvite(text) -> {line, dest, code, word, pin} | null   an invite's text as the host's person reads it: the
 *                                     line (without "/sub-human "), its parts and the PIN told apart
 *     workers(script, input, seat) -> n     worker threads that hook started (test/support/worker-probe.ts)
 *     tail(seat, seconds) -> Promise<stdout>   seat's tail (scripts/sub-human tail, its NDJSON events) for that long
 *     mcp(seat, tool, args) -> Promise<result>   one tools/call on the room's MCP server (mcp/room-server.ts) as seat
 *     send(seat, code, to, text, {server?}) -> Promise<{isDelivered, reason?} | 'engine'>   a SendMessage as the
 *                                     hooks module's session.send hook takes it (mod/send.ts: the same files read,
 *                                     mod/core/send.ts judges): a seat on another machine is posted to through the room
 *                                     (the room server's post; server: false, hooks/handlers/send.ts as when that
 *                                     server is not connected); 'engine' when the module would pass it on (a seat on
 *                                     this machine: the native send)
 *     lib(fn)                         fn with this machine's home, in this process
 *     log(code) -> string             the room's log.jsonl as stored here ('' when none)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from '../helpers.ts';
import type { HookInput, HookLine } from '../hooks/helpers.ts';
import { must } from './must.ts';
import * as identity from '../../lib/identity.ts';
import * as hostLinks from '../../lib/remote/host-links.ts';
import * as store from '../../lib/room/store.ts';
import * as links from '../../lib/room/links.ts';
import * as homeMod from '../../lib/home.ts';
import * as linkConnect from '../../lib/remote/link-connect.ts';
import * as admission from '../../lib/remote/admission.ts';
import * as linkSocket from '../../lib/remote/link-socket.ts';
import type { RoomCode } from '../../lib/brand.ts';
import { roomCode } from '../../lib/text.ts';
import { remotePeer, postArgs, postResult, relayResult } from '../../mod/core/send.ts';

const PROBE = path.join(import.meta.dirname, 'worker-probe.ts');

/** A seat on a Machine: a live sleeper's pid standing in for its claude, a session id and the module's nonce. */
interface Seat { name: string; pid: number; sid: string; nonce: string }
/** A tools/call result from the room's MCP server. */
interface McpResult { isError?: boolean; content?: { type: string; text: string }[] }
const isMcpResult = (v: unknown): v is McpResult => !!v && typeof v === 'object';
/** A hook run on a Machine: spawnSync's result plus stdout parsed (null when it printed nothing). */
type MachineRun = SpawnSyncReturns<string> & { json: HookLine | null };
type Env = Record<string, string | undefined>;

class Machine {
  home: string;
  user: string;
  cwd: string;
  extra: Env;

  constructor(t: TestContext | undefined, name: string, env: Env = {}) {
    // first, so it runs before the home is removed (after hooks run in order): a web listener this home started
    // (invite --web) is killed, not left serving a deleted home
    if (t) t.after(() => this.killListener());
    this.home = h.tmpDir(`sh-${name}-`, t);
    this.user = h.tmpDir('sh-user-', t);
    this.cwd = h.tmpDir('sh-cwd-', t);
    this.extra = env;
  }

  env(seat: Seat | null | undefined, extra: Env = {}): NodeJS.ProcessEnv {
    return h.childEnv({
      SUB_HUMAN_HOME: this.home, HOME: this.user, CLAUDE_PLUGIN_ROOT: h.PLUGIN, CLAUDE_PID: seat ? String(seat.pid) : undefined,
      SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', ...this.extra, ...extra,
    });
  }

  seat(name: string): Seat { return { name, pid: h.spawnSleeper(600).pid as number, sid: crypto.randomUUID(), nonce: crypto.randomBytes(16).toString('hex') }; }

  lease(seat: Seat): void {
    this.lib(() => identity.writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce }));
  }

  hook(script: string, input: HookInput, seat: Seat, { env }: { env?: Env } = {}): MachineRun {
    const r = spawnSync(process.execPath, [path.join(h.PLUGIN, 'hooks', 'run.ts'), script], {
      input: JSON.stringify({ ...input, session_id: seat.sid, cwd: this.cwd }), env: this.env(seat, env), encoding: 'utf8', cwd: this.cwd, timeout: 30_000,
    });
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) as HookLine : null }; // a hook's answer, as it printed it
  }

  join(seat: Seat, args: string, env: Env = {}): MachineRun { this.lease(seat); return this.hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: args }, seat, { env }); }
  /** A link (no invite, no PIN, no card) to room code hosted here, for the second home `joiner` on this machine (pipe):
   * the joiner's link file holds its token (the join over it is then `NAME CODE`). */
  linkFor(code: RoomCode, joiner: Machine): void {
    const machine = must(joiner.lib(() => homeMod.machineIn(code)), "the joiner's machine id");
    const { token } = this.lib(() => hostLinks.create(store.open(code), { id: hostLinks.newLinkId(), machine, seats: [] }));
    const transport = must(linkConnect.transportOf(`pipe:${this.home}`), 'the pipe transport');
    joiner.lib(() => links.set(code, { code, transport, token, created_at: new Date().toISOString() }));
  }

  /** The whole join from this (second) home: the host's invite line and its PIN, typed here, the host's admit, then the seat. */
  async joinVia(host: Machine, hostSeat: Seat, seat: Seat, { as = seat.name, line, pin, invite = 'invite --pipe', front, ms = 15_000 }: { as?: string; line?: string; pin?: string; invite?: string; front?: string; ms?: number } = {}) {
    const shown = line ? null : front ? host.join(hostSeat, 'invite --web', { SUB_HUMAN_WEB_FRONT: front }) : host.join(hostSeat, invite);
    const inv = shownInvite(line ? `/sub-human ${line.replace(/^\/sub-human /, '')}${pin ? `\napart from the line: ${pin}` : ''}` : shown?.json?.reason || '');
    if (!inv) throw new Error(`no invite line in: ${JSON.stringify(shown && shown.json)}`);
    const { code } = inv;
    const typed = this.join(seat, `${inv.line}${as ? ` --as ${as}` : ''}`);
    const asked = await h.until(() => this.lib(() => !!(links.get(code) || {}).pin_wanted), ms, 50);
    if (!asked) throw new Error(`the host never asked for the PIN: ${JSON.stringify(typed.json)} ${typed.stderr} ${JSON.stringify(this.lib(() => links.get(code)))}`);
    const gave = this.join(seat, `join ${inv.pin}`);
    const ref = await h.until(() => { try { const q = host.lib(() => admission.pending(code)); return q.at(-1)?.ref ?? null; } catch { return null; } }, ms, 50);
    if (!ref) throw new Error(`no join request on the host: ${JSON.stringify(gave.json)} ${gave.stderr}`);
    const admitted = host.join(hostSeat, `admit ${ref}`);
    const linked = await h.until(() => this.lib(() => (links.get(code) || {}).token), ms, 50);
    if (!linked) throw new Error(`the link never came up: ${JSON.stringify(this.lib(() => links.get(code)))}`);
    const seated = this.join(seat, '');
    // the seat is the host's to record: this home's mirror shows it once the members document streams back, and
    // until then a hook here cannot resolve it (a prompt typed that fast reads "not in a room")
    if (seated.json && !seated.json.decision) await h.until(() => this.lib(() => identity.resolveBySession(seat.sid)), ms, 50);
    return { shown, line: inv.line, code, pin: inv.pin, typed, gave, admitted, seated };
  }
  plain(seat: Seat, text: string): MachineRun {
    this.lease(seat);
    const input = { hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id: crypto.randomUUID(), sub_human_origin: 'composer', sub_human_nonce: seat.nonce };
    return this.hook('prompt', input, seat);
  }
  say(seat: Seat, text: string): MachineRun { return this.plain(seat, `@room ${text}`); }

  workers(script: string, input: HookInput, seat: Seat): number {
    const r = this.hook(script, input, seat, { env: { NODE_OPTIONS: `--import ${PROBE}` } });
    const m = /WORKERS=(\d+)/.exec(r.stderr);
    if (!m) throw new Error(`no WORKERS line: ${r.stderr}`);
    return Number(m[1]);
  }

  tail(seat: Seat, seconds: number): Promise<string> {
    const env = this.env(seat, { CLAUDE_CODE_SESSION_ID: seat.sid, SUB_HUMAN_SETTLE_MS: '200', SUB_HUMAN_SETTLE_MAX_MS: '400', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_TAIL_HEALTH_MS: '200' });
    return new Promise<string>(resolve => {
      const c = spawn(process.execPath, [h.BIN, 'tail', '--max-seconds', String(seconds)], { env, cwd: this.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.on('exit', () => resolve(out));
    });
  }

  mcp(seat: Seat, tool: string, args: Record<string, unknown>): Promise<McpResult> {
    const env = this.env(seat, { CLAUDE_CODE_SESSION_ID: seat.sid });
    return new Promise<McpResult>((resolve, reject) => {
      const c = spawn(process.execPath, [h.MCP], { env, cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`mcp ${tool}: no answer`)); }, 15_000);
      c.stdout.on('data', d => {
        buf += String(d);
        for (const line of buf.split('\n').slice(0, -1)) {
          const m: unknown = JSON.parse(line);
          const result: unknown = m && typeof m === 'object' && Reflect.get(m, 'id') === 2 ? Reflect.get(m, 'result') : null;
          if (isMcpResult(result)) { clearTimeout(timer); c.kill(); resolve(result); }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      });
      const send = (m: object) => c.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'two-homes', version: '0' } } });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
    });
  }

  async send(seat: Seat, code: RoomCode, to: string, text: string, { server = true }: { server?: boolean } = {}): Promise<ReturnType<typeof postResult> | 'engine'> {
    const read = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(path.join(this.home, f), 'utf8')); } catch { return null; } };
    const inRooms = read('machines.json'), machine = read('machine.json');
    const inRoom: unknown = inRooms && typeof inRooms === 'object' ? Reflect.get(inRooms, code) : undefined;
    const id: unknown = typeof inRoom === 'string' && inRoom ? inRoom : machine && typeof machine === 'object' ? Reflect.get(machine, 'id') : undefined;
    const name = remotePeer(to, { name: seat.name, code, role: 'member', addr: `${seat.name}.${code}` }, read(`rooms/${code}/members.json`), id);
    if (!name) return 'engine';
    if (!server) return relayResult(name, this.hook('send', { to: name, text }, seat)); // the room server not connected
    return postResult(name, await this.mcp(seat, 'post', postArgs(name, text)));
  }

  /** Kill the listener whose pid this home's listen/state.json holds (no-op without one). */
  killListener(): void {
    let pid: unknown = null;
    try { pid = (JSON.parse(fs.readFileSync(path.join(this.home, 'listen', 'state.json'), 'utf8')) as { pid?: unknown }).pid; } catch { return; }
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }

  lib<T>(fn: () => T): T {
    const old = process.env.SUB_HUMAN_HOME;
    process.env.SUB_HUMAN_HOME = this.home;
    try { return fn(); } finally { process.env.SUB_HUMAN_HOME = old; }
  }

  log(code: RoomCode): string { try { return fs.readFileSync(path.join(this.home, 'rooms', code, 'log.jsonl'), 'utf8'); } catch { return ''; } }
}

/** An invite's text as the host's person reads it (lib/remote/hosting.ts inviteText): the line and the PIN told apart. */
function shownInvite(text: string): { line: string; dest: string; code: RoomCode; word: string; pin: string } | null {
  const m = /\/sub-human (join (\S+)(?: ([a-z]+-\d{4}))? ([0-9a-z]{39})((?: --(?:via|home) \S+)*))\s*$/m.exec(text);
  const p = /apart from the line[^\n]*: (\d{4})\s*$/m.exec(text);
  if (!m || !p) return null;
  const [, line = '', dest = '', named, word = ''] = m;
  const code = roomCode(named || dest.split('/').pop() || ''); // a web line: the URL's last segment is the room
  if (!code) return null;
  return { line, dest, code, word, pin: p[1] ?? '' };
}

/** The first child of pid (a link daemon's ssh or serve), or null. */
const childOf = (pid: number | null | undefined): number | null => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
/** SIGKILL pid; nothing when it is gone or none. */
const kill = (pid: number | null | undefined): void => { try { if (pid != null) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
/** A /sub-human answer shown to the person and hidden from the model. */
const hiddenBlock = (r: MachineRun): boolean => !!(r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true);
/** After the test: stop m's link daemon for code (and its child) and remove its socket folder. */
const stopDaemon = (t: TestContext, m: Machine, code: RoomCode): void => t.after(() => {
  const d = m.lib(() => linkSocket.status(code));
  if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
  fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
});

export { Machine, shownInvite, childOf, kill, hiddenBlock, stopDaemon };
export type { Seat, MachineRun };