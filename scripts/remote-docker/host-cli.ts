#!/usr/bin/env node
/**
 * scripts/remote-docker/host-cli.ts: the host side of the remote-rooms harness, run INSIDE the devbox container as
 * user `host` (`docker compose exec -u host devbox node /harness/host-cli.ts CMD`). It drives the plugin mounted at
 * /plugin the way Claude Code and its hooks module would: the real hooks as child processes (the module's lease and
 * the typed origin with its nonce written as the module does), a live sleeper standing in for the host seat's claude
 * process. State (the seat's name, pid and session) is in /home/host/harness.json. Prints one JSON object.
 *
 *   setup [SEAT]          a sleeper for SEAT (default alice), then `/sub-human SEAT` (opens the room; the room Claude's
 *                         `claude` is a stub)
 *   say TEXT              the seat's `@room TEXT` through hooks/run.ts prompt (signed with its seat key)
 *   to NAME TEXT          a post the seat's Claude addresses to NAME (via=agent, store.append)
 *   dump                  {code, machine, home, log, members (raw members.json), entries: [{id, from, kind, v2, trust}],
 *                         files: [path relative to the room dir]}
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require: <M>(id: string) => M = createRequire(import.meta.url);
/** JSON.parse typed as what the caller expects (this lab's own files and the plugin's output: not checked). */
const parseJson: <T = unknown>(text: string) => T = JSON.parse;

// The plugin mounted at /plugin, typed by the few members this file uses (not by the repo's sources: the container
// holds whatever was mounted).
/** A log entry as the dump reads it. */
interface Entry { id: number, from: string, via: string, kind: string, to?: string, text?: string, machine?: string }
/** The store of one room (lib/room/store.ts open). */
interface Store {
  dir: string;
  readAll(): Entry[];
  append(e: { kind: string, text: string, to: string }, o: { via: string, from: string }): Entry;
  verifyChain(): unknown;
  trust?(e: Entry): unknown;
}
/** The plugin libs this file loads, by name under lib/. */
interface Libs {
  'identity.ts': { writeModLease(sid: string, lease: { pid: number, nonce: string }): void };
  'room/store.ts': { listRooms(): string[], open(code: string): Store, humanTrust(e: Entry): unknown };
  'room/envelope.ts': { isV2(e: Entry): boolean };
  'home.ts': { machineId(): string };
}
/** The host seat: its sleeper's pid, session and nonce. */
interface Seat { name: string, pid: number, sid: string, nonce: string }
/** /home/host/harness.json. */
interface State { code: string, seat: Seat, machine: string, home: string, join: unknown }

const PLUGIN = '/plugin';
const HOME = process.env.SUB_HUMAN_HOME;
const STATE = '/home/host/harness.json';
const CWD = '/home/host/work';
if (!HOME) { console.error('host-cli: SUB_HUMAN_HOME is not set'); process.exit(2); }

const lib = <K extends keyof Libs>(name: K): Libs[K] => require(path.join(PLUGIN, 'lib', name));
const state = (): State => parseJson<State>(fs.readFileSync(STATE, 'utf8'));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function hook(script: string, input: Record<string, unknown>, seat: Seat): { status: number | null, json: { continue?: boolean } | null, stderr: string } {
  const env = {
    ...process.env, SUB_HUMAN_HOME: HOME, HOME: '/home/host', CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(seat.pid),
    SUB_HUMAN_CLAUDE: '/usr/local/bin/claude', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0',
  };
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'run.ts'), script], {
    input: JSON.stringify({ ...input, session_id: seat.sid, cwd: CWD }), env, cwd: CWD, encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, json: r.stdout.trim() ? parseJson(r.stdout) : null, stderr: r.stderr };
}

const cmds: Record<string, (...args: string[]) => unknown> = {
  setup(name = 'alice') {
    fs.mkdirSync(CWD, { recursive: true });
    let s: State | null = null;
    try { s = state(); } catch { /* first run */ }
    if (s && alive(s.seat.pid)) return { already: true, ...s };
    const sleeper = spawn('sleep', ['86400'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const seat: Seat = { name, pid: sleeper.pid ?? 0, sid: crypto.randomUUID(), nonce: crypto.randomBytes(16).toString('hex') };
    // the hooks module's hello lease (hooks/handlers/mod-hello.ts writes it; join requires it)
    lib('identity.ts').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
    const r = hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: name }, seat);
    const code = lib('room/store.ts').listRooms()[0] ?? '';
    s = { code, seat, machine: lib('home.ts').machineId(), home: HOME, join: r.json };
    fs.writeFileSync(STATE, JSON.stringify(s) + '\n', { mode: 0o600 });
    return s;
  },

  say(text) {
    const { seat } = state();
    // typed: the origin and the session's nonce, as the hooks module hands them to hooks/run.ts prompt
    const r = hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: `@room ${text}`, prompt_id: crypto.randomUUID(),
      sub_human_origin: 'composer', sub_human_nonce: seat.nonce }, seat);
    return { ok: !!(r.json && r.json.continue === false), out: r.json, stderr: r.stderr };
  },

  to(name, text) {
    const { code, seat } = state();
    const e = lib('room/store.ts').open(code).append({ kind: 'say', text, to: name }, { via: 'agent', from: seat.name });
    return { ok: true, id: e.id };
  },

  dump() {
    const { code, machine } = state();
    const store = lib('room/store.ts');
    const envelope = lib('room/envelope.ts');
    const s = store.open(code);
    const read = (f: string): string | null => { try { return fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { return null; } };
    const entries = s.readAll().map(e => ({ id: e.id, from: e.from, via: e.via, kind: e.kind, to: e.to, text: e.text, machine: e.machine,
      // the store's own verdict (0.5.0 after beta.15: s.trust), else an older plugin's store.humanTrust
      v2: envelope.isV2(e), trust: e.via === 'human' ? (s.trust ? s.trust(e) : store.humanTrust(e)) : null }));
    return { code, machine, home: HOME, dir: s.dir, log: read('log.jsonl'), members: read('members.json'), entries,
      chain: s.verifyChain(), files: fs.readdirSync(s.dir, { recursive: true, encoding: 'utf8' }).sort() };
  },
};

const [cmd = '', ...args] = process.argv.slice(2);
const run = Object.hasOwn(cmds, cmd) ? cmds[cmd] : undefined;
if (!run) { console.error('usage: host-cli.ts setup [SEAT] | say TEXT | to NAME TEXT | dump'); process.exit(2); }
try { process.stdout.write(JSON.stringify(run(...args)) + '\n'); } catch (e) { console.error(e instanceof Error && e.stack || e); process.exit(1); }
