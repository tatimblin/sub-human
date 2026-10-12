'use strict';
/**
 * log: helpers over the room log (rooms/CODE/log.jsonl) and the row notice records, for checks/context.js.
 *
 *   byKind(kind, fields), logIn(span), fmt(entry), props (proposals with a hash)
 *   shownVia(name, id)   how entry id was shown to name as a join/leave line (rows/notices-NAME.json, in that seat's
 *                        rows: rowsDir, the host's or its own mirror's)
 *   chainOk()            the hash chain, validated by the plugin's own room lib
 */
const path = require('node:path');
const paths = require('../lib/paths.js');
const { readJson, clip } = require('../lib/io.js');

function roomLog({ home, code, roomDir, log, rowsDir = () => path.join(roomDir, 'rows') }) {
  const byKind = (k, f = {}) => log.filter(e => e.kind === k && Object.entries(f).every(([a, b]) => e[a] === b));
  const fmt = e => (e ? `#${e.id} ${e.from} ${e.via} ${e.kind}${e.hash ? ' ' + e.hash.slice(0, 6) : ''}${e.proposal_hash ? ' ' + e.proposal_hash.slice(0, 6) : ''}: ${clip(e.text, 90)}` : 'none');
  const logIn = s => (s ? log.filter(e => e.at > s.from && e.at <= s.to) : []);
  const props = log.filter(e => e.kind === 'proposal' && e.hash);

  /** How log entry id was shown to name as a join/leave line ("mod"), from rows/notices-NAME.json. */
  function shownVia(name, id) {
    const rec = readJson(path.join(rowsDir(name), `notices-${name}.json`), {});
    const x = (Array.isArray(rec.log) ? rec.log : []).find(y => y.id === id);
    return x ? x.via : null;
  }
  /** The room's hash chain, validated by the plugin's own room lib. */
  function chainOk() {
    process.env.SUB_HUMAN_HOME = home;
    const r = paths.pluginLib('room.ts').open(code).validateChain();
    return { ok: !!r.ok, evidence: r.ok ? `validateChain ok over ${r.count} entries` : `chain breaks at #${r.badAt} (${r.count} entries)` };
  }
  return { byKind, fmt, logIn, props, shownVia, chainOk };
}

module.exports = { roomLog };
