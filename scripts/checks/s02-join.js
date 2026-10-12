'use strict';
// S2: B joins (bob; --film: jess)
const { panelRows, joinNotices } = require('../lib/panes.js');
const { readText, esc } = require('../lib/io.js');

module.exports = {
  scene: 'S2',
  run(x, { det, beh }, T) {
    const { code, A, B } = x;
    const j = x.byKind('member_joined', { from: B })[0];
    det(`member_joined ${B} (via system)`, j && j.via === 'system', x.fmt(j));
    // since 0.5.0-beta.7 a join that works shows one dim notice from the hooks module (command.run), no hook frame
    const jn = joinNotices(x.cap('S2', B));
    const want = new RegExp(`^⏺ sub-human: joined ${code} as ${B}, with ${A} · @room to talk, @claude to ask the room's Claude`);
    det(`${B}'s join shows one line, "sub-human: joined CODE as ${B}, with ${A} · …", and no "blocked by hook" frame`, jn.notices.length === 1 && want.test(jn.notices[0]) && !jn.frame,
      `${jn.notices.length} join line(s)${jn.notices.length ? `: ${jn.notices.map(l => `"${l}"`).join('; ')}` : ''}; hook frame ${jn.frame ? `"${jn.frame}"` : 'none'} in ${x.capName('S2', B)}`);
    const ha = x.st('S2', 1, `holds-${A}.json`, {}), hb = x.st('S2', 1, `holds-${B}.json`, {}), ho = x.st('S2', 1, 'holds-claude.json', {});
    det(`Rows: ${B} nested in ${A}'s room row, ${A} in ${B}'s, both in the room's Claude's`, ha.room && (ha.members || []).includes(B) && hb.room && (hb.members || []).includes(A) && [A, B].every(n => (ho.members || []).includes(n)),
      `holds-${A} ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-${B} ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-claude ${JSON.stringify(ho.members)}`);
    const br = panelRows(x.cap('S2', B));
    const top = br.filter(r => !r.nested);
    det(`${B}'s panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0].label === code, br.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(x.cap('S2', 'claude'));
    det(`The room's Claude's panel lists ${A} and ${B}`, [A, B].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
    const n = x.roomClaudeTurns(x.span('S2'));
    beh(`The room's Claude spent at most ${T.roomClaudeJoinCalls} model calls on the join (its row spawn)`, n, T.roomClaudeJoinCalls, `${n} claude assistant messages in S2`);
    // the join as a group-chat line in A's pane: the hooks module's $.ui.log row "sub-human: B joined"
    const jt = readText(x.stateFile('S2', `notice-${A}.txt`)) || '';
    const jl = new RegExp(`^\\s*(⏺ )?(sub-human: )?${esc(B)} joined\\s*$`, 'm').exec(jt);
    const via = j && x.shownVia(A, j.id);
    det(`${A} sees the chat line "${B} joined" (a lasting line, no room code, no ids)`, jl && via === 'mod',
      `${jl ? `"${jl[0].trim()}" in ${A}'s pane (state/S2/notice-${A}.txt)` : `not seen in ${A}'s pane`}; rows/notices-${A}.json: #${j ? j.id : '?'} shown via ${via || 'nothing'}`);
    const arow = panelRows(x.cap('S2', A)).find(r => r.label === code);
    det(`${A}'s room row reads "+${B} joined"`, !!(arow && arow.text.includes(`+${B} joined`)), arow ? arow.line : `no ${code} row in ${x.capName('S2', A)}`);
    // a join is group chat: the person sees the row, the model gets a copy, nothing wakes it
    const inS2 = es => (j ? es.filter(e => e.timestamp > j.at && e.timestamp <= (x.span('S2') || {}).to) : []);
    const notes = inS2(x.chatIn(x.entries(A))).filter(e => e.content === `sub-human: ${B} joined`);
    const pulls = inS2(x.pullIn(x.entries(A))).filter(e => new RegExp(`^${esc(B)} joined$`, 'm').test(x.textOf(e.message && e.message.content)));
    const woke = inS2(x.wakeIn(x.entries(A))).filter(e => x.textOf(e.message && e.message.content).includes(`${B} joined`));
    const ct = notes[0] ? x.chatTurn(A, notes[0]) : null;
    det(`The join reached ${A} as one chat row and one copy for ${A}'s Claude, with no model turn`, notes.length === 1 && pulls.length === 1 && woke.length === 0 && ct && !ct.woke,
      `${notes.length} chat row(s) "sub-human: ${B} joined"; ${pulls.length} isMeta copy(ies); ${woke.length} wake(s) carrying it; ${ct ? ct.evidence : 'no chat row'}`);
  },
};
