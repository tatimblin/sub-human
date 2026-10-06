'use strict';
/**
 * plugin/sub-human/lib/home.js: where the plugin's store lives on this machine. Zero dependencies beyond text.js.
 * Both lib/identity.js (session indexes) and lib/room/store.js (room state) need it, and identity requires the
 * store, so it lives here rather than in either.
 *
 *   home() -> string            SUB_HUMAN_HOME, else ~/.sub-human (read on every call)
 *   roomsDir() -> string        <home>/rooms
 *   roomDir(code) -> string     <home>/rooms/<code>; throws on a code that is not CODE_RE
 */
const os = require('node:os');
const path = require('node:path');
const { CODE_RE } = require('./text.js');

const home = () => process.env.SUB_HUMAN_HOME || path.join(os.homedir(), '.sub-human');
const roomsDir = () => path.join(home(), 'rooms');
function roomDir(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new Error(`invalid room code "${code}"`);
  return path.join(roomsDir(), code);
}

module.exports = { home, roomsDir, roomDir };
