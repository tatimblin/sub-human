// Shared helpers for the hook tests. Each hook runs as a child process with fixture stdin, a temp
// SUB_HUMAN_HOME and a temp HOME (so ~/.claude settings and plans are isolated), and with every
// inherited CLAUDE* variable stripped.
//
// Identity: hooks resolve by session_id, then by a direct lookup of CLAUDE_PID (which Claude Code sets
// for every hook). Any registered pid can act; 'act' (this process), 'act2' (our parent) and 'sleep'
// (a live `sleep` child) are all just live pids.
//
// Temp dirs: ../helpers.ts (required first) tracks every mkdtemp under os.tmpdir() and removes them on
// exit, so World's homes are cleaned up without the tests doing anything. World.dispose() removes one
// world early; new World(spec, { t }) does that in t.after.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as common from '../helpers.ts';
import * as identity from '../../lib/identity.ts';
import * as room from '../../lib/room.ts';
import type { AppendOpts, Entry, EntryInput, Members } from '../../lib/room/types.ts';
import type { HookOutput, HookSpecificOutput } from '../../hooks/types.ts';

const PLUGIN = path.join(import.meta.dirname, '..', '..');
const HOOKS = path.join(PLUGIN, 'hooks');
const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');

/** A hook's stdin as a test builds it: a fixture or a literal, any fields (hooks check each one). */
type HookInput = Record<string, unknown>;
/** A hook's stdout line, parsed; { raw } when it was not JSON. */
type HookJson = HookOutput & { raw?: string };
/** What World.hook returns: the exit code, both streams, and stdout parsed (null when it printed nothing). */
interface HookRun { code: number | null; stdout: string; stderr: string; json: HookJson | null }
/** Who holds a seat in a World: this process, our parent, or a live `sleep` child. */
type Who = 'act' | 'act2' | 'sleep';

const fixture = (name: string): HookInput => JSON.parse(fs.readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));

// A live pid that is not an ancestor; ../helpers.ts kills it on exit.
const sleeper = () => common.spawnSleeper(600).pid as number;

function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE') || k === 'NODE_TEST_CONTEXT' || k === 'SUB_HUMAN_HOME') continue;
    e[k] = v;
  }
  return { ...e, ...extra };
}

/** Run fn with process.env.SUB_HUMAN_HOME pointed at this test's home. */
function withHome<T>(home: string, fn: () => T): T {
  const old = process.env.SUB_HUMAN_HOME;
  process.env.SUB_HUMAN_HOME = home;
  try { return fn(); } finally {
    if (old === undefined) delete process.env.SUB_HUMAN_HOME; else process.env.SUB_HUMAN_HOME = old;
  }
}

const sid = () => crypto.randomUUID();

/**
 * A temp world. spec maps names to who holds them: 'act' (this process), 'act2' (our parent) or
 * 'sleep'. "claude" is created first and owns the room code. Pass {room:false} for no room.
 */
class World {
  home: string;
  userHome: string;
  cwd: string;
  pid: Record<string, number> = {};
  sid: Record<string, string> = {};
  /** the room's code; null only for a World made with { room: false } */
  code: string;

  constructor(spec: Record<string, Who> = {}, { room: makeRoom = true, t }: { room?: boolean; t?: TestContext } = {}) {
    this.home = common.tmpDir('sh-hooks-');
    this.userHome = common.tmpDir('sh-user-');
    fs.mkdirSync(path.join(this.userHome, '.claude', 'plans'), { recursive: true });
    this.cwd = common.tmpDir('sh-cwd-');
    if (t) t.after(() => this.dispose());
    this.code = null as unknown as string; // a World without a room never reads it
    if (makeRoom) this.code = this.lib(() => identity.newCode());
    for (const [name, who] of Object.entries(spec)) this.join(name, who);
  }

  lib<T>(fn: () => T): T { return withHome(this.home, fn); }

  join(name: string, who: Who = 'sleep', { announce = false }: { announce?: boolean } = {}): number {
    const pid = who === 'act' ? process.pid : who === 'act2' ? process.ppid : sleeper();
    const s = sid();
    const r = this.lib(() => identity.join({ code: this.code, name, role: name === 'claude' ? 'claude' : 'member', pid, session_id: s, cwd: this.cwd }));
    if (!r.ok) throw new Error(`join ${name}: ${r.error}`);
    this.pid[name] = pid;
    this.sid[name] = s;
    if (announce) this.lib(() => room.open(this.code).append({ kind: 'member_joined', text: `${name} joined` }, { via: 'system', from: name, system: true }));
    return pid;
  }

  /** Remove this world's dirs now (they are removed on process exit anyway). */
  dispose(): void {
    for (const d of [this.home, this.userHome, this.cwd]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  }

  entries(): Entry[] { return this.code ? this.lib(() => room.open(this.code).readAll()) : []; }
  append(entry: EntryInput, opts: AppendOpts): Entry { return this.lib(() => room.open(this.code).append(entry, opts)); }
  members(): Members { return this.lib(() => identity.readMembers(this.code)); }
  memberDir(name: string): string { return path.join(this.home, 'rooms', this.code, 'members', name); }

  /** The hooks module's hello lease for session id sid (hooks/handlers/mod-hello.ts writes it on session.start; join needs it). */
  modLease(sid: unknown): void { if (sid) this.lib(() => identity.writeModLease(sid)); }

  /**
   * Run hook `name` (hooks/run.ts name: hooks/handlers/name.ts) with stdin `input`, as identity `as` (sets CLAUDE_PID and session_id). For join, the session's
   * hello lease is written first, as the hooks module does on session.start (modLease: false leaves it out).
   */
  hook(name: string, input: HookInput, { as, env = {}, session = true, modLease = true }: { as?: string; env?: Record<string, string | undefined>; session?: boolean; modLease?: boolean } = {}): HookRun {
    const inp: HookInput = { ...input, cwd: this.cwd };
    // Never launch a real room Claude: `claude` is /usr/bin/false unless a test passes a stub (SUB_HUMAN_CLAUDE).
    const e = baseEnv({ SUB_HUMAN_HOME: this.home, HOME: this.userHome, CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0', ...env });
    if (as) {
      e.CLAUDE_PID = String(this.pid[as]);
      if (session) inp.session_id = this.sid[as];
    }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
    if (name === 'join' && modLease) this.modLease(inp.session_id);
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'run.ts'), name], {
      input: JSON.stringify(inp), env: e, encoding: 'utf8', cwd: this.cwd, timeout: 30_000,
    });
    let json: HookJson | null = null;
    if (r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { json = { raw: r.stdout }; } }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  }
}

const hso = (r: HookRun): HookSpecificOutput | Partial<HookSpecificOutput> => (r.json && r.json.hookSpecificOutput) || {};
const decision = (r: HookRun) => hso(r).permissionDecision;
const reason = (r: HookRun) => hso(r).permissionDecisionReason;
const ctx = (r: HookRun) => hso(r).additionalContext;

/** Plan text with sub-human frontmatter. */
const roomPlan = (code: string, approvers: string[], body = '# Plan\n\n1. add pagination\n', approval = 'all') =>
  `---\nsub-human: ${JSON.stringify({ room: code, approval, approvers })}\n---\n${body}`;

export {
  PLUGIN, HOOKS, identity, room, fixture, sleeper, baseEnv, withHome, sid, World,
  hso, decision, reason, ctx, roomPlan,
};
export type { HookInput, HookJson, HookRun, Who };
