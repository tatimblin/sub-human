'use strict';
// test/remote-reconnect.test.js: one MirrorRoomStore.place in its own process (the bridge blocks the calling thread,
// so the fake daemon socket lives in the test's process). argv: code, mirror dir, payload JSON. Prints the outcome.
const path = require('node:path');
const { MirrorRoomStore } = require(path.join(__dirname, '..', '..', 'lib', 'room', 'store-mirror.js'));

const [code, dir, payload] = process.argv.slice(2);
let out;
try {
  out = { ok: true, placed: new MirrorRoomStore(code, { dir }).place(JSON.parse(payload), { queue: true }) };
} catch (e) {
  out = { code: e.code, message: e.message, unknown: e.unknown };
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
