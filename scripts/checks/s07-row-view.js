'use strict';
// S7: stray typing in a row view: the read-only hint; nothing is posted
const { clip, esc } = require('../lib/io.ts');

module.exports = {
  scene: 'S7',
  run(x, { det }) {
    const { code } = x;
    const s = x.span('S7');
    const t = x.cap('S7', 'alice') || '';
    const viewing = new RegExp(`─ ${esc(code)} ─`).test(t);
    const hint = /read-only · talk in main \(@room\)/.test(t);
    det('alice\'s room row view shows the read-only hint where she typed', viewing && hint && /❯ x\b/.test(t), `${viewing ? `viewing ${code}` : 'not in the row view'}; hint ${hint ? 'shown' : 'missing'}; typed x ${/❯ x\b/.test(t) ? 'shown' : 'missing'} (${x.capName('S7', 'alice')})`);
    const posted = x.logIn(s).filter(e => e.from === 'alice');
    det('Nothing is posted', posted.length === 0, posted.length ? posted.map(x.fmt).join('; ') : 'no alice entries in S7');
    // A row is a subagent blocked in its hold call: text typed into its view is queued and reaches the row's
    // model only when that hold returns (a join, rejoin or stop). So the true check is: if the text reached the
    // row, its answer is the one-line read-only reply (and nothing else); if it never did, nothing answered it.
    const since = s ? s.from : '';
    const got = x.rowUserText('alice', since, /^\s*x\s*$/);
    const reply = x.rowReply('alice', since);
    det('The stray text gets the one-line read-only reply when the row\'s hold next returns, or no answer at all (it never reached the row)',
      got ? !!reply : !reply,
      got ? (reply ? `"x" reached row ${got.file} at ${got.at.slice(11, 19)}; reply ${reply.at.slice(11, 19)} "${clip(reply.text, 80)}"` : `"x" reached row ${got.file} at ${got.at.slice(11, 19)} but no read-only reply`)
        : (reply ? `a read-only reply with no "x" delivered: ${clip(reply.text, 80)}` : 'the "x" never reached alice\'s row model by the end of the run (its hold did not return); no reply, nothing posted'));
  },
};
