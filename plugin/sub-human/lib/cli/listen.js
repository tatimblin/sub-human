'use strict';
/**
 * plugin/sub-human/lib/cli/listen.js: the host's web listener commands of scripts/sub-human, in the person's own
 * shell (the Bash guard refuses them to a model). The work is lib/remote/listener.js and lib/remote/webhost.js.
 *
 *   listen(args)   sub-human listen [--port 7420]          run the listener in this process (`/sub-human host
 *                                                          --tailscale | --url` starts it detached, the same way)
 *                  sub-human listen --start [--port P]     start it detached unless it runs (idempotent)
 *                  sub-human listen --stop                 stop it (idempotent)
 *                  sub-human listen --status               its state as JSON (pid, port, rooms served)
 *   unhost(args)   sub-human unhost [--room CODE]          stop serving a room over the web (webhost.unhost)
 */

const say = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); return code; };

function listen(args) {
  const a = [...args];
  const take = f => { const i = a.indexOf(f); if (i < 0) return false; a.splice(i, 1); return true; };
  let port;
  const i = a.indexOf('--port');
  if (i >= 0) { port = Number(a[i + 1]); a.splice(i, 2); if (!(port >= 0 && port <= 65535) || !Number.isInteger(port)) return fail('--port takes a port number', 2); }
  const doStart = take('--start'), doStop = take('--stop'), doStatus = take('--status');
  if (a.length || doStart + doStop + doStatus > 1) return fail('usage: sub-human listen [--port 7420] | --start [--port P] | --stop | --status', 2);
  const L = require('../remote/listener.js');
  try {
    if (doStatus) { say(JSON.stringify(L.status(), null, 2)); return 0; }
    if (doStop) { say(L.stop() ? 'the listener stopped' : 'no listener was running'); return 0; }
    if (doStart) {
      const r = L.start(port !== undefined ? { port } : {});
      say(`${r.started ? 'started' : 'already running'}: pid ${r.pid} on 127.0.0.1:${r.port}`);
      return 0;
    }
  } catch (e) { return fail(e.message); }
  L.run(port !== undefined ? { port } : {}).then(() => process.exit(0), e => { fail(e.message); process.exit(1); });
  return null; // the daemon keeps running
}

function unhost(args) {
  const a = [...args];
  let room;
  const i = a.indexOf('--room');
  if (i >= 0) { room = a[i + 1]; a.splice(i, 2); }
  if (a.length || (i >= 0 && !room)) return fail('usage: sub-human unhost [--room CODE]', 2);
  try {
    const { hostedRoom } = require('./host.js');
    say(require('../remote/webhost.js').unhost(hostedRoom(room)).text);
    return 0;
  } catch (e) { return fail(e.message); }
}

module.exports = { listen, unhost };
