'use strict';
// S9: the orch refuses typed input (a viewer attaches with claude attach and types one line)
const { readJson } = require('../lib/io.js');

module.exports = {
  scene: 'S9',
  run(x, { det }) {
    const s = x.span('S9');
    const v = x.cap('S9', 'viewer') || '';
    det('A viewer attached with claude attach and typed: the prompt is refused with the hint', /the orch takes no typed input; use @room or ask your Claude to message orch\./.test(v),
      (/the orch takes no typed input[^\n]*/.exec(v) || [`no refusal in ${x.capName('S9', 'viewer')}`])[0]);
    const typed = x.entries('orch').filter(e => e.type === 'user' && x.textOf(e.message && e.message.content).includes(x.DEMO.viewer9));
    const n = x.orchTurns(s);
    det('The typed text never reached the orch\'s model; no orch turn', typed.length === 0 && n === 0, `${typed.length} transcript entries with the typed text; ${n} orch assistant messages in S9`);
    const syn = readJson(x.stateFile('S9', 'synthetic-prompt.json'), null);
    const so = syn && (() => { try { return JSON.parse(syn.stdout); } catch { return null; } })();
    det('The orch\'s UserPromptSubmit hook blocks a typed prompt (synthetic payload as the orch)', so && so.decision === 'block' && /takes no typed input/.test(so.reason),
      so ? `decision ${so.decision}: "${so.reason}" (session ${syn.input.session_id.slice(0, 8)}, pid ${syn.input.pid})` : 'no synthetic run saved');
  },
};
