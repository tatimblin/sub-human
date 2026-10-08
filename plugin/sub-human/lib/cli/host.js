'use strict';
/**
 * plugin/sub-human/lib/cli/host.js: the host's and the joiner's ssh setup commands of scripts/sub-human, in the
 * person's own shell (the Bash guard refuses them to a model). The work is lib/remote/hosting.js; this file parses
 * arguments and prints. Each export takes argv (after the command) and returns the exit code; a RoomError is
 * printed on stderr (exit 1), a usage error exits 2.
 *
 *   host(args)   sub-human host [--room CODE] [--ssh [USER@HOST[:PORT]]] [--via JUMP]
 *                an sh2 invite and its PIN, the block /sub-human host shows (hosting.hostInvite). Without --room, the
 *                one room hosted here with a live seat (else name it)
 *                sub-human host [--room CODE] --tailscale [--funnel] | --url URL [--port P]
 *                the same over the web: the listener, Tailscale Serve/Funnel or a front of your own, and a join URL
 *                with its PIN (lib/remote/webhost.js hostWeb)
 *   admit(args)  sub-human admit REQUEST [--file AUTHORIZED_KEYS] [--yes]
 *                let a joiner's key in for the invite its request names (hosting.admit). On a terminal it shows who
 *                asks, the room, the key's fingerprint and the invite's age, and asks y/N first (--yes skips it)
 *   prime(args)  sub-human prime CODE [--persist 8h]
 *                the joiner's side, for an MFA bastion or host: open an ssh master for room CODE's link once,
 *                interactively (ssh -M -N -f, ControlPersist), and mark the link to ride it (its transport's mux), so
 *                the link daemon's BatchMode ssh reuses it without a prompt (lib/remote/transports/ssh.js)
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const say = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); return code; };

/** --name VALUE flags (and bare --name switches) out of args. */
function flags(args, valued, switches = []) {
  const f = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const k = a.startsWith('--') ? a.slice(2) : null;
    if (k && valued.includes(k)) {
      if (args[i + 1] === undefined) return { error: `${a} needs a value` };
      f[k] = args[++i];
    } else if (k && switches.includes(k)) f[k] = true;
    else rest.push(a);
  }
  return { f, rest };
}

/** The room: --room, else the one open room hosted here. */
function hostedRoom(explicit) {
  const identity = require('../identity.js');
  if (explicit) return explicit;
  const open = identity.openRooms().filter(c => identity.isHost(c));
  if (open.length === 1) return open[0];
  throw Object.assign(new Error(open.length ? `${open.length} rooms are open here (${open.join(', ')}); name one with --room CODE` : 'no room is open here; name one with --room CODE'), { code: 'NO_ROOM' });
}

function host(args) {
  // --ssh takes a value only when one follows that is not another flag
  const a = [...args];
  let ssh;
  const i = a.indexOf('--ssh');
  if (i >= 0) {
    ssh = a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true;
    a.splice(i, ssh === true ? 1 : 2);
  }
  const p = flags(a, ['room', 'via', 'url', 'port'], ['tailscale', 'funnel']);
  if (p.error || p.rest.length) return fail(p.error || 'usage: sub-human host [--room CODE] [--ssh [USER@HOST[:PORT]]] [--via JUMP] | [--tailscale [--funnel] | --url URL] [--port P]', 2);
  const web = p.f.tailscale || p.f.funnel || p.f.url !== undefined;
  if (web && (ssh !== undefined || p.f.via !== undefined)) return fail('--ssh and --tailscale / --url are different ways in; pick one', 2);
  try {
    const r = web
      ? require('../remote/webhost.js').hostWeb(hostedRoom(p.f.room), { tailscale: !!p.f.tailscale, funnel: !!p.f.funnel, url: p.f.url, ...(p.f.port ? { port: Number(p.f.port) } : {}) })
      : require('../remote/hosting.js').hostInvite(hostedRoom(p.f.room), { ssh, via: p.f.via });
    say(r.text);
    return 0;
  } catch (e) { return fail(e.message); }
}

function ask(question) {
  process.stderr.write(question);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { return ''; }
  return buf.subarray(0, n).toString('utf8').trim();
}

function admit(args) {
  const p = flags(args, ['file'], ['yes']);
  if (p.error || p.rest.length !== 1) return fail(p.error || 'usage: sub-human admit shk1.CODE.REF.KEY.NAME [--file AUTHORIZED_KEYS] [--yes]', 2);
  const hosting = require('../remote/hosting.js');
  const sshkeys = require('../remote/sshkeys.js');
  const req = sshkeys.parseRequest(p.rest[0]);
  if (!req) return fail('that is not an admit request (shk1.CODE.REF.KEY.NAME, from the joiner\'s /sub-human join)');
  if (!p.f.yes && process.stdin.isTTY) {
    const yes = ask(`${req.name} asks to join room ${req.code} from another machine with ssh key ${sshkeys.fingerprint(req.key)}.\n`
      + 'Admit it? That key will reach only this room\'s server, as one link, and still needs the invite\'s PIN. [y/N] ');
    if (!/^y(es)?$/i.test(yes)) return fail('not admitted');
  }
  try {
    say(hosting.admit(p.rest[0], p.f.file ? { file: p.f.file } : {}).text);
    return 0;
  } catch (e) { return fail(e.message); }
}

function prime(args) {
  const p = flags(args, ['persist']);
  if (p.error || p.rest.length !== 1) return fail(p.error || 'usage: sub-human prime CODE [--persist 8h]', 2);
  const code = p.rest[0];
  const links = require('../room/links.js');
  const l = links.get(code);
  if (!l || !l.transport || l.transport.kind !== 'ssh') return fail(`this machine has no ssh link to room ${code}`);
  try {
    const ssh = require('../remote/transports/ssh.js');
    fs.mkdirSync(require('node:path').dirname(ssh.controlPath()), { recursive: true, mode: 0o700 });
    const [cmd, ...rest] = ssh.primeCommand(l.transport, code, p.f.persist ? { persist: p.f.persist } : {});
    links.set(code, { ...l, transport: { ...l.transport, mux: true } });
    process.stderr.write(`opening a shared ssh connection for room ${code} (answer any prompt once)…\n`);
    const r = spawnSync(cmd, rest, { stdio: 'inherit' });
    if (r.status !== 0) return fail(`ssh exited ${r.status}; the link still connects on its own, without the shared connection`);
    say(`room ${code}: the link now rides this connection for ${p.f.persist || '8h'} (it reconnects on its own after that; prime again for another MFA prompt)`);
    return 0;
  } catch (e) { return fail(e.message); }
}

module.exports = { host, admit, prime, hostedRoom };
