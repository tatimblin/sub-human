#!/usr/bin/env node
/**
 * scripts/remote-docker/lab/seat-cli.ts: drives seats on one lab machine (devbox, devbox-old or a joiner), run inside
 * the container as that machine's user (`docker compose exec -u USER MACHINE node /lab/seat-cli.ts CMD ...`, with
 * SUB_HUMAN_HOME set). It uses the plugin mounted at /plugin the way Claude Code and its hooks module would: the
 * real hooks as child processes (the hello lease and the typed origin with its nonce written as the module does),
 * a live seat-proc.ts standing in for each seat's claude process (it runs the seat's room tail and records what it
 * delivers). Works against the current plugin and the previous release (devbox-old: 0.5.0-beta.15, where the link
 * daemon's status was in lib/remote/link.ts and the invites in lib/remote/auth.ts). Prints one JSON object.
 * State: $HOME/lab-seats<basename of SUB_HUMAN_HOME>.json, so one machine can hold two homes (two links to a room).
 *
 *   host NAME                     open a room here as NAME (`/sub-human NAME`): {code, machine, seat, out}
 *   restrict CODE LINK PUBKEY [FILE]   (on a host) the one-link forced-command line an admit wrote before protocol 3
 *                                 (nothing writes one now) for PUBKEY and link LINK, appended to FILE (default
 *                                 ~/.ssh/authorized_keys): what a key let in for one other connection looks like: {out}
 *   login NAME DEST CODE [SSH_OPT…]   `/sub-human join DEST CODE --as NAME`: a link over the person's own ssh login to
 *                                 DEST (no invite); SSH_OPT… become SUB_HUMAN_SSH_OPTS for this seat's hooks and so for
 *                                 the link daemon the join starts: {ok, out, ms, code}; ok: the seat joined
 *   rejoin NAME CODE              `/sub-human NAME CODE` (a room hosted here, or one this machine links to)
 *   say NAME TEXT                 NAME's `@room TEXT` through the prompt hook: {ok, ms, t0, out}
 *   prompt NAME TEXT              any typed prompt through the prompt hook (e.g. a slash-free command)
 *   expand NAME ARGS              any `/sub-human ARGS` through the join hook (invite --ssh, kick, …)
 *   leave NAME                    SessionEnd for NAME, then its seat process stops
 *   short NAME LINE [SSH_OPT…]    `/sub-human LINE --as NAME`: an invite's line as the host showed it, one argument
 *                                 ("join DEST ROOM SECRET [--via J] [--home H]" or "join URL SECRET"; a 0.5.0-beta.15
 *                                 host's "join DEST ROOM PIN"): {ok, asked, knocked, waiting, linked, out, hidden}:
 *                                 asked once the host asks for the PIN (a host before the knock), knocked (and waiting)
 *                                 once the line with no PIN asked the host's card, waiting too once an older host
 *                                 checked a PIN for its card, linked once the PIN on the line let it in
 *   pin NAME PIN                  `/sub-human join PIN`: the PIN the host asked for, or typed while a knock waits:
 *                                 {ok, linked, waiting, out, hidden} (linked: the right PIN let it in, no card; waiting:
 *                                 an older host's card asks)
 *   linkfile CODE                 this machine's link file, without its secrets: {exists, token, invite, pin,
 *                                 pin_wanted, awaiting, refused, transport}
 *   admitcard NAME LABEL          NAME, on the host, answers the oldest join request's card ("Let in" / "Refuse"):
 *                                 {ok, question, out, ref, key, link}
 *   events NAME                   what NAME's tail delivered: [{t, ev}]
 *   dump CODE                     {code, machine, machineIn, isHost, dir, log, entries, chain, members, link, home}
 *   link CODE                     the link daemon's status (lib/remote/link-socket.ts status; beta.15: link.ts)
 *   probe                         what this plugin can do (feature detection for pending scenarios)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require: <M>(id: string) => M = createRequire(import.meta.url);
/** JSON.parse typed as what the caller expects (this lab's own files and the plugin's output: not checked). */
const parseJson: <T = unknown>(text: string) => T = JSON.parse;

// The plugin in /plugin is the current one or the previous release (devbox-old), so its modules are typed here by
// the few members this file uses, not by the repo's plugin sources (which may not be what the container holds).
/** A log entry as the dump reads it. */
interface Entry { id: number, from: string, via: string, kind: string, to?: string, text?: string, machine?: string }
/** The store of one room (lib/room/store.ts open). */
interface Store {
  dir: string;
  isHost?: boolean;
  kv: { get(doc: string): { id: string } | null | undefined };
  readAll(): Entry[];
  verifyChain(): unknown;
  trust?(e: Entry): unknown;
}
/** A hook's JSON answer, as far as this file reads it. */
interface HookJson {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
  continue?: boolean;
  raw?: string;
  hookSpecificOutput?: { additionalContext?: string, suppressOriginalPrompt?: boolean, updatedInput?: Card };
}
/** The AskUserQuestion input a consent hook builds. */
interface Card { questions: { question: string, options: unknown[] }[] }
/** A seat on this machine (the state file's seats). */
interface Seat { name: string, sid: string, nonce: string, events: string, sshOpts: string, pid: number }
/** The state file: this machine's seats and the room it hosts or links to. */
interface State { seats: Record<string, Seat>, code?: string | null }
/** The plugin libs this file loads, by name under lib/ (a .js name in an older plugin: pick). */
interface Libs {
  'identity.ts': { writeModLease(sid: string, lease: { pid: number, nonce: string }): void };
  'room/store.ts': { listRooms(): string[], open(code: string): Store, humanTrust?(e: Entry): unknown };
  'room/envelope.ts': { isV2(e: Entry): boolean };
  'home.ts': { machineId(): string, machineIn?(code: string): string };
  'remote/shim.ts': { refresh(o: { force: boolean }): void };
  'remote/admission.ts': { pending(code: string): { ref: string, key: string, link: string }[] };
  'remote/link-socket.ts': { status(code: string): unknown };
  'remote/link.ts': { status(code: string): unknown };
  'remote/transports/index.ts': { kinds(): string[] };
  'remote/protocol.ts': { OPS?: unknown, VERSION?: unknown, skewMessage?: unknown };
}

const PLUGIN = '/plugin';
const HOME = process.env.SUB_HUMAN_HOME;
const USER_HOME = process.env.HOME ?? '';
if (!HOME) { console.error('seat-cli: SUB_HUMAN_HOME is not set'); process.exit(2); }
const STATE = path.join(USER_HOME, `lab-seats${path.basename(HOME)}.json`); // one per SUB_HUMAN_HOME
const CWD = path.join(USER_HOME, 'work');
const CLI = ['scripts/sub-human', 'bin/sub-human'].map(p => path.join(PLUGIN, p)).find(p => fs.existsSync(p)) ?? '';

/** A plugin file by its .ts name, or its .js one in a plugin from before the TypeScript migration (devbox-old). */
const pick = (rel: string): string => { const ts = rel.replace(/\.js$/, '.ts'); return fs.existsSync(path.join(PLUGIN, ts)) ? ts : ts.replace(/\.ts$/, '.js'); };
const lib = <K extends keyof Libs>(name: K): Libs[K] => require(path.join(PLUGIN, pick(path.join('lib', name))));
/** node's argv for hook `script`: hooks/run.ts SCRIPT (0.5.0-beta.16+), else the older hooks/SCRIPT.ts|.js. */
const hookArgv = (script: string): string[] => (fs.existsSync(path.join(PLUGIN, 'hooks', 'run.ts')) ? [path.join(PLUGIN, 'hooks', 'run.ts'), script] : [path.join(PLUGIN, pick(`hooks/${script}.ts`))]);
/** The join hook's source: hooks/handlers/join.ts, else the older hooks/join.ts|.js. */
const joinSrc = (): string => (fs.existsSync(path.join(PLUGIN, 'hooks', 'handlers', 'join.ts')) ? 'hooks/handlers/join.ts' : 'hooks/join.ts');
const load = (): State => { try { return parseJson<State>(fs.readFileSync(STATE, 'utf8')); } catch { return { seats: {} }; } };
const save = (s: State): void => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
const seatOf = (name: string): Seat => { const s = load().seats[name]; if (!s) throw new Error(`no seat ${name} on this machine`); return s; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function baseEnv(seat: Pick<Seat, 'pid' | 'sshOpts'>): NodeJS.ProcessEnv {
  return {
    ...process.env, SUB_HUMAN_HOME: HOME, HOME: USER_HOME, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(seat.pid),
    SUB_HUMAN_CLAUDE: '/usr/local/bin/claude', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0',
    SUB_HUMAN_LINK_RETRY_MS: process.env.SUB_HUMAN_LINK_RETRY_MS || '1000',
    SUB_HUMAN_LINK_IDLE_MS: process.env.SUB_HUMAN_LINK_IDLE_MS || '900000',
    ...(seat.sshOpts ? { SUB_HUMAN_SSH_OPTS: seat.sshOpts } : {}),
  };
}

function hook(script: string, input: Record<string, unknown>, seat: Seat): { status: number | null, json: HookJson | null, stderr: string, ms: number, t0: number } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, hookArgv(script), {
    input: JSON.stringify({ ...input, session_id: seat.sid, cwd: CWD }), env: baseEnv(seat), cwd: CWD, encoding: 'utf8', timeout: 30_000,
  });
  let json: HookJson | null = null;
  try { json = r.stdout.trim() ? parseJson<HookJson>(r.stdout) : null; } catch { json = { raw: r.stdout }; }
  return { status: r.status, json, stderr: (r.stderr || '').slice(-4000), ms: Date.now() - t0, t0 };
}

/** A new seat: its stand-in claude process (seat-proc.ts, running the tail) and the hooks module's lease. */
function newSeat(name: string, sshOpts?: string): Seat {
  fs.mkdirSync(CWD, { recursive: true });
  const st = load();
  const old = st.seats[name];
  if (old && alive(old.pid)) try { process.kill(old.pid, 'SIGTERM'); } catch { /* gone */ }
  const sid = crypto.randomUUID();
  const events = path.join(USER_HOME, `lab-events-${name}.ndjson`);
  fs.writeFileSync(events, '');
  const seat: Seat = { name, sid, nonce: crypto.randomBytes(16).toString('hex'), events, sshOpts: sshOpts || '', pid: 0 };
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, 'seat-proc.ts'), CLI, sid, events], {
    detached: true, stdio: 'ignore', env: baseEnv({ ...seat, pid: process.pid }), cwd: CWD,
  });
  proc.unref();
  seat.pid = proc.pid ?? 0;
  lib('identity.ts').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
  st.seats[name] = seat;
  save(st);
  return seat;
}

const lease = (seat: Seat): void => lib('identity.ts').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
/** NAME's seat (a new one when none is alive), its ssh options set to opts when given. */
function seatWith(name: string, opts: string[]): Seat {
  let seat: Seat | null;
  try { seat = seatOf(name); } catch { seat = null; }
  if (!seat || !alive(seat.pid)) return newSeat(name, opts.join(' '));
  if (opts.length) { seat.sshOpts = opts.join(' '); const st = load(); st.seats[name] = seat; save(st); }
  return seat;
}
const expand = (seat: Seat, args: string): ReturnType<typeof hook> => { lease(seat); return hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: args }, seat); };
const typed = (seat: Seat, prompt: string): ReturnType<typeof hook> => {
  lease(seat);
  return hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: crypto.randomUUID(), sub_human_origin: 'composer', sub_human_nonce: seat.nonce }, seat);
};
const joinedOk = (j: HookJson | null): boolean => !!(j && j.decision !== 'block' && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext);
const reason = (j: HookJson | null): string | null => j && (j.reason || j.systemMessage) || null;
const hidden = (j: HookJson | null): boolean => !!(j && j.hookSpecificOutput && j.hookSpecificOutput.suppressOriginalPrompt);

function walk(dir: string): { rel: string, mode: string, dir: boolean, size: number }[] {
  if (!fs.existsSync(dir)) return [];
  // a file gone between the listing and its lstat (a lock taken and dropped meanwhile: session.json.lock) is skipped
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().flatMap(rel => {
    const st = fs.lstatSync(path.join(dir, rel), { throwIfNoEntry: false });
    return st ? [{ rel, mode: (st.mode & 0o777).toString(8), dir: st.isDirectory(), size: st.size }] : [];
  });
}

/** The link daemon's status: lib/remote/link-socket.ts, else (beta.15) lib/remote/link.ts. */
const linkStatus = (code: string): unknown => (fs.existsSync(path.join(PLUGIN, 'lib/remote/link-socket.ts')) ? lib('remote/link-socket.ts') : lib('remote/link.ts')).status(code);

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function src(rel: string): string { try { return fs.readFileSync(path.join(PLUGIN, /\.[jt]s$/.test(rel) ? pick(rel) : rel), 'utf8'); } catch { return ''; } }

const cmds: Record<string, (...args: string[]) => unknown> = {
  host(name) {
    const seat = newSeat(name);
    const r = expand(seat, name);
    const code = lib('room/store.ts').listRooms().find(c => lib('room/store.ts').open(c).isHost) || null;
    const st = load();
    st.code = code;
    save(st);
    return { ok: joinedOk(r.json), code, machine: lib('home.ts').machineId(), seat: { name, pid: seat.pid }, out: reason(r.json), ms: r.ms };
  },

  restrict(code, linkId, pub, file = path.join(USER_HOME, '.ssh', 'authorized_keys')) {
    const key = String(pub).trim().split(/\s+/).slice(0, 2).join(' ');
    const h = path.resolve(HOME);
    const line = `command="SUB_HUMAN_HOME=${h} ${h}/bin/serve --stdio ${code} --link ${linkId}",restrict ${key} sub-human:${code}:${linkId}`;
    lib('remote/shim.ts').refresh({ force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    return { out: `added: link ${linkId} of room ${code}` };
  },

  login(name, dest, code, ...rest) {
    const seat = seatWith(name, rest);
    const r = expand(seat, `join ${dest} ${code} --as ${name}`);
    return { ok: joinedOk(r.json), out: reason(r.json) || '', ms: r.ms, code, stderr: r.stderr };
  },

  // `/sub-human LINE --as NAME`: an invite's line, one argument; SSH_OPT… as for login
  short(name, line, ...rest) {
    const seat = seatWith(name, rest);
    const r = expand(seat, `${String(line).replace(/^\/sub-human /, '')} --as ${name}`);
    const out = reason(r.json) || '';
    // asked: the host asks for the PIN (a host before the knock); knocked: the line with no PIN asked the host's card;
    // waiting: a card waits (the knock's, or a host before 0.5.x step 2 that checked a PIN); linked: let in already
    const asked = /Type the 4-digit PIN they told you/.test(out), knocked = /Asked the host to let you in/.test(out);
    const waiting = knocked || /checked your PIN/.test(out), linked = /the host let you in/.test(out);
    return { ok: asked || waiting || linked || /still connecting/.test(out), asked, knocked, waiting, linked, out, ms: r.ms, hidden: hidden(r.json), stderr: r.stderr };
  },

  // `/sub-human join PIN`: the PIN the host's machine asked for, or one typed while a knock waits for the card. linked:
  // the right PIN let the machine in (no card); waiting: a host that still sends a checked PIN to its card
  pin(name, pin) {
    const seat = seatOf(name);
    const r = expand(seat, `join ${pin}`);
    const out = reason(r.json) || '';
    const linked = /the host let you in/.test(out), waiting = /checked your PIN/.test(out);
    return { ok: linked || waiting, linked, waiting, out, ms: r.ms, hidden: hidden(r.json), stderr: r.stderr };
  },

  linkfile(code) {
    let l: Record<string, unknown>;
    try { l = parseJson<typeof l>(fs.readFileSync(path.join(HOME, 'links', `${code}.json`), 'utf8')); } catch { return { exists: false }; }
    return {
      exists: true, token: typeof l.token === 'string', invite: typeof l.invite === 'string', pin: typeof l.pin === 'string',
      pin_wanted: l.pin_wanted || null, awaiting: l.awaiting || null, refused: l.refused || null, transport: l.transport,
    };
  },

  // NAME, on the host, answers the join request's card the hooks build (consent.ts Pre with "admit REF", then Post)
  admitcard(name, label) {
    const seat = seatOf(name);
    const code = load().code || lib('room/store.ts').listRooms()[0];
    const req = code ? lib('remote/admission.ts').pending(code)[0] : undefined;
    if (!req) return { ok: false, out: 'no join request waits' };
    lease(seat);
    const pre = hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${req.ref}`, options: [] }] } }, seat);
    const card = pre.json && pre.json.hookSpecificOutput && pre.json.hookSpecificOutput.updatedInput;
    const q = card ? card.questions[0]?.question : undefined;
    if (!card || q === undefined) return { ok: false, out: 'the hooks built no card', pre: pre.json, stderr: pre.stderr };
    const post = hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: label } } }, seat);
    const ctx = post.json && post.json.hookSpecificOutput && post.json.hookSpecificOutput.additionalContext;
    return { ok: /let \S+'s machine into room|refused/.test(ctx || ''), question: q, out: ctx, ref: req.ref, key: req.key, link: req.link, ms: pre.ms + post.ms, stderr: post.stderr };
  },

  rejoin(name, code) {
    let seat: Seat;
    try { seat = seatOf(name); } catch { seat = newSeat(name); }
    if (!alive(seat.pid)) seat = newSeat(name, seat.sshOpts);
    const r = expand(seat, `${name} ${code}`);
    return { ok: joinedOk(r.json), out: reason(r.json), ms: r.ms };
  },

  expand(name, ...args) {
    const r = expand(seatOf(name), args.join(' '));
    return { ok: joinedOk(r.json), json: r.json, out: reason(r.json), ms: r.ms, stderr: r.stderr };
  },

  say(name, ...words) {
    const r = typed(seatOf(name), `@room ${words.join(' ')}`);
    // out: a refusal's reason, else the line the person reads ("✓ sent", "⧗ queued …", "⧗ sending (slow link) …")
    // ok: posted or queued; a refusal stops the prompt too, with "✗ not posted: …" as its stop reason
    const stop = r.json && r.json.continue === false ? String(r.json.stopReason ?? '') : null;
    return { ok: stop !== null && !stop.startsWith('✗'), out: reason(r.json) || (r.json && r.json.stopReason) || null, json: r.json, ms: r.ms, t0: r.t0, stderr: r.stderr };
  },

  prompt(name, ...words) {
    const r = typed(seatOf(name), words.join(' '));
    return { json: r.json, out: reason(r.json), ms: r.ms, stderr: r.stderr };
  },

  leave(name) {
    const seat = seatOf(name);
    const r = hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, seat);
    try { process.kill(seat.pid, 'SIGTERM'); } catch { /* gone */ }
    return { status: r.status };
  },

  events(name) {
    const seat = seatOf(name);
    let text = '';
    try { text = fs.readFileSync(seat.events, 'utf8'); } catch { /* none yet */ }
    return { pid: seat.pid, alive: alive(seat.pid), events: text.split('\n').filter(Boolean).map(l => parseJson(l)) };
  },

  dump(code) {
    const store = lib('room/store.ts');
    const envelope = lib('room/envelope.ts');
    const room = code || load().code || '';
    const s = store.open(room);
    const read = (f: string): string | null => { try { return fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { return null; } };
    let entries: unknown[] = [];
    try {
      entries = s.readAll().map(e => ({ id: e.id, from: e.from, via: e.via, kind: e.kind, to: e.to, text: e.text, machine: e.machine,
        // the store's own verdict (s.trust), else an older plugin's store.humanTrust
        v2: envelope.isV2(e), trust: e.via === 'human' && s.isHost ? (s.trust ? s.trust(e) : store.humanTrust ? store.humanTrust(e) : null) : null }));
    } catch (e) { entries = [{ error: msgOf(e) }]; }
    let chain: unknown = null;
    try { chain = s.verifyChain(); } catch (e) { chain = { ok: false, error: msgOf(e) }; }
    let linkSt: unknown = null;
    try { linkSt = s.isHost ? null : linkStatus(room); } catch (e) { linkSt = { error: msgOf(e) }; }
    const homeSt = fs.existsSync(HOME) ? (fs.statSync(HOME).mode & 0o777).toString(8) : null;
    // machineIn: this machine's id in the room as its host recorded it (a current plugin: the machine key's), else machine
    const home = lib('home.ts');
    return { code: room, machine: home.machineId(), machineIn: typeof home.machineIn === 'function' ? home.machineIn(room) : home.machineId(), isHost: !!s.isHost, dir: s.dir, log: read('log.jsonl') || '', members: read('members.json'),
      entries, chain, link: linkSt, home: { path: HOME, mode: homeSt, files: walk(HOME) } };
  },

  link(code) { return linkStatus(code || load().code || ''); },

  probe() {
    const usage = spawnSync(process.execPath, [CLI, '__lab_probe__'], { encoding: 'utf8', env: { ...process.env } });
    const words = new Set((usage.stderr + usage.stdout).replace(/^.*?usage:\s*sub-human/s, '').split('|').map(w => w.trim().split(/\s+/)[0]).filter(Boolean));
    let kinds: string[] = [];
    try { kinds = lib('remote/transports/index.ts').kinds(); } catch { kinds = ['pipe', 'memory', 'ssh'].filter(k => src('lib/remote/link.ts').includes(`'${k}'`)); }
    const protocol = lib('remote/protocol.ts');
    const files = ['lib/remote/ws.ts', 'lib/remote/transports/ws.ts', 'lib/remote/listener.ts', 'lib/remote/outbox.ts', 'lib/remote/doctor.ts', 'lib/doctor.ts',
      'lib/remote/seal.js', 'lib/remote/noise.ts', 'lib/remote/tailscale.ts', 'lib/remote/enroll.ts'].map(pick).filter(f => fs.existsSync(path.join(PLUGIN, f)));
    let version: unknown = null;
    try { version = parseJson<{ version?: unknown }>(src('.claude-plugin/plugin.json')).version; } catch { /* none */ }
    return {
      version, cli: [...words], kinds, ops: protocol.OPS || [], protocolVersion: protocol.VERSION,
      protocolExports: Object.keys(protocol), files, cliPath: CLI,
      src: {
        // the invites: lib/remote/invites.ts, else (beta.15) lib/remote/auth.ts
        auth: { sh2: /\bsh2\b/.test(src('lib/remote/invites.ts') || src('lib/remote/auth.ts')), pin: /\bpin\b/i.test(src('lib/remote/invites.ts') || src('lib/remote/auth.ts')) },
        join: (() => {
          // the join's source: the command table (lib/commands, 0.5.0-beta.16+), else the join hook (beta.15)
          const j = src(joinSrc()) + src('lib/commands/join.ts') + src('lib/commands/invite.ts');
          return { hostSsh: /host\s+--ssh|--ssh\b/.test(j), urlPin: /https?:\/\//.test(j) && /\bpin\b/i.test(j), login: /\bloginSpec\b/.test(j), line: /\bjoin URL SECRET\b|\blinkLine\b/.test(j) };
        })(),
        // a seat kept across an outage: the daemon renews this machine's seats on every reconnect (keepSeats/beat)
        // the daemon: lib/remote/link.ts with link-engine.ts and link-connect.ts (Stage 7), else link.ts alone
        link: ((d: string) => ({ rejoin: /rejoin|keepSeats|localSeats/i.test(d), outbox: /outbox/i.test(d), ping: /\bping\b/.test(d), wake: /\bwake\b/i.test(d) }))(['link.ts', 'link-engine.ts', 'link-connect.ts'].map(f => src(`lib/remote/${f}`)).join('\n')),
        // the hello's version range: protocol.PROTO {min, max} and skewMessage (which side updates)
        hello: { range: typeof protocol.skewMessage === 'function' || /min_v|vmin|minVersion|MIN_VERSION/.test(src('lib/remote/protocol.ts') + src('lib/remote/server.ts')) },
      },
    };
  },
};

const [cmd = '', ...args] = process.argv.slice(2);
const run = Object.hasOwn(cmds, cmd) ? cmds[cmd] : undefined;
if (!run) { console.error(`usage: seat-cli.ts ${Object.keys(cmds).join(' | ')}`); process.exit(2); }
try { process.stdout.write(JSON.stringify(run(...args)) + '\n'); } catch (e) { console.error(e instanceof Error && e.stack || e); process.exit(1); }
