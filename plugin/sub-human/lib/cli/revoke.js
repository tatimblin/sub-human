'use strict';
/**
 * plugin/sub-human/lib/cli/revoke.js: `sub-human revoke LINK_ID|NAME [--room CODE] [--file AUTHORIZED_KEYS]`, on the
 * host, in the person's own shell (the Bash guard refuses it to a model): end one link of a room hosted here
 * (lib/remote/hosting.js revoke): its token is burnt (and any invite reserved for it), its authorized_keys lines
 * removed, its seats leave and its running servers stop; a room line says so. NAME: a seat that joined over a link.
 * Without --room, the one open room hosted here. Returns the exit code.
 */

const { hostedRoom } = require('./host.js');

function revoke(args) {
  const f = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--room' || args[i] === '--file') && args[i + 1] !== undefined) f[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  if (rest.length !== 1) {
    process.stderr.write('usage: sub-human revoke LINK_ID|NAME [--room CODE] [--file AUTHORIZED_KEYS]\n');
    return 2;
  }
  try {
    const r = require('../remote/hosting.js').revoke(hostedRoom(f.room), rest[0], f.file ? { file: f.file } : {});
    process.stdout.write(r.text + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(e.message + '\n');
    return 1;
  }
}

module.exports = { revoke };
