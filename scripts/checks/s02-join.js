'use strict';
// S2: bob joins
const { panelRows } = require('../lib/panes.js');
const { readText, clip } = require('../lib/io.js');

module.exports = {
  scene: 'S2',
  run(x, { det, beh }, T) {
    const { code } = x;
    const j = x.byKind('member_joined', { from: 'bob' })[0];
    det('member_joined bob (via system)', j && j.via === 'system', x.fmt(j));
    const rc = /sub-human: joined ([a-z]+-\d{4}) as bob \(([^)]*)\)/.exec(x.cap('S2', 'bob') || '');
    det('bob\'s join line: "joined CODE as bob (alice, orch here)"', rc && rc[1] === code && /alice/.test(rc[2]) && /orch/.test(rc[2]), rc ? rc[0] : `not in ${x.capName('S2', 'bob')}`);
    const ha = x.st('S2', 1, 'holds-alice.json', {}), hb = x.st('S2', 1, 'holds-bob.json', {}), ho = x.st('S2', 1, 'holds-orch.json', {});
    det('Rows: bob nested in alice\'s room row, alice in bob\'s, both in the orch\'s', ha.room && (ha.members || []).includes('bob') && hb.room && (hb.members || []).includes('alice') && ['alice', 'bob'].every(n => (ho.members || []).includes(n)),
      `holds-alice ${JSON.stringify({ room: ha.room, members: ha.members })}; holds-bob ${JSON.stringify({ room: hb.room, members: hb.members })}; holds-orch ${JSON.stringify(ho.members)}`);
    const br = panelRows(x.cap('S2', 'bob'));
    const top = br.filter(r => !r.nested);
    det(`bob's panel: only the ${code} row at the top level (no stray participant row)`, top.length === 1 && top[0].label === code, br.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(x.cap('S2', 'orch'));
    det('The orch\'s panel lists alice and bob', ['alice', 'bob'].every(n => orr.some(r => r.label === n)), orr.map(r => r.line).join(' | ') || 'none');
    const n = x.orchTurns(x.span('S2'));
    beh(`The orch spent at most ${T.orchJoinCalls} model calls on the join (its row spawn)`, n, T.orchJoinCalls, `${n} orch assistant messages in S2`);
    // the join as a group-chat line in alice's pane: the hooks module's $.ui.log row "sub-human: bob joined"
    const jt = readText(x.stateFile('S2', 'notice-alice.txt')) || '';
    const jl = /^\s*(⏺ )?(sub-human: )?bob joined\s*$/m.exec(jt);
    const via = j && x.shownVia('alice', j.id);
    det('alice sees the chat line "bob joined" (a lasting line, no room code, no ids)', jl && via === 'mod',
      `${jl ? `"${jl[0].trim()}" in alice's pane (state/S2/notice-alice.txt)` : 'not seen in alice\'s pane'}; rows/notices-alice.json: #${j ? j.id : '?'} shown via ${via || 'nothing'}`);
    const arow = panelRows(x.cap('S2', 'alice')).find(r => r.label === code);
    det('alice\'s room row reads "+bob joined"', !!(arow && /\+bob joined/.test(arow.text)), arow ? arow.line : `no ${code} row in ${x.capName('S2', 'alice')}`);
    // a join is group chat: the person sees the row, the model gets a copy, nothing wakes it
    const inS2 = es => (j ? es.filter(e => e.timestamp > j.at && e.timestamp <= (x.span('S2') || {}).to) : []);
    const notes = inS2(x.chatIn(x.entries('alice'))).filter(e => e.content === 'sub-human: bob joined');
    const pulls = inS2(x.pullIn(x.entries('alice'))).filter(e => /^bob joined$/m.test(x.textOf(e.message && e.message.content)));
    const woke = inS2(x.wakeIn(x.entries('alice'))).filter(e => /bob joined/.test(x.textOf(e.message && e.message.content)));
    const ct = notes[0] ? x.chatTurn('alice', notes[0]) : null;
    det('The join reached alice as one chat row and one copy for her Claude, with no model turn', notes.length === 1 && pulls.length === 1 && woke.length === 0 && ct && !ct.woke,
      `${notes.length} chat row(s) "sub-human: bob joined"; ${pulls.length} isMeta copy(ies); ${woke.length} wake(s) carrying it; ${ct ? ct.evidence : 'no chat row'}`);
  },
};
