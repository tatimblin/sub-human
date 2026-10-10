#!/usr/bin/env node
'use strict';
/**
 * scripts/remote-docker/host-cli.js: the host side of the remote-rooms harness, run INSIDE the devbox container as
 * user `host` (`docker compose exec -u host devbox node /harness/host-cli.js CMD`). It drives the plugin mounted at
 * /plugin the way Claude Code and its hooks module would: the real hooks as child processes (the module's lease and
 * the typed origin with its nonce written as the module does), a live sleeper standing in for the host seat's claude
 * process. State (the seat's name, pid and session) is in /home/host/harness.json. Prints one JSON object.
 *
 *   setup [SEAT]          a sleeper for SEAT (default alice), then `/sub-human SEAT` (opens the room; the room Claude's
 *                         `claude` is a stub)
 *   say TEXT              the seat's `@room TEXT` through hooks/prompt.js (signed with its seat key)
 *   to NAME TEXT          a post the seat's Claude addresses to NAME (via=agent, store.append)
 *   dump                  {code, machine, home, log, members (raw members.json), entries: [{id, from, kind, v2, trust}],
 *                         files: [path relative to the room dir]}
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = '/plugin';
const HOME = process.env.SUB_HUMAN_HOME;
const STATE = '/home/host/harness.json';
const CWD = '/home/host/work';
if (!HOME) { console.error('host-cli: SUB_HUMAN_HOME is not set'); process.exit(2); }

const lib = name => require(path.join(PLUGIN, 'lib', name));
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function hook(script, input, seat) {
  const env = {
    ...process.env, SUB_HUMAN_HOME: HOME, HOME: '/home/host', CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(seat.pid),
    SUB_HUMAN_CLAUDE: '/usr/local/bin/claude', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0',
  };
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', `${script}.js`)], {
    input: JSON.stringify({ ...input, session_id: seat.sid, cwd: CWD }), env, cwd: CWD, encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

const cmds = {
  setup(name = 'alice') {
    fs.mkdirSync(CWD, { recursive: true });
    let s = null;
    try { s = state(); } catch { /* first run */ }
    if (s && alive(s.seat.pid)) return { already: true, ...s };
    const sleeper = spawn('sleep', ['86400'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const seat = { name, pid: sleeper.pid, sid: crypto.randomUUID(), nonce: crypto.randomBytes(16).toString('hex') };
    // the hooks module's hello lease (hooks/mod-hello.js writes it on session.start; join requires it)
    lib('identity.js').writeModLease(seat.sid, { pid: seat.pid, nonce: seat.nonce });
    const r = hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: name }, seat);
    const code = lib('room/store.js').listRooms()[0];
    s = { code, seat, machine: lib('home.js').machineId(), home: HOME, join: r.json };
    fs.writeFileSync(STATE, JSON.stringify(s) + '\n', { mode: 0o600 });
    return s;
  },

  say(text) {
    const { seat } = state();
    // typed: the origin and the session's nonce, as the hooks module hands them to hooks/prompt.js
    const r = hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: `@room ${text}`, prompt_id: crypto.randomUUID(),
      sub_human_origin: 'composer', sub_human_nonce: seat.nonce }, seat);
    return { ok: !!(r.json && r.json.continue === false), out: r.json, stderr: r.stderr };
  },

  to(name, text) {
    const { code, seat } = state();
    const e = lib('room/store.js').open(code).append({ kind: 'say', text, to: name }, { via: 'agent', from: seat.name });
    return { ok: true, id: e.id };
  },

  /** An sh1 invite to the room for DEST (internal: no command mints one; the Mac run links with it), and its key's line. */
  invite1(dest) {
    const { code } = state();
    const L = lib('remote/link.js');
    const locator = dest === 'pipe' ? L.pipeLocator() : L.sshLocator(dest);
    return { invite: lib('remote/auth.js').mintInvite(lib('room/store.js').open(code), { locator }).invite };
  },

  /** The one-link forced-command line for the public key on stdin and that invite's reserved link, appended. */
  authorize(invite, file = '/home/host/.ssh/authorized_keys') {
    const auth = lib('remote/auth.js'), sshkeys = lib('remote/sshkeys.js');
    const inv = auth.parseInvite(invite);
    const id = auth.reserveLink(lib('room/store.js').open(inv.code), inv.secret);
    const key = sshkeys.publicKey(fs.readFileSync(0, 'utf8'));
    const { shim, h } = lib('remote/hosting.js').shimReady();
    sshkeys.appendAuthorized(file, shim.authorizedLine(inv.code, id, key, h), key);
    return { linkId: id };
  },

  dump() {
    const { code, machine } = state();
    const store = lib('room/store.js');
    const envelope = lib('room/envelope.js');
    const s = store.open(code);
    const read = f => { try { return fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { return null; } };
    const entries = s.readAll().map(e => ({ id: e.id, from: e.from, via: e.via, kind: e.kind, to: e.to, text: e.text, machine: e.machine,
      v2: envelope.isV2(e), trust: e.via === 'human' ? store.humanTrust(e) : null }));
    return { code, machine, home: HOME, dir: s.dir, log: read('log.jsonl'), members: read('members.json'), entries,
      chain: s.verifyChain(), files: fs.readdirSync(s.dir, { recursive: true }).sort() };
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.error('usage: host-cli.js setup [SEAT] | say TEXT | to NAME TEXT | invite1 DEST | authorize INVITE [FILE] < PUBKEY | dump'); process.exit(2); }
try { process.stdout.write(JSON.stringify(cmds[cmd](...args)) + '\n'); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
