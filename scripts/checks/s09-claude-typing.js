'use strict';
// S9: the room's Claude refuses typed input (a viewer attaches with claude attach and types one line)
const { readJson } = require('../lib/io.ts');

module.exports = {
  scene: 'S9',
  run(x, { det }) {
    const s = x.span('S9');
    const v = x.cap('S9', 'viewer') || '';
    det('A viewer attached with claude attach and typed: the prompt is refused with the hint', /the room's Claude takes no typed input; type @claude in your own session, or ask your Claude to message claude\./.test(v),
      (/the room's Claude takes no typed input[^\n]*/.exec(v) || [`no refusal in ${x.capName('S9', 'viewer')}`])[0]);
    const typed = x.entries('claude').filter(e => e.type === 'user' && x.textOf(e.message && e.message.content).includes(x.DEMO.viewer9));
    const n = x.roomClaudeTurns(s);
    det('The typed text never reached the room\'s Claude\'s model; no claude turn', typed.length === 0 && n === 0, `${typed.length} transcript entries with the typed text; ${n} claude assistant messages in S9`);
    const syn = readJson(x.stateFile('S9', 'synthetic-prompt.json'), null);
    const so = syn && (() => { try { return JSON.parse(syn.stdout); } catch { return null; } })();
    det('The room\'s Claude\'s UserPromptSubmit hook blocks a typed prompt (synthetic payload as the room\'s Claude)', so && so.decision === 'block' && /takes no typed input/.test(so.reason),
      so ? `decision ${so.decision}: "${so.reason}" (session ${syn.input.session_id.slice(0, 8)}, pid ${syn.input.pid})` : 'no synthetic run saved');
  },
};
