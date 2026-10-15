#!/usr/bin/env node
'use strict';
/**
 * scripts/remote-docker/lab/seat-cli.js: drives seats on one lab machine (devbox, devbox-old or a joiner), run inside
 * the container as that machine's user (`docker compose exec -u USER MACHINE node /lab/seat-cli.js CMD ...`, with
 * SUB_HUMAN_HOME set). It uses the plugin mounted at /plugin the way Claude Code and its hooks module would: the
 * real hooks as child processes (the hello lease and the typed origin with its nonce written as the module does),
 * a live seat-proc.js standing in for each seat's claude process (it runs the seat's room tail and records what it
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
 *   options CODE NAME on|off      `sub-human options CODE NAME on|off` (the host's shell): the room's option
 *   rejoin NAME CODE              `/sub-human NAME CODE` (a room hosted here, or one this machine links to)
 *   say NAME TEXT                 NAME's `@room TEXT` through the prompt hook: {ok, ms, t0, out}
 *   prompt NAME TEXT              any typed prompt through the prompt hook (e.g. a slash-free command)
 *   expand NAME ARGS              any `/sub-human ARGS` through the join hook (invite --ssh, kick, handoff, …)
 *   leave NAME                    SessionEnd for NAME, then its seat process stops
 *   short NAME LINE [SSH_OPT…]    `/sub-human LINE --as NAME`: an invite's line as the host showed it, one argument
 *                                 ("join DEST ROOM SECRET [--via J] [--home H]" or "join URL SECRET"; a 0.5.0-beta.15
 *                                 host's "join DEST ROOM PIN"): {ok, asked, waiting, out, hidden}: asked once the host
 *                                 asks for the PIN (protocol 3), waiting once it checked a PIN (beta.15: in one step)
 *   pin NAME PIN                  `/sub-human join PIN`: the PIN the host asked for: {ok, waiting, out, hidden}
 *   linkfile CODE                 this machine's link file, without its secrets: {exists, token, invite, pin,
 *                                 pin_wanted, awaiting, refused, transport}
 *   admitcard NAME LABEL          NAME, on the host, answers the oldest join request's card ("Let in" / "Refuse"):
 *                                 {ok, question, out, ref, key, link}
 *   card NAME LABEL               NAME answers the handoff card the hooks build (consent.ts Pre, then Post with
 *                                 LABEL, e.g. "Host it here"), as the person would on the AskUserQuestion card
 *   events NAME                   what NAME's tail delivered: [{t, ev}]
 *   dump CODE                     {code, machine, machineIn, isHost, dir, log, entries, chain, members, link, home}
 *   link CODE                     the link daemon's status (lib/remote/link-socket.ts status; beta.15: link.ts)
 *   probe                         what this plugin can do (feature detection for pending scenarios)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = '/plugin';
const HOME = process.env.SUB_HUMAN_HOME;
const USER_HOME = process.env.HOME;
const STATE = HOME && path.join(USER_HOME, `lab-seats${path.basename(HOME)}.json`); // one per SUB_HUMAN_HOME
const CWD = path.join(USER_HOME, 'work');
const CLI = ['scripts/sub-human', 'bin/sub-human'].map(p => path.join(PLUGIN, p)).find(p => fs.existsSync(p));
if (!HOME) { console.error('seat-cli: SUB_HUMAN_HOME is not set'); process.exit(2); }

/** A plugin file by its .ts name, or its .js one in a plugin from before the TypeScript migration (devbox-old). */
const pick = rel => { const ts = rel.replace(/\.js$/, '.ts'); return fs.existsSync(path.join(PLUGIN, ts)) ? ts : ts.replace(/\.ts$/, '.js'); };
const lib = name => require(path.join(PLUGIN, pick(path.join('lib', name))));
/** node's argv for hook `script`: hooks/run.ts SCRIPT (0.5.0-beta.16+), else the older hooks/SCRIPT.ts|.js. */
const hookArgv = script => (fs.existsSync(path.join(PLUGIN, 'hooks', 'run.ts')) ? [path.join(PLUGIN, 'hooks', 'run.ts'), script] : [path.join(PLUGIN, pick(`hooks/${script}.ts`))]);
/** The join hook's source: hooks/handlers/join.ts, else the older hooks/join.ts|.js. */
const joinSrc = () => (fs.existsSync(path.join(PLUGIN, 'hooks', 'handlers', 'join.ts')) ? 'hooks/handlers/join.ts' : 'hooks/join.ts');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seats: {} }; } };
const save = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
const seatOf = name => { const s = load().seats[name]; if (!s) throw new Error(`no seat ${name} on this machine`); return s; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function baseEnv(seat) {
  return {
    ...process.env, SUB_HUMAN_HOME: HOME, HOME: USER_HOME, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(seat.pid),
    SUB_HUMAN_CLAUDE: '/usr/local/bin/claude', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0',
    SUB_HUMAN_LINK_RETRY_MS: process.env.SUB_HUMAN_LINK_RETRY_MS || '1000',
    SUB_HUMAN_LINK_IDLE_MS: process.env.SUB_HUMAN_LINK_IDLE_MS || '900000',
    ...(seat.sshOpts ? { SUB_HUMAN_SSH_OPTS: seat.sshOpts } : {}),
  };
}

function hook(script, input, seat) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, hookArgv(script), {
    input: JSON.stringify({ ...input, session_id: seat.sid, cwd: CWD }), env: baseEnv(seat), cwd: CWD, encoding: 'utf8', timeout: 30_000,
  });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = { raw: r.stdout }; }
  return { status: r.status, json, stderr: (r.stderr || '').slice(-4000), ms: Date.now() - t0, t0 };
}

/** A new seat: its stand-in claude process (seat-proc.js, running the tail) and the hooks module's lease. */
function newSeat(name, sshOpts) {
  fs.mkdirSync(CWD, { recursive: true });
  const st = load();
  const old = st.seats[name];
  if (old && alive(old.pid)) try { process.kill(old.pid, 'SIGTERM'); } catch { /* gone */ }
  const sid = crypto.randomUUID();
  const events = path.join(USER_HOME, `lab-events-${name}.ndjson`);
  fs.writeFileSync(events, '');
  const seat = { name, sid, nonce: crypto.randomBytes(16).toString('hex'), events, sshOpts: sshOpts || '', pid: 0 };
  const proc = spawn(process.execPath, [path.join(__dirname, 'seat-proc.js'), CLI, sid, events], {
    detached: true, stdio: 'ignore', env: baseEnv({ ...seat, pid: process.pid }), cwd: CWD,
  });
  proc.unref();
  seat.pid = proc.pid;
  lib('identity.ts').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
  st.seats[name] = seat;
  save(st);
  return seat;
}

const lease = seat => lib('identity.ts').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
/** NAME's seat (a new one when none is alive), its ssh options set to opts when given. */
function seatWith(name, opts) {
  let seat;
  try { seat = seatOf(name); } catch { seat = null; }
  if (!seat || !alive(seat.pid)) return newSeat(name, opts.join(' '));
  if (opts.length) { seat.sshOpts = opts.join(' '); const st = load(); st.seats[name] = seat; save(st); }
  return seat;
}
const expand = (seat, args) => { lease(seat); return hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: args }, seat); };
const typed = (seat, prompt) => {
  lease(seat);
  return hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: crypto.randomUUID(), sub_human_origin: 'composer', sub_human_nonce: seat.nonce }, seat);
};
const joinedOk = j => !!(j && j.decision !== 'block' && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext);
const reason = j => j && (j.reason || j.systemMessage) || null;
const hidden = j => !!(j && j.hookSpecificOutput && j.hookSpecificOutput.suppressOriginalPrompt);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort().map(rel => {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    return { rel, mode: (st.mode & 0o777).toString(8), dir: st.isDirectory(), size: st.size };
  });
}

/** The link daemon's status: lib/remote/link-socket.ts, else (beta.15) lib/remote/link.ts. */
const linkStatus = code => lib(fs.existsSync(path.join(PLUGIN, 'lib/remote/link-socket.ts')) ? 'remote/link-socket.ts' : 'remote/link.ts').status(code);

function src(rel) { try { return fs.readFileSync(path.join(PLUGIN, /\.[jt]s$/.test(rel) ? pick(rel) : rel), 'utf8'); } catch { return ''; } }

const cmds = {
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

  options(code, name, value) {
    const r = spawnSync(process.execPath, [CLI, 'options', code, name, value], { encoding: 'utf8', env: { ...process.env } });
    return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
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
    const asked = /Type the 4-digit PIN they told you/.test(out), waiting = /checked your PIN/.test(out);
    return { ok: asked || waiting || /the host let you in/.test(out) || /still connecting/.test(out), asked, waiting, out, ms: r.ms, hidden: hidden(r.json), stderr: r.stderr };
  },

  // `/sub-human join PIN`: the PIN the host's machine asked for
  pin(name, pin) {
    const seat = seatOf(name);
    const r = expand(seat, `join ${pin}`);
    const out = reason(r.json) || '';
    return { ok: /checked your PIN/.test(out), waiting: /checked your PIN/.test(out), out, ms: r.ms, hidden: hidden(r.json), stderr: r.stderr };
  },

  linkfile(code) {
    let l = null;
    try { l = JSON.parse(fs.readFileSync(path.join(HOME, 'links', `${code}.json`), 'utf8')); } catch { return { exists: false }; }
    return {
      exists: true, token: typeof l.token === 'string', invite: typeof l.invite === 'string', pin: typeof l.pin === 'string',
      pin_wanted: l.pin_wanted || null, awaiting: l.awaiting || null, refused: l.refused || null, transport: l.transport,
    };
  },

  // NAME, on the host, answers the join request's card the hooks build (consent.ts Pre with "admit REF", then Post)
  admitcard(name, label) {
    const seat = seatOf(name);
    const code = load().code || lib('room/store.ts').listRooms()[0];
    const req = lib('remote/admission.ts').pending(code)[0];
    if (!req) return { ok: false, out: 'no join request waits' };
    lease(seat);
    const pre = hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${req.ref}`, options: [] }] } }, seat);
    const card = pre.json && pre.json.hookSpecificOutput && pre.json.hookSpecificOutput.updatedInput;
    if (!card) return { ok: false, out: 'the hooks built no card', pre: pre.json, stderr: pre.stderr };
    const q = card.questions[0].question;
    const post = hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: label } } }, seat);
    const ctx = post.json && post.json.hookSpecificOutput && post.json.hookSpecificOutput.additionalContext;
    return { ok: /let \S+'s machine into room|refused/.test(ctx || ''), question: q, out: ctx, ref: req.ref, key: req.key, link: req.link, ms: pre.ms + post.ms, stderr: post.stderr };
  },

  card(name, label) {
    const seat = seatOf(name);
    const code = load().code || lib('room/store.ts').listRooms()[0];
    const ask = lib('room/store.ts').open(code).kv.get(lib('handoff.ts').ASK_DOC);
    if (!ask) return { ok: false, out: 'no handoff ask on this machine' };
    lease(seat);
    const pre = hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `handoff ${ask.id}`, options: [] }] } }, seat);
    const card = pre.json && pre.json.hookSpecificOutput && pre.json.hookSpecificOutput.updatedInput;
    if (!card) return { ok: false, out: 'the hooks built no card', pre: pre.json, stderr: pre.stderr };
    const q = card.questions[0].question;
    const post = hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: label } } }, seat);
    return { ok: !!(post.json && post.json.systemMessage), out: post.json && (post.json.systemMessage || post.json.reason), json: post.json, ms: pre.ms + post.ms, stderr: post.stderr };
  },

  rejoin(name, code) {
    let seat;
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
    return { ok: !!(r.json && r.json.continue === false), out: reason(r.json) || (r.json && r.json.stopReason) || null, json: r.json, ms: r.ms, t0: r.t0, stderr: r.stderr };
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
    return { pid: seat.pid, alive: alive(seat.pid), events: text.split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  },

  dump(code) {
    const store = lib('room/store.ts');
    const envelope = lib('room/envelope.ts');
    code = code || load().code;
    const s = store.open(code);
    const read = f => { try { return fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { return null; } };
    let entries = [];
    try {
      entries = s.readAll().map(e => ({ id: e.id, from: e.from, via: e.via, kind: e.kind, to: e.to, text: e.text, machine: e.machine,
        // the store's own verdict (s.trust), else an older plugin's store.humanTrust
        v2: envelope.isV2(e), trust: e.via === 'human' && s.isHost ? (s.trust ? s.trust(e) : store.humanTrust ? store.humanTrust(e) : null) : null }));
    } catch (e) { entries = [{ error: e.message }]; }
    let chain = null;
    try { chain = s.verifyChain(); } catch (e) { chain = { ok: false, error: e.message }; }
    let linkSt = null;
    try { linkSt = s.isHost ? null : linkStatus(code); } catch (e) { linkSt = { error: e.message }; }
    const homeSt = fs.existsSync(HOME) ? (fs.statSync(HOME).mode & 0o777).toString(8) : null;
    // machineIn: this machine's id in the room as its host recorded it (a current plugin: the machine key's), else machine
    const home = lib('home.ts');
    return { code, machine: home.machineId(), machineIn: typeof home.machineIn === 'function' ? home.machineIn(code) : home.machineId(), isHost: !!s.isHost, dir: s.dir, log: read('log.jsonl') || '', members: read('members.json'),
      entries, chain, link: linkSt, home: { path: HOME, mode: homeSt, files: walk(HOME) } };
  },

  link(code) { return linkStatus(code || load().code); },

  probe() {
    const usage = spawnSync(process.execPath, [CLI, '__lab_probe__'], { encoding: 'utf8', env: { ...process.env } });
    const words = new Set((usage.stderr + usage.stdout).replace(/^.*?usage:\s*sub-human/s, '').split('|').map(w => w.trim().split(/\s+/)[0]).filter(Boolean));
    let kinds = [];
    try { kinds = lib('remote/transports/index.ts').kinds(); } catch { kinds = ['pipe', 'memory', 'ssh'].filter(k => src('lib/remote/link.ts').includes(`'${k}'`)); }
    const protocol = lib('remote/protocol.ts');
    const files = ['lib/remote/ws.ts', 'lib/remote/transports/ws.ts', 'lib/remote/listener.ts', 'lib/remote/outbox.ts', 'lib/remote/doctor.ts', 'lib/doctor.ts',
      'lib/remote/seal.js', 'lib/remote/handoff.ts', 'lib/remote/noise.ts', 'lib/remote/tailscale.ts', 'lib/remote/enroll.ts'].map(pick).filter(f => fs.existsSync(path.join(PLUGIN, f)));
    let version = null;
    try { version = JSON.parse(src('.claude-plugin/plugin.json')).version; } catch { /* none */ }
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
        link: (d => ({ rejoin: /rejoin|keepSeats|localSeats/i.test(d), outbox: /outbox/i.test(d), ping: /\bping\b/.test(d), wake: /\bwake\b/i.test(d) }))(['link.ts', 'link-engine.ts', 'link-connect.ts'].map(f => src(`lib/remote/${f}`)).join('\n')),
        // the hello's version range: protocol.PROTO {min, max} and skewMessage (which side updates)
        hello: { range: typeof protocol.skewMessage === 'function' || /min_v|vmin|minVersion|MIN_VERSION/.test(src('lib/remote/protocol.ts') + src('lib/remote/server.ts')) },
      },
    };
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.error(`usage: seat-cli.js ${Object.keys(cmds).join(' | ')}`); process.exit(2); }
try { process.stdout.write(JSON.stringify(cmds[cmd](...args)) + '\n'); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
