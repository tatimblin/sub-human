'use strict';
// Shared by the row hooks (B): stdin JSON and the seat this hook runs for. Kept apart from common.js (A).
const fs = require('node:fs');
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}; } catch { return {}; }
}

/** {code, name, role} for this hook's session: by session_id, then the nearest registered claude pid. */
function resolveMe(input) {
  let me = null;
  try { if (input && input.session_id) me = identity.resolveBySession(input.session_id); } catch { me = null; }
  if (!me) { try { me = identity.resolveSelf(); } catch { me = null; } }
  return me && me.code ? me : null;
}

module.exports = { readInput, resolveMe };
