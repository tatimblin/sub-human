#!/usr/bin/env node
'use strict';
/**
 * scripts/remote-docker/lab/seat-cli.js: drives seats on one lab machine (devbox, devbox-old or a joiner), run inside
 * the container as that machine's user (`docker compose exec -u USER MACHINE node /lab/seat-cli.js CMD ...`, with
 * SUB_HUMAN_HOME set). It uses the plugin mounted at /plugin the way Claude Code and its hooks module would: the
 * real hooks as child processes (the hello lease and the typed origin with its nonce written as the module does),
 * a live seat-proc.js standing in for each seat's claude process (it runs the seat's room tail and records what it
 * delivers). Works against the current plugin (scripts/sub-human) and 0.2.0 (bin/sub-human). Prints one JSON object.
 * State: $HOME/lab-seats<basename of SUB_HUMAN_HOME>.json, so one machine can hold two homes (two links to a room).
 *
 *   host NAME                     open a room here as NAME (`/sub-human NAME`): {code, machine, seat, out}
 *   join NAME INVITE [PIN] [SSH_OPT…]   `/sub-human join NAME INVITE [PIN]` (an sh2 invite takes its 6-digit PIN);
 *                                 SSH_OPT… become SUB_HUMAN_SSH_OPTS for this seat's hooks and so for the link daemon
 *                                 the join starts: {ok, out, ms, code, linked, admit}. ok: the seat joined (sh1), or
 *                                 the link redeemed the invite (sh2: "linked"); admit: the shk1 request an ssh join
 *                                 shows for the host's /sub-human admit
 *   login NAME DEST CODE [SSH_OPT…]   `/sub-human join NAME DEST CODE`: a link over the person's own ssh login to DEST
 *                                 (no invite), with SSH_OPT… as for join: {ok, out, ms, code}; ok: the seat joined
 *   rejoin NAME CODE              `/sub-human NAME CODE` (a room hosted here, or one this machine links to)
 *   say NAME TEXT                 NAME's `@room TEXT` through hooks/prompt.js: {ok, ms, t0, out}
 *   prompt NAME TEXT              any typed prompt through hooks/prompt.js (e.g. a slash-free command)
 *   expand NAME ARGS              any `/sub-human ARGS` through hooks/join.js (host --ssh, revoke, handoff, …)
 *   leave NAME                    SessionEnd for NAME, then its seat process stops
 *   card NAME LABEL               NAME answers the handoff card the hooks build (consent.js Pre, then Post with
 *                                 LABEL, e.g. "Host it here"), as the person would on the AskUserQuestion card
 *   events NAME                   what NAME's tail delivered: [{t, ev}]
 *   dump CODE                     {code, machine, isHost, dir, log, entries, chain, members, link, home}
 *   link CODE                     the link daemon's status (lib/remote/link.js status)
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

const lib = name => require(path.join(PLUGIN, 'lib', name));
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
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', `${script}.js`)], {
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
  lib('identity.js').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
  st.seats[name] = seat;
  save(st);
  return seat;
}

const lease = seat => lib('identity.js').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
const expand = (seat, args) => { lease(seat); return hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: args }, seat); };
const typed = (seat, prompt) => {
  lease(seat);
  return hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: crypto.randomUUID(), sub_human_origin: 'composer', sub_human_nonce: seat.nonce }, seat);
};
const joinedOk = j => !!(j && j.decision !== 'block' && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext);
const reason = j => j && (j.reason || j.systemMessage) || null;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort().map(rel => {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    return { rel, mode: (st.mode & 0o777).toString(8), dir: st.isDirectory(), size: st.size };
  });
}

function src(rel) { try { return fs.readFileSync(path.join(PLUGIN, rel), 'utf8'); } catch { return ''; } }

const cmds = {
  host(name) {
    const seat = newSeat(name);
    const r = expand(seat, name);
    const code = lib('room/store.js').listRooms().find(c => lib('room/store.js').open(c).isHost) || null;
    const st = load();
    st.code = code;
    save(st);
    return { ok: joinedOk(r.json), code, machine: lib('home.js').machineId(), seat: { name, pid: seat.pid }, out: reason(r.json), ms: r.ms };
  },

  join(name, invite, ...rest) {
    const pin = /^\d{6}$/.test(rest[0] || '') ? rest.shift() : null;
    let seat;
    try { seat = seatOf(name); } catch { seat = null; }
    if (!seat || !alive(seat.pid)) seat = newSeat(name, rest.join(' '));
    else if (rest.length) { seat.sshOpts = rest.join(' '); const st = load(); st.seats[name] = seat; save(st); }
    const r = expand(seat, `join ${name} ${invite}${pin ? ` ${pin}` : ''}`);
    let parsed = lib('remote/auth.js').parseInvite(invite);
    if (!parsed) try { parsed = lib('remote/transports/ws.js').parseJoinUrl(invite); } catch { /* an older plugin */ }
    const out = reason(r.json) || '';
    const linked = /^linked to room/.test(out);
    const admit = (/\/sub-human admit (shk1\.\S+)/.exec(out) || [])[1] || null;
    return { ok: joinedOk(r.json) || linked, linked, admit, out, ms: r.ms, code: parsed && parsed.code, stderr: r.stderr };
  },

  login(name, dest, code, ...rest) {
    let seat;
    try { seat = seatOf(name); } catch { seat = null; }
    if (!seat || !alive(seat.pid)) seat = newSeat(name, rest.join(' '));
    else if (rest.length) { seat.sshOpts = rest.join(' '); const st = load(); st.seats[name] = seat; save(st); }
    const r = expand(seat, `join ${name} ${dest} ${code}`);
    return { ok: joinedOk(r.json), out: reason(r.json) || '', ms: r.ms, code, stderr: r.stderr };
  },

  card(name, label) {
    const seat = seatOf(name);
    const code = load().code || lib('room/store.js').listRooms()[0];
    const ask = lib('room/store.js').open(code).kv.get(lib('handoff.js').ASK_DOC);
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
    const store = lib('room/store.js');
    const envelope = lib('room/envelope.js');
    code = code || load().code;
    const s = store.open(code);
    const read = f => { try { return fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { return null; } };
    let entries = [];
    try {
      entries = s.readAll().map(e => ({ id: e.id, from: e.from, via: e.via, kind: e.kind, to: e.to, text: e.text, machine: e.machine,
        v2: envelope.isV2(e), trust: e.via === 'human' && s.isHost && store.humanTrust ? store.humanTrust(e) : null }));
    } catch (e) { entries = [{ error: e.message }]; }
    let chain = null;
    try { chain = s.verifyChain(); } catch (e) { chain = { ok: false, error: e.message }; }
    let linkSt = null;
    try { linkSt = s.isHost ? null : lib('remote/link.js').status(code); } catch (e) { linkSt = { error: e.message }; }
    const homeSt = fs.existsSync(HOME) ? (fs.statSync(HOME).mode & 0o777).toString(8) : null;
    return { code, machine: lib('home.js').machineId(), isHost: !!s.isHost, dir: s.dir, log: read('log.jsonl') || '', members: read('members.json'),
      entries, chain, link: linkSt, home: { path: HOME, mode: homeSt, files: walk(HOME) } };
  },

  link(code) { return lib('remote/link.js').status(code || load().code); },

  probe() {
    const usage = spawnSync(process.execPath, [CLI, '__lab_probe__'], { encoding: 'utf8', env: { ...process.env } });
    const words = new Set((usage.stderr + usage.stdout).replace(/^.*?usage:\s*sub-human/s, '').split('|').map(w => w.trim().split(/\s+/)[0]).filter(Boolean));
    let kinds = [];
    try { kinds = require(path.join(PLUGIN, 'lib/remote/transports/index.js')).kinds(); } catch { kinds = ['pipe', 'memory', 'ssh'].filter(k => src('lib/remote/link.js').includes(`'${k}'`)); }
    const protocol = lib('remote/protocol.js');
    const files = ['lib/remote/ws.js', 'lib/remote/transports/ws.js', 'lib/remote/listener.js', 'lib/remote/outbox.js', 'lib/remote/doctor.js', 'lib/doctor.js',
      'lib/remote/seal.js', 'lib/remote/handoff.js', 'lib/remote/noise.js', 'lib/remote/tailscale.js'].filter(f => fs.existsSync(path.join(PLUGIN, f)));
    let version = null;
    try { version = JSON.parse(src('.claude-plugin/plugin.json')).version; } catch { /* none */ }
    return {
      version, cli: [...words], kinds, ops: protocol.OPS || [], protocolVersion: protocol.VERSION,
      protocolExports: Object.keys(protocol), files, cliPath: CLI,
      src: {
        auth: { sh2: /\bsh2\b/.test(src('lib/remote/auth.js')), pin: /\bpin\b/i.test(src('lib/remote/auth.js')) },
        join: { hostSsh: /host\s+--ssh|--ssh\b/.test(src('hooks/join.js')), urlPin: /https?:\/\//.test(src('hooks/join.js')) && /\bpin\b/i.test(src('hooks/join.js')), login: /\bloginSpec\b/.test(src('hooks/join.js')) },
        // a seat kept across an outage: the daemon renews this machine's seats on every reconnect (keepSeats/beat)
        link: { rejoin: /rejoin|keepSeats|localSeats/i.test(src('lib/remote/link.js')), outbox: /outbox/i.test(src('lib/remote/link.js')), ping: /\bping\b/.test(src('lib/remote/link.js')), wake: /\bwake\b/i.test(src('lib/remote/link.js')) },
        // the hello's version range: protocol.PROTO {min, max} and skewMessage (which side updates)
        hello: { range: typeof protocol.skewMessage === 'function' || /min_v|vmin|minVersion|MIN_VERSION/.test(src('lib/remote/protocol.js') + src('lib/remote/server.js')) },
      },
    };
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.error(`usage: seat-cli.js ${Object.keys(cmds).join(' | ')}`); process.exit(2); }
try { process.stdout.write(JSON.stringify(cmds[cmd](...args)) + '\n'); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
