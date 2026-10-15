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
 *                                     hooks/mod-hello.ts writes it; join and every prompt write it first
 *     join(seat, args), say(seat, text), plain(seat, text)          the join expansion; an @room post; a prompt
 *     invite1(code) -> string         an sh1 invite (no PIN) to a room hosted here, for a second home (internal: no
 *                                     command makes one; the robustness tests link with it)
 *     linkInvite1(code, invite)       this machine's link file for that invite (what a 0.4 sh1 join wrote); then
 *                                     join(seat, `NAME CODE`) takes the seat over it
 *     joinVia(host, hostSeat, seat, {as?, line?, invite?}) -> Promise<{shown, line, code, pin, typed, admitted, seated}>
 *                                     (once seated, it waits until the seat resolves here: the mirror's members)
 *                                     the whole join from a second home: `/sub-human invite --pipe` (or invite: other
 *                                     invite args, e.g. `invite --url U`) on the host, unless line is given; the line
 *                                     typed here (a hidden step), the host's `/sub-human admit REF`, the link online,
 *                                     then a bare /sub-human (the seat)
 *     workers(script, input, seat) -> n     worker threads that hook started (test/support/worker-probe.ts)
 *     tail(seat, seconds) -> Promise<stdout>   seat's tail (scripts/sub-human tail, its NDJSON events) for that long
 *     lib(fn)                         fn with this machine's home, in this process
 *     log(code) -> string             the room's log.jsonl as stored here ('' when none)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from '../helpers.ts';
import type { HookInput, HookJson } from '../hooks/helpers.ts';
import * as identity from '../../lib/identity.ts';
import * as auth from '../../lib/remote/auth.ts';
import * as store from '../../lib/room/store.ts';
import * as links from '../../lib/room/links.ts';
import * as link from '../../lib/remote/link.ts';
import * as admission from '../../lib/remote/admission.ts';

const PROBE = path.join(import.meta.dirname, 'worker-probe.ts');

/** A seat on a Machine: a live sleeper's pid standing in for its claude, a session id and the module's nonce. */
interface Seat { name: string; pid: number; sid: string; nonce: string }
/** A hook run on a Machine: spawnSync's result plus stdout parsed (null when it printed nothing). */
type MachineRun = SpawnSyncReturns<string> & { json: HookJson | null };
type Env = Record<string, string | undefined>;

class Machine {
  home: string;
  user: string;
  cwd: string;
  extra: Env;

  constructor(t: TestContext | undefined, name: string, env: Env = {}) {
    // first, so it runs before the home is removed (after hooks run in order): a web listener this home started
    // (host --tailscale / --url, a handoff to a web locator) is killed, not left serving a deleted home
    if (t) t.after(() => this.killListener());
    this.home = h.tmpDir(`sh-${name}-`, t);
    this.user = h.tmpDir('sh-user-', t);
    this.cwd = h.tmpDir('sh-cwd-', t);
    this.extra = env;
  }

  env(seat: Seat | null | undefined, extra: Env = {}): NodeJS.ProcessEnv {
    return h.childEnv({
      SUB_HUMAN_HOME: this.home, HOME: this.user, CLAUDE_PLUGIN_ROOT: h.PLUGIN, CLAUDE_PID: seat ? String(seat.pid) : undefined,
      SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0', ...this.extra, ...extra,
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
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  }

  join(seat: Seat, args: string): MachineRun { this.lease(seat); return this.hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: args }, seat); }
  /** An sh1 invite (no PIN) to room code hosted here, for a second home on this machine (pipe). */
  invite1(code: string): string {
    return this.lib(() => auth.mintInvite(store.open(code), { locator: `pipe:${this.home}` }).invite);
  }

  /** This machine's link file for an sh1 invite (the join over it is then `NAME CODE`). */
  linkInvite1(code: string, invite: string): void {
    const inv = auth.parseInvite(invite);
    if (!inv) throw new Error(`not an invite: ${invite}`);
    const transport = link.transportOf(inv.locator);
    if (!transport) throw new Error(`no transport for ${inv.locator}`);
    this.lib(() => links.set(code, { code, transport, invite, created_at: new Date().toISOString() }));
  }

  /** The whole join from this (second) home: the host's invite line, typed here, the host's admit, then the seat. */
  async joinVia(host: Machine, hostSeat: Seat, seat: Seat, { as = seat.name, line, invite = 'invite --pipe', ms = 15_000 }: { as?: string; line?: string; invite?: string; ms?: number } = {}) {
    const shown = line ? null : host.join(hostSeat, invite);
    const m = /\/sub-human (join (\S+)(?: ([a-z]+-\d{4}))? (\d{4}))/.exec(line || shown?.json?.reason || '');
    if (!m) throw new Error(`no invite line in: ${JSON.stringify(shown && shown.json)}`);
    const [, typedLine, dest, room, pin] = m;
    const code = room || dest.split('/').pop() || ''; // a web line: the URL's last segment is the room
    const typed = this.join(seat, `${typedLine}${as ? ` --as ${as}` : ''}`);
    const ref = await h.until(() => { try { const q = host.lib(() => admission.pending(code)); return q.length ? q[q.length - 1].ref : null; } catch { return null; } }, ms, 50);
    if (!ref) throw new Error(`no join request on the host: ${JSON.stringify(typed.json)} ${typed.stderr}`);
    const admitted = host.join(hostSeat, `admit ${ref}`);
    const linked = await h.until(() => this.lib(() => (links.get(code) || {}).token), ms, 50);
    if (!linked) throw new Error(`the link never came up: ${JSON.stringify(this.lib(() => links.get(code)))}`);
    const seated = this.join(seat, '');
    // the seat is the host's to record: this home's mirror shows it once the members document streams back, and
    // until then a hook here cannot resolve it (a prompt typed that fast reads "not in a room")
    if (seated.json && !seated.json.decision) await h.until(() => this.lib(() => identity.resolveBySession(seat.sid)), ms, 50);
    return { shown, line: typedLine, code, pin, typed, admitted, seated };
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

  /** Kill the listener whose pid this home's listen/state.json holds (no-op without one). */
  killListener(): void {
    let pid: unknown = null;
    try { pid = JSON.parse(fs.readFileSync(path.join(this.home, 'listen', 'state.json'), 'utf8')).pid; } catch { return; }
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }

  lib<T>(fn: () => T): T {
    const old = process.env.SUB_HUMAN_HOME;
    process.env.SUB_HUMAN_HOME = this.home;
    try { return fn(); } finally { process.env.SUB_HUMAN_HOME = old; }
  }

  log(code: string): string { try { return fs.readFileSync(path.join(this.home, 'rooms', code, 'log.jsonl'), 'utf8'); } catch { return ''; } }
}

export { Machine };
export type { Seat, MachineRun };